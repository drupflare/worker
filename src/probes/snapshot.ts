// must evaluate before the glue; see the file for why
import '@drupflare/cartridge/shim';

import { mountDrupalLazy, type LazyFsEnv } from '@drupflare/cartridge/fs';
import FreeFactory from '../../vendor/static-free-v1/php8.3-worker.mjs';
import freeWasm from '../../vendor/static-free-v1/php8.3-worker.mjs.wasm';
import O2Factory from '../../vendor/static-o2/php8.3-worker.mjs';
import o2Wasm from '../../vendor/static-o2/php8.3-worker.mjs.wasm';
import { captureStreams, replayStreams, type StreamRecord } from '../db/heap-store';

/**
 * GATE 2: can a post-boot wasm heap image be written back into a FRESH instance
 * and keep executing?
 *
 * Deliberately bypasses `PhpBase`. `PhpBase.binary` always calls `pib_init` (PHP's
 * module startup) before it resolves, and `pib_init` IS the state we want to restore
 * rather than pay for. So both instances come off the raw emscripten factory:
 * instance A gets `pib_init`, instance B never does, and the only thing that could
 * make B able to run PHP is the heap image copied out of A.
 *
 * `/control` is the negative arm -- a B with no image written -- so a passing
 * `/restore` cannot be explained by "pib_run works on a virgin instance anyway".
 *
 * A1b -- `/drupal-snap`, `/drupal-restore`, `/drupal-control` -- is the same question
 * asked of a heap that has BOOTED DRUPAL rather than one that has only run `pib_init`.
 * `pib_init` costs 22-23 ms, so Gate 2 proved the mechanism and not that the ~4 s
 * Drupal state survives. The Drupal heap is where the risk lives: it holds interned
 * paths, a realpath cache, and open file descriptors -- an sqlite3 handle on the
 * mounted database above all -- and every one of those is a NUMBER in linear memory
 * pointing at a JS-side MEMFS object that the fresh instance has to reproduce
 * exactly. See RESTORING THE FILESYSTEM below.
 */

const PAGE = 65536;

/**
 * The two binaries, and A1b can only use the second one.
 *
 * `static-o2` is the shipping build and it CANNOT boot Drupal on its own:
 * `WITH_SQLITE=0`, so `settings.php`'s sqlite driver dies at
 * `PDOException: could not find driver`. The shipping path reaches SQLite through the
 * Durable Object driver, which would put a `vrzno_env()` bridge -- JS object handles
 * held by index on the PHP side -- inside the very heap under test, and those handles
 * live in a JS array the fresh instance does not have. `static-free-v1` has SQLite
 * compiled in, boots the mounted site standalone, and is the build every historical
 * memory figure in TECHNICAL_REPORT.md was taken on.
 *
 * RULE 0b applies to any figure taken here: static-free-v1 is 586,923 bytes OVER the
 * free bundle ceiling, so this settles the MECHANISM on a binary that cannot ship.
 * What transfers is the inode/fd contract, which is a property of emscripten's MEMFS
 * rather than of the PHP build.
 */
const BINARIES = {
	o2: { label: 'vendor/static-o2', PHPFactory: O2Factory, wasmModule: o2Wasm },
	free: { label: 'vendor/static-free-v1', PHPFactory: FreeFactory, wasmModule: freeWasm }
};

/** which vendored build an instance came from; `free` is the only one that boots Drupal here */
type BinName = keyof typeof BINARIES;

/** the one binding this probe mounts its pack through */
interface ProbeEnv {
	ASSETS: Fetcher;
}

/** a whole-heap fingerprint, as `digestBuffer()` reports it */
type Digest = ReturnType<typeof digestBuffer>;

/** what one `pib_run` produced */
interface PhpResult {
	rc: number | null;
	threw: string | null;
	out: string;
	err: string;
	ms: number;
}

/**
 * One raw emscripten instance.
 *
 * `mod` and `exports` are `any` deliberately: `mod` is emscripten's Module, reached for by
 * name (`ccall`, `FS`, `_malloc`), and on static-free-v1 the wasm export names are MINIFIED,
 * which is the reason STACK_EXPORTS exists at all.
 */
interface RawInstance {
	bin: BinName;
	mod: any;
	exports: any;
	memory: WebAssembly.Memory;
	stackGet: (() => number) | null;
	stackRestore: ((sp: number) => void) | null;
	notes: string[];
	importShape: string[] | null;
	memoryImported: boolean | null;
	pagesAtInstantiate: number | null;
	atInstantiate: Digest | null;
	instantiateMs: number;
	stdoutBytes: number[];
	stderrBytes: number[];
	drain(): { out: string; err: string };
}

/** one exported `WebAssembly.Global`, with the mutability probe's verdict */
interface GlobalRecord {
	name: string;
	value: unknown;
	mutable: boolean;
	valueError: string | null;
}

/** what a heap-growth attempt did */
interface GrowReport {
	needed: boolean;
	path: string | null;
	pagesBefore: number;
	pagesAfter: number | null;
	attempts: { want: number; ptr: number; pages: number }[];
	error: string | null;
}

/**
 * emscripten's MEMFS and one of its nodes.
 *
 * `any` on both, and not out of laziness: a MEMFS node carries emscripten's own fields plus
 * the `cfw*` ones `src/runtime/lazy-fs.ts` hangs on a lazy node, this file reads both, and
 * `FS.streams[fd]` is reassigned by index -- none of which any published type describes.
 */
type MemFS = any;
type FsNode = any;

/** one captured node: what it is, where it lives, and its bytes if it is a file */
interface FsRecord {
	path: string;
	id: number;
	kind: 'dir' | 'file';
	mode: number;
	timestamp: number;
	bytes: Uint8Array | null;
}

/** everything the boot did to the filesystem after the mount watermark */
type FsCapture = ReturnType<typeof captureFs>;

/** what a replay rebuilt, and everything it could not */
interface ReplayReport {
	dirs: number;
	files: number;
	bytes: number;
	gaps: number;
	overwritten: number;
	overwrittenBytes: number;
	missingParents: string[];
	failures: { id?: number; path?: string; error: string }[];
	replayMs?: number;
	nextInodeAfter?: number;
}

/**
 * The knobs both Drupal sides accept.
 *
 * Every mechanism is switchable because a test that cannot be made to fail proves nothing;
 * `misalign` is the arm A1b was written for.
 */
interface DrupalOpts {
	bin?: BinName;
	budget?: number;
	fsdelta?: boolean;
	streams?: boolean;
	stack?: boolean;
	preinflate?: boolean;
	forceInode?: boolean;
	html?: boolean;
	misalign?: number;
	renders?: number;
	dropfd?: number[];
	init?: boolean;
	boot?: boolean;
}

/**
 * The Drupal image: the heap, plus the FS, stream and global state a fresh instance must match.
 *
 * `aRender`/`aRenders` are `any` and optional because they are instance A's own parsed render
 * JSON, filled in AFTER the image is taken and shaped by the PHP fragment rather than by this
 * file.
 */
interface DrupalSnapshot {
	bin: BinName;
	bytes: Uint8Array;
	byteLength: number;
	pages: number;
	sp: number | string;
	fs: FsCapture;
	streams: StreamRecord[];
	globals: GlobalRecord[];
	atInstantiate: Digest | null;
	budget: number | null;
	takenAt: number;
	aRender?: any;
	aRenders?: any[];
}

/** the kept image: the heap bytes plus everything a fresh instance has to be told */
interface Snapshot {
	bytes: Uint8Array;
	pages: number;
	byteLength: number;
	sp: number | string;
	nextInode: number;
	streams: number;
	globals: GlobalRecord[];
	takenAt: number;
}

/**
 * The anonymous front page, as recorded in TECHNICAL_REPORT.md.
 *
 * The FIRST render of a booted kernel is 12,304 bytes; every render after it is
 * 12,310. So a snapshot that is to be compared against this reference has to be taken
 * BEFORE any render, which is also the moment the design wants: boot is the expensive
 * indivisible thing, a render is not.
 */
const REFERENCE = { bytes: 12304, sha1: '10077de5f0bd', secondRenderBytes: 12310 };

/** what `PhpBase` would write; identical on both sides so the inode baseline matches */
const PHP_INI = ['memory_limit=256M', 'date.timezone=UTC'].join('\n') + '\n';

/**
 * The wasm export names for the two stack-pointer accessors, per build.
 *
 * static-free-v1 IS LINKED WITH MINIFIED EXPORT NAMES, so `exports.memory` and
 * `exports.emscripten_stack_get_current` do not exist on it at all -- reading
 * `exports.memory.buffer` there threw "Cannot read properties of undefined", and
 * because that happened inside the `instantiateWasm` callback the unremoved
 * `wasm-instantiate` run dependency turned it into a hung request rather than an
 * error. Recovered the same way `src/probes/heapsize.js` recovers its resize import:
 *   grep -o -E '_?_emscripten_stack_(restore|get_current)=wasmExports\["[^"]+"\]' \
 *     vendor/<build>/php8.3-worker.mjs
 * The Memory itself is found by TYPE rather than by name, which needs no table and
 * cannot go stale.
 */
const STACK_EXPORTS = {
	o2: { get: 'emscripten_stack_get_current', restore: '_emscripten_stack_restore' },
	free: { get: 'tva', restore: 'rva' }
};

/**
 * A whole-heap fingerprint, FNV-1a over 32-bit words.
 *
 * A digest rather than a kept copy, because the assertions it serves are equality
 * checks and a second 64-96 MB buffer per instance is real memory. Two of them matter:
 *
 *   - A's and B's digests AT INSTANTIATION must be equal. That is the invariant
 *     zero-page elision rests on: a snapshot that stores only the pages differing from
 *     the post-instantiation baseline is only restorable if the fresh instance HAS that
 *     baseline. A wrong baseline produces a heap that RUNS and is subtly wrong.
 *   - B's digest just before the memcpy must equal its own post-factory digest, which
 *     is what proves the mount, the FS replay and the stream replay touched no linear
 *     memory at all.
 */
function digestBuffer(buffer: ArrayBufferLike) {
	const u32 = new Uint32Array(buffer);
	let h = 0x811c9dc5;
	for (let i = 0; i < u32.length; i++) {
		h = Math.imul(h ^ u32[i]!, 0x01000193);
	}
	return { words: u32.length, hash: (h >>> 0).toString(16) };
}

/** one raw emscripten instance, with its wasm exports and its stdout/stderr taps */
async function makeInstance(bin: BinName = 'o2'): Promise<RawInstance> {
	const stdout: number[] = [];
	const stderr: number[] = [];
	const notes: string[] = [];
	// `any` on both: these are emscripten's Module and the raw wasm exports, and on
	// static-free-v1 the export names are minified, so nothing here can be named up front
	let exports: any = null;
	let memory: WebAssembly.Memory | null = null;
	let importShape: string[] | null = null;
	let memoryImported: boolean | null = null;
	let pagesAtInstantiate: number | null = null;
	let atInstantiate: Digest | null = null;
	const { PHPFactory, wasmModule } = BINARIES[bin] ?? BINARIES.o2;

	const t0 = Date.now();
	const factory = PHPFactory({
		stdout: (b: number) => stdout.push(b),
		stderr: (b: number) => stderr.push(b),
		stdin: () => null,
		printErr: (t: string) => notes.push(`err: ${t}`),
		onAbort: (w: unknown) => notes.push(`abort: ${w}`),
		locateFile: (p: string) => (p === 'libxml2.so' ? 'data:,' : undefined),
		instantiateWasm(
			imports: WebAssembly.Imports,
			receiveInstance: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
		) {
			importShape = Object.keys(imports);
			// -sIMPORTED_MEMORY would put a Memory on the import object
			memoryImported = Boolean(imports?.env?.memory) || Boolean(imports?.['a']?.memory);
			WebAssembly.instantiate(wasmModule, imports)
				.then((instance) => {
					exports = instance.exports;
					memory =
						Object.values(exports).find((v) => v instanceof WebAssembly.Memory) ?? null;
					pagesAtInstantiate = memory ? memory.buffer.byteLength / PAGE : null;
					// the ONE moment the heap holds the module's data segments and nothing
					// else: `receiveInstance` runs __wasm_call_ctors on the next line
					if (memory) atInstantiate = digestBuffer(memory.buffer);
					receiveInstance(instance, wasmModule);
				})
				.catch((e: any) => notes.push(`instantiate FAILED: ${e?.stack ?? e}`));
			return {};
		}
	});

	/**
	 * A factory that never resolves is otherwise INVISIBLE.
	 *
	 * `instantiateWasm` returning `{}` leaves emscripten holding an unremoved
	 * `wasm-instantiate` run dependency, so anything that stops `receiveInstance` from
	 * being called -- a LinkError, a missing preload -- means `readyPromise` is never
	 * settled and workerd cancels the request with "your Worker's code had hung",
	 * discarding every note the glue produced. Racing a timer turns that into a
	 * diagnosable error.
	 */
	// `any`: emscripten's Module, reached for by name (`ccall`, `FS`, `_malloc`) throughout
	const mod: any = await Promise.race([
		factory,
		new Promise((_resolve, reject) =>
			setTimeout(
				() =>
					reject(
						new Error(
							`${bin}: the emscripten factory never resolved in 20s; notes: ${notes.join(' | ') || '(none)'}`
						)
					),
				20000
			)
		)
	]);

	const names = STACK_EXPORTS[bin] ?? STACK_EXPORTS.o2;
	const decoder = new TextDecoder();
	return {
		bin,
		mod,
		exports,
		// asserted: every route below reads `inst.memory.buffer`, and an instance whose
		// instantiate callback never found a Memory has already thrown out of the race above
		memory: memory!,
		stackGet: exports?.[names.get] ?? null,
		stackRestore: exports?.[names.restore] ?? null,
		notes,
		importShape,
		memoryImported,
		pagesAtInstantiate,
		atInstantiate,
		instantiateMs: Date.now() - t0,
		stdoutBytes: stdout,
		stderrBytes: stderr,
		drain() {
			const o = decoder.decode(new Uint8Array(stdout));
			const e = decoder.decode(new Uint8Array(stderr));
			stdout.length = 0;
			stderr.length = 0;
			return { out: o, err: e };
		}
	};
}

const pages = (inst: RawInstance) => inst.memory.buffer.byteLength / PAGE;
const heapBytes = (inst: RawInstance) => inst.memory.buffer.byteLength;
const sp = (inst: RawInstance): number | string => {
	if (!inst.stackGet) return `unavailable: no stack export for ${inst.bin}`;
	try {
		return inst.stackGet();
	} catch (e: any) {
		return `unavailable: ${e?.message ?? e}`;
	}
};

/** run PHP through the same C entry point PhpBase uses, minus PhpBase */
function phpRun(inst: RawInstance, code: string): PhpResult {
	const t0 = Date.now();
	let rc: number | null = null;
	let threw: string | null = null;
	try {
		rc = inst.mod.ccall('pib_run', 'number', ['string'], [`?>${code}`]);
	} catch (e: any) {
		threw = `${e?.stack ?? e}`;
	}
	const { out, err } = inst.drain();
	return { rc, threw, out, err, ms: Date.now() - t0 };
}

/** every fragment below prints one JSON object; anything before the first brace is noise */
function phpJson(result: PhpResult): any {
	const at = (result.out ?? '').indexOf('{');
	if (at < 0) return { parseError: 'no JSON in output', out: (result.out ?? '').slice(0, 400) };
	try {
		return JSON.parse(result.out.slice(at));
	} catch (e: any) {
		return { parseError: `${e?.message ?? e}`, out: result.out.slice(at, at + 400) };
	}
}

/**
 * Every exported `WebAssembly.Global`, with a probe for mutability.
 *
 * Writing a Global's own value back is a no-op on a mutable global and throws on an
 * immutable one, so it is a safe mutability test with no separate binary parse.
 */
function readGlobals(inst: RawInstance): GlobalRecord[] {
	const out: GlobalRecord[] = [];
	for (const [name, v] of Object.entries<any>(inst.exports)) {
		if (!(v instanceof WebAssembly.Global)) continue;
		let value: any;
		let valueError: string | null = null;
		try {
			value = v.value;
		} catch (e: any) {
			valueError = `${e?.message ?? e}`;
		}
		let mutable = false;
		if (valueError === null) {
			try {
				v.value = value;
				mutable = true;
			} catch {
				mutable = false;
			}
		}
		out.push({
			name,
			value: typeof value === 'bigint' ? String(value) : value,
			mutable,
			valueError
		});
	}
	return out;
}

/**
 * Grows a fresh instance to at least `targetBytes` through emscripten's OWN path:
 * malloc -> sbrk -> emscripten_resize_heap -> growMemory -> updateMemoryViews.
 *
 * A bare `memory.grow()` detaches every cached `HEAP*` view inside the glue and there
 * is no exported way to refresh them. The request must be for the WHOLE target size
 * rather than the shortfall, because sbrk's break sits ~35 MB below the buffer end, so
 * a shortfall-sized request grows to break+shortfall and lands short (measured: 2634
 * pages against a 3633-page target). Nothing is freed -- the image about to be written
 * replaces the allocator's bookkeeping wholesale.
 */
function growHeap(b: RawInstance, targetBytes: number) {
	const grow: GrowReport = {
		needed: false,
		path: null,
		pagesBefore: pages(b),
		pagesAfter: null,
		attempts: [],
		error: null
	};
	if (heapBytes(b) >= targetBytes) {
		grow.pagesAfter = grow.pagesBefore;
		return grow;
	}
	grow.needed = true;
	grow.path = 'malloc->emscripten_resize_heap';
	try {
		for (let i = 0; i < 4 && heapBytes(b) < targetBytes; i++) {
			const ptr = b.mod._malloc(targetBytes);
			grow.attempts.push({ want: targetBytes, ptr, pages: pages(b) });
			if (!ptr) break;
		}
	} catch (e: any) {
		grow.error = `${e?.stack ?? e}`;
	}
	grow.pagesAfter = pages(b);
	if (grow.error === null && heapBytes(b) < targetBytes) {
		grow.error = `still short: ${heapBytes(b)} < ${targetBytes}`;
	}
	return grow;
}

/** the snapshot, kept in module scope so /snap then /restore works across requests */
let snap: Snapshot | null = null;

async function takeSnapshot(opts: { warmup?: boolean; bloatMb?: number } = {}) {
	const a = await makeInstance();
	const before = {
		pages: pages(a),
		sp: sp(a),
		nextInode: a.mod.FS.nextInode,
		streams: a.mod.FS.streams.length
	};

	const tInit = Date.now();
	let initRc: number | null = null;
	let initThrew: string | null = null;
	try {
		initRc = a.mod.ccall('pib_init', 'number', ['string'], ['embed']);
	} catch (e: any) {
		initThrew = `${e?.stack ?? e}`;
	}
	const initMs = Date.now() - tInit;
	const initDrain = a.drain();

	// a real PHP heap: boot leaves the interpreter warm, this makes it dirty too
	const warmup = opts.warmup
		? phpRun(a, '<?php $x = str_repeat("w", 4096); echo strlen($x);')
		: null;

	/**
	 * Forces A past the module's initial page count.
	 *
	 * Memory is NOT imported, so a fresh B always starts at the 1536 pages baked into
	 * the module's memory section. Any snapshot taken after the heap grew -- which a
	 * Drupal boot certainly does -- can only be written into a B that was grown first.
	 * This is the arm that tests that growth path rather than assuming it.
	 */
	const bloat = opts.bloatMb
		? phpRun(
				a,
				`<?php ini_set('memory_limit', '-1'); $s = str_repeat("z", ${opts.bloatMb} * 1024 * 1024); echo strlen($s);`
			)
		: null;
	const pagesAfterBloat = pages(a);

	const globals = readGlobals(a);
	const buf = a.memory.buffer;
	const tCopy = Date.now();
	const bytes = new Uint8Array(buf.byteLength);
	bytes.set(new Uint8Array(buf));
	const copyMs = Date.now() - tCopy;

	snap = {
		bytes,
		pages: buf.byteLength / PAGE,
		byteLength: buf.byteLength,
		sp: sp(a),
		nextInode: a.mod.FS.nextInode,
		streams: a.mod.FS.streams.length,
		globals,
		takenAt: Date.now()
	};

	// prove A itself is a working interpreter AFTER the snapshot was taken
	const proof = phpRun(a, '<?php echo phpversion();');

	return {
		instance: {
			memoryImported: a.memoryImported,
			importShape: a.importShape,
			pagesAtInstantiate: a.pagesAtInstantiate,
			instantiateMs: a.instantiateMs,
			notes: a.notes.slice(0, 20)
		},
		beforeInit: before,
		pibInit: { rc: initRc, threw: initThrew, ms: initMs, ...initDrain },
		warmup,
		bloat,
		pagesAfterBloat,
		snapshot: {
			pages: snap.pages,
			byteLength: snap.byteLength,
			sp: snap.sp,
			nextInode: snap.nextInode,
			streams: snap.streams,
			copyMs,
			globalsTotal: globals.length,
			globalsMutable: globals
				.filter((g) => g.mutable)
				.map((g) => ({ name: g.name, value: g.value })),
			globalsSample: globals.slice(0, 5)
		},
		instanceAStillWorks: proof
	};
}

async function restore(opts: { globals?: boolean; stack?: boolean; inode?: boolean } = {}) {
	if (!snap) return { error: 'no snapshot; call /snap first' };

	const b = await makeInstance();
	const fresh = {
		memoryImported: b.memoryImported,
		pagesAtInstantiate: b.pagesAtInstantiate,
		pages: pages(b),
		sp: sp(b),
		nextInode: b.mod.FS.nextInode,
		streams: b.mod.FS.streams.length,
		instantiateMs: b.instantiateMs,
		notes: b.notes.slice(0, 20)
	};

	const grow = growHeap(b, snap.byteLength);
	if (grow.error) return { fresh, grow, verdict: 'could not size the fresh instance' };

	const tWrite = Date.now();
	const heap = new Uint8Array(b.memory.buffer);
	heap.set(snap.bytes);
	const writeMs = Date.now() - tWrite;

	// mutable globals last, so nothing above can clobber them
	const globalsRestored: string[] = [];
	const globalsFailed: { name: string; error: string }[] = [];
	if (opts.globals !== false) {
		for (const g of snap.globals) {
			if (!g.mutable) continue;
			try {
				// bigint globals were stringified for JSON; put the type back
				const target = b.exports[g.name];
				target.value =
					typeof target.value === 'bigint' ? BigInt(g.value as string) : g.value;
				globalsRestored.push(g.name);
			} catch (e: any) {
				globalsFailed.push({ name: g.name, error: `${e?.message ?? e}` });
			}
		}
	}

	const stack: {
		snapshotSp: number | string;
		freshSp: number | string;
		restored: boolean;
		error: string | null;
		spAfter?: number | string;
	} = { snapshotSp: snap.sp, freshSp: fresh.sp, restored: false, error: null };
	if (opts.stack !== false && typeof snap.sp === 'number') {
		try {
			b.stackRestore!(snap.sp);
			stack.restored = true;
			stack.spAfter = sp(b);
		} catch (e: any) {
			stack.error = `${e?.message ?? e}`;
		}
	}

	const fs = {
		snapshotNextInode: snap.nextInode,
		freshNextInode: b.mod.FS.nextInode,
		match: snap.nextInode === b.mod.FS.nextInode,
		aligned: false
	};
	if (opts.inode !== false && !fs.match) {
		b.mod.FS.nextInode = snap.nextInode;
		fs.aligned = true;
	}

	const version = phpRun(b, '<?php echo phpversion();');
	// `any`: either a run result or the skip marker, and `heapOk` below reads `.out` off it
	const heapWork: any =
		version.threw === null
			? phpRun(
					b,
					'<?php $a=[]; for($i=0;$i<1000;$i++)$a[]=str_repeat("x",100); echo strlen(implode("",$a));'
				)
			: { skipped: 'version call threw' };
	const files =
		version.threw === null
			? phpRun(
					b,
					'<?php file_put_contents("/tmp/snap.txt", "hello-restored"); echo file_get_contents("/tmp/snap.txt");'
				)
			: { skipped: 'version call threw' };

	const versionOk = /8\.3\.\d+/.test(version.out ?? '');
	const heapOk = (heapWork.out ?? '').trim() === '100000';

	return {
		fresh,
		grow,
		writeMs,
		bytesWritten: snap.byteLength,
		globals: {
			restored: globalsRestored.length,
			names: globalsRestored,
			failed: globalsFailed
		},
		stack,
		fs,
		version,
		heapWork,
		files,
		verdict: versionOk && heapOk ? 'RESTORED HEAP EXECUTES' : 'FAILED',
		versionOk,
		heapOk
	};
}

/** negative arm: fresh instance, no pib_init, no image written */
async function control() {
	const b = await makeInstance();
	const version = phpRun(b, '<?php echo phpversion();');
	return {
		pages: pages(b),
		sp: sp(b),
		nextInode: b.mod.FS.nextInode,
		notes: b.notes.slice(0, 20),
		version
	};
}

// #region A1b: the PHP that boots Drupal, and the PHP that renders one page

/**
 * The synchronous stand-in for \Fiber that the patched tree expects.
 *
 * Copied from src/drupal/site-php.js rather than imported: that file's fragments all
 * reach the database through `vrzno_env()`, which is the Durable Object bridge this
 * probe deliberately does not have. `scripts/patch-drupal.mjs` rewrites core's five
 * `\Fiber` call sites to this class name, so it has to exist before Drupal loads.
 */
const FIBER_SHIM = String.raw`
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
  public function throw(\\Throwable $e) { throw $e; }
  public function getReturn() { return $this->result; }
  public static function getCurrent(): ?object { return null; }
  public static function suspend($value = null) { return null; }
}
'); }
`;

const SERVER_VARS = String.raw`
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
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';
`;

/**
 * Boots the kernel and STOPS, which is the whole point of the split.
 *
 * `src/probes/drupal-boot.js` boots and renders in one fragment, and that cannot be
 * used here: the first render of a booted kernel is 12,304 bytes and every render
 * after it is 12,310, so a snapshot taken after a render can only ever be compared
 * against the second figure. Snapshotting here -- kernel up, container built, database
 * open, nothing rendered -- makes the restored instance's render a FIRST render, which
 * is both the number the report recorded and the state the design wants to store.
 */
const DRUPAL_KERNEL_BOOT = String.raw`<?php
${FIBER_SHIM}
${SERVER_VARS}
chdir('/drupal');

$mark = [];
$clock = function () { return microtime(true) * 1000; };
$t0 = $clock();
try {
  // require_once returns true rather than the autoloader once the interpreter has
  // already loaded the file, and the interpreter persists between runs
  if (!isset($GLOBALS['__pw_autoloader'])) {
    $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
  }
  $autoloader = $GLOBALS['__pw_autoloader'];
  $mark['autoloadMs'] = round($clock() - $t0, 1);

  if (!isset($GLOBALS['__pw_kernel'])) {
    $a = $clock();
    $request = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
    $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
    \Drupal\Core\DrupalKernel::bootEnvironment();
    $sitePath = \Drupal\Core\DrupalKernel::findSitePath($request);
    $kernel->setSitePath($sitePath);
    \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
    $mark['settingsMs'] = round($clock() - $a, 1);

    $a = $clock();
    $kernel->boot();
    $mark['kernelBootMs'] = round($clock() - $a, 1);
    $GLOBALS['__pw_kernel'] = $kernel;
    $mark['booted'] = 1;
  } else {
    $mark['booted'] = 0;
  }

  // forces the database connection open before the snapshot, so the sqlite3 file
  // descriptor is part of the image rather than something the restore creates
  $connection = \Drupal\Core\Database\Database::getConnection();
  $mark['driver'] = $connection->driver();
  $mark['tables'] = count($connection->schema()->findTables('%'));
} catch (\Throwable $e) {
  $mark['error'] = get_class($e) . ': ' . $e->getMessage();
  $mark['trace'] = substr($e->getTraceAsString(), 0, 900);
}

$mark['totalMs'] = round($clock() - $t0, 1);
$mark['includedFiles'] = count(get_included_files());
$mark['peakMemMb'] = round(memory_get_peak_usage(true) / 1048576, 1);
$mark['cwd'] = getcwd();
echo json_encode($mark);
`;

/**
 * Renders the front page against the kernel the heap already holds.
 *
 * `$GLOBALS['__pw_kernel']` is the assertion that matters on the restore side: the
 * kernel object, its container and its open database handle are all in linear memory,
 * so `kernelFromHeap: 1` means the image carried the boot. A plain `handle()` rather
 * than site-php's `cfw_serve()` because this is a FIRST render on this kernel --
 * there is no previous request's state to unpick, and the 12,304-byte reference was
 * recorded from exactly this call.
 *
 * sha1 is computed HERE as well as in JS, because the recorded reference is
 * `substr(sha1($body), 0, 12)` taken in PHP.
 */
function drupalRender(path = '/', withHtml = false, bust = false) {
	const safePath = JSON.stringify(String(path));
	/**
	 * Rule 3 of this project, applied to request 2.
	 *
	 * Without this a second `handle()` on the same kernel is a page_cache HIT: measured,
	 * 1 ms and the same 12,304 bytes, which exercises none of the container,
	 * `drupal_static` or collector state the restored heap is holding. Emptying both bins
	 * and nulling `PageCache`'s memoized cid is what makes request 2 a REAL render, and a
	 * real second render is 12,310 bytes rather than 12,304.
	 */
	const bustCode = bust
		? String.raw`
  foreach (['page', 'dynamic_page_cache'] as $bin) {
    try { \Drupal::cache($bin)->deleteAll(); } catch (\Throwable $e) {}
  }
  try {
    $mw = \Drupal::service('http_middleware.page_cache');
    $rp = new \ReflectionProperty($mw, 'cid');
    $rp->setAccessible(true);
    $rp->setValue($mw, NULL);
  } catch (\Throwable $e) {}
  $out['busted'] = 1;`
		: '';
	return String.raw`<?php
${FIBER_SHIM}
${SERVER_VARS}
chdir('/drupal');
$path = json_decode(${JSON.stringify(safePath)});
$_SERVER['REQUEST_URI'] = $path;

$out = [];
$clock = function () { return microtime(true) * 1000; };
$t0 = $clock();
try {
  $out['kernelFromHeap'] = isset($GLOBALS['__pw_kernel']) ? 1 : 0;
  $out['autoloaderFromHeap'] = isset($GLOBALS['__pw_autoloader']) ? 1 : 0;
  if (!isset($GLOBALS['__pw_kernel'])) {
    throw new \RuntimeException('no kernel in this heap; the image did not carry the boot');
  }
  $kernel = $GLOBALS['__pw_kernel'];
${bustCode}
  $request = \Symfony\Component\HttpFoundation\Request::create($path, 'GET');
  $response = $kernel->handle($request);
  $body = (string) $response->getContent();
  $out['status'] = $response->getStatusCode();
  $out['bytes'] = strlen($body);
  $out['sha1'] = substr(sha1($body), 0, 12);
  $out['titleFound'] = str_contains($body, '<title>') ? 1 : 0;
  $out['pageCache'] = $response->headers->get('x-drupal-cache');
  $out['dynamicCache'] = $response->headers->get('x-drupal-dynamic-cache');
  ${withHtml ? "$out['html'] = $body;" : ''}
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
  $out['trace'] = substr($e->getTraceAsString(), 0, 1200);
}
$out['renderMs'] = round($clock() - $t0, 1);
echo json_encode($out);
`;
}

// #endregion

// #region A1b: RESTORING THE FILESYSTEM

/**
 * WHY THE FILESYSTEM IS PART OF THE SNAPSHOT AT ALL.
 *
 * MEMFS lives in JS objects hanging off the Module, not in linear memory. The image
 * carries only the numbers PHP holds: inode ids in its stat cache, and file
 * descriptors, which are indices into `FS.streams`. So a fresh instance has to
 * reproduce three things, and each one fails differently if it is wrong:
 *
 *   1. The same NODES, so a path PHP has interned resolves to a file with the same
 *      contents. The lazy mount gives this for free -- it is the same asset.
 *   2. The same INODE NUMBERING, because `FS.nextInode` is a counter and every node
 *      created after the mount takes the next value. If the two sides disagree, the
 *      ids in the restored stat cache name different files.
 *   3. The same OPEN STREAMS at the same fd numbers. This is the load-bearing one: a
 *      booted Drupal holds an sqlite3 handle on `/drupal/sites/default/files/.sqlite`,
 *      and that handle is an integer in the restored heap. Without a stream at that
 *      index the first query reads a closed fd.
 *
 * `captureFs()` records everything the boot changed after the mount watermark;
 * `replayFs()` puts it back in ID ORDER so the numbering is reproduced by
 * construction rather than patched afterwards.
 */

/** every node under `root`, depth-first; MEMFS keeps directory children in an object */
function* walkFs(FS: MemFS, root: string) {
	let start: FsNode;
	try {
		start = FS.lookupPath(root, { follow: true }).node;
	} catch {
		return;
	}
	const stack: [string, FsNode][] = [[root, start]];
	while (stack.length > 0) {
		const [path, node] = stack.pop()!;
		yield { path, node };
		if (FS.isDir(node.mode) && node.contents && !(node.contents instanceof Uint8Array)) {
			for (const [name, child] of Object.entries(node.contents)) {
				stack.push([path === '/' ? `/${name}` : `${path}/${name}`, child]);
			}
		}
	}
}

/**
 * One file node's real bytes.
 *
 * `node.contents` is over-allocated by MEMFS's growth strategy, so `usedBytes` is the
 * only correct length. A lazy node that was never opened has `contents === null` and
 * is never captured, because the pack still reproduces it.
 */
function fileBytes(node: FsNode): Uint8Array {
	const c = node.contents;
	if (!c) return new Uint8Array(0);
	const used = typeof node.usedBytes === 'number' ? node.usedBytes : c.length;
	return c instanceof Uint8Array
		? c.slice(0, used)
		: new Uint8Array(Array.prototype.slice.call(c, 0, used));
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

/**
 * Everything the Drupal boot did to the filesystem after the mount.
 *
 * Three categories, and they replay differently:
 *   - `created`: id >= the post-mount watermark. These CONSUME inode numbers, so they
 *     must be replayed in id order.
 *   - `overwritten`: a file that existed at mount time and no longer matches the pack
 *     -- the database above all, plus any lazy node PHP wrote to (`cfwDirty`). These
 *     consume no inode number, so their order does not matter.
 *   - `inflated`: lazy nodes the boot materialised. Not needed for correctness (the
 *     blob can re-inflate on demand) but it is the measurement A1b was asked for.
 */
function captureFs(FS: MemFS, watermark: number, roots = ['/drupal', '/tmp']) {
	const t0 = Date.now();
	const created: FsRecord[] = [];
	const overwritten: FsRecord[] = [];
	const inflated: string[] = [];
	let scanned = 0;
	let capturedBytes = 0;

	for (const root of roots) {
		for (const { path, node } of walkFs(FS, root)) {
			scanned++;
			const isDir = FS.isDir(node.mode);
			const isFile = FS.isFile(node.mode);
			if (!isDir && !isFile) continue;
			if (isFile && node.cfwEntry && node.cfwLoaded) inflated.push(path);

			const rec: FsRecord = {
				path,
				id: node.id,
				kind: isDir ? 'dir' : 'file',
				mode: node.mode,
				timestamp: node.timestamp,
				bytes: isFile ? fileBytes(node) : null
			};
			if (node.id >= watermark) {
				created.push(rec);
				capturedBytes += rec.bytes?.length ?? 0;
			} else if (isFile && (node.cfwDirty === true || node.cfwEntry === undefined)) {
				overwritten.push(rec);
				capturedBytes += rec.bytes?.length ?? 0;
			}
		}
	}

	created.sort((a: FsRecord, b: FsRecord) => a.id - b.id);
	return {
		watermark,
		nextInode: FS.nextInode,
		created,
		overwritten,
		inflated,
		scanned,
		capturedBytes,
		captureMs: Date.now() - t0
	};
}

/** consumes exactly one inode number without leaving a node behind */
function consumeInode(FS: MemFS, tag: number | string) {
	const path = `/tmp/.cfw-gap-${tag}`;
	FS.writeFile(path, new Uint8Array(0));
	FS.unlink(path);
}

/**
 * Rebuilds the captured delta on a fresh instance, id by id.
 *
 * The loop walks the id RANGE rather than the captured list, because a node the boot
 * created and then unlinked consumed a number and left nothing to copy. Skipping those
 * would shift every later id by one, which is precisely the failure this function
 * exists to avoid -- so a gap is filled with a create/unlink pair.
 */
function replayFs(FS: MemFS, capture: FsCapture) {
	const t0 = Date.now();
	const byId = new Map(capture.created.map((r): [number, FsRecord] => [r.id, r]));
	const out: ReplayReport = {
		dirs: 0,
		files: 0,
		bytes: 0,
		gaps: 0,
		overwritten: 0,
		overwrittenBytes: 0,
		missingParents: [],
		failures: []
	};

	for (let id = capture.watermark; id < capture.nextInode; id++) {
		const rec = byId.get(id);
		if (!rec) {
			try {
				consumeInode(FS, id);
				out.gaps++;
			} catch (e: any) {
				out.failures.push({ id, error: `gap: ${e?.message ?? e}` });
			}
			continue;
		}
		try {
			if (rec.kind === 'dir') {
				FS.mkdir(rec.path, rec.mode & 0o777);
				out.dirs++;
			} else {
				// a parent is always created before its child, so anything missing here is
				// a real divergence rather than something to paper over
				if (!FS.analyzePath(parentOf(rec.path)).exists) {
					out.missingParents.push(rec.path);
				}
				FS.writeFile(rec.path, rec.bytes);
				out.files++;
				out.bytes += rec.bytes!.length;
			}
			if (rec.timestamp) {
				try {
					FS.utime(rec.path, rec.timestamp, rec.timestamp);
				} catch {
					/* some node types reject utime; not fatal */
				}
			}
		} catch (e: any) {
			out.failures.push({ id, path: rec.path, error: `${e?.message ?? e}` });
		}
	}

	for (const rec of capture.overwritten) {
		try {
			FS.writeFile(rec.path, rec.bytes);
			out.overwritten++;
			out.overwrittenBytes += rec.bytes!.length;
		} catch (e: any) {
			out.failures.push({ path: rec.path, error: `overwrite: ${e?.message ?? e}` });
		}
	}

	out.replayMs = Date.now() - t0;
	out.nextInodeAfter = FS.nextInode;
	return out;
}

// captureStreams and replayStreams now come from src/db/heap-store.ts. They were duplicated here
// after being promoted to production, which recreated the two-copies hazard that bit driver.json

/** materialises the same lazy members the snapshot side inflated */
function preInflate(FS: MemFS, paths: string[]) {
	const out = { requested: paths.length, inflated: 0, failed: 0 };
	for (const path of paths) {
		try {
			const stream = FS.open(path, 'r');
			FS.read(stream, new Uint8Array(1), 0, 1, 0);
			FS.close(stream);
			out.inflated++;
		} catch {
			out.failed++;
		}
	}
	return out;
}

// #endregion

// #region A1b: the two sides

/** the Drupal snapshot, module scope so /drupal-snap then /drupal-restore works */
let dsnap: DrupalSnapshot | null = null;

/**
 * Brings up one instance to the same pre-mount filesystem state on both sides.
 *
 * Writing `/php.ini` is what `PhpBase` does before `pib_init`, and it has to happen on
 * BOTH sides even though B never reads it: it consumes an inode, so doing it on one
 * side only would offset every id in the mount by one -- the exact failure the
 * misalignment arm induces deliberately.
 */
async function makeDrupalInstance(bin: BinName) {
	const inst = await makeInstance(bin);
	const FS = inst.mod.FS;
	const baseline = { nextInode: FS.nextInode, streams: FS.streams.length };
	// taken BEFORE /php.ini, so it is the state the glue's own init left behind and
	// nothing this probe did
	const afterFactory = digestBuffer(inst.memory.buffer);
	FS.writeFile('/php.ini', PHP_INI);
	return { inst, FS, baseline, afterFactory, afterIniNextInode: FS.nextInode };
}

/**
 * The mount env, with the LRU budget overridable.
 *
 * `LAZY_FS_BUDGET_BYTES` is what decides whether eviction happens at all. At the 20 MB
 * default the boot inflates 9.7 MB and nothing is ever evicted, so a snapshot taken
 * there cannot answer whether an eviction after restore drops something the restored
 * heap believes is resident. `?budget=2000000` forces the thrashing case on BOTH sides.
 */
const mountEnv = (env: ProbeEnv, opts: DrupalOpts): LazyFsEnv =>
	opts.budget ? { ASSETS: env.ASSETS, LAZY_FS_BUDGET_BYTES: opts.budget } : env;

async function takeDrupalSnapshot(env: ProbeEnv, opts: DrupalOpts = {}) {
	const bin = opts.bin ?? 'free';
	const {
		inst: a,
		FS,
		baseline,
		afterFactory,
		afterIniNextInode
	} = await makeDrupalInstance(bin);
	const stages: Record<string, number> = { atInstantiate: heapBytes(a) };

	const tInit = Date.now();
	let initRc: number | null = null;
	let initThrew: string | null = null;
	try {
		initRc = a.mod.ccall('pib_init', 'number', ['string'], ['embed']);
	} catch (e: any) {
		initThrew = `${e?.stack ?? e}`;
	}
	const pibInit = { rc: initRc, threw: initThrew, ms: Date.now() - tInit, ...a.drain() };
	const afterInit = { nextInode: FS.nextInode, streams: FS.streams.length };
	stages.afterPibInit = heapBytes(a);

	// the real mount path: LAZY_MOUNT=1 is the default in wrangler.jsonc, and the
	// database is fetched because static-free-v1 opens it through PDO
	const tMount = Date.now();
	// `any`: this probe hangs its own `wallMs` on the mount result before reporting it
	const mount: any = await mountDrupalLazy({ FS }, mountEnv(env, opts), { database: true });
	mount.wallMs = Date.now() - tMount;
	stages.afterMount = heapBytes(a);

	// everything created from here on is the boot's, and its ids are what the image
	// will reference
	const watermark = FS.nextInode;
	const afterMount = { nextInode: watermark, streams: FS.streams.length };

	const tBoot = Date.now();
	const bootRun = phpRun(a, DRUPAL_KERNEL_BOOT);
	const boot = { ...phpJson(bootRun), wallMs: Date.now() - tBoot, threw: bootRun.threw };
	stages.afterDrupalBoot = heapBytes(a);
	if (boot.error || boot.parseError) {
		return {
			bin: BINARIES[bin].label,
			baseline,
			afterIniNextInode,
			pibInit,
			mount,
			afterInit,
			afterMount,
			boot,
			stderr: bootRun.err?.slice(0, 2000),
			verdict: 'BOOT FAILED; nothing to snapshot'
		};
	}

	const fsCapture = captureFs(FS, watermark);
	const streams = captureStreams(FS);

	const buf = a.memory.buffer;
	const tCopy = Date.now();
	const bytes = new Uint8Array(buf.byteLength);
	bytes.set(new Uint8Array(buf));
	const copyMs = Date.now() - tCopy;

	dsnap = {
		bin,
		bytes,
		byteLength: buf.byteLength,
		pages: buf.byteLength / PAGE,
		sp: sp(a),
		fs: fsCapture,
		streams,
		globals: readGlobals(a),
		atInstantiate: a.atInstantiate,
		budget: opts.budget ?? null,
		takenAt: Date.now()
	};

	/**
	 * A's own renders, taken AFTER the snapshot.
	 *
	 * TWO of them, because seven instances of the persistent-interpreter bug class in
	 * this project surfaced on request 2 rather than request 1 -- PageCache's memoized
	 * cid, drupal_static and the container all survive between requests. The second
	 * render is 12,310 rather than 12,304 on a healthy interpreter, so the pair is the
	 * reference the restore side has to reproduce, not just the first one.
	 */
	const aRenders = [
		phpJson(phpRun(a, drupalRender('/', false, false))),
		phpJson(phpRun(a, drupalRender('/', false, true)))
	];
	const aRender = aRenders[0];
	dsnap.aRender = aRender;
	dsnap.aRenders = aRenders;
	stages.afterTwoRenders = heapBytes(a);

	return {
		bin: BINARIES[bin].label,
		instance: {
			memoryImported: a.memoryImported,
			pagesAtInstantiate: a.pagesAtInstantiate,
			instantiateMs: a.instantiateMs,
			atInstantiateDigest: a.atInstantiate,
			afterFactoryDigest: afterFactory,
			notes: a.notes.slice(0, 10)
		},
		// the grow question: if afterDrupalBoot equals atInstantiate, a restore into a
		// fresh instance of the SAME binary needs no emscripten_resize_heap at all
		stages,
		growNeededForBoot: stages.afterDrupalBoot! > stages.atInstantiate!,
		baseline,
		afterIniNextInode,
		pibInit: { rc: pibInit.rc, threw: pibInit.threw, ms: pibInit.ms },
		afterInit,
		mount: { ...mount, inflateStats: mount.inflateStats },
		afterMount,
		boot,
		snapshot: {
			pages: dsnap.pages,
			byteLength: dsnap.byteLength,
			copyMs,
			sp: dsnap.sp,
			watermark,
			nextInode: fsCapture.nextInode,
			nodesCreatedByBoot: fsCapture.created.length,
			filesOverwrittenByBoot: fsCapture.overwritten.map((r) => ({
				path: r.path,
				bytes: r.bytes?.length ?? 0
			})),
			inflatedFiles: fsCapture.inflated.length,
			capturedBytes: fsCapture.capturedBytes,
			captureMs: fsCapture.captureMs,
			scannedNodes: fsCapture.scanned,
			openStreams: streams
		},
		aRenders: aRenders.map((r) => ({
			status: r.status ?? null,
			bytes: r.bytes ?? null,
			sha1: r.sha1 ?? null,
			pageCache: r.pageCache ?? null,
			renderMs: r.renderMs ?? null,
			error: r.error
		})),
		referenceMatch: {
			bytes: aRender.bytes ?? null,
			sha1: aRender.sha1 ?? null,
			bytesMatch: aRender.bytes === REFERENCE.bytes,
			sha1Match: aRender.sha1 === REFERENCE.sha1,
			secondRenderBytes: aRenders[1]?.bytes ?? null,
			secondRenderMatch: aRenders[1]?.bytes === REFERENCE.secondRenderBytes
		},
		verdict:
			aRender.bytes === REFERENCE.bytes && aRender.sha1 === REFERENCE.sha1
				? 'SNAPSHOT TAKEN; instance A renders the reference page'
				: 'SNAPSHOT TAKEN; instance A does NOT match the reference'
	};
}

/**
 * The restore side, with every mechanism switchable so the test can be made to fail.
 *
 * `misalign` is the one A1b was written for: N extra files created BEFORE the mount
 * shift every node id in the tree by N, so the mount is structurally identical and
 * numerically wrong. A test that cannot fail proves nothing.
 */
async function restoreDrupal(env: ProbeEnv, opts: DrupalOpts = {}) {
	if (!dsnap) return { error: 'no Drupal snapshot; call /drupal-snap first' };

	const {
		inst: b,
		FS,
		baseline,
		afterFactory,
		afterIniNextInode
	} = await makeDrupalInstance(dsnap.bin);
	const fresh = {
		pagesAtInstantiate: b.pagesAtInstantiate,
		pages: pages(b),
		sp: sp(b),
		nextInode: FS.nextInode,
		streams: FS.streams.length,
		instantiateMs: b.instantiateMs
	};

	// the deliberate break: extra nodes before the mount, so every id shifts
	const misalign: { shift: number; created: { path: string; id: number }[] } = {
		shift: opts.misalign ?? 0,
		created: []
	};
	for (let i = 0; i < misalign.shift; i++) {
		const path = `/tmp/.cfw-misalign-${i}`;
		FS.writeFile(path, new Uint8Array(1));
		misalign.created.push({ path, id: FS.lookupPath(path).node.id });
	}

	const tMount = Date.now();
	// `any` for the same reason the snapshot side does it: `wallMs` is this probe's own field
	const mount: any = await mountDrupalLazy({ FS }, mountEnv(env, opts), { database: true });
	mount.wallMs = Date.now() - tMount;

	// THE ASSERTION A1b ASKS FOR: mounting the tree the same way has to reproduce the
	// numbering the snapshot side reached, with no correction applied
	const mountAlignment = {
		snapshotWatermark: dsnap.fs.watermark,
		freshWatermark: FS.nextInode,
		delta: FS.nextInode - dsnap.fs.watermark,
		aligned: FS.nextInode === dsnap.fs.watermark
	};

	const fsReplay =
		opts.fsdelta === false
			? { skipped: 'fsdelta=0' }
			: replayFs(FS, { ...dsnap.fs, watermark: dsnap.fs.watermark });

	const inode = {
		snapshotNextInode: dsnap.fs.nextInode,
		freshNextInode: FS.nextInode,
		match: FS.nextInode === dsnap.fs.nextInode,
		forced: false
	};
	// only ever a fallback, and it is reported: forcing the counter fixes FUTURE ids
	// and cannot fix a node that already took the wrong one
	if (opts.forceInode === true && !inode.match) {
		FS.nextInode = dsnap.fs.nextInode;
		inode.forced = true;
	}

	const preinflate = opts.preinflate === true ? preInflate(FS, dsnap.fs.inflated) : null;

	const grow = growHeap(b, dsnap.byteLength);
	if (grow.error) {
		return {
			fresh,
			misalign,
			mount,
			mountAlignment,
			grow,
			verdict: 'could not size the fresh instance'
		};
	}

	/**
	 * THE BASELINE ASSERTIONS, taken at the last possible moment before the memcpy.
	 *
	 * `baselineIdentical` is the invariant zero-page elision would rest on: the two
	 * instances must hold the same bytes at instantiation, or a diff-against-baseline
	 * snapshot restores into a heap that runs and is quietly wrong.
	 * `nothingWroteBeforeRestore` proves the mount, the FS replay, the stream replay and
	 * the pre-inflation all stayed on the JS side of the boundary. A grow legitimately
	 * changes the word count, so that case is reported rather than failed.
	 */
	const preWrite = digestBuffer(b.memory.buffer);
	const baselines = {
		snapshotAtInstantiate: dsnap.atInstantiate,
		freshAtInstantiate: b.atInstantiate,
		baselineIdentical: dsnap.atInstantiate?.hash === b.atInstantiate?.hash,
		freshAfterFactory: afterFactory,
		freshPreWrite: preWrite,
		grewBeforeWrite: preWrite.words !== afterFactory.words,
		nothingWroteBeforeRestore: preWrite.hash === afterFactory.hash
	};

	const tWrite = Date.now();
	new Uint8Array(b.memory.buffer).set(dsnap.bytes);
	const writeMs = Date.now() - tWrite;

	const stack: {
		snapshotSp: number | string;
		freshSp: number | string;
		restored: boolean;
		error: string | null;
		spAfter?: number | string;
	} = { snapshotSp: dsnap.sp, freshSp: fresh.sp, restored: false, error: null };
	if (opts.stack !== false && typeof dsnap.sp === 'number') {
		try {
			b.stackRestore!(dsnap.sp);
			stack.restored = true;
			stack.spAfter = sp(b);
		} catch (e: any) {
			stack.error = `${e?.message ?? e}`;
		}
	}

	// `dropfd` is what turns "the fd table matters" into "THIS descriptor matters":
	// dropping fd 6 alone leaves /dev/urandom closed, dropping 3,4,5 leaves the sqlite
	// handles closed, and the two fail in completely different places
	const dropped = new Set<number>(opts.dropfd ?? []);
	const wanted = dsnap.streams.filter((s: StreamRecord) => !dropped.has(s.fd));
	const streams =
		opts.streams === false
			? { skipped: 'streams=0' }
			: { dropped: [...dropped], ...replayStreams(FS, wanted) };

	// TWO requests, not one. The restored heap holds the container, drupal_static and
	// PageCache's memoized cid, and this project has seven instances of a
	// persistent-interpreter defect that first showed on request 2.
	const renders: any[] = [];
	for (let i = 0; i < Math.max(1, opts.renders ?? 2); i++) {
		const run = phpRun(b, drupalRender('/', opts.html === true && i === 0, i > 0));
		const parsed = phpJson(run);
		if (run.threw) parsed.trapped = run.threw.slice(0, 600);
		if (run.err) parsed.stderr = run.err.slice(0, 1200);
		renders.push(parsed);
		// a trap poisons the instance; a second call would only produce noise
		if (run.threw) break;
	}
	const render = renders[0];
	const second = renders[1];

	const bytesMatch = render.bytes === REFERENCE.bytes;
	const sha1Match = render.sha1 === REFERENCE.sha1;
	const secondMatchesA = second?.bytes === dsnap.aRenders?.[1]?.bytes;
	const matchesA = render.bytes === dsnap.aRender?.bytes && render.sha1 === dsnap.aRender?.sha1;

	return {
		bin: BINARIES[dsnap.bin].label,
		fresh,
		baseline,
		afterIniNextInode,
		misalign,
		mount: {
			mode: mount.mode,
			files: mount.files,
			dirs: mount.dirs,
			wallMs: mount.wallMs,
			budgetBytes: mount.budgetBytes,
			inflateStats: mount.inflateStats
		},
		mountAlignment,
		fsReplay,
		inode,
		preinflate,
		baselines,
		grow,
		writeMs,
		bytesWritten: dsnap.byteLength,
		stack,
		streams,
		renders: renders.map((r) => ({
			status: r.status ?? null,
			bytes: r.bytes ?? null,
			sha1: r.sha1 ?? null,
			pageCache: r.pageCache ?? null,
			dynamicCache: r.dynamicCache ?? null,
			renderMs: r.renderMs ?? null,
			kernelFromHeap: r.kernelFromHeap ?? null,
			error: r.error,
			trapped: r.trapped,
			trace: r.trace?.slice(0, 400)
		})),
		reference: {
			...REFERENCE,
			bytesMatch,
			sha1Match,
			secondRenderBytes: second?.bytes ?? null,
			secondRenderMatch: second?.bytes === REFERENCE.secondRenderBytes
		},
		instanceA: dsnap.aRenders
			? dsnap.aRenders.map((r) => ({ bytes: r.bytes, sha1: r.sha1 }))
			: null,
		matchesInstanceA: matchesA,
		secondMatchesInstanceA: secondMatchesA,
		verdict:
			bytesMatch && sha1Match
				? secondMatchesA
					? 'RESTORED DRUPAL HEAP RENDERS THE REFERENCE PAGE, TWICE'
					: 'PARTIAL: render 1 is the reference, render 2 diverges from instance A'
				: render.error || render.trapped
					? 'FAILED: the restored heap could not render'
					: 'FAILED: rendered, but not the reference bytes'
	};
}

/**
 * The negative arm for A1b: a fresh instance with the tree mounted and NO image.
 *
 * `boot=1` turns it into a positive control instead -- B boots Drupal itself -- which
 * is what distinguishes "the restore failed" from "this instance could never have
 * rendered anyway".
 */
async function controlDrupal(env: ProbeEnv, opts: DrupalOpts = {}) {
	const bin = opts.bin ?? dsnap?.bin ?? 'free';
	const { inst: b, FS } = await makeDrupalInstance(bin);
	const stages: Record<string, number> = { atInstantiate: heapBytes(b) };
	if (opts.init === true) b.mod.ccall('pib_init', 'number', ['string'], ['embed']);
	b.drain();
	stages.afterPibInit = heapBytes(b);

	const mount = await mountDrupalLazy({ FS }, mountEnv(env, opts), { database: true });
	const watermark = FS.nextInode;
	stages.afterMount = heapBytes(b);

	const boot = opts.boot === true ? phpJson(phpRun(b, DRUPAL_KERNEL_BOOT)) : null;
	stages.afterDrupalBoot = heapBytes(b);

	const renders: any[] = [];
	for (let i = 0; i < Math.max(1, opts.renders ?? 1); i++) {
		const run = phpRun(b, drupalRender('/', false, i > 0));
		const parsed = phpJson(run);
		if (run.threw) parsed.trapped = run.threw.slice(0, 600);
		renders.push(parsed);
		if (run.threw) break;
	}
	stages.afterRenders = heapBytes(b);

	return {
		bin: BINARIES[bin].label,
		pibInit: opts.init === true,
		selfBooted: opts.boot === true,
		// the answer to "does a post-boot heap exceed this binary's INITIAL_MEMORY", which
		// is what decides whether the restore needs a grow path at all
		stages,
		pages: pages(b),
		mount: {
			mode: mount.mode,
			files: mount.files,
			dirs: mount.dirs,
			budgetBytes: mount.budgetBytes,
			inflateStats: mount.inflateStats
		},
		watermark,
		boot,
		renders,
		notes: b.notes.slice(0, 10)
	};
}

// #endregion

const bool = (u: URL, k: string, d = true) =>
	u.searchParams.has(k) ? u.searchParams.get(k) !== '0' : d;
const num = (u: URL, k: string, d = 0) => {
	const n = Number(u.searchParams.get(k) ?? d);
	return Number.isFinite(n) ? n : d;
};

const ROUTES = [
	'/snap',
	'/restore',
	'/control',
	'/all',
	'/state',
	'/drupal-snap',
	'/drupal-restore',
	'/drupal-control',
	'/drupal-all'
];

export default {
	async fetch(request: Request, env: ProbeEnv): Promise<Response> {
		const url = new URL(request.url);
		const restoreOpts = (): DrupalOpts => ({
			// cast on a query string, as in heapsize.ts: an unknown name falls through to the
			// `?? BINARIES.o2` default rather than being validated here
			bin: (url.searchParams.get('bin') ?? undefined) as BinName | undefined,
			fsdelta: bool(url, 'fsdelta'),
			streams: bool(url, 'streams'),
			stack: bool(url, 'stack'),
			preinflate: bool(url, 'preinflate', false),
			forceInode: bool(url, 'forceInode', false),
			html: bool(url, 'html', false),
			misalign: num(url, 'misalign', 0),
			renders: num(url, 'renders', 2),
			budget: num(url, 'budget', 0),
			dropfd: (url.searchParams.get('dropfd') ?? '')
				.split(',')
				.map((s) => Number(s.trim()))
				.filter((n) => Number.isInteger(n) && n >= 3)
		});
		const snapOpts = (): DrupalOpts => ({
			bin: (url.searchParams.get('bin') ?? 'free') as BinName,
			budget: num(url, 'budget', 0)
		});
		try {
			switch (url.pathname) {
				case '/snap':
					return Response.json(
						await takeSnapshot({
							warmup: bool(url, 'warmup', false),
							bloatMb: num(url, 'bloatMb', 0)
						})
					);

				case '/restore':
					return Response.json(
						await restore({
							globals: bool(url, 'globals'),
							stack: bool(url, 'stack'),
							inode: bool(url, 'inode')
						})
					);

				case '/control':
					return Response.json(await control());

				case '/all': {
					const s = await takeSnapshot({
						warmup: bool(url, 'warmup', false),
						bloatMb: num(url, 'bloatMb', 0)
					});
					const r = await restore({
						globals: bool(url, 'globals'),
						stack: bool(url, 'stack'),
						inode: bool(url, 'inode')
					});
					return Response.json({ snap: s, restore: r });
				}

				case '/drupal-snap':
					return Response.json(await takeDrupalSnapshot(env, snapOpts()));

				case '/drupal-restore':
					return Response.json(await restoreDrupal(env, restoreOpts()));

				case '/drupal-control':
					return Response.json(
						await controlDrupal(env, {
							bin: (url.searchParams.get('bin') ?? undefined) as BinName | undefined,
							init: bool(url, 'init', false),
							boot: bool(url, 'boot', false),
							renders: num(url, 'renders', 1),
							budget: num(url, 'budget', 0)
						})
					);

				case '/drupal-all': {
					const s = await takeDrupalSnapshot(env, snapOpts());
					const r = await restoreDrupal(env, restoreOpts());
					return Response.json({ snap: s, restore: r });
				}

				case '/state':
					return Response.json({
						hasSnapshot: Boolean(snap),
						pages: snap?.pages ?? null,
						byteLength: snap?.byteLength ?? null,
						drupal: dsnap
							? {
									bin: BINARIES[dsnap.bin].label,
									byteLength: dsnap.byteLength,
									watermark: dsnap.fs.watermark,
									nextInode: dsnap.fs.nextInode,
									createdByBoot: dsnap.fs.created.length,
									overwrittenByBoot: dsnap.fs.overwritten.length,
									inflated: dsnap.fs.inflated.length,
									openStreams: dsnap.streams.length,
									aRender: dsnap.aRender
										? { bytes: dsnap.aRender.bytes, sha1: dsnap.aRender.sha1 }
										: null
								}
							: null
					});

				default:
					return new Response(ROUTES.join('\n'), { status: 404 });
			}
		} catch (e: any) {
			return new Response(`${e?.stack ?? e}`, { status: 500 });
		}
	}
};
