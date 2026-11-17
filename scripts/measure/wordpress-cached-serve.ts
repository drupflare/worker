/**
 * The cached anonymous serve and the fill, for WordPress and Drupal, measured in one session on one
 * machine with the arms alternating request by request.
 *
 * It starts two `wrangler dev` workers (one per CMS, the same `PLAN` and the same flags), claims both
 * sites, stores the front page, and drives:
 *
 * - a control first: one CMS driven as two arms, so the instrument's own spread is known;
 * - the cached serve of `/` through the front worker's `edge=0` path (the object's stored copy, which
 *   is what `measure:headlines` calls the cached serve), alternating WordPress and Drupal;
 * - the default path of `/` (whichever tier answers), alternating;
 * - a fill with the stored row removed first, alternating.
 *
 * Every figure is local. `x-worker-ms` is a `Date.now()` delta that brackets the hop, so it has the
 * clock's 1 ms granularity and the frozen clock across synchronous PHP; it is not a `cpuTime`
 * reading, and an absolute CPU figure still comes only from a deployed worker.
 *
 * Usage: `bun scripts/measure/wordpress-cached-serve.ts` (environment: `PLAN`, `N_SERVE`, `N_FILL`,
 * `MEASURE_OUT`).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const PLAN = process.env.PLAN ?? 'free';
const N_SERVE = Number(process.env.N_SERVE ?? 120);
const N_FILL = Number(process.env.N_FILL ?? 12);
const WARMUP = 10;
const PASS = `pw-${crypto.randomUUID()}`;

type Server = {
	name: 'wordpress' | 'drupal';
	port: number;
	origin: string;
	child: ChildProcess;
	state: string;
};

function start(name: Server['name'], port: number): Server {
	const origin = `http://localhost:${port}`;
	const state = mkdtempSync(join(tmpdir(), `measure-${name}-`));
	const vars = [
		'PW_DIAGNOSTICS:1',
		`PLAN:${PLAN}`,
		'SITE_WARM:0',
		`SITE_ORIGIN:${origin}`,
		...(name === 'wordpress'
			? [
					'CMS:wordpress',
					'SQL_CHUNK_PREFIX:wordpress/sql',
					'HEAP_SNAPSHOT:0',
					'WORDPRESS_PAGE_CACHE:1'
				]
			: [])
	];
	const child = spawn(
		'bunx',
		[
			'wrangler',
			'dev',
			'-c',
			'wrangler.jsonc',
			'--port',
			String(port),
			'--inspector-port',
			String(port + 500),
			'--persist-to',
			state,
			...vars.flatMap((v) => ['--var', v])
		],
		{ cwd: ROOT, detached: true, stdio: 'ignore' }
	);
	return { name, port, origin, child, state };
}

const stopAll = async (servers: Server[]) => {
	for (const s of servers) {
		try {
			if (s.child.pid !== undefined) process.kill(-s.child.pid, 'SIGTERM');
		} catch {
			// already gone
		}
	}
	await new Promise((r) => setTimeout(r, 2000));
	for (const s of servers) rmSync(s.state, { recursive: true, force: true });
};

type Reading = {
	wall: number;
	workerMs: number | null;
	serveMs: number | null;
	status: number;
	tier: string | null;
	bytes: number;
	headers: Record<string, string>;
};

async function get(
	s: Server,
	path: string,
	init: RequestInit = {}
): Promise<Reading & { body: string }> {
	const t0 = performance.now();
	const res = await fetch(`${s.origin}${path}`, {
		redirect: 'manual',
		...init,
		headers: { accept: '*/*', ...(init.headers as Record<string, string> | undefined) }
	});
	const body = await res.text();
	const wall = performance.now() - t0;
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => (headers[k] = v));
	const num = (k: string) => (headers[k] === undefined ? null : Number(headers[k]));
	return {
		wall,
		workerMs: num('x-worker-ms'),
		serveMs: num('x-cfw-serve-ms'),
		status: res.status,
		tier: headers['x-cfw-cache'] ?? null,
		bytes: body.length,
		headers,
		body
	};
}

const sql = async (s: Server, q: string, params: unknown[] = []) =>
	JSON.parse(
		(
			await get(
				s,
				`/sql?q=${encodeURIComponent(q)}&params=${encodeURIComponent(JSON.stringify(params))}`
			)
		).body
	) as { rows: Record<string, unknown>[]; rowsRead: number; rowsWritten: number };

async function ready(s: Server): Promise<void> {
	const deadline = Date.now() + 300_000;
	for (;;) {
		try {
			if ((await get(s, '/')).status === 200) return;
		} catch {
			// not listening yet
		}
		if (Date.now() > deadline) throw new Error(`${s.name} never answered 200`);
		await new Promise((r) => setTimeout(r, 1500));
	}
}

async function claim(s: Server): Promise<void> {
	const res = await get(s, '/firstrun', {
		method: 'POST',
		body: JSON.stringify(
			s.name === 'wordpress'
				? {
						adminName: 'owner',
						adminMail: 'owner@example.test',
						adminPass: PASS,
						siteName: 'Measure Site'
					}
				: { adminPass: PASS, siteName: 'Measure Site' }
		)
	});
	if (res.status !== 200) throw new Error(`${s.name} claim answered ${res.status}`);
}

const OBJECT_HIT = '/serve?path=%2F&edge=0';

async function storeFront(s: Server): Promise<void> {
	for (let i = 0; i < 30; i++) {
		const r = await get(s, OBJECT_HIT);
		if (r.status === 200 && r.tier === 'HIT') return;
		await get(s, '/fill?path=%2F&max=1');
		await new Promise((res) => setTimeout(res, 300));
	}
	throw new Error(`${s.name} never stored the front page`);
}

type Stat = {
	n: number;
	min: number;
	median: number;
	p95: number;
	max: number;
	mean: number;
	zeros: number;
	atMostOne: number;
};

function stat(values: number[]): Stat {
	const v = [...values].sort((a, b) => a - b);
	const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? NaN;
	return {
		n: v.length,
		min: v[0] ?? NaN,
		median: q(0.5),
		p95: q(0.95),
		max: v[v.length - 1] ?? NaN,
		mean: v.reduce((a, b) => a + b, 0) / Math.max(1, v.length),
		zeros: v.filter((x) => x === 0).length,
		atMostOne: v.filter((x) => x <= 1).length
	};
}

const ratio = (a: number, b: number) => (b === 0 ? null : Number((a / b).toFixed(2)));

type Arms = Record<string, { workerMs: number[]; wall: number[]; tiers: Record<string, number> }>;

function note(arms: Arms, arm: string, r: Reading) {
	const a = (arms[arm] ??= { workerMs: [], wall: [], tiers: {} });
	if (r.workerMs !== null) a.workerMs.push(r.workerMs);
	a.wall.push(r.wall);
	const t = r.tier ?? `status ${r.status}`;
	a.tiers[t] = (a.tiers[t] ?? 0) + 1;
}

const summary = (arms: Arms) =>
	Object.fromEntries(
		Object.entries(arms).map(([k, v]) => [
			k,
			{ workerMs: stat(v.workerMs), wallMs: stat(v.wall), tiers: v.tiers }
		])
	);

/** requests alternate between the two arms, so a slow minute of the machine lands on both */
async function alternate(
	n: number,
	a: { label: string; run(): Promise<Reading> },
	b: { label: string; run(): Promise<Reading> }
): Promise<Arms> {
	const arms: Arms = {};
	for (let i = 0; i < WARMUP; i++) {
		await a.run();
		await b.run();
	}
	for (let i = 0; i < n; i++) {
		const first = i % 2 === 0 ? a : b;
		const second = i % 2 === 0 ? b : a;
		note(arms, first.label, await first.run());
		note(arms, second.label, await second.run());
	}
	return arms;
}

async function main(): Promise<void> {
	const wp = start('wordpress', 8795);
	const dr = start('drupal', 8796);
	const servers = [wp, dr];
	const report: Record<string, unknown> = {
		figures: 'local, wrangler dev on one Mac; x-worker-ms has 1 ms granularity',
		plan: PLAN,
		nServePerArm: N_SERVE,
		nFillPerArm: N_FILL,
		warmupDiscarded: WARMUP
	};
	process.on('SIGINT', () => void stopAll(servers).then(() => process.exit(130)));
	try {
		await Promise.all([ready(wp), ready(dr)]);
		await Promise.all([claim(wp), claim(dr)]);
		for (const s of servers) await storeFront(s);
		// the two stores answer; keep what the hit looks like before driving it
		const hit: Record<string, unknown> = {};
		for (const s of servers) {
			const r = await get(s, OBJECT_HIT);
			const page = await sql(
				s,
				'SELECT status, content_type, html, rendered_at, render_ms, stale_at, tags, tag_checksum, headers FROM cfw_page WHERE path = ?',
				['/']
			);
			hit[s.name] = {
				status: r.status,
				tier: r.tier,
				bodyBytes: r.bytes,
				headerCount: Object.keys(r.headers).length,
				headers: Object.keys(r.headers).sort(),
				rowsReadByThePageSelect: page.rowsRead
			};
		}
		report.storeHit = hit;

		// the control: one binary as two arms
		report.control = {
			drupalAgainstDrupal: summary(
				await alternate(
					N_SERVE,
					{ label: 'drupal-a', run: () => get(dr, OBJECT_HIT) },
					{ label: 'drupal-b', run: () => get(dr, OBJECT_HIT) }
				)
			),
			wordpressAgainstWordpress: summary(
				await alternate(
					N_SERVE,
					{ label: 'wordpress-a', run: () => get(wp, OBJECT_HIT) },
					{ label: 'wordpress-b', run: () => get(wp, OBJECT_HIT) }
				)
			)
		};

		// the cached serve through the object, then through whatever tier answers
		const objectArms = await alternate(
			N_SERVE,
			{ label: 'wordpress', run: () => get(wp, OBJECT_HIT) },
			{ label: 'drupal', run: () => get(dr, OBJECT_HIT) }
		);
		report.cachedServeObject = summary(objectArms);
		const defaultArms = await alternate(
			N_SERVE,
			{ label: 'wordpress', run: () => get(wp, '/') },
			{ label: 'drupal', run: () => get(dr, '/') }
		);
		report.cachedServeDefaultPath = summary(defaultArms);

		// the fill: remove the row, queue the path and drain it in one invocation
		const fillArms: Arms = {};
		const fillDetail: Record<string, unknown[]> = { wordpress: [], drupal: [] };
		const fillOnce = async (s: Server) => {
			await sql(s, 'DELETE FROM cfw_page WHERE path = ?', ['/']);
			const r = await get(s, '/fill?path=%2F&max=1');
			const j = JSON.parse(r.body) as Record<string, unknown>;
			note(fillArms, s.name, r);
			fillDetail[s.name]?.push({
				wall: Number(r.wall.toFixed(1)),
				workerMs: r.workerMs,
				renderMs: j.renderMs,
				bootedInFill: j.bootedInFill,
				filled: j.filled
			});
		};
		for (let i = 0; i < 2; i++) {
			await fillOnce(wp);
			await fillOnce(dr);
		}
		for (const k of Object.keys(fillArms)) delete fillArms[k];
		for (const k of Object.keys(fillDetail)) fillDetail[k] = [];
		for (let i = 0; i < N_FILL; i++) {
			const order = i % 2 === 0 ? [wp, dr] : [dr, wp];
			for (const s of order) await fillOnce(s);
		}
		report.fill = { ...summary(fillArms), detail: fillDetail };

		const s = (a: Arms, k: string) => stat(a[k]?.workerMs ?? []);
		report.ratios = {
			cachedServeObjectMedianWordpressOverDrupal: ratio(
				s(objectArms, 'wordpress').median,
				s(objectArms, 'drupal').median
			),
			cachedServeObjectMeanWordpressOverDrupal: ratio(
				s(objectArms, 'wordpress').mean,
				s(objectArms, 'drupal').mean
			),
			fillMedianWordpressOverDrupal: ratio(
				s(fillArms, 'wordpress').median,
				s(fillArms, 'drupal').median
			)
		};
	} finally {
		await stopAll(servers);
	}
	const text = JSON.stringify(report, null, 2);
	console.log(text);
	if (process.env.MEASURE_OUT) writeFileSync(process.env.MEASURE_OUT, text);
}

await main();
