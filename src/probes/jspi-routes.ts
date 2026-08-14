/**
 * Routes that only mean anything on a build linked with -sJSPI plus the VM
 * interrupt patch (build/patch-vm-interrupt.sh).
 *
 * /jspi              capability report; what the glue and the engine actually did
 * /tick?n=&period=&mode=  arm the interrupt, run CPU_BENCH, report tick counters
 * /park?n=&period=&at=    suspend PHP mid-run and RETURN FROM fetch() with the
 *                         call still pending
 * /resume                 resolve the parked yield from a LATER invocation and
 *                         collect the PHP result
 *
 * Every timing here is Date.now() deltas measured locally, so only ratios
 * against another variant measured in the same process are meaningful. Iteration
 * counts are fixed; nothing is clock-driven, because Date.now() does not advance
 * during synchronous wasm execution on the edge.
 */
import { CPU_BENCH } from './cpu-bench';

/**
 * The emscripten Module, as these routes use it.
 *
 * Only the members this file reaches for are named. The `_zend_wasm_slice_*` three come from
 * build/patch-vm-interrupt.sh and are optional BECAUSE their absence is a reading: /jspi reports
 * whether the loaded binary has them.
 */
interface JspiBinary {
	lengthBytesUTF8(s: string): number;
	_malloc(bytes: number): number;
	stringToUTF8(s: string, ptr: number, maxBytes: number): void;
	_free(ptr: number): void;
	/** `any`: this returns a promise on a promising (-sJSPI) build and an int otherwise, and
	 *  which one it is is the measurement */
	_pib_run(ptr: number): any;
	_zend_wasm_slice_arm?: (period: number, mode: number) => void;
	_zend_wasm_slice_mask?: (mask: number) => void;
	_zend_wasm_slice_stat?: (which: number) => number;
	cfwVmYield?: (seq?: unknown) => unknown;
}

/** what one `collect()` produced: the pib_run return value and the output it buffered */
interface CollectResult {
	ret: unknown;
	out: string;
	error?: string;
}

/** a booted interpreter, as probe-core's `build()` hands it over */
interface JspiInstance {
	php: { flush(): void };
	out: string[];
	binary: JspiBinary;
}

/** the slice of probe-core's route context these routes read */
interface JspiRoutesArgs {
	label: string;
	build: () => Promise<JspiInstance>;
}

/** what probe-core hands a variant route handler */
interface JspiRouteArgs {
	url: URL;
	warm: JspiInstance;
}

/** the interrupt hook is installed on the Module AND on the global, which declares neither */
type VmYieldGlobal = typeof globalThis & { cfwVmYield?: (seq?: unknown) => unknown };

const num = (u: URL, k: string, d: number) => {
	const v = Number(u.searchParams.get(k));
	return Number.isFinite(v) && v !== 0 ? v : d;
};

/** pib_run through the Module export directly, so a promising export cannot be
 *  flattened by ccall's return-value conversion */
function runDirect(binary: JspiBinary, code: string) {
	const src = `?>${code}`;
	const len = binary.lengthBytesUTF8(src) + 1;
	const ptr = binary._malloc(len);
	binary.stringToUTF8(src, ptr, len);
	let r: any;
	try {
		r = binary._pib_run(ptr);
	} catch (e) {
		binary._free(ptr);
		throw e;
	}
	return Promise.resolve(r).then(
		(v: unknown) => {
			binary._free(ptr);
			return v;
		},
		(e: unknown) => {
			binary._free(ptr);
			throw e;
		}
	);
}

const stats = (binary: JspiBinary) => {
	if (!binary._zend_wasm_slice_stat) return null;
	const s = binary._zend_wasm_slice_stat;
	return {
		fires: s(0),
		yields: s(1),
		aborts: s(2),
		period: s(3),
		mask: s(4),
		mode: s(5),
		countdown: s(6)
	};
};

export function jspiRoutes({ label, build }: JspiRoutesArgs) {
	/** the park slot: the suspended run, its resolver, and whatever it produced */
	interface ParkSlot {
		resolve: ((value?: unknown) => void) | null;
		marks: unknown[];
		t0: number;
		run?: Promise<CollectResult>;
		done?: CollectResult;
		err?: string;
	}

	// survives between invocations in the same isolate; this is the park slot
	let parked: ParkSlot | null = null;

	async function collect(inst: JspiInstance, code: string): Promise<CollectResult> {
		inst.out.length = 0;
		const ret = await runDirect(inst.binary, code);
		try {
			await inst.php.flush();
		} catch {
			// flush is best-effort; the return value is the assertion
		}
		return { ret, out: inst.out.join('') };
	}

	return {
		'/jspi': async ({ warm }: JspiRouteArgs) => {
			const b = warm.binary;
			// a real (empty) run, because pib_run(NULL) would fault; the point is the
			// SHAPE of the return value, which is what tells us the export is promising
			const src = '?><?php ;';
			const len = b.lengthBytesUTF8(src) + 1;
			const ptr = b._malloc(len);
			b.stringToUTF8(src, ptr, len);
			const raw = b._pib_run(ptr);
			const promising = !!(raw && typeof raw.then === 'function');
			await Promise.resolve(raw).catch(() => {});
			b._free(ptr);
			return Response.json({
				label,
				engineHasSuspending: typeof WebAssembly.Suspending === 'function',
				engineHasPromising: typeof WebAssembly.promising === 'function',
				pibRunReturnsPromise: promising,
				hasSliceArm: !!b._zend_wasm_slice_arm,
				hasSliceMask: !!b._zend_wasm_slice_mask,
				hasSliceStat: !!b._zend_wasm_slice_stat,
				stats: stats(b)
			});
		},

		/**
		 * Exercises zend_bailout, i.e. the longjmp paths, three ways.
		 *
		 * This is the test that matters for a -sSUPPORT_LONGJMP=wasm build: that flag
		 * moves longjmp off invoke_* JS trampolines and onto wasm exception handling,
		 * and a module can validate and run without the throw/catch path ever being
		 * taken. exit(), a fatal error and an uncaught exception all bailout, and the
		 * instance has to still answer afterwards.
		 */
		'/bailout': async () => {
			const cases = {
				exit: '<?php echo "before"; exit(0); echo "after";',
				fatal: '<?php echo "before"; trigger_error("boom", E_USER_ERROR); echo "after";',
				uncaught: '<?php echo "before"; throw new RuntimeException("boom");',
				division:
					'<?php echo "before"; try { intdiv(1, 0); } catch (\\Throwable $e) { echo "|caught:", get_class($e); }'
			};
			// Partial: the catch path files an `error` alone, with no run to report
			const results: Record<string, Partial<CollectResult> & { alive?: unknown }> = {};
			for (const [name, code] of Object.entries(cases)) {
				// ONE FRESH INSTANCE PER CASE. Every one of these bails out, and a bailout
				// runs php_request_shutdown, after which that instance emits no more
				// output at all - measured: sharing an instance made the three cases after
				// exit() report out "" and silently zeroed four later /tick runs too.
				const inst = await build();
				try {
					results[name] = await collect(inst, code);
					// the instance must still answer after the bailout
					results[name]!.alive = (await collect(inst, '<?php echo "alive";')).ret;
				} catch (e: any) {
					results[name] = { error: `${e?.constructor?.name ?? ''}: ${e?.message ?? e}` };
				}
			}
			return Response.json({ label, results });
		},

		// mode 0 counts interrupts only; mode 1 suspends through JSPI on each one
		'/tick': async ({ warm, url }: JspiRouteArgs) => {
			const b = warm.binary;
			const n = num(url, 'n', 200000);
			const period = num(url, 'period', 0);
			const mode = Number(url.searchParams.get('mode') ?? 0) ? 1 : 0;
			let yields = 0;
			b.cfwVmYield = () => {
				yields++;
				return 0;
			};
			(globalThis as VmYieldGlobal).cfwVmYield = b.cfwVmYield;
			if (b._zend_wasm_slice_arm) b._zend_wasm_slice_arm(period, mode);
			const t0 = Date.now();
			const r = await collect(warm, CPU_BENCH.replace('__N__', String(n)));
			const execMs = Date.now() - t0;
			const after = stats(b);
			if (b._zend_wasm_slice_arm) b._zend_wasm_slice_arm(0, 0);
			return Response.json({
				label,
				n,
				period,
				mode,
				execMs,
				hostYields: yields,
				stats: after,
				...r
			});
		},

		// suspend and RETURN; the PHP call is still on the stack when fetch resolves
		'/park': async ({ warm, url }: JspiRouteArgs) => {
			const b = warm.binary;
			if (parked) return Response.json({ label, error: 'already parked' }, { status: 409 });
			const n = num(url, 'n', 20000);
			const period = num(url, 'period', 5000);
			const at = num(url, 'at', 1);
			let yields = 0;
			const marks: unknown[] = [];
			b.cfwVmYield = (seq: unknown) => {
				yields++;
				marks.push(seq);
				if (yields !== at) return 0;
				return new Promise((resolve) => {
					parked!.resolve = resolve;
				});
			};
			(globalThis as VmYieldGlobal).cfwVmYield = b.cfwVmYield;
			b._zend_wasm_slice_arm!(period, 1);
			parked = { resolve: null, marks, t0: Date.now() };
			parked.run = collect(warm, CPU_BENCH.replace('__N__', String(n))).then(
				(v) => {
					parked!.done = v;
					return v;
				},
				(e: any) => {
					parked!.err = `${e?.constructor?.name ?? ''}: ${e?.message ?? e}`;
					return { ret: null, out: '', error: parked!.err };
				}
			);
			// one turn of the microtask queue: enough for the run to reach its first
			// yield, and if the stack did not suspend it would have finished instead
			await new Promise((r) => setTimeout(r, 25));
			return Response.json({
				label,
				n,
				period,
				at,
				suspended: !!parked.resolve && !parked.done,
				finishedWithoutParking: !!parked.done,
				marks,
				stats: stats(b)
			});
		},

		'/resume': async ({ warm }: JspiRouteArgs) => {
			const b = warm.binary;
			if (!parked) return Response.json({ label, error: 'nothing parked' }, { status: 409 });
			const p = parked;
			if (!p.resolve) {
				parked = null;
				// the interesting failure: the run never suspended. p.err carries the
				// SuspendError when a JS frame was on the stack.
				return Response.json(
					{
						label,
						error: 'parked slot has no suspended stack',
						done: p.done ?? null,
						runError: p.err ?? null,
						stats: stats(b)
					},
					{ status: 409 }
				);
			}
			p.resolve(0);
			const r = await p.run;
			b._zend_wasm_slice_arm!(0, 0);
			parked = null;
			return Response.json({
				label,
				resumedAfterMs: Date.now() - p.t0,
				marks: p.marks,
				stats: stats(b),
				...r
			});
		}
	};
}
