// must evaluate before the glue; see the file for why
import '@drupflare/cartridge/shim';

import { PhpBase, type PhpBaseModuleFactory, type PhpRuntimeArgs } from 'php-wasm/PhpBase';
import PHPFactory from '../../vendor/static-free-v1/php8.3-worker.mjs';
import wasmModule from '../../vendor/static-free-v1/php8.3-worker.mjs.wasm';

/**
 * Measures the minimal+Stark node page in wasm.
 *
 * Deliberately the same build as src/prof.js (static-free-v1) and the same
 * mount shape, so the numbers line up with the recorded 33.8 ms warm /
 * 149.6 ms fresh for standard+Olivero. The measurement itself is not here: it
 * lives in pw_bench_profile() / pw_bench_breakdown() inside the packed tree's
 * pw-probe.php, which scripts/bench/bench-minimal.php calls natively with the same
 * arguments. Only the interpreter differs.
 */

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
 * the one cast happens where `php.binary` resolves.
 */
interface ProbeBinary {
	FS: ProbeFS;
	wasmMemory?: { buffer: ArrayBufferLike };
	HEAPU8?: { buffer: ArrayBufferLike };
}

/** the binding this probe reads its packs through, and the one var that gates the routes */
interface ProbeEnv {
	ASSETS: Fetcher;
	PW_DIAGNOSTICS?: string;
}

/** one `core.json` entry: path, offset into the inflated stream, length, mtime */
interface PackEntry {
	p: string;
	o: number;
	l: number;
	m?: number;
}

/** a booted interpreter; `mountedPack` is this file's own flag, not php-wasm's */
interface PhpInstance {
	php: PhpStatic;
	out: any[];
	diag: string[];
	binary: ProbeBinary;
	bootMs: number;
	mountedPack?: string;
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
 * The two site packs, so one worker can price both profiles under one harness.
 *
 * standard reuses assets/drupal's core tree (read-only; it belongs to another
 * track) with a database carrying the same node/1 and the same body field the
 * minimal site has, so profile+theme is the only thing that differs between the
 * two rows. assets/drupal/site.sqlite itself has zero nodes and cannot serve
 * /node/1 at all.
 */
const PACKS = {
	min: { core: 'drupal-min', db: 'drupal-min/site.sqlite' },
	std: { core: 'drupal', db: 'drupal-std/site.sqlite' }
};

/**
 * Streaming mount of a site pack: inflate and write each file as its bytes
 * arrive, never holding the whole inflated tree. Same algorithm as
 * mountDrupalStreaming in src/prof.js.
 *
 * sites/default/files/php/twig is created EMPTY on purpose. The pack excludes
 * runtime-writable state, so a fresh isolate has no compiled templates and the
 * first render must compile them -- which is the cost the breakdown route is
 * there to price.
 *
 * pw-probe.php is written from assets/probe AFTER the tree, overriding whatever
 * the pack shipped: the probe is the measuring instrument and repacking 11k
 * files to change one file would make every fix cost a minute.
 */
async function mountMinimal(
	binary: ProbeBinary,
	env: ProbeEnv,
	packName: keyof typeof PACKS = 'min'
) {
	const pack = PACKS[packName] ?? PACKS.min;
	const t0 = Date.now();
	const [idxRes, binRes, dbRes, probeRes] = await Promise.all([
		env.ASSETS.fetch(new URL(`https://a.local/${pack.core}/core.json`)),
		env.ASSETS.fetch(new URL(`https://a.local/${pack.core}/core.bin.gz`)),
		env.ASSETS.fetch(new URL(`https://a.local/${pack.db}`)),
		env.ASSETS.fetch(new URL('https://a.local/probe/pw-probe.php'))
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
		// Drupal hashes filemtime() into compiled-Twig directory names, so a
		// write-time mtime makes it miss its own shipped cache
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

	const probe = new Uint8Array(await probeRes.arrayBuffer());
	binary.FS.writeFile('/drupal/pw-probe.php', probe);

	return {
		pack: packName,
		files: index.length,
		bytes,
		dbBytes: db.length,
		probeBytes: probe.length,
		peakCarryBytes: peakCarry,
		fetchMs: tFetch - t0,
		writeMs: Date.now() - tFetch,
		subrequests: 4
	};
}

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
				// identical to src/prof.js: file_cache_only because there is no shared
				// memory, validate_timestamps off because VFS mtimes are meaningless and
				// the pack is immutable within a version
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

/**
 * Sets up the interpreter: the Fiber stand-in, $_SERVER, the cached autoloader,
 * and pw-probe.php. Nothing is rendered here, so a breakdown run can install its
 * decorators before the first render ever happens.
 *
 * The Fiber stand-in is a copy of the one in src/drupal-boot.js because that
 * file is a fixture for other work and is left alone. Drupal's five call sites
 * all follow construct -> start -> resume-until-terminated -> getReturn, so
 * running the callable eagerly on start() satisfies every one; emscripten has no
 * ucontext and a real Fiber aborts the runtime.
 */
const PRELUDE = `<?php
chdir('/drupal');

if (!class_exists('PhpWasmSyncFiber', false)) { eval('
class PhpWasmSyncFiber {
	private $callable;
	private $result = null;
	private $started = false;

	public function __construct(callable $callable) { $this->callable = $callable; }
	public function start(...$args) { $this->started = true; $this->result = ($this->callable)(...$args); return null; }
	public function isStarted(): bool { return $this->started; }
	public function isSuspended(): bool { return false; }
	public function isRunning(): bool { return false; }
	public function isTerminated(): bool { return $this->started; }
	public function resume($value = null) { return null; }
	public function throw(\\\\Throwable $e) { throw $e; }
	public function getReturn() { return $this->result; }
	public static function getCurrent(): ?object { return null; }
	public static function suspend($value = null) { return null; }
}
'); }

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['HTTP_USER_AGENT'] = 'workerd-bench';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

$t0 = microtime(true) * 1000;
try {
	// require_once returns true rather than the autoloader once the interpreter
	// has already loaded the file, and the interpreter persists between requests
	if (!isset($GLOBALS['__pw_autoloader'])) {
		$GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
	}
	require_once '/drupal/pw-probe.php';
	echo json_encode([
		'ok' => 1,
		'autoloadMs' => round(microtime(true) * 1000 - $t0, 1),
		'warm' => isset($GLOBALS['__pw_prelude']) ? 1 : 0,
		'files' => count(get_included_files()),
		'sapi' => PHP_SAPI,
		'version' => PHP_VERSION,
	]);
	$GLOBALS['__pw_prelude'] = true;
} catch (\\Throwable $e) {
	echo json_encode(['ok' => 0, 'error' => get_class($e) . ': ' . $e->getMessage(), 'trace' => substr($e->getTraceAsString(), 0, 900)]);
}
`;

const q = (s: string) => JSON.stringify(String(s));

/** everything runs inside a closure: at the eval'd global scope a backtrace walk inflates 12-24x */
const PROFILE_CODE = (route: string, mode: string, n: number) => `<?php
echo json_encode((function() {
	try {
		return pw_bench_profile([
			'root' => '/drupal',
			'route' => ${q(route)},
			'mode' => ${q(mode)},
			'n' => ${Number(n)},
			'autoloader' => $GLOBALS['__pw_autoloader'],
		]);
	} catch (\\Throwable $e) {
		return ['error' => get_class($e) . ': ' . $e->getMessage(), 'trace' => substr($e->getTraceAsString(), 0, 1400)];
	}
})());
`;

const BREAKDOWN_CODE = (route: string, n: number, coldTwig: boolean) => `<?php
echo json_encode((function() {
	try {
		return pw_bench_breakdown([
			'root' => '/drupal',
			'route' => ${q(route)},
			'n' => ${Number(n)},
			'autoloader' => $GLOBALS['__pw_autoloader'],
			'coldTwig' => ${coldTwig ? 'true' : 'false'},
		]);
	} catch (\\Throwable $e) {
		return ['error' => get_class($e) . ': ' . $e->getMessage(), 'trace' => substr($e->getTraceAsString(), 0, 1400)];
	}
})());
`;

/**
 * Boot attribution. No `n`: boot happens once per interpreter, so a spread needs N fresh
 * instances at the caller rather than N iterations in here.
 */
const BOOT_BREAKDOWN_CODE = (route: string) => `<?php
echo json_encode((function() {
	try {
		return pw_bench_boot_breakdown([
			'root' => '/drupal',
			'route' => ${q(route)},
			'autoloader' => $GLOBALS['__pw_autoloader'],
		]);
	} catch (\\Throwable $e) {
		return ['error' => get_class($e) . ': ' . $e->getMessage(), 'trace' => substr($e->getTraceAsString(), 0, 1400)];
	}
})());
`;

function parse(raw: string): any {
	const at = raw.indexOf('{');
	if (at < 0) return { raw: raw.slice(0, 1500) };
	try {
		return JSON.parse(raw.slice(at));
	} catch {
		return { raw: raw.slice(0, 1500) };
	}
}

// Every route here mutates interpreter state or reports internals, so they all
// fail closed the way src/prof.js does.
const DIAGNOSTIC_ROUTES = new Set(['/min', '/breakdown', '/bootbreakdown', '/mount', '/boot']);

export default {
	async fetch(request: Request, env: ProbeEnv): Promise<Response> {
		const url = new URL(request.url);

		if (DIAGNOSTIC_ROUTES.has(url.pathname) && env?.PW_DIAGNOSTICS !== '1') {
			return new Response('not found\n', { status: 404 });
		}

		// min = minimal+Stark, std = standard+Olivero; both carry the same node/1
		const pack = url.searchParams.get('pack') === 'std' ? 'std' : 'min';

		try {
			switch (url.pathname) {
				case '/boot':
					return Response.json(startup);

				case '/mount': {
					const inst = warm!;
					const mount = inst.mountedPack
						? { skipped: true, pack: inst.mountedPack }
						: await mountMinimal(inst.binary, env, pack);
					inst.mountedPack = pack;
					const prelude = parse(await exec(inst, PRELUDE));
					return Response.json({
						mount,
						prelude,
						linearMemoryBytes: linearMemory(inst.binary)
					});
				}

				case '/min': {
					// A fresh instance per call unless asked otherwise: pw_bench_profile
					// boots kernels, and warm-mode and fresh-mode kernels cannot share an
					// interpreter because boot() repoints \\Drupal::setContainer().
					const route = url.searchParams.get('route') ?? '/node/1';
					const mode = url.searchParams.get('mode') === 'fresh' ? 'fresh' : 'warm';
					const n = Number(url.searchParams.get('n') ?? 10);
					const reuse = url.searchParams.get('reuse') === '1';

					const inst = reuse ? warm! : await build();
					const t0 = Date.now();
					const mount = inst.mountedPack
						? { skipped: true, pack: inst.mountedPack }
						: await mountMinimal(inst.binary, env, pack);
					inst.mountedPack = pack;
					const mountMs = Date.now() - t0;

					const prelude = parse(await exec(inst, PRELUDE));
					const t1 = Date.now();
					const php = parse(await exec(inst, PROFILE_CODE(route, mode, n)));
					return Response.json({
						freshInstance: !reuse,
						mount,
						mountMs,
						prelude,
						wallMs: Date.now() - t1,
						php,
						linearMemoryBytes: linearMemory(inst.binary),
						diag: inst.diag.slice(-6)
					});
				}

				case '/breakdown': {
					const route = url.searchParams.get('route') ?? '/node/1';
					const n = Number(url.searchParams.get('n') ?? 10);
					// default on: a fresh isolate genuinely has no compiled templates, so
					// leaving them behind from an earlier call would hide the compile cost
					const coldTwig = url.searchParams.get('coldtwig') !== '0';
					const reuse = url.searchParams.get('reuse') === '1';

					const inst = reuse ? warm! : await build();
					const mount = inst.mountedPack
						? { skipped: true, pack: inst.mountedPack }
						: await mountMinimal(inst.binary, env, pack);
					inst.mountedPack = pack;

					const prelude = parse(await exec(inst, PRELUDE));
					const t1 = Date.now();
					const php = parse(await exec(inst, BREAKDOWN_CODE(route, n, coldTwig)));
					return Response.json({
						freshInstance: !reuse,
						mount,
						prelude,
						wallMs: Date.now() - t1,
						php,
						linearMemoryBytes: linearMemory(inst.binary),
						diag: inst.diag.slice(-6)
					});
				}

				case '/bootbreakdown': {
					// ALWAYS a fresh instance, never `reuse`: boot() calls
					// \Drupal::setContainer(), so a second boot in one interpreter repoints
					// every \Drupal:: static and there is nothing left to measure
					const route = url.searchParams.get('route') ?? '/node/1';

					const inst = await build();
					const t0 = Date.now();
					const mount = await mountMinimal(inst.binary, env, pack);
					inst.mountedPack = pack;
					const mountMs = Date.now() - t0;

					const prelude = parse(await exec(inst, PRELUDE));
					const t1 = Date.now();
					const php = parse(await exec(inst, BOOT_BREAKDOWN_CODE(route)));
					return Response.json({
						freshInstance: true,
						clock: 'local wall clock; on the edge neither Date.now() nor microtime() ADVANCES, so every delta below reads 0. The absolute is real -- /clock reports it',
						mount,
						mountMs,
						prelude,
						wallMs: Date.now() - t1,
						php,
						linearMemoryBytes: linearMemory(inst.binary),
						diag: inst.diag.slice(-6)
					});
				}

				case '/clock': {
					// Bucket attribution is only as good as the clock. workerd freezes
					// Date.now() between I/O in some configurations and coarsens timers for
					// Spectre, so measure the real granularity rather than assuming it.
					//
					// `absoluteS` and `jsAbsoluteMs` are the ADDITIVE half, and they are what this
					// probe could not answer. Every reading that made it into the report was a
					// DELTA -- `steadySeqMs`, `wallMs`, the fields below -- so "microtime() returns
					// 0 on the edge" was recorded as a fact about the value when the measurement
					// was about the advance. Frozen and zero are different claims and only one of
					// them was ever measured.
					const code = `<?php
echo json_encode((function() {
	$abs = microtime(true);
	$m = [];
	for ($i = 0; $i < 4000; $i++) { $m[] = microtime(true); }
	$h = [];
	for ($i = 0; $i < 4000; $i++) { $h[] = hrtime(true); }
	$dm = [];
	$dh = [];
	for ($i = 1; $i < 4000; $i++) {
		$a = ($m[$i] - $m[$i - 1]) * 1000;
		if ($a > 0) { $dm[] = $a; }
		$b = $h[$i] - $h[$i - 1];
		if ($b > 0) { $dh[] = $b; }
	}
	sort($dm);
	sort($dh);
	// busy loop long enough that both clocks must move
	$x = 0.0;
	$s1 = microtime(true);
	$s2 = hrtime(true);
	for ($i = 0; $i < 400000; $i++) { $x += sqrt($i); }
	return [
		'absoluteS' => $abs,
		'absoluteIso' => gmdate('c', (int) $abs),
		'requestTime' => $_SERVER['REQUEST_TIME'] ?? null,
		'microtimeDistinct' => count(array_unique($m)),
		'microtimeMinStepMs' => $dm ? $dm[0] : null,
		'hrtimeDistinct' => count(array_unique($h)),
		'hrtimeMinStepNs' => $dh ? $dh[0] : null,
		'busyMicrotimeMs' => round((microtime(true) - $s1) * 1000, 4),
		'busyHrtimeMs' => round((hrtime(true) - $s2) / 1e6, 4),
		'sink' => round($x, 1),
	];
})());
`;
					// jsAbsoluteMs is the JS side of the same question, read in the same
					// invocation: if these two agree, PHP's clock IS Date.now() and a frozen
					// reading is still a real instant
					return Response.json({
						...parse(await exec(warm!, code)),
						jsAbsoluteMs: Date.now()
					});
				}

				case '/version':
					return new Response(await exec(warm!, '<?php echo PHP_VERSION;'));

				default:
					return new Response('routes: /boot /mount /min /breakdown /version\n', {
						status: 404
					});
			}
		} catch (e: any) {
			return Response.json(
				{
					error: `${e?.message ?? e}`,
					stack: `${e?.stack ?? ''}`.slice(0, 1200)
				},
				{ status: 500 }
			);
		}
	}
};
