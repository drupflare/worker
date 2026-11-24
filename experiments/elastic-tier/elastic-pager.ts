import { crc32 } from 'node:zlib';
import {
	MISS_ENTRY,
	PAGE_SHIFT,
	TABLE_ENTRIES,
	TranslationMiss
} from './elastic-translate-host';

const PAGE = 1 << PAGE_SHIFT;

export interface Layout {
	/** byte address of the 65,536 entry i32 table */
	tableBase: number;
	/** byte address of the write table; set when the module was translated with `dirty` */
	writeTableBase?: number;
	/** logical pages that are their own frames and never move: [first, end) */
	identity: [number, number][];
	/** first logical page the pager manages */
	heapStart: number;
	/** physical pages that may hold frames: [first, end), the last end may be Infinity */
	frameRuns: [number, number][];
}

export interface PageStore {
	read(page: number, into: Uint8Array): void;
	write(page: number, bytes: Uint8Array): void;
	readonly storedBytes: number;
}

function framePages(layout: Layout, frames: number): number[] {
	const out: number[] = [];
	for (const [lo, hi] of layout.frameRuns)
		for (let p = lo; p < hi && out.length < frames; p++) out.push(p);
	if (out.length < frames)
		throw new RangeError(`folio.pager: the layout holds ${out.length} frames`);
	return out;
}

export function physicalPagesFor(layout: Layout, frames: number): number {
	const top = Math.max(
		0,
		...layout.identity.map((r) => r[1]),
		layout.tableBase / PAGE + 4,
		layout.writeTableBase === undefined ? 0 : layout.writeTableBase / PAGE + 4
	);
	return Math.max(top, ...framePages(layout, frames).map((p) => p + 1));
}

export interface PagerStats {
	slow: number;
	straddles: number;
	/** fills from the store */
	hard: number;
	/** fills with zeros, a page never written */
	zero: number;
	/** remaps of a resident frame the clock unmapped */
	soft: number;
	/** entries the clock hand cleared */
	unmaps: number;
	evictions: number;
	writebacks: number;
	cleanEvictions: number;
	pairMoves: number;
	hostFaults: number;
	/** calls of the store handler */
	wslow: number;
	/** clean frames that turned dirty */
	dirtyMarks: number;
	/** live views handed to the host, each counted as a write */
	viewDirty: number;
	fillMs: number;
	evictMs: number;
	crcMs: number;
}

export interface PagerOptions {
	memory: WebAssembly.Memory;
	layout: Layout;
	frames: number;
	store: PageStore;
	logicalBytes: number;
	/** with a write table: take a CRC when a page turns dirty and write it back only if it changed */
	verify?: boolean;
}

let zeroCrc: number | undefined;

// frames of a translated module in the module's own memory, with a CLOCK hand over them. A table
// hit is a plain load the pager never sees, so the hand clears an entry (the frame stays) and a
// later access takes one import call that sets it again.
export class Pager {
	readonly stats: PagerStats = {
		slow: 0,
		straddles: 0,
		hard: 0,
		zero: 0,
		soft: 0,
		unmaps: 0,
		evictions: 0,
		writebacks: 0,
		cleanEvictions: 0,
		pairMoves: 0,
		hostFaults: 0,
		wslow: 0,
		dirtyMarks: 0,
		viewDirty: 0,
		fillMs: 0,
		evictMs: 0,
		crcMs: 0
	};
	readonly memory: WebAssembly.Memory;
	readonly layout: Layout;
	readonly frames: number;
	logicalBytes: number;
	private store: PageStore;
	private verify: boolean;
	private buf: ArrayBufferLike | undefined;
	private table!: Int32Array;
	private wtable: Int32Array | undefined;
	private dirty: Uint8Array;
	private bytes!: Uint8Array;
	private fvs: (Uint8Array | undefined)[];
	private phys: number[];
	private frameAtPhys = new Map<number, number>();
	private identity = new Uint8Array(TABLE_ENTRIES);
	private frameOf = new Int32Array(TABLE_ENTRIES).fill(-1);
	private stored = new Uint8Array(TABLE_ENTRIES);
	private pageOf: Int32Array;
	private mapped: Uint8Array;
	private crc: Uint32Array;
	private free: number[] = [];
	private hand = 0;
	private keep = -1;
	private tmp: Uint8Array | undefined;
	private pairAt: number | undefined;

	constructor(options: PagerOptions) {
		this.memory = options.memory;
		this.layout = options.layout;
		this.frames = options.frames;
		this.store = options.store;
		this.verify = !!options.verify;
		this.logicalBytes = options.logicalBytes;
		this.phys = framePages(options.layout, options.frames);
		const need = physicalPagesFor(options.layout, options.frames);
		const have = options.memory.buffer.byteLength / PAGE;
		if (have < need) options.memory.grow(need - have);
		// the module sees the physical size as its memory size, so the heap reaches at least that far
		this.logicalBytes = Math.max(this.logicalBytes, options.memory.buffer.byteLength);
		this.pageOf = new Int32Array(options.frames).fill(-1);
		this.mapped = new Uint8Array(options.frames);
		this.crc = new Uint32Array(options.frames);
		this.dirty = new Uint8Array(options.frames);
		this.fvs = new Array(options.frames);
		for (let f = options.frames - 1; f >= 0; f--) this.free.push(f);
		this.phys.forEach((p, f) => this.frameAtPhys.set(p, f));
		for (const [lo, hi] of options.layout.identity) this.identity.fill(1, lo, hi);
		for (let f = 0; f + 1 < options.frames; f++)
			if (this.phys[f + 1] === this.phys[f]! + 1) {
				this.pairAt = this.phys[f];
				break;
			}
		this.sync();
		this.table.fill(MISS_ENTRY);
		this.wtable?.fill(MISS_ENTRY);
		for (let p = 0; p < TABLE_ENTRIES; p++)
			if (this.identity[p]) {
				this.table[p] = 0;
				if (this.wtable) this.wtable[p] = 0;
			}
	}

	get counts() {
		return this.stats;
	}

	private sync() {
		if (this.buf === this.memory.buffer) return;
		this.buf = this.memory.buffer;
		this.table = new Int32Array(this.buf, this.layout.tableBase, TABLE_ENTRIES);
		if (this.layout.writeTableBase !== undefined)
			this.wtable = new Int32Array(this.buf, this.layout.writeTableBase, TABLE_ENTRIES);
		this.bytes = new Uint8Array(this.buf);
		this.fvs.fill(undefined);
	}

	view() {
		this.sync();
		return this.bytes;
	}

	private fv(f: number) {
		return (this.fvs[f] ??= new Uint8Array(this.buf!, this.phys[f]! * PAGE, PAGE));
	}

	isResident(page: number) {
		return this.frameOf[page]! >= 0;
	}

	private map(f: number, page: number) {
		this.table[page] = ((this.phys[f]! - page) * PAGE) | 0;
		this.mapped[f] = 1;
	}

	private fill(f: number, page: number) {
		const bytes = this.fv(f);
		const t0 = performance.now();
		const crc = !this.wtable;
		if (this.stored[page]) {
			this.store.read(page, bytes);
			this.stats.hard++;
			const t1 = performance.now();
			if (crc) this.crc[f] = crc32(bytes);
			this.stats.fillMs += t1 - t0;
			if (crc) this.stats.crcMs += performance.now() - t1;
		} else {
			bytes.fill(0);
			this.stats.zero++;
			if (crc) {
				zeroCrc ??= crc32(new Uint8Array(PAGE));
				this.crc[f] = zeroCrc;
			}
			this.stats.fillMs += performance.now() - t0;
		}
	}

	private evict(f: number) {
		const page = this.pageOf[f]!;
		const bytes = this.fv(f);
		let write: boolean;
		const t0 = performance.now();
		if (this.wtable) {
			write = this.dirty[f] === 1;
			if (write && this.verify) {
				write = crc32(bytes) !== this.crc[f];
				this.stats.crcMs += performance.now() - t0;
			}
			this.wtable[page] = MISS_ENTRY;
			this.dirty[f] = 0;
		} else {
			write = crc32(bytes) !== this.crc[f];
			this.stats.crcMs += performance.now() - t0;
		}
		if (write) {
			const t1 = performance.now();
			this.store.write(page, bytes);
			this.stored[page] = 1;
			this.stats.writebacks++;
			this.stats.evictMs += performance.now() - t1;
		} else this.stats.cleanEvictions++;
		this.table[page] = MISS_ENTRY;
		this.frameOf[page] = -1;
		this.pageOf[f] = -1;
		this.mapped[f] = 0;
		this.stats.evictions++;
	}

	private pick(): number {
		const free = this.free.pop();
		if (free !== undefined) return free;
		const n = this.frames;
		for (let step = 0; step < 4 * n; step++) {
			const c = this.hand;
			this.hand = c + 1 === n ? 0 : c + 1;
			if (c === this.keep) continue;
			if (this.mapped[c]) {
				this.mapped[c] = 0;
				this.table[this.pageOf[c]!] = MISS_ENTRY;
				if (this.wtable) this.wtable[this.pageOf[c]!] = MISS_ENTRY;
				this.stats.unmaps++;
				continue;
			}
			this.evict(c);
			return c;
		}
		throw new Error('folio.pager: no frame can be evicted');
	}

	private resident(page: number, write = false): number {
		let f = this.frameOf[page]!;
		if (f >= 0) {
			if (!this.mapped[f]) {
				this.map(f, page);
				this.stats.soft++;
			}
		} else {
			f = this.pick();
			this.fill(f, page);
			this.pageOf[f] = page;
			this.frameOf[page] = f;
			this.map(f, page);
		}
		if (write && this.wtable) {
			if (!this.dirty[f]) {
				this.stats.dirtyMarks++;
				if (this.verify) {
					const t0 = performance.now();
					this.crc[f] = crc32(this.fv(f));
					this.stats.crcMs += performance.now() - t0;
				}
				this.dirty[f] = 1;
			}
			this.wtable[page] = this.table[page]!;
		}
		return f;
	}

	private check(page: number, address: number, bytes: number) {
		if (
			!this.identity[page] &&
			(page < this.layout.heapStart || page * PAGE >= this.logicalBytes)
		)
			throw new TranslationMiss(address >>> 0, bytes);
	}

	private deltaOf(page: number, address: number, bytes: number, write: boolean): number {
		this.check(page, address, bytes);
		if (!this.identity[page]) this.resident(page, write);
		return this.table[page]!;
	}

	private physOf(page: number): number {
		return this.identity[page] ? page : this.phys[this.frameOf[page]!]!;
	}

	// swaps the pages of two frames, or moves one page into a free frame
	private swap(g: number, h: number) {
		const bg = this.fv(g);
		const bh = this.fv(h);
		const rg = this.pageOf[g]!;
		const rh = this.pageOf[h]!;
		if (rg < 0) {
			bg.set(bh);
			this.free.splice(this.free.indexOf(g), 1);
			this.free.push(h);
		} else {
			const tmp = (this.tmp ??= new Uint8Array(PAGE));
			tmp.set(bg);
			bg.set(bh);
			bh.set(tmp);
		}
		const mg = this.mapped[g]!;
		const cg = this.crc[g]!;
		const dg = this.dirty[g]!;
		this.mapped[g] = this.mapped[h]!;
		this.crc[g] = this.crc[h]!;
		this.dirty[g] = this.dirty[h]!;
		this.mapped[h] = mg;
		this.crc[h] = cg;
		this.dirty[h] = dg;
		this.pageOf[g] = rh;
		this.pageOf[h] = rg;
		this.frameOf[rh] = g;
		this.table[rh] = this.mapped[g] ? ((this.phys[g]! - rh) * PAGE) | 0 : MISS_ENTRY;
		if (this.wtable)
			this.wtable[rh] = this.mapped[g] && this.dirty[g] ? this.table[rh]! : MISS_ENTRY;
		if (rg >= 0) {
			this.frameOf[rg] = h;
			this.table[rg] = this.mapped[h] ? ((this.phys[h]! - rg) * PAGE) | 0 : MISS_ENTRY;
			if (this.wtable)
				this.wtable[rg] = this.mapped[h] && this.dirty[h] ? this.table[rg]! : MISS_ENTRY;
		}
	}

	// puts a resident heap page in the frame at physical page q
	private placeAt(page: number, q: number): boolean {
		const g = this.frameAtPhys.get(q);
		if (g === undefined || this.identity[page]) return false;
		const h = this.frameOf[page]!;
		if (h === g) return true;
		this.swap(g, h);
		this.stats.pairMoves++;
		return true;
	}

	// frames of two neighbouring pages must sit next to each other, because one delta serves both
	private pair(first: number, address: number, bytes: number, write: boolean): number {
		const next = first + 1;
		this.deltaOf(first, address, bytes, write);
		this.keep = this.identity[first] ? -1 : this.frameOf[first]!;
		try {
			this.deltaOf(next, next * PAGE, bytes, write);
		} finally {
			this.keep = -1;
		}
		if (this.table[first] === this.table[next]) return this.table[first]!;
		const pf = this.physOf(first);
		const pn = this.physOf(next);
		let ok = this.placeAt(next, pf + 1) || this.placeAt(first, pn - 1);
		if (!ok && this.pairAt !== undefined)
			ok = this.placeAt(first, this.pairAt) && this.placeAt(next, this.pairAt + 1);
		if (!ok || this.table[first] !== this.table[next])
			throw new TranslationMiss(next * PAGE, bytes, 'page straddle');
		return this.table[first]!;
	}

	private handle(pointer: number, offset: number, bytes: number, write: boolean): number {
		this.sync();
		const address = (pointer >>> 0) + offset;
		if (address > 0xffffffff) throw new TranslationMiss(address >>> 0, bytes, 'address wrap');
		const first = address >>> PAGE_SHIFT;
		const last = address + bytes - 1;
		if (last > 0xffffffff) throw new TranslationMiss(address, bytes, 'address wrap');
		if (last >>> PAGE_SHIFT === first) return this.deltaOf(first, address, bytes, write);
		this.stats.straddles++;
		return this.pair(first, address, bytes, write);
	}

	slow = (pointer: number, offset: number, bytes: number): number => {
		this.stats.slow++;
		return this.handle(pointer, offset, bytes, false);
	};

	slowWrite = (pointer: number, offset: number, bytes: number): number => {
		this.stats.wslow++;
		return this.handle(pointer, offset, bytes, true);
	};

	stackMiss = (pointer: number): void => {
		throw new TranslationMiss(pointer >>> 0, 0, 'stack window');
	};

	get imports() {
		return { folio: { slow: this.slow, slow_w: this.slowWrite, stack_miss: this.stackMiss } };
	}

	/** physical byte address of the start of a logical page, filled and mapped for the host */
	base(page: number, write = false): number {
		this.sync();
		if (this.identity[page]) return page * PAGE;
		this.check(page, page * PAGE, 0);
		const before = this.stats.hard + this.stats.zero;
		const f = this.resident(page, write);
		if (this.stats.hard + this.stats.zero !== before) this.stats.hostFaults++;
		return this.phys[f]! * PAGE;
	}

	/** like `base`, with the frame of `keepPage` protected from the clock while this page fills */
	baseKeeping(page: number, write: boolean, keepPage: number): number {
		this.keep = this.identity[keepPage] ? -1 : this.frameOf[keepPage]!;
		try {
			return this.base(page, write);
		} finally {
			this.keep = -1;
		}
	}

	residentFrames() {
		return this.frames - this.free.length;
	}
}

interface Kind {
	bpe: number;
	ctor: new (n: number) => ArrayBufferView & { length: number };
	get: (dv: DataView, o: number) => number;
	put: (dv: DataView, o: number, v: number) => void;
}

type HeapName =
	'HEAP8' | 'HEAPU8' | 'HEAP16' | 'HEAPU16' | 'HEAP32' | 'HEAPU32' | 'HEAPF32' | 'HEAPF64';

const KINDS: Record<HeapName, Kind> = {
	HEAP8: {
		bpe: 1,
		ctor: Int8Array,
		get: (d, o) => d.getInt8(o),
		put: (d, o, v) => d.setInt8(o, v)
	},
	HEAPU8: {
		bpe: 1,
		ctor: Uint8Array,
		get: (d, o) => d.getUint8(o),
		put: (d, o, v) => d.setUint8(o, v)
	},
	HEAP16: {
		bpe: 2,
		ctor: Int16Array,
		get: (d, o) => d.getInt16(o, true),
		put: (d, o, v) => d.setInt16(o, v, true)
	},
	HEAPU16: {
		bpe: 2,
		ctor: Uint16Array,
		get: (d, o) => d.getUint16(o, true),
		put: (d, o, v) => d.setUint16(o, v, true)
	},
	HEAP32: {
		bpe: 4,
		ctor: Int32Array,
		get: (d, o) => d.getInt32(o, true),
		put: (d, o, v) => d.setInt32(o, v, true)
	},
	HEAPU32: {
		bpe: 4,
		ctor: Uint32Array,
		get: (d, o) => d.getUint32(o, true),
		put: (d, o, v) => d.setUint32(o, v, true)
	},
	HEAPF32: {
		bpe: 4,
		ctor: Float32Array,
		get: (d, o) => d.getFloat32(o, true),
		put: (d, o, v) => d.setFloat32(o, v, true)
	},
	HEAPF64: {
		bpe: 8,
		ctor: Float64Array,
		get: (d, o) => d.getFloat64(o, true),
		put: (d, o, v) => d.setFloat64(o, v, true)
	}
};

const UNSUPPORTED = new Set([
	'map',
	'forEach',
	'join',
	'reduce',
	'reduceRight',
	'find',
	'findIndex',
	'findLast',
	'every',
	'some',
	'reverse',
	'sort',
	'entries',
	'keys',
	'values',
	'lastIndexOf',
	'includes',
	'at',
	'filter',
	'toReversed',
	'toSorted',
	'with'
]);

export type HeapView = Record<string, any>;

/** the eight emscripten heap views over the logical address space, with every access translated */
export class LogicalHeap {
	readonly views: Record<keyof typeof KINDS, HeapView>;
	readonly sentinel = new ArrayBuffer(0);
	readonly stats = { copies: 0, copyBytes: 0, copyChunks: 0 };
	private dvBuf: ArrayBufferLike | undefined;
	private dvv!: DataView;
	readonly pager: Pager;
	constructor(pager: Pager) {
		this.pager = pager;
		this.views = Object.fromEntries(
			Object.entries(KINDS).map(([name, kind]) => [name, this.proxy(kind)])
		) as Record<keyof typeof KINDS, HeapView>;
	}

	private dv() {
		const bytes = this.pager.view();
		if (this.dvBuf !== bytes.buffer) {
			this.dvBuf = bytes.buffer;
			this.dvv = new DataView(bytes.buffer);
		}
		return this.dvv;
	}

	private span(
		address: number,
		length: number,
		fn: (at: number, n: number, done: number) => void,
		write = false
	) {
		if (address < 0 || address + length > 0x100000000)
			throw new RangeError('folio.pager: address range');
		let done = 0;
		while (done < length) {
			const a = address + done;
			const inPage = a & (PAGE - 1);
			const n = Math.min(length - done, PAGE - inPage);
			fn(this.pager.base(a >>> PAGE_SHIFT, write) + inPage, n, done);
			done += n;
		}
	}

	read(address: number, length: number): Uint8Array {
		const out = new Uint8Array(length);
		this.span(address, length, (at, n, done) =>
			out.set(this.pager.view().subarray(at, at + n), done)
		);
		return out;
	}

	write(address: number, source: Uint8Array) {
		this.span(
			address,
			source.length,
			(at, n, done) => this.pager.view().set(source.subarray(done, done + n), at),
			true
		);
	}

	fill(address: number, value: number, length: number) {
		this.span(address, length, (at, n) => this.pager.view().fill(value, at, at + n), true);
	}

	copyWithin(target: number, start: number, end: number) {
		const n = end - start;
		if (n <= 0) return;
		this.stats.copies++;
		this.stats.copyBytes += n;
		if (this.pager.frames < 2) return this.write(target, this.read(start, n));
		if (target < 0 || start < 0 || target + n > 0x100000000 || end > 0x100000000)
			throw new RangeError('folio.pager: address range');
		// a chunk never crosses a page of the source or of the target; the order keeps an overlap exact
		const backward = target > start;
		let done = 0;
		while (done < n) {
			const left = n - done;
			let s: number;
			let t: number;
			let len: number;
			if (backward) {
				const sEnd = end - done;
				const tEnd = target + n - done;
				len = Math.min(left, ((sEnd - 1) & (PAGE - 1)) + 1, ((tEnd - 1) & (PAGE - 1)) + 1);
				s = sEnd - len;
				t = tEnd - len;
			} else {
				s = start + done;
				t = target + done;
				len = Math.min(left, PAGE - (s & (PAGE - 1)), PAGE - (t & (PAGE - 1)));
			}
			const from = this.pager.base(s >>> PAGE_SHIFT) + (s & (PAGE - 1));
			const to =
				this.pager.baseKeeping(t >>> PAGE_SHIFT, true, s >>> PAGE_SHIFT) + (t & (PAGE - 1));
			this.pager.view().copyWithin(to, from, from + len);
			this.stats.copyChunks++;
			done += len;
		}
	}

	/** the bytes up to the first NUL or `max`, as a copy */
	cstr(address: number, max = Infinity): Uint8Array {
		const chunks: Uint8Array[] = [];
		let total = 0;
		let a = address;
		while (total < max) {
			const inPage = a & (PAGE - 1);
			const limit = Math.min(PAGE - inPage, max - total);
			const at = this.pager.base(a >>> PAGE_SHIFT) + inPage;
			const segment = this.pager.view().subarray(at, at + limit);
			const z = segment.indexOf(0);
			if (z >= 0) {
				chunks.push(segment.slice(0, z));
				total += z;
				break;
			}
			chunks.push(segment.slice());
			total += limit;
			a += limit;
		}
		if (chunks.length === 1) return chunks[0]!;
		const out = new Uint8Array(total);
		let at = 0;
		for (const c of chunks) {
			out.set(c, at);
			at += c.length;
		}
		return out;
	}

	private element(kind: Kind, index: number): number | undefined {
		const off = index * kind.bpe;
		if (off + kind.bpe > this.pager.logicalBytes) return undefined;
		const at = this.pager.base(off >>> PAGE_SHIFT) + (off & (PAGE - 1));
		return kind.get(this.dv(), at);
	}

	private put(kind: Kind, index: number, value: number) {
		const off = index * kind.bpe;
		if (off + kind.bpe > this.pager.logicalBytes) return;
		const at = this.pager.base(off >>> PAGE_SHIFT, true) + (off & (PAGE - 1));
		kind.put(this.dv(), at, value);
	}

	private proxy(kind: Kind): HeapView {
		const heap = this;
		const { bpe, ctor } = kind;
		const length = () => heap.pager.logicalBytes / bpe;
		const clamp = (v: number | undefined, dflt: number) => {
			if (v === undefined) return dflt;
			const n = Math.trunc(v) || 0;
			const len = length();
			return n < 0 ? Math.max(len + n, 0) : Math.min(n, len);
		};
		const slice = (a?: number, b?: number) => {
			const from = clamp(a, 0);
			const to = Math.max(clamp(b, length()), from);
			const bytes = heap.read(from * bpe, (to - from) * bpe);
			return new (ctor as any)(bytes.buffer);
		};
		const methods: Record<string, (...args: any[]) => any> = {
			slice,
			subarray(a?: number, b?: number) {
				const from = clamp(a, 0);
				const to = Math.max(clamp(b, length()), from);
				const first = (from * bpe) >>> PAGE_SHIFT;
				if (to > from && (to * bpe - 1) >>> PAGE_SHIFT === first) {
					heap.pager.stats.viewDirty++;
					const at = heap.pager.base(first, true) + ((from * bpe) & (PAGE - 1));
					return new (ctor as any)(heap.pager.memory.buffer, at, to - from);
				}
				return slice(from, to);
			},
			set(
				source: ArrayLike<number> & {
					BYTES_PER_ELEMENT?: number;
					buffer?: ArrayBufferLike;
					byteOffset?: number;
					byteLength?: number;
				},
				offset = 0
			) {
				if (offset < 0 || offset + source.length > length())
					throw new RangeError('offset is out of bounds');
				if (source.buffer && source.constructor === ctor)
					heap.write(
						offset * bpe,
						new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
					);
				else if (source.buffer && bpe === 1 && source.BYTES_PER_ELEMENT === 1)
					heap.write(
						offset,
						new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
					);
				else for (let i = 0; i < source.length; i++) heap.put(kind, offset + i, source[i]!);
				return undefined;
			},
			fill(value: number, start?: number, end?: number) {
				const from = clamp(start, 0);
				const to = clamp(end, length());
				if (bpe === 1) heap.fill(from, value & 255, Math.max(to - from, 0));
				else for (let i = from; i < to; i++) heap.put(kind, i, value);
				return this;
			},
			copyWithin(target: number, start: number, end?: number) {
				const t = clamp(target, 0);
				const s = clamp(start, 0);
				const e = clamp(end, length());
				const n = Math.min(e - s, length() - t);
				if (n > 0) heap.copyWithin(t * bpe, s * bpe, (s + n) * bpe);
				return this;
			},
			indexOf(value: number, from?: number) {
				if (bpe !== 1)
					throw new Error('folio.pager: indexOf on a wide view is not translated');
				const start = clamp(from, 0);
				for (let i = start; i < length(); i++)
					if (heap.element(kind, i) === value) return i;
				return -1;
			}
		};
		const bound = new Map<string, (...args: any[]) => any>();
		let self!: HeapView;
		self = new Proxy(new ctor(0), {
			get(_target, key) {
				if (typeof key === 'string') {
					const c = key.charCodeAt(0);
					if (c >= 48 && c <= 57) return heap.element(kind, +key);
					switch (key) {
						case 'length':
							return length();
						case 'byteLength':
							return heap.pager.logicalBytes;
						case 'byteOffset':
							return 0;
						case 'buffer':
							return heap.sentinel;
						case 'BYTES_PER_ELEMENT':
							return bpe;
						case 'constructor':
							return ctor;
					}
					const m = methods[key];
					if (m) {
						let f = bound.get(key);
						if (!f) bound.set(key, (f = (...args: any[]) => m.apply(self, args)));
						return f;
					}
					if (UNSUPPORTED.has(key))
						throw new Error(`folio.pager: ${key} on a heap view is not translated`);
				}
				return undefined;
			},
			set(_target, key, value) {
				if (typeof key === 'string' && key.charCodeAt(0) >= 48 && key.charCodeAt(0) <= 57) {
					heap.put(kind, +key, value);
					return true;
				}
				throw new TypeError(`folio.pager: cannot set ${String(key)} on a heap view`);
			}
		}) as HeapView;
		return self;
	}
}
