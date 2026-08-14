// must evaluate before the glue; see the file for why
import '@drupflare/cartridge/shim';

import { Gate } from '@drupflare/cartridge/gate';
import { decode, encode, PHP_CODEC } from '@drupflare/durabledb/codec';
import { PhpBase, type PhpBaseModuleFactory, type PhpRuntimeArgs } from 'php-wasm/PhpBase';
import PHPFactory from '../../vendor/static/php8.3-worker.mjs';
import wasmModule from '../../vendor/static/php8.3-worker.mjs.wasm';
import { CPU_BENCH } from './cpu-bench';
import { DRUPAL_BOOT, DRUPAL_EXERCISE, DRUPAL_PROFILE } from './drupal-boot';
import { generateCases, likeToGlob } from './glob-differential';

/** the MEMFS calls this worker makes; emscripten's FS is far wider than this */
interface ProbeFS {
	mkdir(path: string): void;
	writeFile(path: string, data: Uint8Array | string): void;
	utime(path: string, atime: number, mtime: number): void;
	/** wrapped by /trace, which is how one trace covers every read path; `any` because the
	 *  argument types are emscripten's and the wrapper has to pass them straight through */
	open(path: any, flags?: any, mode?: any): any;
	unlink(path: string): void;
	stat(path: string): any;
	analyzePath(path: string): any;
	readFile(path: string, options?: any): any;
}

/**
 * The emscripten Module, as this worker uses it.
 *
 * php-wasm types `PhpBinaryRuntime.FS` as bare `object`, so the MEMFS surface is named here and
 * the one cast happens where `php.binary` resolves. `wasmMemory` and `HEAPU8` are read only to
 * price linear memory, and which one exists depends on how the build was linked.
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
	PW_DIAGNOSTICS?: string;
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
				// PhpBase appends this to /php.ini before pib_init.
				//
				// file_cache_only=1 is the whole point: no shared memory, bytecode
				// written to and read from disk. validate_timestamps=0 removes ~1,799
				// stats per boot -- VFS mtimes are meaningless here anyway, and the pack
				// is immutable within a version.
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
const startup: StartupReport = {
	ok: false,
	error: null,
	diag: [],
	bootMs: null,
	memory: null
};
let warm: PhpInstance | null = null;
try {
	warm = await build();
	startup.ok = true;
	startup.diag = warm!.diag;
	startup.bootMs = warm!.bootMs;
	startup.memory = linearMemory(warm!.binary);
} catch (e: any) {
	startup.error = `${e?.stack ?? e}`;
}

async function exec(inst: PhpInstance, code: string) {
	inst.out.length = 0;
	await inst.php._run(code);
	return inst.out.join('');
}

/**
 * Routes that must never be reachable in production.
 *
 * Not merely "these are noisy". `Database::startLog()` is IRREVERSIBLE: after
 * one call, `Log::end()` leaves statement events enabled and
 * `Database::openConnection()` re-attaches the logger to every connection
 * created for the rest of the isolate's life. Measured cost of that residue:
 * 0.0595 ms/query against 0.0345 ms clean -- 1.72x, permanently.
 *
 * So a single hit on a diagnostic route permanently degrades whichever isolate
 * serves it, and every later request on that isolate pays. Any route that
 * profiles, logs SQL, mutates globals or leaks internals belongs here.
 */
const DIAGNOSTIC_ROUTES = new Set([
	'/dbal',
	'/codec',
	'/reentrancy',
	'/authed-real',
	'/cache-headers',
	'/authed-cost',
	'/authed-cost2',
	'/authed-cost3',
	'/profile',
	'/trace',
	'/boot-profile',
	'/boot-breakdown',
	'/warm-precision',
	'/isolation',
	'/isolation-test',
	'/glob-diff',
	'/evict',
	'/opcache',
	'/yaml-bench',
	'/cpubench',
	'/vfs',
	'/wal-roundtrip',
	'/sqlite-caps',
	'/bridge'
]);

export default {
	async fetch(request: Request, env: ProbeEnv): Promise<Response> {
		const url = new URL(request.url);

		// Fail closed: diagnostics require an explicit opt-in var, so forgetting to
		// set it in production is safe and forgetting to unset it is not possible.
		if (DIAGNOSTIC_ROUTES.has(url.pathname) && env?.PW_DIAGNOSTICS !== '1') {
			return new Response('not found\n', { status: 404 });
		}

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

				case '/bridge': {
					// The tax on every query forever, if the DO SQLite Connection is written as a
					// JS-bridged driver. Raw PDO is 0.0070 ms/query in wasm, so a bridge costing
					// more than that makes the bridged driver a regression -- and 24 queries x a
					// 0.5 ms round trip would be 12 ms, closing the free tier by itself.
					const inst = warm!;
					if (!inst.mounted) {
						await mountDrupalStreaming(inst.binary, env);
						inst.mounted = true;
					}
					// install trivial JS callables on the Module for vrzno to reach
					inst.binary.pwNoop = () => 0;
					inst.binary.pwEcho = (x: unknown) => x;
					inst.binary.pwSqlish = (q: unknown) =>
						JSON.stringify([{ cid: String(q).slice(0, 8), data: 1 }]);
					await exec(inst, DRUPAL_BOOT);

					const probe = `<?php
        $N = ${Number(url.searchParams.get('n') ?? 2000)};
        $t = function() { return microtime(true) * 1000; };
        $out = ['vrznoLoaded' => (int) extension_loaded('vrzno')];
        if (!$out['vrznoLoaded']) { echo json_encode($out); return; }

        // measure inside a closure: the logger A/B proved global scope distorts
        // anything that walks a backtrace, and function scope is what production is
        $bench = function($N, $t, $fn) {
          $a = $t();
          for ($i = 0; $i < $N; $i++) { $fn($i); }
          return round((($t() - $a) / $N), 4);
        };

        $noop = vrzno_env('pwNoop');
        $echo = vrzno_env('pwEcho');
        $sqlish = vrzno_env('pwSqlish');
        $out['resolved'] = ['noop' => (int) is_object($noop), 'echo' => (int) is_object($echo), 'sqlish' => (int) is_object($sqlish)];

        try { $out['noopMs'] = $bench($N, $t, function($i) use ($noop) { $noop(); }); }
        catch (\\Throwable $e) { $out['noopMs'] = 'ERR ' . substr($e->getMessage(), 0, 70); }
        try { $out['echoIntMs'] = $bench($N, $t, function($i) use ($echo) { $echo($i); }); }
        catch (\\Throwable $e) { $out['echoIntMs'] = 'ERR ' . substr($e->getMessage(), 0, 70); }
        try { $out['echoStrMs'] = $bench($N, $t, function($i) use ($echo) { $echo('cache_discovery_key_' . $i); }); }
        catch (\\Throwable $e) { $out['echoStrMs'] = 'ERR ' . substr($e->getMessage(), 0, 70); }
        try { $out['sqlishJsonMs'] = $bench($N, $t, function($i) use ($sqlish) { json_decode($sqlish('SELECT ' . $i), true); }); }
        catch (\\Throwable $e) { $out['sqlishJsonMs'] = 'ERR ' . substr($e->getMessage(), 0, 70); }

        // the number that decides it: bridge round trip vs the in-wasm PDO it replaces
        $out['rawPdoIndexedMsForReference'] = 0.007;
        echo json_encode($out);
        `;
					const raw = await exec(inst, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 900) };
					}
					return Response.json(parsed);
				}

				case '/reentrancy': {
					// Concurrent suspending requests against ONE interpreter, with and without the
					// gate.
					//
					// This build is not Asyncify, so PHP cannot suspend mid-call today -- which is
					// exactly why the gate has to exist before JSPI rather than after. What CAN be
					// modelled faithfully right now is the shape a suspending request has from the
					// interpreter's point of view: touch a global, yield, then read it back. Whether
					// the yield is JSPI or a host round trip between two exec() calls is immaterial;
					// either way a second request can enter while the first is parked.
					const inst = warm!;
					if (!inst.mounted) {
						await mountDrupalStreaming(inst.binary, env);
						inst.mounted = true;
					}
					await exec(inst, DRUPAL_BOOT);

					const N = Number(url.searchParams.get('n') ?? 12);

					// one "request": set a marker, yield, then assert it survived
					const twoPhase = async (id: number) => {
						await exec(inst, `<?php $GLOBALS['__pw_reent'] = ${id}; echo 'set';`);
						// the suspension point
						await scheduler.wait(0);
						const got = await exec(
							inst,
							`<?php echo (int) ($GLOBALS['__pw_reent'] ?? -1);`
						);
						return Number(String(got).trim().match(/-?\d+/)?.[0] ?? -999) === id;
					};

					// CONTROL: no gate. Must corrupt, or the gated result proves nothing.
					let ungatedOk = 0;
					const ungated = await Promise.all(
						Array.from({ length: N }, (_, i2) => twoPhase(i2))
					);
					for (const r of ungated) if (r) ungatedOk++;

					// GATED: the same workload through the serializer.
					const gate = new Gate();
					let gatedOk = 0;
					const gated = await Promise.all(
						Array.from({ length: N }, (_, i2) =>
							gate.run(() => twoPhase(1000 + i2), `r${i2}`)
						)
					);
					for (const r of gated) if (r) gatedOk++;

					return Response.json({
						requests: N,
						ungated: {
							survived: ungatedOk,
							corrupted: N - ungatedOk,
							note: 'CONTROL -- corruption here is the point; zero would invalidate the test'
						},
						gated: {
							survived: gatedOk,
							corrupted: N - gatedOk,
							maxConcurrent: gate.stats().maxConcurrent,
							fifo:
								gate.stats().order.join(',') ===
								Array.from({ length: N }, (_, i2) => `r${i2}`).join(',')
						},
						verdict: gatedOk === N && ungatedOk < N ? 'PASS' : 'INCONCLUSIVE'
					});
				}

				case '/codec': {
					// Differential test of the PHP half of the typed codec, across the real
					// boundary. scripts/test-codec.mjs covers the JS half; the two halves only
					// work if they agree, so this drives JS -> PHP -> JS and compares.
					const inst = warm!;
					if (!inst.mounted) {
						await mountDrupalStreaming(inst.binary, env);
						inst.mounted = true;
					}
					await exec(inst, DRUPAL_BOOT);

					const corpus = {
						zero: 0,
						smallInt: 42,
						negInt: -42,
						int32Max: 2 ** 31 - 1,
						int32Min: -(2 ** 31),
						floatV: 1.5,
						boolT: true,
						boolF: false,
						str: 'hello',
						emptyStr: '',
						unicode: 'h\u00e9llo \u4e16\u754c',
						nullV: null,
						// the two holes found separately in production paths
						dateNowMagnitude: 1780000000000,
						nodeIdAt2p31: 2 ** 31,
						nodeIdAbove: 4294967296,
						maxSafe: Number.MAX_SAFE_INTEGER,
						// must survive as a STRING; the old marshal() could not express this
						digitString: '12345',
						wideDigitString: '1780000000000',
						leadingZero: '007',
						arr: [1, 2, 3],
						nested: { a: { b: { c: 1780000000000 } } },
						mixed: {
							ids: [2 ** 31, 2 ** 31 + 1],
							when: 1780000000000,
							name: 'x'
						},
						emptyArr: []
					};

					const encoded = JSON.stringify(encode(corpus));
					const probe = `<?php
        ${PHP_CODEC}
        $in = json_decode(${JSON.stringify(encoded)}, true);
        $decoded = pw_decode($in);
        $reencoded = pw_encode($decoded);
        echo json_encode(['round' => $reencoded, 'phpIntSize' => PHP_INT_SIZE]);
        `;
					const raw = await exec(inst, probe);
					let back;
					try {
						back = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						return Response.json({
							error: 'unparseable',
							raw: raw.slice(0, 600)
						});
					}

					const got = decode(back.round) as any;
					const results: Record<string, string> = {};
					let failed = 0;
					// `any` on both sides and an explicit return type: this walks arbitrary decoded
					// JSON and recurses, so tsc cannot infer the return type on its own
					const same = (a: any, b: any): boolean => {
						if (typeof a === 'bigint' || typeof b === 'bigint')
							return String(a) === String(b);
						if (Array.isArray(a) && Array.isArray(b))
							return a.length === b.length && a.every((v, i2) => same(v, b[i2]));
						if (a && b && typeof a === 'object' && typeof b === 'object') {
							const ka = Object.keys(a);
							return (
								ka.length === Object.keys(b).length &&
								ka.every((k) => same(a[k], b[k]))
							);
						}
						return a === b || (Number.isNaN(a) && Number.isNaN(b));
					};
					for (const [k, v] of Object.entries(corpus)) {
						const ok = same(v, got?.[k]);
						if (!ok) failed++;
						results[k] = ok
							? 'ok'
							: `MISMATCH sent=${JSON.stringify(String(v))} got=${JSON.stringify(String(got?.[k]))} type=${typeof got?.[k]}`;
					}

					// CONTROL: a value deliberately corrupted on the way out must be caught, so a
					// vacuously-passing comparison is not mistaken for a clean round trip.
					const control = same(
						corpus.dateNowMagnitude,
						(decode(back.round) as any).dateNowMagnitude + 1
					);

					return Response.json({
						phpIntSize: back.phpIntSize,
						failed,
						controlShouldBeFalse: control,
						results
					});
				}

				case '/dbal': {
					// Isolated on purpose. The earlier querycost number was taken inside
					// /authed-real AFTER that probe had called Database::startLog() three
					// times and never stopped them -- so every query dispatched
					// StatementExecutionEndEvent into Log::logFromEvent(), which calls
					// findCallerFromDebugBacktrace() -> debug_backtrace(). That is
					// suspect #1, and it was self-inflicted. Measure with logging provably
					// off, then switch it on to price it.
					const inst = warm!;
					if (!inst.mounted) {
						await mountDrupalStreaming(inst.binary, env);
						inst.mounted = true;
					}
					await exec(inst, DRUPAL_BOOT);

					const probe = `<?php
        $N = ${Number(url.searchParams.get('n') ?? 2000)};
        $t = function() { return microtime(true) * 1000; };
        $out = [];
        $db = \\Drupal::database();

        // prove no logger is attached before measuring
        $out['loggingActive'] = \\Drupal\\Core\\Database\\Database::getLog('pw', 'default') === null ? 0 : 1;

        $drupalBench = function($N) use ($db, $t) {
          $db->query('SELECT 1')->fetchAll();
          $a = $t();
          for ($i = 0; $i < $N; $i++) { $db->query('SELECT 1')->fetchAll(); }
          $triv = ($t() - $a) / $N;
          $a = $t();
          for ($i = 0; $i < $N; $i++) {
            $db->query('SELECT [cid] FROM {cache_discovery} WHERE [cid] = :c', [':c' => 'pw_' . $i])->fetchAll();
          }
          return [round($triv, 4), round((($t() - $a) / $N), 4)];
        };

        [$a1, $b1] = $drupalBench($N);
        $out['drupalNoLogging'] = ['trivialMs' => $a1, 'indexedMs' => $b1];

        $m = new \\PDO('sqlite::memory:');
        $m->setAttribute(\\PDO::ATTR_ERRMODE, \\PDO::ERRMODE_EXCEPTION);
        $m->exec('CREATE TABLE cache_discovery (cid TEXT PRIMARY KEY, data BLOB)');
        $m->query('SELECT 1')->fetchAll();
        $a = $t();
        for ($i = 0; $i < $N; $i++) { $m->query('SELECT 1')->fetchAll(); }
        $out['rawPdo']['trivialMs'] = round((($t() - $a) / $N), 4);
        $a = $t();
        for ($i = 0; $i < $N; $i++) {
          $st = $m->prepare('SELECT cid FROM cache_discovery WHERE cid = :c');
          $st->execute([':c' => 'x_' . $i]);
          $st->fetchAll();
        }
        $out['rawPdo']['indexedMs'] = round((($t() - $a) / $N), 4);

        // CONTROL: same A/B before any startLog, so no logger is attached.
        // one at the eval'd script's global scope, one inside a closure. PHP compiles
        // function-local variables to CVs (direct slot access) but global scope keeps
        // them in a hashtable, and pib_run evaluates this whole file at global scope.
        $M = 400;
        $dbzc = \\Drupal::database();
        $dbzc->query('SELECT 1')->fetchAll();
        $a = $t();
        for ($i3c = 0; $i3c < $M; $i3c++) {
          $dbzc->query('SELECT [cid] FROM {cache_discovery} WHERE [cid] = :c', [':c' => 'gc_' . $i3c])->fetchAll();
        }
        $globalMsC = ($t() - $a) / $M;
        $fnC = function($M, $dbzc, $t) {
          $a = $t();
          for ($i = 0; $i < $M; $i++) {
            $dbzc->query('SELECT [cid] FROM {cache_discovery} WHERE [cid] = :c', [':c' => 'fc_' . $i])->fetchAll();
          }
          return ($t() - $a) / $M;
        };
        $fnMsC = $fnC($M, $dbzc, $t);
        $out['scopeABClean'] = [
          'globalScopeMs' => round($globalMsC, 4),
          'functionScopeMs' => round($fnMsC, 4),
          'multiple' => $fnMsC > 0 ? round($globalMsC / $fnMsC, 1) : 0,
        ];

        \\Drupal\\Core\\Database\\Database::startLog('pw');
        [$a2, $b2] = $drupalBench($N);
        $out['drupalWithLogging'] = ['trivialMs' => $a2, 'indexedMs' => $b2];
        $out['loggingTaxMs'] = round($b2 - $b1, 4);

        // The state that actually contaminated the request timings: getLog() ends the
        // named key but Log::end() only unsets the array -- events stay enabled and
        // $event->caller keeps being computed. Database::openConnection() then attaches
        // the logger to every NEW connection for the life of the interpreter, so this
        // state cannot be left once entered.
        \\Drupal\\Core\\Database\\Database::getLog('pw', 'default');
        [$a3, $b3] = $drupalBench($N);
        $out['drupalAfterGetLog'] = ['trivialMs' => $a3, 'indexedMs' => $b3];
        $out['residualTaxMs'] = round($b3 - $b1, 4);
        $out['residualMultiple'] = $b1 > 0 ? round($b3 / $b1, 2) : 0;

        // Why was the original figure 0.866 ms when even active logging is 0.067 ms?
        // The difference is where it was measured: /authed-real ran it after ~40 fresh
        // DrupalKernel boots, each leaking a container. Test the interpreter directly --
        // same query loop, before and after kernel churn.
        $al = $GLOBALS['__pw_autoloader'];
        $churn = [];
        foreach ([0, 10, 25] as $k) {
          for ($j = 0; $j < ($k ? ($k === 10 ? 10 : 15) : 0); $j++) {
            try {
              $rq = \\Symfony\\Component\\HttpFoundation\\Request::create('/', 'GET');
              $kk = new \\Drupal\\Core\\DrupalKernel('prod', $al);
              \\Drupal\\Core\\DrupalKernel::bootEnvironment();
              $kk->setSitePath(\\Drupal\\Core\\DrupalKernel::findSitePath($rq));
              \\Drupal\\Core\\Site\\Settings::initialize('/drupal', $kk->getSitePath(), $al);
              $kk->boot();
            } catch (\\Throwable $e) { break; }
          }
          $dbx = \\Drupal::database();
          $dbx->query('SELECT 1')->fetchAll();
          $a = $t();
          for ($i2 = 0; $i2 < 300; $i2++) {
            $dbx->query('SELECT [cid] FROM {cache_discovery} WHERE [cid] = :c', [':c' => 'ch_' . $i2])->fetchAll();
          }
          $churn['after' . $k . 'Kernels'] = [
            'perQueryMs' => round((($t() - $a) / 300), 4),
            'heapMb' => round(memory_get_usage(true) / 1048576, 1),
          ];
        }
        $out['kernelChurn'] = $churn;

        // A/B the scope itself. Identical loop, identical connection, identical N --
        // one at the eval'd script's global scope, one inside a closure. PHP compiles
        // function-local variables to CVs (direct slot access) but global scope keeps
        // them in a hashtable, and pib_run evaluates this whole file at global scope.
        $M = 400;
        $dbz = \\Drupal::database();
        $dbz->query('SELECT 1')->fetchAll();
        $a = $t();
        for ($i3 = 0; $i3 < $M; $i3++) {
          $dbz->query('SELECT [cid] FROM {cache_discovery} WHERE [cid] = :c', [':c' => 'g_' . $i3])->fetchAll();
        }
        $globalMs = ($t() - $a) / $M;
        $fn = function($M, $dbz, $t) {
          $a = $t();
          for ($i = 0; $i < $M; $i++) {
            $dbz->query('SELECT [cid] FROM {cache_discovery} WHERE [cid] = :c', [':c' => 'f_' . $i])->fetchAll();
          }
          return ($t() - $a) / $M;
        };
        $fnMs = $fn($M, $dbz, $t);
        $out['scopeAB'] = [
          'globalScopeMs' => round($globalMs, 4),
          'functionScopeMs' => round($fnMs, 4),
          'multiple' => $fnMs > 0 ? round($globalMs / $fnMs, 1) : 0,
        ];

        // PCRE cannot JIT in wasm (JIT emits native code; workerd forbids runtime
        // codegen anyway), so price the interpreter gap on the shapes Drupal uses.
        $out['pcreJit'] = (string) ini_get('pcre.jit');
        $subject = 'SELECT [cid] FROM {cache_discovery} c INNER JOIN {users_field_data} u ON u.[uid] = c.[uid] WHERE [cid] = :c';
        $a = $t();
        for ($i = 0; $i < $N; $i++) { preg_replace_callback('/{(\\S*)}/', function($mm) { return 'x' . $mm[1]; }, $subject); }
        $out['pregReplaceCallbackMs'] = round((($t() - $a) / $N), 4);
        $a = $t();
        for ($i = 0; $i < $N; $i++) { preg_match('#^/user/(\\d+)/edit$#', '/user/12345/edit', $mm); }
        $out['pregMatchMs'] = round((($t() - $a) / $N), 4);
        $a = $t();
        for ($i = 0; $i < $N; $i++) { str_replace(['{', '}'], ['p_', ''], $subject); }
        $out['strReplaceMs'] = round((($t() - $a) / $N), 4);

        echo json_encode($out);
        `;
					const raw = await exec(inst, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 900) };
					}
					return Response.json(parsed);
				}

				case '/authed-real': {
					// Every earlier "authenticated" number was account_switcher plus a
					// synthetic request. That has two defects, both measured:
					//   1. no session cookie -> page_cache's request policy says ALLOW
					//      -> the ANONYMOUS cached page is served. "authed /" was
					//      12,304 bytes, byte-identical to anon, at 7.2 ms.
					//   2. a bare fake cookie -> the session subsystem loads an empty
					//      session and the auth subscriber overwrites switchTo() with
					//      anonymous -> /user/1 becomes a 403.
					// So: log in for real once, keep the session cookie, and replay it.
					// Session load/save cost is then included rather than excluded.
					const n = Number(url.searchParams.get('n') ?? 10);
					const inst = warm!;
					if (!inst.mounted) {
						await mountDrupalStreaming(inst.binary, env);
						inst.mounted = true;
					}
					await exec(inst, DRUPAL_BOOT);

					const probe = `<?php
$n = ${n};
$t = function() { return microtime(true) * 1000; };
$al = $GLOBALS['__pw_autoloader'];

$boot = function($req) use ($al) {
  $k = new \\Drupal\\Core\\DrupalKernel('prod', $al);
  \\Drupal\\Core\\DrupalKernel::bootEnvironment();
  $sp = \\Drupal\\Core\\DrupalKernel::findSitePath($req);
  $k->setSitePath($sp);
  \\Drupal\\Core\\Site\\Settings::initialize('/drupal', $sp, $al);
  $k->boot();
  return $k;
};
$close = function() {
  if (function_exists('session_status') && session_status() === PHP_SESSION_ACTIVE) { @session_write_close(); }
};

$out = [];

// --- log in for real, once ---
try {
  $req = \\Symfony\\Component\\HttpFoundation\\Request::create('/user/login', 'GET');
  $k = $boot($req);
  \\Drupal::service('request_stack')->push($req);
  $session = \\Drupal::service('session');
  $req->setSession($session);
  $session->start();
  $u = \\Drupal\\user\\Entity\\User::load(1);
  user_login_finalize($u);
  $session->save();
  $GLOBALS['__pw_sid'] = $session->getId();
  $GLOBALS['__pw_sname'] = $session->getName();
  $out['login'] = ['name' => $GLOBALS['__pw_sname'], 'sid_len' => strlen((string) $GLOBALS['__pw_sid'])];
  $close();
} catch (\\Throwable $e) {
  $out['login'] = ['err' => get_class($e) . ': ' . substr($e->getMessage(), 0, 140)];
  echo json_encode($out); return;
}

$SPLIT = ['boot' => 0.0, 'handle' => 0.0, 'n' => 0];
$serve = function($path, $authed) use ($boot, $close, $t, &$SPLIT) {
  $req = \\Symfony\\Component\\HttpFoundation\\Request::create($path, 'GET');
  if ($authed) { $req->cookies->set($GLOBALS['__pw_sname'], $GLOBALS['__pw_sid']); }
  $b0 = $t();
  $k = $boot($req);
  $b1 = $t();
  $resp = $k->handle($req, \\Symfony\\Component\\HttpKernel\\HttpKernelInterface::MAIN_REQUEST, false);
  $b2 = $t();
  $close();
  $SPLIT['boot'] += $b1 - $b0;
  $SPLIT['handle'] += $b2 - $b1;
  $SPLIT['n']++;
  return $resp;
};

// $bust appends a unique query per iteration so page_cache MISSES every time.
// Without it "anonymous /" measures a cache lookup (0.5 ms), not a render, and
// comparing that against an authenticated render is comparing nothing to work.
$bench = function($path, $authed, $n, $bust = false) use ($serve, $t, &$SPLIT) {
  try { $r0 = $serve($path, $authed); }
  catch (\\Throwable $e) { return ['err' => get_class($e) . ': ' . substr($e->getMessage(), 0, 90)]; }
  $body = (string) $r0->getContent();
  preg_match('#<title>(.*?)</title>#s', $body, $m);
  // second call so the reported cache state is the steady state, not the fill
  try { $r1 = $serve($path, $authed); } catch (\\Throwable $e) { $r1 = $r0; }
  $SPLIT = ['boot' => 0.0, 'handle' => 0.0, 'n' => 0];
  $a = $t();
  for ($i = 0; $i < $n; $i++) {
    $p = $bust ? ($path . (str_contains($path, '?') ? '&' : '?') . 'cb=' . $i . '_' . mt_rand()) : $path;
    $serve($p, $authed);
  }
  $ms = $t() - $a;
  return [
    'perRequestMs' => round($ms / $n, 2),
    'bootMs' => $SPLIT['n'] ? round($SPLIT['boot'] / $SPLIT['n'], 2) : 0,
    'handleMs' => $SPLIT['n'] ? round($SPLIT['handle'] / $SPLIT['n'], 2) : 0,
    'status' => $r0->getStatusCode(),
    'bytes' => strlen($body),
    'title' => trim(strip_tags($m[1] ?? 'none')),
    'page' => $r1->headers->get('x-drupal-cache') ?: '-',
    'dynamic' => $r1->headers->get('x-drupal-dynamic-cache') ?: '-',
    'uid' => (int) \\Drupal::currentUser()->id(),
  ];
};

// The authenticated floor is a flat ~113 ms independent of route and present
// even when dynamic_page_cache HITs, so it is not render work. Log the SQL for
// one authenticated request and find it rather than theorising.
try {
  \\Drupal\\Core\\Database\\Database::startLog('pw');
  $serve('/', 1);
  $log = \\Drupal\\Core\\Database\\Database::getLog('pw', 'default');
  $agg = [];
  $total = 0.0;
  foreach ($log as $entry) {
    $q = preg_replace('/\\s+/', ' ', trim((string) ($entry['query'] ?? '')));
    $ms = ((float) ($entry['time'] ?? 0)) * 1000;
    $total += $ms;
    if (!isset($agg[$q])) { $agg[$q] = ['n' => 0, 'ms' => 0.0]; }
    $agg[$q]['n']++;
    $agg[$q]['ms'] += $ms;
  }
  uasort($agg, function($a, $b) { return $b['ms'] <=> $a['ms']; });
  $top = [];
  foreach (array_slice($agg, 0, 8, TRUE) as $q => $v) {
    $top[] = ['n' => $v['n'], 'ms' => round($v['ms'], 1), 'q' => substr($q, 0, 110)];
  }
  $out['sql'] = ['queries' => count($log), 'distinct' => count($agg), 'totalMs' => round($total, 1), 'top' => $top];
} catch (\\Throwable $e) {
  $out['sql'] = ['err' => get_class($e) . ': ' . substr($e->getMessage(), 0, 120)];
}

// The SQL log said 20 ms for 133 queries, but every entry quantized to 1-2 ms,
// so that total is unreliable. Measure per-query cost in bulk instead, where
// quantization averages out over the loop.
try {
  $db = \\Drupal::database();
  $db->query('SELECT 1')->fetchAll();
  $N = 500;
  $a = $t();
  for ($i = 0; $i < $N; $i++) {
    $db->query('SELECT "cid" FROM {cache_discovery} WHERE "cid" = :c', [':c' => 'pw_missing_' . $i])->fetchAll();
  }
  $perQuery = ($t() - $a) / $N;
  $a = $t();
  for ($i = 0; $i < $N; $i++) { $db->query('SELECT 1')->fetchAll(); }
  $perTrivial = ($t() - $a) / $N;
  // Drupal's Connection::query() is not PDO: it adds prepareStatement(),
  // StatementPrefetchIterator (which fetches every row up front), logging and
  // exception wrapping. Comparing it against raw native PDO measures the
  // wrapper, not the platform. Run raw PDO here too, identical to the native
  // script, so the two comparisons are actually the same shape.
  $raw = ['skipped' => 'no pdo_sqlite'];
  if (class_exists('PDO', false) && in_array('sqlite', \\PDO::getAvailableDrivers(), true)) {
    $m = new \\PDO('sqlite::memory:');
    $m->setAttribute(\\PDO::ATTR_ERRMODE, \\PDO::ERRMODE_EXCEPTION);
    $m->exec('CREATE TABLE cache_discovery (cid TEXT PRIMARY KEY, data BLOB)');
    $m->query('SELECT 1')->fetchAll();
    $a = $t();
    for ($i = 0; $i < $N; $i++) { $m->query('SELECT 1')->fetchAll(); }
    $rawTrivial = ($t() - $a) / $N;
    $a = $t();
    for ($i = 0; $i < $N; $i++) {
      $st = $m->prepare('SELECT cid FROM cache_discovery WHERE cid = :c');
      $st->execute([':c' => 'x_' . $i]);
      $st->fetchAll();
    }
    $rawIndexed = ($t() - $a) / $N;
    $raw = [
      'rawPdoTrivialMs' => round($rawTrivial, 4),
      'rawPdoIndexedMs' => round($rawIndexed, 4),
    ];
  }
  $out['querycost'] = array_merge([
    'drupalPerIndexedMs' => round($perQuery, 3),
    'drupalPerTrivialMs' => round($perTrivial, 3),
    'implied133QueriesMs' => round($perQuery * 133, 1),
  ], $raw);
} catch (\\Throwable $e) { $out['querycost'] = ['err' => substr($e->getMessage(), 0, 100)]; }

// Disposable-kernel-per-request was chosen for isolation, but it empties every
// in-memory static each request, so config/discovery/routes are re-read from the
// DB cache tables every time -- 133 queries at 0.866 ms each. A persistent
// kernel plus the resetter serves those from memory. Measure the difference in
// query count, which is what actually drives the cost.
try {
  $warmK = $boot(\\Symfony\\Component\\HttpFoundation\\Request::create('/', 'GET'));
  $GLOBALS['__pw_warmk'] = $warmK;
  $warmServe = function($path, $authed) use ($warmK, $close) {
    $req = \\Symfony\\Component\\HttpFoundation\\Request::create($path, 'GET');
    if ($authed) { $req->cookies->set($GLOBALS['__pw_sname'], $GLOBALS['__pw_sid']); }
    // re-arm the per-request state a fresh process would have had
    try {
      $rp = new \\ReflectionProperty(\\Drupal\\Core\\DrupalKernel::class, 'prepared');
      $rp->setAccessible(true);
      $rp->setValue($warmK, false);
    } catch (\\Throwable $e) {}
    try { $st = \\Drupal::service('request_stack'); while ($st->getCurrentRequest() !== null) { $st->pop(); } } catch (\\Throwable $e) {}
    if (function_exists('drupal_static_reset')) { drupal_static_reset(); }
    // PageCache memoizes $this->cid on the middleware instance, which a warm
    // kernel reuses forever -- so EVERY route re-serves the first request's
    // cached page. Measured: /user/login, /node/1 and /admin/content all
    // returned "Welcome!" at 12,341 bytes with HTTP 200 and 1 query.
    //
    // StackedHttpKernel::$middlewares is a lazy iterator since 11.3 and is only
    // used by terminate(), so iterating it finds nothing. handle() delegates
    // down a chain of objects instead, so walk the object graph.
    $GLOBALS['__pw_cidreset'] = 0;
    $walk = function($obj, $depth) use (&$walk) {
      if ($depth > 8 || !is_object($obj)) { return; }
      if ($obj instanceof \\Drupal\\page_cache\\StackMiddleware\\PageCache) {
        $rc = new \\ReflectionProperty(\\Drupal\\page_cache\\StackMiddleware\\PageCache::class, 'cid');
        $rc->setAccessible(true);
        $rc->setValue($obj, null);
        $GLOBALS['__pw_cidreset']++;
        return;
      }
      $ro = new \\ReflectionObject($obj);
      foreach ($ro->getProperties() as $prop) {
        $prop->setAccessible(true);
        if (!$prop->isInitialized($obj)) { continue; }
        $v = $prop->getValue($obj);
        if ($v instanceof \\Closure) {
          try { $v = $v(); } catch (\\Throwable $e) { continue; }
        }
        if (is_object($v) && !($v instanceof \\Drupal\\Core\\DrupalKernel)) { $walk($v, $depth + 1); }
      }
    };
    try { $walk(\\Drupal::service('http_kernel'), 0); } catch (\\Throwable $e) { $GLOBALS['__pw_cidreset'] = 'ERR ' . substr($e->getMessage(), 0, 60); }
    $resp = $warmK->handle($req, \\Symfony\\Component\\HttpKernel\\HttpKernelInterface::MAIN_REQUEST, false);
    try { $resp->headers->set('x-pw-uri', (string) \\Drupal::request()->getRequestUri()); } catch (\\Throwable $e) {}
    $close();
    return $resp;
  };

  $countQ = function($fn) {
    \\Drupal\\Core\\Database\\Database::startLog('pwc');
    $r = $fn();
    $l = \\Drupal\\Core\\Database\\Database::getLog('pwc', 'default');
    return [count($l), $r];
  };

  // Anonymous with a unique query string: a full uncached render on both sides,
  // no session. That isolates kernel lifetime as the only variable -- PHP's
  // native session module is process-global (headers-sent, session_status) and
  // would confound it.
  $bustPath = function($i) { return '/?cb=warm' . $i . '_' . mt_rand(); };
  $warmServe($bustPath(0), 0); // prime

  // 0.3 ms is not a Twig render. The ?cb= variants all assemble the SAME blocks,
  // so the render cache serves them from memory and only the final HTML glue
  // runs. Drive genuinely different routes and verify the output matches the
  // route (title check) -- routing against a stale request is the $prepared bug
  // that previously made every route return the front page with HTTP 200.
  $routes = ['/', '/user/login', '/user/register', '/node/1', '/admin/content'];
  $variety = [];
  foreach ($routes as $rp) {
    try {
      \\Drupal\\Core\\Database\\Database::startLog('pwv');
      $a2 = $t();
      // NO cache-buster: plain URLs on a warm kernel. Correct output here is
      // only possible if the PageCache cid memo is cleared per request; with
      // the memo live every one of these returned "Welcome!" / HTTP 200.
      $rr = $warmServe($rp, 0);
      $ms2 = $t() - $a2;
      $lg = \\Drupal\\Core\\Database\\Database::getLog('pwv', 'default');
      $bd = (string) $rr->getContent();
      preg_match('#<title>(.*?)</title>#s', $bd, $mm);
      $variety[$rp] = [
        'ms' => round($ms2, 2),
        'q' => count($lg),
        'status' => $rr->getStatusCode(),
        'bytes' => strlen($bd),
        'title' => trim(strip_tags($mm[1] ?? 'none')),
        'page' => $rr->headers->get('x-drupal-cache') ?: '-',
        'uri' => $rr->headers->get('x-pw-uri') ?: '-',
      ];
    } catch (\\Throwable $e) {
      $variety[$rp] = ['err' => get_class($e) . ': ' . substr($e->getMessage(), 0, 70)];
    }
  }
  $out['warmroutes'] = $variety;

  [$qWarm, $rw] = $countQ(function() use ($warmServe, $bustPath) { return $warmServe($bustPath(1), 0); });
  $a = $t();
  for ($i = 0; $i < $n; $i++) { $warmServe($bustPath(100 + $i), 0); }
  $warmMs = ($t() - $a) / $n;

  // Everything below boots FRESH kernels, and DrupalKernel::boot() calls
  // \\Drupal::setContainer() -- so every \\Drupal:: static after this point
  // resolves against the last fresh kernel, not $warmK. Warm-kernel assertions
  // must run above this line; measuring them below made the cid reset target
  // the wrong container and looked like a Drupal bug.
  [$qCold, $rc] = $countQ(function() use ($serve, $bustPath) { return $serve($bustPath(2), 0); });
  $a = $t();
  for ($i = 0; $i < $n; $i++) { $serve($bustPath(200 + $i), 0); }
  $freshMs = ($t() - $a) / $n;

  $out['middlewarechain'] = $GLOBALS['__pw_chain'] ?? [];

  $out['warmkernel'] = [
    'warmQueries' => $qWarm,
    'freshQueries' => $qCold,
    'warmPerRequestMs' => round($warmMs, 2),
    'freshPerRequestMs' => round($freshMs, 2),
    'warmBytes' => strlen((string) $rw->getContent()),
    'freshBytes' => strlen((string) $rc->getContent()),
    'warmDynamic' => $rw->headers->get('x-drupal-dynamic-cache') ?: '-',
    'pageCacheInstancesReset' => $GLOBALS['__pw_cidreset'],
  ];
} catch (\\Throwable $e) {
  $out['warmkernel'] = ['err' => get_class($e) . ': ' . substr($e->getMessage(), 0, 140)];
}

foreach ([['/', 0], ['/user/login', 0]] as $c) { $out['anon(cached) ' . $c[0]] = $bench($c[0], 0, $n); }
foreach (['/', '/user/login'] as $p) { $out['anon(render) ' . $p] = $bench($p, 0, $n, true); }
foreach (['/', '/user/1', '/admin/content'] as $p) { $out['authed ' . $p] = $bench($p, 1, $n); }
foreach (['/', '/user/1'] as $p) { $out['authed(render) ' . $p] = $bench($p, 1, $n, true); }

echo json_encode($out);
`;
					const raw = await exec(inst, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 900) };
					}
					return Response.json(parsed);
				}

				case '/cache-headers': {
					// Never checked in 3,000+ lines: is dynamic_page_cache actually
					// HITTING on authenticated requests? If it is MISS, that is most of
					// the 7.2 ms and it is a config bug rather than a performance
					// problem. Free to check, so check it before optimizing anything.
					const inst = warm!;
					if (!inst.mounted) {
						await mountDrupalStreaming(inst.binary, env);
						inst.mounted = true;
					}
					await exec(inst, DRUPAL_BOOT);

					const probe = `<?php
$al = $GLOBALS['__pw_autoloader'];
$out = [];
$serve = function($path, $uid) use ($al) {
  $k = new \\Drupal\\Core\\DrupalKernel('prod', $al);
  $req = \\Symfony\\Component\\HttpFoundation\\Request::create($path, 'GET');
  \\Drupal\\Core\\DrupalKernel::bootEnvironment();
  $sp = \\Drupal\\Core\\DrupalKernel::findSitePath($req);
  $k->setSitePath($sp);
  \\Drupal\\Core\\Site\\Settings::initialize('/drupal', $sp, $al);
  $k->boot();
  if ($uid) {
    // page_cache's NoSessionOpen policy looks for the CONFIGURED session cookie
    // name (SESS<hash> / SSESS<hash>), not an arbitrary one. Without it the
    // policy says "cacheable", page_cache serves the ANONYMOUS cached page, and
    // the measurement is a 12,304-byte anonymous hit wearing an authenticated
    // label. The name is only knowable after boot(), hence the placement.
    try { $req->cookies->set(\\Drupal::service('session_configuration')->getOptions($req)['name'], str_repeat('a', 32)); } catch (\\Throwable $e) {}
    try { $u = \\Drupal\\user\\Entity\\User::load($uid); if ($u) { \\Drupal::service('account_switcher')->switchTo($u); } } catch (\\Throwable $e) {}
  }
  $resp = $k->handle($req, \\Symfony\\Component\\HttpKernel\\HttpKernelInterface::MAIN_REQUEST, false);
  // PHP's session state is process-global and the interpreter persists, so an
  // unclosed session makes the NEXT request throw "already started by PHP" out
  // of NativeSessionStorage::start(). A real per-request process closes this at
  // teardown; here nothing does.
  if (function_exists('session_status') && session_status() === PHP_SESSION_ACTIVE) { @session_write_close(); }
  return $resp;
};

foreach ([['anon','/',0], ['anon2','/',0], ['authed','/',1], ['authed2','/',1], ['authed_user','/user/1',1], ['authed_user2','/user/1',1]] as $c) {
  [$label, $path, $uid] = $c;
  try {
    $r = $serve($path, $uid);
    $out[$label] = [
      'page' => $r->headers->get('x-drupal-cache') ?: '-',
      'dynamic' => $r->headers->get('x-drupal-dynamic-cache') ?: '-',
      'status' => $r->getStatusCode(),
      'bytes' => strlen((string) $r->getContent()),
    ];
  } catch (\\Throwable $e) { $out[$label] = ['err' => substr($e->getMessage(), 0, 60)]; }
}
$out['modules'] = [
  'page_cache' => (int) \\Drupal::moduleHandler()->moduleExists('page_cache'),
  'dynamic_page_cache' => (int) \\Drupal::moduleHandler()->moduleExists('dynamic_page_cache'),
];

// Why is page_cache still HIT on an authenticated request? Ask the policy
// directly rather than inferring it from the header.
try {
  $req = \\Symfony\\Component\\HttpFoundation\\Request::create('/', 'GET');
  $sc = \\Drupal::service('session_configuration');
  $name = $sc->getOptions($req)['name'];
  $out['diag']['session_name'] = $name;
  $req->cookies->set($name, str_repeat('a', 32));
  $out['diag']['has_session_after_set'] = (int) $sc->hasSession($req);
  $policy = \\Drupal::service('page_cache_request_policy');
  $out['diag']['policy_class'] = get_class($policy);
  $out['diag']['policy_verdict'] = var_export($policy->check($req), TRUE);
  $out['diag']['current_uid_now'] = (int) \\Drupal::currentUser()->id();
} catch (\\Throwable $e) {
  $out['diag']['err'] = get_class($e) . ': ' . substr($e->getMessage(), 0, 120);
}
echo json_encode($out);
`;
					const raw = await exec(inst, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 800) };
					}
					return Response.json(parsed);
				}

				case '/evict': {
					// Which files are boot-only? Those are dead weight in MEMFS for the
					// rest of the isolate's life and can be unlinked.
					//
					// Also tests the premise behind the read-only FS backend. The claim
					// was "every file is resident twice -- once as blob-derived data,
					// once as filesystem state". That is true of the NAIVE mount, but
					// the streaming mount already releases the source, so the only
					// recoverable duplicate is MEMFS per-node overhead, not the bytes.
					const inst = warm!;
					const FS = inst.binary.FS;

					if (!inst.mounted) {
						await mountDrupalStreaming(inst.binary, env);
						inst.mounted = true;
					}

					// phase 1: record everything opened during boot
					const bootSet = new Set<string>();
					const origOpen = FS.open.bind(FS);
					FS.open = function (path: any, flags: any, mode: any) {
						if (typeof path === 'string') bootSet.add(path);
						return origOpen(path, flags, mode);
					};
					await exec(inst, DRUPAL_BOOT);
					const bootFiles = new Set(bootSet);

					// phase 2: record what the request path touches
					bootSet.clear();
					await exec(inst, DRUPAL_BOOT);
					await exec(inst, DRUPAL_EXERCISE);
					const requestFiles = new Set(bootSet);
					FS.open = origOpen;

					const bootOnly = [...bootFiles].filter(
						(f) => !requestFiles.has(f) && f.startsWith('/drupal/')
					);

					// size the eviction candidates
					const sizeOf = (p: string) => {
						try {
							return FS.stat(p).size;
						} catch {
							return 0;
						}
					};
					const bootOnlyBytes = bootOnly.reduce((a, p) => a + sizeOf(p), 0);
					const requestBytes = [...requestFiles]
						.filter((f) => f.startsWith('/drupal/'))
						.reduce((a, p) => a + sizeOf(p), 0);

					const before = linearMemory(inst.binary);
					let evicted = 0;
					for (const p of bootOnly) {
						try {
							FS.unlink(p);
							evicted++;
						} catch {
							/* directories and open handles resist */
						}
					}
					const after = linearMemory(inst.binary);

					// does Drupal still work with the boot-only set gone?
					const still = await exec(inst, DRUPAL_BOOT);
					let ok = null;
					try {
						ok = JSON.parse(still.slice(still.indexOf('{')));
					} catch {
						ok = { raw: still.slice(0, 300) };
					}

					return Response.json({
						bootFiles: bootFiles.size,
						requestFiles: requestFiles.size,
						bootOnlyFiles: bootOnly.length,
						bootOnlyBytes,
						requestPathBytes: requestBytes,
						evicted,
						linearBefore: before,
						linearAfter: after,
						stillWorks: {
							status: ok.status,
							bytes: ok.bytes,
							error: ok.error ?? null
						}
					});
				}

				case '/authed-cost3': {
					// Fresh kernel per request -- which is the production strategy
					// anyway (2-4 ms, isolation by construction), and independently
					// fixes PageCache::$cid being memoized on a persistent middleware
					// instance. That memo is why every earlier per-route number was
					// secretly the front page.
					const n = Number(url.searchParams.get('n') ?? 20);
					const inst = warm!;
					if (!inst.mounted) {
						await mountDrupalStreaming(inst.binary, env);
						inst.mounted = true;
					}
					await exec(inst, DRUPAL_BOOT);

					const probe = `<?php
$n = ${n};
$t = function() { return microtime(true) * 1000; };
$al = $GLOBALS['__pw_autoloader'];

// one fresh kernel + one request, the disposable-kernel shape
$serve = function($path, $uid = 0) use ($al) {
  $k = new \\Drupal\\Core\\DrupalKernel('prod', $al);
  $req = \\Symfony\\Component\\HttpFoundation\\Request::create($path, 'GET');
  \\Drupal\\Core\\DrupalKernel::bootEnvironment();
  $sp = \\Drupal\\Core\\DrupalKernel::findSitePath($req);
  $k->setSitePath($sp);
  \\Drupal\\Core\\Site\\Settings::initialize('/drupal', $sp, $al);
  $k->boot();
  if ($uid) {
    // page_cache's NoSessionOpen policy keys off the CONFIGURED session cookie
    // name from getOptions()['name'] (getName() is protected). Without it the
    // policy returns ALLOW, page_cache serves the ANONYMOUS cached page, and an
    // "authenticated" measurement is really a 12,304-byte anonymous hit.
    try { $req->cookies->set(\\Drupal::service('session_configuration')->getOptions($req)['name'], str_repeat('a', 32)); } catch (\\Throwable $e) {}
    try {
      $u = \\Drupal\\user\\Entity\\User::load($uid);
      if ($u) { \\Drupal::service('account_switcher')->switchTo($u); }
    } catch (\\Throwable $e) {}
  }
  $resp = $k->handle($req, \\Symfony\\Component\\HttpKernel\\HttpKernelInterface::MAIN_REQUEST, false);
  // PHP's session state is process-global and the interpreter persists, so an
  // unclosed session makes the NEXT request throw "already started by PHP" out
  // of NativeSessionStorage::start(). A real per-request process closes this at
  // teardown; here nothing does.
  if (function_exists('session_status') && session_status() === PHP_SESSION_ACTIVE) { @session_write_close(); }
  return $resp;
};

$bench = function($path, $uid, $n) use ($serve, $t) {
  try { $r0 = $serve($path, $uid); }
  catch (\\Throwable $e) { return ['err' => get_class($e) . ': ' . substr($e->getMessage(), 0, 60)]; }
  $body = (string) $r0->getContent();
  preg_match('#<title>(.*?)</title>#s', $body, $m);
  $a = $t();
  for ($i = 0; $i < $n; $i++) { $serve($path, $uid); }
  $ms = $t() - $a;
  return [
    'perRequestMs' => round($ms / $n, 2),
    'status' => $r0->getStatusCode(),
    'bytes' => strlen($body),
    'title' => trim($m[1] ?? 'none'),
  ];
};

$out = ['anon' => [], 'authed' => []];
foreach (['/', '/user/login'] as $p) { $out['anon'][$p] = $bench($p, 0, $n); }
foreach (['/', '/user/1', '/admin/content', '/admin/modules'] as $p) {
  $out['authed'][$p] = $bench($p, 1, max(5, intdiv($n, 2)));
}

$titles = [];
foreach (['anon','authed'] as $g) { foreach ($out[$g] as $r) { if (isset($r['title'])) $titles[] = $r['title']; } }
$out['distinct_titles'] = count(array_unique($titles));
$out['routing_varied'] = count(array_unique($titles)) > 1;
$out['peakMemMb'] = round(memory_get_peak_usage(true) / 1048576, 1);
echo json_encode($out);
`;
					const raw = await exec(inst, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 1100) };
					}
					return Response.json({
						...parsed,
						linearMemoryBytes: linearMemory(inst.binary)
					});
				}

				case '/authed-cost2': {
					// Authenticated CPU, with the two defects that invalidated the first
					// attempt now fixed: preHandle is forced to re-run so routing
					// actually varies, and exception classes are packed so failures are
					// not swallowed into a front-page 200.
					//
					// Byte counts are reported per route and MUST differ. Identical
					// lengths across paths is exactly how the first attempt lied.
					const n = Number(url.searchParams.get('n') ?? 30);
					const inst = warm!;
					if (!inst.mounted) {
						await mountDrupalStreaming(inst.binary, env);
						inst.mounted = true;
					}
					await exec(inst, DRUPAL_BOOT);

					const probe = `<?php
$n = ${n};
$t = function() { return microtime(true) * 1000; };
$k = $GLOBALS['__pw_kernel'];
$rp = new ReflectionProperty(\\Drupal\\Core\\DrupalKernel::class, 'prepared');
$rp->setAccessible(true);

$serve = function($path) use ($k, $rp) {
  $rp->setValue($k, false);
  try {
    $st = \\Drupal::service('request_stack');
    while ($st->getCurrentRequest() !== null) { $st->pop(); }
  } catch (\\Throwable $e) {}
  $req = \\Symfony\\Component\\HttpFoundation\\Request::create($path, 'GET');
  $resp = $k->handle($req, \\Symfony\\Component\\HttpKernel\\HttpKernelInterface::MAIN_REQUEST, false);
  // PHP's session state is process-global and the interpreter persists, so an
  // unclosed session makes the NEXT request throw "already started by PHP" out
  // of NativeSessionStorage::start(). A real per-request process closes this at
  // teardown; here nothing does.
  if (function_exists('session_status') && session_status() === PHP_SESSION_ACTIVE) { @session_write_close(); }
  return $resp;
};

$bench = function($path, $n) use ($serve, $t) {
  try { $r0 = $serve($path); } catch (\\Throwable $e) { return ['err' => substr($e->getMessage(), 0, 70)]; }
  $bytes = strlen((string) $r0->getContent());
  $status = $r0->getStatusCode();
  $a = $t();
  for ($i = 0; $i < $n; $i++) { $serve($path); }
  $ms = $t() - $a;
  return ['perRequestMs' => round($ms / $n, 3), 'status' => $status, 'bytes' => $bytes];
};

$out = ['anon' => [], 'authed' => []];
foreach (['/', '/user/login', '/node/1'] as $p) { $out['anon'][$p] = $bench($p, $n); }

try {
  $u = \\Drupal\\user\\Entity\\User::load(1);
  \\Drupal::service('account_switcher')->switchTo($u);
  $out['uid'] = (int) \\Drupal::currentUser()->id();
  foreach (['/', '/user/1', '/admin/content', '/admin/modules', '/node/1/edit'] as $p) {
    $out['authed'][$p] = $bench($p, max(5, intdiv($n, 3)));
  }
  \\Drupal::service('account_switcher')->switchBack();
} catch (\\Throwable $e) {
  $out['authed_err'] = get_class($e) . ': ' . substr($e->getMessage(), 0, 110);
}

// the validity check: distinct byte counts prove routing actually varied
$lens = [];
foreach (['anon','authed'] as $g) { foreach ($out[$g] as $p => $r) { if (isset($r['bytes'])) $lens[] = $r['bytes']; } }
$out['distinct_response_sizes'] = count(array_unique($lens));
$out['routing_varied'] = count(array_unique($lens)) > 1;
$out['peakMemMb'] = round(memory_get_peak_usage(true) / 1048576, 1);
echo json_encode($out);
`;
					const raw = await exec(inst, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 1000) };
					}
					return Response.json({
						...parsed,
						linearMemoryBytes: linearMemory(inst.binary)
					});
				}

				case '/authed-cost': {
					// The real worst case. Every CPU figure so far is anonymous and
					// cached; an authenticated render bypasses cache_page entirely and
					// runs access checks, node grants and the admin theme.
					const n = Number(url.searchParams.get('n') ?? 50);
					const inst = warm!;
					if (!inst.mounted) {
						await mountDrupalStreaming(inst.binary, env);
						inst.mounted = true;
					}
					await exec(inst, DRUPAL_BOOT);

					const probe = `<?php
$n = ${n};
$out = [];
$t = function() { return microtime(true) * 1000; };
$k = $GLOBALS['__pw_kernel'];

$bench = function($label, $path, $n) use ($t, $k, &$out) {
  // warm the path once so we measure steady state, not first-touch discovery
  try { $k->handle(\\Symfony\\Component\\HttpFoundation\\Request::create($path . '?cb=warm', 'GET')); } catch (\\Throwable $e) {}
  $a = $t(); $status = 0;
  for ($i = 0; $i < $n; $i++) {
    try {
      $r = $k->handle(\\Symfony\\Component\\HttpFoundation\\Request::create($path . '?cb=' . $i, 'GET'));
      $status = $r->getStatusCode();
    } catch (\\Throwable $e) { $status = 'ERR:' . substr($e->getMessage(), 0, 50); break; }
  }
  $ms = $t() - $a;
  // bytes and a content marker: a 200 that returns almost nothing is a
  // redirect or a cached shell, not a render. 0.2 ms for a View would be
  // implausible, so verify the work actually happened.
  $bytes = 0; $marker = '';
  try {
    $r = $k->handle(\\Symfony\\Component\\HttpFoundation\\Request::create($path . '?cb=verify', 'GET'));
    $body = (string) $r->getContent();
    $bytes = strlen($body);
    $marker = str_contains($body, '<title>') ? 'has-title' : substr(strip_tags($body), 0, 40);
  } catch (\\Throwable $e) { $marker = 'ERR'; }
  $out[$label] = [
    'perRequestMs' => round($ms / $n, 3),
    'totalMs' => round($ms, 1),
    'status' => $status,
    'bytes' => $bytes,
    'body' => $marker,
  ];
};

// anonymous, cache-busted: no page-cache hit, so this is a real render
$bench('anon_uncached', '/', $n);

// authenticated
try {
  $u = \\Drupal\\user\\Entity\\User::load(1);
  \\Drupal::service('account_switcher')->switchTo($u);
  $out['uid'] = (int) \\Drupal::currentUser()->id();
  $bench('authed_front', '/', $n);
  $bench('authed_admin_content', '/admin/content', max(5, intdiv($n, 5)));
  $bench('authed_user_page', '/user/1', max(5, intdiv($n, 5)));
  \\Drupal::service('account_switcher')->switchBack();
} catch (\\Throwable $e) {
  $out['authed_err'] = get_class($e) . ': ' . substr($e->getMessage(), 0, 100);
}

$out['peakMemMb'] = round(memory_get_peak_usage(true) / 1048576, 1);
echo json_encode($out);
`;
					const raw = await exec(inst, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 900) };
					}
					return Response.json({
						...parsed,
						linearMemoryBytes: linearMemory(inst.binary)
					});
				}

				case '/yaml-bench': {
					// Prices the 83,551 bytes ext-yaml costs, against the same .yml
					// corpus boot actually opens. Symfony's pure-PHP parser measured
					// 201 ms for 146 files; this is the same work through libyaml.
					const binary = warm!.binary;
					try {
						binary.FS.mkdir('/drupal');
					} catch {
						/* exists */
					}
					if (!warm!.mounted) {
						await mountDrupalStreaming(binary, env);
						warm!.mounted = true;
					}
					const probe = `<?php
$out = ['ext_yaml' => extension_loaded('yaml')];

$ymls = [];
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator('/drupal', FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
  $p = $f->getPathname();
  if (str_ends_with($p, '.yml')) { $ymls[] = $p; }
  if (count($ymls) >= 300) break;
}
$srcs = [];
$bytes = 0;
foreach ($ymls as $p) { $s = @file_get_contents($p); if ($s !== false) { $srcs[] = $s; $bytes += strlen($s); } }
$out['files'] = count($srcs);
$out['bytes'] = $bytes;

$t = function() { return microtime(true) * 1000; };

// libyaml
if (function_exists('yaml_parse')) {
  $a = $t(); $ok = 0;
  foreach ($srcs as $s) { $r = @yaml_parse($s); if ($r !== false) { $ok++; } }
  $ms = $t() - $a;
  $out['ext_yaml_ms'] = round($ms, 1);
  $out['ext_yaml_parsed'] = $ok;
  $out['ext_yaml_mb_s'] = round(($bytes / 1048576) / ($ms / 1000), 2);
}

// Symfony pure-PHP, loaded straight from the mounted tree
$sf = '/drupal/vendor/symfony/yaml/Yaml.php';
if (file_exists('/drupal/vendor/autoload.php')) {
  if (!isset($GLOBALS['__pw_autoloader'])) { $GLOBALS['__pw_autoloader'] = require_once '/drupal/vendor/autoload.php'; }
  if (class_exists('Symfony\\\\Component\\\\Yaml\\\\Yaml')) {
    $a = $t(); $ok = 0;
    foreach ($srcs as $s) { try { \\Symfony\\Component\\Yaml\\Yaml::parse($s); $ok++; } catch (\\Throwable $e) {} }
    $ms = $t() - $a;
    $out['symfony_ms'] = round($ms, 1);
    $out['symfony_parsed'] = $ok;
    $out['symfony_mb_s'] = round(($bytes / 1048576) / ($ms / 1000), 2);
  }
}
if (isset($out['ext_yaml_ms']) && isset($out['symfony_ms']) && $out['ext_yaml_ms'] > 0) {
  $out['speedup'] = round($out['symfony_ms'] / $out['ext_yaml_ms'], 1);
  $out['saved_ms'] = round($out['symfony_ms'] - $out['ext_yaml_ms'], 1);
}
echo json_encode($out);
`;
					const raw = await exec(warm!, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 800) };
					}
					return Response.json(parsed);
				}

				case '/isolation-test': {
					// The differential: N heterogeneous requests through ONE isolate,
					// with and without the reset, asserting state does not carry.
					//
					// A test that cannot fail proves nothing, so the no-reset arm must
					// leak. If both arms come back clean the harness is broken.
					const n = Number(url.searchParams.get('n') ?? 50);
					const probe = `<?php
$n = ${n};
$results = ['with_reset' => [], 'without_reset' => []];

// mirrors RequestResetter::reset() -- drupal_static() last, because resetting a
// service can repopulate statics
$doReset = function() {
  try {
    if (\\Drupal::hasService('account_switcher')) {
      $sw = \\Drupal::service('account_switcher');
      for ($i = 0; $i < 8; $i++) {
        try { $sw->switchBack(); } catch (\\Throwable $e) { break; }
      }
    }
  } catch (\\Throwable $e) {}
  if (function_exists('drupal_static_reset')) { drupal_static_reset(); }
  unset($GLOBALS['pw_req_state']);
};

$runOne = function($i, $reset) use ($doReset) {
  // each "request" writes identity-shaped state, as Drupal does
  $ref = &drupal_static('pw_req_state');
  $ref = 'request-' . $i;
  $GLOBALS['pw_req_state'] = 'global-' . $i;

  $req = \\Symfony\\Component\\HttpFoundation\\Request::create('/', 'GET');
  $res = $GLOBALS['__pw_kernel']->handle($req);

  if ($reset) { $doReset(); }

  // what does the NEXT request observe?
  return [
    'static' => drupal_static('pw_req_state'),
    'global' => $GLOBALS['pw_req_state'] ?? null,
    'status' => $res->getStatusCode(),
  ];
};

foreach ([true, false] as $reset) {
  $key = $reset ? 'with_reset' : 'without_reset';
  $leaks = 0; $statuses = [];
  for ($i = 0; $i < $n; $i++) {
    $obs = $runOne($i, $reset);
    $statuses[$obs['status']] = true;
    // a leak is observing state from THIS request after the boundary
    if ($obs['static'] !== null || $obs['global'] !== null) { $leaks++; }
  }
  $results[$key] = [
    'requests' => $n,
    'leaks' => $leaks,
    'leak_rate' => round($leaks / $n, 3),
    'statuses' => array_keys($statuses),
  ];
  $doReset();
}

$results['verdict'] = [
  'reset_closes_leak' => ($results['with_reset']['leaks'] === 0),
  'control_leaks' => ($results['without_reset']['leaks'] > 0),
  'harness_valid' => ($results['without_reset']['leaks'] > 0),
];
echo json_encode($results);
`;
					const raw = await exec(warm!, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 900) };
					}
					return Response.json(parsed);
				}

				case '/boot-profile': {
					// The 1,020 ms of "everything else" is the whole game and is
					// currently a list of suspects. Turn it into numbers.
					//
					// Suspects, each with a different fix:
					//   - plugin discovery rebuilding because a cache key is
					//     environment-dependent (same failure shape as the Twig
					//     uniqid() prefix) -> a cache-key bug, not a perf problem
					//   - Symfony's pure-PHP YAML parser standing in for ext-yaml
					//   - entity type / field definition discovery
					const probe = `<?php
$out = [];
$t = function() { return microtime(true) * 1000; };

// --- are the discovery caches HITTING, or silently rebuilding? ---
try {
  $pdo = new PDO('sqlite:/drupal/sites/default/files/.sqlite');
  $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  foreach (['cache_discovery','cache_bootstrap','cache_config','cache_default'] as $tbl) {
    try {
      $r = $pdo->query("SELECT COUNT(*) c, COALESCE(SUM(LENGTH(data)),0) b FROM $tbl")->fetch(PDO::FETCH_ASSOC);
      $out['cache'][$tbl] = ['rows' => (int)$r['c'], 'bytes' => (int)$r['b']];
    } catch (\\Throwable $e) { $out['cache'][$tbl] = 'missing'; }
  }
} catch (\\Throwable $e) { $out['cache_err'] = substr($e->getMessage(),0,100); }

// --- entity type definitions (cache_discovery backed) ---
$a = $t();
try {
  $defs = \\Drupal::entityTypeManager()->getDefinitions();
  $out['entity_defs_count'] = count($defs);
} catch (\\Throwable $e) { $out['entity_defs_err'] = substr($e->getMessage(),0,90); }
$out['entity_defs_ms'] = round($t() - $a, 1);

// second call proves whether it was cached in-process
$a = $t();
try { \\Drupal::entityTypeManager()->getDefinitions(); } catch (\\Throwable $e) {}
$out['entity_defs_ms_2'] = round($t() - $a, 1);

// --- field definitions for a real entity type ---
$a = $t();
try {
  $f = \\Drupal::service('entity_field.manager')->getFieldStorageDefinitions('node');
  $out['field_defs_count'] = count($f);
} catch (\\Throwable $e) { $out['field_defs_err'] = substr($e->getMessage(),0,90); }
$out['field_defs_ms'] = round($t() - $a, 1);

// --- a spread of plugin managers: discovery is the usual cold-boot hot spot ---
$managers = ['plugin.manager.block','plugin.manager.field.field_type','plugin.manager.entity_reference_selection','plugin.manager.menu.link','plugin.manager.condition'];
foreach ($managers as $m) {
  $a = $t();
  try {
    $d = \\Drupal::service($m)->getDefinitions();
    $out['plugins'][$m] = ['ms' => round($t() - $a, 1), 'n' => count($d)];
  } catch (\\Throwable $e) {
    $out['plugins'][$m] = ['err' => substr($e->getMessage(), 0, 60)];
  }
}

// --- YAML: ext-yaml is absent, so Symfony's pure-PHP parser is doing the work.
//     Measure it against the real .yml corpus in the pack. ---
$out['ext_yaml'] = extension_loaded('yaml');
$ymls = [];
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator('/drupal', FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
  $p = $f->getPathname();
  if (str_ends_with($p, '.yml')) { $ymls[] = $p; }
  if (count($ymls) >= 300) break;
}
$bytes = 0; $parsed = 0;
$a = $t();
foreach ($ymls as $p) {
  $src = @file_get_contents($p);
  if ($src === false) continue;
  $bytes += strlen($src);
  try { \\Symfony\\Component\\Yaml\\Yaml::parse($src); $parsed++; } catch (\\Throwable $e) {}
}
$ymlMs = $t() - $a;
$out['yaml'] = [
  'files' => $parsed,
  'bytes' => $bytes,
  'ms' => round($ymlMs, 1),
  'ms_per_file' => $parsed ? round($ymlMs / $parsed, 3) : null,
];

echo json_encode($out);
`;
					const raw = await exec(warm!, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 1200) };
					}
					return Response.json(parsed);
				}

				case '/boot-breakdown': {
					// Decides the isolation strategy, so it must exist before that
					// strategy is chosen.
					//
					// opcache attacks PARSING. It does nothing for the 1.4 MB
					// cache_container unserialize plus service instantiation. A
					// disposable kernel pays the container cost on every spawn even
					// with a perfect bytecode cache, so the parse/container split
					// decides whether disposable-per-authenticated-request is
					// affordable at all.
					const probe = `<?php
$out = [];
$t = function() { return microtime(true) * 1000; };

// 1. Cost of unserializing the container blob ALONE, straight from SQLite,
//    with no Drupal involved. This is the floor a disposable kernel pays.
try {
  $pdo = new PDO('sqlite:/drupal/sites/default/files/.sqlite');
  $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  $row = $pdo->query("SELECT data, LENGTH(data) AS len FROM cache_container LIMIT 1")->fetch(PDO::FETCH_ASSOC);
  $blob = $row['data'] ?? '';
  $out['container_bytes'] = (int) ($row['len'] ?? 0);

  $a = $t();
  $u = @unserialize($blob);
  $out['container_unserialize_ms'] = round($t() - $a, 1);
  $out['container_unserialized_ok'] = ($u !== false);

  // repeat to separate first-touch from steady state
  $a = $t();
  @unserialize($blob);
  $out['container_unserialize_ms_2'] = round($t() - $a, 1);
} catch (\\Throwable $e) {
  $out['container_err'] = substr($e->getMessage(), 0, 120);
}

// 2. Cost of PARSING PHP source with no bytecode cache. Re-including already
//    -included files is free, so compile a representative sample fresh via
//    token_get_all(), which exercises the lexer/parser path opcache removes.
$files = array_slice(array_filter(get_included_files(), function($f) {
  return str_starts_with($f, '/drupal/') && str_ends_with($f, '.php');
}), 0, 400);
$bytes = 0;
$a = $t();
foreach ($files as $f) {
  $src = @file_get_contents($f);
  if ($src === false) continue;
  $bytes += strlen($src);
  @token_get_all($src);
}
$parseMs = $t() - $a;
$out['parse_sample_files'] = count($files);
$out['parse_sample_bytes'] = $bytes;
$out['parse_sample_ms'] = round($parseMs, 1);
$out['parse_ms_per_file'] = count($files) ? round($parseMs / count($files), 3) : null;
$out['parse_projected_1799_files_ms'] = count($files) ? round($parseMs / count($files) * 1799, 1) : null;

// 3. REAL parse+compile cost. token_get_all() only lexes; actual compilation
//    builds an AST and emits opcodes, which is what opcache caches. Measure by
//    including files the run has NOT already loaded -- those pay the full cost.
$loaded = array_flip(get_included_files());
$candidates = [];
// scan the whole mounted tree: the trace-based pack loaded ~1,801 of 3,557
// files, so the remainder are genuinely uncompiled and pay full cost
$it = new RecursiveIteratorIterator(
  new RecursiveDirectoryIterator('/drupal', FilesystemIterator::SKIP_DOTS),
  RecursiveIteratorIterator::SELF_FIRST
);
foreach ($it as $f) {
  $p = $f->getPathname();
  if (!str_ends_with($p, '.php')) continue;
  if (isset($loaded[$p])) continue;
  // skip anything that executes on include rather than just declaring
  if (str_contains($p, '/sites/default/files/')) continue;
  $candidates[] = $p;
  if (count($candidates) >= 300) break;
}
$compiled = 0; $cbytes = 0; $failed = 0;
$a = $t();
foreach ($candidates as $p) {
  try { @include_once $p; $compiled++; $cbytes += @filesize($p) ?: 0; }
  catch (\\Throwable $e) { $failed++; }
}
$compileMs = $t() - $a;
$out['compile_files'] = $compiled;
$out['compile_failed'] = $failed;
$out['compile_bytes'] = $cbytes;
$out['compile_ms'] = round($compileMs, 1);
$out['compile_ms_per_file'] = $compiled ? round($compileMs / $compiled, 3) : null;
$out['compile_projected_1799_ms'] = $compiled ? round($compileMs / $compiled * 1799, 1) : null;

echo json_encode($out);
`;
					const raw = await exec(warm!, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 900) };
					}
					return Response.json(parsed);
				}

				case '/warm-precision': {
					// Warm was reported as "2-3 ms", which is at the precision floor:
					// workerd returns integer-millisecond timers, so 2 vs 3 is one tick
					// and 2.0 cannot be distinguished from 3.9. Amortize over N.
					const n = Number(url.searchParams.get('n') ?? 500);
					const inst = warm!;
					if (!inst.mounted) {
						await mountDrupalStreaming(inst.binary, env);
						inst.mounted = true;
					}
					await exec(inst, DRUPAL_BOOT);

					const code = `<?php
$n = ${n};
$t0 = microtime(true);
for ($i = 0; $i < $n; $i++) {
  $req = \\Symfony\\Component\\HttpFoundation\\Request::create('/', 'GET');
  $res = $GLOBALS['__pw_kernel']->handle($req);
}
$el = (microtime(true) - $t0) * 1000;
echo json_encode([
  'n' => $n,
  'totalMs' => round($el, 1),
  'perRequestMs' => round($el / $n, 4),
  'lastStatus' => $res->getStatusCode(),
]);
`;
					const t0 = Date.now();
					const raw = await exec(inst, code);
					const wall = Date.now() - t0;
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 600) };
					}
					return Response.json({ ...parsed, outerWallMs: wall });
				}

				case '/opcache': {
					// The largest unexplored cold-start lever.
					//
					// The document asserted "there is no opcache in wasm". That is true
					// of SHM opcache, which needs shared memory emscripten does not
					// provide -- but opcache.file_cache_only=1 writes compiled bytecode
					// to disk and reads it back with no SHM at all, which is exactly a
					// single-process model. The Makefile only passes
					// --disable-opcache-jit, which implies opcache itself may be built.
					//
					// get_loaded_extensions() excludes Zend extensions, which is why the
					// earlier probe missed it.
					const probe = `<?php
$out = [];
$out['zend_extensions'] = get_loaded_extensions(true);
$out['opcache_loaded'] = extension_loaded('Zend OPcache');
$out['has_status_fn'] = function_exists('opcache_get_status');
$out['has_compile_fn'] = function_exists('opcache_compile_file');
foreach (['opcache.enable','opcache.enable_cli','opcache.file_cache','opcache.file_cache_only','opcache.jit'] as $k) {
  $out['ini'][$k] = ini_get($k);
}
if (function_exists('opcache_get_status')) {
  $s = @opcache_get_status(false);
  $out['status'] = is_array($s) ? array_intersect_key($s, array_flip(['opcache_enabled','file_cache_only','opcache_statistics'])) : $s;
}
echo json_encode($out);
`;
					const raw = await exec(warm!, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 800) };
					}
					return Response.json(parsed);
				}

				case '/isolation': {
					// The security question, not a performance one.
					//
					// The interpreter persists between requests and cannot be torn down
					// cheaply, so Drupal's statics, its container, and the current-user
					// service survive from one request to the next. Drupal assumes a
					// fresh process. If the account set during request N is still set
					// during request N+1, that is one user's identity leaking into
					// another's render -- silently.
					//
					// This drives it directly: switch to uid 1, then serve an
					// "anonymous" request and ask who Drupal thinks is logged in.
					const probe = `<?php
$out = [];
try {
  $uidOf = function() {
    try { return (int) \\Drupal::currentUser()->id(); }
    catch (\\Throwable $e) { return 'ERR:' . substr($e->getMessage(), 0, 60); }
  };

  $out['uid_at_start'] = $uidOf();

  // Mechanism probe: does process-level state survive into the next request?
  // drupal_static() is the canonical per-request cache -- Drupal resets it
  // between requests in a normal SAPI because the process dies.
  $ref = &drupal_static('pw_leak_probe');
  $ref = 'set-by-request-1';
  $out['static_set'] = drupal_static('pw_leak_probe');

  // an account object placed on a service that is not reset per request
  $GLOBALS['pw_fake_account'] = 'uid-1-identity';

  // now serve a fresh "anonymous" request through the same kernel
  $req = \\Symfony\\Component\\HttpFoundation\\Request::create('/', 'GET');
  $res = $GLOBALS['__pw_kernel']->handle($req);
  $out['next_request_status'] = $res->getStatusCode();
  $out['uid_during_next_request'] = $uidOf();

  // the leak test: is request 1's state still visible after request 2 ran?
  $out['static_after_next_request'] = drupal_static('pw_leak_probe');
  $out['global_after_next_request'] = $GLOBALS['pw_fake_account'] ?? '(gone)';
  $out['container_object_id'] = spl_object_id(\\Drupal::getContainer());
  $out['LEAKED'] = (drupal_static('pw_leak_probe') === 'set-by-request-1');
} catch (\\Throwable $e) {
  $out['fatal'] = get_class($e) . ': ' . substr($e->getMessage(), 0, 160);
}
echo json_encode($out);
`;
					const raw = await exec(warm!, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 900) };
					}
					return Response.json(parsed);
				}

				case '/wal-roundtrip': {
					// The persistence design is: keep the base file plus an append-only
					// WAL, ship both to DO storage, restore on cold boot. What matters
					// is not that WAL engages -- already confirmed -- but that the
					// round trip RECOVERS. A wrong restore either silently drops writes
					// or refuses to open, and both are worse than failing loudly.
					const probe = `<?php
$out = [];
$dir = '/tmp/wal';
@mkdir($dir);
$db = $dir . '/t.sqlite';
foreach ([$db, $db . '-wal', $db . '-shm'] as $f) { @unlink($f); }

function openDb($path) {
  $p = new PDO('sqlite:' . $path);
  $p->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  return $p;
}

// --- write with WAL, do NOT checkpoint: writes live in the -wal sidecar ---
$pdo = openDb($db);
$out['mode'] = $pdo->query('PRAGMA journal_mode=WAL')->fetchColumn();
$pdo->exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
for ($i = 1; $i <= 200; $i++) { $pdo->exec("INSERT INTO t (v) VALUES ('row" . $i . "')"); }
$out['rows_before'] = (int) $pdo->query('SELECT COUNT(*) FROM t')->fetchColumn();
$out['base_size'] = filesize($db);
$out['wal_size'] = file_exists($db . '-wal') ? filesize($db . '-wal') : 0;

// snapshot exactly what would go to DO storage
$baseBytes = file_get_contents($db);
$walBytes = file_exists($db . '-wal') ? file_get_contents($db . '-wal') : '';
$pdo = null;

// --- teardown: everything the isolate held is gone ---
foreach ([$db, $db . '-wal', $db . '-shm'] as $f) { @unlink($f); }
$out['torn_down'] = !file_exists($db);

// --- restore base + WAL, no -shm (it must be rebuilt by SQLite) ---
file_put_contents($db, $baseBytes);
if ($walBytes !== '') { file_put_contents($db . '-wal', $walBytes); }
try {
  $pdo = openDb($db);
  $out['rows_after_restore'] = (int) $pdo->query('SELECT COUNT(*) FROM t')->fetchColumn();
  $out['sample'] = $pdo->query('SELECT v FROM t ORDER BY id DESC LIMIT 1')->fetchColumn();
  $pdo = null;
} catch (\\Throwable $e) { $out['restore_err'] = $e->getMessage(); }

// --- control: restore base WITHOUT the WAL. Writes must be LOST, proving the
// WAL is load-bearing and the test is not passing by accident ---
foreach ([$db, $db . '-wal', $db . '-shm'] as $f) { @unlink($f); }
file_put_contents($db, $baseBytes);
try {
  $pdo = openDb($db);
  $out['rows_base_only'] = (int) $pdo->query('SELECT COUNT(*) FROM t')->fetchColumn();
  $pdo = null;
} catch (\\Throwable $e) { $out['base_only_err'] = substr($e->getMessage(), 0, 90); }

// --- checkpointed variant: after a checkpoint the base file should stand alone ---
foreach ([$db, $db . '-wal', $db . '-shm'] as $f) { @unlink($f); }
$pdo = openDb($db);
$pdo->query('PRAGMA journal_mode=WAL');
$pdo->exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
for ($i = 1; $i <= 200; $i++) { $pdo->exec("INSERT INTO t (v) VALUES ('row" . $i . "')"); }
$out['checkpoint'] = json_encode($pdo->query('PRAGMA wal_checkpoint(TRUNCATE)')->fetch(PDO::FETCH_NUM));
$ckBase = file_get_contents($db);
$pdo = null;
foreach ([$db, $db . '-wal', $db . '-shm'] as $f) { @unlink($f); }
file_put_contents($db, $ckBase);
try {
  $pdo = openDb($db);
  $out['rows_after_checkpoint_baseonly'] = (int) $pdo->query('SELECT COUNT(*) FROM t')->fetchColumn();
} catch (\\Throwable $e) { $out['ck_err'] = substr($e->getMessage(), 0, 90); }

echo json_encode($out);
`;
					const raw = await exec(warm!, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 900) };
					}
					return Response.json(parsed);
				}

				case '/glob-diff': {
					// Differential: Drupal's LIKE BINARY (reference, pure PHP) versus
					// builtin GLOB with a translated pattern (candidate). Any mismatch
					// is a silently-wrong query on the DO SQLite path.
					const n = Number(url.searchParams.get('n') ?? 2000);
					const seed = Number(url.searchParams.get('seed') ?? 1);
					// control=1 feeds the RAW pattern to GLOB instead of the translated
					// one. It must produce mismatches -- if it does not, the harness is
					// not exercising the divergence and the clean run means nothing.
					const control = url.searchParams.get('control') === '1';
					const cases = generateCases(n, seed).map(([p, s]) => [
						p,
						s,
						control ? p : likeToGlob(p)
					]);

					const probe = `<?php
$cases = json_decode(<<<'JSON'
${JSON.stringify(cases)}
JSON, true);

// Reference: core/modules/sqlite/.../Connection::sqlFunctionLikeBinary()
// guarded because the interpreter persists across requests
if (!function_exists('ref_like_binary')) {
  eval('function ref_like_binary($pattern, $subject) {
    $p = str_replace(["%", "_"], [".*?", "."], preg_quote($pattern, "/"));
    return preg_match("/^" . $p . "$/", $subject) ? 1 : 0;
  }');
}

$pdo = new PDO('sqlite::memory:');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$stmt = $pdo->prepare('SELECT CASE WHEN ? GLOB ? THEN 1 ELSE 0 END');

$mismatch = [];
$checked = 0;
foreach ($cases as $c) {
  [$pattern, $subject, $globPattern] = $c;
  $expected = ref_like_binary($pattern, $subject);
  $stmt->execute([$subject, $globPattern]);
  $actual = (int) $stmt->fetchColumn();
  $checked++;
  if ($expected !== $actual) {
    if (count($mismatch) < 12) {
      $mismatch[] = ['pattern' => $pattern, 'subject' => $subject, 'glob' => $globPattern, 'ref' => $expected, 'got' => $actual];
    }
  }
}
echo json_encode(['checked' => $checked, 'mismatches' => count($mismatch), 'samples' => $mismatch]);
`;
					const raw = await exec(warm!, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 900) };
					}
					return Response.json({ n, seed, ...parsed });
				}

				case '/sqlite-caps': {
					// Does this SQLite build support WAL? The persist-to-DO-storage
					// design depends on it: without WAL, every mutating request has to
					// serialize the whole database file back, which would destroy the
					// 3 ms warm path. With WAL, the base file plus an append-only log
					// can be checkpointed on an alarm instead.
					const probe = `<?php
$out = [];
try {
  $pdo = new PDO('sqlite:/tmp/waltest.sqlite');
  $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  $out['default_mode'] = $pdo->query('PRAGMA journal_mode')->fetchColumn();
  $out['set_wal'] = $pdo->query('PRAGMA journal_mode=WAL')->fetchColumn();
  $out['after_set'] = $pdo->query('PRAGMA journal_mode')->fetchColumn();
  $out['sqlite_version'] = $pdo->query('SELECT sqlite_version()')->fetchColumn();

  // does the WAL sidecar actually appear? MEMFS has no mmap, which is how
  // SQLite normally implements the WAL index
  $pdo->exec('CREATE TABLE IF NOT EXISTS t (a INTEGER)');
  $pdo->exec('INSERT INTO t VALUES (1)');
  $out['wal_file'] = file_exists('/tmp/waltest.sqlite-wal');
  $out['shm_file'] = file_exists('/tmp/waltest.sqlite-shm');
  $out['rows'] = (int) $pdo->query('SELECT COUNT(*) FROM t')->fetchColumn();
} catch (\\Throwable $e) {
  $out['err'] = get_class($e) . ': ' . $e->getMessage();
}
echo json_encode($out);
`;
					const raw = await exec(warm!, probe);
					let parsed;
					try {
						parsed = JSON.parse(raw.slice(raw.indexOf('{')));
					} catch {
						parsed = { raw: raw.slice(0, 700) };
					}
					return Response.json(parsed);
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
					return Response.json({
						extensions: s.split(',').filter(Boolean).sort()
					});
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
