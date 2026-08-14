// must evaluate before the glue; see the file for why
import '@drupflare/cartridge/shim';

import { PhpBase, type PhpBaseModuleFactory, type PhpRuntimeArgs } from 'php-wasm/PhpBase';
import FreeFactory from '../../vendor/static-free-v1/php8.3-worker.mjs';
import freeWasm from '../../vendor/static-free-v1/php8.3-worker.mjs.wasm';
import O2Factory from '../../vendor/static-o2/php8.3-worker.mjs';
import o2Wasm from '../../vendor/static-o2/php8.3-worker.mjs.wasm';
import { DRUPAL_BOOT } from './drupal-boot';

/**
 * Sizes the thing a post-boot memory snapshot would have to store.
 *
 * Two independent levers, both measurable without a rebuild:
 *
 * 1. `INITIAL_MEMORY`. The wasm module DEFINES its memory (min 1536 pages, max
 *    8192) rather than importing it, so the figure is baked into the binary and
 *    the only runtime evidence is `memory.buffer.byteLength` at instantiation.
 *    `WebAssembly.Memory.prototype.grow` is patched here because emscripten's
 *    `growMemory` calls it from JS, which makes every plateau boundary
 *    observable exactly instead of by polling.
 * 2. Zero-page elision. A snapshot only has to carry pages that differ from the
 *    post-instantiation heap; `memory.grow` zero-fills, so pages past the
 *    baseline's extent have a definitionally-zero baseline and need no stored
 *    copy.
 *
 * The baseline is captured at the 4 KiB grain only and the 64 KiB answer is
 * aggregated 16:1 from it -- a 64 KiB page is identical iff all sixteen of its
 * sub-pages are. That is exact, and it costs one scan instead of two.
 *
 * Comparison is byte-exact, not hashed: the active data segments total 1.24 MiB
 * across 359 of the 24,576 4 KiB pages, so keeping real copies of every
 * non-zero baseline page costs ~1.5 MB.
 *
 * TWO BINARIES, because static-o2 cannot boot Drupal on its own. It has no
 * `pdo_sqlite` (`WITH_SQLITE=0` in `build/rc/control.rc`), so `DRUPAL_BOOT`
 * dies at `PDOException: could not find driver` while building the container --
 * the shipping path reaches a database through the Durable Object driver in
 * `src/db/do-sqlite.js`, which is far more wiring than a heap probe should
 * carry. `static-free-v1` has SQLite compiled in and is the build every
 * historical memory figure in TECHNICAL_REPORT.md was taken on, so `?bin=free`
 * measures a REAL post-boot Drupal heap and `?bin=o2` measures the shipping
 * binary's INITIAL_MEMORY and its partial boot. Neither is a substitute for the
 * other; both are reported.
 */

/** each glue's own getHeapMax(), grepped from the vendored .mjs */
const HEAP_MAX = { o2: 536870912, free: 536870912 };

/** min/max from each wasm binary's memory section, in 64 KiB pages */
const DECLARED_PAGES = { o2: { min: 1536, max: 8192 }, free: { min: 1024, max: 8192 } };

/**
 * The wasm import key that maps to `_emscripten_resize_heap` in each glue.
 *
 * This is the ONLY way to see the size PHP actually asked for. `memory.grow`
 * only ever sees the size emscripten already rounded up -- `resize_heap`
 * computes `max(requestedSize, oldSize * 1.2)` and page-aligns it before
 * calling grow, so a grow log reports the plateau and hides the demand.
 * Recovered with:
 *   grep -o -E "[A-Za-z0-9_]+:_emscripten_resize_heap" vendor/<build>/php8.3-worker.mjs
 * static-o2's glue is unminified here; static-free-v1's is not.
 */
const RESIZE_IMPORT = { o2: 'emscripten_resize_heap', free: 'ea' };

const BINARIES = {
	o2: { label: 'vendor/static-o2', PHPFactory: O2Factory, wasmModule: o2Wasm },
	free: { label: 'vendor/static-free-v1', PHPFactory: FreeFactory, wasmModule: freeWasm }
};

const GRAIN_FINE = 4096;
const GRAIN_COARSE = 65536;

/** which vendored build a route ran against; the two are not substitutes for each other */
type BinName = keyof typeof BINARIES;

/** the three MEMFS calls a mount makes; emscripten's FS is far wider than this */
interface ProbeFS {
	mkdir(path: string): void;
	writeFile(path: string, data: Uint8Array | string): void;
	utime(path: string, atime: number, mtime: number): void;
}

/** the emscripten Module, as this worker uses it; php-wasm types `FS` as bare `object` */
interface ProbeBinary {
	FS: ProbeFS;
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

/** one `memory.grow`, tagged with the phase that caused it */
interface GrowEvent {
	tag: string;
	ms: number;
	requestedDeltaPages: number;
	beforeBytes: number;
	afterBytes: number;
	error: string | null;
}

/** one heap size PHP asked for, before emscripten rounded it up to a plateau */
interface DemandEvent {
	tag: string;
	requestedBytes: number;
	requestedMiB: number;
	granted: unknown;
}

/** the post-instantiation heap a snapshot is measured against */
type Baseline = ReturnType<typeof captureBaseline>;

/** a booted interpreter, plus everything the instantiation hook recorded for it */
interface HeapInstance {
	bin: BinName;
	php: PhpStatic;
	out: any[];
	diag: string[];
	binary: ProbeBinary;
	memory: WebAssembly.Memory;
	baseline: Baseline;
	instantiationBytes: number;
	memoryType: unknown;
	bootMs: number;
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

/** streaming mount, copied from src/probes/o2.js so the peak stays one pending chunk */
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

// #region grow instrumentation

/** every memory.grow this isolate has seen, tagged with the phase that caused it */
const growLog: GrowEvent[] = [];
/** every heap size PHP asked for, before emscripten rounded it up to a plateau */
const demandLog: DemandEvent[] = [];
let growTag = 'module-eval';
let growPatched = false;
let growPatchError: string | null = null;
let resizePatched = false;

try {
	const proto = WebAssembly.Memory.prototype;
	const original = proto.grow;
	// the `this` parameter is a type annotation only; the patch is installed on the prototype
	proto.grow = function grow(this: WebAssembly.Memory, delta: number) {
		const beforeBytes = this.buffer.byteLength;
		const t0 = Date.now();
		// asserted rather than initialised: the only path that skips the assignment rethrows
		let result!: number;
		let error: string | null = null;
		try {
			result = original.call(this, delta);
		} catch (e: any) {
			error = `${e?.message ?? e}`;
			throw e;
		} finally {
			growLog.push({
				tag: growTag,
				ms: Date.now() - t0,
				requestedDeltaPages: delta,
				beforeBytes,
				afterBytes: error === null ? this.buffer.byteLength : beforeBytes,
				error
			});
		}
		return result;
	};
	growPatched = true;
} catch (e: any) {
	growPatchError = `${e?.message ?? e}`;
}

function growsFor(tag: string) {
	return growLog.filter((g) => g.tag === tag);
}

/** wraps the resize import in place, before instantiation, so the demand is recorded */
function instrumentResize(imports: Record<string, any>, bin: BinName) {
	const key = RESIZE_IMPORT[bin];
	for (const ns of Object.values(imports)) {
		if (!ns || typeof ns !== 'object') continue;
		const fn = ns[key];
		if (typeof fn !== 'function') continue;
		ns[key] = (requestedSize: number) => {
			const ok = fn(requestedSize);
			demandLog.push({
				tag: growTag,
				requestedBytes: requestedSize >>> 0,
				requestedMiB: +((requestedSize >>> 0) / 1048576).toFixed(3),
				granted: ok
			});
			return ok;
		};
		resizePatched = true;
		return;
	}
}

// #endregion

// #region page accounting

/**
 * Copies out every non-zero page of a freshly instantiated heap.
 *
 * Scanned as u32 because the grain divides by 4 and a word compare is ~4x the
 * throughput of a byte compare over 96 MiB.
 */
function captureBaseline(buffer: ArrayBufferLike, grain: number) {
	const t0 = Date.now();
	const u32 = new Uint32Array(buffer);
	const wordsPerPage = grain / 4;
	const nPages = u32.length / wordsPerPage;
	const zero = new Uint8Array(nPages);
	const pages = new Map<number, Uint32Array>();
	for (let p = 0; p < nPages; p++) {
		const s = p * wordsPerPage;
		const e = s + wordsPerPage;
		let allZero = true;
		for (let i = s; i < e; i++) {
			if (u32[i] !== 0) {
				allZero = false;
				break;
			}
		}
		if (allZero) zero[p] = 1;
		else pages.set(p, u32.slice(s, e));
	}
	return {
		grain,
		nPages,
		zero,
		pages,
		bytes: buffer.byteLength,
		nonZeroPages: pages.size,
		heldBytes: pages.size * grain,
		scanMs: Date.now() - t0
	};
}

/**
 * Classifies the current heap against the baseline at the fine grain, then
 * aggregates to the coarse grain.
 *
 * A page past the baseline's extent is compared against zeros, because
 * `memory.grow` zero-fills by specification -- so "identical to baseline" and
 * "all zero" coincide there rather than being unknowable.
 */
function classify(buffer: ArrayBufferLike, baseline: Baseline) {
	const t0 = Date.now();
	const u32 = new Uint32Array(buffer);
	const wordsPerPage = baseline.grain / 4;
	const nPages = u32.length / wordsPerPage;

	const differs = new Uint8Array(nPages);
	const counts = {
		identicalAndZero: 0,
		identicalAndNonZero: 0,
		differsNowZero: 0,
		differsNonZero: 0,
		grownPages: Math.max(0, nPages - baseline.nPages)
	};

	for (let p = 0; p < nPages; p++) {
		const s = p * wordsPerPage;
		const e = s + wordsPerPage;

		let allZero = true;
		for (let i = s; i < e; i++) {
			if (u32[i] !== 0) {
				allZero = false;
				break;
			}
		}

		// past the baseline extent, or a baseline page that was all zero
		const baseZero = p >= baseline.nPages || baseline.zero[p] === 1;
		if (baseZero) {
			if (allZero) counts.identicalAndZero++;
			else {
				differs[p] = 1;
				counts.differsNonZero++;
			}
			continue;
		}

		const base = baseline.pages.get(p);
		let same = true;
		for (let i = 0; i < wordsPerPage; i++) {
			if (u32[s + i] !== base![i]) {
				same = false;
				break;
			}
		}
		if (same) counts.identicalAndNonZero++;
		else {
			differs[p] = 1;
			if (allZero) counts.differsNowZero++;
			else counts.differsNonZero++;
		}
	}

	// a coarse page differs iff any of its sub-pages does
	const ratio = GRAIN_COARSE / baseline.grain;
	const nCoarse = Math.ceil(nPages / ratio);
	const differsCoarse = new Uint8Array(nCoarse);
	let coarseDiff = 0;
	for (let p = 0; p < nPages; p++) {
		if (differs[p] && !differsCoarse[(p / ratio) | 0]) {
			differsCoarse[(p / ratio) | 0] = 1;
			coarseDiff++;
		}
	}

	const fineDiff = counts.differsNowZero + counts.differsNonZero;
	return {
		classifyMs: Date.now() - t0,
		heapBytes: buffer.byteLength,
		fine: {
			grain: baseline.grain,
			pages: nPages,
			identicalToBaseline: nPages - fineDiff,
			allZeroNow: countZeroPages(u32, wordsPerPage, nPages),
			differing: fineDiff,
			...counts
		},
		coarse: {
			grain: GRAIN_COARSE,
			pages: nCoarse,
			identicalToBaseline: nCoarse - coarseDiff,
			differing: coarseDiff
		},
		differs,
		differsCoarse
	};
}

function countZeroPages(u32: Uint32Array, wordsPerPage: number, nPages: number) {
	let n = 0;
	for (let p = 0; p < nPages; p++) {
		const s = p * wordsPerPage;
		const e = s + wordsPerPage;
		let allZero = true;
		for (let i = s; i < e; i++) {
			if (u32[i] !== 0) {
				allZero = false;
				break;
			}
		}
		if (allZero) n++;
	}
	return n;
}

/** the snapshot format priced here: a 12-byte header, a page bitmap, then the pages */
function snapshotShape(heapBytes: number, grain: number, pages: number, differing: number) {
	const bitmapBytes = Math.ceil(pages / 8);
	const headerBytes = 12;
	const payloadBytes = differing * grain;
	return {
		grain,
		pages,
		differing,
		headerBytes,
		bitmapBytes,
		payloadBytes,
		totalBytes: headerBytes + bitmapBytes + payloadBytes,
		vsRawHeapPct: +((100 * (headerBytes + bitmapBytes + payloadBytes)) / heapBytes).toFixed(2),
		indexListBytesIfNotBitmap: differing * 4
	};
}

// #endregion

// #region compression

function* snapshotChunks(
	buffer: ArrayBufferLike,
	grain: number,
	differs: Uint8Array,
	bitmapAndHeader: Uint8Array | null
) {
	if (bitmapAndHeader) yield bitmapAndHeader;
	const bytes = new Uint8Array(buffer);
	for (let p = 0; p < differs.length; p++) {
		if (differs[p]) yield bytes.slice(p * grain, p * grain + grain);
	}
}

function headerAndBitmap(heapBytes: number, grain: number, differs: Uint8Array) {
	const header = new Uint8Array(12);
	new DataView(header.buffer).setUint32(0, heapBytes, true);
	new DataView(header.buffer).setUint32(4, grain, true);
	new DataView(header.buffer).setUint32(8, differs.length, true);
	const bitmap = new Uint8Array(Math.ceil(differs.length / 8));
	for (let p = 0; p < differs.length; p++) {
		if (differs[p]) bitmap[p >> 3]! |= 1 << (p & 7);
	}
	const out = new Uint8Array(header.length + bitmap.length);
	out.set(header);
	out.set(bitmap, header.length);
	return out;
}

/**
 * Streams an iterable through CompressionStream and totals the output.
 *
 * The reader runs concurrently with the writer on purpose: awaiting every write
 * before reading anything deadlocks on backpressure once the output exceeds the
 * queue, and holding the whole compressed result would defeat the point of
 * streaming a 100 MB heap.
 */
async function gzipSize(iterable: Iterable<Uint8Array>, keep?: boolean) {
	const t0 = Date.now();
	const cs = new CompressionStream('gzip');
	const writer = cs.writable.getWriter();
	const reader = cs.readable.getReader();
	let total = 0;
	const kept: Uint8Array[] | null = keep ? [] : null;
	const draining = (async () => {
		for (;;) {
			const r = await reader.read();
			if (r.done) return;
			total += r.value.byteLength;
			if (kept) kept.push(r.value);
		}
	})();
	let inputBytes = 0;
	for (const chunk of iterable) {
		inputBytes += chunk.byteLength;
		await writer.write(chunk);
	}
	await writer.close();
	await draining;
	return { inputBytes, gzipBytes: total, gzipMs: Date.now() - t0, kept };
}

/** wall clock only; whether workerd bills this as CPU is not observable from inside */
async function gunzipSize(chunks: Uint8Array[]) {
	const t0 = Date.now();
	const ds = new DecompressionStream('gzip');
	const writer = ds.writable.getWriter();
	const reader = ds.readable.getReader();
	let total = 0;
	const draining = (async () => {
		for (;;) {
			const r = await reader.read();
			if (r.done) return;
			total += r.value.byteLength;
		}
	})();
	for (const chunk of chunks) await writer.write(chunk);
	await writer.close();
	await draining;
	return { bytesOut: total, gunzipMs: Date.now() - t0 };
}

// #endregion

// #region the interpreter

/** the WebAssembly.Memory of the most recent build, kept because Module never exposes it */
let lastMemory: WebAssembly.Memory | null = null;
let lastBaseline: Baseline | null = null;
let lastInstantiationBytes: number | null = null;
let lastMemoryType: unknown = null;

class PhpStatic extends PhpBase {
	/** the raw entry point php-wasm's published types omit; `run()` is a wrapper over it */
	declare _run: (code: string) => Promise<unknown>;

	constructor(bin: BinName, args: PhpRuntimeArgs = {}, diag: string[] = []) {
		const t0 = Date.now();
		const note = (m: string) => diag.push(`+${Date.now() - t0}ms ${m}`);
		const { PHPFactory, wasmModule } = BINARIES[bin];
		// php-wasm types the loader's `default` as a CONSTRUCTOR, while every real php-wasm build
		// exports an emscripten factory function; the cast is over that upstream mismatch
		super(
			Promise.resolve({ default: PHPFactory }) as unknown as Promise<PhpBaseModuleFactory>,
			{
				...args,
				// same ini as src/probes/o2.js, so opcache state cannot explain a delta
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
					instrumentResize(imports, bin);
					WebAssembly.instantiate(wasmModule, imports)
						.then((instance) => {
							// the memory is DEFINED by the module, so this is the only place
							// the INITIAL_MEMORY the binary was linked with is observable, and
							// the only moment the heap is still untouched by the glue's init
							const mem = Object.values(instance.exports).find(
								(v) => v instanceof WebAssembly.Memory
							) as WebAssembly.Memory | undefined;
							lastMemory = mem ?? null;
							lastInstantiationBytes = mem ? mem.buffer.byteLength : null;
							try {
								// `type()` is the memory-type reflection proposal, absent from the TS lib
								lastMemoryType =
									typeof (mem as any)?.type === 'function'
										? (mem as any).type()
										: null;
							} catch {
								lastMemoryType = null;
							}
							note(`instantiated at ${lastInstantiationBytes} bytes`);
							if (mem) {
								lastBaseline = captureBaseline(mem.buffer, GRAIN_FINE);
								note(`baseline captured in ${lastBaseline.scanMs}ms`);
							}
							receiveInstance(instance, wasmModule);
						})
						.catch((e: any) => note(`FAILED: ${e?.message ?? e}`));
					return {};
				}
			}
		);
	}
}

async function build(bin: BinName, tag: string): Promise<HeapInstance> {
	const prev = growTag;
	growTag = tag;
	const diag: string[] = [];
	const out: any[] = [];
	const t0 = Date.now();
	const php = new PhpStatic(bin, {}, diag);
	php.addEventListener('output', (e: any) => out.push(...[].concat(e.detail ?? [])));
	php.addEventListener('error', (e: any) => out.push(...[].concat(e.detail ?? [])));
	const binary = (await php.binary) as unknown as ProbeBinary;
	growTag = prev;
	return {
		bin,
		php,
		out,
		diag,
		binary,
		// asserted, not checked: instantiateWasm has run by the time `php.binary` resolves, and
		// every route below is written on that invariant
		memory: lastMemory!,
		baseline: lastBaseline!,
		instantiationBytes: lastInstantiationBytes!,
		memoryType: lastMemoryType,
		bootMs: Date.now() - t0
	};
}

/** `?bin=o2` (default, the shipping binary) or `?bin=free` (the one that can boot Drupal) */
function pickBin(url: URL): BinName {
	// cast then check: the guard below is what makes an unknown name an error rather than a
	// silent default, so the type has to allow the lookup first
	const bin = (url.searchParams.get('bin') ?? 'o2') as BinName;
	if (!BINARIES[bin]) throw new Error(`unknown bin '${bin}'; use o2 or free`);
	return bin;
}

async function exec(inst: HeapInstance, code: string, tag?: string) {
	const prev = growTag;
	if (tag) growTag = tag;
	inst.out.length = 0;
	await inst.php._run(code);
	growTag = prev;
	return inst.out.join('');
}

function parseJson(raw: string): any {
	try {
		return JSON.parse(raw.slice(raw.indexOf('{')));
	} catch {
		return { raw: raw.slice(0, 900) };
	}
}

// #endregion

/** the shape both /bare and /drupal report, so the two are directly comparable */
async function report(inst: HeapInstance, url: URL, extra: Record<string, unknown>) {
	const heap = inst.memory.buffer;
	const cls = classify(heap, inst.baseline);

	const fineShape = snapshotShape(cls.heapBytes, GRAIN_FINE, cls.fine.pages, cls.fine.differing);
	const coarseShape = snapshotShape(
		cls.heapBytes,
		GRAIN_COARSE,
		cls.coarse.pages,
		cls.coarse.differing
	);

	const keep = url.searchParams.get('roundtrip') === '1';
	const rawGzip = url.searchParams.get('rawgzip') === '1';

	const coarseHeader = headerAndBitmap(cls.heapBytes, GRAIN_COARSE, cls.differsCoarse);
	const fineHeader = headerAndBitmap(cls.heapBytes, GRAIN_FINE, cls.differs);

	const coarseGz = await gzipSize(
		snapshotChunks(heap, GRAIN_COARSE, cls.differsCoarse, coarseHeader),
		keep && coarseShape.totalBytes < 48 * 1048576
	);
	const fineGz = await gzipSize(snapshotChunks(heap, GRAIN_FINE, cls.differs, fineHeader), false);
	const pagesOnlyCoarseGz = await gzipSize(
		snapshotChunks(heap, GRAIN_COARSE, cls.differsCoarse, null),
		false
	);

	let roundtrip: Awaited<ReturnType<typeof gunzipSize>> | null = null;
	if (coarseGz.kept) roundtrip = await gunzipSize(coarseGz.kept);

	let rawHeapGzip: Awaited<ReturnType<typeof gzipSize>> | null = null;
	if (rawGzip) {
		const all = new Uint8Array(cls.fine.pages).fill(1);
		rawHeapGzip = await gzipSize(snapshotChunks(heap, GRAIN_FINE, all, null), false);
	}

	return {
		build: BINARIES[inst.bin].label,
		initialMemory: {
			atInstantiationBytes: inst.instantiationBytes,
			atInstantiationMiB: +(inst.instantiationBytes / 1048576).toFixed(3),
			atInstantiationPages64K: inst.instantiationBytes / 65536,
			declaredPages: DECLARED_PAGES[inst.bin],
			memoryTypeIfSupported: inst.memoryType,
			glueGetHeapMax: HEAP_MAX[inst.bin],
			glueGetHeapMaxMiB: HEAP_MAX[inst.bin] / 1048576
		},
		heapNow: {
			bytes: cls.heapBytes,
			miB: +(cls.heapBytes / 1048576).toFixed(3),
			pages64K: cls.heapBytes / 65536,
			grewSinceInstantiation: cls.heapBytes !== inst.instantiationBytes
		},
		growth: {
			growInstrumented: growPatched,
			resizeInstrumented: resizePatched,
			instrumentError: growPatchError,
			events: growLog,
			plateausBytes: [...new Set(growLog.map((g) => g.afterBytes))],
			// the sizes PHP asked for, which is what INITIAL_MEMORY has to cover
			demand: demandLog,
			peakDemandBytes: demandLog.length
				? Math.max(...demandLog.map((d) => d.requestedBytes))
				: inst.instantiationBytes
		},
		baseline: {
			grain: inst.baseline.grain,
			pages: inst.baseline.nPages,
			nonZeroPages: inst.baseline.nonZeroPages,
			heldBytes: inst.baseline.heldBytes,
			scanMs: inst.baseline.scanMs
		},
		elision: {
			classifyMs: cls.classifyMs,
			fine: cls.fine,
			coarse: cls.coarse,
			snapshot: { fine: fineShape, coarse: coarseShape },
			gzip: {
				coarseFullSnapshot: {
					inputBytes: coarseGz.inputBytes,
					gzipBytes: coarseGz.gzipBytes,
					gzipMs: coarseGz.gzipMs,
					ratio: +(coarseGz.gzipBytes / coarseGz.inputBytes).toFixed(4),
					vsRawHeapPct: +((100 * coarseGz.gzipBytes) / cls.heapBytes).toFixed(2)
				},
				coarsePagesOnly: {
					inputBytes: pagesOnlyCoarseGz.inputBytes,
					gzipBytes: pagesOnlyCoarseGz.gzipBytes,
					gzipMs: pagesOnlyCoarseGz.gzipMs
				},
				fineFullSnapshot: {
					inputBytes: fineGz.inputBytes,
					gzipBytes: fineGz.gzipBytes,
					gzipMs: fineGz.gzipMs,
					ratio: +(fineGz.gzipBytes / fineGz.inputBytes).toFixed(4),
					vsRawHeapPct: +((100 * fineGz.gzipBytes) / cls.heapBytes).toFixed(2)
				},
				rawWholeHeap: rawHeapGzip
					? {
							inputBytes: rawHeapGzip.inputBytes,
							gzipBytes: rawHeapGzip.gzipBytes,
							gzipMs: rawHeapGzip.gzipMs
						}
					: 'skipped; pass ?rawgzip=1'
			},
			roundtrip: roundtrip ?? 'skipped; pass ?roundtrip=1'
		},
		...extra
	};
}

export default {
	async fetch(request: Request, env: ProbeEnv): Promise<Response> {
		const url = new URL(request.url);
		// both logs are module-global so the wasm-side hooks can reach them; clearing
		// per request keeps each response self-contained rather than cumulative
		growLog.length = 0;
		demandLog.length = 0;
		try {
			switch (url.pathname) {
				case '/bare': {
					// PHP up, no Drupal: separates the interpreter's own footprint from
					// the workload's, which is what decides whether INITIAL_MEMORY has
					// any headroom at all
					const inst = await build(pickBin(url), 'bare-boot');
					const ver = await exec(inst, '<?php echo PHP_VERSION;', 'bare-version');
					const php = parseJson(
						await exec(
							inst,
							`<?php echo json_encode([
  'memory_get_usage_real' => memory_get_usage(true),
  'memory_get_usage' => memory_get_usage(false),
  'memory_get_peak_usage_real' => memory_get_peak_usage(true),
  'memory_limit' => ini_get('memory_limit'),
]);`,
							'bare-phpmem'
						)
					);
					return Response.json({
						route: '/bare',
						phpVersion: ver.trim(),
						bootMs: inst.bootMs,
						php,
						...(await report(inst, url, { diag: inst.diag }))
					});
				}

				case '/drupal': {
					// the number the snapshot design actually has to pay for
					const inst = await build(pickBin(url), 'drupal-boot');
					const postInitBytes = inst.memory.buffer.byteLength;
					const mount = await mountDrupalStreaming(inst.binary, env);
					const postMountBytes = inst.memory.buffer.byteLength;

					const t0 = Date.now();
					const raw = await exec(inst, DRUPAL_BOOT, 'drupal-request');
					const wallMs = Date.now() - t0;
					const php = parseJson(raw);

					// A5 wants the snapshot taken after the FIRST render, so the question
					// is whether a warm render moves the heap again -- if it does, a
					// post-boot snapshot is snapshotting the wrong moment
					const extra: Record<string, unknown>[] = [];
					const n = Number(url.searchParams.get('extra') ?? 0);
					for (let i = 0; i < n; i++) {
						const before = inst.memory.buffer.byteLength;
						const out = parseJson(
							await exec(inst, DRUPAL_BOOT, `drupal-request-${i + 2}`)
						);
						extra.push({
							request: i + 2,
							status: out.status ?? null,
							bytes: out.bytes ?? null,
							totalMs: out.totalMs ?? null,
							heapBeforeBytes: before,
							heapAfterBytes: inst.memory.buffer.byteLength
						});
					}

					const phpMem = parseJson(
						await exec(
							inst,
							`<?php echo json_encode([
  'memory_get_usage_real' => memory_get_usage(true),
  'memory_get_usage' => memory_get_usage(false),
  'memory_get_peak_usage_real' => memory_get_peak_usage(true),
  'memory_limit' => ini_get('memory_limit'),
]);`,
							'drupal-phpmem'
						)
					);

					return Response.json({
						route: '/drupal',
						bootMs: inst.bootMs,
						wallMs,
						mount,
						php,
						extraRequests: extra,
						phpMem,
						stages: {
							atInstantiation: inst.instantiationBytes,
							afterPhpInit: postInitBytes,
							afterMount: postMountBytes,
							afterDrupalBoot: inst.memory.buffer.byteLength
						},
						...(await report(inst, url, {}))
					});
				}

				case '/plateau': {
					// enumerates the geometric growth boundaries directly. One instance
					// and a monotone ladder, because the heap never shrinks: each step's
					// resulting size IS the plateau that request size lands on.
					const ladder = (
						url.searchParams.get('mb') ?? '4,8,16,24,32,48,64,80,96,112,128'
					)
						.split(',')
						.map((s) => Number(s.trim()))
						.filter((n) => Number.isFinite(n) && n > 0);
					const bin = pickBin(url);
					const inst = await build(bin, 'plateau-boot');
					const steps: Record<string, unknown>[] = [];
					for (const mb of ladder) {
						const before = inst.memory.buffer.byteLength;
						const growsBefore = growLog.length;
						const out = await exec(
							inst,
							`<?php $s = str_repeat('x', ${mb} * 1048576); echo strlen($s); unset($s);`,
							`plateau-${mb}mb`
						);
						const after = inst.memory.buffer.byteLength;
						steps.push({
							requestMb: mb,
							allocatedBytes: Number(out.trim()) || null,
							heapBeforeBytes: before,
							heapAfterBytes: after,
							heapAfterMiB: +(after / 1048576).toFixed(3),
							pages64K: after / 65536,
							grows: growLog.slice(growsBefore).map((g) => ({
								requestedDeltaPages: g.requestedDeltaPages,
								beforeBytes: g.beforeBytes,
								afterBytes: g.afterBytes,
								ms: g.ms
							})),
							demandBytes: demandLog
								.filter((d) => d.tag === `plateau-${mb}mb`)
								.map((d) => d.requestedBytes)
						});
					}
					return Response.json({
						route: '/plateau',
						build: BINARIES[bin].label,
						instrumented: growPatched,
						atInstantiationBytes: inst.instantiationBytes,
						glueGetHeapMax: HEAP_MAX[bin],
						plateausBytes: [...new Set(growLog.map((g) => g.afterBytes))],
						steps
					});
				}

				case '/limits': {
					// static facts about the binary, with no workload at all
					const bin = pickBin(url);
					const inst = await build(bin, 'limits-boot');
					return Response.json({
						route: '/limits',
						build: BINARIES[bin].label,
						atInstantiationBytes: inst.instantiationBytes,
						atInstantiationPages64K: inst.instantiationBytes / 65536,
						declaredPages: DECLARED_PAGES[bin],
						memoryTypeIfSupported: inst.memoryType,
						glueGetHeapMax: HEAP_MAX[bin],
						baselineNonZeroPages4K: inst.baseline.nonZeroPages,
						baselineNonZeroBytes4K: inst.baseline.heldBytes,
						baselineScanMs: inst.baseline.scanMs,
						growEventsDuringBoot: growsFor('limits-boot'),
						resizeDemandDuringBoot: demandLog,
						instrumented: { grow: growPatched, resizeHeap: resizePatched },
						compression: {
							CompressionStream: typeof CompressionStream !== 'undefined',
							DecompressionStream: typeof DecompressionStream !== 'undefined'
						}
					});
				}

				default:
					return new Response(
						[
							'/limits   binary facts: INITIAL_MEMORY at instantiation, heap max, baseline non-zero pages',
							'/bare     PHP up, no Drupal; page elision against the post-instantiation baseline',
							'/drupal   mount + DrupalKernel boot; the snapshot cost that matters',
							'/plateau?mb=4,8,16  growth plateau boundaries from instrumented memory.grow',
							'',
							'?bin=o2 (default, the shipping binary) or ?bin=free (static-free-v1, the only',
							'one that can boot Drupal standalone -- static-o2 has no pdo_sqlite)',
							'?roundtrip=1 gunzips the coarse snapshot back   ?rawgzip=1 gzips the whole heap'
						].join('\n'),
						{ status: 404 }
					);
			}
		} catch (e: any) {
			return new Response(`${e?.stack ?? e}`, { status: 500 });
		}
	}
};
