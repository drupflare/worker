#!/usr/bin/env bun
/**
 * Spec 65 measure-first gates on a throwaway paid-account worker.
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bun scripts/measure/g65-assets.ts run \
 *     --out=<dir> [--views=3000] [--control=20000] [--conc=48] [--arms=N,A,A,A,B,A,A,N,B]
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bun scripts/measure/g65-assets.ts bill \
 *     --from=2026-10-12 --to=2026-11-06 --out=<file>
 *   bun scripts/measure/g65-assets.ts selftest
 *
 * `run` deploys the canonical config as `cfw-e2e-g65-*` with its assets directory cloned to a
 * scratch path, claims the site, then (1) drives a Worker-answered control path and a 66-asset
 * page view mix so the account's billed usage can be read afterwards, (2) republishes the script
 * with a changed asset (and, in arm B, a changed var) while watching the warm object's alarm
 * counter for a reset and the changed asset for the moment it becomes visible. Teardown always
 * runs and the inventory is diffed. `bill` reads the day's billed Workers requests beside the
 * account's own invocation count. No token is printed or written.
 */
import { spawnSync } from 'node:child_process';
import {
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { isEmptyInventory, leftovers, provision, Site, type Inventory } from '../e2e/live-deploy';

// #region pure helpers

/** nearest-rank percentile, 0 for an empty list */
export function pct(xs: number[], p: number): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number;
}

/** how many times a series of counters went down between neighbours, which a reset does */
export function drops(xs: number[]): number {
	let n = 0;
	for (let i = 1; i < xs.length; i++) if ((xs[i] as number) < (xs[i - 1] as number)) n++;
	return n;
}

export type Poll = { t: number; status: number; body: string };

/** time of the first poll whose body equals `expected`, and the polls after it that disagree */
export function visibleAt(
	rows: Poll[],
	expected: string
): { at: number | null; flaps: number; statuses: Record<string, number> } {
	const statuses: Record<string, number> = {};
	let at: number | null = null;
	let flaps = 0;
	for (const r of rows) {
		statuses[String(r.status)] = (statuses[String(r.status)] ?? 0) + 1;
		if (r.body === expected) {
			if (at === null) at = r.t;
		} else if (at !== null) flaps++;
	}
	return { at, flaps, statuses };
}

function selftest(): void {
	const eq = (a: unknown, b: unknown, what: string) => {
		if (JSON.stringify(a) !== JSON.stringify(b))
			throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
	};
	eq(drops([1, 2, 3, 1, 2, 0]), 2, 'drops');
	eq(drops([]), 0, 'drops empty');
	eq(pct([5, 1, 3, 2, 4], 50), 3, 'median');
	const rows: Poll[] = [
		{ t: 1, status: 200, body: 'v1' },
		{ t: 2, status: 200, body: 'v2' },
		{ t: 3, status: 200, body: 'v1' },
		{ t: 4, status: 200, body: 'v2' }
	];
	eq(visibleAt(rows, 'v2'), { at: 2, flaps: 1, statuses: { '200': 4 } }, 'visibleAt');
	eq(visibleAt(rows, 'v9').at, null, 'never visible');
	console.log('selftest ok');
}

// #endregion

const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = join(import.meta.dir, '..', '..');
const argv = process.argv.slice(3);
const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const scrub = (s: string) => s.replace(/[A-Za-z0-9_-]{40,}/g, '<redacted>');

async function cf<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			...init.headers
		}
	});
	const body = (await res.json()) as { success?: boolean; result?: T; errors?: unknown };
	if (!res.ok || body.success === false) {
		throw new Error(
			`${init.method ?? 'GET'} ${path}: ${res.status} ${JSON.stringify(body.errors)}`
		);
	}
	return body.result as T;
}

async function gql<T>(query: string): Promise<T> {
	const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ query })
	});
	const body = (await res.json()) as { data?: T; errors?: { message: string }[] | null };
	if (body.errors?.length)
		throw new Error(`graphql: ${JSON.stringify(body.errors).slice(0, 400)}`);
	return body.data as T;
}

async function inventory(): Promise<Inventory> {
	const [workers, dos, kv, d1] = await Promise.all([
		cf<{ id: string }[]>('/workers/scripts'),
		cf<{ id: string; name: string }[]>('/workers/durable_objects/namespaces?per_page=1000'),
		cf<{ id: string; title: string }[]>('/storage/kv/namespaces?per_page=100'),
		cf<{ uuid: string; name: string }[]>('/d1/database?per_page=100')
	]);
	return {
		workers: workers.map((w) => w.id).sort(),
		durableObjects: dos.map((d) => `${d.id} ${d.name}`).sort(),
		kv: kv.map((k) => `${k.id} ${k.title}`).sort(),
		d1: d1.map((d) => `${d.uuid} ${d.name}`).sort()
	};
}

type Ev = {
	at: number;
	cpuMs: number;
	wallMs?: number;
	entry: string;
	type: string;
	outcome: string;
	text: string;
};

async function events(name: string, from: number, to: number): Promise<Ev[]> {
	const out: Ev[] = [];
	for (let t = from; t < to; t += 300_000) {
		const result = await cf<{ events?: { events?: Record<string, any>[] } }>(
			'/workers/observability/telemetry/query',
			{
				method: 'POST',
				body: JSON.stringify({
					queryId: `g65-${name}-${t}`,
					view: 'events',
					limit: 2000,
					timeframe: { from: t, to: Math.min(to, t + 300_000) },
					parameters: {
						filterCombination: 'and',
						filters: [
							{
								key: '$metadata.service',
								operation: 'eq',
								type: 'string',
								value: name
							}
						]
					}
				})
			}
		);
		for (const e of result.events?.events ?? []) {
			const w = e['$workers'] ?? {};
			const m = e['$metadata'] ?? {};
			out.push({
				at: Number(e['timestamp'] ?? m.timestamp ?? t),
				cpuMs: typeof w.cpuTimeMs === 'number' ? w.cpuTimeMs : -1,
				wallMs: typeof w.wallTimeMs === 'number' ? w.wallTimeMs : undefined,
				entry: String(w.entrypoint ?? ''),
				type: String(w.eventType ?? ''),
				outcome: String(w.outcome ?? ''),
				text: String(m.error ?? m.message ?? '').slice(0, 240)
			});
		}
	}
	return out;
}

// #region billing read

type Billed = Record<string, { workers: number; dor: number }>;

async function billedByDay(from: string, to: string): Promise<Billed> {
	const res = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${account}/billable-usage?from=${from}&to=${to}`,
		{ headers: { authorization: `Bearer ${token}` } }
	);
	const body = (await res.json()) as { result?: Record<string, any>[]; success?: boolean };
	if (!res.ok || !body.result) throw new Error(`billable-usage answered ${res.status}`);
	const out: Billed = {};
	for (const x of body.result) {
		const day = String(x.ChargePeriodStart).slice(0, 10);
		const row = (out[day] ??= { workers: 0, dor: 0 });
		const s = String(x.ServiceName);
		if (s.startsWith('Workers Standard Requests')) row.workers += Number(x.ConsumedQuantity);
		if (s.startsWith('Durable Objects Compute Requests')) row.dor += Number(x.ConsumedQuantity);
	}
	return out;
}

async function invocationsByDay(from: string, to: string): Promise<Record<string, number>> {
	const d = await gql<any>(
		`{ viewer { accounts(filter:{accountTag:"${account}"}) { workersInvocationsAdaptive(limit:10000, filter:{datetime_geq:"${from}T00:00:00Z", datetime_lt:"${to}T00:00:00Z"}) { sum { requests } dimensions { date } } } } }`
	);
	const out: Record<string, number> = {};
	for (const r of d.viewer.accounts[0].workersInvocationsAdaptive)
		out[r.dimensions.date] = (out[r.dimensions.date] ?? 0) + r.sum.requests;
	return out;
}

async function bill(): Promise<void> {
	const from = flag('from') ?? '2026-10-12';
	const to = flag('to') ?? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
	const [billed, inv] = await Promise.all([billedByDay(from, to), invocationsByDay(from, to)]);
	const days = [...new Set([...Object.keys(billed), ...Object.keys(inv)])].sort();
	const rows = days.map((day) => {
		const b = billed[day]?.workers;
		const i = inv[day];
		return {
			day,
			billedWorkersRequests: b ?? null,
			billedDoRequests: billed[day]?.dor ?? null,
			invocations: i ?? null,
			billedMinusInvocations: b !== undefined && i !== undefined ? b - i : null,
			ratio: b !== undefined && i ? Number((b / i).toFixed(3)) : null
		};
	});
	console.table(rows);
	const out = flag('out');
	if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
}

// #endregion

// #region drive

type DriveResult = {
	label: string;
	requests: number;
	startIso: string;
	endIso: string;
	seconds: number;
	rps: number;
	statuses: Record<string, number>;
	errors: number;
	bytes: number;
	workerAnswered: number;
	cfCache: Record<string, number>;
};

async function drive(
	origin: string,
	paths: string[],
	total: number,
	conc: number,
	label: string
): Promise<DriveResult> {
	let next = 0;
	let errors = 0;
	let bytes = 0;
	let workerAnswered = 0;
	const statuses: Record<string, number> = {};
	const cfCache: Record<string, number> = {};
	const t0 = Date.now();
	const startIso = new Date(t0).toISOString();
	await Promise.all(
		Array.from({ length: conc }, async () => {
			for (;;) {
				const i = next++;
				if (i >= total) return;
				try {
					const r = await fetch(origin + (paths[i % paths.length] as string), {
						signal: AbortSignal.timeout(30_000)
					});
					const b = await r.arrayBuffer();
					bytes += b.byteLength;
					statuses[r.status] = (statuses[r.status] ?? 0) + 1;
					if (r.headers.has('x-cfw-cache') || r.headers.has('x-worker-ms'))
						workerAnswered++;
					const c = r.headers.get('cf-cache-status') ?? 'none';
					cfCache[c] = (cfCache[c] ?? 0) + 1;
				} catch {
					errors++;
				}
				if (i > 0 && i % 20_000 === 0)
					console.log(
						`${label}: ${i}/${total} after ${((Date.now() - t0) / 1000).toFixed(0)} s`
					);
			}
		})
	);
	const seconds = (Date.now() - t0) / 1000;
	return {
		label,
		requests: total,
		startIso,
		endIso: new Date().toISOString(),
		seconds,
		rps: Math.round(total / seconds),
		statuses,
		errors,
		bytes,
		workerAnswered,
		cfCache
	};
}

/** 66 small published asset paths that answer 200 with no Worker header, found on the live site */
async function assetMix(origin: string): Promise<string[]> {
	const found: string[] = [];
	const dirs = [
		'core/misc',
		'core/themes/olivero/css',
		'core/themes/claro/css',
		'core/modules/system/css'
	];
	const cands: string[] = [];
	const walk = (rel: string, depth: number) => {
		let names: string[] = [];
		try {
			names = readdirSync(join(root, 'assets', rel));
		} catch {
			return;
		}
		for (const n of names) {
			const p = join(root, 'assets', rel, n);
			const s = statSync(p);
			if (s.isDirectory() && depth < 3) walk(`${rel}/${n}`, depth + 1);
			else if (s.isFile() && s.size > 0 && s.size < 4096 && /\.(css|js|svg|json)$/.test(n))
				cands.push(`/${rel}/${n}`);
		}
	};
	for (const d of dirs) walk(d, 0);
	for (const p of cands) {
		if (found.length >= 66) break;
		const r = await fetch(origin + p, { signal: AbortSignal.timeout(30_000) });
		await r.arrayBuffer();
		if (r.status === 200 && !r.headers.has('x-cfw-cache') && !r.headers.has('x-worker-ms'))
			found.push(p);
	}
	return found;
}

/** a path the front worker answers itself with no object hop, found by its deny header */
async function controlPath(origin: string): Promise<string> {
	for (const p of ['/wp-login.php', '/xmlrpc.php', '/.env', '/wp-admin/install.php']) {
		const r = await fetch(origin + p, { signal: AbortSignal.timeout(30_000) });
		await r.arrayBuffer();
		if (r.headers.get('x-cfw-deny')) return p;
	}
	throw new Error('no deny-listed control path answered with x-cfw-deny');
}

// #endregion

// #region republish arms

type Arm = 'N' | 'A' | 'B';

type StatRow = {
	t: number;
	alarmFirings?: number;
	phpBooted?: boolean;
	recycles?: number;
	heapsReused?: number;
	rowsToday?: number;
};

async function main(): Promise<void> {
	if (!account || !token)
		throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
	const out = flag('out');
	if (!out) throw new Error('pass --out=<dir>');
	mkdirSync(out, { recursive: true });
	const views = Number(flag('views') ?? 3000);
	const controlN = Number(flag('control') ?? 20_000);
	const conc = Number(flag('conc') ?? 48);
	const arms = (flag('arms') ?? 'N,A,A,A,B,A,A,N,B').split(',') as Arm[];
	const name = `cfw-e2e-g65-${Date.now()}`;
	const config = join(root, `wrangler.${name}.jsonc`);
	const scratch = join(out, 'assets-pub');

	const before = await inventory();
	writeFileSync(join(out, 'inventory-before.json'), JSON.stringify(before, null, 1));
	console.log(
		`inventory before: ${before.workers.length} workers, ${before.durableObjects.length} namespaces, ${before.kv.length} kv, ${before.d1.length} d1`
	);

	rmSync(scratch, { recursive: true, force: true });
	cpSync(join(root, 'assets'), scratch, { recursive: true });
	const ignorePath = join(scratch, '.assetsignore');
	writeFileSync(ignorePath, `${readFileSync(ignorePath, 'utf8')}\n!/g65-fresh.txt\n`);
	writeFileSync(join(scratch, 'g65-fresh.txt'), 'v0\n');

	const base = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
	base.name = name;
	base.d1_databases = [{ binding: 'FLEET_DB', database_name: `${name}-fleet` }];
	base.assets = { ...base.assets, directory: scratch };
	delete base.build;
	const writeConfig = (nonce?: string) => {
		const c = structuredClone(base);
		if (nonce !== undefined) c.vars = { ...(c.vars ?? {}), G65_NONCE: nonce };
		writeFileSync(config, JSON.stringify(c, null, '\t'));
	};
	writeConfig();

	const failed: string[] = [];
	const summary: Record<string, any> = {
		name,
		startedAt: new Date().toISOString(),
		views,
		controlN
	};
	const started = Date.now();
	let origin = '';
	let owner = '';
	let requestsTotal = 0;
	try {
		// bundle-only time, so a publish can be split into bundling and the platform leg
		const tb = Date.now();
		const dry = spawnSync(
			'bunx',
			['wrangler', 'deploy', '-c', config, '--dry-run', `--outdir=${join(out, 'dry')}`],
			{ cwd: root, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 }
		);
		summary.dryRunMs = Date.now() - tb;
		summary.dryRunStatus = dry.status;
		console.log(`dry run ${summary.dryRunMs} ms, status ${dry.status}`);

		const td = Date.now();
		const deploy = spawnSync('bunx', ['wrangler', 'deploy', '-c', config], {
			cwd: root,
			encoding: 'utf8',
			env: process.env,
			maxBuffer: 64 * 1024 * 1024
		});
		summary.firstDeployMs = Date.now() - td;
		process.stdout.write(scrub(deploy.stdout ?? ''));
		process.stderr.write(scrub(deploy.stderr ?? ''));
		if (deploy.status !== 0) throw new Error(`wrangler deploy exited ${deploy.status}`);
		origin = /https:\/\/[^\s]+\.workers\.dev/.exec(deploy.stdout ?? '')?.[0] ?? '';
		if (!origin) throw new Error('wrangler printed no workers.dev URL');
		summary.firstDeployOut = scrub(deploy.stdout ?? '')
			.split('\n')
			.filter((l) => /Upload|Uploaded|assets/i.test(l));
		console.log(`deployed ${name} at ${origin} in ${summary.firstDeployMs} ms`);
		await sleep(60_000);

		const site = new Site(origin);
		const pass = `g65-${crypto.randomUUID()}`;
		owner = await provision(site, pass);
		requestsTotal += site.requests;

		const stats = async (): Promise<StatRow | null> => {
			try {
				const res = await fetch(new URL('/serve-stats', origin), {
					headers: { authorization: `Bearer ${owner}` },
					signal: AbortSignal.timeout(20_000)
				});
				requestsTotal += 1;
				if (res.status !== 200) return null;
				const s = (await res.json()) as Record<string, any>;
				return {
					t: Date.now(),
					alarmFirings: s.alarmFirings,
					phpBooted: s.phpBooted,
					recycles: s.recycles,
					heapsReused: s.heapsReused,
					rowsToday: s.rowsToday
				};
			} catch {
				return null;
			}
		};
		for (let i = 0; i < 5; i++) {
			await site.hit(`/?g65warm=${i}`);
			await sleep(1000);
		}
		const s0 = await stats();
		summary.statsAtStart = s0;
		console.log(`stats at start ${JSON.stringify(s0)}`);

		// #region measurement 1: billing drive
		const mix = await assetMix(origin);
		const ctl = await controlPath(origin);
		summary.assetMixCount = mix.length;
		summary.controlPath = ctl;
		if (mix.length < 66) throw new Error(`only ${mix.length} asset paths qualified`);
		console.log(`66-path mix ready, control path ${ctl}`);
		const m1: Record<string, DriveResult> = {};
		m1.control = await drive(origin, [ctl], controlN, conc, 'control');
		console.log(`control ${JSON.stringify(m1.control)}`);
		requestsTotal += controlN;
		const assetTotal = views * 66;
		m1.assets = await drive(origin, mix, assetTotal, conc, 'assets');
		console.log(`assets ${JSON.stringify(m1.assets)}`);
		requestsTotal += assetTotal;
		summary.m1 = m1;
		writeFileSync(join(out, 'm1.json'), JSON.stringify({ mix, m1 }, null, 1));
		// #endregion

		// #region measurements 2 and 3: republish arms
		const dryOut = (s: string) =>
			s
				.split('\n')
				.filter((l) => /Uploaded|Total Upload|Deployed|Current Version|assets/i.test(l))
				.map(scrub);
		const armRows: Record<string, any>[] = [];
		let prev = 'v0';
		let k = 0;
		for (const arm of arms) {
			k++;
			const marker = `v${k}-${Date.now().toString(36)}`;
			const stat: StatRow[] = [];
			const fresh: { a: Poll[]; b: Poll[] } = { a: [], b: [] };
			const stop = { done: false };
			const one = async (path: string): Promise<{ status: number; body: string }> => {
				try {
					const r = await fetch(origin + path, { signal: AbortSignal.timeout(10_000) });
					const body = (await r.text()).trim().slice(0, 40);
					requestsTotal += 1;
					return { status: r.status, body };
				} catch {
					return { status: 0, body: 'error' };
				}
			};
			const watchFresh = (async () => {
				while (!stop.done) {
					const t = Date.now();
					const [a, b] = await Promise.all([
						one('/g65-fresh.txt'),
						one(`/g65-fresh.txt?b=${t}`)
					]);
					fresh.a.push({ t, ...a });
					fresh.b.push({ t, ...b });
					await sleep(250);
				}
			})();
			const watchStats = (async () => {
				while (!stop.done) {
					const s = await stats();
					if (s) stat.push(s);
					await sleep(2000);
				}
			})();
			await sleep(6000);
			const t0 = Date.now();
			let t1 = t0;
			let outText = '';
			let status: number | null = null;
			if (arm !== 'N') {
				writeFileSync(join(scratch, 'g65-fresh.txt'), `${marker}\n`);
				writeConfig(arm === 'B' ? `n${k}` : undefined);
				const proc = Bun.spawn(['bunx', 'wrangler', 'deploy', '-c', config], {
					cwd: root,
					env: process.env,
					stdout: 'pipe',
					stderr: 'pipe'
				});
				const [so, se, code] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited
				]);
				t1 = Date.now();
				status = code;
				outText = `${so}\n${se}`;
				if (code !== 0)
					failed.push(
						`arm ${k} ${arm} deploy exited ${code}: ${scrub(outText).slice(-300)}`
					);
			} else {
				await sleep(40_000);
				t1 = Date.now();
			}
			// one render on a unique query: a reset interpreter shows as an inline boot
			await sleep(14_000);
			const pt = Date.now();
			let probe: Record<string, string> = {};
			try {
				const r = await fetch(`${origin}/user/login?g65=${k}`, {
					signal: AbortSignal.timeout(60_000)
				});
				await r.text();
				requestsTotal += 1;
				for (const h of [
					'x-cfw-cache',
					'x-cfw-inline-boot',
					'x-cfw-php-booted',
					'x-worker-ms',
					'x-cfw-serve-ms'
				])
					probe[h] = r.headers.get(h) ?? '';
				probe.ms = String(Date.now() - pt);
				probe.status = String(r.status);
			} catch (e) {
				probe = { error: String(e).slice(0, 100) };
			}
			await sleep(14_000);
			stop.done = true;
			await Promise.all([watchFresh, watchStats]);
			const va = visibleAt(fresh.a, marker);
			const vb = visibleAt(fresh.b, marker);
			const firings = stat
				.map((s) => s.alarmFirings)
				.filter((x): x is number => typeof x === 'number');
			const row = {
				k,
				arm,
				marker,
				deployMs: arm === 'N' ? null : t1 - t0,
				deployStatus: status,
				deployLines: arm === 'N' ? [] : dryOut(outText),
				visiblePlainFromStartMs: va.at === null ? null : va.at - t0,
				visiblePlainAfterDeployEndMs: va.at === null ? null : va.at - t1,
				visibleBustedFromStartMs: vb.at === null ? null : vb.at - t0,
				visibleBustedAfterDeployEndMs: vb.at === null ? null : vb.at - t1,
				flapsPlain: va.flaps,
				flapsBusted: vb.flaps,
				statusesPlain: va.statuses,
				statusesBusted: vb.statuses,
				oldBodyPollsBeforeVisible: fresh.a.filter(
					(p) => va.at !== null && p.t < va.at && p.body === prev
				).length,
				otherBodies: [...new Set(fresh.a.map((p) => p.body))].filter(
					(b) => b !== prev && b !== marker
				),
				statPolls: stat.length,
				alarmFirings: {
					first: firings[0],
					last: firings[firings.length - 1],
					drops: drops(firings)
				},
				phpBootedFalse: stat.filter((s) => s.phpBooted === false).length,
				recyclesFirstLast: [stat[0]?.recycles, stat[stat.length - 1]?.recycles],
				probe
			};
			armRows.push(row);
			if (arm !== 'N') prev = marker;
			console.log(`ARM ${JSON.stringify(row)}`);
			writeFileSync(
				join(out, 'm2.json'),
				JSON.stringify({ armRows, stat: undefined }, null, 1)
			);
		}
		summary.arms = armRows.length;
		// #endregion

		// object and invocation meters must be read before the teardown deletes them
		console.log('waiting 6 min for analytics lag before reading meters');
		await sleep(360_000);
		const endIso = new Date().toISOString();
		const startIso = new Date(started - 60_000).toISOString();
		const meters: Record<string, unknown> = {};
		try {
			const d = await gql<any>(
				`{ viewer { accounts(filter:{accountTag:"${account}"}) { workersInvocationsAdaptive(limit:5000, filter:{scriptName:"${name}", datetime_geq:"${startIso}", datetime_leq:"${endIso}"}) { sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { datetimeFiveMinutes status } } } } }`
			);
			meters.workers = d.viewer.accounts[0].workersInvocationsAdaptive;
		} catch (e) {
			meters.workersError = String(e).slice(0, 300);
		}
		try {
			const d = await gql<any>(
				`{ viewer { accounts(filter:{accountTag:"${account}"}) { durableObjectsInvocationsAdaptiveGroups(limit:5000, filter:{datetime_geq:"${startIso}", datetime_leq:"${endIso}"}) { sum { requests errors } dimensions { datetimeFiveMinutes scriptName } } } } }`
			);
			meters.durableObjects =
				d.viewer.accounts[0].durableObjectsInvocationsAdaptiveGroups.filter((r: any) =>
					String(r.dimensions.scriptName).startsWith(name)
				);
		} catch (e) {
			meters.durableObjectsError = String(e).slice(0, 300);
		}
		writeFileSync(join(out, 'meters.json'), JSON.stringify(meters, null, 1));
		const seen = await events(name, started - 60_000, Date.now());
		writeFileSync(join(out, 'events.json'), JSON.stringify(seen, null, 1));
		const outcomes: Record<string, number> = {};
		for (const e of seen)
			outcomes[`${e.type}/${e.outcome}`] = (outcomes[`${e.type}/${e.outcome}`] ?? 0) + 1;
		summary.eventOutcomes = outcomes;
		summary.eventsNotOk = seen.filter((e) => e.outcome && e.outcome !== 'ok').slice(0, 30);
		summary.eventsWithText = seen.filter((e) => /updated|reset/i.test(e.text)).slice(0, 30);
		console.log(`events ${seen.length} ${JSON.stringify(outcomes)}`);
		summary.requestsFromRunner = requestsTotal;
	} catch (e) {
		failed.push(`the run itself failed: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		rmSync(config, { force: true });
		spawnSync('bunx', ['wrangler', 'delete', '--name', name, '--force'], {
			cwd: root,
			stdio: 'inherit',
			env: process.env
		});
		const created = leftovers(before, await inventory());
		for (const entry of created.durableObjects) {
			const [id, doName] = entry.split(' ');
			if (doName?.startsWith(name))
				await cf(`/workers/durable_objects/namespaces/${id}`, { method: 'DELETE' }).catch(
					(e) => failed.push(String(e))
				);
		}
		for (const entry of created.kv) {
			const [id, title] = entry.split(' ');
			if (title?.startsWith(name))
				await cf(`/storage/kv/namespaces/${id}`, { method: 'DELETE' }).catch((e) =>
					failed.push(String(e))
				);
		}
		for (const entry of created.d1) {
			const [id, dbName] = entry.split(' ');
			if (dbName?.startsWith(name))
				await cf(`/d1/database/${id}`, { method: 'DELETE' }).catch((e) =>
					failed.push(String(e))
				);
		}
		const after = await inventory();
		writeFileSync(join(out, 'inventory-after.json'), JSON.stringify(after, null, 1));
		const diff = leftovers(before, after);
		const gone = leftovers(after, before);
		summary.inventoryExtra = diff;
		summary.inventoryMissing = gone;
		console.log(`INVENTORY EXTRA ${JSON.stringify(diff)}`);
		console.log(`INVENTORY MISSING ${JSON.stringify(gone)}`);
		console.log(
			isEmptyInventory(diff) && isEmptyInventory(gone) ? 'TEARDOWN OK' : 'TEARDOWN MISMATCH'
		);
		summary.failed = failed;
		summary.endedAt = new Date().toISOString();
		writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
		rmSync(scratch, { recursive: true, force: true });
	}
	if (failed.length > 0) {
		for (const f of failed) console.log(`FAILED: ${f}`);
		process.exitCode = 1;
	}
}

// #endregion

if (import.meta.main) {
	const mode = process.argv[2];
	if (mode === 'selftest') selftest();
	else if (mode === 'run') await main();
	else if (mode === 'bill') await bill();
	else
		throw new Error('usage: g65-assets.ts run --out=<dir> | bill --from=.. --to=.. | selftest');
}
