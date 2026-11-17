/**
 * Drives the WordPress page cache on a local `wrangler dev`: what a stored page costs and which tier
 * answers it, what a post save purges, and a matrix of requests that try to get an anonymous visitor
 * a page that is personal, stale or planted. Every case must stay out of the store.
 *
 * `--controls` then removes, for each case, the rules that stop it (a source edit that wrangler
 * reloads, restored when the run ends) and reports whether the case gets into the store, so a rule
 * with no effect shows. The password is generated per run and the state directory is deleted.
 *
 * Usage: `bun scripts/wp/cache-e2e.ts [--controls]` (environment: `E2E_PORT`, `E2E_OUT`).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const RULE_FILE = join(ROOT, 'src/wordpress/store-rule.ts');
const PORT = Number(process.env.E2E_PORT ?? 8793);
const ORIGIN = `http://localhost:${PORT}`;
const PASS = `pw-${crypto.randomUUID()}`;
const STATE = mkdtempSync(join(tmpdir(), 'wp-cache-e2e-'));
const CONTROLS = process.argv.includes('--controls');
const BACKUP = join(STATE, 'store-rule.ts.original');

type Answer = {
	status: number;
	headers: Record<string, string>;
	body: string;
	cookies: string[];
};
type Init = { method?: string; headers?: Record<string, string>; body?: string };

const SEEN = ['HIT', 'EDGE', 'MEM', 'KV', 'AGED'];
const stored = (a: Answer): boolean => SEEN.includes(a.headers['x-cfw-cache'] ?? '');

const log: string[] = [];
let reloads = 0;
const vars = [
	'PW_DIAGNOSTICS:1',
	'CMS:wordpress',
	'PLAN:paid',
	`SITE_ORIGIN:${ORIGIN}`,
	'SQL_CHUNK_PREFIX:wordpress/sql',
	'HEAP_SNAPSHOT:0',
	'CRON_INTERVAL_MS:0',
	'WORDPRESS_PAGE_CACHE:1'
];
const worker: ChildProcess = spawn(
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
		STATE,
		...vars.flatMap((v) => ['--var', v])
	],
	{ cwd: ROOT, detached: true }
);
const onLog = (d: unknown) => {
	const text = String(d);
	log.push(text);
	reloads += (text.match(/Reloading local server|Ready on/g) ?? []).length;
};
worker.stdout?.on('data', onLog);
worker.stderr?.on('data', onLog);

const restore = () => {
	try {
		copyFileSync(BACKUP, RULE_FILE);
	} catch {
		// no backup was taken
	}
};
const stop = async () => {
	restore();
	try {
		if (worker.pid !== undefined) process.kill(-worker.pid, 'SIGTERM');
	} catch {
		// already gone
	}
	await new Promise((r) => setTimeout(r, 1500));
	rmSync(STATE, { recursive: true, force: true });
};
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
	process.on(sig, () => void stop().then(() => process.exit(130)));
}

/** one raw request, so a Host header, a doubled slash or an encoded slash arrive as written */
function raw(path: string, init: Init = {}): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: 'localhost',
				port: PORT,
				path,
				method: init.method ?? 'GET',
				headers: { accept: '*/*', ...init.headers }
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
						cookies: res.headers['set-cookie'] ?? []
					});
				});
			}
		);
		req.on('error', reject);
		req.end(init.body);
	});
}

const json = async (path: string): Promise<Record<string, unknown>> =>
	JSON.parse((await raw(path)).body) as Record<string, unknown>;
const sql = (q: string, params: unknown[] = []) =>
	json(`/sql?q=${encodeURIComponent(q)}&params=${encodeURIComponent(JSON.stringify(params))}`);
const rows = async (): Promise<string[]> =>
	((await sql('SELECT path FROM cfw_page ORDER BY path')).rows as { path: string }[]).map(
		(r) => r.path
	);

async function ready(): Promise<void> {
	const deadline = Date.now() + 240_000;
	for (;;) {
		try {
			if ((await raw('/wp-login.php')).status === 200) return;
		} catch {
			// not listening yet
		}
		if (Date.now() > deadline) throw new Error('the worker never answered 200');
		await new Promise((r) => setTimeout(r, 1500));
	}
}

async function waitReload(from: number): Promise<void> {
	const deadline = Date.now() + 120_000;
	while (reloads <= from && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
	await new Promise((r) => setTimeout(r, 2500));
	await ready();
}

const tierHeaders = (a: Answer) => ({
	status: a.status,
	cache: a.headers['x-cfw-cache'] ?? null,
	edge: a.headers['x-cfw-edge'] ?? null,
	lane: a.headers['x-cfw-lane'] ?? null,
	inlineBoot: a.headers['x-cfw-inline-boot'] ?? null,
	phpBooted: a.headers['x-cfw-php-booted'] ?? null,
	serveMs: a.headers['x-cfw-serve-ms'] ?? null,
	workerMs: a.headers['x-worker-ms'] ?? null,
	cacheControl: a.headers['cache-control'] ?? null,
	bytes: a.body.length
});

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const H = 'b'.repeat(32);
const POST_PATH = '/2026/01/01/hello-world/';
const PAGE_PATH = '/sample-page/';
const DATE_PATH = '/2026/01/';

type Case = {
	id: string;
	what: string;
	rules: string[];
	/** the path whose row must not appear, and whose later clean answer must not carry the marker */
	victim: string;
	attack: () => Promise<Answer[]>;
	/** a marker the stored or later clean answer must never carry */
	marker?: string;
	/** a second layer that also stops it, so removing the rule alone may not let it in */
	also?: string;
};

const twice = async (path: string, init: Init = {}): Promise<Answer[]> => [
	await raw(path, init),
	await raw(path, init)
];

const CASES: Case[] = [
	{
		id: 'search',
		what: 'a search',
		rules: ['query-param'],
		victim: '/?s=hello',
		attack: () => twice('/?s=hello')
	},
	{
		id: 'search-pretty',
		what: 'a pretty search',
		rules: ['search-path'],
		victim: '/search/hello/',
		attack: () => twice('/search/hello/')
	},
	{
		id: 'search-flood',
		what: '30 distinct searches, one row each if stored',
		rules: ['query-param'],
		victim: '/?s=flood0',
		attack: async () => {
			const out: Answer[] = [];
			for (let i = 0; i < 30; i++) out.push(await raw(`/?s=flood${i}`));
			return out;
		}
	},
	{
		id: 'preview',
		what: 'a preview link',
		rules: ['query-param'],
		victim: '/?p=1&preview=true',
		attack: () => twice('/?p=1&preview=true')
	},
	{
		id: 'replytocom',
		what: 'a reply link',
		rules: ['query-param'],
		victim: `${POST_PATH}?replytocom=3`,
		attack: () => twice(`${POST_PATH}?replytocom=3`)
	},
	{
		id: 'unapproved',
		what: 'the held-comment notice',
		rules: ['query-param'],
		victim: `${POST_PATH}?unapproved=3&moderation-hash=abc`,
		attack: () => twice(`${POST_PATH}?unapproved=3&moderation-hash=abc`)
	},
	{
		id: 'rest-query',
		what: 'REST through the query',
		rules: ['query-param'],
		victim: '/?rest_route=%2Fwp%2Fv2%2Fposts',
		attack: () => twice('/?rest_route=%2Fwp%2Fv2%2Fposts')
	},
	{
		id: 'rest',
		what: 'a REST collection',
		rules: ['wp-internal'],
		victim: '/wp-json/wp/v2/posts',
		attack: () => twice('/wp-json/wp/v2/posts')
	},
	{
		id: 'login',
		what: 'the login page',
		rules: ['wp-internal', 'file-extension', 'set-cookie', 'cache-control', 'nonce'],
		victim: '/wp-login.php',
		attack: () => twice('/wp-login.php')
	},
	{
		id: 'admin',
		what: '/wp-admin/ without a cookie',
		rules: ['wp-internal', 'status'],
		victim: '/wp-admin/',
		attack: () => twice('/wp-admin/')
	},
	{
		id: 'anon-nonce',
		what: 'the anonymous REST nonce',
		rules: ['wp-internal', 'file-extension', 'content-type', 'incomplete'],
		victim: '/wp-admin/admin-ajax.php?action=rest-nonce',
		attack: () => twice('/wp-admin/admin-ajax.php?action=rest-nonce')
	},
	{
		id: 'robots',
		what: 'robots.txt',
		rules: ['file-extension', 'content-type', 'incomplete'],
		victim: '/robots.txt',
		attack: () => twice('/robots.txt')
	},
	{
		id: 'post',
		what: 'a POST to the front page',
		rules: ['method'],
		also: 'fillOne() only stores a GET',
		victim: '/',
		attack: () => twice('/', { method: 'POST', headers: FORM, body: 'a=1' })
	},
	{
		id: 'comment-post',
		what: 'a comment submission',
		rules: ['method'],
		also: 'fillOne() only stores a GET',
		victim: '/wp-comments-post.php',
		attack: () =>
			twice('/wp-comments-post.php', {
				method: 'POST',
				headers: FORM,
				body: 'comment=x&comment_post_ID=1'
			})
	},
	{
		id: 'cookie-login',
		what: 'a login cookie that is not valid',
		rules: ['cookie'],
		also: 'a cookie makes the request personal before the rule',
		victim: PAGE_PATH,
		attack: () => twice(PAGE_PATH, { headers: { cookie: `wordpress_logged_in_${H}=x` } })
	},
	{
		id: 'cookie-settings',
		what: 'a wp-settings cookie',
		rules: ['cookie'],
		also: 'a cookie makes the request personal before the rule',
		victim: PAGE_PATH,
		attack: () =>
			twice(PAGE_PATH, { headers: { cookie: 'wp-settings-1=libraryContent%3Dbrowse' } })
	},
	{
		id: 'cookie-commenter',
		what: 'a commenter cookie',
		marker: 'EveMarker7',
		rules: ['cookie'],
		also: 'a cookie makes the request personal before the rule',
		victim: PAGE_PATH,
		attack: () =>
			twice(PAGE_PATH, {
				headers: {
					cookie: `comment_author_${H}=EveMarker7; comment_author_email_${H}=eve%40evil.example`
				}
			})
	},
	{
		id: 'authorization',
		what: 'an application password',
		rules: ['authorization'],
		also: 'an Authorization header makes the request personal before the rule',
		victim: PAGE_PATH,
		attack: () => twice(PAGE_PATH, { headers: { authorization: 'Basic b3duZXI6eHh4eA==' } })
	},
	{
		id: 'xf-host',
		what: 'X-Forwarded-Host',
		marker: 'evil.example',
		rules: [],
		also: 'the origin is pinned, so the body never takes the forwarded host',
		victim: PAGE_PATH,
		attack: () => twice(PAGE_PATH, { headers: { 'x-forwarded-host': 'evil.example' } })
	},
	{
		id: 'forwarded',
		what: 'Forwarded and X-Original-URL',
		marker: 'evil.example',
		rules: ['header-override'],
		victim: DATE_PATH,
		attack: () =>
			twice(DATE_PATH, {
				headers: {
					forwarded: 'host=evil.example;proto=http',
					'x-original-url': '/wp-admin/'
				}
			})
	},
	{
		id: 'method-override',
		what: 'X-HTTP-Method-Override: DELETE',
		rules: ['header-override'],
		victim: '/author/owner/',
		attack: () => twice('/author/owner/', { headers: { 'x-http-method-override': 'DELETE' } })
	},
	{
		id: 'wp-nonce-header',
		what: 'X-WP-Nonce on a page',
		rules: ['header-override'],
		victim: '/2026/',
		attack: () => twice('/2026/', { headers: { 'x-wp-nonce': 'abcdef0123' } })
	},
	{
		id: 'host',
		what: 'a Host header naming another site',
		marker: 'evil.example',
		rules: [],
		also: 'the origin is pinned, so the body never takes the request host',
		victim: PAGE_PATH,
		attack: () => twice(PAGE_PATH, { headers: { host: 'evil.example' } })
	},
	{
		id: 'xf-proto',
		what: 'X-Forwarded-Proto: https on an http site',
		marker: 'https://localhost',
		rules: [],
		also: 'WP_HOME fixes the scheme, so the stored body keeps the canonical origin',
		victim: DATE_PATH,
		attack: () =>
			twice(DATE_PATH, {
				headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '6.6.6.6' }
			})
	},
	{
		id: 'upper',
		what: 'a capital in the path',
		rules: ['path-case', 'path-chars', 'key-form', 'status'],
		victim: '/SAMPLE-page/',
		attack: () => twice('/SAMPLE-page/')
	},
	{
		id: 'no-slash',
		what: 'the path without its trailing slash',
		rules: ['status'],
		victim: '/sample-page',
		attack: () => twice('/sample-page')
	},
	{
		id: 'double-slash',
		what: 'a doubled slash',
		rules: ['path-shape', 'status'],
		victim: '/sample-page//',
		attack: () => twice('/sample-page//')
	},
	{
		id: 'encoded-slash',
		what: 'an encoded slash',
		rules: ['path-encoding', 'status'],
		victim: '/sample-page%2f',
		attack: () => twice('/sample-page%2f')
	},
	{
		id: 'unknown-flood',
		what: '20 distinct unknown query variables',
		rules: ['query-param'],
		victim: `${PAGE_PATH}?x=0`,
		attack: async () => {
			const out: Answer[] = [];
			for (let i = 0; i < 20; i++) out.push(await raw(`${PAGE_PATH}?x=${i}`));
			return out;
		}
	},
	{
		id: 'not-found-flood',
		what: '20 distinct pages that do not exist',
		rules: ['status'],
		victim: '/nope-0/',
		attack: async () => {
			const out: Answer[] = [];
			for (let i = 0; i < 20; i++) out.push(await raw(`/nope-${i}/`));
			return out;
		}
	}
];

const BASELINE = [POST_PATH, PAGE_PATH, DATE_PATH, '/author/owner/', '/2026/'];

type Outcome = {
	id: string;
	what: string;
	rules: string[];
	entered: boolean;
	why: string;
	tiers: string[];
	rowsAfter: string[];
};

async function runCase(c: Case): Promise<Outcome> {
	// a clean slate for the victim: no row, and a new generation so no copy of it is in a cache
	await sql('DELETE FROM cfw_page WHERE path = ?', [c.victim]);
	await raw('/bump?reason=case');
	const before = await rows();
	const answers = await c.attack();
	const after = await rows();
	const minted = after.filter((p) => !before.includes(p));
	const clean = await raw(
		c.victim.startsWith('/?') || c.victim.includes('?') ? PAGE_PATH : c.victim
	);
	const marked =
		c.marker !== undefined &&
		(clean.body.includes(c.marker) ||
			answers.some((a) => stored(a) && a.body.includes(c.marker!)));
	const served = answers.some((a) => stored(a));
	const entered = minted.length > 0;
	return {
		id: c.id,
		what: c.what,
		rules: c.rules,
		// a case with no rule is a property check: the page may be stored, the marker may not appear
		entered: c.rules.length > 0 ? entered || served || marked : marked,
		why: marked
			? 'a marker reached a stored or later clean answer'
			: entered
				? `a row was minted: ${minted.slice(0, 3).join(', ')}`
				: served
					? 'an answer came from the store'
					: 'stayed out',
		tiers: answers.slice(0, 2).map((a) => `${a.status} ${a.headers['x-cfw-cache'] ?? '-'}`),
		rowsAfter: after.filter((p) => !BASELINE.includes(p))
	};
}

async function claim(): Promise<void> {
	const res = await raw('/firstrun', {
		method: 'POST',
		body: JSON.stringify({
			adminName: 'owner',
			adminMail: 'owner@example.test',
			adminPass: PASS,
			siteName: 'Cache Site'
		})
	});
	if (res.status !== 200) throw new Error(`claim answered ${res.status}`);
}

async function storeBaseline(): Promise<void> {
	for (const path of BASELINE) {
		for (let i = 0; i < 6; i++) {
			const a = await raw(path);
			if (stored(a)) break;
		}
	}
}

async function serveStats(): Promise<Record<string, unknown>> {
	const s = await json('/serve-stats');
	const pick = [
		'storageLaneServes',
		'renders',
		'rendersSinceFlush',
		'rowsToday',
		'doRequestsToday',
		'heapsReused',
		'exitedRuns'
	];
	return Object.fromEntries(pick.filter((k) => k in s).map((k) => [k, s[k]]));
}

async function evidence(): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	await storeBaseline();
	const firstTry = await raw('/2026/01/01/hello-world/embed/');
	const embedRows = await rows();
	out.firstAnswerOfAnotherPage = tierHeaders(firstTry);
	const edge = await raw(`/serve?path=${encodeURIComponent(PAGE_PATH)}&edge=0`);
	const statsBefore = await serveStats();
	const object = await raw(`/serve?path=${encodeURIComponent(PAGE_PATH)}&edge=0`);
	const statsAfter = await serveStats();
	out.edgeZeroFirst = tierHeaders(edge);
	out.objectHit = tierHeaders(object);
	out.statsAroundTheHit = { before: statsBefore, after: statsAfter };
	const read = await sql(
		'SELECT status, content_type, html, rendered_at, render_ms, stale_at, tags, tag_checksum, headers FROM cfw_page WHERE path = ?',
		[PAGE_PATH]
	);
	out.rowsReadByThePageSelect = read.rowsRead;
	out.headerSet = Object.keys(object.headers).sort();
	out.bodyBytes = object.body.length;
	out.storedRows = embedRows;

	// a post save through WordPress's own REST route, with a real login
	const login = await raw('/wp-login.php', {
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
	const cookie = login.cookies
		.map((c) => c.split(';')[0] ?? '')
		.filter((c) => !c.endsWith('=deleted'))
		.join('; ');
	const nonce = (
		await raw('/wp-admin/admin-ajax.php?action=rest-nonce', { headers: { cookie } })
	).body.trim();
	const pageBefore = (
		(await sql('SELECT rendered_at FROM cfw_page WHERE path = ?', [PAGE_PATH])).rows as {
			rendered_at: number;
		}[]
	)[0]?.rendered_at;
	const rowsBeforeSave = await rows();
	const statsSave0 = await serveStats();
	const save = await raw('/wp-json/wp/v2/posts/1', {
		method: 'POST',
		headers: { cookie, 'x-wp-nonce': nonce, 'content-type': 'application/json' },
		body: JSON.stringify({ title: 'Edited by the cache run' })
	});
	const statsSave1 = await serveStats();
	const rowsAfterSave = await rows();
	out.save = { status: save.status, nonceLength: nonce.length };
	out.rowsBeforeSave = rowsBeforeSave;
	out.rowsAfterSave = rowsAfterSave;
	out.purged = rowsBeforeSave.filter((p) => !rowsAfterSave.includes(p));
	out.kept = rowsAfterSave;
	out.statsAroundTheSave = { before: statsSave0, after: statsSave1 };
	const pageAfter = (
		(await sql('SELECT rendered_at FROM cfw_page WHERE path = ?', [PAGE_PATH])).rows as {
			rendered_at: number;
		}[]
	)[0]?.rendered_at;
	out.unrelatedPageUntouched = pageBefore !== undefined && pageBefore === pageAfter;
	const refill1 = await raw(POST_PATH);
	const refill2 = await raw(POST_PATH);
	out.refill = {
		first: tierHeaders(refill1),
		second: tierHeaders(refill2),
		newTitleOnFirst: refill1.body.includes('Edited by the cache run'),
		newTitleOnSecond: refill2.body.includes('Edited by the cache run')
	};
	return out;
}

async function main(): Promise<void> {
	await ready();
	await claim();
	const report: Record<string, unknown> = { port: PORT, figures: 'local, wrangler dev' };
	report.evidence = await evidence();

	await storeBaseline();
	const live: Outcome[] = [];
	for (const c of CASES) live.push(await runCase(c));
	report.matrix = live;
	report.matrixCleanCount = live.filter((o) => !o.entered).length;
	report.matrixSize = live.length;

	if (CONTROLS) {
		copyFileSync(RULE_FILE, BACKUP);
		const original = readFileSync(RULE_FILE, 'utf8');
		const marker = 'const NO_SKIP: ReadonlySet<string> = new Set();';
		if (!original.includes(marker)) throw new Error('NO_SKIP not found');
		const groups = new Map<string, Case[]>();
		for (const c of CASES.filter((x) => x.rules.length > 0)) {
			const key = [...c.rules].sort().join(',');
			groups.set(key, [...(groups.get(key) ?? []), c]);
		}
		const controls: (Outcome & { removed: string[] })[] = [];
		for (const [key, cases] of groups) {
			const from = reloads;
			writeFileSync(
				RULE_FILE,
				original.replace(
					marker,
					`const NO_SKIP: ReadonlySet<string> = new Set(${JSON.stringify(key.split(','))});`
				)
			);
			await waitReload(from);
			await claimIfNeeded();
			await storeBaseline();
			for (const c of cases) {
				controls.push({ ...(await runCase(c)), removed: key.split(',') });
			}
		}
		restore();
		report.controls = controls;
	}
	console.log(JSON.stringify(report, null, 2));
	if (process.env.E2E_OUT) writeFileSync(process.env.E2E_OUT, JSON.stringify(report, null, 2));
}

/** a reload restarts the object's isolate but not its state, so the claim stands; this only waits */
async function claimIfNeeded(): Promise<void> {
	await ready();
}

try {
	await main();
} finally {
	await stop();
}
