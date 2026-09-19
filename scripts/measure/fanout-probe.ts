/**
 * What actually bounds a load generator that runs inside Cloudflare.
 *
 * A pooled-lane curve read ~31 req/s at every pool size, and that was attributed to the documented
 * "6 simultaneous outgoing connections per invocation". The attribution was never isolated: the
 * generator reaches its arms over SERVICE BINDINGS, the shards were driven from a laptop whose own
 * fetch pool is 6 per origin, and either of those produces the same flat reading. This probe holds
 * the target's service time fixed and sweeps only the concurrency, so the ceiling is a measurement
 * rather than an inference.
 *
 *   GET /sleep?ms=200          the synthetic target: known service time, no work
 *   GET /fan?n=48&ms=200       n parallel subrequests over the SELF service binding
 *   GET /fan?n=48&ms=200&sub=1 n sub-INVOCATIONS, each fanning out 6, for the nested arm
 *
 * Read `concurrency` in the reply, not `elapsedMs` alone: it is n x ms / elapsed, so an uncapped run
 * reports ~n and a run capped at k reports ~k whatever n was asked for.
 */

type FanReply = {
	n: number;
	ms: number;
	elapsedMs: number;
	/** the effective parallelism the platform allowed, derived rather than assumed */
	concurrency: number;
	p50: number | null;
	p95: number | null;
	errors: number;
	threw?: string;
};

function percentile(xs: number[], q: number): number | null {
	if (xs.length === 0) return null;
	return [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)] ?? null;
}

async function fan(
	self: { fetch: typeof fetch },
	n: number,
	ms: number,
	path: string
): Promise<FanReply> {
	const latencies: number[] = [];
	let errors = 0;
	let threw: string | undefined;
	const t0 = Date.now();
	await Promise.all(
		Array.from({ length: n }, async () => {
			const started = Date.now();
			try {
				const res = await self.fetch(`https://fan.invalid${path}&ms=${ms}`);
				await res.text();
				latencies.push(Date.now() - started);
				if (!res.ok) errors += 1;
			} catch (e) {
				errors += 1;
				threw ??= String((e as Error)?.message ?? e);
			}
		})
	);
	const elapsedMs = Date.now() - t0;
	return {
		n,
		ms,
		elapsedMs,
		concurrency: elapsedMs > 0 ? Number(((n * ms) / elapsedMs).toFixed(2)) : n,
		p50: percentile(latencies, 0.5),
		p95: percentile(latencies, 0.95),
		errors,
		...(threw === undefined ? {} : { threw })
	};
}

export default {
	async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
		const url = new URL(request.url);
		const ms = Math.max(0, Math.min(Number(url.searchParams.get('ms') ?? 200), 5_000));

		if (url.pathname === '/sleep') {
			// a real await, so the invocation holds a connection open for `ms` the way a render does
			await scheduler.wait(ms);
			return new Response('slept');
		}

		const self = (env as Record<string, { fetch: typeof fetch } | undefined>).SELF;
		if (!self) return Response.json({ error: 'no SELF binding' }, { status: 400 });
		const n = Math.max(1, Math.min(Number(url.searchParams.get('n') ?? 6), 512));

		// the nested arm asks whether a SUB-INVOCATION carries its own budget: if the flat arm caps at
		// k, this one caps at k x k unless the limit is per isolate rather than per invocation
		if (url.pathname === '/fan') {
			const nested = url.searchParams.get('sub') === '1';
			return Response.json(await fan(self, n, ms, nested ? '/fan?n=6' : '/sleep?x=1'));
		}
		return new Response('not found', { status: 404 });
	}
};
