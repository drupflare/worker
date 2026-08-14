/**
 * One worker body shared by every build variant, so the variants differ only in
 * which vendor directory they import. Routes: /boot /version /extensions
 * /cpubench /mb2 /iconv.
 *
 * /cpubench is deliberately identical in shape to src/o2.js so its number is
 * comparable to the recorded 648 ms (-O2) / 674 ms (-Oz) figures.
 */
import { PhpBase, type PhpBaseModuleFactory, type PhpRuntimeArgs } from 'php-wasm/PhpBase';
import { CPU_BENCH } from './cpu-bench';
import { MB_PROBE2 } from './mb-probe2';

/** the three MEMFS calls a mount makes; emscripten's FS is far wider than this */
interface ProbeFS {
	mkdir(path: string): void;
	writeFile(path: string, data: Uint8Array | string): void;
	utime(path: string, atime: number, mtime: number): void;
}

/**
 * The emscripten Module, as this worker uses it.
 *
 * `wasmMemory` and `HEAPU8` are read only to price linear memory, and either one may be absent
 * depending on how the build was linked -- which is why `linearMemory()` tries both. The index
 * signature is what lets a variant route reach a `_zend_wasm_slice_*` export this file does not
 * name.
 */
interface ProbeBinary {
	FS: ProbeFS;
	wasmMemory?: { buffer: ArrayBufferLike };
	HEAPU8?: { buffer: ArrayBufferLike };
	/** the emscripten helpers and the pib entry point; php-wasm's own `PhpBinaryRuntime` names
	 *  the same five, and a variant route (src/probes/jspi-routes.ts) calls them directly */
	lengthBytesUTF8(s: string): number;
	_malloc(bytes: number): number;
	stringToUTF8(s: string, ptr: number, maxBytes: number): void;
	_free(ptr: number): void;
	_pib_run(ptr: number): any;
	[key: string]: any;
}

/** the one binding every probe config declares: the packed Drupal tree */
interface ProbeEnv {
	ASSETS: Fetcher;
}

/** one `core.json` entry: path, offset into the inflated stream, length, mtime */
interface PackEntry {
	p: string;
	o: number;
	l: number;
	m?: number;
}

/** a booted interpreter and the output buffer its events fill */
interface ProbeInstance {
	php: PhpStaticLike;
	out: any[];
	diag: string[];
	binary: ProbeBinary;
	bootMs: number;
}

/** the interpreter as the route bodies use it; `_run` is the entry point php-wasm's types omit */
interface PhpStaticLike extends PhpBase {
	_run(code: string): Promise<unknown>;
}

/** what a variant route module receives, and what it returns */
interface ProbeRouteContext {
	label: string;
	build: () => Promise<ProbeInstance>;
	exec: (inst: ProbeInstance, code: string) => Promise<string>;
	linearMemory: (b?: ProbeBinary | null) => number | null;
	warmed: () => ProbeInstance | null;
}

type ProbeRoute = (args: {
	url: URL;
	env: ProbeEnv;
	warm: ProbeInstance;
}) => Response | Promise<Response>;

/** what one build variant hands this factory */
interface ProbeWorkerOptions {
	wasmModule: WebAssembly.Module;
	PHPFactory: (moduleArg?: object) => Promise<any>;
	label: string;
	routes?: (ctx: ProbeRouteContext) => Record<string, ProbeRoute>;
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

/** streaming mount, copied from src/o2.js so the peak stays one pending chunk */
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
	let base = 0;
	let bytes = 0;
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
		}

		const start = e.o - base;
		if (start < 0 || start + e.l > carry.length) continue;

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
				// some paths reject utime; not fatal
			}
		}
		bytes += e.l;

		const consumed = need - base;
		carry = carry.slice(consumed);
		base = need;
	}

	const db = new Uint8Array(await dbRes.arrayBuffer());
	mkdirp(binary.FS, '/drupal/sites/default/files/php/twig');
	binary.FS.writeFile('/drupal/sites/default/files/.sqlite', db);

	return {
		files: index.length,
		bytes,
		dbBytes: db.length,
		fetchMs: tFetch - t0,
		writeMs: Date.now() - tFetch
	};
}

const linearMemory = (b?: ProbeBinary | null) =>
	(b?.wasmMemory?.buffer ?? b?.HEAPU8?.buffer)?.byteLength ?? null;

export function makeProbeWorker({ wasmModule, PHPFactory, label, routes }: ProbeWorkerOptions) {
	class PhpStatic extends PhpBase {
		/** the raw entry point php-wasm's published types omit; `run()` is a wrapper over it */
		declare _run: (code: string) => Promise<unknown>;

		constructor(args: PhpRuntimeArgs = {}, diag: string[] = []) {
			const t0 = Date.now();
			const note = (m: string) => diag.push(`+${Date.now() - t0}ms ${m}`);
			// php-wasm types the loader's `default` as a CONSTRUCTOR, while every real php-wasm
			// build exports an emscripten factory function; the cast is over that upstream
			// mismatch, as in src/site-do.ts
			super(
				Promise.resolve({
					default: PHPFactory
				}) as unknown as Promise<PhpBaseModuleFactory>,
				{
					...args,
					// same ini as src/o2.js, so opcache state cannot explain a delta
					ini: [
						'opcache.enable=1',
						'opcache.enable_cli=1',
						'opcache.file_cache=/tmp/opcache',
						'opcache.file_cache_only=1',
						'opcache.validate_timestamps=0',
						'opcache.file_cache_consistency_checks=0',
						'opcache.max_accelerated_files=20011',
						'opcache.optimization_level=0x7FFEBFFF'
					].join('\n'),
					cfProbe: 'php-to-js-ok',
					cfHost: { now: () => Date.now(), echo: (s: string) => `echo:${s}` },
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
								receiveInstance(instance, wasmModule);
								note('instantiated');
							})
							.catch((e: any) => note(`FAILED: ${e?.message ?? e}`));
						return {};
					}
				}
			);
		}
	}

	async function build(): Promise<ProbeInstance> {
		const diag: string[] = [];
		const out: any[] = [];
		const t0 = Date.now();
		const php = new PhpStatic({}, diag);
		php.addEventListener('output', (e: any) => out.push(...[].concat(e.detail ?? [])));
		php.addEventListener('error', (e: any) => out.push(...[].concat(e.detail ?? [])));
		const binary = (await php.binary) as unknown as ProbeBinary;
		return { php, out, diag, binary, bootMs: Date.now() - t0 };
	}

	async function exec(inst: ProbeInstance, code: string) {
		inst.out.length = 0;
		await inst.php._run(code);
		return inst.out.join('');
	}

	const startup: {
		label: string;
		ok: boolean;
		error: string | null;
		diag: string[];
		bootMs: number | null;
		memory: number | null;
	} = {
		label,
		ok: false,
		error: null,
		diag: [],
		bootMs: null,
		memory: null
	};
	let warm: ProbeInstance | null = null;

	// variant-specific routes get the same warm instance and helpers, so a JSPI
	// number and a /cpubench number come off one build in one process
	const extra = routes ? routes({ label, build, exec, linearMemory, warmed: () => warm }) : {};

	return {
		async fetch(request: Request, env: ProbeEnv): Promise<Response> {
			const url = new URL(request.url);
			try {
				if (!warm && !startup.error) {
					try {
						warm = await build();
						startup.ok = true;
						startup.diag = warm.diag;
						startup.bootMs = warm.bootMs;
						startup.memory = linearMemory(warm.binary);
					} catch (e: any) {
						startup.error = `${e?.stack ?? e}`;
					}
				}

				switch (url.pathname) {
					case '/boot':
						return Response.json(startup);

					case '/version':
						return Response.json({
							label,
							out: await exec(
								warm!,
								'<?php echo PHP_VERSION, " ", PHP_OS, " int", PHP_INT_SIZE;'
							),
							memory: linearMemory(warm!.binary)
						});

					case '/extensions': {
						const s = await exec(
							warm!,
							'<?php echo implode(",", get_loaded_extensions());'
						);
						const z = await exec(
							warm!,
							'<?php echo implode(",", get_loaded_extensions(true));'
						);
						return Response.json({
							label,
							extensions: s.split(',').filter(Boolean).sort(),
							zendExtensions: z.split(',').filter(Boolean).sort()
						});
					}

					case '/iconv': {
						// the direct evidence for lever 1: is the real extension present,
						// and does iconv_substr substitute instead of returning false
						const raw = await exec(
							warm!,
							`<?php
$f = function () {
  $bad = "abc\\xff\\xfedef";
  return json_encode([
    'ext_iconv' => extension_loaded('iconv'),
    'ext_mbstring' => extension_loaded('mbstring'),
    'has_iconv_substr' => function_exists('iconv_substr'),
    'iconv_substr_internal' => function_exists('iconv_substr')
      ? (new ReflectionFunction('iconv_substr'))->isInternal() : null,
    'iconv_substr_bad' => function_exists('iconv_substr')
      ? bin2hex((string) @iconv_substr($bad, 0, 100, 'UTF-8')) : null,
    'iconv_strlen_bad' => function_exists('iconv_strlen') ? @iconv_strlen($bad, 'UTF-8') : null,
    'iconv_impl' => defined('ICONV_IMPL') ? ICONV_IMPL : null,
    'iconv_version' => defined('ICONV_VERSION') ? ICONV_VERSION : null,
  ]);
};
echo $f();`
						);
						let parsed: any;
						try {
							parsed = JSON.parse(raw.slice(raw.indexOf('{')));
						} catch {
							parsed = { raw: raw.slice(0, 600) };
						}
						return Response.json({ label, ...parsed });
					}

					case '/mb2': {
						// fresh instance: the polyfill registration must happen once, on a
						// tree mounted the way a real request mounts it
						const inst = await build();
						const mountInfo = await mountDrupalStreaming(inst.binary, env);
						const raw = await exec(inst, MB_PROBE2);
						return new Response(raw, {
							headers: {
								'content-type': 'application/json',
								'x-mount-files': String(mountInfo.files),
								'x-build': label
							}
						});
					}

					case '/cpubench': {
						const n = Number(url.searchParams.get('n') ?? 200000);
						const t0 = Date.now();
						const out = await exec(warm!, CPU_BENCH.replace('__N__', String(n)));
						return Response.json({
							label,
							n,
							execMs: Date.now() - t0,
							out,
							memory: linearMemory(warm!.binary)
						});
					}

					default: {
						const handler = extra[url.pathname];
						if (handler) return await handler({ url, env, warm: warm! });
						return new Response(
							[
								'/boot',
								'/version',
								'/extensions',
								'/iconv',
								'/mb2',
								'/cpubench?n=',
								...Object.keys(extra)
							].join('\n'),
							{ status: 404 }
						);
					}
				}
			} catch (e: any) {
				return new Response(`${e?.stack ?? e}`, { status: 500 });
			}
		}
	};
}
