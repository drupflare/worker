/**
 * Worker CPU per request, by path class, for the two spool rig workers.
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
 *     bun scripts/measure/spool-cpu.ts --on=cfw-e2e-spool-on --off=cfw-e2e-spool-off \
 *       --from=2026-10-23T05:00:00Z --to=2026-10-23T07:00:00Z
 *
 * Reads the platform's own per-invocation record (Workers Observability events) for the front worker
 * entrypoint, in five minute slices so a slice stays under the 2,000 event limit. `cpuTime` is the
 * only absolute CPU instrument here and it is read in whole milliseconds, so a median of 1 is the
 * meter's floor and not a measurement of 1.0. A slice that returns the limit is reported, because
 * its tail is cut. The first request an isolate answers for an image pays the conversion and the
 * rest read the isolate's cache, so the image row is also read with its first request apart.
 */

export type Invocation = { path: string; cpuMs: number; at: number };

/** the class a request path is counted under */
export function pathClass(path: string): string {
	if (path === '/spool-sw.js') return 'spool worker script';
	if (path.startsWith('/.spool/')) return 'spool endpoint';
	if (path.startsWith('/sites/default/files/'))
		return /\.(mp4|webm)$/.test(path) ? 'video file' : 'image file';
	if (path === '/' || path === '/user/login' || /^\/node\/\d+$/.test(path)) return 'page';
	return 'other';
}

/** nearest-rank percentile of a list, 0 for an empty one */
export function percentile(xs: number[], p: number): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number;
}

export type Row = { n: number; median: number; p90: number; max: number };

/** CPU milliseconds by path class */
export function byClass(events: Invocation[]): Record<string, Row> {
	const groups = new Map<string, number[]>();
	for (const e of events) {
		const key = pathClass(e.path);
		groups.set(key, [...(groups.get(key) ?? []), e.cpuMs]);
	}
	return Object.fromEntries(
		[...groups].map(([key, xs]) => [
			key,
			{
				n: xs.length,
				median: percentile(xs, 50),
				p90: percentile(xs, 90),
				max: Math.max(...xs)
			}
		])
	);
}

/** the first request for each path, in time order: where a cold isolate's one-off work lands */
export function firstPerPath(events: Invocation[]): Invocation[] {
	const seen = new Set<string>();
	const out: Invocation[] = [];
	for (const e of [...events].sort((a, b) => a.at - b.at)) {
		if (seen.has(e.path)) continue;
		seen.add(e.path);
		out.push(e);
	}
	return out;
}

const arg = (name: string): string => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	if (!hit) throw new Error(`pass --${name}=`);
	return hit.slice(name.length + 3);
};

async function slice(name: string, from: number, to: number): Promise<Record<string, any>[]> {
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	const res = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				queryId: `spool-cpu-${name}-${from}`,
				view: 'events',
				limit: 2000,
				timeframe: { from, to },
				parameters: {
					filterCombination: 'and',
					filters: [
						{ key: '$metadata.service', operation: 'eq', type: 'string', value: name }
					]
				}
			})
		}
	);
	const body = (await res.json()) as { result?: { events?: { events?: Record<string, any>[] } } };
	return body.result?.events?.events ?? [];
}

async function read(name: string, from: number, to: number): Promise<Invocation[]> {
	const out: Invocation[] = [];
	for (let t = from; t < to; t += 300_000) {
		const events = await slice(name, t, Math.min(to, t + 300_000));
		if (events.length >= 2000)
			console.error(`${name}: slice at ${new Date(t).toISOString()} hit the limit`);
		for (const e of events) {
			const w = e['$workers'] ?? {};
			if ((w.entrypoint ?? w.eventType) !== 'fetch' || typeof w.cpuTimeMs !== 'number')
				continue;
			const url: string | undefined = w.event?.request?.url;
			if (!url) continue;
			out.push({
				path: new URL(url).pathname,
				cpuMs: w.cpuTimeMs,
				at: Number(e['timestamp'] ?? e['$metadata']?.timestamp ?? t)
			});
		}
	}
	return out;
}

if (import.meta.main) {
	const from = Date.parse(arg('from'));
	const to = Date.parse(arg('to'));
	for (const [label, name] of [
		['on', arg('on')],
		['off', arg('off')]
	] as const) {
		const events = await read(name, from, to);
		console.log(`\n${label} (${name}): ${events.length} front worker invocations`);
		for (const [cls, r] of Object.entries(byClass(events)).sort())
			console.log(
				`  ${cls.padEnd(20)} n=${String(r.n).padStart(5)}  cpu median ${r.median} ms  p90 ${r.p90}  max ${r.max}`
			);
		for (const e of firstPerPath(events).filter((x) => pathClass(x.path) === 'image file'))
			console.log(`  first image request ${e.path}: ${e.cpuMs} ms`);
	}
}
