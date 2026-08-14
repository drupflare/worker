// must evaluate before the glue; see the file for why
import '@drupflare/cartridge/shim';

import { PhpBase, type PhpBaseModuleFactory, type PhpRuntimeArgs } from 'php-wasm/PhpBase';
import PHPFactory from '../../vendor/static-free/php8.3-worker.mjs';
import wasmModule from '../../vendor/static-free/php8.3-worker.mjs.wasm';
import { CPU_BENCH } from './cpu-bench';
import { DRUPAL_BOOT } from './drupal-boot';

/** the three MEMFS calls a mount makes; emscripten's FS is far wider than this */
interface ProbeFS {
	mkdir(path: string): void;
	writeFile(path: string, data: Uint8Array | string): void;
	utime(path: string, atime: number, mtime: number): void;
}

/**
 * The emscripten Module, as this worker uses it.
 *
 * php-wasm types `PhpBinaryRuntime.FS` as bare `object`, so the MEMFS calls are named here and
 * the one cast happens where `php.binary` resolves. `wasmMemory` and `HEAPU8` are read only to
 * price linear memory, and which one exists depends on how the build was linked.
 */
interface ProbeBinary {
	FS: ProbeFS;
	wasmMemory?: { buffer: ArrayBufferLike };
	HEAPU8?: { buffer: ArrayBufferLike };
}

/** the one binding this probe reads its pack through */
interface ProbeEnv {
	ASSETS: Fetcher;
}

/** one `core.json` entry: path, offset into the blob, length, mtime */
interface PackEntry {
	p: string;
	o: number;
	l: number;
	m?: number;
}

/** a booted interpreter and its buffers; `mounted` is this file's own flag, not php-wasm's */
interface PhpInstance {
	php: PhpStatic;
	out: any[];
	diag: string[];
	binary: ProbeBinary;
	bootMs: number;
	mounted?: boolean;
}

/** what the startup instantiation reported */
interface StartupReport {
	ok: boolean;
	error: string | null;
	diag: string[];
	bootMs: number | null;
	memory: number | null;
}

/** emscripten has no mkdir -p */
function mkdirp(FS: ProbeFS, path: string) {
	let cur = '';
	for (const seg of path.split('/').filter(Boolean)) {
		cur += '/' + seg;
		try {
			FS.mkdir(cur);
		} catch {
			// exists
		}
	}
}

/** mounts the packed Drupal tree, the database, and the writable dirs it needs */
async function mountDrupal(binary: ProbeBinary, env: ProbeEnv) {
	const t0 = Date.now();
	const [idxRes, binRes, dbRes] = await Promise.all([
		env.ASSETS.fetch(new URL('https://a.local/drupal/core.json')),
		env.ASSETS.fetch(new URL('https://a.local/drupal/core.bin.gz')),
		env.ASSETS.fetch(new URL('https://a.local/drupal/site.sqlite'))
	]);
	const index = await idxRes.json<PackEntry[]>();
	// the full tree is 33 MB raw, past the 25 MiB per-asset ceiling, so it ships
	// gzipped and inflates here
	const blob = new Uint8Array(
		await new Response(binRes.body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
	);
	const db = new Uint8Array(await dbRes.arrayBuffer());
	const tFetch = Date.now();

	const dirs = new Set<string>();
	let bytes = 0;
	for (const e of index) {
		if (e.p.startsWith('/')) continue; // absolute paths are the dump script itself
		const dir = '/drupal/' + e.p.split('/').slice(0, -1).join('/');
		if (!dirs.has(dir)) {
			mkdirp(binary.FS, dir);
			dirs.add(dir);
		}
		const full = '/drupal/' + e.p;
		binary.FS.writeFile(full, blob.subarray(e.o, e.o + e.l));
		// restore the original mtime: Drupal hashes filemtime() into compiled
		// Twig directory names, so write-time mtimes make it miss its own cache
		if (e.m) {
			try {
				binary.FS.utime(full, e.m, e.m);
			} catch {
				// some paths reject utime; not fatal
			}
		}
		bytes += e.l;
	}

	// database plus the directories Drupal writes into at runtime
	mkdirp(binary.FS, '/drupal/sites/default/files/php/twig');
	binary.FS.writeFile('/drupal/sites/default/files/.sqlite', db);

	return {
		files: index.length,
		bytes,
		dbBytes: db.length,
		fetchMs: tFetch - t0,
		writeMs: Date.now() - tFetch,
		subrequests: 3
	};
}

/**
 * The statically-linked build: MAIN_MODULE=0, extensions compiled in,
 * INITIAL_MEMORY=64MB, ENVIRONMENT=worker.
 *
 * The dylink build could only be instantiated during module evaluation, because
 * emscripten's dynamic linker synthesizes trampoline modules at runtime and
 * workerd forbids codegen outside startup. With no dylink section there should
 * be no runtime codegen at all -- which would mean this can be instantiated
 * inside a request handler, and the VM could be built and discarded per request.
 * That is what /request-boot tests.
 */
class PhpStatic extends PhpBase {
	/** the raw entry point php-wasm's published types omit; `run()` is a wrapper over it */
	declare _run: (code: string) => Promise<unknown>;

	constructor(args: PhpRuntimeArgs = {}, diag: string[] = []) {
		const t0 = Date.now();
		const note = (m: string) => diag.push(`+${Date.now() - t0}ms ${m}`);
		// php-wasm types the loader's `default` as a CONSTRUCTOR, while every real php-wasm build
		// exports an emscripten factory function; the cast is over that upstream mismatch
		super(
			Promise.resolve({ default: PHPFactory }) as unknown as Promise<PhpBaseModuleFactory>,
			{
				...args,
				printErr: (t: string) => note(`err: ${t}`),
				onAbort: (what: unknown) => note(`abort: ${what}`),
				instantiateWasm(
					imports: WebAssembly.Imports,
					receiveInstance: (
						instance: WebAssembly.Instance,
						module: WebAssembly.Module
					) => void
				) {
					note(`imports=${Object.keys(imports).join(',')}`);
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

const linearMemory = (b?: ProbeBinary | null) =>
	(b?.wasmMemory?.buffer ?? b?.HEAPU8?.buffer)?.byteLength ?? null;

async function build(): Promise<PhpInstance> {
	const diag: string[] = [];
	const out: any[] = [];
	const t0 = Date.now();
	const php = new PhpStatic({}, diag);
	php.addEventListener('output', (e: any) => out.push(...[].concat(e.detail ?? [])));
	php.addEventListener('error', (e: any) => out.push(...[].concat(e.detail ?? [])));
	const binary = (await php.binary) as unknown as ProbeBinary;
	return { php, out, diag, binary, bootMs: Date.now() - t0 };
}

/** stands in for Durable Object storage; the hit path must never touch wasm */
const pageCache = new Map<string, string>();

// startup instantiation, matching how the dylink build had to work
const startup: StartupReport = { ok: false, error: null, diag: [], bootMs: null, memory: null };
let warm: PhpInstance | null = null;
try {
	warm = await build();
	startup.ok = true;
	startup.diag = warm.diag;
	startup.bootMs = warm.bootMs;
	startup.memory = linearMemory(warm.binary);
} catch (e: any) {
	startup.error = `${e?.stack ?? e}`;
}

async function exec(inst: PhpInstance, code: string) {
	inst.out.length = 0;
	await inst.php._run(code);
	return inst.out.join('');
}

export default {
	async fetch(request: Request, env: ProbeEnv): Promise<Response> {
		const url = new URL(request.url);
		try {
			switch (url.pathname) {
				case '/boot':
					return Response.json(startup);

				case '/caps': {
					// Does workerd expose JSPI? It matters because PHP's outbound HTTP
					// is synchronous and fetch() is not. Asyncify can bridge that but
					// costs ~42% of the bundle. JSPI does the same thing natively, at
					// almost no size cost -- if the runtime supports it.
					const has = (o: any, k: string) => {
						try {
							return typeof o?.[k] !== 'undefined';
						} catch {
							return false;
						}
					};
					return Response.json({
						jspi: {
							Suspending: has(WebAssembly, 'Suspending'),
							promising: has(WebAssembly, 'promising'),
							SuspendError: has(WebAssembly, 'SuspendError')
						},
						streams: {
							DecompressionStream: typeof DecompressionStream !== 'undefined',
							CompressionStream: typeof CompressionStream !== 'undefined'
						},
						crypto: {
							subtle: typeof crypto !== 'undefined' && !!crypto.subtle,
							randomUUID: typeof crypto?.randomUUID === 'function'
						}
					});
				}

				case '/request-boot': {
					// the load-bearing experiment: can a fresh VM be built inside a
					// request now that nothing needs runtime codegen?
					const t0 = Date.now();
					try {
						const fresh = await build();
						const ver = await exec(fresh, '<?php echo PHP_VERSION;');
						return Response.json({
							ok: true,
							bootMs: fresh.bootMs,
							totalMs: Date.now() - t0,
							version: ver,
							memory: linearMemory(fresh.binary),
							diag: fresh.diag
						});
					} catch (e: any) {
						return Response.json({ ok: false, error: `${e?.message ?? e}` });
					}
				}

				case '/drupal': {
					// the whole point: a real Drupal request, in wasm, in workerd
					const fresh = url.searchParams.get('fresh') === '1';
					const inst = fresh ? await build() : warm!;
					// the tree survives in MEMFS between requests; remounting it would
					// hide the warm-path cost we are trying to measure
					const already = !fresh && inst.mounted;
					const mounted = already
						? { skipped: true, subrequests: 0 }
						: await mountDrupal(inst.binary, env);
					inst.mounted = true;

					const t0 = Date.now();
					const out = await exec(inst, DRUPAL_BOOT);
					const wallMs = Date.now() - t0;

					let php: any = null;
					try {
						php = JSON.parse(out.slice(out.indexOf('{')));
					} catch {
						php = { raw: out.slice(0, 1500) };
					}
					return Response.json({
						freshInstance: fresh,
						mount: mounted,
						wallMs,
						php,
						linearMemoryBytes: linearMemory(inst.binary)
					});
				}

				case '/page': {
					// The free-tier serving path.
					//
					// Anonymous Drupal responses are cacheable, so the Worker can hold
					// the rendered HTML and answer in JS without instantiating PHP at
					// all. In production this map is Durable Object storage; the point
					// of measuring it here is the cost of the hit path, which never
					// touches wasm.
					const key = url.pathname + url.search;
					const t0 = Date.now();

					const hit = pageCache.get(key);
					if (hit && url.searchParams.get('nocache') !== '1') {
						return new Response(hit, {
							headers: {
								'content-type': 'text/html; charset=utf-8',
								'x-cache': 'HIT',
								'x-cpu-ms': String(Date.now() - t0)
							}
						});
					}

					// miss: this is the expensive path, and the one free tier cannot
					// afford at 10 ms
					if (!warm!.mounted) {
						await mountDrupal(warm!.binary, env);
						warm!.mounted = true;
					}
					const out = await exec(warm!, DRUPAL_BOOT);
					let body = '';
					try {
						const parsed = JSON.parse(out.slice(out.indexOf('{')));
						body = `<!-- rendered by php-wasm, ${parsed.bytes} bytes, ${parsed.totalMs}ms -->`;
					} catch {
						body = '<!-- render failed -->';
					}
					pageCache.set(key, body);
					return new Response(body, {
						headers: {
							'content-type': 'text/html; charset=utf-8',
							'x-cache': 'MISS',
							'x-cpu-ms': String(Date.now() - t0)
						}
					});
				}

				case '/cpubench': {
					// identical source to the dylink worker and to bench-cpu.php,
					// so static-vs-dylink-vs-native is a like-for-like comparison
					const n = Number(url.searchParams.get('n') ?? 200000);
					const t0 = Date.now();
					const out = await exec(warm!, CPU_BENCH.replace('__N__', String(n)));
					return Response.json({
						n,
						execMs: Date.now() - t0,
						out,
						memory: linearMemory(warm!.binary)
					});
				}

				case '/extensions': {
					const s = await exec(
						warm!,
						'<?php echo implode(",", get_loaded_extensions());'
					);
					return Response.json({ extensions: s.split(',').filter(Boolean).sort() });
				}

				case '/version':
					return Response.json({
						out: await exec(
							warm!,
							'<?php echo PHP_VERSION, " ", PHP_OS, " int", PHP_INT_SIZE;'
						),
						memory: linearMemory(warm!.binary)
					});

				case '/eval':
					return Response.json({
						out: await exec(warm!, url.searchParams.get('code') ?? '<?php echo 1;'),
						memory: linearMemory(warm!.binary)
					});

				default:
					return new Response(
						['/boot', '/request-boot', '/extensions', '/version', '/eval?code='].join(
							'\n'
						)
					);
			}
		} catch (e: any) {
			return new Response(`${e?.stack ?? e}`, { status: 500 });
		}
	}
};
