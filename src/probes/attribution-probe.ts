/**
 * Decides whether time-slicing work across Durable Object invocations is possible
 * at all, and does it WITHOUT needing a JSPI rebuild.
 *
 * The slicing idea is: start expensive work in one invocation, park it, return,
 * then resume it in the next invocation so each gets a fresh 10 ms budget. That
 * rests on an undocumented behaviour — **which invocation is charged for work
 * that was started in one and completed in another.**
 *
 * The question decomposes, and only the second half needs a JSPI build:
 *
 *   (a) ATTRIBUTION. Does CPU spent after a parked promise resolves count against
 *       the invocation that resolves it, or against the one that parked it?
 *   (b) SUSPENSION. Can a suspended *wasm* stack survive across invocations?
 *
 * (a) is testable in plain JS right now, and it is the cheap falsification: if
 * attribution follows the ORIGINATING invocation, slicing cannot work no matter
 * what JSPI does, and the whole branch dies this afternoon instead of after a
 * multi-hour rebuild.
 *
 * Method: /park burns a little, then awaits a promise held in DO memory and
 * returns. /resume resolves that promise, so the continuation — including a large
 * burn — runs during the resuming invocation. Read cpuTime per invocation from
 * `wrangler tail` and see where the large burn landed.
 */

/** the one binding wrangler.attr.jsonc and wrangler.canary.jsonc declare */
interface AttrEnv {
	ATTR: DurableObjectNamespace;
}

/** one `/verdict` post, as the Tail Worker files it */
interface Verdict {
	at: number;
	body: string;
}

/**
 * Burns CPU for a fixed number of units.
 *
 * Iteration-counted, not clock-driven: Workers freeze Date.now() during
 * synchronous execution, so a deadline loop never terminates. The result must be
 * returned and used, or V8 eliminates the loop as dead code — both traps were hit
 * and measured earlier in this project.
 */
function burnCpu(units: number): number {
	let sink = 0;
	const iterations = Math.max(0, units) * 100000;
	for (let i = 0; i < iterations; i++) {
		sink += Math.sqrt(i % 1024) * 1.0000001;
	}
	return sink;
}

export class AttributionDurableObject {
	ctx: DurableObjectState;
	env: AttrEnv;
	release: ((value?: unknown) => void) | null;
	pending: Promise<string> | null;
	sink: number;
	verdicts?: Verdict[];

	constructor(ctx: DurableObjectState, env: AttrEnv) {
		this.ctx = ctx;
		this.env = env;
		this.release = null;
		this.pending = null;
		this.sink = 0;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const small = Number(url.searchParams.get('small') ?? 2);
		const big = Number(url.searchParams.get('big') ?? 120);

		switch (url.pathname) {
			/**
			 * Park. Burns `small`, then leaves a continuation waiting on a promise this
			 * object holds, and returns. The big burn is INSIDE the continuation, so it
			 * has not run when this invocation ends.
			 */
			case '/park': {
				this.sink += burnCpu(small);
				const gate = new Promise((resolve) => {
					this.release = resolve;
				});
				this.pending = gate.then(() => {
					// the whole question: whose CPU budget pays for this?
					this.sink += burnCpu(big);
					return 'resumed-and-burned';
				});
				return Response.json({
					parked: true,
					smallUnits: small,
					bigUnits: big,
					sink: this.sink
				});
			}

			/** Resume. Resolves the promise, so the continuation runs here. */
			case '/resume': {
				if (!this.release) {
					return Response.json({ error: 'nothing parked' }, { status: 409 });
				}
				this.release();
				const result = await this.pending;
				this.release = null;
				this.pending = null;
				return Response.json({ result, sink: this.sink });
			}

			/** Control: the same total burn, all in one invocation. */
			case '/oneshot': {
				this.sink += burnCpu(small) + burnCpu(big);
				return Response.json({ oneshot: true, totalUnits: small + big, sink: this.sink });
			}

			/**
			 * Where the Tail Worker files its verdict.
			 *
			 * The Worker cannot read its own cpuTime, so the canary cannot judge itself:
			 * the three legs are run here and scored from the trace events by
			 * src/tail-worker.js, which posts the answer back here.
			 */
			case '/verdict': {
				const body = await request.text();
				this.verdicts = this.verdicts ?? [];
				this.verdicts.push({ at: Date.now(), body: body.slice(0, 1000) });
				if (this.verdicts.length > 20) this.verdicts.shift();
				await this.ctx.storage.put('lastVerdict', this.verdicts.at(-1));
				return Response.json({ recorded: true, count: this.verdicts.length });
			}

			case '/verdicts':
				return Response.json({
					live: this.verdicts ?? [],
					stored: (await this.ctx.storage.get('lastVerdict')) ?? null
				});

			default:
				return new Response('not found\n', { status: 404 });
		}
	}
}

export default {
	async fetch(request: Request, env: AttrEnv): Promise<Response> {
		const url = new URL(request.url);
		const stub = env.ATTR.get(env.ATTR.idFromName('probe'));
		if (url.pathname === '/') {
			return Response.json({
				routes: ['/park', '/resume', '/oneshot', '/canary', '/verdicts']
			});
		}

		/**
		 * THE CANARY. Re-runs the three-invocation probe so a change in CPU attribution
		 * surfaces in tail instead of in customer pages.
		 *
		 * Each leg is tagged `?canary=<id>&leg=<name>` because tail batches are neither
		 * ordered nor guaranteed to arrive together, so the Tail Worker has to identify a
		 * leg from the URL rather than from position. The legs are issued in sequence:
		 * /resume is meaningless before /park has parked.
		 *
		 * Nothing is asserted here. This Worker cannot read its own cpuTime, which is the
		 * entire reason the verdict belongs in src/tail-worker.js.
		 */
		if (url.pathname === '/canary') {
			const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
			const legs = [];
			for (const leg of ['park', 'resume', 'oneshot']) {
				const target = `https://do.local/${leg}?canary=${id}&leg=${leg}`;
				const res = await stub.fetch(new Request(target));
				legs.push({ leg, status: res.status });
			}
			return Response.json({
				canary: id,
				legs,
				note: 'cpuTime per leg is scored by the tail consumer; poll /verdicts'
			});
		}

		return stub.fetch(new Request(`https://do.local${url.pathname}${url.search}`));
	}
};
