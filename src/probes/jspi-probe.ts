import wasmModule from '../../assets/jspi/park.wasm';

/**
 * Half (b) of the slicing question: does a JSPI-SUSPENDED WASM STACK survive the gap
 * between two Durable Object invocation callbacks?
 *
 * Half (a) is already measured -- CPU spent after a parked promise resolves is
 * charged to the RESUMING invocation (src/attribution-probe.js: /park 2 ms, /resume
 * 88 ms, one-shot control 93 ms). That proved slicing is not refuted by billing. It
 * did NOT prove the mechanism a PHP render would actually need, because a render is
 * one synchronous `php._run()` call and parking it mid-render means parking a wasm
 * stack, not a JS continuation.
 *
 * Deliberately NOT php-wasm. A 1,055-byte C loop (scripts/jspi-probe.c) isolates the
 * platform question from every PHP question, and it needed no php-wasm rebuild --
 * which is the only reason this is a one-afternoon experiment rather than a
 * multi-hour Docker build with a known configure gate.
 *
 * The evidence is `cfw.mark`, a non-suspending import the loop calls once per
 * iteration. Each mark records which invocation it ran in, so a pass looks like
 * iterations 0-5 stamped with the /park invocation and 6-9 stamped with /resume. A
 * result that merely returns the right integer would not distinguish "the stack
 * survived" from "the whole loop ran inside /park".
 */

/** the one binding wrangler.jspi.jsonc declares */
interface JspiEnv {
	JSPI: DurableObjectNamespace;
}

/** one `cfw.mark` call: the loop iteration, and the invocation it ran in */
interface Mark {
	i: number;
	invocation: number;
}

/**
 * The probe module, once `promising` has wrapped the two suspending entry points.
 *
 * `any` on `exports` and on the nopark control: these are raw wasm exports, so their types come
 * from build/probes/jspi-probe.c and nothing on the JS side can narrow them.
 */
interface ProbeModule {
	exports: any;
	runLoop: (total: number, parkAt: number, units: number) => Promise<any>;
	runLoopMulti: (total: number, every: number, units: number) => Promise<any>;
	runLoopNopark: any;
}

/** what one alarm firing writes to storage before it returns */
interface AlarmOutcome {
	firedAt: number;
	invocation: number;
	error?: string;
	result?: unknown;
	marks?: string[];
}

/** raw JSPI, no emscripten glue; absent primitives are reported rather than thrown */
function jspiCaps() {
	return {
		Suspending: typeof WebAssembly.Suspending === 'function',
		promising: typeof WebAssembly.promising === 'function',
		SuspendError: typeof WebAssembly.SuspendError === 'function'
	};
}

export class JspiDurableObject {
	ctx: DurableObjectState;
	env: JspiEnv;
	invocation: number;
	marks: Mark[];
	release: (() => void) | null;
	pending: Promise<unknown> | null;
	instance: ProbeModule | null;
	parkedIn: number | null;
	parkCalls: number;
	lastError: string | null;
	/** the chain fields, set by /chain and read by alarm(); absent until one has run */
	chainDone?: boolean;
	chainResult?: unknown;
	chainSlices?: number;
	alarmFired?: number;
	alarmResult?: unknown;
	alarmError?: string | null;

	constructor(ctx: DurableObjectState, env: JspiEnv) {
		this.ctx = ctx;
		this.env = env;
		/** every fetch() bumps this, and every mark is stamped with it */
		this.invocation = 0;
		this.marks = [];
		this.release = null;
		this.pending = null;
		this.instance = null;
		this.parkedIn = null;
		this.parkCalls = 0;
		this.lastError = null;
	}

	/**
	 * Instantiates the probe with `park` wrapped in WebAssembly.Suspending.
	 *
	 * The wrapper's function returns a promise that is resolved by a LATER
	 * invocation, which is the whole experiment: at that moment the wasm frames of
	 * run_loop -> middle -> inner are on a suspended stack with nothing running.
	 */
	async ensureInstance(): Promise<ProbeModule> {
		if (this.instance) return this.instance;
		const caps = jspiCaps();
		if (!caps.Suspending || !caps.promising) {
			throw new Error(`JSPI unavailable: ${JSON.stringify(caps)}`);
		}

		const mark = (i: number) => {
			this.marks.push({ i, invocation: this.invocation });
		};
		const park = async (i: number) => {
			this.parkCalls++;
			this.parkedIn = this.invocation;
			return new Promise((resolve) => {
				// resolved by /resume, in a different invocation
				this.release = () => resolve(i * 7 + 1);
			});
		};

		// `any` twice over: a Suspending wrapper is not in the lib's `ImportValue` union, and the
		// result is read both as an Instance and as a ResultObject on the next line
		const instance: any = await WebAssembly.instantiate(wasmModule, {
			cfw: { mark, park: new WebAssembly.Suspending(park) }
		} as any);
		const exports = instance.exports ?? instance.instance?.exports;
		this.instance = {
			exports,
			// a promising export is what makes a suspending import legal below it
			runLoop: WebAssembly.promising(exports.run_loop),
			runLoopMulti: WebAssembly.promising(exports.run_loop_multi),
			runLoopNopark: exports.run_loop_nopark
		};
		return this.instance;
	}

	/**
	 * Lets the resumed wasm run until it suspends again or finishes.
	 *
	 * A macrotask hop, not a microtask one: resolving the park promise queues the
	 * wasm continuation as a microtask, so `await Promise.resolve()` can come back
	 * before the wasm has reached its next suspension and the chain would re-arm on
	 * stale state.
	 */
	async settle() {
		await new Promise((r) => setTimeout(r, 0));
	}

	async fetch(request: Request): Promise<Response> {
		this.invocation++;
		const url = new URL(request.url);
		const total = Number(url.searchParams.get('total') ?? 10);
		const parkAt = Number(url.searchParams.get('park') ?? 5);
		const units = Number(url.searchParams.get('units') ?? 8);

		try {
			switch (url.pathname) {
				case '/caps':
					return Response.json({ caps: jspiCaps(), invocation: this.invocation });

				/**
				 * Starts the loop and returns while it is suspended.
				 *
				 * The returned promise is held, never awaited here -- awaiting it would
				 * keep the invocation open and measure nothing.
				 */
				case '/park': {
					const inst = await this.ensureInstance();
					this.marks = [];
					this.release = null;
					this.pending = inst.runLoop(total, parkAt, units);
					// surface a synchronous rejection rather than an unhandled one
					this.pending.catch((e: any) => {
						this.lastError = String(e?.stack ?? e?.message ?? e);
					});
					return Response.json({
						parked: this.release !== null,
						parkCalls: this.parkCalls,
						parkedInInvocation: this.parkedIn,
						invocation: this.invocation,
						marksSoFar: this.marks.map((m) => `${m.i}@${m.invocation}`),
						error: this.lastError
					});
				}

				/** Resolves the held promise, so the suspended stack continues HERE. */
				case '/resume': {
					if (!this.release) {
						return Response.json(
							{
								error: 'nothing parked',
								invocation: this.invocation,
								lastError: this.lastError
							},
							{ status: 409 }
						);
					}
					this.release();
					let result: unknown = null;
					let error: string | null = null;
					try {
						result = await this.pending;
					} catch (e: any) {
						error = String(e?.stack ?? e?.message ?? e);
					}
					this.release = null;
					this.pending = null;
					return Response.json({
						result,
						error,
						invocation: this.invocation,
						parkedInInvocation: this.parkedIn,
						marks: this.marks.map((m) => `${m.i}@${m.invocation}`),
						// 171000 for total=10 park=5: acc 135 + (5*7+1), corruption mask 0
						expected: expectedFor(total, parkAt)
					});
				}

				/** Control: identical work, one invocation, no suspension. */
				case '/oneshot': {
					const inst = await this.ensureInstance();
					this.marks = [];
					const result = inst.runLoopNopark(total, units);
					return Response.json({
						result,
						invocation: this.invocation,
						marks: this.marks.map((m) => `${m.i}@${m.invocation}`),
						expected: expectedFor(total, -1)
					});
				}

				/**
				 * Park, then resume from an ALARM rather than a fetch.
				 *
				 * A fill chain is driven by alarms, so if suspension only survives
				 * fetch-to-fetch the design still does not work. Arms an alarm at +1 ms.
				 */
				case '/park-alarm': {
					const inst = await this.ensureInstance();
					this.marks = [];
					this.release = null;
					this.pending = inst.runLoop(total, parkAt, units);
					this.pending.catch((e: any) => {
						this.lastError = String(e?.stack ?? e?.message ?? e);
					});
					await this.ctx.storage.setAlarm(Date.now() + 1);
					return Response.json({
						parked: this.release !== null,
						alarmArmed: true,
						invocation: this.invocation,
						marks: this.marks.map((m) => `${m.i}@${m.invocation}`)
					});
				}

				// Read from STORAGE, not from instance fields. The first attempt read the
				// fields and got a fresh object: the DO was evicted between the alarm and
				// the read, so the answer to the question was discarded before anyone saw
				// it while tail showed the alarm had run and burned 21 ms.
				/**
				 * THE PRODUCTION SHAPE: one wasm stack, N suspensions, N alarm invocations.
				 *
				 * Starts run_loop_multi, which suspends every `every` iterations, then hands
				 * the chain to alarm(). Each firing resolves one park and re-arms if the
				 * stack has suspended again, so the total work is spread over N separately
				 * charged invocations -- exactly what a sliced render would do.
				 */
				case '/chain': {
					const inst = await this.ensureInstance();
					const every = Number(url.searchParams.get('every') ?? 5);
					this.marks = [];
					this.release = null;
					this.chainDone = false;
					this.chainResult = null;
					this.chainSlices = 1;
					await this.ctx.storage.delete('chainOutcome');
					this.pending = inst.runLoopMulti(total, every, units);
					this.pending.then(
						(v) => {
							this.chainDone = true;
							this.chainResult = v;
						},
						(e: any) => {
							this.chainDone = true;
							this.lastError = String(e?.stack ?? e?.message ?? e);
						}
					);
					await this.ctx.storage.setAlarm(Date.now() + 1);
					return Response.json({
						chain: true,
						total,
						every,
						units,
						expectedSlices: 1 + Math.floor((total - 1) / every),
						suspended: this.release !== null,
						invocation: this.invocation,
						marks: this.marks.map((m) => `${m.i}@${m.invocation}`)
					});
				}

				case '/chain-result': {
					const stored = await this.ctx.storage.get('chainOutcome');
					return Response.json({
						stored: stored ?? null,
						live: {
							done: this.chainDone ?? null,
							result: this.chainResult ?? null,
							slices: this.chainSlices ?? null,
							marks: this.marks.map((m) => `${m.i}@${m.invocation}`),
							lastError: this.lastError
						},
						invocation: this.invocation
					});
				}

				case '/alarm-result': {
					const stored = await this.ctx.storage.get('alarmOutcome');
					return Response.json({
						stored: stored ?? null,
						liveFields: {
							alarmResult: this.alarmResult ?? null,
							alarmError: this.alarmError ?? null,
							alarmFired: this.alarmFired ?? 0,
							marks: this.marks.map((m) => `${m.i}@${m.invocation}`)
						},
						invocation: this.invocation
					});
				}

				default:
					return new Response('not found\n', { status: 404 });
			}
		} catch (e: any) {
			return Response.json(
				{ error: String(e?.stack ?? e?.message ?? e), invocation: this.invocation },
				{ status: 500 }
			);
		}
	}

	/**
	 * The alarm half of the same question; an alarm is its own invocation.
	 *
	 * The outcome is written to durable storage before returning, because the object
	 * can be evicted between this firing and anyone asking -- observed exactly that,
	 * with tail showing the alarm had done the work.
	 */
	async alarm(): Promise<void> {
		this.invocation++;
		this.alarmFired = (this.alarmFired ?? 0) + 1;

		// the chain drives itself: resolve one park, let the stack run to its next
		// suspension, re-arm if it has not finished
		if (this.chainDone === false) {
			if (!this.release) {
				await this.ctx.storage.put('chainOutcome', {
					error: 'chain alarm fired with nothing suspended',
					slices: this.chainSlices
				});
				return;
			}
			this.release();
			this.release = null;
			this.chainSlices!++;
			await this.settle();
			if (this.chainDone) {
				await this.ctx.storage.put('chainOutcome', {
					result: this.chainResult,
					slices: this.chainSlices,
					marks: this.marks.map((m) => `${m.i}@${m.invocation}`),
					error: this.lastError ?? null
				});
			} else {
				await this.ctx.storage.setAlarm(Date.now() + 1);
			}
			return;
		}

		const outcome: AlarmOutcome = { firedAt: Date.now(), invocation: this.invocation };
		if (!this.release) {
			outcome.error = 'nothing parked when the alarm fired';
			this.alarmError = outcome.error;
			await this.ctx.storage.put('alarmOutcome', outcome);
			return;
		}
		this.release();
		try {
			this.alarmResult = await this.pending;
			outcome.result = this.alarmResult;
			this.alarmError = null;
		} catch (e: any) {
			this.alarmError = String(e?.stack ?? e?.message ?? e);
			outcome.error = this.alarmError;
		}
		outcome.marks = this.marks.map((m) => `${m.i}@${m.invocation}`);
		await this.ctx.storage.put('alarmOutcome', outcome);
		this.release = null;
		this.pending = null;
	}
}

/** what run_loop must return if the stack came back intact */
function expectedFor(total: number, parkAt: number) {
	let acc = 0;
	for (let i = 0; i < total; i++) {
		acc += i * 3;
		if (i === parkAt) acc += i * 7 + 1;
	}
	return acc * 1000;
}

export default {
	async fetch(request: Request, env: JspiEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/') {
			return Response.json({
				routes: [
					'/caps',
					'/park',
					'/resume',
					'/oneshot',
					'/park-alarm',
					'/alarm-result',
					'/chain',
					'/chain-result'
				]
			});
		}
		// `obj` picks the instance. A live Durable Object keeps running the script
		// version it started on, so a redeploy that adds a route 404s until the object
		// is evicted -- measured, and a fresh name is the way past it rather than
		// waiting the eviction out.
		const stub = env.JSPI.get(env.JSPI.idFromName(url.searchParams.get('obj') ?? 'probe'));
		return stub.fetch(new Request(`https://do.local${url.pathname}${url.search}`));
	}
};
