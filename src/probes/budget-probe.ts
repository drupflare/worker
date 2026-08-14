/**
 * Prices the free tier's central assumption: is a Durable Object fetch its own
 * invocation, with its own CPU budget?
 *
 * The whole #lazy_builder splitting strategy is costed on "yes". If a stub.fetch()
 * shares the caller's CPU budget then splitting a 34 ms render into four pieces
 * buys nothing and the free tier is closed for good. Nobody had checked.
 *
 * METHOD. Two independent readings, because the cap alone is a bad instrument:
 *
 *   1. ACCOUNTING. wrangler tail emits one event per invocation with its own
 *      cpuTime and executionModel. If a single client request produces a
 *      "stateless" event and a separate durable-object event, each carrying its
 *      own cpuTime, the budget is per invocation by construction.
 *   2. ENFORCEMENT. limits.cpu_ms sets the documented per-invocation ceiling, and
 *      is only enforced on deployed Workers -- never in local dev. Compare a
 *      single over-cap burn against the same total split across hops.
 *
 * The cap is enforced loosely: a runaway loop reached cpuTime 2020 against a
 * cpu_ms of 10 before being terminated, which is the "built-in flexibility" the
 * docs mention. So enforcement is read as a pattern over repeats, not as a single
 * pass/fail, and the accounting reading is the primary evidence.
 */

/** the one binding wrangler.budget.jsonc declares */
interface BudgetEnv {
	BUDGET: DurableObjectNamespace;
}

/**
 * Burns CPU for a fixed number of work units.
 *
 * NOT clock-driven, and that is the whole point. Workers freeze Date.now() during
 * synchronous execution as a Spectre mitigation, so `while (Date.now() < deadline)`
 * never terminates: the first version of this burned 2,020 ms of CPU for a
 * requested 3 ms and every case died with exceededCpu, including ones that should
 * have passed. A unit count is deterministic and comparable across hops.
 */
function burnCpu(units: number): number {
	let sink = 0;
	const iterations = Math.max(0, units) * 100000;
	for (let i = 0; i < iterations; i++) {
		sink += Math.sqrt(i % 1024) * 1.0000001;
	}
	// the caller MUST put this in the response. An earlier version discarded it and
	// V8 eliminated the whole loop as dead code: cpuTime stayed flat at 4-5 ms from
	// units=1 to units=200, and a cpu_ms of 10 never fired
	return sink;
}

export class BudgetDurableObject {
	ctx: DurableObjectState;
	env: BudgetEnv;
	hops: number;

	constructor(ctx: DurableObjectState, env: BudgetEnv) {
		this.ctx = ctx;
		this.env = env;
		this.hops = 0;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const units = Number(url.searchParams.get('units') ?? 5);
		this.hops++;
		try {
			const sink = burnCpu(units);
			return Response.json({
				ok: true,
				where: 'durable-object',
				units,
				hops: this.hops,
				sink
			});
		} catch (e: any) {
			return Response.json(
				{ ok: false, where: 'durable-object', error: String(e?.message ?? e) },
				{ status: 500 }
			);
		}
	}
}

export default {
	async fetch(request: Request, env: BudgetEnv): Promise<Response> {
		const url = new URL(request.url);
		const stub = () => env.BUDGET.get(env.BUDGET.idFromName('probe'));
		const hop = (units: number) =>
			stub().fetch(`https://do.local/?units=${encodeURIComponent(units)}`);

		try {
			switch (url.pathname) {
				// calibration, and the single-invocation control
				case '/burn-worker': {
					const units = Number(url.searchParams.get('units') ?? 5);
					const sink = burnCpu(units);
					return Response.json({ ok: true, case: 'worker-only', units, sink });
				}

				// does the cap reach into a Durable Object at all?
				case '/burn-do': {
					const units = Number(url.searchParams.get('units') ?? 5);
					const res = await hop(units);
					return Response.json({
						ok: res.ok,
						case: 'do-only',
						units,
						inner: await res.json().catch(() => null)
					});
				}

				// the discriminating case: under the cap on each side, over it in total
				case '/burn-split': {
					const workerUnits = Number(url.searchParams.get('worker') ?? 5);
					const doUnits = Number(url.searchParams.get('do') ?? 5);
					const sink = burnCpu(workerUnits);
					const res = await hop(doUnits);
					return Response.json({
						ok: res.ok,
						case: 'split',
						workerUnits,
						doUnits,
						totalUnits: workerUnits + doUnits,
						sink,
						inner: await res.json().catch(() => null)
					});
				}

				// the splitting strategy itself: many hops, each individually cheap
				case '/burn-chain': {
					const hops = Math.min(Number(url.searchParams.get('hops') ?? 4), 20);
					const units = Number(url.searchParams.get('units') ?? 5);
					const results = [];
					for (let i = 0; i < hops; i++) {
						const res = await hop(units);
						results.push({ hop: i, status: res.status, ok: res.ok });
						if (!res.ok) break;
					}
					return Response.json({
						ok: results.every((r) => r.ok),
						case: 'chain',
						hops,
						unitsPerHop: units,
						totalUnits: hops * units,
						results
					});
				}

				case '/':
					return Response.json({
						probe: 'do-cpu-budget',
						routes: [
							'/burn-worker?units=',
							'/burn-do?units=',
							'/burn-split?worker=&do=',
							'/burn-chain?hops=&units='
						]
					});

				default:
					return new Response('not found\n', { status: 404 });
			}
		} catch (e: any) {
			return Response.json(
				{
					ok: false,
					error: String(e?.message ?? e),
					name: e?.name ?? null
				},
				{ status: 500 }
			);
		}
	}
};
