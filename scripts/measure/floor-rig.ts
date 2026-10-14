/**
 * Memory, CPU per render and latency against offered load for one conventional-host arm.
 *
 * Drives a `docker/vps-container` image reached at --target, whether that is a local docker run or
 * the Cloudflare Container arm, so both hosts are measured by the same code from the same machine.
 * Latency is reported twice: the client round trip, and nginx's own `$request_time` (`x-vps-ms`),
 * which is the server's response time including its queue and carries no network term.
 *
 *   bun scripts/measure/floor-rig.ts --target=http://100.89.33.84:8101 --label=paisley-1cpu-2g --out=run.json
 *
 * Every request is a render: a unique query string, and a response answered from nginx's cache is
 * counted and refused, never averaged in.
 */
import { writeFileSync } from 'node:fs';
import { percentile } from './vps-compare';

/** one request's evidence */
export interface Row {
	ms: number;
	serverMs: number | null;
	status: number;
	hit: boolean;
}

/** the arrival offsets, in ms, of a Poisson process at `rate` a second over `seconds` */
export function poissonArrivals(rate: number, seconds: number, rand: () => number = Math.random) {
	const out: number[] = [];
	let t = 0;
	for (;;) {
		t += (-Math.log(1 - rand()) / rate) * 1000;
		if (t >= seconds * 1000) return out;
		out.push(t);
	}
}

/** latency and error summary over the rows of one cell */
export function summarise(rows: Row[]) {
	const ok = rows.filter((r) => r.status >= 200 && r.status < 400);
	const client = ok.map((r) => r.ms).sort((a, b) => a - b);
	const server = ok
		.map((r) => r.serverMs)
		.filter((v): v is number => v !== null)
		.sort((a, b) => a - b);
	return {
		n: rows.length,
		ok: ok.length,
		errors: rows.length - ok.length,
		cacheHits: rows.filter((r) => r.hit).length,
		clientP50: percentile(client, 50),
		clientP95: percentile(client, 95),
		clientP99: percentile(client, 99),
		serverP50: percentile(server, 50),
		serverP95: percentile(server, 95),
		serverP99: percentile(server, 99)
	};
}

let nonce = `${process.pid}-${Date.now()}`;
let counter = 0;

async function render(base: string): Promise<Row> {
	const t0 = performance.now();
	try {
		const res = await fetch(`${base}/?cachebust=${nonce}-${++counter}`, { redirect: 'manual' });
		await res.arrayBuffer();
		const server = Number(res.headers.get('x-vps-ms'));
		return {
			ms: performance.now() - t0,
			serverMs: Number.isFinite(server) && res.headers.has('x-vps-ms') ? server * 1000 : null,
			status: res.status,
			hit: (res.headers.get('x-fastcgi-cache') ?? '').toUpperCase() === 'HIT'
		};
	} catch {
		return { ms: performance.now() - t0, serverMs: null, status: 0, hit: false };
	}
}

/** fixed concurrency for a fixed duration */
export async function closedLoop(base: string, concurrency: number, seconds: number) {
	const deadline = Date.now() + seconds * 1000;
	const rows: Row[] = [];
	const started = Date.now();
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (Date.now() < deadline) rows.push(await render(base));
		})
	);
	const elapsed = (Date.now() - started) / 1000;
	const s = summarise(rows);
	return { concurrency, seconds: elapsed, rps: s.ok / elapsed, ...s };
}

/** Poisson arrivals at a fixed rate; slow requests do not slow the arrivals */
export async function openLoop(base: string, rate: number, seconds: number) {
	const rows: Row[] = [];
	const pending: Promise<void>[] = [];
	const t0 = performance.now();
	for (const at of poissonArrivals(rate, seconds)) {
		const wait = at - (performance.now() - t0);
		if (wait > 1) await new Promise((r) => setTimeout(r, wait));
		pending.push(render(base).then((row) => void rows.push(row)));
	}
	await Promise.all(pending);
	const s = summarise(rows);
	return { offeredRate: rate, achievedRate: rows.length / seconds, seconds, ...s };
}

/** the fields of /__probe the driver reads; the rest is carried through untouched */
interface Probe {
	cgroup?: { cpuStat?: Record<string, number> };
}

async function probe(base: string): Promise<Probe> {
	const res = await fetch(`${base}/__probe`);
	if (!res.ok) throw new Error(`probe answered ${res.status}`);
	return (await res.json()) as Probe;
}

function arg(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : fallback;
}

if (import.meta.main) {
	const base = arg('target', '').replace(/\/$/, '');
	if (base === '') throw new Error('pass --target=<url>');
	const label = arg('label', base);
	const out = arg('out', `floor-${label}.json`);
	const seconds = Number(arg('seconds', '15'));
	const openSeconds = Number(arg('open-seconds', '30'));
	const levels = arg('concurrency', '1,2,4,8,16,32').split(',').map(Number);
	const fracs = arg('fracs', '0.25,0.5,0.7,0.8,0.9,0.95').split(',').map(Number);
	const log = (m: string) => console.error(`[${label}] ${m}`);

	const result: Record<string, unknown> = {
		label,
		target: base,
		startedAt: new Date().toISOString()
	};
	result.probeIdle = await probe(base);
	log('idle probe taken');

	// one render pays for opcache and the first container boot outside the readings
	await closedLoop(base, 2, 20);
	result.probeWarm = await probe(base);
	log('warmed');

	const before = await probe(base);
	const sweep = [];
	for (const c of levels) {
		const cell = await closedLoop(base, c, seconds);
		sweep.push(cell);
		log(
			`c=${c} rps=${cell.rps.toFixed(1)} serverP50=${cell.serverP50.toFixed(0)}ms ` +
				`serverP95=${cell.serverP95.toFixed(0)}ms clientP95=${cell.clientP95.toFixed(0)}ms ` +
				`err=${cell.errors} hits=${cell.cacheHits}`
		);
	}
	const after = await probe(base);
	result.sweep = sweep;
	result.probeSaturated = after;
	const renders = sweep.reduce((n, c) => n + c.ok, 0);
	const cpuUsec = (p: { cgroup?: { cpuStat?: Record<string, number> } }) =>
		p.cgroup?.cpuStat?.usage_usec ?? null;
	const b = cpuUsec(before);
	const a = cpuUsec(after);
	result.cpuMsPerRender =
		b !== null && a !== null && renders > 0 ? (a - b) / 1000 / renders : null;
	const capacity = Math.max(...sweep.map((c) => c.rps));
	result.capacityRps = capacity;
	log(`capacity ${capacity.toFixed(1)} renders/s, cpu ms per render ${result.cpuMsPerRender}`);

	const ladder = [];
	for (const f of fracs) {
		const cell = await openLoop(base, capacity * f, openSeconds);
		ladder.push({ fraction: f, ...cell });
		log(
			`open ${(f * 100).toFixed(0)}% rate=${cell.offeredRate.toFixed(1)}/s ` +
				`serverP95=${cell.serverP95.toFixed(0)}ms clientP95=${cell.clientP95.toFixed(0)}ms ` +
				`err=${cell.errors} hits=${cell.cacheHits}`
		);
	}
	result.openLoop = ladder;
	result.probeEnd = await probe(base);
	result.finishedAt = new Date().toISOString();
	writeFileSync(out, JSON.stringify(result, null, 2));
	log(`wrote ${out}`);
}
