// must evaluate before the glue; see the file for why
import '@drupflare/cartridge/shim';

import { PhpBase, type PhpBaseModuleFactory, type PhpRuntimeArgs } from 'php-wasm/PhpBase';
import PHPFactory from '../../vendor/static-cap/php8.3-worker.mjs';
import wasmModule from '../../vendor/static-cap/php8.3-worker.mjs.wasm';
import { CPU_BENCH } from './cpu-bench';
import { DRUPAL_BOOT, DRUPAL_EXERCISE, DRUPAL_PROFILE } from './drupal-boot';

/** the MEMFS calls this worker makes; emscripten's FS is far wider than this */
interface ProbeFS {
	mkdir(path: string): void;
	writeFile(path: string, data: Uint8Array | string): void;
	utime(path: string, atime: number, mtime: number): void;
	/** wrapped by /trace, which is how one trace covers every read path; `any` because the
	 *  argument types are emscripten's and the wrapper has to pass them straight through */
	open(path: any, flags?: any, mode?: any): any;
}

/**
 * The emscripten Module, as this worker uses it.
 *
 * php-wasm types `PhpBinaryRuntime.FS` as bare `object`, so the MEMFS surface is named here and
 * the one cast happens where `php.binary` resolves.
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

/** one `core.json` entry: path, offset into the pack, length, mtime */
interface PackEntry {
	p: string;
	o: number;
	l: number;
	m?: number;
}

/** a booted interpreter; everything after `bootMs` is this file's own bookkeeping */
interface PhpInstance {
	php: PhpStatic;
	out: any[];
	diag: string[];
	binary: ProbeBinary;
	bootMs: number;
	mounted?: boolean;
	traced?: boolean;
	traceSet?: Set<string>;
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

/**
 * Streaming mount: inflate the pack and write each file as its bytes arrive,
 * never holding the whole inflated tree.
 *
 * The naive version holds three copies at once -- the compressed blob, the
 * inflated buffer, and the MEMFS copies -- which peaks around 145-157 MB against
 * a 128 MB isolate cap. Here the resident set is one pending chunk plus the
 * unconsumed tail, so the peak is roughly one file (median ~8 KB).
 *
 * Requires the index to be ordered by offset, which the packer guarantees
 * because it appends sequentially.
 */
async function mountDrupalStreaming(binary: ProbeBinary, env: ProbeEnv) {
	const t0 = Date.now();
	const [idxRes, binRes, dbRes] = await Promise.all([
		env.ASSETS.fetch(new URL('https://a.local/drupal/core.json')),
		env.ASSETS.fetch(new URL('https://a.local/drupal/core.bin.gz')),
		env.ASSETS.fetch(new URL('https://a.local/drupal/site.sqlite'))
	]);
	const index = await idxRes.json<PackEntry[]>();
	const tFetch = Date.now();

	const reader = binRes.body!.pipeThrough(new DecompressionStream('gzip')).getReader();
	const dirs = new Set<string>();

	let carry = new Uint8Array(0);
	let base = 0; // absolute offset of carry[0] within the inflated stream
	let bytes = 0;
	let peakCarry = 0;
	let done = false;

	for (const e of index) {
		if (e.p.startsWith('/')) continue;
		const need = e.o + e.l;
		while (!done && base + carry.length < need) {
			const r = await reader.read();
			if (r.done) {
				done = true;
				break;
			}
			const next = new Uint8Array(carry.length + r.value.length);
			next.set(carry);
			next.set(r.value, carry.length);
			carry = next;
			if (carry.length > peakCarry) peakCarry = carry.length;
		}

		const start = e.o - base;
		if (start < 0 || start + e.l > carry.length) continue; // stream ended short

		const dir = '/drupal/' + e.p.split('/').slice(0, -1).join('/');
		if (!dirs.has(dir)) {
			mkdirp(binary.FS, dir);
			dirs.add(dir);
		}
		const full = '/drupal/' + e.p;
		binary.FS.writeFile(full, carry.subarray(start, start + e.l));
		if (e.m) {
			try {
				binary.FS.utime(full, e.m, e.m);
			} catch {
				/* not fatal */
			}
		}
		bytes += e.l;

		// release everything consumed so far; this is what keeps the peak flat
		const consumed = need - base;
		carry = carry.slice(consumed);
		base = need;
	}

	const db = new Uint8Array(await dbRes.arrayBuffer());
	mkdirp(binary.FS, '/drupal/sites/default/files/php/twig');
	binary.FS.writeFile('/drupal/sites/default/files/.sqlite', db);

	return {
		mode: 'streaming',
		files: index.length,
		bytes,
		dbBytes: db.length,
		peakCarryBytes: peakCarry,
		fetchMs: tFetch - t0,
		writeMs: Date.now() - tFetch,
		subrequests: 3
	};
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
				// vrzno_env($name) resolves to Module[$name], so anything hung on the
				// Module object is reachable from PHP. This is the capability seam: the
				// Worker's env (DO namespace, R2, KV) and host helpers go here.
				cfProbe: 'php-to-js-ok',
				cfHost: {
					now: () => Date.now(),
					echo: (s: string) => `echo:${s}`,
					// returns a promise: the shape a fetch()-backed capability has
					later: (s: string) => Promise.resolve(`later:${s}`)
				},
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
					const streaming = url.searchParams.get('stream') !== '0';
					const mounted = already
						? { skipped: true, subrequests: 0 }
						: streaming
							? await mountDrupalStreaming(inst.binary, env)
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

				case '/vrzno': {
					// Can PHP reach JS? This is the whole capability API in one probe:
					// if PHP can call a host function, the database driver and the
					// Guzzle handler are both userland PHP from here on.
					const probe = `<?php
$out = [];
$out['funcs'] = get_extension_funcs('vrzno') ?: [];
$classes = [];
foreach (get_declared_classes() as $c) {
  if (stripos($c, 'vrzno') !== false) { $classes[] = $c; }
}
$out['classes'] = $classes;
$out['loaded'] = extension_loaded('vrzno');

// vrzno_eval() is deliberately NOT called: it uses JS eval() internally and
// workerd answers with "Code generation from strings disallowed", the same
// prohibition that blocks runtime wasm codegen. The eval half of vrzno is
// unusable here.
//
// What matters is whether the direct-access half works, because that is what a
// database driver or HTTP handler would use.
// vrzno_env(name) === Module[name]
try {
  $probe = vrzno_env('cfProbe');
  $out['probe'] = $probe;
  $out['probe_type'] = gettype($probe);
} catch (\\Throwable $e) { $out['probe_err'] = get_class($e) . ': ' . $e->getMessage(); }

// can PHP call a JS function on a host object? this is the whole capability API
try {
  $host = vrzno_env('cfHost');
  $out['host_type'] = gettype($host);
  $out['host_class'] = is_object($host) ? get_class($host) : null;
  if (is_object($host)) {
    $out['host_echo'] = $host->echo('drupal');
    $out['host_now'] = $host->now();
  }
} catch (\\Throwable $e) { $out['host_err'] = get_class($e) . ': ' . $e->getMessage(); }

// Can PHP block on a JS promise? This is what an outbound-HTTP capability
// needs, and it requires a suspension mechanism (Asyncify or JSPI). This build
// has neither, so the expected answer is "no" -- recorded rather than assumed.
try {
  $host = vrzno_env('cfHost');
  $p = $host->later('x');
  $out['promise_type'] = gettype($p);
  $out['promise_class'] = is_object($p) ? get_class($p) : null;
  $out['awaited'] = vrzno_await($p);
} catch (\\Throwable $e) { $out['await_err'] = get_class($e) . ': ' . $e->getMessage(); }

echo json_encode($out);
`;
					const raw = await exec(warm!, probe);
					let parsed: any = null;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 600) };
					}
					return Response.json(parsed);
				}

				case '/trace': {
					// The general mechanism.
					//
					// get_included_files() only sees `include`. Drupal also reads through
					// file_get_contents (services/routing/schema yml), ExtensionDiscovery
					// (*.info.yml), module_load_include (.install/.post_update.php) and
					// Twig's loader. Chasing those one fatal at a time is endless.
					//
					// Wrapping emscripten's FS.open records every path the runtime opens
					// by any route, so one trace covers all of them. Mount the whole tree
					// first, then pack only what this reports.
					const inst = warm!;
					if (!inst.mounted) {
						await mountDrupalStreaming(inst.binary, env);
						inst.mounted = true;
					}

					const FS = inst.binary.FS;
					if (!inst.traced) {
						const seen = new Set<string>();
						const origOpen = FS.open.bind(FS);
						FS.open = function (path: any, flags: any, mode: any) {
							try {
								if (typeof path === 'string') seen.add(path);
							} catch {
								/* never break the FS */
							}
							return origOpen(path, flags, mode);
						};
						inst.traceSet = seen;
						inst.traced = true;
					}
					inst.traceSet!.clear();

					await exec(inst, DRUPAL_BOOT);
					await exec(inst, DRUPAL_EXERCISE);

					const files = [...inst.traceSet!]
						.filter((p) => p.startsWith('/drupal/'))
						.map((p) => p.slice('/drupal/'.length))
						.sort();

					return Response.json({ fileCount: files.length, files });
				}

				case '/profile': {
					// boot, drive several routes, then report exactly which files the
					// target runtime touched -- the input to a correct minimal pack
					const inst = warm!;
					if (!inst.mounted) {
						await mountDrupal(inst.binary, env);
						inst.mounted = true;
					}
					await exec(inst, DRUPAL_BOOT);
					const routes = await exec(inst, DRUPAL_EXERCISE);
					const listRaw = await exec(inst, DRUPAL_PROFILE);

					let files: any[] = [];
					try {
						files = JSON.parse(listRaw.slice(listRaw.indexOf('[')));
					} catch {
						/* fall through with empty */
					}
					let routeInfo: any = null;
					try {
						routeInfo = JSON.parse(routes.slice(routes.indexOf('{')));
					} catch {
						/* ignore */
					}

					return Response.json({
						fileCount: files.length,
						routes: routeInfo,
						files
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
