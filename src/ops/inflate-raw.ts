/**
 * DEFLATE and zlib readers that report how many INPUT bytes they consumed.
 *
 * `fflate` cannot answer that, and a packfile needs it: objects are concatenated zlib streams with no
 * length prefix, so the only way to find object N+1 is to know where object N ended.
 */

/** how a stream decoded, and where the next one starts */
export interface InflateResult {
	data: Uint8Array;
	/** bytes of `src` consumed, counted from `start` */
	consumed: number;
}

/**
 * An LSB-first bit reader over a byte accumulator.
 *
 * Reading one bit at a time is the obvious form and costs about 4x; a packfile inflate is the only
 * CPU-heavy step on the git path, so the accumulator is worth its fifteen lines.
 */
class Bits {
	/** the next byte to pull into the accumulator, which may be ahead of what has been consumed */
	pos: number;
	private acc = 0;
	private nbits = 0;

	constructor(
		readonly src: Uint8Array,
		start: number
	) {
		this.pos = start;
	}

	read(n: number): number {
		while (this.nbits < n) {
			if (this.pos >= this.src.length) throw new Error('deflate: input ended mid-stream');
			this.acc |= (this.src[this.pos++] as number) << this.nbits;
			this.nbits += 8;
		}
		const value = this.acc & ((1 << n) - 1);
		this.acc >>>= n;
		this.nbits -= n;
		return value >>> 0;
	}

	/** discards the partial byte, leaving whole buffered bytes to be given back by {@link at} */
	align(): void {
		const drop = this.nbits & 7;
		this.acc >>>= drop;
		this.nbits -= drop;
	}

	/** the byte offset actually consumed, which is `pos` minus whatever is still buffered */
	at(): number {
		return this.pos - (this.nbits >> 3);
	}

	/** re-seats the reader at a byte boundary after a stored block */
	seek(offset: number): void {
		this.pos = offset;
		this.acc = 0;
		this.nbits = 0;
	}
}

/** a canonical Huffman table in puff's shape: counts per length, then symbols in code order */
interface Huffman {
	counts: Int32Array;
	symbols: Int32Array;
}

function build(lengths: readonly number[], n: number): Huffman {
	const counts = new Int32Array(16);
	for (let i = 0; i < n; i++) {
		const len = lengths[i] as number;
		counts[len] = (counts[len] as number) + 1;
	}
	counts[0] = 0;

	const offsets = new Int32Array(16);
	for (let len = 1; len < 16; len++) {
		offsets[len] = (offsets[len - 1] as number) + (counts[len - 1] as number);
	}

	const symbols = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		const len = lengths[i] as number;
		if (len === 0) continue;
		symbols[offsets[len] as number] = i;
		offsets[len] = (offsets[len] as number) + 1;
	}
	return { counts, symbols };
}

/** walks one bit at a time; a table-driven decoder is faster and this is not the hot path */
function decode(bits: Bits, table: Huffman): number {
	let code = 0;
	let first = 0;
	let index = 0;
	for (let len = 1; len < 16; len++) {
		code |= bits.read(1);
		const count = table.counts[len] as number;
		if (code - first < count) return table.symbols[index + (code - first)] as number;
		index += count;
		first = (first + count) << 1;
		code <<= 1;
	}
	throw new Error('deflate: no symbol matches the code');
}

const LENGTH_BASE = [
	3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
	163, 195, 227, 258
] as const;
const LENGTH_EXTRA = [
	0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
] as const;
const DIST_BASE = [
	1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
	3073, 4097, 6145, 8193, 12289, 16385, 24577
] as const;
const DIST_EXTRA = [
	0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
] as const;
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15] as const;

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;

function fixedTables(): { lit: Huffman; dist: Huffman } {
	if (fixedLit === null || fixedDist === null) {
		const lengths: number[] = [];
		for (let i = 0; i < 144; i++) lengths.push(8);
		for (let i = 144; i < 256; i++) lengths.push(9);
		for (let i = 256; i < 280; i++) lengths.push(7);
		for (let i = 280; i < 288; i++) lengths.push(8);
		fixedLit = build(lengths, 288);
		fixedDist = build(new Array(30).fill(5) as number[], 30);
	}
	return { lit: fixedLit, dist: fixedDist };
}

/** grows geometrically; `hint` skips the regrows when the caller knows the answer */
class Out {
	buf: Uint8Array;
	len = 0;
	constructor(hint: number) {
		this.buf = new Uint8Array(Math.max(hint, 64));
	}
	need(extra: number): void {
		if (this.len + extra <= this.buf.length) return;
		let size = this.buf.length * 2;
		while (size < this.len + extra) size *= 2;
		const next = new Uint8Array(size);
		next.set(this.buf.subarray(0, this.len));
		this.buf = next;
	}
	push(byte: number): void {
		this.need(1);
		this.buf[this.len++] = byte;
	}
}

/**
 * Inflates one raw DEFLATE stream beginning at `start`.
 *
 * `hint` is the expected output size when the caller knows it, which a packfile object header does.
 */
export function inflateRaw(src: Uint8Array, start = 0, hint = 1024): InflateResult {
	const bits = new Bits(src, start);
	const out = new Out(hint);

	for (;;) {
		const final = bits.read(1);
		const type = bits.read(2);

		if (type === 0) {
			bits.align();
			const head = bits.at();
			if (head + 4 > src.length) throw new Error('deflate: stored block header is short');
			const len = (src[head] as number) | ((src[head + 1] as number) << 8);
			const nlen = (src[head + 2] as number) | ((src[head + 3] as number) << 8);
			if ((len ^ 0xffff) !== nlen) throw new Error('deflate: stored block length is corrupt');
			if (head + 4 + len > src.length) throw new Error('deflate: stored block is truncated');
			out.need(len);
			out.buf.set(src.subarray(head + 4, head + 4 + len), out.len);
			out.len += len;
			bits.seek(head + 4 + len);
		} else if (type === 1 || type === 2) {
			let lit: Huffman;
			let dist: Huffman;
			if (type === 1) {
				({ lit, dist } = fixedTables());
			} else {
				const hlit = bits.read(5) + 257;
				const hdist = bits.read(5) + 1;
				const hclen = bits.read(4) + 4;
				const clen = new Array<number>(19).fill(0);
				for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i] as number] = bits.read(3);
				const clenTable = build(clen, 19);

				const lengths = new Array<number>(hlit + hdist).fill(0);
				let i = 0;
				while (i < hlit + hdist) {
					const symbol = decode(bits, clenTable);
					if (symbol < 16) {
						lengths[i++] = symbol;
					} else if (symbol === 16) {
						if (i === 0) throw new Error('deflate: repeat with no previous length');
						const prev = lengths[i - 1] as number;
						for (let r = bits.read(2) + 3; r > 0; r--) lengths[i++] = prev;
					} else if (symbol === 17) {
						for (let r = bits.read(3) + 3; r > 0; r--) lengths[i++] = 0;
					} else {
						for (let r = bits.read(7) + 11; r > 0; r--) lengths[i++] = 0;
					}
				}
				lit = build(lengths.slice(0, hlit), hlit);
				dist = build(lengths.slice(hlit), hdist);
			}

			for (;;) {
				const symbol = decode(bits, lit);
				if (symbol === 256) break;
				if (symbol < 256) {
					out.push(symbol);
					continue;
				}
				const li = symbol - 257;
				if (li >= LENGTH_BASE.length)
					throw new Error('deflate: length symbol out of range');
				const length = (LENGTH_BASE[li] as number) + bits.read(LENGTH_EXTRA[li] as number);
				const di = decode(bits, dist);
				if (di >= DIST_BASE.length)
					throw new Error('deflate: distance symbol out of range');
				const distance = (DIST_BASE[di] as number) + bits.read(DIST_EXTRA[di] as number);
				if (distance > out.len)
					throw new Error('deflate: distance reaches before the output');
				out.need(length);
				for (let n = 0; n < length; n++) {
					out.buf[out.len] = out.buf[out.len - distance] as number;
					out.len++;
				}
			}
		} else {
			throw new Error('deflate: reserved block type');
		}

		if (final === 1) break;
	}

	bits.align();
	return { data: out.buf.subarray(0, out.len), consumed: bits.at() - start };
}

/** the same, with zlib's 2-byte header and 4-byte adler trailer counted into `consumed` */
export function inflateZlib(src: Uint8Array, start = 0, hint = 1024): InflateResult {
	if (start + 2 > src.length) throw new Error('zlib: header is short');
	const cmf = src[start] as number;
	const flg = src[start + 1] as number;
	if ((cmf & 0x0f) !== 8) throw new Error('zlib: not a deflate stream');
	if (((cmf << 8) | flg) % 31 !== 0) throw new Error('zlib: header check failed');
	// FDICT: a preset dictionary the caller has no way to supply, so refuse rather than mis-decode
	if ((flg & 0x20) !== 0) throw new Error('zlib: a preset dictionary is not supported');
	const raw = inflateRaw(src, start + 2, hint);
	return { data: raw.data, consumed: 2 + raw.consumed + 4 };
}
