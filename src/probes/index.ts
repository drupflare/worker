// must evaluate before the glue; see the file for why
import './browser-shim';

import { PhpBase, type PhpBaseModuleFactory, type PhpRuntimeArgs } from 'php-wasm/PhpBase';
import PHPFactory from '../../vendor/php8.3-web.mjs';
import wasmModule from '../../vendor/php8.3.wasm';
import { CPU_BENCH } from './cpu-bench';

/**
 * The emscripten Module, as this worker uses it.
 *
 * php-wasm types `PhpBinaryRuntime.FS` as bare `object` and leaves it optional, so the two calls
 * this file makes into MEMFS are named here and the cast happens where `php.binary` resolves.
 */
interface ProbeBinary {
	FS: {
		mkdir(path: string): void;
		writeFile(path: string, data: Uint8Array | string): void;
	};
	wasmMemory?: { buffer: ArrayBufferLike };
	HEAPU8?: { buffer: ArrayBufferLike };
}

/** the one binding this probe reads its fixtures through */
interface ProbeEnv {
	ASSETS: Fetcher;
}

/** one `pack.json` entry, from the granular-vs-packed experiment's own index */
interface PackSlice {
	name: string;
	offset: number;
	length: number;
}

/** one `core.json` entry: path, offset into the blob, length */
interface PackEntry {
	p: string;
	o: number;
	l: number;
}

/** what the module-evaluation boot reported */
interface BootReport {
	ok: boolean;
	error: string | null;
	diag: string[];
	ms: number | null;
	idleMemoryBytes: number | null;
}

/** what a deadline-guarded wait produced; `value` is the resolved value when `ok` */
interface TimedResult {
	ok: boolean;
	value?: unknown;
	error?: string;
}

/** what one `run()` reported; `boot` is present only on the never-booted path */
interface RunResult {
	execMs?: number;
	error?: string | null;
	memoryBytes?: number | null;
	stdout?: string;
	boot?: BootReport;
}

/**
 * PHP runtime bound to a statically imported WebAssembly.Module.
 *
 * Two workerd constraints shape this:
 *
 * 1. Wasm cannot be compiled from bytes at request time, so the binary is
 *    imported at build time and handed to emscripten via instantiateWasm.
 * 2. The shipped php-wasm builds are MAIN_MODULE (dylink) builds, and
 *    emscripten's dynamic linker synthesizes trampoline modules at runtime via
 *    convertJsFunctionToWasm. That is codegen, so it only succeeds during
 *    module evaluation -- which forces instantiation to isolate startup.
 */
class PhpWorkerd extends PhpBase {
	/** the raw entry point php-wasm's published types omit; `run()` is a wrapper over it */
	declare _run: (code: string) => Promise<unknown>;

	constructor(args: PhpRuntimeArgs = {}, diag: string[] = []) {
		const note = (m: string) => diag.push(`+${Date.now() - t0}ms ${m}`);
		const t0 = Date.now();
		// php-wasm types the loader's `default` as a CONSTRUCTOR, while every real php-wasm build
		// exports an emscripten factory function; the cast is over that upstream mismatch
		super(
			Promise.resolve({ default: PHPFactory }) as unknown as Promise<PhpBaseModuleFactory>,
			{
				...args,
				// 134217728 (128 MiB) is the build default, not a floor
				INITIAL_MEMORY: args.INITIAL_MEMORY ?? 134217728,
				print: (t: string) => note(`out: ${t}`),
				printErr: (t: string) => note(`err: ${t}`),
				monitorRunDependencies: (left: number) => note(`runDeps=${left}`),
				onAbort: (what: unknown) => note(`abort: ${what}`),
				instantiateWasm(
					imports: WebAssembly.Imports,
					receiveInstance: (
						instance: WebAssembly.Instance,
						module: WebAssembly.Module
					) => void
				) {
					note(`instantiateWasm imports=${Object.keys(imports).join(',')}`);
					WebAssembly.instantiate(wasmModule, imports)
						.then((instance) => {
							note('instantiated');
							receiveInstance(instance, wasmModule);
							note('receiveInstance ok');
						})
						.catch((e: any) => note(`FAILED: ${e?.message ?? e}`));
					return {};
				}
			}
		);
	}
}

/** wasm linear memory in bytes; the number the memory argument turns on */
const linearMemory = (binary: any) => {
	const buf = binary?.wasmMemory?.buffer ?? binary?.HEAPU8?.buffer;
	return buf ? buf.byteLength : null;
};

const probeCodegen = () => {
	// minimal valid wasm module: magic + version
	const empty = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
	try {
		// the cast is the finding: @cloudflare/workers-types declares Module abstract BECAUSE
		// workerd refuses request-time codegen, and whether it does is what this probes
		new (WebAssembly.Module as any)(empty);
		return { allowed: true, error: null };
	} catch (e: any) {
		return { allowed: false, error: `${e?.message ?? e}` };
	}
};

const startupCodegen = probeCodegen();

/** an under-provisioned boot stalls instead of throwing, so every wait needs a deadline */
const withTimeout = (promise: Promise<unknown>, ms: number): Promise<TimedResult> =>
	Promise.race([
		promise.then(
			(v: unknown) => ({ ok: true, value: v }),
			(e: any) => ({ ok: false, error: `${e?.message ?? e}` })
		),
		new Promise<TimedResult>((r) =>
			setTimeout(() => r({ ok: false, error: `stalled >${ms}ms` }), ms)
		)
	]);

// #region startup instantiation
// this is the load-bearing experiment: build PHP during module evaluation,
// where codegen is still permitted, and keep it for the isolate's lifetime
const boot: BootReport = { ok: false, error: null, diag: [], ms: null, idleMemoryBytes: null };
let php: PhpWorkerd | null = null;
const output: any[] = [];

try {
	const t0 = Date.now();
	php = new PhpWorkerd({}, boot.diag);
	php.addEventListener('output', (e: any) => output.push(...[].concat(e.detail ?? [])));
	php.addEventListener('error', (e: any) => output.push(...[].concat(e.detail ?? [])));
	const binary = await php.binary;
	boot.ms = Date.now() - t0;
	boot.idleMemoryBytes = linearMemory(binary);
	boot.ok = true;
} catch (e: any) {
	boot.error = `${e?.stack ?? e}`;
}
// #endregion

// #region memory sweep
// how low can INITIAL_MEMORY go and still boot + execute? establishes whether
// the 128 MiB idle figure is a floor or just a build default
const memSweep: Record<string, unknown>[] = [];
for (const mib of [8, 16, 32, 64]) {
	const diag: string[] = [];
	const t0 = Date.now();
	try {
		const inst = new PhpWorkerd({ INITIAL_MEMORY: mib * 1024 * 1024 }, diag);
		const out: any[] = [];
		inst.addEventListener('output', (e: any) => out.push(...[].concat(e.detail ?? [])));

		const ready = await withTimeout(inst.binary, 10000);
		if (!ready.ok) {
			memSweep.push({ mib, booted: false, error: ready.error, diag });
			continue;
		}
		const ran = await withTimeout(inst._run('<?php echo PHP_VERSION;'), 10000);
		memSweep.push({
			mib,
			booted: true,
			ran: ran.ok && out.join('').includes('8.3'),
			runError: ran.ok ? null : ran.error,
			bootMs: Date.now() - t0,
			actualBytes: linearMemory(ready.value)
		});
	} catch (e: any) {
		memSweep.push({ mib, booted: false, error: `${e?.message ?? e}`, diag });
	}
}
// #endregion

/**
 * Materializes files into the emscripten FS from Static Assets.
 *
 * PHP's include is synchronous and demand-driven, but env.ASSETS.fetch() is
 * async, so files cannot be pulled lazily at include time without suspending the
 * whole VM. Everything therefore has to be resident before PHP runs, which is
 * exactly why the granular-vs-packed tradeoff below matters.
 */
async function mountGranular(binary: ProbeBinary, env: ProbeEnv, names: string[], concurrency = 6) {
	let bytes = 0;
	const queue = [...names];
	const workers = Array.from({ length: concurrency }, async () => {
		for (;;) {
			const name = queue.shift();
			if (!name) return;
			const res = await env.ASSETS.fetch(new URL(`https://assets.local/${name}`));
			const buf = new Uint8Array(await res.arrayBuffer());
			bytes += buf.length;
			binary.FS.writeFile(`/gen/${name.split('/').pop()}`, buf);
		}
	});
	await Promise.all(workers);
	return { bytes, fetches: names.length };
}

async function mountPacked(binary: ProbeBinary, env: ProbeEnv, count: number) {
	const [idxRes, binRes] = await Promise.all([
		env.ASSETS.fetch(new URL('https://assets.local/pack.json')),
		env.ASSETS.fetch(new URL('https://assets.local/pack.bin'))
	]);
	const index = await idxRes.json<PackSlice[]>();
	const blob = new Uint8Array(await binRes.arrayBuffer());

	let bytes = 0;
	for (const entry of index.slice(0, count)) {
		const slice = blob.subarray(entry.offset, entry.offset + entry.length);
		bytes += slice.length;
		binary.FS.writeFile(`/gen/${entry.name.split('/').pop()}`, slice);
	}
	return { bytes, fetches: 2 };
}

async function run(code: string): Promise<RunResult> {
	if (!boot.ok) return { error: 'php failed to boot', boot };
	output.length = 0;
	const t0 = Date.now();
	let error: string | null = null;
	try {
		await php!._run(code);
	} catch (e: any) {
		error = `${e?.stack ?? e}`;
	}
	const binary = await php!.binary;
	return {
		execMs: Date.now() - t0,
		error,
		memoryBytes: linearMemory(binary),
		stdout: output.join('')
	};
}

export default {
	async fetch(request: Request, env: ProbeEnv): Promise<Response> {
		const url = new URL(request.url);

		try {
			switch (url.pathname) {
				case '/boot':
					return Response.json({
						...boot,
						memSweep,
						startupCodegen,
						requestCodegen: probeCodegen()
					});

				case '/phpinfo': {
					const r = await run('<?php phpinfo();');
					return new Response(r.stdout || r.error || '(no output)', {
						headers: { 'content-type': 'text/plain; charset=utf-8' }
					});
				}

				case '/version':
					return Response.json(
						await run('<?php echo PHP_VERSION, " ", PHP_OS, " ", PHP_INT_SIZE;')
					);

				case '/extensions': {
					const r = await run('<?php echo implode(",", get_loaded_extensions());');
					return Response.json({
						...r,
						extensions: r.stdout!.split(',').filter(Boolean)
					});
				}

				case '/vfs': {
					// granular vs packed: the subrequest-count question, measured
					const mode = url.searchParams.get('mode') ?? 'granular';
					const n = Number(url.searchParams.get('n') ?? 200);
					const binary = (await php!.binary) as unknown as ProbeBinary;

					try {
						binary.FS.mkdir('/gen');
					} catch {
						// already there from a previous request; the FS persists
					}

					const names = Array.from({ length: n }, (_, i) => `lib/gen${i}.php`);

					const t0 = Date.now();
					const mounted =
						mode === 'packed'
							? await mountPacked(binary, env, n)
							: await mountGranular(
									binary,
									env,
									names,
									Number(url.searchParams.get('c') ?? 6)
								);
					const tMount = Date.now();

					// prove PHP can actually read what was mounted
					const r = await run(
						`<?php $t=0; for($i=0;$i<${n};$i++){ require_once "/gen/gen$i.php"; $t += constant("Gen$i::ID"); } echo $t;`
					);
					const tInclude = Date.now();

					return Response.json({
						mode,
						n,
						...mounted,
						mountMs: tMount - t0,
						includeMs: tInclude - tMount,
						totalMs: tInclude - t0,
						phpOutput: r.stdout,
						phpError: r.error,
						memoryBytes: linearMemory(binary)
					});
				}

				case '/drupal-mount': {
					// the real thing: Drupal's actual cold-bootstrap file set,
					// packed as one blob, mounted into the emscripten FS
					const binary = (await php!.binary) as unknown as ProbeBinary;
					const t0 = Date.now();

					const [idxRes, binRes] = await Promise.all([
						env.ASSETS.fetch(new URL('https://assets.local/drupal/core.json')),
						env.ASSETS.fetch(new URL('https://assets.local/drupal/core.bin'))
					]);
					const index = await idxRes.json<PackEntry[]>();
					const blob = new Uint8Array(await binRes.arrayBuffer());
					const tFetch = Date.now();

					const dirs = new Set<string>();
					let written = 0;
					let bytes = 0;
					for (const e of index) {
						const dir = '/drupal/' + e.p.split('/').slice(0, -1).join('/');
						if (!dirs.has(dir)) {
							// emscripten has no mkdir -p
							let cur = '';
							for (const seg of dir.split('/').filter(Boolean)) {
								cur += '/' + seg;
								try {
									binary.FS.mkdir(cur);
								} catch {
									// exists
								}
							}
							dirs.add(dir);
						}
						binary.FS.writeFile('/drupal/' + e.p, blob.subarray(e.o, e.o + e.l));
						written++;
						bytes += e.l;
					}
					const tWrite = Date.now();

					// prove PHP can read them back out of the mounted tree
					const probe = await run(
						`<?php $f='/drupal/${index[0]!.p}'; echo file_exists($f)?filesize($f):'MISSING';`
					);

					return Response.json({
						files: written,
						bytes,
						mb: +(bytes / 1048576).toFixed(2),
						dirs: dirs.size,
						fetchMs: tFetch - t0,
						writeMs: tWrite - tFetch,
						totalMs: tWrite - t0,
						subrequests: 2,
						probeFile: index[0]!.p,
						probeResult: probe.stdout,
						linearMemoryBytes: linearMemory(binary)
					});
				}

				case '/cpubench': {
					// mirrors what Drupal bootstrap actually does: string building,
					// array/hash churn, preg, object construction, serialization.
					// run the identical source natively to get a real wasm:native
					// ratio instead of guessing a multiplier.
					const n = Number(url.searchParams.get('n') ?? 200000);
					const r = await run(CPU_BENCH.replace('__N__', String(n)));
					return Response.json({ n, ...r });
				}

				case '/eval': {
					const code = url.searchParams.get('code') ?? '<?php echo 1;';
					return Response.json(await run(code));
				}

				default:
					return new Response(
						['/boot', '/phpinfo', '/version', '/extensions', '/eval?code=...'].join(
							'\n'
						),
						{ headers: { 'content-type': 'text/plain' } }
					);
			}
		} catch (e: any) {
			return new Response(`${e?.stack ?? e}`, { status: 500 });
		}
	}
};
