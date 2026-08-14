// must evaluate before the glue; see worker-shim.js for why
import '@drupflare/cartridge/shim';

import { PhpBase, type PhpBaseModuleFactory } from 'php-wasm/PhpBase';
import PHPFactory from '../../vendor/static-free-v1/php8.3-worker.mjs';
import wasmModule from '../../vendor/static-free-v1/php8.3-worker.mjs.wasm';

/** the three MEMFS calls a mount makes; emscripten's FS is far wider than this */
interface ProbeFS {
	mkdir(path: string): void;
	writeFile(path: string, data: Uint8Array | string): void;
	utime(path: string, atime: number, mtime: number): void;
}

/**
 * The emscripten Module, as this worker uses it.
 *
 * The index signature is load-bearing here rather than lazy: /malloc-mem reaches for the malloc
 * export under three different spellings (`_malloc`, `wasmExports.malloc`, `asm.malloc`) because
 * which one exists depends on how the build was linked, and finding out is the probe.
 */
interface ProbeBinary {
	FS: ProbeFS;
	wasmMemory?: { buffer: ArrayBufferLike };
	HEAPU8?: Uint8Array;
	[key: string]: any;
}

/** the one binding this probe reads its pack through */
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
interface PhpInstance {
	php: PhpStatic;
	out: any[];
	diag: string[];
	binary: ProbeBinary;
	bootMs: number;
}

/** what a mount reported; taken from the mount itself so the two cannot drift */
type MountInfo = Awaited<ReturnType<typeof mountDrupalStreaming>>;

/** one NDJSON record; every route emits its own free-form shape */
type Emit = (obj: Record<string, unknown>) => Promise<void>;

/** where a handler parks its diag so a throw can still report stderr */
interface DiagRef {
	diag: string[] | null;
}

/** the non-standard Chrome heap counters, absent from the TS lib and probably from workerd */
type PerfWithMemory = typeof performance & {
	memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
};

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

/** copied from prof.js; streaming mount keeps the inflate peak flat */
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
				/* not fatal */
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
		treeBytes: bytes,
		dbBytes: db.length,
		fetchMs: tFetch - t0,
		writeMs: Date.now() - tFetch
	};
}

/** static build, same shape as prof.js; memory_limit is the knob under test */
class PhpStatic extends PhpBase {
	/** the raw entry point php-wasm's published types omit; `run()` is a wrapper over it */
	declare _run: (code: string) => Promise<unknown>;

	constructor(memoryLimit: string, diag: string[] = []) {
		const t0 = Date.now();
		const note = (m: string) => diag.push(`+${Date.now() - t0}ms ${m}`);
		// php-wasm types the loader's `default` as a CONSTRUCTOR, while every real php-wasm build
		// exports an emscripten factory function; the cast is over that upstream mismatch
		super(
			Promise.resolve({ default: PHPFactory }) as unknown as Promise<PhpBaseModuleFactory>,
			{
				ini: [
					'opcache.enable=0',
					'opcache.enable_cli=0',
					`memory_limit=${memoryLimit}`
				].join('\n'),
				printErr: (t: string) => note(`err: ${t}`),
				onAbort: (what: unknown) => note(`abort: ${what}`),
				instantiateWasm(
					imports: WebAssembly.Imports,
					receiveInstance: (
						instance: WebAssembly.Instance,
						module: WebAssembly.Module
					) => void
				) {
					WebAssembly.instantiate(wasmModule, imports)
						.then((instance) => {
							receiveInstance(instance, wasmModule);
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

async function build(memoryLimit = '-1'): Promise<PhpInstance> {
	const diag: string[] = [];
	const out: any[] = [];
	const t0 = Date.now();
	const php = new PhpStatic(memoryLimit, diag);
	php.addEventListener('output', (e: any) => out.push(...[].concat(e.detail ?? [])));
	php.addEventListener('error', (e: any) => out.push(...[].concat(e.detail ?? [])));
	const binary = (await php.binary) as unknown as ProbeBinary;
	return { php, out, diag, binary, bootMs: Date.now() - t0 };
}

async function exec(inst: PhpInstance, code: string) {
	inst.out.length = 0;
	await inst.php._run(code);
	return inst.out.join('');
}

/**
 * NDJSON streamed step-by-step, so the record of every surviving step is already
 * on the wire when the isolate dies. A death here is silent: the stream simply
 * stops, which is why nothing is buffered.
 */
function ndjson(handler: (emit: Emit, ref: DiagRef) => Promise<void>) {
	const { readable, writable } = new TransformStream();
	const w = writable.getWriter();
	const enc = new TextEncoder();
	const emit = async (obj: Record<string, unknown>) => {
		const line = JSON.stringify(obj);
		console.warn('MEMTEST ' + line);
		await w.write(enc.encode(line + '\n'));
	};
	// handler parks its instance here so a thrown error can still report stderr
	const ref: DiagRef = { diag: null };
	(async () => {
		try {
			await handler(emit, ref);
		} catch (e: any) {
			try {
				await emit({
					fatal: `${e?.name ?? 'Error'}: ${e?.message ?? e}`,
					status: e?.status ?? null,
					stderrTail: ref.diag ? ref.diag.slice(-12) : null
				});
			} catch {
				/* stream already gone */
			}
		}
		try {
			await w.close();
		} catch {
			/* already closed */
		}
	})();
	return new Response(readable, {
		headers: {
			'content-type': 'application/x-ndjson',
			'cache-control': 'no-store'
		}
	});
}

const MB = 1024 * 1024;

export default {
	async fetch(request: Request, env: ProbeEnv): Promise<Response> {
		const url = new URL(request.url);
		const q = url.searchParams;
		const num = (k: string, d: number) => {
			const v = Number(q.get(k));
			return Number.isFinite(v) && v > 0 ? v : d;
		};

		try {
			switch (url.pathname) {
				case '/info': {
					const inst = await build(q.get('limit') ?? '-1');
					const phpInfo = await exec(
						inst,
						`<?php echo json_encode([
              'version' => PHP_VERSION,
              'memory_limit' => ini_get('memory_limit'),
              'int_size' => PHP_INT_SIZE,
              'usage_real' => memory_get_usage(true),
              'usage' => memory_get_usage(false),
            ]);`
					);
					const probe = (fn: () => unknown) => {
						try {
							return fn();
						} catch (e: any) {
							return `ERR ${e?.message ?? e}`;
						}
					};
					return Response.json({
						php: JSON.parse(phpInfo),
						bootMs: inst.bootMs,
						linearMemoryBytes: linearMemory(inst.binary),
						// getHeapMax() in the glue is the hard build-time wasm ceiling
						heapMaxFromGlue: 536870912,
						hostProbes: {
							processMemoryUsage: probe(() =>
								typeof process !== 'undefined' &&
								typeof process.memoryUsage === 'function'
									? process.memoryUsage()
									: null
							),
							performanceMemory: probe(() =>
								typeof performance !== 'undefined' &&
								(performance as PerfWithMemory).memory
									? {
											used: (performance as PerfWithMemory).memory!
												.usedJSHeapSize,
											total: (performance as PerfWithMemory).memory!
												.totalJSHeapSize,
											limit: (performance as PerfWithMemory).memory!
												.jsHeapSizeLimit
										}
									: null
							)
						}
					});
				}

				// which PHP state survives a _run boundary? decides how A.1 can be driven
				case '/persist': {
					const inst = await build('-1');
					const probe = `<?php
            $out = [];
            $out['globals_before'] = isset($GLOBALS['keep']) ? count($GLOBALS['keep']) : 'unset';
            $GLOBALS['keep'][] = 1;
            $out['globals_after'] = count($GLOBALS['keep']);

            $out['func_defined'] = function_exists('keepFn');
            if (!function_exists('keepFn')) {
              eval('function keepFn() { static $k = []; $k[] = 1; return count($k); }');
            }
            $out['func_count'] = keepFn();

            $out['class_defined'] = class_exists('KeepCls', false);
            if (!class_exists('KeepCls', false)) {
              eval('class KeepCls { public static array $k = []; }');
            }
            KeepCls::$k[] = 1;
            $out['class_count'] = count(KeepCls::$k);

            $out['const_defined'] = defined('KEEP_MARK');
            if (!defined('KEEP_MARK')) define('KEEP_MARK', 1);

            echo json_encode($out);`;
					const runs: string[] = [];
					for (let i = 0; i < 3; i++) runs.push(await exec(inst, probe));
					return Response.json({ runs: runs.map((r) => JSON.parse(r.trim())) });
				}

				/**
				 * A.1 control: grow the wasm arena straight from JS with _malloc, one
				 * step per event-loop turn. Nothing is freed, so this is a pure staircase
				 * against whatever ceiling the runtime enforces, with every surviving
				 * step already flushed when the isolate dies.
				 */
				case '/malloc-mem': {
					const stepMb = num('step', 5);
					const maxMb = num('max', 1024);
					const mount = q.get('mount') === '1';
					return ndjson(async (emit, ref) => {
						const t0 = Date.now();
						const inst = await build('-1');
						ref.diag = inst.diag;
						let mountInfo: MountInfo | null = null;
						if (mount) mountInfo = await mountDrupalStreaming(inst.binary, env);
						const malloc =
							inst.binary._malloc ??
							inst.binary.wasmExports?.malloc ??
							inst.binary.asm?.malloc;
						await emit({
							phase: 'baseline',
							driver: 'js _malloc',
							stepMb,
							maxMb,
							mounted: mount,
							mountInfo,
							mallocAvailable: typeof malloc === 'function',
							bootMs: inst.bootMs,
							linearMemoryBytes: linearMemory(inst.binary),
							elapsedMs: Date.now() - t0
						});
						if (typeof malloc !== 'function') {
							await emit({ fatal: 'no malloc export reachable from JS' });
							return;
						}
						const ptrs: number[] = [];
						const steps = Math.ceil(maxMb / stepMb);
						for (let i = 1; i <= steps; i++) {
							const before = linearMemory(inst.binary);
							const p = malloc(stepMb * MB);
							ptrs.push(p);
							// touch every page so the allocation is real, not just reserved
							if (p) {
								const h = inst.binary.HEAPU8;
								for (let o = 0; o < stepMb * MB; o += 4096) h![p + o] = 1;
							}
							await emit({
								step: i,
								requestedCumulativeMb: i * stepMb,
								ptr: p,
								mallocFailed: p === 0,
								linearBeforeBytes: before,
								linearAfterBytes: linearMemory(inst.binary),
								elapsedMs: Date.now() - t0
							});
							if (p === 0) {
								await emit({
									phase: 'malloc-returned-null',
									atStep: i,
									requestedCumulativeMb: i * stepMb,
									linearMemoryBytes: linearMemory(inst.binary)
								});
								return;
							}
						}
						await emit({ phase: 'completed-without-failure', maxMb });
					});
				}

				/**
				 * A.1 proper: one PHP run holding N x stepMb PHP strings live in a single
				 * scope. All-or-nothing by construction -- output only reaches JS if the
				 * run returns -- so the ceiling is found by walking `mb` upward across
				 * independent requests.
				 */
				case '/php-alloc': {
					const mb = num('mb', 100);
					const stepMb = num('step', 5);
					const limit = q.get('limit') ?? '-1';
					const mount = q.get('mount') === '1';
					const t0 = Date.now();
					const inst = await build(limit);
					let mountInfo = null;
					if (mount) mountInfo = await mountDrupalStreaming(inst.binary, env);
					const baseline = linearMemory(inst.binary);
					const raw = await exec(
						inst,
						`<?php
            $f = function (int $bytes, int $blocks): string {
              $keep = [];
              $trace = [];
              for ($i = 1; $i <= $blocks; $i++) {
                $keep[] = str_repeat('x', $bytes);
                $trace[] = $i * $bytes;
              }
              return json_encode([
                'blocks' => count($keep),
                'liveBytes' => array_sum(array_map('strlen', $keep)),
                'usage_real' => memory_get_usage(true),
                'usage' => memory_get_usage(false),
                'peak_real' => memory_get_peak_usage(true),
              ]);
            };
            echo $f(${stepMb * MB}, ${Math.round(mb / stepMb)});`
					);
					let php = null;
					try {
						php = JSON.parse(raw.trim());
					} catch {
						php = { rawOutput: raw.slice(0, 800) };
					}
					return Response.json({
						requestedMb: mb,
						stepMb,
						blocksRequested: Math.round(mb / stepMb),
						memoryLimitIni: limit,
						mounted: mount,
						mountInfo,
						php,
						linearBaselineBytes: baseline,
						linearAfterBytes: linearMemory(inst.binary),
						elapsedMs: Date.now() - t0,
						diag: inst.diag.slice(-6)
					});
				}

				// TASK A.1 -- grow PHP linear memory in steps until something dies
				case '/php-mem': {
					const stepMb = num('step', 5);
					const maxMb = num('max', 1024);
					const limit = q.get('limit') ?? '-1';
					const mount = q.get('mount') === '1';
					return ndjson(async (emit, ref) => {
						const t0 = Date.now();
						const inst = await build(limit);
						ref.diag = inst.diag;
						let mountInfo = null;
						if (mount) mountInfo = await mountDrupalStreaming(inst.binary, env);
						await emit({
							phase: 'baseline',
							stepMb,
							maxMb,
							memoryLimitIni: limit,
							mounted: mount,
							mountInfo,
							bootMs: inst.bootMs,
							linearMemoryBytes: linearMemory(inst.binary),
							elapsedMs: Date.now() - t0
						});

						const steps = Math.ceil(maxMb / stepMb);
						for (let i = 1; i <= steps; i++) {
							const before = linearMemory(inst.binary);
							// allocate inside a closure (project rule) but park the string in
							// $GLOBALS, which /persist proves survives the _run boundary --
							// a closure static does not, because the closure is re-created
							const raw = await exec(
								inst,
								`<?php
                $f = function (int $bytes): string {
                  $GLOBALS['keep'][] = str_repeat('x', $bytes);
                  return json_encode([
                    'blocks' => count($GLOBALS['keep']),
                    'liveBytes' => array_sum(array_map('strlen', $GLOBALS['keep'])),
                    'usage_real' => memory_get_usage(true),
                    'usage' => memory_get_usage(false),
                    'peak_real' => memory_get_peak_usage(true),
                  ]);
                };
                echo $f(${stepMb * MB});`
							);
							let php = null;
							try {
								php = JSON.parse(raw.trim());
							} catch {
								php = { rawOutput: raw.slice(0, 400) };
							}
							await emit({
								step: i,
								requestedCumulativeMb: i * stepMb,
								php,
								linearBeforeBytes: before,
								linearAfterBytes: linearMemory(inst.binary),
								elapsedMs: Date.now() - t0
							});
							if (php && php.rawOutput !== undefined) {
								await emit({
									phase: 'php-side-failure',
									atStep: i,
									requestedCumulativeMb: i * stepMb
								});
								return;
							}
						}
						await emit({ phase: 'completed-without-failure', maxMb });
					});
				}

				// TASK A.2 -- grow the MEMFS tree in steps until something dies
				case '/fs-mem': {
					const stepMb = num('step', 5);
					const maxMb = num('max', 1024);
					const fileKb = num('filekb', 1024);
					const mount = q.get('mount') === '1';
					return ndjson(async (emit, ref) => {
						const t0 = Date.now();
						const inst = await build('-1');
						ref.diag = inst.diag;
						const FS = inst.binary.FS;
						let mountInfo = null;
						if (mount) mountInfo = await mountDrupalStreaming(inst.binary, env);
						mkdirp(FS, '/memfs');
						await emit({
							phase: 'baseline',
							stepMb,
							maxMb,
							fileKb,
							mounted: mount,
							mountInfo,
							bootMs: inst.bootMs,
							linearMemoryBytes: linearMemory(inst.binary),
							elapsedMs: Date.now() - t0
						});

						// uniform bytes are a trap: macOS compresses identical pages, so a
						// 6 GB run showed 30 MB RSS. random bytes cannot be compressed, so
						// rand=1 is the only variant whose RSS means anything
						const chunk = new Uint8Array(fileKb * 1024);
						if (q.get('rand') === '1') {
							// Web Crypto caps getRandomValues at 65,536 bytes per call
							for (let o = 0; o < chunk.length; o += 65536) {
								crypto.getRandomValues(
									chunk.subarray(o, Math.min(o + 65536, chunk.length))
								);
							}
						} else {
							chunk.fill(0x61);
						}
						const filesPerStep = Math.max(
							1,
							Math.round((stepMb * MB) / (fileKb * 1024))
						);
						const steps = Math.ceil(maxMb / stepMb);
						let written = 0;
						let files = 0;
						for (let i = 1; i <= steps; i++) {
							const before = linearMemory(inst.binary);
							for (let j = 0; j < filesPerStep; j++) {
								FS.writeFile(`/memfs/f${files}`, chunk);
								files++;
								written += chunk.length;
							}
							// prove PHP can still see and stat the tree it is carrying
							const raw = await exec(
								inst,
								`<?php
                $f = function (): string {
                  $n = 0;
                  foreach (scandir('/memfs') as $e) { if ($e[0] !== '.') $n++; }
                  return json_encode([
                    'visible' => $n,
                    'usage_real' => memory_get_usage(true),
                  ]);
                };
                echo $f();`
							);
							let php = null;
							try {
								php = JSON.parse(raw.trim());
							} catch {
								php = { rawOutput: raw.slice(0, 400) };
							}
							await emit({
								step: i,
								files,
								writtenBytes: written,
								writtenMb: +(written / MB).toFixed(2),
								php,
								linearBeforeBytes: before,
								linearAfterBytes: linearMemory(inst.binary),
								elapsedMs: Date.now() - t0
							});
						}
						// hold the peak so an external RSS sampler can actually catch it;
						// the run is otherwise faster than a 50 ms sampling interval
						const holdMs = Number(q.get('hold') ?? 0);
						if (holdMs > 0) {
							await emit({ phase: 'holding', holdMs, files, writtenBytes: written });
							await new Promise((r) => setTimeout(r, holdMs));
							const raw = await exec(
								inst,
								`<?php $f = function (): string {
                  $n = 0; foreach (scandir('/memfs') as $e) { if ($e[0] !== '.') $n++; }
                  return json_encode(['visible' => $n, 'sample' => strlen(file_get_contents('/memfs/f0'))]);
                }; echo $f();`
							);
							await emit({ phase: 'afterHold', probe: raw.trim() });
						}
						await emit({
							phase: 'completed-without-failure',
							maxMb,
							files,
							writtenBytes: written
						});
					});
				}

				// TASK C.2 -- mbstring polyfill behaviour inside wasm PHP
				case '/mb': {
					const inst = await build('-1');
					const mountInfo = await mountDrupalStreaming(inst.binary, env);
					const raw = await exec(inst, MB_PROBE);
					return new Response(raw, {
						headers: {
							'content-type': 'application/json',
							'x-mount-files': String(mountInfo.files)
						}
					});
				}

				/**
				 * TASK B in wasm: the same ClassLoader::findFile() loop the native
				 * benchmark runs, so the native saving can be scaled by a measured
				 * wasm:native ratio for THIS operation rather than by the project's
				 * general 3.4x CPU factor. Drupal is not booted, so only classes the
				 * composer loader resolves on its own are timed.
				 *
				 *   curl -X POST --data-binary @classlist.json .../autoload-bench
				 */
				case '/autoload-bench': {
					const body = await request.json<any>();
					const classes = body.sample ?? body;
					const iters = num('iters', 20);
					const inst = await build('-1');
					const mountInfo = await mountDrupalStreaming(inst.binary, env);
					const raw = await exec(
						inst,
						`<?php
            $f = function (array $classes, int $iters): string {
              chdir('/drupal');
              $loader = require '/drupal/autoload.php';
              $refl = new ReflectionObject($loader);
              $mapProp = $refl->getProperty('classMap');
              $resolvable = [];
              foreach ($classes as $c) {
                if ($loader->findFile($c) !== false) $resolvable[] = $c;
              }
              // warm-up pass excluded from the samples
              foreach ($resolvable as $c) { $loader->findFile($c); }
              // hrtime() in this wasm build has ~1 ms granularity, so one pass
              // over 152 classes quantizes to multiples of 6,579 ns/class.
              // INNER repeats per timed sample push each sample to ~40 ms.
              $inner = INNER_REPEAT;
              $samples = [];
              for ($k = 0; $k < $iters; $k++) {
                $a = hrtime(true);
                for ($j = 0; $j < $inner; $j++) {
                  foreach ($resolvable as $c) { $loader->findFile($c); }
                }
                $samples[] = (hrtime(true) - $a) / max(1, count($resolvable) * $inner);
              }
              sort($samples);
              return json_encode([
                'phpVersion' => PHP_VERSION,
                'classMapEntries' => count($mapProp->getValue($loader)),
                'sampleSize' => count($classes),
                'resolvable' => count($resolvable),
                'iterations' => $iters,
                'innerRepeat' => $inner,
                'perClassNsMedian' => (int) round($samples[intdiv(count($samples), 2)]),
                'perClassNsMin' => (int) round($samples[0]),
                'perClassNsMax' => (int) round($samples[count($samples) - 1]),
                'resolvableList' => $resolvable,
              ]);
            };
            echo $f(${JSON.stringify(classes)}, ${iters});`.replace(
							'INNER_REPEAT',
							String(num('inner', 20))
						)
					);
					let parsed = null;
					try {
						parsed = JSON.parse(raw.trim());
					} catch {
						parsed = { rawOutput: raw.slice(0, 800) };
					}
					return Response.json({ mountFiles: mountInfo.files, wasm: parsed });
				}

				/**
				 * TASK B in wasm, optimized arm: overwrite the mounted tree's
				 * vendor/composer/*.php with an optimized dump before requiring
				 * autoload.php, so the classmap-hit cost is measured in wasm rather
				 * than scaled from native. The ComposerStaticInit hash is stable across
				 * dumps for the same composer.json, so the files are drop-in.
				 *
				 *   curl -X POST --data-binary @payload.json .../autoload-bench-opt
				 */
				case '/autoload-bench-opt': {
					const body = await request.json<any>();
					const classes = body.sample;
					const iters = num('iters', 20);
					const inner = num('inner', 20);
					const inst = await build('-1');
					const mountInfo = await mountDrupalStreaming(inst.binary, env);
					const enc = new TextEncoder();
					const overwritten = [];
					for (const [rel, content] of Object.entries<string>(body.files ?? {})) {
						const full = '/drupal/' + rel;
						mkdirp(inst.binary.FS, full.split('/').slice(0, -1).join('/'));
						inst.binary.FS.writeFile(full, enc.encode(content));
						overwritten.push({ path: rel, bytes: content.length });
					}
					const raw = await exec(
						inst,
						`<?php
            $f = function (array $classes, int $iters, int $inner): string {
              chdir('/drupal');
              $loader = require '/drupal/autoload.php';
              $refl = new ReflectionObject($loader);
              $mapProp = $refl->getProperty('classMap');
              $resolvable = [];
              $inMap = 0;
              $map = $mapProp->getValue($loader);
              foreach ($classes as $c) {
                if ($loader->findFile($c) !== false) $resolvable[] = $c;
                if (isset($map[$c])) $inMap++;
              }
              foreach ($resolvable as $c) { $loader->findFile($c); }
              $samples = [];
              for ($k = 0; $k < $iters; $k++) {
                $a = hrtime(true);
                for ($j = 0; $j < $inner; $j++) {
                  foreach ($resolvable as $c) { $loader->findFile($c); }
                }
                $samples[] = (hrtime(true) - $a) / max(1, count($resolvable) * $inner);
              }
              sort($samples);
              return json_encode([
                'phpVersion' => PHP_VERSION,
                'classMapEntries' => count($map),
                'sampleSize' => count($classes),
                'resolvable' => count($resolvable),
                'inClassMap' => $inMap,
                'iterations' => $iters,
                'innerRepeat' => $inner,
                'perClassNsMedian' => (int) round($samples[intdiv(count($samples), 2)]),
                'perClassNsMin' => (int) round($samples[0]),
                'perClassNsMax' => (int) round($samples[count($samples) - 1]),
              ]);
            };
            echo $f(${JSON.stringify(classes)}, ${iters}, ${inner});`
					);
					let parsed = null;
					try {
						parsed = JSON.parse(raw.trim());
					} catch {
						parsed = { rawOutput: raw.slice(0, 800) };
					}
					return Response.json({
						mountFiles: mountInfo.files,
						overwritten,
						wasm: parsed
					});
				}

				// TASK C.2 -- isolates each divergence the first probe found
				case '/mb2': {
					const inst = await build('-1');
					const mountInfo = await mountDrupalStreaming(inst.binary, env);
					const raw = await exec(inst, MB_PROBE2);
					return new Response(raw, {
						headers: {
							'content-type': 'application/json',
							'x-mount-files': String(mountInfo.files)
						}
					});
				}

				default:
					return new Response(
						[
							'/info',
							'/php-mem?step=5&max=1024[&limit=-1][&mount=1]',
							'/fs-mem?step=5&max=1024[&filekb=1024][&mount=1]',
							'/mb'
						].join('\n'),
						{ status: 404 }
					);
			}
		} catch (e: any) {
			return new Response(`${e?.stack ?? e}`, { status: 500 });
		}
	}
};

/**
 * Loads Drupal's autoloader so Symfony's polyfill is registered exactly the way
 * a real request registers it, then exercises the mb_* surface Drupal uses.
 */
const MB_PROBE = String.raw`<?php
$f = function (): string {
  $r = ['extension_loaded_mbstring' => extension_loaded('mbstring')];
  $r['before_autoload'] = [
    'mb_strlen' => function_exists('mb_strlen'),
    'mb_substr' => function_exists('mb_substr'),
    'mb_strtolower' => function_exists('mb_strtolower'),
  ];

  // MB_ROOT lets the identical file run natively against a real tree
  $root = defined('MB_ROOT') ? MB_ROOT : '/drupal';
  chdir($root);
  $al = $root . '/autoload.php';
  $r['root'] = $root;
  $r['autoload_exists'] = file_exists($al);
  if ($r['autoload_exists']) {
    require $al;
  }

  $fns = [
    'mb_strlen', 'mb_substr', 'mb_strtolower', 'mb_strtoupper', 'mb_strpos',
    'mb_convert_encoding', 'mb_detect_encoding', 'mb_check_encoding',
    'mb_internal_encoding', 'mb_convert_case', 'mb_str_split', 'mb_strwidth',
    'mb_substr_count', 'mb_strrpos', 'mb_stripos', 'mb_ucfirst',
  ];
  foreach ($fns as $fn) {
    $r['exists'][$fn] = function_exists($fn);
    if (function_exists($fn)) {
      $rf = new ReflectionFunction($fn);
      $r['defined_in'][$fn] = $rf->isInternal()
        ? 'INTERNAL(extension)'
        : ($rf->getFileName() ?: 'unknown');
    }
  }

  // accented Latin + CJK + an emoji (astral plane) + a combining sequence
  $s = "Cafe\u{0301} na\u{ef}ve \u{4f60}\u{597d}\u{4e16}\u{754c} \u{1f600} \u{439}";
  $r['sample_hex'] = bin2hex($s);
  $r['strlen_bytes'] = strlen($s);

  $r['results'] = [
    'mb_strlen'                 => mb_strlen($s),
    'mb_strlen_utf8'            => mb_strlen($s, 'UTF-8'),
    'mb_substr_0_4'             => bin2hex(mb_substr($s, 0, 4)),
    'mb_substr_5_5'             => bin2hex(mb_substr($s, 5, 5)),
    'mb_substr_neg3'            => bin2hex(mb_substr($s, -3)),
    'mb_strtolower'             => bin2hex(mb_strtolower($s)),
    'mb_strtoupper'             => bin2hex(mb_strtoupper($s)),
    'mb_strpos_cjk'             => mb_strpos($s, "\u{597d}"),
    'mb_strrpos_space'          => mb_strrpos($s, ' '),
    'mb_stripos_CAFE'           => mb_stripos($s, 'CAFE'),
    'mb_substr_count_space'     => mb_substr_count($s, ' '),
    'mb_strwidth'               => mb_strwidth($s),
    'mb_check_encoding_utf8'    => mb_check_encoding($s, 'UTF-8'),
    'mb_detect_encoding'        => mb_detect_encoding($s, ['ASCII','UTF-8'], true),
    'mb_convert_case_title'     => bin2hex(mb_convert_case($s, MB_CASE_TITLE, 'UTF-8')),
    'mb_convert_case_upper'     => bin2hex(mb_convert_case($s, MB_CASE_UPPER, 'UTF-8')),
    'mb_str_split_3'            => array_map('bin2hex', array_slice(mb_str_split($s), 0, 6)),
    'mb_internal_encoding'      => mb_internal_encoding(),
    'mb_convert_encoding_l1'    => bin2hex(mb_convert_encoding("na\u{ef}ve", 'ISO-8859-1', 'UTF-8')),
    'mb_convert_encoding_back'  => bin2hex(mb_convert_encoding("na\xefve", 'UTF-8', 'ISO-8859-1')),
    'invalid_utf8_strlen'       => mb_strlen("abc\xff\xfedef"),
    'invalid_utf8_check'        => mb_check_encoding("abc\xff\xfedef", 'UTF-8'),
    'invalid_utf8_substr'       => bin2hex(mb_substr("abc\xff\xfedef", 0, 5)),
    'turkish_i_lower'           => bin2hex(mb_strtolower("\u{130}")),
    'german_sharp_s_upper'      => bin2hex(mb_strtoupper("stra\u{df}e")),
    'greek_final_sigma'         => bin2hex(mb_strtolower("\u{39f}\u{394}\u{39f}\u{3a3}")),
  ];

  // Drupal's own Unicode helper, which is what core actually calls
  // D11 removed Unicode::strlen/substr/strtolower; these are what remains, and
  // every one of them is implemented on top of mb_*
  $U = 'Drupal\Component\Utility\Unicode';
  if (class_exists($U)) {
    $r['drupal_unicode'] = [
      'ucfirst'          => bin2hex($U::ucfirst("\u{ef}nput")),
      'lcfirst'          => bin2hex($U::lcfirst("\u{cf}NPUT")),
      'ucwords'          => bin2hex($U::ucwords("\u{ef}nput \u{e9}tat")),
      'truncate_8'       => bin2hex($U::truncate($s, 8, false, true)),
      'truncate_12_ws'   => bin2hex($U::truncate($s, 12, true, true)),
      'truncateBytes_10' => bin2hex($U::truncateBytes($s, 10)),
      'strcasecmp'       => $U::strcasecmp("Caf\u{e9}", "caf\u{c9}"),
      'validateUtf8'     => $U::validateUtf8($s),
      'validateUtf8_bad' => $U::validateUtf8("abc\xff\xfe"),
      'convertToUtf8_l1' => bin2hex($U::convertToUtf8("na\xefve", 'ISO-8859-1')),
      'getStatus'        => $U::getStatus(),
    ];
  } else {
    $r['drupal_unicode'] = 'class not found';
  }

  return json_encode($r);
};
echo $f();`;

/**
 * Isolates each divergence the first probe found, and covers the exact set of
 * mb_* functions Drupal 11 core calls (14 distinct, counted by grep over core/).
 */
const MB_PROBE2 = String.raw`<?php
$f = function (): string {
  $root = defined('MB_ROOT') ? MB_ROOT : '/drupal';
  chdir($root);
  require $root . '/autoload.php';

  $r = [
    'ext' => [
      'mbstring' => extension_loaded('mbstring'),
      'iconv' => extension_loaded('iconv'),
      'intl' => extension_loaded('intl'),
    ],
  ];

  // the exact functions Drupal 11 core calls
  $core = [
    'mb_strtolower', 'mb_substr', 'mb_strlen', 'mb_strtoupper',
    'mb_convert_encoding', 'mb_chr', 'mb_language', 'mb_internal_encoding',
    'mb_check_encoding', 'mb_strpos', 'mb_stripos', 'mb_ord',
    'mb_detect_encoding', 'mb_convert_case',
  ];
  foreach ($core as $fn) {
    $r['coreFns'][$fn] = function_exists($fn);
  }

  // which char makes mb_strwidth disagree
  $chars = [
    'ascii_a' => 'a',
    'latin_e_acute' => "\u{e9}",
    'combining_acute' => "e\u{0301}",
    'cjk_ni' => "\u{4f60}",
    'fullwidth_A' => "\u{ff21}",
    'emoji_grin' => "\u{1f600}",
    'cyrillic_i' => "\u{439}",
  ];
  foreach ($chars as $k => $c) {
    $r['strwidth'][$k] = mb_strwidth($c);
    $r['strlen_per_char'][$k] = mb_strlen($c);
  }

  // invalid UTF-8: the case that silently corrupts content
  $bad = [
    'ff_fe_middle' => "abc\xff\xfedef",
    'lone_continuation' => "abc\x80def",
    'truncated_3byte' => "abc\xe4\xbd",
    'overlong' => "abc\xc0\xafdef",
    'surrogate' => "abc\xed\xa0\x80def",
  ];
  foreach ($bad as $k => $s) {
    $r['invalid'][$k] = [
      'bytes' => strlen($s),
      'mb_strlen' => mb_strlen($s),
      'mb_check_encoding' => mb_check_encoding($s, 'UTF-8'),
      'mb_substr_0_5' => bin2hex(mb_substr($s, 0, 5)),
      'mb_substr_all' => bin2hex(mb_substr($s, 0, 100)),
      'mb_strtolower' => bin2hex(mb_strtolower($s)),
      'mb_convert_utf8' => bin2hex(mb_convert_encoding($s, 'UTF-8', 'UTF-8')),
    ];
  }

  // Greek final sigma is contextual lowercasing
  $greek = [
    'ODOS' => "\u{39f}\u{394}\u{39f}\u{3a3}",
    'SIGMA_alone' => "\u{3a3}",
    'SIGMA_mid' => "\u{3a3}\u{391}",
    'ASH' => "\u{391}\u{3a3}\u{397}",
  ];
  foreach ($greek as $k => $s) {
    $r['greek'][$k] = [
      'lower' => bin2hex(mb_strtolower($s)),
      'upper' => bin2hex(mb_strtoupper($s)),
      'title' => bin2hex(mb_convert_case($s, MB_CASE_TITLE, 'UTF-8')),
    ];
  }

  // mb_chr / mb_ord round trip over the planes
  foreach ([65, 233, 0x4f60, 0x1f600, 0x10FFFF] as $cp) {
    $ch = mb_chr($cp, 'UTF-8');
    $r['chr_ord'][$cp] = [
      'chr' => $ch === false ? false : bin2hex($ch),
      'ord' => $ch === false ? false : mb_ord($ch, 'UTF-8'),
    ];
  }

  $r['mb_language_uni'] = mb_language('uni');
  $r['mb_language_get'] = mb_language();
  $r['mb_internal_encoding_get'] = mb_internal_encoding();

  $U = 'Drupal\Component\Utility\Unicode';
  $r['unicode_check'] = $U::check();
  $r['unicode_getStatus'] = $U::getStatus();
  $r['unicode_STATUS_MULTIBYTE'] = $U::STATUS_MULTIBYTE;

  return json_encode($r);
};
echo $f();`;
