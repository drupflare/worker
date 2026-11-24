/**
 * Soaks the WordPress page cache on a local `wrangler dev` and checks the properties a cache has to
 * keep: no authenticated body in the store, no error stored, no page served after the write that
 * purged it has been given its contract, and one render for a herd on one cold key.
 *
 * One run seeds a site, draws `--operations` operations from `--seed` (anonymous reads of 20
 * routes, tracking variants, conditional and HEAD requests, refused routes, logged-in reads, AJAX
 * and REST reads, and ten kinds of editorial write), audits the store every 500 operations against a
 * set of seeded secrets, then runs the stampede arm and the restart arm. `--determinism` runs it
 * twice with the same seed and compares the figures the clock does not decide.
 *
 * The detectors are tried first against planted violations (`controls`), so a check that never
 * fires shows before the run starts.
 *
 * Usage: `bun scripts/wp/cache-soak.ts [--operations=4400] [--seed=1] [--determinism] [--out=file]`
 * (environment: `SOAK_PORT`, `SOAK_CONTRACT_MS`, `SOAK_PLAN`, `free` unless set).
 *
 * `--deployed` points the same run at a worker that is already running, named by `SOAK_ORIGIN`.
 * `SOAK_ROWS_STOP` is required: the run reads the object's rows-written counter every 500
 * operations and stops when it passes that figure. Owner calls use `/serve-stats`, `/db-console`
 * and `/recycle` with the owner token. The run claims the site itself, because it sets the admin
 * password it logs in with and the claim reply is the only place the token is shown; give it an
 * unclaimed site. The token is never printed. What an owner token cannot do (a planted row, a
 * process kill) is reported as skipped, with the reason, in the run's JSON.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	DEPLOYED_SKIPS,
	digest,
	frontPage,
	judgeAnswer,
	judgeContract,
	judgeError,
	judgePrivate,
	judgeQuietWrite,
	judgeStore,
	type Model,
	OPERATIONS,
	OWNER_ROUTES_USED,
	pick,
	prng,
	type PurgeCounters,
	readTarget,
	retryableTransport,
	rowsGuard,
	sameStable,
	type Seen,
	type Skipped,
	skipped,
	spread,
	type Stable,
	type StoredRow,
	tierOf,
	tokensOf,
	undated,
	WRITES
} from './cache-soak-core';

const ROOT = new URL('../..', import.meta.url).pathname;
const arg = (name: string, fallback: string): string =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const OPERATIONS_COUNT = Number(arg('operations', '4400'));
const SEED = Number(arg('seed', '1'));
const PORT = Number(process.env.SOAK_PORT ?? 8795);
const CONTRACT_OVERRIDE_MS =
	process.env.SOAK_CONTRACT_MS === undefined ? undefined : Number(process.env.SOAK_CONTRACT_MS);
const PLAN = process.env.SOAK_PLAN === 'paid' ? 'paid' : 'free';
const FRESH_LIMIT_MS = Number(process.env.SOAK_FRESH_LIMIT_MS ?? 45_000);
const AGED_WINDOW_MS = 62_000;
const targetRead = readTarget(process.argv, process.env);
if (!targetRead.ok) {
	console.error(`cache-soak: ${targetRead.error}`);
	process.exit(2);
}
const TARGET = targetRead.target;
const ORIGIN = TARGET.deployed ? TARGET.origin : `http://localhost:${PORT}`;
const REQUEST_TIMEOUT_MS = 180_000;
/** the owner token of a deployed run, read from the claim reply and never printed */
let ownerToken = '';

type Answer = Seen & { cookies: string[]; ms: number };
type Init = { method?: string; headers?: Record<string, string>; body?: string };

/** connection-level failures a deployed read is retried for; the count is part of the result */
let transportRetries = 0;

async function raw(path: string, init: Init = {}): Promise<Answer> {
	const idempotent = (init.method ?? 'GET') === 'GET' || init.method === 'HEAD';
	for (let attempt = 1; ; attempt++) {
		try {
			return await rawOnce(path, init);
		} catch (error) {
			const message =
				error instanceof Error
					? `${error.message} ${(error as { code?: string }).code ?? ''}`
					: String(error);
			if (!TARGET.deployed || attempt >= 3 || !retryableTransport(message, idempotent))
				throw error;
			transportRetries++;
			console.error(
				`transport retry ${transportRetries}: ${path.split('?')[0]} (${message.trim()})`
			);
			await new Promise((r) => setTimeout(r, 1000 * attempt));
		}
	}
}

function rawOnce(path: string, init: Init = {}): Promise<Answer> {
	const t0 = Date.now();
	const send = TARGET.deployed && TARGET.secure ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		const req = send(
			{
				host: TARGET.deployed ? TARGET.host : 'localhost',
				port: TARGET.deployed ? TARGET.port : PORT,
				path,
				method: init.method ?? 'GET',
				headers: { accept: '*/*', ...init.headers },
				...(TARGET.deployed ? { timeout: REQUEST_TIMEOUT_MS, agent: false, family: 4 } : {})
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('end', () => {
					const headers: Record<string, string> = {};
					for (const [k, v] of Object.entries(res.headers)) {
						headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
					}
					resolve({
						status: res.statusCode ?? 0,
						headers,
						body: Buffer.concat(chunks).toString('utf8'),
						cookies: res.headers['set-cookie'] ?? [],
						ms: Date.now() - t0
					});
				});
			}
		);
		req.on('error', reject);
		req.on('timeout', () => req.destroy(new Error(`${path.split('?')[0]} timed out`)));
		req.end(init.body);
	});
}

// carries the owner token, so it is for owner routes only and never for a page
const owner = (path: string, init: Init = {}): Promise<Answer> =>
	raw(
		path,
		TARGET.deployed
			? { ...init, headers: { ...init.headers, authorization: `Bearer ${ownerToken}` } }
			: init
	);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RIGS: Rig[] = [];

/** one wrangler dev, its state directory, and the means to stop and restart it */
class Rig {
	child: ChildProcess | undefined;
	readonly state = mkdtempSync(join(tmpdir(), 'wp-soak-'));

	constructor() {
		RIGS.push(this);
	}

	start(): void {
		const vars = [
			'PW_DIAGNOSTICS:1',
			'CMS:wordpress',
			`PLAN:${PLAN}`,
			'SITE_WARM:0',
			`SITE_ORIGIN:${ORIGIN}`,
			'SQL_CHUNK_PREFIX:wordpress/sql',
			'HEAP_SNAPSHOT:0',
			'CRON_INTERVAL_MS:0',
			'WORDPRESS_PAGE_CACHE:1'
		];
		this.child = spawn(
			'bunx',
			[
				'wrangler',
				'dev',
				'-c',
				'wrangler.jsonc',
				'--port',
				String(PORT),
				'--inspector-port',
				String(PORT + 500),
				'--persist-to',
				this.state,
				...vars.flatMap((v) => ['--var', v])
			],
			{ cwd: ROOT, detached: true, stdio: 'ignore' }
		);
	}

	async stop(): Promise<void> {
		try {
			if (this.child?.pid !== undefined) process.kill(-this.child.pid, 'SIGTERM');
		} catch {
			// already gone
		}
		await sleep(2500);
	}

	async ready(): Promise<void> {
		const deadline = Date.now() + 300_000;
		for (;;) {
			try {
				if ((await raw('/wp-login.php')).status === 200) return;
			} catch {
				// not listening yet
			}
			if (Date.now() > deadline) throw new Error('the worker never answered 200');
			await sleep(1500);
		}
	}

	async remove(): Promise<void> {
		await this.stop();
		rmSync(this.state, { recursive: true, force: true });
	}
}

/** a worker that is already running: nothing to start or stop, only to wait for */
class Remote {
	start(): void {}

	async stop(): Promise<void> {}

	async ready(): Promise<void> {
		const deadline = Date.now() + 300_000;
		for (;;) {
			try {
				if ((await raw('/wp-login.php')).status === 200) return;
			} catch {
				// not answering yet
			}
			if (Date.now() > deadline) throw new Error('the worker never answered 200');
			await sleep(5000);
		}
	}

	async remove(): Promise<void> {}
}

/**
 * What each owner route answers to the token alone, and to no token (which must be a 401, so a
 * route open to anyone is not mistaken for one the token opened). `/recycle` replaces the
 * interpreter, which is the one change a deployed run lets it make.
 */
async function proveOwnerRoutes(): Promise<Record<string, string>> {
	const read = (a: Answer, ok: (b: string) => boolean) => {
		try {
			return a.status === 200 && ok(a.body) ? 'ok' : `answered ${a.status}`;
		} catch {
			return `answered ${a.status} with a body that is not the expected JSON`;
		}
	};
	const out: Record<string, string> = {};
	const noToken = await raw('/serve-stats');
	out['/serve-stats without a token'] =
		noToken.status === 401 ? 'ok' : `answered ${noToken.status}`;
	out['/serve-stats'] = read(await owner('/serve-stats'), (b) =>
		Number.isFinite(Number((JSON.parse(b) as { rowsToday?: unknown }).rowsToday))
	);
	out['/db-console'] = read(
		await owner('/db-console', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ v: 1, sql: 'SELECT count(*) AS n FROM cfw_page' })
		}),
		(b) => Array.isArray((JSON.parse(b) as { rows?: unknown }).rows)
	);
	out['/recycle'] = read(await owner('/recycle', { method: 'POST' }), () => true);
	for (const route of OWNER_ROUTES_USED.slice(0, 2)) {
		if (out[route.route] !== 'ok') {
			throw new Error(
				`${route.route} does not answer the owner token alone: ${out[route.route]}`
			);
		}
	}
	return out;
}

const json = async (path: string): Promise<Record<string, unknown>> =>
	JSON.parse((await owner(path)).body) as Record<string, unknown>;

/** reads only: the local rig runs `/sql`, a deployed worker answers the same statement on `/db-console` */
const sql = async (q: string, params: unknown[] = []): Promise<Record<string, unknown>> => {
	if (!TARGET.deployed) {
		return json(
			`/sql?q=${encodeURIComponent(q)}&params=${encodeURIComponent(JSON.stringify(params))}`
		);
	}
	const res = await owner('/db-console', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ v: 1, sql: q, params })
	});
	if (res.status !== 200) {
		throw new Error(`/db-console answered ${res.status}: ${res.body.slice(0, 160)}`);
	}
	const out = JSON.parse(res.body) as { columns: string[]; rows: unknown[][] };
	return {
		rows: out.rows.map((cells) =>
			Object.fromEntries(out.columns.map((name, i) => [name, cells[i]]))
		)
	};
};
const storedRows = async (): Promise<StoredRow[]> =>
	((
		await sql(
			'SELECT path, status, rendered_at, stale_at, length(html) AS bytes FROM cfw_page ORDER BY path'
		)
	).rows ?? []) as StoredRow[];
const stats = async () => (await json('/serve-stats')) as Record<string, any>;

/** the figures of one run that depend on the clock or the platform, kept apart from `Stable` */
type Timed = {
	requests: number;
	tiers: Record<string, number>;
	freshMs: Record<string, number[]>;
	/** the one minute load average when each write kind was confirmed */
	load: Record<string, number[]>;
	staleReads: number;
	/** the tier that answered each stale read inside a confirm, by write kind */
	staleTiers: Record<string, Record<string, number>>;
	rowsBefore: number;
	rowsAfter: number;
	renders: number;
	barriers: { at: number; rows: number; bytes: number; rowsToday: number }[];
	/** the rows guard's message when it stopped the run */
	stoppedBy?: string;
};

/** one run: its stable figures, its timed ones and what the arms found */
type Run = {
	stable: Stable;
	timed: Timed;
	controls: Record<string, boolean>;
	stampede?: Record<string, unknown>;
	restart?: Record<string, unknown>;
	counters?: Record<string, unknown>;
	probes: Record<string, unknown>;
	/** pieces a deployed run did not do, each with the reason */
	skipped: Skipped[];
	/** what each owner route answered before the run began; deployed only */
	ownerRoutes?: Record<string, string>;
	/** idempotent reads repeated after a connection-level failure; deployed only */
	transportRetries?: number;
};

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

async function execute(seed: number, label: string): Promise<Run> {
	const rig = TARGET.deployed ? new Remote() : new Rig();
	const skips: Skipped[] = [];
	let ownerRoutes: Record<string, string> | undefined;
	const roll = prng(seed);
	const violations: string[] = [];
	const log: string[] = [];
	const byKind: Record<string, number> = {};
	const writesByKind: Record<string, number> = {};
	const timed: Timed = {
		requests: 0,
		tiers: {},
		freshMs: {},
		load: {},
		staleReads: 0,
		staleTiers: {},
		rowsBefore: 0,
		rowsAfter: 0,
		renders: 0,
		barriers: []
	};
	const probes: Record<string, unknown> = {};
	const note = (message: string) => {
		violations.push(message);
		console.error(`[${label}] VIOLATION ${message}`);
	};
	const fetchRaw = async (path: string, init: Init = {}): Promise<Answer> => {
		timed.requests++;
		const a = await raw(path, init);
		const t = tierOf(a.headers) || '-';
		timed.tiers[t] = (timed.tiers[t] ?? 0) + 1;
		return a;
	};
	const token = () =>
		`Tk${Math.floor(roll() * 36 ** 8)
			.toString(36)
			.padStart(8, '0')}`;

	rig.start();
	try {
		await rig.ready();
		const PASS = `pw-${token()}${token()}`;
		const MAIL = `owner-${token()}@example.test`.toLowerCase();
		const claim = await raw('/firstrun', {
			method: 'POST',
			body: JSON.stringify({
				adminName: 'owner',
				adminMail: MAIL,
				adminPass: PASS,
				siteName: 'Soak Site'
			})
		});
		if (claim.status !== 200) throw new Error(`claim answered ${claim.status}`);
		if (TARGET.deployed) {
			ownerToken = String(
				(JSON.parse(claim.body) as { ownerToken?: unknown }).ownerToken ?? ''
			);
			if (ownerToken === '') throw new Error('the claim returned no owner token');
			ownerRoutes = await proveOwnerRoutes();
			if (ownerRoutes['/recycle'] !== 'ok') {
				skips.push(
					skipped(
						'process restart',
						`/recycle with the owner token: ${ownerRoutes['/recycle']}`
					)
				);
			} else {
				skips.push(DEPLOYED_SKIPS.processRestart);
			}
			skips.push(DEPLOYED_SKIPS.plantedRow);
		}

		let cookie = '';
		let nonce = '';
		const login = async () => {
			const res = await raw('/wp-login.php', {
				method: 'POST',
				headers: { ...FORM, cookie: 'wordpress_test_cookie=WP%20Cookie%20check' },
				body: new URLSearchParams({
					log: 'owner',
					pwd: PASS,
					'wp-submit': 'Log In',
					redirect_to: `${ORIGIN}/wp-admin/`,
					testcookie: '1'
				}).toString()
			});
			cookie = res.cookies
				.map((c) => c.split(';')[0] ?? '')
				.filter((c) => !c.endsWith('=deleted'))
				.join('; ');
			nonce = (
				await raw('/wp-admin/admin-ajax.php?action=rest-nonce', { headers: { cookie } })
			).body.trim();
			if (cookie === '' || nonce.length < 6) throw new Error('login failed');
		};
		await login();
		const rest = async (path: string, method: string, body?: unknown): Promise<Answer> => {
			const res = await fetchRaw(path, {
				method,
				headers: { cookie, 'x-wp-nonce': nonce, 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			if (method !== 'GET' && res.status >= 300) {
				note(`${method} ${path} answered ${res.status}: ${res.body.slice(0, 160)}`);
			}
			return res;
		};
		const create = async (path: string, body: unknown): Promise<Record<string, any>> => {
			const res = await rest(path, 'POST', body);
			if (res.status >= 300)
				throw new Error(`${path} answered ${res.status}: ${res.body.slice(0, 200)}`);
			return JSON.parse(res.body) as Record<string, any>;
		};

		// #region the site
		await create('/wp-json/wp/v2/settings', { posts_per_page: 3 });
		const news = await create('/wp-json/wp/v2/categories', { name: `Cat${token()}` });
		const notes = await create('/wp-json/wp/v2/categories', { name: `Cat${token()}` });
		const alpha = await create('/wp-json/wp/v2/tags', { name: `Tag${token()}` });
		const beta = await create('/wp-json/wp/v2/tags', { name: `Tag${token()}` });
		const model: Model = {
			blogname: 'Soak Site',
			theme: 'twentytwentyfive',
			themeShows: false,
			posts: [
				{
					id: 1,
					title: 'Hello world!',
					route: '/2026/01/01/hello-world/',
					status: 'publish',
					category: 1,
					comments: []
				}
			],
			categories: new Map([
				[1, { name: 'Uncategorized', slug: 'uncategorized' }],
				[news.id, { name: news.name, slug: news.slug }],
				[notes.id, { name: notes.name, slug: notes.slug }]
			]),
			secrets: [],
			gone: []
		};
		const publish = async (category: number, tag: number): Promise<number> => {
			const title = token();
			const made = await create('/wp-json/wp/v2/posts', {
				title,
				content: 'A post of the soak',
				status: 'publish',
				categories: [category],
				tags: [tag]
			});
			model.posts.push({
				id: made.id,
				title,
				route: new URL(made.link).pathname,
				status: 'publish',
				category,
				comments: []
			});
			// post_date has one second of resolution, so two posts in a second have no fixed order
			await sleep(1100);
			return made.id;
		};
		for (let i = 0; i < 6; i++)
			await publish(i % 2 === 0 ? news.id : notes.id, i % 2 === 0 ? alpha.id : beta.id);
		const seeds = model.posts.filter((p) => p.id > 1).map((p) => p.id);
		const month = new URL(model.posts[1]!.route, ORIGIN).pathname.split('/').slice(1, 3);
		// #endregion

		// #region the secrets: content only the owner may read, and the shape of the owner's own pages
		const secret = (kind: string) => `${kind}-${token()}`;
		const privateTitle = secret('PRIVTITLE');
		const privateBody = secret('PRIVBODY');
		const draftBody = secret('DRAFTBODY');
		const passwordBody = secret('PASSBODY');
		const heldBody = secret('HELDBODY');
		const heldMail = `held-${token()}@example.test`.toLowerCase();
		await create('/wp-json/wp/v2/posts', {
			title: privateTitle,
			content: privateBody,
			status: 'private'
		});
		await create('/wp-json/wp/v2/posts', {
			title: secret('DRAFTTITLE'),
			content: draftBody,
			status: 'draft'
		});
		const lockedTitle = secret('PASSTITLE');
		const locked = await create('/wp-json/wp/v2/posts', {
			title: lockedTitle,
			content: passwordBody,
			status: 'publish',
			password: token()
		});
		// published, so it takes a front page slot; its title is not one of the secrets
		model.locked = [{ id: locked.id as number, title: lockedTitle }];
		await create('/wp-json/wp/v2/comments', {
			post: 1,
			content: heldBody,
			author_name: 'Held Author',
			author_email: heldMail,
			status: 'hold'
		});
		model.secrets = [
			privateTitle,
			privateBody,
			draftBody,
			passwordBody,
			heldBody,
			heldMail,
			MAIL,
			nonce,
			'id="wpadminbar"',
			'Howdy, owner',
			...cookie
				.split('; ')
				.map((c) => c.split('=')[1] ?? '')
				.filter((v) => v.length >= 16)
		];
		// #endregion

		const routes = [
			'/',
			'/page/2/',
			'/page/3/',
			'/feed/',
			'/comments/feed/',
			'/sample-page/',
			model.posts[0]!.route,
			...model.posts.slice(1).map((p) => p.route),
			'/author/owner/',
			`/category/${news.slug}/`,
			`/category/${notes.slug}/`,
			`/tag/${alpha.slug}/`,
			`/tag/${beta.slug}/`,
			`/${month[0]}/`,
			`/${month[0]}/${month[1]}/`
		];
		probes.routes = routes.length;
		const anonymous = async (path: string, init: Init = {}) => fetchRaw(path, init);
		const settle = async (route: string): Promise<void> => {
			for (let i = 0; i < 4; i++) await anonymous(route);
		};

		for (const r of routes) await settle(r);
		model.themeShows = (await anonymous('/')).body.includes(`/themes/${model.theme}/`);
		probes.themeShows = model.themeShows;

		// #region the detectors, tried against planted violations
		const controls: Record<string, boolean> = {};
		const staleAnswer: Seen = { status: 200, body: 'old page', headers: {} };
		controls.stale = judgeAnswer(model, '/', staleAnswer).length > 0;
		controls.secretInAnonymousBody = judgeAnswer(model, '/', {
			status: 200,
			body: `${model.blogname} ${draftBody}`,
			headers: {}
		}).some((m) => m.startsWith('leaks'));
		controls.authenticatedFromStore =
			judgePrivate('auth', { status: 200, body: '', headers: { 'x-cfw-cache': 'MEM' } })
				.length > 0;
		controls.errorFromStore =
			judgeError({ status: 404, body: '', headers: { 'x-cfw-cache': 'EDGE' } }).length > 0;
		controls.cleanAnswerPasses =
			judgePrivate('auth', { status: 200, body: '', headers: { 'x-cfw-cache': 'RENDER' } })
				.length === 0 && judgeError({ status: 200, body: '', headers: {} }).length === 0;
		const heldRow = { path: '/a/', status: 200, rendered_at: 1, stale_at: null, bytes: 1 };
		const still = { generation: 1, announced: 0, wholesale: 0, floorPurges: 0 };
		controls.quietPurgeFlagged =
			judgeQuietWrite([heldRow], [], still, still).length > 0 &&
			judgeQuietWrite([heldRow], [{ ...heldRow, rendered_at: 2 }], still, still).length === 0;
		const planted = `/zz-control-${token().toLowerCase()}/`;
		let auditPlanted: string[];
		if (TARGET.deployed) {
			// the judge alone: a deployed run cannot write the row the local control reads back
			const row = { path: planted, status: 500, rendered_at: 1, stale_at: null, bytes: 1 };
			auditPlanted = judgeStore([row], { [draftBody]: [planted] });
		} else {
			await sql(
				"INSERT INTO cfw_page (path, status, content_type, html, rendered_at, render_ms) VALUES (?, 500, 'text/html', ?, 1, 1)",
				[planted, `<html>${draftBody}</html>`]
			);
			auditPlanted = await audit(model);
		}
		controls.plantedRowFlagged =
			auditPlanted.some((m) => m.includes(planted) && m.includes('status 500')) &&
			auditPlanted.some((m) => m.includes('is stored in') && m.includes(planted));
		if (!TARGET.deployed) await sql('DELETE FROM cfw_page WHERE path = ?', [planted]);
		controls.storeCleanAfterRemoval = (await audit(model)).length === 0;
		for (const [name, ok] of Object.entries(controls)) {
			if (!ok) note(`detector control ${name} did not fire`);
		}
		// #endregion

		async function audit(m: Model): Promise<string[]> {
			const rows = await storedRows();
			const leaks: Record<string, string[]> = {};
			for (const s of m.secrets) {
				const hit = await sql(
					'SELECT path FROM cfw_page WHERE instr(html, ?) > 0 OR instr(headers, ?) > 0',
					[s, s]
				);
				leaks[s] = ((hit.rows ?? []) as { path: string }[]).map((r) => r.path);
			}
			return judgeStore(rows, leaks);
		}

		const meter = async () => {
			const s = await stats();
			return { rowsToday: Number(s.rowsToday ?? 0), renders: Number(s.renders ?? 0) };
		};
		const m0 = await meter();
		timed.rowsBefore = m0.rowsToday;
		const rendersBefore = m0.renders;
		if (TARGET.deployed) {
			const start = rowsGuard(m0.rowsToday, TARGET.rowsStop, 0);
			if (start.stop) throw new Error(`refusing to start: ${start.message}`);
		}

		const etags = new Map<string, string>();
		const retired = new Map<string, string[]>();
		const gone = (route: string) => {
			const e = etags.get(route);
			if (e !== undefined) retired.set(route, [...(retired.get(route) ?? []), e]);
			etags.delete(route);
		};

		// #region reads
		// a wholesale purge marks rows superseded, and the object answers one `AGED` for up to a minute
		let wholesaleUntil = 0;
		let agedReads = 0;
		const checkAnonymous = (route: string, a: Answer, where: string) => {
			if (tierOf(a.headers) === 'AGED' && Date.now() < wholesaleUntil) {
				agedReads++;
				return;
			}
			for (const m of [...judgeAnswer(model, route, a), ...judgeError(a)]) {
				note(`${where} ${route}: ${m} (${tierOf(a.headers) || '-'})`);
			}
		};
		const readAnon = async (route: string, suffix = '') => {
			const a = await anonymous(route + suffix);
			checkAnonymous(route, a, 'read');
			const e = a.headers['etag'];
			if (a.status === 200 && e !== undefined && suffix === '') etags.set(route, e);
			log.push(`read|${route}${suffix}|${a.status}`);
		};
		// #endregion

		// #region confirming a write: every affected route must be right within the contract
		const confirm = async (
			kind: string,
			routesToCheck: string[],
			wrote: number,
			storedBefore?: number
		) => {
			for (const r of routesToCheck) gone(r);
			const pending = new Set(routesToCheck);
			let lastWhy = '';
			while (pending.size > 0 && Date.now() - wrote < FRESH_LIMIT_MS) {
				for (const r of [...pending]) {
					const a = await anonymous(r);
					const problems = judgeAnswer(model, r, a);
					if (problems.length === 0) {
						pending.delete(r);
						(timed.freshMs[kind] ??= []).push(Date.now() - wrote);
						if (a.status === 200 && a.headers['etag'] !== undefined) {
							etags.set(r, a.headers['etag']);
						}
					} else {
						timed.staleReads++;
						const byTier = (timed.staleTiers[kind] ??= {});
						const tier = tierOf(a.headers) || '-';
						byTier[tier] = (byTier[tier] ?? 0) + 1;
						lastWhy = `${r}: ${problems.join('; ')} (${tierOf(a.headers) || '-'})`;
					}
				}
				if (pending.size > 0) await sleep(250);
			}
			// a path the rule refuses renders fresh every time, so it is the oracle for the stored one;
			// it runs after the timing so its renders are not charged to the contract
			if (pending.size === 0) {
				for (const r of routesToCheck) {
					for (let i = 0; i < 20; i++) {
						const a = await anonymous(r);
						if (a.status !== 200) break;
						const truth = await anonymous(`${r}${r.includes('?') ? '&' : '?'}zz=1`);
						if (tokensOf(truth.body) === tokensOf(a.body)) break;
						if (i === 19) {
							note(
								`after ${kind} ${r} differs from a fresh render (${tokensOf(a.body)} against ${tokensOf(truth.body)})`
							);
						}
						await sleep(500);
					}
				}
			}
			if (pending.size > 0) {
				const route = [...pending][0]!;
				const front = await anonymous(route);
				const object = await anonymous(`/serve?path=${encodeURIComponent(route)}&edge=0`);
				const s = await stats();
				const truth = await anonymous(`${route}${route.includes('?') ? '&' : '?'}zz=1`);
				probes[`truth-${kind}`] = {
					route,
					tier: tierOf(truth.headers),
					problems: judgeAnswer(model, route, truth),
					titles: [...new Set(truth.body.match(/Tk[0-9a-z]{8}/g) ?? [])]
				};
				console.error(`[${label}] fresh render ${JSON.stringify(probes[`truth-${kind}`])}`);
				const missing = lastWhy.match(/missing (Tk[0-9a-z]{8})/)?.[1];
				if (missing !== undefined) {
					const found = await rest(
						`/wp-json/wp/v2/posts?search=${missing}&status=any&context=edit`,
						'GET'
					);
					const rows = JSON.parse(found.body) as {
						id: number;
						status: string;
						date: string;
					}[];
					probes[`diag-${missing}`] = rows.map((r) => `${r.id} ${r.status} ${r.date}`);
					console.error(
						`[${label}] ${missing}: ${JSON.stringify(probes[`diag-${missing}`])}`
					);
				}
				note(
					`never fresh after ${kind}: ${lastWhy}; front generation ${front.headers['x-cfw-generation']} ` +
						`${tierOf(front.headers)}, object generation ${s.generation}, object answer ` +
						`${tierOf(object.headers)} ${object.status} (stale: ${judgeAnswer(model, route, object).join('; ') || 'no'}; ` +
						`titles on it ${[...new Set(object.body.match(/Tk[0-9a-z]{8}/g) ?? [])].join(',')}; ` +
						`model front page ${frontPage(model)
							.map((p) => p.title)
							.join(',')}), ` +
						`rowsToday ${s.rowsToday}, queue ${(s.queue as unknown[]).length}`
				);
			}
			const worst = Math.max(0, ...(timed.freshMs[kind] ?? []).slice(-routesToCheck.length));
			const load = loadavg()[0] ?? 0;
			(timed.load[kind] ??= []).push(load);
			const over = judgeContract(
				kind,
				worst,
				routesToCheck.length,
				CONTRACT_OVERRIDE_MS,
				storedBefore
			);
			if (over !== undefined)
				note(`${over} (load average ${load.toFixed(1)} on ${cpus().length} cores)`);
		};
		// #endregion

		// #region editorial writes
		const livePosts = () =>
			model.posts.filter((p) => p.status === 'publish' && !seeds.includes(p.id) && p.id > 1);
		const catRoute = (id: number) => `/category/${model.categories.get(id)?.slug}/`;
		const tagRoute = (tag: number) => `/tag/${tag === alpha.id ? alpha.slug : beta.slug}/`;
		const stamp = async (): Promise<Map<string, number>> =>
			new Map((await storedRows()).map((r) => [r.path, r.rendered_at]));

		const purgeCounters = async (): Promise<PurgeCounters> => {
			const s = await stats();
			const tags = (s.wordpressTags ?? {}) as Record<string, number>;
			const last = s.lastScopedPurge as { generation?: number; purged?: number } | null;
			return {
				generation: Number(s.generation ?? 0),
				announced: Number(tags.announced ?? 0),
				wholesale: Number(tags.wholesale ?? 0),
				floorPurges: Number(tags.floorPurges ?? 0),
				...(last?.generation === undefined
					? {}
					: {
							lastScoped: {
								generation: last.generation,
								purged: Number(last.purged ?? 0)
							}
						})
			};
		};
		let refilledInWindow = 0;
		// judged at the purge: rows are read straight after the write, so a render the object does
		// later for an earlier write cannot read as a purge by this one
		const quietWrite = async <T>(label: string, act: () => Promise<T>): Promise<T> => {
			const before = await storedRows();
			const c0 = await purgeCounters();
			const result = await act();
			const after = await storedRows();
			const c1 = await purgeCounters();
			for (const m of judgeQuietWrite(before, after, c0, c1)) note(`${label} purged: ${m}`);
			const rendered = new Map(before.map((r) => [r.path, r.rendered_at]));
			refilledInWindow += after.filter(
				(r) => rendered.has(r.path) && rendered.get(r.path) !== r.rendered_at
			).length;
			probes.quietWriteEdgeBumps =
				Number(probes.quietWriteEdgeBumps ?? 0) + (c1.generation > c0.generation ? 1 : 0);
			probes.quietWriteRefills = refilledInWindow;
			return result;
		};

		const write = async (kind: (typeof WRITES)[number]) => {
			writesByKind[kind] = (writesByKind[kind] ?? 0) + 1;
			const sample = livePosts();
			switch (kind) {
				case 'publish': {
					const cat = roll() < 0.5 ? news.id : notes.id;
					const id = await publish(cat, cat === news.id ? alpha.id : beta.id);
					const post = model.posts.find((p) => p.id === id)!;
					const t = Date.now();
					log.push(`write|publish|${id}`);
					const tag = cat === news.id ? alpha.id : beta.id;
					await confirm(
						kind,
						[
							'/',
							'/feed/',
							post.route,
							catRoute(cat),
							tagRoute(tag),
							`/${month[0]}/${month[1]}/`
						],
						t
					);
					break;
				}
				case 'edit': {
					const post =
						sample[Math.floor(roll() * sample.length)] ??
						model.posts.find((p) => p.id === seeds[0])!;
					const title = token();
					model.gone.push(post.title);
					post.title = title;
					const r = await rest(`/wp-json/wp/v2/posts/${post.id}`, 'POST', { title });
					const t = Date.now();
					log.push(`write|edit|${post.id}|${r.status}`);
					await confirm(kind, ['/', '/feed/', post.route, catRoute(post.category)], t);
					break;
				}
				case 'trash': {
					if (sample.length === 0) return write('publish');
					const post = sample[Math.floor(roll() * sample.length)]!;
					model.gone.push(post.title);
					post.status = 'trash';
					const r = await rest(`/wp-json/wp/v2/posts/${post.id}`, 'DELETE');
					const t = Date.now();
					log.push(`write|trash|${post.id}|${r.status}`);
					await confirm(kind, [post.route, '/', '/feed/', catRoute(post.category)], t);
					break;
				}
				case 'comment-approve': {
					const kept = model.posts.filter((p) => p.id === 1 || seeds.includes(p.id));
					const post = kept[Math.floor(roll() * kept.length)]!;
					const text = token();
					const held = await create('/wp-json/wp/v2/comments', {
						post: post.id,
						content: text,
						author_name: 'Reader',
						author_email: `reader-${text}@example.test`.toLowerCase(),
						status: 'hold'
					});
					await sleep(400);
					const before = await anonymous(post.route);
					if (before.body.includes(text)) note(`a held comment showed on ${post.route}`);
					post.comments.push(text);
					model.lastComment = text;
					const r = await rest(`/wp-json/wp/v2/comments/${held.id}`, 'POST', {
						status: 'approve'
					});
					const t = Date.now();
					log.push(`write|comment-approve|${post.id}|${r.status}`);
					await confirm(kind, [post.route, '/comments/feed/'], t);
					break;
				}
				case 'term-edit': {
					const id = roll() < 0.5 ? news.id : notes.id;
					const name = token();
					const cat = model.categories.get(id)!;
					model.gone.push(cat.name);
					cat.name = name;
					const r = await rest(`/wp-json/wp/v2/categories/${id}`, 'POST', { name });
					const t = Date.now();
					log.push(`write|term-edit|${id}|${r.status}`);
					const inCat = model.posts.find(
						(p) => p.category === id && p.status === 'publish'
					)?.route;
					await confirm(kind, [catRoute(id), ...(inCat === undefined ? [] : [inCat])], t);
					break;
				}
				case 'option-change': {
					const name = `Soak ${token()}`;
					model.gone.push(model.blogname);
					model.blogname = name;
					const stored = (await storedRows()).length;
					const r = await rest('/wp-json/wp/v2/settings', 'POST', { title: name });
					const t = Date.now();
					wholesaleUntil = t + AGED_WINDOW_MS;
					log.push(`write|option-change|${r.status}`);
					await confirm(
						kind,
						['/', '/sample-page/', model.posts[1]!.route, '/feed/'],
						t,
						stored
					);
					break;
				}
				case 'theme-switch': {
					const target =
						model.theme === 'twentytwentyfive'
							? 'twentytwentyfour'
							: 'twentytwentyfive';
					const page = await raw('/wp-admin/themes.php', { headers: { cookie } });
					const link = page.body.match(
						new RegExp(
							`themes\\.php\\?action=activate&(?:amp;|#038;)?stylesheet=${target}&(?:amp;|#038;)?_wpnonce=[0-9a-f]+`
						)
					);
					if (link === null) {
						probes.themeSwitchUnavailable = true;
						return;
					}
					const url = `/wp-admin/${link[0].replaceAll('&amp;', '&').replaceAll('&#038;', '&')}`;
					model.theme = target;
					const stored = (await storedRows()).length;
					const r = await raw(url, { headers: { cookie } });
					const t = Date.now();
					wholesaleUntil = t + AGED_WINDOW_MS;
					log.push(`write|theme-switch|${target}|${r.status}`);
					await confirm(kind, ['/', '/sample-page/', model.posts[1]!.route], t, stored);
					break;
				}
				case 'menu-edit': {
					const before = await stamp();
					const menu = await create('/wp-json/wp/v2/menus', { name: token() });
					const t = Date.now();
					await create('/wp-json/wp/v2/menu-items', {
						title: token(),
						url: `${ORIGIN}/`,
						menus: menu.id,
						status: 'publish'
					});
					const wrote = Date.now();
					wholesaleUntil = wrote + AGED_WINDOW_MS;
					log.push(`write|menu-edit|${menu.id}`);
					for (const r of ['/', '/sample-page/']) gone(r);
					const deadline = Date.now() + FRESH_LIMIT_MS;
					let ok = false;
					while (Date.now() < deadline && !ok) {
						const rows = await storedRows();
						ok = rows.every(
							(r) =>
								r.stale_at !== null ||
								r.rendered_at > t ||
								before.get(r.path) !== r.rendered_at
						);
						if (!ok) await sleep(250);
					}
					(timed.freshMs[kind] ??= []).push(Date.now() - wrote);
					if (!ok) note('a stored row survived a menu edit unmarked');
					break;
				}
				case 'draft-save': {
					const title = secret('DRAFT2');
					const made = await quietWrite('a draft save', () =>
						create('/wp-json/wp/v2/posts', { title, content: 'draft', status: 'draft' })
					);
					log.push(`write|draft-save|${made.id}`);
					break;
				}
				case 'comment-hold': {
					const text = secret('HOLD');
					model.secrets.push(text);
					await quietWrite('a held comment', () =>
						create('/wp-json/wp/v2/comments', {
							post: 1,
							content: text,
							author_name: 'Held',
							author_email: `held-${text.toLowerCase()}@example.test`,
							status: 'hold'
						})
					);
					log.push('write|comment-hold');
					break;
				}
			}
		};
		// #endregion

		const refused = [
			() => `/?s=${token().toLowerCase()}`,
			() => '/?replytocom=1',
			() => '/?preview=true',
			(i: number) => `/nope-${i % 7}/`,
			() => '/wp-json/wp/v2/posts',
			() => '/wp-sitemap.xml',
			() => '/wp-login.php'
		];

		// #region the loop
		for (let i = 0; i < OPERATIONS_COUNT; i++) {
			const op = pick(OPERATIONS, roll());
			byKind[op.kind] = (byKind[op.kind] ?? 0) + 1;
			const route = routes[Math.floor(roll() * routes.length)]!;
			switch (op.kind) {
				case 'read':
					await readAnon(route);
					break;
				case 'tracking': {
					const a = await anonymous(
						`${route}${route.includes('?') ? '&' : '?'}utm_campaign=soak&fbclid=${i}`
					);
					checkAnonymous(route, a, 'tracking');
					log.push(`tracking|${route}|${a.status}`);
					break;
				}
				case 'conditional': {
					const current = etags.get(route);
					const old = retired.get(route)?.at(-1);
					const useOld = old !== undefined && (current === undefined || roll() < 0.5);
					const sent = useOld ? old : current;
					if (sent === undefined) {
						await readAnon(route);
						break;
					}
					const a = await anonymous(route, { headers: { 'if-none-match': sent } });
					if (a.status === 304) {
						if (useOld) note(`a retired validator earned a 304 on ${route}`);
						if (a.body !== '') note(`a 304 carried a body on ${route}`);
						if (a.headers['etag'] !== sent)
							note(`a 304 on ${route} named a different validator`);
					} else {
						checkAnonymous(route, a, 'conditional');
					}
					log.push(`conditional|${route}|${useOld ? 'old' : 'current'}`);
					break;
				}
				case 'head': {
					const a = await anonymous(route, { method: 'HEAD' });
					const want =
						model.posts.find((p) => p.route === route)?.status === 'publish' ||
						!model.posts.some((p) => p.route === route);
					if (want && a.status !== 200) note(`HEAD ${route} answered ${a.status}`);
					if (a.body !== '') note(`HEAD ${route} carried a body`);
					log.push(`head|${route}|${a.status}`);
					break;
				}
				case 'refused': {
					const path = refused[i % refused.length]!(i);
					const a = await anonymous(path);
					for (const m of [...judgePrivate('refused', a), ...judgeError(a)])
						note(`${path}: ${m}`);
					for (const s of model.secrets)
						if (a.body.includes(s)) note(`${path} leaked ${s.slice(0, 12)}`);
					log.push(`refused|${path.replace(/[A-Za-z0-9]{10,}/, 'x')}|${a.status}`);
					break;
				}
				case 'auth-read': {
					const a = await anonymous(route, { headers: { cookie } });
					for (const m of [...judgePrivate('auth', a), ...judgeError(a)])
						note(`auth ${route}: ${m}`);
					log.push(`auth-read|${route}|${a.status}`);
					break;
				}
				case 'ajax': {
					const a =
						i % 2 === 0
							? await anonymous('/wp-admin/admin-ajax.php?action=rest-nonce', {
									headers: { cookie }
								})
							: await anonymous('/wp-admin/admin-ajax.php', {
									method: 'POST',
									headers: { ...FORM, cookie },
									body: 'action=heartbeat&_nonce=0'
								});
					for (const m of judgePrivate('auth', a)) note(`ajax: ${m}`);
					log.push(`ajax|${i % 2}|${a.status}`);
					break;
				}
				case 'rest-read': {
					const a = await rest(
						'/wp-json/wp/v2/posts?context=edit&per_page=100&status=draft,private,publish',
						'GET'
					);
					for (const m of judgePrivate('auth', a)) note(`rest: ${m}`);
					if (!a.body.includes(draftBody))
						note('the owner could not read their own draft over REST');
					const anon = await anonymous('/wp-json/wp/v2/posts?status=draft,private');
					for (const s of model.secrets)
						if (anon.body.includes(s)) note(`anonymous REST leaked ${s.slice(0, 12)}`);
					log.push(`rest-read|${a.status}|${anon.status}`);
					break;
				}
				case 'write': {
					const kind = WRITES[Math.floor(roll() * WRITES.length)]!;
					try {
						await write(kind);
					} catch (e) {
						note(`${kind} failed: ${String((e as Error).message).slice(0, 200)}`);
					}
					break;
				}
			}
			if ((i + 1) % 500 === 0 || i === OPERATIONS_COUNT - 1) {
				const rows = await storedRows();
				for (const m of await audit(model)) note(`audit at ${i + 1}: ${m}`);
				const mm = await meter();
				timed.barriers.push({
					at: i + 1,
					rows: rows.length,
					bytes: rows.reduce((s, r) => s + r.bytes, 0),
					rowsToday: mm.rowsToday
				});
				console.error(
					`[${label}] ${i + 1}/${OPERATIONS_COUNT} operations, ${timed.requests} requests, ${rows.length} rows, ${violations.length} violations, rowsToday ${mm.rowsToday}`
				);
				if (TARGET.deployed) {
					const guard = rowsGuard(mm.rowsToday, TARGET.rowsStop, i + 1);
					if (guard.stop) {
						timed.stoppedBy = guard.message;
						note(guard.message);
						break;
					}
				}
			}
		}
		// #endregion

		const afterMeter = await meter();
		timed.rowsAfter = afterMeter.rowsToday;
		timed.renders = afterMeter.renders - rendersBefore;
		if (timed.stoppedBy !== undefined) {
			return {
				stable: {
					seed,
					operations: OPERATIONS_COUNT,
					byKind,
					writesByKind,
					logDigest: digest(undated(log.join('\n'))),
					violations,
					storedPaths: (await storedRows()).map((r) => r.path)
				},
				timed,
				controls,
				probes,
				skipped: [...skips, skipped('stampede arm and restart arm', timed.stoppedBy)],
				ownerRoutes,
				transportRetries
			};
		}
		await sleep(2500);
		const finalRows = await storedRows();
		const storedPaths = finalRows.map((r) => r.path);

		// #region the stampede arm
		const stampede: Record<string, unknown> = {};
		const herd = async (path: string, n: number) => {
			const before = (await meter()).renders;
			const started = Date.now();
			const answers = await Promise.all(Array.from({ length: n }, () => raw(path)));
			const wallMs = Date.now() - started;
			timed.requests += n;
			await sleep(1500);
			const after = (await meter()).renders;
			return {
				path,
				n,
				wallMs,
				// answers that rendered in the request, which the object's own counter does not show here
				renders: answers.filter((a) => tierOf(a.headers) === 'RENDER').length,
				counterDelta: after - before,
				statuses: [...new Set(answers.map((a) => a.status))],
				bodies: new Set(answers.map((a) => digest(a.body))).size,
				tiers: answers.reduce<Record<string, number>>((acc, a) => {
					const t = tierOf(a.headers) || '-';
					acc[t] = (acc[t] ?? 0) + 1;
					return acc;
				}, {})
			};
		};
		// a post nobody has read has no copy in any tier, and the queue is drained so no fill is counted
		const fresh = await publish(news.id, alpha.id);
		const cold = model.posts.find((p) => p.id === fresh)!.route;
		await confirm('stampede-setup', ['/'], Date.now());
		for (let i = 0; i < 120 && ((await stats()).queue as unknown[]).length > 0; i++)
			await sleep(500);
		await sleep(1500);
		let coldKey = true;
		if (TARGET.deployed) {
			// /sql is closed here, so the key must already be empty: a post nobody has read is
			const held = await sql('SELECT count(*) AS n FROM cfw_page WHERE path = ?', [cold]);
			coldKey = Number(((held.rows ?? []) as { n: number }[])[0]?.n ?? 0) === 0;
			if (!coldKey) {
				skips.push(
					skipped(
						'stampede cold key',
						`${cold} already holds a row and clearing it needs /sql`
					)
				);
			}
		} else {
			await sql('DELETE FROM cfw_page WHERE path = ?', [cold]);
		}
		if (coldKey) stampede.cold = await herd(cold, 50);
		stampede.controlRefused = await herd(`/?s=${token().toLowerCase()}`, 12);
		// one render and the rest served from what it stored; two renders of one key is a defect
		const herdOk =
			!coldKey ||
			((stampede.cold as { renders: number }).renders === 1 &&
				(stampede.cold as { bodies: number }).bodies === 1 &&
				(stampede.cold as { statuses: number[] }).statuses.join() === '200');
		const controlBites = (stampede.controlRefused as { renders: number }).renders >= 10;
		if (!herdOk) note(`stampede: ${JSON.stringify(stampede.cold)}`);
		if (!controlBites)
			note(
				`stampede control did not render per request: ${JSON.stringify(stampede.controlRefused)}`
			);
		// #endregion

		// #region the restart arm
		const restart: Record<string, unknown> = {};
		await sleep(3000);
		const rowsBefore = await storedRows();
		const digestsBefore = new Map<string, string>();
		for (const r of rowsBefore) {
			const html = await sql('SELECT html FROM cfw_page WHERE path = ?', [r.path]);
			digestsBefore.set(
				r.path,
				digest(String(((html.rows ?? []) as { html: string }[])[0]?.html ?? ''))
			);
		}
		const generationBefore = Number(
			(await raw(`/serve?path=${encodeURIComponent('/')}&edge=0`)).headers['x-cfw-generation']
		);
		if (TARGET.deployed) {
			// a fresh interpreter in place of a fresh process; the stored rows must survive it the same way
			if (ownerRoutes?.['/recycle'] === 'ok') {
				const recycled = await owner('/recycle', { method: 'POST' });
				restart.mode = 'recycle';
				restart.recycleStatus = recycled.status;
				if (recycled.status !== 200) note(`/recycle answered ${recycled.status}`);
				await rig.ready();
			} else {
				restart.mode = 'none';
			}
		} else {
			await rig.stop();
			rig.start();
			await rig.ready();
		}
		const rowsAfterRestart = await storedRows();
		const lost = rowsBefore
			.filter((r) => !rowsAfterRestart.some((a) => a.path === r.path))
			.map((r) => r.path);
		const changed: string[] = [];
		for (const r of rowsAfterRestart) {
			const html = await sql('SELECT html FROM cfw_page WHERE path = ?', [r.path]);
			const d = digest(String(((html.rows ?? []) as { html: string }[])[0]?.html ?? ''));
			if (digestsBefore.has(r.path) && digestsBefore.get(r.path) !== d) changed.push(r.path);
		}
		const warmPath = model.posts[1]!.route;
		const objectHit = await raw(`/serve?path=${encodeURIComponent(warmPath)}&edge=0`);
		const generationAfter = Number(objectHit.headers['x-cfw-generation']);
		restart.rowsBefore = rowsBefore.length;
		restart.rowsAfter = rowsAfterRestart.length;
		restart.lost = lost;
		restart.changed = changed;
		restart.objectAnswer = tierOf(objectHit.headers);
		restart.phpBooted = objectHit.headers['x-cfw-php-booted'] ?? null;
		restart.generationBefore = generationBefore;
		restart.generationAfter = generationAfter;
		if (lost.length > 0) note(`restart lost stored rows: ${lost.join(', ')}`);
		if (changed.length > 0) note(`restart changed stored rows: ${changed.join(', ')}`);
		if (tierOf(objectHit.headers) !== 'HIT')
			note(`after a restart a stored page answered ${tierOf(objectHit.headers)}`);
		if (!(generationAfter >= generationBefore))
			note(`the generation went from ${generationBefore} to ${generationAfter}`);
		// the session and a purge still work after the restart
		await login();
		const post =
			model.posts.find((p) => p.status === 'publish' && !seeds.includes(p.id) && p.id > 1) ??
			model.posts[1]!;
		const title = token();
		model.gone.push(post.title);
		post.title = title;
		const edit = await rest(`/wp-json/wp/v2/posts/${post.id}`, 'POST', { title });
		const wrote = Date.now();
		await confirm('restart-edit', [post.route, '/'], wrote);
		restart.purgeAfterRestart = { status: edit.status, freshMs: timed.freshMs['restart-edit'] };
		// #endregion

		const finalStats = await stats();
		const counters = {
			wordpressTags: finalStats.wordpressTags,
			pageKv: finalStats.pageKv,
			rowsToday: finalStats.rowsToday,
			limits: finalStats.limits
		};
		probes.agedReads = agedReads;
		const stable: Stable = {
			seed,
			operations: OPERATIONS_COUNT,
			byKind,
			writesByKind,
			logDigest: digest(undated(log.join('\n'))),
			violations,
			storedPaths
		};
		return {
			stable,
			timed,
			controls,
			stampede,
			restart,
			counters,
			probes,
			skipped: skips,
			ownerRoutes,
			transportRetries
		};
	} finally {
		await rig.remove();
	}
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		for (const rig of RIGS) {
			try {
				if (rig.child?.pid !== undefined) process.kill(-rig.child.pid, 'SIGTERM');
			} catch {
				// already gone
			}
		}
		process.exit(130);
	});
}

const runs: Run[] = [];
const labels = process.argv.includes('--determinism') ? ['run-a', 'run-b'] : ['run'];
for (const label of labels) runs.push(await execute(SEED, label));

const report = {
	figures: TARGET.deployed
		? `deployed: ${TARGET.origin}, the shipped WORDPRESS_PAGE_CACHE default, rows guard at ${TARGET.rowsStop}`
		: `local: wrangler dev on this machine, PLAN ${PLAN}, WORDPRESS_PAGE_CACHE 1`,
	contractMs:
		CONTRACT_OVERRIDE_MS ?? 'one render per route plus one fill, 3000 ms each, plus 2000 ms',
	host: { cores: cpus().length, loadAverageAtEnd: loadavg()[0] },
	runs: runs.map((r) => ({
		stable: r.stable,
		requests: r.timed.requests,
		tiers: r.timed.tiers,
		freshMs: Object.fromEntries(
			Object.entries(r.timed.freshMs).map(([k, v]) => [k, spread(v)])
		),
		loadAverage: Object.fromEntries(
			Object.entries(r.timed.load).map(([k, v]) => [k, spread(v)])
		),
		staleReadsInsideWindow: r.timed.staleReads,
		staleTiers: r.timed.staleTiers,
		rowsToday: { before: r.timed.rowsBefore, after: r.timed.rowsAfter },
		rendersDuringSoak: r.timed.renders,
		barriers: r.timed.barriers,
		controls: r.controls,
		stampede: r.stampede,
		restart: r.restart,
		counters: r.counters,
		probes: r.probes,
		...(TARGET.deployed
			? {
					skipped: r.skipped,
					ownerRoutes: r.ownerRoutes,
					stoppedByRowsGuard: r.timed.stoppedBy ?? null
				}
			: {})
	})),
	determinism:
		runs.length === 2
			? {
					same: sameStable(runs[0]!.stable, runs[1]!.stable),
					a: runs[0]!.stable.logDigest,
					b: runs[1]!.stable.logDigest
				}
			: undefined,
	violations: runs.flatMap((r) => r.stable.violations)
};
const text = JSON.stringify(report, null, 2);
console.log(text);
const out = arg('out', '');
if (out !== '') writeFileSync(out, text);
const stopped = runs.some((r) => r.timed.stoppedBy !== undefined);
process.exit(
	stopped ? 3 : report.violations.length === 0 && (report.determinism?.same ?? true) ? 0 : 1
);
