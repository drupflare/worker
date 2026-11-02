#!/usr/bin/env bun
/**
 * Spec 66 gates 2 to 4 on the paid default account.
 *
 *   bun scripts/measure/g66p-dynamic-workers.ts <step> --out=<dir> [--name=<worker>]
 *
 * steps: deploy, call <query>, gate2, gate4, lat, mix, meters, teardown, inventory
 * Reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN and never prints them. State lives in
 * <out>/state.json so a step can be repeated while the probe is being debugged.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
const root = join(import.meta.dir, '..', '..');
const probe = join(root, 'scripts', 'e2e', 'g66p-probe');
const step = process.argv[2] ?? '';
const flag = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const out = flag('out') ?? join(root, '.g66p-out');
const statePath = join(out, 'state.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scrub = (s: string) => s.split(token).join('<token>').split(account).join('<account>');
const say = (s: string) => {
	const line = scrub(s);
	console.log(line);
	appendFileSync(join(out, 'run.log'), line + '\n');
};

type State = { name: string; base: string; deployedAt: number; startedAt: string };
const loadState = (): State => JSON.parse(readFileSync(statePath, 'utf8'));
const saveState = (s: State) => writeFileSync(statePath, JSON.stringify(s, null, 2));

async function cf<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
		...init,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
	});
	const body = (await res.json()) as { success?: boolean; result?: T; errors?: unknown };
	if (!res.ok || body.success === false) {
		throw new Error(
			scrub(`${init.method ?? 'GET'} ${path}: ${res.status} ${JSON.stringify(body.errors)}`)
		);
	}
	return body.result as T;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
	const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ query, variables })
	});
	const body = (await res.json()) as { data?: T; errors?: unknown };
	if (body.errors)
		throw new Error(scrub(`graphql: ${JSON.stringify(body.errors).slice(0, 600)}`));
	return body.data as T;
}

async function inventory() {
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

async function hit(path: string, timeoutMs = 30000) {
	const st = loadState();
	const t0 = performance.now();
	try {
		const res = await fetch(`${st.base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
		const text = await res.text();
		return {
			wall: Math.round(performance.now() - t0),
			http: res.status,
			handler: res.headers.get('x-handler'),
			pageMs: res.headers.get('x-page-ms'),
			text
		};
	} catch (e) {
		return {
			wall: Math.round(performance.now() - t0),
			http: 0,
			fetchError: String(e),
			text: ''
		};
	}
}

const q = (o: Record<string, string | number>) =>
	Object.entries(o)
		.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
		.join('&');

function stats(xs: number[]) {
	const s = [...xs].sort((a, b) => a - b);
	const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
	return { n: s.length, min: s[0], p50: at(0.5), p90: at(0.9), max: s[s.length - 1] };
}

async function deploy() {
	mkdirSync(out, { recursive: true });
	const name = flag('name') ?? `cfw-e2e-g66p-${Date.now()}`;
	const before = await inventory();
	writeFileSync(join(out, 'inventory-before.json'), JSON.stringify(before, null, 2));
	say(
		`inventory before: workers=${before.workers.length} do=${before.durableObjects.length} kv=${before.kv.length} d1=${before.d1.length}`
	);
	say(`worker: ${name}`);
	const r = spawnSync(
		'bunx',
		['wrangler', 'deploy', '--config', join(probe, 'wrangler.jsonc'), '--name', name],
		{
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env }
		}
	);
	const text = scrub(`${r.stdout}\n${r.stderr}`);
	writeFileSync(join(out, 'deploy.log'), text);
	say(`deploy exit ${r.status}`);
	say(text.slice(-1200));
	if (r.status !== 0) return;
	const sub = await cf<{ subdomain: string }>('/workers/subdomain');
	const st: State = {
		name,
		base: `https://${name}.${sub.subdomain}.workers.dev`,
		deployedAt: Date.now(),
		startedAt: new Date(Date.now() - 60_000).toISOString()
	};
	saveState(st);
	for (let i = 0; i < 24; i++) {
		const p = await hit('/plain', 10000);
		if (p.http === 200) {
			say(`plain route up after ${i} polls`);
			return;
		}
		await sleep(5000);
	}
	say('plain route never came up');
}

async function call(query: string) {
	const r = await hit(`/${query}`);
	say(JSON.stringify({ query, ...r, text: r.text.slice(0, 900) }));
}

type Row = Record<string, unknown>;
const rows: Row[] = [];
const record = (row: Row) => {
	rows.push(row);
	appendFileSync(join(out, 'rows.jsonl'), scrub(JSON.stringify(row)) + '\n');
};

async function probeCase(label: string, query: Record<string, string | number>, i: number) {
	const r = await hit(`/probe?${q(query)}`);
	let body: unknown = r.text;
	try {
		body = JSON.parse(r.text);
	} catch {
		/* keep text */
	}
	const row = { label, i, wall: r.wall, http: r.http, body, fetchError: r.fetchError };
	record(row);
	say(JSON.stringify(row).slice(0, 700));
	return row;
}

async function gate2() {
	const n = 3;
	for (let i = 0; i < n; i++) await probeCase('A-bindings', { p: '/bindings', via: 'load' }, i);
	for (let i = 0; i < n; i++) {
		const r = await hit('/tenants');
		const row = {
			label: 'B-tenants',
			i,
			wall: r.wall,
			http: r.http,
			body: JSON.parse(r.text || 'null')
		};
		record(row);
		say(JSON.stringify(row).slice(0, 1500));
	}
	for (let i = 0; i < n; i++) await probeCase('C-net-null', { p: '/net', via: 'load' }, i);
	for (let i = 0; i < n; i++)
		await probeCase('C-net-gate', { p: '/gate', via: 'load', gate: 1 }, i);
	for (let i = 0; i < n; i++) await probeCase('D-cpu', { p: '/cpu', via: 'load', cpu: 50 }, i);
	for (let i = 0; i < n; i++)
		await probeCase('D-idle', { p: '/idle', via: 'load', timeout: 3000 }, i);
	for (let i = 0; i < n; i++) await probeCase('E-mem', { p: '/mem', via: 'load', cpu: 2000 }, i);
	for (let i = 0; i < n; i++) await probeCase('Z-after', { p: '/ok', via: 'load' }, i);
}

async function gate4() {
	const modes = [
		'ok',
		'throw',
		'hang',
		'cpu',
		'mem',
		'syntax',
		'caperror',
		'badjson',
		'big',
		'status500',
		'idle'
	];
	for (const mode of modes) {
		for (let i = 0; i < 3; i++) {
			const handler = mode === 'syntax' ? 'ok' : mode;
			const query: Record<string, string | number> = {
				handler,
				where: 'inline',
				via: 'load'
			};
			if (mode === 'syntax') query.mode = 'syntax';
			if (mode === 'mem') query.cpu = 2000;
			const r = await hit(`/page?${q(query)}`);
			const row = {
				label: `page-${mode}`,
				i,
				wall: r.wall,
				http: r.http,
				marker: r.text.includes('PAGE-RENDERED'),
				handler: r.handler,
				pageMs: r.pageMs
			};
			record(row);
			say(JSON.stringify(row).slice(0, 500));
		}
	}
	// a real page after every failure, and the deferred shape
	for (let i = 0; i < 3; i++) {
		const r = await hit(`/page?${q({ handler: 'throw', where: 'defer', via: 'load' })}`);
		const row = {
			label: 'page-throw-defer',
			i,
			wall: r.wall,
			http: r.http,
			marker: r.text.includes('PAGE-RENDERED'),
			handler: r.handler
		};
		record(row);
		say(JSON.stringify(row));
	}
}

async function lat() {
	const arms: { label: string; query: Record<string, string | number> }[] = [
		{ label: 'none', query: { handler: 'none' } },
		{
			label: 'inline-get-warm',
			query: { handler: 'ok', via: 'get', id: 'g66p-lat', where: 'inline' }
		},
		{ label: 'inline-load', query: { handler: 'ok', via: 'load', where: 'inline' } },
		{ label: 'defer-load', query: { handler: 'ok', via: 'load', where: 'defer' } }
	];
	await hit(`/page?${q({ handler: 'ok', via: 'get', id: 'g66p-lat', where: 'inline' })}`);
	const res: Record<string, { wall: number[]; pageMs: number[]; handlerMs: number[] }> = {};
	for (const a of arms) res[a.label] = { wall: [], pageMs: [], handlerMs: [] };
	for (let i = 0; i < 12; i++) {
		for (const a of arms) {
			const cell = res[a.label]!;
			const r = await hit(`/page?${q(a.query)}`);
			cell.wall.push(r.wall);
			cell.pageMs.push(Number(r.pageMs ?? NaN));
			try {
				cell.handlerMs.push(JSON.parse(r.handler ?? '{}').ms ?? NaN);
			} catch {
				/* none */
			}
			record({
				label: `lat-${a.label}`,
				i,
				wall: r.wall,
				pageMs: r.pageMs,
				handler: r.handler,
				http: r.http
			});
		}
	}
	for (const a of arms) {
		const x = res[a.label]!;
		say(
			`lat ${a.label}: wall ${JSON.stringify(stats(x.wall))} page-ms ${JSON.stringify(stats(x.pageMs.filter(Number.isFinite)))} handler-ms ${x.handlerMs.length ? JSON.stringify(stats(x.handlerMs.filter(Number.isFinite))) : 'n/a'}`
		);
	}
}

async function conc() {
	for (let round = 0; round < 3; round++) {
		const busy = hit(`/probe?${q({ p: '/cpu', via: 'load', cpu: 50, timeout: 9000 })}`);
		await sleep(400);
		const plains: Promise<{ at: number; wall: number; http: number }>[] = [];
		const t0 = performance.now();
		for (let i = 0; i < 6; i++) {
			plains.push(
				hit('/plain', 15000).then((r) => ({
					at: Math.round(performance.now() - t0),
					wall: r.wall,
					http: r.http
				}))
			);
			await sleep(300);
		}
		const done = await Promise.all(plains);
		const b = await busy;
		const row = {
			label: 'conc-cpu',
			round,
			busyWall: b.wall,
			plain: done.map((d) => `${d.wall}ms/${d.http}`)
		};
		record(row);
		say(JSON.stringify(row));
	}
}

async function alignMinute() {
	const ms = 60_000 - (Date.now() % 60_000);
	await sleep(ms + 2000);
}

async function arms() {
	const plan: { arm: string; n: number; query: (i: number) => string }[] = [
		{
			arm: 'cpu-limit-50',
			n: 5,
			query: () => `/probe?${q({ p: '/cpu', via: 'load', cpu: 50, timeout: 9000 })}`
		},
		{
			arm: 'webhook-get-one-id',
			n: 20,
			query: () => `/mix?${q({ kind: 'webhook', site: 'arm' })}`
		},
		{
			arm: 'heavy-get-one-id',
			n: 20,
			query: () => `/mix?${q({ kind: 'heavy', site: 'arm' })}`
		},
		{
			arm: 'exec-load-same-code',
			n: 20,
			query: () => `/mix?${q({ kind: 'exec', site: 'arm' })}`
		},
		{
			arm: 'mem-spike',
			n: 5,
			query: () => `/probe?${q({ p: '/mem', via: 'load', cpu: 2000 })}`
		},
		{ arm: 'host-only-plain', n: 20, query: () => '/plain' }
	];
	const marks: { arm: string; n: number; start: string; end: string }[] = [];
	for (const a of plan) {
		await alignMinute();
		const start = new Date().toISOString();
		for (let i = 0; i < a.n; i++) await hit(a.query(i), 20000);
		const end = new Date().toISOString();
		marks.push({ arm: a.arm, n: a.n, start, end });
		say(`arm ${a.arm} n=${a.n} ${start} -> ${end}`);
	}
	writeFileSync(join(out, 'arms.json'), JSON.stringify(marks, null, 2));
}

async function armsRead() {
	const st = loadState();
	const marks = JSON.parse(readFileSync(join(out, 'arms.json'), 'utf8')) as {
		arm: string;
		n: number;
		start: string;
		end: string;
	}[];
	for (const m of marks) {
		const lo = new Date(Date.parse(m.start) - 61_000).toISOString();
		const hi = new Date(Date.parse(m.end) + 61_000).toISOString();
		const d = await gql<unknown>(
			`query ($a: String!, $f: AccountWorkersInvocationsByOwnerAndScriptGroupsFilter_InputObject) { viewer { accounts(filter: { accountTag: $a }) {
				g: workersInvocationsByOwnerAndScriptGroups(limit: 100, filter: $f) {
					dimensions { datetimeMinute } sum { requests cpuTimeUs } uniq { distinctDynamicWorkerCount }
				} } } }`,
			{ a: account, f: { datetime_geq: lo, datetime_leq: hi } }
		);
		const h = await gql<unknown>(
			`query ($a: String!, $s: String!, $lo: Time!, $hi: Time!) { viewer { accounts(filter: { accountTag: $a }) {
				w: workersInvocationsAdaptive(limit: 50, filter: { scriptName: $s, datetime_geq: $lo, datetime_leq: $hi }) {
					dimensions { status datetimeMinute } sum { requests cpuTimeUs } quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 }
				} } } }`,
			{ a: account, s: st.name, lo, hi }
		);
		say(`ARM ${m.arm} n=${m.n} window ${m.start}..${m.end}`);
		say(
			`  dynamic: ${JSON.stringify((d as { viewer: { accounts: { g: unknown }[] } }).viewer.accounts[0]?.g)}`
		);
		say(
			`  host: ${JSON.stringify((h as { viewer: { accounts: { w: unknown }[] } }).viewer.accounts[0]?.w)}`
		);
	}
}

async function mix() {
	const plan: string[] = [];
	for (let i = 0; i < 120; i++) plan.push(`webhook:${i % 10}`);
	for (let i = 0; i < 40; i++) plan.push('exec:0');
	for (let i = 0; i < 40; i++) plan.push('heavy:0');
	plan.sort(() => Math.random() - 0.5);
	const times: Record<string, number[]> = { webhook: [], exec: [], heavy: [] };
	let errs = 0;
	for (const item of plan) {
		const [kind = '', site = ''] = item.split(':');
		const r = await hit(`/mix?${q({ kind, site })}`);
		let b: { error?: string; ms?: number } = {};
		try {
			b = JSON.parse(r.text);
		} catch {
			/* keep */
		}
		if (b.error || r.http !== 200) {
			errs++;
			record({ label: 'mix-error', kind, http: r.http, body: r.text.slice(0, 300) });
		}
		if (typeof b.ms === 'number') times[kind]?.push(b.ms);
	}
	say(`mix: ${plan.length} requests, ${errs} errors`);
	for (const k of Object.keys(times))
		say(`mix ${k}: host ms ${JSON.stringify(stats(times[k]!))}`);
	writeFileSync(join(out, 'mix-times.json'), JSON.stringify(times));
}

async function meters() {
	const st = loadState();
	const since = st.startedAt;
	const until = new Date().toISOString();
	const w = await gql<unknown>(
		`query ($a: String!, $s: String!, $since: Time!, $until: Time!) { viewer { accounts(filter: { accountTag: $a }) {
			w: workersInvocationsAdaptive(limit: 20, filter: { scriptName: $s, datetime_geq: $since, datetime_leq: $until }) {
				dimensions { status }
				sum { requests errors subrequests cpuTimeUs }
				quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 }
			}
		} } }`,
		{ a: account, s: st.name, since, until }
	).catch((e) => ({ error: String(e) }));
	say(`workersInvocationsAdaptive: ${JSON.stringify(w)}`);
	writeFileSync(join(out, 'meter-workers.json'), scrub(JSON.stringify(w, null, 2)));
	const d = await gql<unknown>(
		`query ($a: String!, $f: AccountWorkersInvocationsByOwnerAndScriptGroupsFilter_InputObject) { viewer { accounts(filter: { accountTag: $a }) {
			g: workersInvocationsByOwnerAndScriptGroups(limit: 100, filter: $f) {
				dimensions { datetimeFiveMinutes }
				sum { requests cpuTimeUs }
				uniq { distinctDynamicWorkerCount }
			}
		} } }`,
		{ a: account, f: { datetime_geq: since, datetime_leq: until } }
	).catch((e) => ({ error: String(e) }));
	say(`workersInvocationsByOwnerAndScriptGroups: ${JSON.stringify(d).slice(0, 3000)}`);
	writeFileSync(join(out, 'meter-dynamic.json'), scrub(JSON.stringify(d, null, 2)));
}

async function teardown() {
	const st = loadState();
	let err = '';
	try {
		await cf(`/workers/scripts/${st.name}?force=true`, { method: 'DELETE' });
	} catch (e) {
		err = String(e);
	}
	say(`worker delete: ${err || 'ok'}`);
	const before = JSON.parse(readFileSync(join(out, 'inventory-before.json'), 'utf8')) as Awaited<
		ReturnType<typeof inventory>
	>;
	const after = await inventory();
	writeFileSync(join(out, 'inventory-after.json'), JSON.stringify(after, null, 2));
	const diff = (k: 'workers' | 'durableObjects' | 'kv' | 'd1') => ({
		added: after[k].filter((x) => !before[k].includes(x)),
		removed: before[k].filter((x) => !after[k].includes(x))
	});
	const d = {
		workers: diff('workers'),
		durableObjects: diff('durableObjects'),
		kv: diff('kv'),
		d1: diff('d1')
	};
	say(`inventory diff: ${JSON.stringify(d)}`);
	say(`mine still present: ${after.workers.includes(st.name)}`);
}

async function main() {
	if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set');
	mkdirSync(out, { recursive: true });
	if (step === 'deploy') return deploy();
	if (step === 'call') return call(process.argv[3] ?? 'plain');
	if (step === 'gate2') return gate2();
	if (step === 'gate4') return gate4();
	if (step === 'lat') return lat();
	if (step === 'mix') return mix();
	if (step === 'conc') return conc();
	if (step === 'arms') return arms();
	if (step === 'armsread') return armsRead();
	if (step === 'meters') return meters();
	if (step === 'teardown') return teardown();
	if (step === 'inventory') {
		const inv = await inventory();
		say(
			JSON.stringify({
				workers: inv.workers,
				do: inv.durableObjects.length,
				kv: inv.kv.length,
				d1: inv.d1.length
			})
		);
		return;
	}
	throw new Error(`unknown step ${step}`);
}

if (!existsSync(out)) mkdirSync(out, { recursive: true });
await main();
void rows;
