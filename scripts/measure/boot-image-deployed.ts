/**
 * Cold-boot cost of a deployed worker, with and without the boot image.
 *
 *   bun scripts/measure/boot-image-deployed.ts drive --origin=https://x.workers.dev --arm=img \
 *     [--rounds=8] [--gap=60] > rows-img.jsonl
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bun scripts/measure/boot-image-deployed.ts \
 *     read --ctl=cfw-e2e-bootimg-ctl --img=cfw-e2e-bootimg-img --rows=rows-ctl.jsonl,rows-img.jsonl
 *
 * `drive` asks for `/node?r=<round>-<time>` once per round after an idle gap. A path nothing has
 * stored is a miss and renders (`/user/password` is stored on a stock site and answers a HIT), and a
 * gap past the 10 s hibernation threshold on a worker with `SITE_WARM=0` and `RETAIN_INTERPRETER=0`
 * leaves a cold object. `x-cfw-inline-boot: 1` says the request booted; a row without it is not a
 * cold sample.
 *
 * `read` takes each round's cost from the platform's own record of the object's invocations (Workers
 * Observability events), the largest `cpuTime` inside the round's window. `cpuTime` is whole
 * milliseconds, and an alarm inside a window can only raise a reading, so a figure here is an upper
 * bound for its round and a spread over rounds says how far to trust it.
 */
import { readFileSync } from 'node:fs';

/** one driven round */
export type Row = {
	arm: string;
	round: number;
	/** epoch ms before and after the request */
	t0: number;
	t1: number;
	status: number;
	bytes: number;
	/** whether the answer says this request booted the interpreter */
	cold: boolean;
};

/** the Durable Object class that serves a site and boots its interpreter */
const OBJECT = 'SitePhpDurableObject';

/** one invocation the platform recorded */
export type Invocation = { at: number; cpuMs: number; entrypoint: string; type: string };

/** nearest-rank percentile of a list, 0 for an empty one */
export function percentile(xs: number[], p: number): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number;
}

/** what the object's invocations inside one round's window spent, in whole milliseconds */
export type RoundCpu = { fetch: number; alarm: number; total: number };

/**
 * The Durable Object's cost for one round: the fetch and the alarm that woke with it, inside the
 * window padded for clock skew, or undefined when the platform recorded neither.
 *
 * Both are needed. A request that arrives at a cold object queues behind the alarm that woke it, so
 * the platform charges the boot to the ALARM event (1,986 ms) and leaves the request's own fetch
 * event small (634 ms). Reading the fetch alone understates a cold round by the whole boot, and by
 * more on the arm that boots from an image. The front worker's own events are left out.
 */
export function roundCpu(row: Row, events: Invocation[], padMs = 2_000): RoundCpu | undefined {
	const inside = events.filter(
		(e) => e.entrypoint === OBJECT && e.at >= row.t0 - padMs && e.at <= row.t1 + padMs
	);
	if (inside.length === 0) return undefined;
	const sum = (type: string) =>
		inside.filter((e) => e.type === type).reduce((n, e) => n + e.cpuMs, 0);
	const fetch = sum('fetch');
	const alarm = sum('alarm');
	return { fetch, alarm, total: fetch + alarm };
}

/** the cold rounds of an arm with their cost, in round order; a warm round is left out and counted */
export function armSamples(rows: Row[], events: Invocation[]) {
	const cold = rows.filter((r) => r.cold && r.status === 200);
	const costs = cold
		.map((r) => roundCpu(r, events))
		.filter((c): c is RoundCpu => c !== undefined);
	const cpu = costs.map((c) => c.total);
	return {
		rounds: rows.length,
		cold: cold.length,
		unread: cold.length - cpu.length,
		cpu,
		median: percentile(cpu, 50),
		p90: percentile(cpu, 90),
		min: cpu.length ? Math.min(...cpu) : 0,
		max: cpu.length ? Math.max(...cpu) : 0,
		fetchMedian: percentile(
			costs.map((c) => c.fetch),
			50
		),
		alarmMedian: percentile(
			costs.map((c) => c.alarm),
			50
		),
		wallMedian: percentile(
			cold.map((r) => r.t1 - r.t0),
			50
		)
	};
}

const arg = (name: string): string | undefined =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const need = (name: string): string => {
	const v = arg(name);
	if (!v) throw new Error(`pass --${name}=`);
	return v;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function drive(): Promise<void> {
	const origin = need('origin').replace(/\/$/, '');
	const arm = need('arm');
	const rounds = Number(arg('rounds') ?? 8);
	const gap = Number(arg('gap') ?? 60) * 1000;
	for (let round = 1; round <= rounds; round++) {
		await sleep(gap);
		const t0 = Date.now();
		const res = await fetch(`${origin}/node?r=${round}-${t0}`, { redirect: 'manual' });
		const body = await res.arrayBuffer();
		const row: Row = {
			arm,
			round,
			t0,
			t1: Date.now(),
			status: res.status,
			bytes: body.byteLength,
			cold: res.headers.get('x-cfw-inline-boot') === '1'
		};
		console.log(JSON.stringify(row));
	}
}

async function events(account: string, token: string, name: string, from: number, to: number) {
	const out: Invocation[] = [];
	for (let t = from; t < to; t += 300_000) {
		const res = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,
			{
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					queryId: `boot-image-${name}-${t}`,
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
		const body = (await res.json()) as {
			result?: { events?: { events?: Record<string, any>[] } };
		};
		for (const e of body.result?.events?.events ?? []) {
			const w = e['$workers'] ?? {};
			if (typeof w.cpuTimeMs !== 'number') continue;
			out.push({
				at: Number(e['timestamp'] ?? e['$metadata']?.timestamp ?? t),
				cpuMs: w.cpuTimeMs,
				entrypoint: String(w.entrypoint ?? ''),
				type: String(w.eventType ?? '')
			});
		}
	}
	return out;
}

async function read(): Promise<void> {
	const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
	const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
	const names = { ctl: need('ctl'), img: need('img') };
	const [ctlRows, imgRows] = need('rows')
		.split(',')
		.map((f) =>
			readFileSync(f, 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Row)
		) as [Row[], Row[]];
	for (const [label, rows, name] of [
		['control', ctlRows, names.ctl],
		['image', imgRows, names.img]
	] as const) {
		const from = Math.min(...rows.map((r) => r.t0)) - 60_000;
		const to = Math.max(...rows.map((r) => r.t1)) + 60_000;
		const s = armSamples(rows, await events(account, token, name, from, to));
		console.log(
			`${label.padEnd(8)} rounds ${s.rounds}, cold ${s.cold}, unread ${s.unread}: cpu median ${s.median} ms ` +
				`p90 ${s.p90} (min ${s.min}, max ${s.max}), fetch ${s.fetchMedian} + alarm ${s.alarmMedian}, ` +
				`wall median ${s.wallMedian} ms  [${s.cpu.join(' ')}]`
		);
	}
}

if (import.meta.main) {
	const mode = process.argv[2];
	if (mode === 'drive') await drive();
	else if (mode === 'read') await read();
	else throw new Error('usage: boot-image-deployed.ts drive|read');
}
