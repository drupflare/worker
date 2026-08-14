import { encode } from '@drupflare/durabledb/codec';

/**
 * Measures whether a Durable Object can snapshot its own wasm linear memory into
 * its OWN `ctx.storage.sql` as BLOB rows and memcpy it back on a later boot.
 *
 * Nothing here is reasoned about. Every number is bisected against a real
 * `ctx.storage.sql` inside real workerd, because this project has moved five
 * free-tier verdicts and four of those moves were the instrument rather than the
 * system.
 *
 * The five questions, in the order the design depends on them:
 *   1. the largest BLOB one row accepts, and the exact error at the boundary
 *   2. which JS forms bind, and whether the statement TEXT has its own cap that a
 *      base64 literal would hit where a bound parameter would not
 *   3. the exact JS type coming back, and whether `.set()` takes it with no copy
 *   4. integrity at size, checked once through SQLite's own `hex()` and once
 *      through the JS binding, so neither instrument validates itself
 *   5. real `cursor.rowsWritten` for a chunked write, since rows/day is the free
 *      plan's binding meter
 */

/** the one binding wrangler.blob.jsonc declares */
interface BlobEnv {
	BLOB: DurableObjectNamespace;
}

/** what one write attempt reported; `error` is present exactly when `ok` is false */
interface Attempt {
	ok: boolean;
	error?: string;
	allocation?: boolean;
}

/** what a `.set()` attempt did: whether it threw, and whether the bytes actually arrived */
interface SetOutcome {
	threw: boolean;
	error: string | null;
	bytesLanded: boolean;
}

/** the ArrayBuffer-wrapping arm, taken only when the binding hands back an ArrayBuffer */
interface WrapOutcome {
	needed: boolean;
	wrapperIsZeroCopyView?: boolean;
	byteLength?: number;
	bytesLanded?: boolean;
	error?: string;
}

const CHUNK_TABLE = 'CREATE TABLE IF NOT EXISTS memblob (i INTEGER PRIMARY KEY, b BLOB NOT NULL)';

/** 80 MB is the measured post-boot heap this design would have to move. */
const HEAP_BYTES = 80 * 1024 * 1024;

/**
 * Deterministic, non-trivial bytes.
 *
 * `crypto.getRandomValues` refuses anything over 65,536 bytes, and a constant
 * fill would let a swapped or duplicated chunk pass an integrity check. The seed
 * is folded in so chunk N never equals chunk M.
 */
function patternBytes(n: number, seed = 1) {
	const out = new Uint8Array(n);
	let x = (seed * 2654435761) >>> 0 || 1;
	for (let i = 0; i < n; i++) {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >>> 17;
		x ^= x << 5;
		x >>>= 0;
		out[i] = x & 0xff;
	}
	return out;
}

function toHex(bytes: Uint8Array) {
	let s = '';
	for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
	return s.toUpperCase();
}

const errText = (e: any) => String(e?.message ?? e);

export class BlobProbeDurableObject {
	ctx: DurableObjectState;
	env: BlobEnv;
	sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: BlobEnv) {
		this.ctx = ctx;
		this.env = env;
		this.sql = ctx.storage.sql;
		this.sql.exec(CHUNK_TABLE);
	}

	/**
	 * 1. Largest single BLOB row.
	 *
	 * Doubles until a write fails, then bisects to the exact byte. Each probe row
	 * is deleted immediately so the failure boundary is a row-size limit and not
	 * the database filling up.
	 */
	measureMaxRow(
		insert = 'INSERT INTO probe1 (b) VALUES (?)',
		ddl = 'CREATE TABLE probe1 (b BLOB)'
	) {
		const attempt = (n: number): Attempt => {
			// asserted rather than initialised: the allocation catch below returns
			let bytes!: Uint8Array;
			try {
				bytes = patternBytes(n, n);
			} catch (e: any) {
				return { ok: false, error: `allocation failed: ${errText(e)}`, allocation: true };
			}
			try {
				this.sql.exec('DELETE FROM probe1');
				const cur = this.sql.exec(insert, bytes);
				cur.toArray();
				const back = this.sql.exec('SELECT length(b) AS len FROM probe1').toArray()[0]?.len;
				this.sql.exec('DELETE FROM probe1');
				// a write that "succeeds" while storing a different length is a failure
				if (Number(back) !== n) {
					return { ok: false, error: `stored length ${String(back)} != written ${n}` };
				}
				return { ok: true };
			} catch (e: any) {
				try {
					this.sql.exec('DELETE FROM probe1');
				} catch {
					/* the boundary error may poison the statement; not fatal to the probe */
				}
				return { ok: false, error: errText(e) };
			}
		};

		this.sql.exec('DROP TABLE IF EXISTS probe1');
		this.sql.exec(ddl);

		const ladder: Record<string, unknown>[] = [];
		let lastOk = 0;
		let firstFail = 0;
		let failError: string | null | undefined = null;

		for (let n = 1024; n <= 512 * 1024 * 1024; n *= 2) {
			const r = attempt(n);
			ladder.push({ bytes: n, ok: r.ok, error: r.ok ? null : r.error!.slice(0, 200) });
			if (r.ok) {
				lastOk = n;
				continue;
			}
			firstFail = n;
			failError = r.error;
			break;
		}

		// exact byte boundary; ~30 iterations at most
		let lo = lastOk;
		let hi = firstFail;
		let iterations = 0;
		if (hi > 0) {
			while (hi - lo > 1) {
				const mid = lo + Math.floor((hi - lo) / 2);
				const r = attempt(mid);
				iterations++;
				if (r.ok) {
					lo = mid;
				} else {
					hi = mid;
					failError = r.error;
				}
			}
		}

		this.sql.exec('DROP TABLE IF EXISTS probe1');

		return {
			ddl,
			ladder,
			largestAccepted: lo,
			largestAcceptedMiB: +(lo / 1048576).toFixed(6),
			smallestRejected: hi > 0 ? hi : null,
			rejectionError: failError ? failError.slice(0, 400) : null,
			bisectIterations: iterations,
			// the number that decides the design
			chunksFor80MiB: lo > 0 ? Math.ceil(HEAP_BYTES / lo) : null
		};
	}

	/**
	 * Whether the cap is on the BLOB or on the whole record.
	 *
	 * The real chunk table carries an index column, so if the limit is per-record
	 * the usable payload is smaller than the single-column measurement and every
	 * chunk would have to be sized under it.
	 */
	measureRowOverhead() {
		const bare = this.measureMaxRow(
			'INSERT INTO probe1 (b) VALUES (?)',
			'CREATE TABLE probe1 (b BLOB)'
		);
		const keyed = this.measureMaxRow(
			'INSERT INTO probe1 (i, b) VALUES (7, ?)',
			'CREATE TABLE probe1 (i INTEGER PRIMARY KEY, b BLOB NOT NULL)'
		);
		const wide = this.measureMaxRow(
			"INSERT INTO probe1 (i, tag, b) VALUES (7, 'a-tag-of-some-length', ?)",
			'CREATE TABLE probe1 (i INTEGER PRIMARY KEY, tag TEXT, b BLOB NOT NULL)'
		);
		return {
			bare,
			keyed,
			wide,
			capIsPerBlobNotPerRecord:
				bare.largestAccepted === keyed.largestAccepted &&
				keyed.largestAccepted === wide.largestAccepted
		};
	}

	/**
	 * 2. Which forms bind, plus the statement-TEXT cap.
	 *
	 * The codec question is answered by running the real `encode()` over a real
	 * Uint8Array rather than by reading it: it produces a base64 envelope, and the
	 * inflation is measured, not assumed.
	 */
	measureBindForms(size = 1024 * 1024) {
		this.sql.exec('DROP TABLE IF EXISTS probe2');
		this.sql.exec('CREATE TABLE probe2 (k TEXT PRIMARY KEY, b BLOB)');

		const src = patternBytes(size, 7);
		const forms: Record<string, unknown> = {};

		const tryBind = (name: string, value: any) => {
			try {
				this.sql.exec('DELETE FROM probe2 WHERE k = ?', name);
				this.sql.exec('INSERT INTO probe2 (k, b) VALUES (?, ?)', name, value);
				const row = this.sql
					.exec('SELECT typeof(b) AS t, length(b) AS len FROM probe2 WHERE k = ?', name)
					.toArray()[0];
				forms[name] = {
					accepted: true,
					sqliteType: String(row?.t),
					storedBytes: Number(row?.len),
					lengthMatchesSource: Number(row?.len) === size
				};
			} catch (e: any) {
				forms[name] = { accepted: false, error: errText(e).slice(0, 200) };
			}
		};

		tryBind('Uint8Array', src);
		tryBind('ArrayBuffer', src.buffer.slice(0));
		tryBind('DataView', new DataView(src.buffer.slice(0)));
		// a non-zero-offset view: the snapshot path would hand a subarray of the heap
		const backing = patternBytes(size + 4096, 11);
		tryBind('Uint8Array subarray (offset 4096)', backing.subarray(4096));
		tryBind('Int8Array', new Int8Array(src.buffer.slice(0)));

		// base64 as a BOUND parameter: works, but pays 33% and lands as TEXT
		// `any` because the codec's `Encoded` is a three-way union and the shape it returns for a
		// Uint8Array is exactly what this route is measuring
		const b64: any = encode(src);
		const b64Len = typeof b64 === 'object' && b64 !== null ? String(b64.v).length : 0;
		try {
			this.sql.exec('DELETE FROM probe2 WHERE k = ?', 'base64-bound');
			this.sql.exec(
				'INSERT INTO probe2 (k, b) VALUES (?, ?)',
				'base64-bound',
				typeof b64 === 'object' && b64 !== null ? b64.v : ''
			);
			const row = this.sql
				.exec(
					'SELECT typeof(b) AS t, length(b) AS len FROM probe2 WHERE k = ?',
					'base64-bound'
				)
				.toArray()[0];
			forms['base64 string (bound)'] = {
				accepted: true,
				sqliteType: String(row?.t),
				storedBytes: Number(row?.len),
				lengthMatchesSource: false
			};
		} catch (e: any) {
			forms['base64 string (bound)'] = { accepted: false, error: errText(e).slice(0, 200) };
		}

		const codec = {
			// true means the codec REPLACED the bytes with a base64 envelope, so the raw
			// Uint8Array does not survive it; the earlier name for this field said the
			// opposite of what it measured
			codecBase64sIt: !(b64 instanceof Uint8Array),
			encodedShape: typeof b64 === 'object' && b64 !== null ? String(b64.__t) : typeof b64,
			sourceBytes: size,
			base64Chars: b64Len,
			inflationPercent: b64Len ? +(((b64Len - size) / size) * 100).toFixed(2) : null,
			jsonBytes: JSON.stringify(b64).length
		};

		this.sql.exec('DROP TABLE IF EXISTS probe2');
		return { forms, codec, statementText: this.measureStatementCap() };
	}

	/**
	 * The statement-TEXT cap, bisected the same way.
	 *
	 * This is the limit a base64 or hex LITERAL would hit; a bound parameter is not
	 * part of the statement text and so is not subject to it. Both are measured so
	 * the safe path is established rather than inferred.
	 */
	measureStatementCap() {
		const attempt = (n: number) => {
			// SELECT keeps the failure about statement length only; nothing is stored
			const text = `SELECT length('${'a'.repeat(n)}') AS n`;
			try {
				const row = this.sql.exec(text).toArray()[0];
				return {
					ok: Number(row?.n) === n,
					error: null as string | null,
					statementChars: text.length
				};
			} catch (e: any) {
				return { ok: false, error: errText(e), statementChars: text.length };
			}
		};

		const ladder: Record<string, unknown>[] = [];
		let lastOk = 0;
		let firstFail = 0;
		let failError: string | null = null;
		for (let n = 1024; n <= 256 * 1024 * 1024; n *= 2) {
			const r = attempt(n);
			ladder.push({ literalChars: n, ok: r.ok, error: r.ok ? null : r.error!.slice(0, 160) });
			if (r.ok) {
				lastOk = n;
				continue;
			}
			firstFail = n;
			failError = r.error;
			break;
		}

		let lo = lastOk;
		let hi = firstFail;
		if (hi > 0) {
			while (hi - lo > 1) {
				const mid = lo + Math.floor((hi - lo) / 2);
				const r = attempt(mid);
				if (r.ok) {
					lo = mid;
				} else {
					hi = mid;
					failError = r.error;
				}
			}
		}

		// the same payload as a hex literal, which is what an inlined BLOB costs
		const hexLiteral = (() => {
			const bytes = patternBytes(64 * 1024, 3);
			const text = `SELECT length(x'${toHex(bytes)}') AS n`;
			try {
				const n = Number(this.sql.exec(text).toArray()[0]?.n);
				return {
					payloadBytes: bytes.length,
					statementChars: text.length,
					ok: n === bytes.length
				};
			} catch (e: any) {
				return {
					payloadBytes: bytes.length,
					statementChars: text.length,
					ok: false,
					error: errText(e).slice(0, 200)
				};
			}
		})();

		return {
			ladder,
			largestAcceptedLiteralChars: lo,
			smallestRejectedLiteralChars: hi > 0 ? hi : null,
			rejectionError: failError ? failError.slice(0, 400) : null,
			hexLiteral
		};
	}

	/**
	 * 3. What comes back, and whether the restore path can `.set()` it directly.
	 *
	 * A form that needs conversion costs a full extra copy of the heap, so the
	 * question is not only the type but whether wrapping it aliases the same
	 * backing store.
	 */
	measureReadBack(size = 1024 * 1024) {
		this.sql.exec('DROP TABLE IF EXISTS probe3');
		this.sql.exec('CREATE TABLE probe3 (b BLOB)');
		const src = patternBytes(size, 13);
		this.sql.exec('INSERT INTO probe3 (b) VALUES (?)', src);

		// `any`: which JS type the binding hands back is the question this route answers, and the
		// `.set()` call below is deliberately made with whatever that is
		const value: any = this.sql.exec('SELECT b FROM probe3').toArray()[0]?.b;
		const tag = Object.prototype.toString.call(value);
		const ctor = value?.constructor?.name ?? typeof value;

		const offset = 4096;
		// two heaps, because "set() threw nothing" is not the same claim as "the bytes
		// arrived": `set()` reads `.length`, an ArrayBuffer only has `.byteLength`, so
		// the direct call resolves length to 0, copies nothing, and returns normally.
		// One shared heap would let the wrapped copy backfill the direct call's result.
		const heapDirect = new Uint8Array(size + 8192);
		const heapWrapped = new Uint8Array(size + 8192);

		const landed = (heap: Uint8Array) => {
			if (heap[offset] !== src[0]) return false;
			if (heap[offset + size - 1] !== src[size - 1]) return false;
			for (let i = 0; i < size; i += 4093) if (heap[offset + i] !== src[i]) return false;
			return true;
		};

		let setDirect: SetOutcome = { threw: false, error: null, bytesLanded: false };
		try {
			heapDirect.set(value, offset);
			setDirect.bytesLanded = landed(heapDirect);
		} catch (e: any) {
			setDirect = { threw: true, error: errText(e).slice(0, 200), bytesLanded: false };
		}

		// wrapping an ArrayBuffer in a view is zero copy; prove the aliasing rather
		// than asserting it
		let wrap: WrapOutcome = { needed: false };
		if (value instanceof ArrayBuffer) {
			const view = new Uint8Array(value);
			wrap = {
				needed: true,
				wrapperIsZeroCopyView: view.buffer === value,
				byteLength: view.byteLength
			};
			try {
				heapWrapped.set(view, offset);
				wrap.bytesLanded = landed(heapWrapped);
			} catch (e: any) {
				wrap.bytesLanded = false;
				wrap.error = errText(e).slice(0, 200);
			}
		}

		const asView = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
		let identical: boolean | null = null;
		if (asView && typeof asView.length === 'number') {
			identical = asView.length === size;
			for (let i = 0; identical && i < size; i++) {
				if (asView[i] !== src[i]) identical = false;
			}
		}

		this.sql.exec('DROP TABLE IF EXISTS probe3');
		return {
			bytes: size,
			jsTypeTag: tag,
			constructorName: String(ctor),
			isArrayBuffer: value instanceof ArrayBuffer,
			isUint8Array: value instanceof Uint8Array,
			byteLength: Number(value?.byteLength ?? value?.length ?? -1),
			setDirectThrew: setDirect.threw,
			setDirectError: setDirect.error,
			// the one that matters: a silent zero-byte copy reports threw=false too
			setDirectCopiedTheBytes: setDirect.bytesLanded,
			wrap,
			byteIdenticalThroughBinding: identical
		};
	}

	/**
	 * 4. Integrity at size, checked through two independent instruments.
	 *
	 * SQLite formats `hex(b)` itself, from its own pages; the comparison string is
	 * hexed in JS from the SOURCE array, never from the value the cursor handed
	 * back. So a lossy binding cannot make both sides agree -- which is exactly how
	 * `node:sqlite` truncating TEXT at a NUL let 86 assertions pass over an
	 * unrenderable pack.
	 */
	measureRoundTrip(totalBytes = 8 * 1024 * 1024, chunkBytes = 1024 * 1024) {
		this.sql.exec('DROP TABLE IF EXISTS probe4');
		this.sql.exec('CREATE TABLE probe4 (i INTEGER PRIMARY KEY, b BLOB NOT NULL)');

		const count = Math.ceil(totalBytes / chunkBytes);
		const sources: Uint8Array[] = [];
		let rowsWritten = 0;

		this.ctx.storage.transactionSync(() => {
			for (let i = 0; i < count; i++) {
				const n = Math.min(chunkBytes, totalBytes - i * chunkBytes);
				const bytes = patternBytes(n, 101 + i);
				sources.push(bytes);
				const cur = this.sql.exec('INSERT INTO probe4 (i, b) VALUES (?, ?)', i, bytes);
				cur.toArray();
				rowsWritten += cur.rowsWritten;
			}
		});

		// instrument A: SQLite's own hex(), compared against JS hex of the SOURCE.
		//
		// In WINDOWS, because hex() doubles the length and its result is subject to the
		// same 2,200,000-byte cap as the blob: `hex(b)` on a full-size chunk throws
		// SQLITE_TOOBIG, so a whole-blob digest is only available below ~1.1 MB. The
		// window still covers every byte, it just crosses the boundary in pieces.
		const WINDOW = 1000000;
		let hexMatches = 0;
		let hexMismatch: Record<string, unknown> | null = null;
		let hexWindows = 0;
		for (let i = 0; i < count; i++) {
			const src = sources[i]!;
			let same = true;
			for (let off = 0; off < src.length && same; off += WINDOW) {
				const len = Math.min(WINDOW, src.length - off);
				const got = String(
					this.sql
						.exec(
							'SELECT hex(substr(b, ?, ?)) AS h FROM probe4 WHERE i = ?',
							off + 1,
							len,
							i
						)
						.toArray()[0]?.h
				);
				const want = toHex(src.subarray(off, off + len));
				hexWindows++;
				if (got !== want) {
					same = false;
					if (hexMismatch === null) {
						hexMismatch = {
							chunk: i,
							windowOffset: off,
							sqliteHexChars: got.length,
							sourceHexChars: want.length,
							firstDivergenceAtNibble: (() => {
								const lim = Math.min(got.length, want.length);
								for (let k = 0; k < lim; k++) if (got[k] !== want[k]) return k;
								return lim;
							})()
						};
					}
				}
			}
			if (same) hexMatches++;
		}

		// and the fact that forced the windowing, recorded rather than worked around
		const wholeBlobHex = (() => {
			try {
				const h = this.sql
					.exec('SELECT hex(b) AS h FROM probe4 WHERE i = 0')
					.toArray()[0]?.h;
				return { ok: true, chars: String(h).length };
			} catch (e: any) {
				return { ok: false, error: errText(e).slice(0, 200) };
			}
		})();

		// instrument B: the JS binding, byte by byte
		let bindingMatches = 0;
		let bindingMismatch: Record<string, unknown> | null = null;
		for (let i = 0; i < count; i++) {
			const raw: any = this.sql.exec('SELECT b FROM probe4 WHERE i = ?', i).toArray()[0]?.b;
			const view = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
			const want = sources[i]!;
			let same = view?.length === want.length;
			for (let k = 0; same && k < want.length; k++) if (view[k] !== want[k]) same = false;
			if (same) {
				bindingMatches++;
			} else if (bindingMismatch === null) {
				bindingMismatch = { chunk: i, gotLength: Number(view?.length ?? -1) };
			}
		}

		// third, cheapest, entirely inside SQLite: total length and per-chunk edges
		const agg = this.sql
			.exec('SELECT count(*) AS rows, total(length(b)) AS bytes FROM probe4')
			.toArray()[0];
		const edges = this.sql
			.exec(
				'SELECT i, hex(substr(b, 1, 8)) AS head, hex(substr(b, -8)) AS tail FROM probe4 ORDER BY i'
			)
			.toArray();
		let edgesMatch = true;
		for (const row of edges) {
			const s = sources[Number(row.i)]!;
			if (String(row.head) !== toHex(s.subarray(0, 8))) edgesMatch = false;
			if (String(row.tail) !== toHex(s.subarray(s.length - 8))) edgesMatch = false;
		}

		const totalReported = Number(agg?.bytes);
		this.sql.exec('DROP TABLE IF EXISTS probe4');
		return {
			totalBytes,
			chunkBytes,
			chunks: count,
			rowsWritten,
			sqliteHexMatchedSource: `${hexMatches}/${count}`,
			sqliteHexWindows: hexWindows,
			wholeBlobHex,
			sqliteHexMismatch: hexMismatch,
			jsBindingMatchedSource: `${bindingMatches}/${count}`,
			jsBindingMismatch: bindingMismatch,
			sqliteReportedRows: Number(agg?.rows),
			sqliteReportedBytes: totalReported,
			// under 2^53 by three orders of magnitude, so not a rounded double
			byteCountExact: Number.isSafeInteger(totalReported) && totalReported === totalBytes,
			perChunkEdgesMatch: edgesMatch
		};
	}

	/**
	 * 5. Real rows written, and the wall-clock the restore path would pay.
	 *
	 * `chunkBytes` defaults to something safe; the caller passes the measured row
	 * cap so the row count is the one the real design would spend.
	 */
	measureChunkedWrite(totalBytes = HEAP_BYTES, chunkBytes = 1024 * 1024) {
		this.sql.exec('DROP TABLE IF EXISTS memblob');
		this.sql.exec('CREATE TABLE memblob (i INTEGER PRIMARY KEY, b BLOB NOT NULL)');

		const sizeBefore = this.sql.databaseSize;
		const count = Math.ceil(totalBytes / chunkBytes);
		// one buffer, reused: the snapshot path slices a live heap, it does not allocate per chunk
		const chunk = patternBytes(chunkBytes, 5);

		let rowsWritten = 0;
		const t0 = Date.now();
		this.ctx.storage.transactionSync(() => {
			for (let i = 0; i < count; i++) {
				const n = Math.min(chunkBytes, totalBytes - i * chunkBytes);
				const cur = this.sql.exec(
					'INSERT INTO memblob (i, b) VALUES (?, ?)',
					i,
					n === chunkBytes ? chunk : chunk.subarray(0, n)
				);
				cur.toArray();
				rowsWritten += cur.rowsWritten;
			}
		});
		const writeMs = Date.now() - t0;
		const sizeAfter = this.sql.databaseSize;

		// the restore: read every row and memcpy into one heap-sized buffer
		const heap = new Uint8Array(totalBytes);
		const t1 = Date.now();
		let restored = 0;
		let rowsRead = 0;
		const cur = this.sql.exec('SELECT i, b FROM memblob ORDER BY i');
		for (const row of cur) {
			const raw: any = row.b;
			const view = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
			heap.set(view, restored);
			restored += view.length;
		}
		rowsRead = cur.rowsRead;
		const readMs = Date.now() - t1;

		// verify the reassembled heap at the seams, not only its length
		let seamsOk = restored === totalBytes;
		for (let i = 1; i < count && seamsOk; i++) {
			const at = i * chunkBytes;
			if (heap[at] !== chunk[0]) seamsOk = false;
			if (heap[at - 1] !== chunk[chunkBytes - 1]) seamsOk = false;
		}

		this.sql.exec('DROP TABLE IF EXISTS memblob');
		return {
			totalBytes,
			chunkBytes,
			chunks: count,
			rowsWritten,
			rowsWrittenPerChunk: +(rowsWritten / count).toFixed(3),
			rowsRead,
			writeMs,
			readMs,
			restoredBytes: restored,
			restoredExactly: restored === totalBytes,
			seamsOk,
			databaseSizeBefore: Number(sizeBefore),
			databaseSizeAfter: Number(sizeAfter),
			databaseGrowthBytes: Number(sizeAfter) - Number(sizeBefore),
			storageAmplification: +((Number(sizeAfter) - Number(sizeBefore)) / totalBytes).toFixed(
				4
			),
			// 100,000 rows/day is the free plan's binding meter
			snapshotsPerDayAt100kRows: rowsWritten > 0 ? Math.floor(100000 / rowsWritten) : null
		};
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const q = (name: string, dflt: number) => {
			const v = url.searchParams.get(name);
			return v === null ? dflt : Number(v);
		};
		try {
			switch (url.pathname) {
				case '/max':
					return Response.json(this.measureMaxRow());
				case '/overhead':
					return Response.json(this.measureRowOverhead());
				case '/bind':
					return Response.json(this.measureBindForms(q('size', 1024 * 1024)));
				case '/read':
					return Response.json(this.measureReadBack(q('size', 1024 * 1024)));
				case '/roundtrip':
					return Response.json(
						this.measureRoundTrip(q('total', 8 * 1024 * 1024), q('chunk', 1024 * 1024))
					);
				case '/chunked':
					return Response.json(
						this.measureChunkedWrite(q('total', HEAP_BYTES), q('chunk', 1024 * 1024))
					);
				default:
					return new Response(
						'routes: /max /overhead /bind /read /roundtrip /chunked\n',
						{
							status: 404
						}
					);
			}
		} catch (e: any) {
			return Response.json(
				{ error: errText(e), stack: String(e?.stack ?? '') },
				{ status: 500 }
			);
		}
	}
}

const stub = (env: BlobEnv, name = 'blob-probe') => env.BLOB.get(env.BLOB.idFromName(name));

export default {
	async fetch(request: Request, env: BlobEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/') {
			return new Response('routes: /max /overhead /bind /read /roundtrip /chunked\n');
		}
		// a fresh id per route AND per parameter set: a dropped table does not shrink the
		// file, so a reused object would report the previous run's size as its baseline
		const s = stub(env, `blob-probe${url.pathname}${url.search}`);
		return s.fetch(`https://do${url.pathname}${url.search}`);
	}
};
