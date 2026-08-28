/**
 * What a booted PHP linear memory is made of, at `zend_string` granularity.
 *
 * `bun scripts/measure/heap-strings.ts --self-check`
 *
 * `opcache_get_status()` reports `interned_strings_usage` and `OPCACHE_MODE` is off, so the heap
 * itself is the only instrument left. Layout and hash constants are read from `Zend/zend_types.h`
 * (8.5.7), not remembered.
 *
 * **THE HASH IS THE ORACLE AND WITHOUT IT THIS IS USELESS.** Structural checks alone -- type,
 * length, a NUL at `val + len`, a plausible refcount -- are satisfiable by chance at any offset
 * once `len` is large, and reported a 16,777,216-byte "string" and 86% of the live heap. DJB33
 * recomputed with `Math.imul` takes the same heap to 8%.
 *
 * Three populations, kept apart: `verified` matched the hash and is a FLOOR, `unhashed` has
 * `h == 0` and cannot be checked, everything else is rejected.
 */

/** `IS_STRING`, from `Zend/zend_types.h` */
export const IS_STRING = 6;

/** `GC_TYPE_MASK`; the type nibble lives in the low byte of `gc.u.type_info` */
export const GC_TYPE_MASK = 0x0000000f;

/** `GC_NOT_COLLECTABLE`, which `GC_STRING` always sets, so its absence is a rejection */
export const GC_NOT_COLLECTABLE = 1 << 4;

/** `IS_STR_INTERNED`, which is `GC_IMMUTABLE` */
export const GC_IMMUTABLE = 1 << 6;

/** `IS_STR_PERSISTENT`, which is `GC_PERSISTENT` -- allocated with malloc rather than from the arena */
export const GC_PERSISTENT = 1 << 7;

/** `IS_STR_PERMANENT`; survives a request boundary */
export const IS_STR_PERMANENT = 1 << 8;

/** where the fields sit inside `zend_string`, for one ABI */
export type StringLayout = {
	name: string;
	/** words of `zend_ulong h`: 2 on a 64-bit zend_long, 1 on a 32-bit one */
	hWords: 1 | 2;
	lenOffset: number;
	valOffset: number;
};

/** long64 ships; wasm32 is the CONTROL -- a population under both means a pattern, not a struct */
export const STRING_LAYOUTS: readonly StringLayout[] = [
	{ name: 'long64', hWords: 2, lenOffset: 16, valOffset: 20 },
	{ name: 'wasm32', hWords: 1, lenOffset: 12, valOffset: 16 }
];

/** one population of found strings */
export type Population = {
	strings: number;
	/** sum of `len`, so the characters themselves and nothing else */
	payloadBytes: number;
	/** payload plus header plus the NUL, rounded to the allocator's 8-byte grain */
	structBytes: number;
	interned: number;
	internedPayloadBytes: number;
	/** interned payload plus its headers, which is what a shared vocabulary would actually cost */
	internedStructBytes: number;
	persistent: number;
	permanent: number;
	longest: number;
};

/** what one scan found */
export type StringCensus = {
	layout: string;
	/** the hash matched, so these are `zend_string`s and not coincidences */
	verified: Population;
	/** `h == 0`, which is a real state and an uncheckable one */
	unhashed: Population;
	/**
	 * How the hash was reproduced. ASCII hashes the same either way, so only `hashSignedCharOnly`
	 * carries information: non-zero there means `char` is SIGNED on this build.
	 */
	hashSignedCharOnly: number;
	hashPlain: number;
	/** candidates that passed every structural check and failed the hash */
	rejectedByHash: number;
	/** distinct CONTENTS across both populations, by a 32-bit content hash paired with the length */
	distinctContents: number;
	duplicateInstances: number;
	duplicatePayloadBytes: number;
	samples: string[];
};

function emptyPopulation(): Population {
	return {
		strings: 0,
		payloadBytes: 0,
		structBytes: 0,
		interned: 0,
		internedPayloadBytes: 0,
		internedStructBytes: 0,
		persistent: 0,
		permanent: 0,
		longest: 0
	};
}

/** latin1 decode of a short span, for a sample line */
function peek(heap: Uint8Array, from: number, len: number): string {
	const take = Math.min(len, 72);
	let out = '';
	for (let i = 0; i < take; i++) {
		const v = heap[from + i] as number;
		out += v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : '.';
	}
	return len > take ? `${out}...` : out;
}

/**
 * The low 32 bits of `zend_inline_hash_func()`, both signednesses of `char`.
 *
 * Both are computed and the caller counts which one the interpreter agrees with; guessing it is
 * the kind of unverified constraint that produces a plausible wrong answer. The header's fast path
 * needs `__i386__`/`__x86_64__`/`__aarch64__`/`_WIN32`, so wasm32 takes the `#else` branch.
 */
function djb33(heap: Uint8Array, from: number, to: number): { unsigned: number; signed: number } {
	let hu = 5381;
	let hs = 5381;
	for (let i = from; i < to; i++) {
		const b = heap[i] as number;
		hu = (Math.imul(hu, 33) + b) >>> 0;
		hs = (Math.imul(hs, 33) + (b < 0x80 ? b : b - 256)) >>> 0;
	}
	return { unsigned: hu >>> 0, signed: hs >>> 0 };
}

/**
 * Every `zend_string` the heap holds, under one candidate layout.
 *
 * Structural checks first, hash last: the hash is a full pass over the payload, so a 4 MiB
 * candidate failing on its type nibble must never reach it. On a hit the cursor jumps past the
 * payload, so a header shape inside a long string is not counted twice.
 *
 * IT CANNOT SEE: the difference between a live string and a freed one (zend does not zero what it
 * frees, so every figure is an UPPER bound), any `Bucket` or `HashTable`, or the JS heap.
 *
 * @param heap Live linear memory, or a copy of it.
 * @param layout Which ABI's field offsets to read.
 * @param opts `maxLen` rejects an implausible length; `samples` keeps that many decoded payloads.
 */
export function censusStrings(
	heap: Uint8Array,
	layout: StringLayout,
	opts: { maxLen?: number; samples?: number } = {}
): StringCensus {
	const maxLen = opts.maxLen ?? 4 << 20;
	const wantSamples = opts.samples ?? 0;
	const dv = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
	// a 53-bit content key rather than a string one: at ~10^6 strings a Map of string keys is tens of
	// megabytes of JS inside a 128 MiB isolate, and the collision bound here is ~n^2/2^54
	const seen = new Map<number, number>();

	const out: StringCensus = {
		layout: layout.name,
		verified: emptyPopulation(),
		unhashed: emptyPopulation(),
		hashSignedCharOnly: 0,
		hashPlain: 0,
		rejectedByHash: 0,
		distinctContents: 0,
		duplicateInstances: 0,
		duplicatePayloadBytes: 0,
		samples: []
	};

	const limit = heap.length;
	for (let o = 0; o + layout.valOffset + 2 <= limit;) {
		// the type nibble and GC_NOT_COLLECTABLE both live in the low byte of the little-endian
		// type_info, so one array read rejects nearly every offset without touching the DataView
		const typeByte = heap[o + 4] as number;
		if ((typeByte & GC_TYPE_MASK) !== IS_STRING || (typeByte & GC_NOT_COLLECTABLE) === 0) {
			o += 8;
			continue;
		}
		const typeInfo = dv.getUint32(o + 4, true);
		// GC_INFO is the cycle collector's buffer index and a string is never in it
		if (typeInfo >>> 10 !== 0) {
			o += 8;
			continue;
		}
		const len = dv.getUint32(o + layout.lenOffset, true);
		if (len === 0 || len > maxLen) {
			o += 8;
			continue;
		}
		const valStart = o + layout.valOffset;
		const end = valStart + len;
		if (end >= limit || heap[end] !== 0) {
			o += 8;
			continue;
		}
		const refcount = dv.getUint32(o, true);
		if (refcount === 0 || refcount > 0xffffff) {
			o += 8;
			continue;
		}

		const hLow = dv.getUint32(o + 8, true);
		const hHigh = layout.hWords === 2 ? dv.getUint32(o + 12, true) : 0;
		const claimsHash = layout.hWords === 2 ? (hHigh & 0x80000000) !== 0 : hLow >>> 31 === 1;
		const unhashedField = hLow === 0 && hHigh === 0;
		if (!claimsHash && !unhashedField) {
			// the high bit is forced on every real hash, so neither hashed nor cleared is neither
			o += 8;
			continue;
		}

		const { unsigned, signed } = djb33(heap, valStart, end);
		let population: Population | null = null;
		if (unhashedField) {
			population = out.unhashed;
		} else {
			// on a 32-bit zend_long the whole hash IS the low word, so the forced bit is part of it
			const want = layout.hWords === 2 ? hLow : hLow;
			const u = layout.hWords === 2 ? unsigned : (unsigned | 0x80000000) >>> 0;
			const s = layout.hWords === 2 ? signed : (signed | 0x80000000) >>> 0;
			if (want === u) {
				out.hashPlain++;
				population = out.verified;
			} else if (want === s) {
				out.hashSignedCharOnly++;
				population = out.verified;
			}
		}
		if (population === null) {
			out.rejectedByHash++;
			o += 8;
			continue;
		}

		population.strings++;
		population.payloadBytes += len;
		population.structBytes += (layout.valOffset + len + 1 + 7) & ~7;
		if (len > population.longest) population.longest = len;
		if (typeInfo & GC_IMMUTABLE) {
			population.interned++;
			population.internedPayloadBytes += len;
			population.internedStructBytes += (layout.valOffset + len + 1 + 7) & ~7;
		}
		if (typeInfo & GC_PERSISTENT) population.persistent++;
		if (typeInfo & IS_STR_PERMANENT) population.permanent++;

		const key = (unsigned >>> 5) * 0x4000000 + (((signed ^ len) >>> 6) & 0x3ffffff);
		const before = seen.get(key) ?? 0;
		seen.set(key, before + 1);
		if (before > 0) {
			out.duplicateInstances++;
			out.duplicatePayloadBytes += len;
		}

		if (out.samples.length < wantSamples) out.samples.push(peek(heap, valStart, len));
		o = (end + 8) & ~7;
	}

	out.distinctContents = seen.size;
	return out;
}

/** printable-ASCII runs, as a loose upper bound on "text-like" bytes */
export type RunCensus = { bytes: number; runs: number; minRun: number };

/**
 * Bytes belonging to a run of at least `minRun` printable ASCII characters.
 *
 * The envelope, not the answer: it counts a Twig template or an opcode literal as readily as a
 * payload. Reported so a struct count exceeding it would show the scanner is wrong.
 */
export function printableRunBytes(heap: Uint8Array, minRun = 4): RunCensus {
	let bytes = 0;
	let runs = 0;
	let run = 0;
	for (let i = 0; i < heap.length; i++) {
		const v = heap[i] as number;
		const printable = (v >= 0x20 && v < 0x7f) || v === 9 || v === 10 || v === 13;
		if (printable) {
			run++;
			continue;
		}
		if (run >= minRun) {
			bytes += run;
			runs++;
		}
		run = 0;
	}
	if (run >= minRun) {
		bytes += run;
		runs++;
	}
	return { bytes, runs, minRun };
}

/** the live image, at the granularity a snapshot stores */
export type PageCensus = {
	pageBytes: number;
	totalPages: number;
	nonZeroPages: number;
	nonZeroBytes: number;
	heapBytes: number;
};

/** non-zero wasm pages: `elideZeroPages()` drops exactly these, so it is what a snapshot pays for */
export function pageCensus(heap: Uint8Array, pageBytes = 65_536): PageCensus {
	const totalPages = Math.ceil(heap.length / pageBytes);
	let nonZeroPages = 0;
	for (let p = 0; p < totalPages; p++) {
		const from = p * pageBytes;
		const to = Math.min(from + pageBytes, heap.length);
		let zero = true;
		for (let i = from; i < to; i++) {
			if (heap[i] !== 0) {
				zero = false;
				break;
			}
		}
		if (!zero) nonZeroPages++;
	}
	return {
		pageBytes,
		totalPages,
		nonZeroPages,
		nonZeroBytes: nonZeroPages * pageBytes,
		heapBytes: heap.length
	};
}

/** plants one zend_string into a buffer, for the self-check */
function plant(
	buf: Uint8Array,
	at: number,
	layout: StringLayout,
	text: string,
	typeInfo: number,
	opts: { refcount?: number; hashed?: boolean } = {}
): number {
	const dv = new DataView(buf.buffer);
	dv.setUint32(at, opts.refcount ?? 1, true);
	dv.setUint32(at + 4, typeInfo, true);
	for (let i = 0; i < text.length; i++) buf[at + layout.valOffset + i] = text.charCodeAt(i);
	buf[at + layout.valOffset + text.length] = 0;
	dv.setUint32(at + layout.lenOffset, text.length, true);
	if (opts.hashed !== false) {
		const h = djb33(buf, at + layout.valOffset, at + layout.valOffset + text.length);
		if (layout.hWords === 2) {
			dv.setUint32(at + 8, h.unsigned, true);
			dv.setUint32(at + 12, 0x80000000, true);
		} else {
			dv.setUint32(at + 8, (h.unsigned | 0x80000000) >>> 0, true);
		}
	}
	return (at + layout.valOffset + text.length + 1 + 7) & ~7;
}

const GC_STRING = IS_STRING | GC_NOT_COLLECTABLE;

function selfCheck(): void {
	const layout = STRING_LAYOUTS[0] as StringLayout;
	const control = STRING_LAYOUTS[1] as StringLayout;
	const buf = new Uint8Array(8192);
	const dv = new DataView(buf.buffer);

	let at = 64;
	at = plant(
		buf,
		at,
		layout,
		'Drupal\\Core\\Entity\\EntityTypeManager',
		GC_STRING | GC_IMMUTABLE
	);
	at = plant(buf, at, layout, 'Drupal\\Core\\Entity\\EntityTypeManager', GC_STRING, {
		refcount: 3
	});
	at = plant(buf, at, layout, 'system.performance', GC_STRING, { refcount: 2 });
	// a never-looked-up string, which is a real state and lands in the other population
	at = plant(buf, at, layout, 'a-string-nothing-hashed', GC_STRING, { hashed: false });
	// THE CASE THE FIRST VERSION OF THIS SCANNER GOT WRONG: a header shape with an enormous length
	// and a NUL that happens to sit at val+len. Structurally perfect, hash absent -- and it must be
	// rejected rather than counted, because counting one of these is what reported 86% of the heap
	const lie = at;
	dv.setUint32(lie, 1, true);
	dv.setUint32(lie + 4, GC_STRING, true);
	dv.setUint32(lie + 8, 0xdeadbeef, true);
	dv.setUint32(lie + 12, 0x80000000, true);
	dv.setUint32(lie + layout.lenOffset, 2048, true);
	for (let i = 0; i < 2048; i++) buf[lie + layout.valOffset + i] = 0x41;
	buf[lie + layout.valOffset + 2048] = 0;

	const got = censusStrings(buf, layout, { samples: 6 });
	const fail = (why: string) => {
		throw new Error(`self-check: ${why}\n${JSON.stringify(got, null, '\t')}`);
	};
	if (got.verified.strings !== 3) fail(`expected 3 verified, got ${got.verified.strings}`);
	if (got.unhashed.strings !== 1) fail(`expected 1 unhashed, got ${got.unhashed.strings}`);
	if (got.rejectedByHash !== 1) fail(`expected 1 hash rejection, got ${got.rejectedByHash}`);
	if (got.verified.interned !== 1) fail(`expected 1 interned, got ${got.verified.interned}`);
	if (got.verified.payloadBytes !== 36 + 36 + 18) fail(`payload ${got.verified.payloadBytes}`);
	if (got.verified.longest !== 36) fail(`longest ${got.verified.longest}`);
	if (got.distinctContents !== 3) fail(`expected 3 distinct, got ${got.distinctContents}`);
	if (got.duplicateInstances !== 1) fail(`expected 1 duplicate, got ${got.duplicateInstances}`);
	if (!got.samples[0]?.startsWith('Drupal')) fail(`sample ${got.samples[0]}`);

	// the control arm reads len, h and val at the wrong offsets, so it must not reproduce the population
	const wrong = censusStrings(buf, control);
	if (wrong.verified.strings !== 0) fail(`control verified ${wrong.verified.strings}`);

	const pages = pageCensus(buf, 1024);
	if (pages.totalPages !== 8) fail(`pages ${pages.totalPages}`);
	if (pages.nonZeroPages !== 3) fail(`non-zero pages ${pages.nonZeroPages}`);

	const runs = printableRunBytes(buf, 4);
	if (runs.bytes < 36) fail(`printable bytes ${runs.bytes}`);

	console.log(
		`self-check OK: ${got.verified.strings} verified, ${got.unhashed.strings} unhashed, ` +
			`${got.rejectedByHash} rejected by hash, control arm verified ${wrong.verified.strings}`
	);
}

if (import.meta.main) {
	if (process.argv.includes('--self-check')) selfCheck();
	else console.error('usage: bun scripts/measure/heap-strings.ts --self-check');
}
