/**
 * Runs scripts/sjlj-jspi-probe.c under workerd in both SjLj modes and reports
 * whether a JSPI suspension survives a setjmp frame.
 *
 * The interesting cell is (setjmp, emscripten SjLj): that is the shape
 * pib_run -> zend_eval_stringl -> zend_execute has today, and if it cannot
 * suspend then no -sJSPI php-wasm build can slice a render no matter what else
 * is right. (plain, *) is the control -- if that cannot suspend either, the
 * failure is not about setjmp.
 */
// must evaluate before the glue: the ENVIRONMENT=worker build reads
// self.location.href at module scope and workerd has no location
import '@drupflare/cartridge/shim';

import emFactory from '../../assets/sjlj/emsjlj.mjs';
import emWasm from '../../assets/sjlj/emsjlj.wasm';
import wasmFactory from '../../assets/sjlj/wasmsjlj.mjs';
import wasmWasm from '../../assets/sjlj/wasmsjlj.wasm';

/**
 * The emscripten factory both probe builds default-export.
 *
 * `any` on the Module, deliberately: it is emscripten's object, its members are named by the C
 * side (`_run_plain`, `_acc_value`) and one of them is reached by computed key below.
 */
type SjljFactory = (args: Record<string, unknown>) => Promise<any>;

/** the yield hook the C probe calls back into; `trial()` installs it on the global */
type YieldGlobal = typeof globalThis & { cfwYield?: () => Promise<unknown> };

/** what the parked `cfwYield` promise hands back to the wasm side */
type Resolver = (value?: unknown) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const instances = new Map<string, Promise<any>>();

async function load(key: string, factory: SjljFactory, wasmModule: WebAssembly.Module) {
	if (instances.has(key)) return instances.get(key);
	const p = factory({
		instantiateWasm(
			imports: WebAssembly.Imports,
			receiveInstance: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
		) {
			WebAssembly.instantiate(wasmModule, imports).then((instance) =>
				receiveInstance(instance, wasmModule)
			);
			return {};
		},
		printErr: () => {}
	});
	instances.set(key, p);
	return p;
}

async function trial(
	key: string,
	factory: SjljFactory,
	wasmModule: WebAssembly.Module,
	fn: string
) {
	const M = await load(key, factory, wasmModule);
	// the cast keeps the union in the flow type: the only assignment is inside the promise
	// callback below, so tsc would otherwise narrow this to `null` for the whole function
	let resolver: Resolver | null = null as Resolver | null;
	(globalThis as YieldGlobal).cfwYield = () =>
		new Promise((r) => {
			resolver = r;
		});

	let state = 'pending';
	let value: unknown = null;
	let err: string | null = null;
	// whatever the wasm export returned: a promise under JSPI, a number otherwise
	let raw: any;
	try {
		raw = M['_' + fn](7);
	} catch (e: any) {
		return { sjlj: key, fn, threwSynchronously: `${e?.message ?? e}`, suspended: false };
	}
	const returnedPromise = !!(raw && typeof raw.then === 'function');
	if (returnedPromise) {
		raw.then(
			(v: unknown) => {
				state = 'resolved';
				value = v;
			},
			(e: any) => {
				state = 'rejected';
				err = `${e?.constructor?.name ?? ''}: ${e?.message ?? e}`;
			}
		);
	} else {
		state = 'sync';
		value = raw;
	}

	await sleep(20);
	const suspended = state === 'pending' && resolver !== null;
	if (resolver) resolver(5);
	await sleep(20);

	return {
		sjlj: key,
		fn,
		returnedPromise,
		yieldCalled: resolver !== null,
		suspended,
		state,
		value,
		err,
		acc: M._acc_value()
	};
}

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/caps') {
			return Response.json({
				Suspending: typeof WebAssembly.Suspending === 'function',
				promising: typeof WebAssembly.promising === 'function',
				SuspendError: typeof WebAssembly.SuspendError === 'function'
			});
		}
		const out = [];
		for (const [key, factory, mod] of [
			['emscripten', emFactory, emWasm],
			['wasm', wasmFactory, wasmWasm]
		] as [string, SjljFactory, WebAssembly.Module][]) {
			for (const fn of ['run_plain', 'run_with_setjmp']) {
				try {
					out.push(await trial(key, factory, mod, fn));
				} catch (e: any) {
					out.push({ sjlj: key, fn, harnessError: `${e?.stack ?? e}` });
				}
			}
		}
		return Response.json({
			caps: { Suspending: typeof WebAssembly.Suspending === 'function' },
			trials: out
		});
	}
};
