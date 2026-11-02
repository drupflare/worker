#!/usr/bin/env bun
/**
 * Spec 64 gate 1 (and gate 2's arm A baseline): what a visitor meets on a path a save invalidated.
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bun scripts/measure/g64-save-drive.ts run \
 *     --out=<dir> [--saves=10] [--visits=100] [--spacing=300] [--nodes=6]
 *   bun scripts/measure/g64-save-drive.ts selftest
 *
 * Deploys the canonical config under a `cfw-e2e-g64-*` name, claims the site, seeds promoted
 * nodes and warms their pages. Each save edits one node, reads the invalidated set from the
 * owner's `/serve-stats` (the fill queue plus the stored pages that vanished), then drives
 * anonymous visits over exactly that set on a fixed schedule and tags every answer by its cache
 * headers. After phase one it waits for `<out>/decision.txt` (`go` or `stop`) before phase two,
 * which saves with no visitors so rows and object CPU per save are read without visits in them.
 * Teardown always runs: the worker, then every namespace this run created, then a diff against
 * the starting inventory. The owner token and password stay in this process and are never printed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	hiddenFields,
	isEmptyInventory,
	leftovers,
	provision,
	sessionFrom,
	Site,
	type Inventory
} from '../e2e/live-deploy';

// #region pure helpers

/** what one anonymous visit ended as */
export type Outcome =
	'RENDER' | 'WARMING503' | 'STALE' | 'AGED' | 'HIT_OLD_GEN' | 'HIT_CURRENT' | 'OTHER';

/**
 * Classifies a visit from its status and cache headers.
 *
 * `x-cfw-edge: STALE` is the front worker answering a previous generation from `PAGE_KV`;
 * `x-cfw-cache: AGED` is the object answering a superseded row. A stored answer (HIT, EDGE, MEM,
 * KV) is `HIT_OLD_GEN` when its generation header is behind the generation the save produced.
 */
export function classify(
	status: number,
	h: Record<string, string | undefined>,
	currentGeneration: number | undefined
): Outcome {
	const cache = (h['x-cfw-cache'] ?? '').toUpperCase();
	if (status === 503 && cache === 'MISS') return 'WARMING503';
	if (h['x-cfw-edge'] === 'STALE') return 'STALE';
	if (cache === 'AGED') return 'AGED';
	if (cache === 'RENDER') return 'RENDER';
	if (status === 200 && ['HIT', 'EDGE', 'MEM', 'KV'].includes(cache)) {
		const g = Number(h['x-cfw-generation']);
		return currentGeneration !== undefined && Number.isFinite(g) && g < currentGeneration
			? 'HIT_OLD_GEN'
			: 'HIT_CURRENT';
	}
	return 'OTHER';
}

/** the generation a `lastBump` meta string ("<generation>:<reason>:<ms>") names */
export function generationOf(lastBump: string | null | undefined): number | undefined {
	const n = Number(String(lastBump ?? '').split(':')[0]);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** nearest-rank percentile, 0 for an empty list */
export function pct(xs: number[], p: number): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number;
}

/** share of `rows` per outcome, in [0, 1] */
export function shares<T extends { outcome: Outcome }>(rows: T[]): Record<Outcome, number> {
	const out: Record<Outcome, number> = {
		RENDER: 0,
		WARMING503: 0,
		STALE: 0,
		AGED: 0,
		HIT_OLD_GEN: 0,
		HIT_CURRENT: 0,
		OTHER: 0
	};
	for (const r of rows) out[r.outcome] += rows.length ? 1 / rows.length : 0;
	return out;
}

function selftest(): void {
	const eq = (a: unknown, b: unknown, what: string) => {
		if (a !== b) throw new Error(`${what}: expected ${String(b)}, got ${String(a)}`);
	};
	eq(classify(503, { 'x-cfw-cache': 'MISS' }, 5), 'WARMING503', 'warming');
	eq(classify(200, { 'x-cfw-cache': 'KV', 'x-cfw-edge': 'STALE' }, 5), 'STALE', 'stale');
	eq(classify(200, { 'x-cfw-cache': 'KV' }, 5), 'HIT_CURRENT', 'kv without generation');
	eq(classify(200, { 'x-cfw-cache': 'AGED' }, 5), 'AGED', 'aged');
	eq(classify(200, { 'x-cfw-cache': 'RENDER' }, 5), 'RENDER', 'render');
	eq(classify(200, { 'x-cfw-cache': 'EDGE', 'x-cfw-generation': '4' }, 5), 'HIT_OLD_GEN', 'old');
	eq(classify(200, { 'x-cfw-cache': 'HIT', 'x-cfw-generation': '5' }, 5), 'HIT_CURRENT', 'cur');
	eq(classify(500, { 'x-cfw-cache': 'ERROR' }, 5), 'OTHER', 'error');
	eq(generationOf('7:cachetags:1700000000000'), 7, 'generation');
	eq(generationOf(null), undefined, 'no bump');
	eq(pct([5, 1, 3, 2, 4], 50), 3, 'median');
	eq(
		shares([{ outcome: 'RENDER' as Outcome }, { outcome: 'AGED' as Outcome }]).RENDER,
		0.5,
		'share'
	);
	console.log('selftest ok');
}

// #endregion

const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = join(import.meta.dir, '..', '..');
const argv = process.argv.slice(3);
const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

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

type Invocation = { at: number; cpuMs: number; wallMs?: number; entrypoint: string; type: string };

async function events(name: string, from: number, to: number): Promise<Invocation[]> {
	const out: Invocation[] = [];
	for (let t = from; t < to; t += 300_000) {
		const result = await cf<{ events?: { events?: Record<string, any>[] } }>(
			'/workers/observability/telemetry/query',
			{
				method: 'POST',
				body: JSON.stringify({
					queryId: `g64-${name}-${t}`,
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
			if (typeof w.cpuTimeMs !== 'number') continue;
			out.push({
				at: Number(e['timestamp'] ?? e['$metadata']?.timestamp ?? t),
				cpuMs: w.cpuTimeMs,
				wallMs: typeof w.wallTimeMs === 'number' ? w.wallTimeMs : undefined,
				entrypoint: String(w.entrypoint ?? ''),
				type: String(w.eventType ?? '')
			});
		}
	}
	return out;
}

type Stats = {
	cached: { path: string }[];
	queue: { path: string; priority?: number }[];
	lastBump: string | null;
	generation: number;
	rowsToday: number;
	alarmFirings?: number;
	phpBooted?: boolean;
	recycles?: number;
};

type VisitRow = {
	save: number;
	i: number;
	path: string;
	tOffsetMs: number;
	ms: number;
	status: number;
	outcome: Outcome;
	fresh: boolean | null;
	h: Record<string, string>;
};

type SaveRow = {
	save: number;
	node: number;
	marker: string;
	tSave: number;
	tQuiet: number | null;
	invalidated: string[];
	generation: number | undefined;
	rowsBefore: number;
	rowsAfter: number;
	rowsAfterQuiet: number | null;
	quietMs: number | null;
	queueAfterSave: number;
	phpBootedAtSave: boolean | undefined;
};

const HEADERS = [
	'x-cfw-cache',
	'x-cfw-edge',
	'x-cfw-generation',
	'x-cfw-aged-ms',
	'x-cfw-stale-behind',
	'x-cfw-plan',
	'x-cfw-inline',
	'x-cfw-inline-boot',
	'x-cfw-serve-ms',
	'x-worker-ms',
	'x-cfw-queued',
	'x-cfw-replica',
	'cf-cache-status'
];

async function main(): Promise<void> {
	if (!account || !token)
		throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
	const out = flag('out');
	if (!out) throw new Error('pass --out=<dir>');
	const saves = Number(flag('saves') ?? 10);
	const visits = Number(flag('visits') ?? 100);
	const spacing = Number(flag('spacing') ?? 300);
	const nodes = Number(flag('nodes') ?? 6);
	const baseSaves = Number(flag('base-saves') ?? 5);
	const rowCap = Number(flag('row-cap') ?? 60_000);
	const name = `cfw-e2e-g64-${Date.now()}`;
	const config = join(root, `wrangler.${name}.jsonc`);

	const before = await inventory();
	writeFileSync(join(out, 'inventory-before.json'), JSON.stringify(before, null, 1));
	console.log(
		`inventory before: ${before.workers.length} workers, ${before.durableObjects.length} namespaces, ${before.kv.length} kv, ${before.d1.length} d1`
	);

	const base = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
	base.name = name;
	base.d1_databases = [{ binding: 'FLEET_DB', database_name: `${name}-fleet` }];
	delete base.build;
	writeFileSync(config, JSON.stringify(base, null, '\t'));

	const failed: string[] = [];
	const summary: Record<string, unknown> = { name, startedAt: new Date().toISOString() };
	const started = Date.now();
	try {
		const deploy = spawnSync('bunx', ['wrangler', 'deploy', '-c', config], {
			cwd: root,
			encoding: 'utf8',
			env: process.env,
			maxBuffer: 64 * 1024 * 1024
		});
		process.stdout.write((deploy.stdout ?? '').replace(/[A-Za-z0-9_-]{40,}/g, '<redacted>'));
		process.stderr.write((deploy.stderr ?? '').replace(/[A-Za-z0-9_-]{40,}/g, '<redacted>'));
		if (deploy.status !== 0) throw new Error(`wrangler deploy exited ${deploy.status}`);
		const origin = /https:\/\/[^\s]+\.workers\.dev/.exec(deploy.stdout ?? '')?.[0];
		if (!origin) throw new Error('wrangler printed no workers.dev URL');
		console.log(`deployed ${name} at ${origin}`);
		await sleep(60_000);

		const site = new Site(origin);
		const pass = `g64-${crypto.randomUUID()}`;
		const owner = await provision(site, pass);

		const stats = async (): Promise<Stats> => {
			const res = await fetch(new URL('/serve-stats', origin), {
				headers: { authorization: `Bearer ${owner}` },
				signal: AbortSignal.timeout(60_000)
			});
			if (res.status !== 200) throw new Error(`/serve-stats answered ${res.status}`);
			return (await res.json()) as Stats;
		};
		const login = async () => {
			const form = await site.hit('/user/login');
			const res = await site.post('/user/login', {
				...hiddenFields(form.body),
				name: 'admin',
				pass,
				op: 'Log in'
			});
			site.cookie = sessionFrom(res.res.headers.getSetCookie());
			if (!site.cookie) throw new Error('the login set no session cookie');
		};
		const get = async (path: string) => {
			const t0 = Date.now();
			const res = await fetch(new URL(path, origin), {
				redirect: 'manual',
				signal: AbortSignal.timeout(120_000)
			});
			const body = await res.text();
			const h: Record<string, string> = {};
			for (const k of HEADERS) {
				const v = res.headers.get(k);
				if (v !== null) h[k] = v;
			}
			return { status: res.status, body, h, ms: Date.now() - t0 };
		};

		await login();
		// promoted nodes, so `/` and `/node` carry each title and a stale answer is visible in the body
		const nids: number[] = [];
		for (let n = 1; n <= nodes; n++) {
			const add = await site.hit('/node/add/page', { auth: true });
			const created = await site.post('/node/add/page', {
				...hiddenFields(add.body),
				'title[0][value]': `g64 seed ${n}`,
				'body[0][value]': `seed body ${n}`,
				'status[value]': '1',
				'promote[value]': '1',
				op: 'Save'
			});
			const nid = Number(
				/\/node\/(\d+)/.exec(created.res.headers.get('location') ?? '')?.[1]
			);
			if (!nid)
				throw new Error(`seed ${n} returned no node location (${created.res.status})`);
			nids.push(nid);
		}
		const watched = ['/', '/node', ...nids.map((n) => `/node/${n}`), '/user/login'];
		const isStored = (r: { status: number; h: Record<string, string> }) =>
			r.status === 200 &&
			['HIT', 'EDGE', 'MEM', 'KV'].includes((r.h['x-cfw-cache'] ?? '').toUpperCase());
		const warm = async (): Promise<number> => {
			let n = 0;
			for (let round = 0; round < 60; round++) {
				const rs = await Promise.all(watched.map((p) => get(p)));
				n = rs.filter(isStored).length;
				if (n === watched.length) return round;
				await sleep(1_000);
			}
			return -1;
		};
		const warmRounds = await warm();
		if (warmRounds < 0) throw new Error('a watched path never answered 200 from a stored page');
		summary.watched = watched;
		summary.warmRounds = warmRounds;
		console.log(
			`seeded ${nids.length} nodes, watched ${watched.length} paths, warm after ${warmRounds} rounds`
		);

		const settle = async (): Promise<void> => {
			for (let i = 0; i < 90; i++) {
				const s = await stats();
				if (s.queue.length === 0) break;
				await sleep(2_000);
			}
			await warm();
			await sleep(10_000);
		};

		const save = async (s: number, node: number) => {
			const marker = `g64s${s}x${Date.now().toString(36)}`;
			const nid = nids[node % nids.length] as number;
			const edit = await site.hit(`/node/${nid}/edit`, { auth: true });
			const res = await site.post(`/node/${nid}/edit`, {
				...hiddenFields(edit.body),
				'title[0][value]': `g64 ${marker}`,
				'body[0][value]': `edited ${marker}`,
				'status[value]': '1',
				'promote[value]': '1',
				op: 'Save'
			});
			return { marker, nid, tSave: Date.now(), status: res.res.status };
		};

		const rowsOf = async () => (await stats()).rowsToday;

		// #region phase one: save, then visitors on the invalidated set
		const visitRows: VisitRow[] = [];
		const saveRows: SaveRow[] = [];
		for (let s = 1; s <= saves; s++) {
			await settle();
			const pre = await stats();
			const preCached = new Set(pre.cached.map((c) => c.path));
			const w = await save(s, s - 1);
			if (w.status !== 303 && w.status !== 302) failed.push(`save ${s} answered ${w.status}`);
			const post = await stats();
			const postCached = new Set(post.cached.map((c) => c.path));
			const invalidated = [
				...new Set([
					...post.queue.map((q) => q.path),
					...[...preCached].filter((p) => !postCached.has(p))
				])
			]
				.concat(['/', '/node', `/node/${w.nid}`])
				.filter((p, i, a) => a.indexOf(p) === i && watched.includes(p))
				.sort();
			// checksummed pages go stale with no queue row, so name the paths the save's tags reach
			const generation = generationOf(post.lastBump);
			const row: SaveRow = {
				save: s,
				node: w.nid,
				marker: w.marker,
				tSave: w.tSave,
				tQuiet: null,
				invalidated,
				generation,
				rowsBefore: pre.rowsToday,
				rowsAfter: post.rowsToday,
				rowsAfterQuiet: null,
				quietMs: null,
				queueAfterSave: post.queue.length,
				phpBootedAtSave: post.phpBooted
			};
			saveRows.push(row);
			if (invalidated.length === 0) {
				console.log(`save ${s}: nothing invalidated (queue ${post.queue.length})`);
				continue;
			}
			const nodePath = `/node/${w.nid}`;
			for (let i = 0; i < visits; i++) {
				const due = w.tSave + i * spacing;
				if (Date.now() < due) await sleep(due - Date.now());
				const path = invalidated[i % invalidated.length] as string;
				const r = await get(path);
				const carries = [nodePath, '/', '/node'].includes(path);
				visitRows.push({
					save: s,
					i,
					path,
					tOffsetMs: Date.now() - w.tSave,
					ms: r.ms,
					status: r.status,
					outcome: classify(r.status, r.h, generation),
					fresh: carries ? r.body.includes(w.marker) : null,
					h: r.h
				});
			}
			for (let i = 0; i < 90; i++) {
				const q = await stats();
				if (q.queue.length === 0) {
					row.tQuiet = Date.now();
					row.quietMs = row.tQuiet - w.tSave;
					row.rowsAfterQuiet = q.rowsToday;
					break;
				}
				await sleep(2_000);
			}
			const mine = visitRows.filter((v) => v.save === s);
			const sh = shares(mine);
			console.log(
				`save ${s}: node ${w.nid}, ${invalidated.length} invalidated (${invalidated.join(' ')}), ` +
					`RENDER ${(sh.RENDER * 100).toFixed(0)}% 503 ${(sh.WARMING503 * 100).toFixed(0)}% STALE ${(sh.STALE * 100).toFixed(0)}% ` +
					`AGED ${(sh.AGED * 100).toFixed(0)}% OLD ${(sh.HIT_OLD_GEN * 100).toFixed(0)}% HIT ${(sh.HIT_CURRENT * 100).toFixed(0)}% ` +
					`OTHER ${(sh.OTHER * 100).toFixed(0)}%, quiet ${row.quietMs ?? 'never'} ms, rows ${row.rowsBefore} -> ${row.rowsAfterQuiet ?? row.rowsAfter}`
			);
			const cap = await rowsOf();
			if (cap > rowCap) {
				failed.push(`rows today ${cap} passed the cap ${rowCap}; stopping`);
				break;
			}
		}
		writeFileSync(join(out, 'phase1.json'), JSON.stringify({ saveRows, visitRows }, null, 1));
		// #endregion

		const all = shares(visitRows);
		summary.phase1 = {
			saves: saveRows.length,
			visits: visitRows.length,
			shares: all,
			firstVisit: visitRows
				.filter(
					(v) => v.i < (saveRows.find((r) => r.save === v.save)?.invalidated.length ?? 0)
				)
				.map((v) => v.outcome)
		};
		console.log(`PHASE1 DONE ${JSON.stringify(summary.phase1)}`);
		console.log(`WAITING-FOR-DECISION ${join(out, 'decision.txt')}`);
		let decision = 'stop';
		for (let i = 0; i < 300; i++) {
			if (existsSync(join(out, 'decision.txt'))) {
				decision = readFileSync(join(out, 'decision.txt'), 'utf8').trim();
				break;
			}
			await sleep(5_000);
		}
		summary.decision = decision;

		// #region phase two: saves with no visitors, rows and object CPU per save
		const baseRows: {
			save: number;
			marker: string;
			tSave: number;
			tQuiet: number | null;
			invalidated: string[];
			rowsBefore: number;
			rowsAfterQuiet: number | null;
		}[] = [];
		if (decision === 'go') {
			for (let s = 1; s <= baseSaves; s++) {
				await settle();
				const pre = await stats();
				const preCached = new Set(pre.cached.map((c) => c.path));
				const w = await save(100 + s, s - 1);
				const post = await stats();
				const postCached = new Set(post.cached.map((c) => c.path));
				const invalidated = [
					...new Set([
						...post.queue.map((q) => q.path),
						...[...preCached].filter((p) => !postCached.has(p))
					])
				].sort();
				let tQuiet: number | null = null;
				let rowsAfterQuiet: number | null = null;
				for (let i = 0; i < 90; i++) {
					const q = await stats();
					if (q.queue.length === 0) {
						tQuiet = Date.now();
						rowsAfterQuiet = q.rowsToday;
						break;
					}
					await sleep(2_000);
				}
				baseRows.push({
					save: s,
					marker: w.marker,
					tSave: w.tSave,
					tQuiet,
					invalidated,
					rowsBefore: pre.rowsToday,
					rowsAfterQuiet
				});
				console.log(
					`base save ${s}: ${invalidated.length} invalidated, rows ${pre.rowsToday} -> ${rowsAfterQuiet}`
				);
			}
			writeFileSync(join(out, 'phase2.json'), JSON.stringify({ baseRows }, null, 1));
		}
		// #endregion

		const final = await stats();
		summary.final = {
			rowsToday: final.rowsToday,
			alarmFirings: final.alarmFirings,
			recycles: final.recycles
		};
		await sleep(90_000);
		const seen = await events(name, started - 60_000, Date.now());
		writeFileSync(join(out, 'events.json'), JSON.stringify(seen, null, 1));
		summary.events = seen.length;
		console.log(`observability events ${seen.length}`);
		console.log('metered requests from this runner', site.requests);
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
		summary.inventoryDiffAfterMinusBefore = diff;
		summary.inventoryMissingVsBefore = gone;
		console.log(`INVENTORY EXTRA ${JSON.stringify(diff)}`);
		console.log(`INVENTORY MISSING ${JSON.stringify(gone)}`);
		console.log(
			isEmptyInventory(diff) && isEmptyInventory(gone) ? 'TEARDOWN OK' : 'TEARDOWN MISMATCH'
		);
		summary.failed = failed;
		writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
	}
	if (failed.length > 0) {
		for (const f of failed) console.log(`FAILED: ${f}`);
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	const mode = process.argv[2];
	if (mode === 'selftest') selftest();
	else if (mode === 'run') await main();
	else throw new Error('usage: g64-save-drive.ts run --out=<dir> | selftest');
}
