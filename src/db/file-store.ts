/**
 * Durable storage for Drupal's `public://` and `private://` files.
 *
 * Writing to `ctx.storage.sql` inverts that. It is synchronous from inside the Durable Object, so a
 * write is durable the moment PHP returns, in the SAME store as the entity row that describes it.
 * The two commit together or not at all. R2 then becomes an OFFLOAD -- worth doing because an R2
 * object on a custom domain serves without invoking the Worker at all, which is the only lever on
 * the serving ceiling -- rather than the thing durability depends on. A missing or failing bucket
 * degrades to "served from the Durable Object", not to data loss.
 *
 * WHY CHUNKED. A Durable Object SQLite record is capped at 2,199,995 bytes, measured. A 3 MB image
 * is an ordinary Drupal upload, so single-row storage would fail on real content. Chunks are also
 * what make a large read divisible across invocations under a 10 ms cap.
 */

/**
 * The slice of `ctx.storage.sql` this module uses.
 *
 * Structural rather than `SqlStorage`, so the store is drivable from anything that can run a
 * statement -- which is what lets the gate lane test it against a real Durable Object handle
 * without the two type surfaces having to agree on members nothing here touches.
 */
export type FileSql = {
	exec(sql: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
};

/**
 * One typed read.
 *
 * The cast is here and nowhere else. `FileSql` is non-generic so that the gate lane's
 * narrowed handle satisfies it, which means the column shapes have to be asserted somewhere; doing
 * it in one place keeps every call site clear that SQLite, not TypeScript, decides
 * what comes back.
 */
function rows<T>(sql: FileSql, text: string, ...bindings: unknown[]): T[] {
	return sql.exec(text, ...bindings).toArray() as unknown as T[];
}

/**
 * Bytes per chunk.
 *
 * Well under the 2,199,995-byte record ceiling rather than near it, for two reasons that both cost
 * something to learn: the ceiling is on the whole record, so the key and the integer columns count
 * against it too, and a chunk has to be readable AND writable inside one 10 ms invocation. 200,000
 * matches `heap-store.ts`, which settled on the same figure for the same reason.
 */
export const FILE_CHUNK_BYTES = 200_000;

/** One stored file's metadata, without its bytes. */
export type FileStat = {
	/** the full stream URI, e.g. `public://styles/thumbnail/foo.png` */
	uri: string;
	size: number;
	/** ms since epoch */
	modified: number;
	mime: string | null;
	chunks: number;
	/** whether a copy has been pushed to R2 for off-Worker serving */
	mirrored: boolean;
};

/** the `cfw_file` columns as SQLite hands them back */
type FileRow = {
	uri: string;
	size: number;
	modified: number;
	mime: string | null;
	chunks: number;
	mirrored: number;
};

function toStat(row: FileRow): FileStat {
	return {
		uri: String(row.uri),
		size: Number(row.size),
		modified: Number(row.modified),
		mime: row.mime === null ? null : String(row.mime),
		chunks: Number(row.chunks),
		mirrored: Number(row.mirrored) === 1
	};
}

export function ensureFileTables(sql: FileSql): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_file (
      uri TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      modified INTEGER NOT NULL,
      mime TEXT,
      chunks INTEGER NOT NULL,
      mirrored INTEGER NOT NULL DEFAULT 0
    )`
	);
	// separate table rather than a blob column on cfw_file: the record ceiling applies per row, so
	// the metadata has to stay readable without dragging 200 KB of bytes through every stat
	sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_file_chunk (
      uri TEXT NOT NULL,
      seq INTEGER NOT NULL,
      bytes BLOB NOT NULL,
      PRIMARY KEY (uri, seq)
    )`
	);
	// the R2 offload queue. A row here means "durable in the DO, not yet mirrored"; the drain
	// clears it. Deliberately NOT the mechanism durability rests on -- see the module docblock.
	sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_file_mirror_queue (
      uri TEXT PRIMARY KEY,
      op TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )`
	);
}

/**
 * Normalises a stream URI so one file has exactly one key.
 *
 * `public://a//b.png` and `public://a/b.png` are the same file to Drupal, and storing them under
 * two keys would let a delete miss and a stat disagree with a read. Rejects `..` outright rather
 * than resolving it: a traversal here would let one site's URI address another scheme's bytes, and
 * there is no legitimate Drupal URI that needs one.
 */
export function normaliseUri(uri: string): string | null {
	const raw = String(uri ?? '').trim();
	const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw);
	if (!match) return null;
	const scheme = (match[1] as string).toLowerCase();
	const parts = (match[2] as string).split('/').filter((p) => p !== '' && p !== '.');
	if (parts.some((p) => p === '..')) return null;
	return `${scheme}://${parts.join('/')}`;
}

/**
 * The ONE scheme whose bytes may leave the Durable Object for a public bucket.
 *
 * Drupal's `private://` is not a naming convention, it is an access-control boundary: those files
 * serve through `/system/files/`, a route that runs a per-user access check on every request
 * (`CfwFileStreamWrapper::getExternalUrl()` builds that path). An R2 object has no user, so
 * mirroring a private file publishes it permanently to anyone holding the URL -- an
 * authentication bypass, and a worse one than serving a stale personalised page, because it does
 * not expire and cannot be invalidated after the fact.
 *
 * So this is the file-side of the same rule `src/site.ts` enforces for renders: **anything whose
 * correctness depends on knowing who is asking must not be answered by a layer that does not
 * know.** It is a list rather than a `!== 'private'` test -- a scheme added later
 * (`temporary://`, a contrib scheme) is refused until someone decides it is publishable, which is
 * the direction a mistake should fail in.
 */
export const MIRRORABLE_SCHEMES: readonly string[] = ['public'];

/**
 * Whether a URI may be mirrored off the object at all.
 *
 * Enforced at BOTH ends -- `queueMirror()` keeps the queue clean and `drainMirrors()` refuses again
 * before touching the bucket, and the redundancy is what matters. A queue row can outlive the rule
 * that admitted it: a file mirrored while public, then replaced by a private one at the same URI,
 * leaves a stale `put` behind. Checking only at enqueue would publish it.
 */
export function isMirrorable(uri: string): boolean {
	const key = normaliseUri(uri);
	if (key === null) return false;
	const scheme = key.slice(0, key.indexOf('://')).toLowerCase();
	return MIRRORABLE_SCHEMES.includes(scheme);
}

/**
 * Queues one mirror operation, or declines to.
 *
 * The four call sites -- write, delete, and both halves of a rename -- had the same upsert copied
 * out four times, which is four places for the refusal above to be forgotten in. One helper makes
 * "a private file is never enqueued" a property of the module rather than of four call sites that
 * happen to agree today.
 *
 * A `delete` is gated by the same predicate rather than always queued, and that is correct rather
 * than lax: a private URI has no R2 object to remove because it was never allowed to have one. The
 * case that matters is `rename('public://a', 'private://b')`, where the scheme is per-URI, so the
 * put of `private://b` is refused while the delete of `public://a` still runs and clears the stale
 * object.
 *
 * @returns whether anything was queued.
 */
export function queueMirror(
	sql: FileSql,
	uri: string,
	op: 'put' | 'delete',
	nowMs: number
): boolean {
	if (!isMirrorable(uri)) return false;
	sql.exec(
		`INSERT INTO cfw_file_mirror_queue (uri, op, queued_at, attempts)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(uri) DO UPDATE SET op = excluded.op, queued_at = excluded.queued_at, attempts = 0`,
		uri,
		op,
		nowMs
	);
	return true;
}

/**
 * Bytes to base64, for the crossing into PHP.
 *
 * Chunked through `String.fromCharCode` rather than spreading the whole array. `fromCharCode(...bytes)`
 * passes every byte as an argument, and a 200 KB chunk is 200,000 arguments -- which overflows the
 * call stack rather than returning a wrong answer, so it would fail on exactly the large uploads
 * this module exists to support and pass every small-file test.
 */
export function bytesToBase64(bytes: Uint8Array): string {
	let out = '';
	const stride = 8_192;
	for (let at = 0; at < bytes.length; at += stride) {
		out += String.fromCharCode(...bytes.subarray(at, Math.min(at + stride, bytes.length)));
	}
	return btoa(out);
}

/** base64 back to bytes, for the crossing out of PHP. */
export function base64ToBytes(b64: string): Uint8Array {
	const raw = atob(String(b64 ?? ''));
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

/** Splits bytes into chunk-sized pieces; an empty file yields one empty chunk so a read is uniform. */
export function chunkBytes(bytes: Uint8Array, chunkSize = FILE_CHUNK_BYTES): Uint8Array[] {
	const size = Math.max(1, Math.floor(chunkSize));
	if (bytes.length === 0) return [new Uint8Array(0)];
	const out: Uint8Array[] = [];
	for (let at = 0; at < bytes.length; at += size) {
		out.push(bytes.subarray(at, Math.min(at + size, bytes.length)));
	}
	return out;
}

export type PutResult = { uri: string; size: number; chunks: number };

/**
 * Stores a file, replacing any previous copy.
 *
 * The old chunks are deleted FIRST and unconditionally. Overwriting a 3-chunk file with a 1-chunk
 * one by INSERT OR REPLACE alone would leave chunks 1 and 2 behind, and the next read -- which
 * trusts `chunks` from the metadata row -- would return the new first chunk followed by nothing,
 * silently truncating. Worse, a later overwrite back up to 3 chunks would splice the new chunk 0
 * onto the ORIGINAL chunks 1 and 2 and produce a file that never existed.
 */
export function putFile(
	sql: FileSql,
	uri: string,
	bytes: Uint8Array,
	opts: { mime?: string | null; nowMs: number; chunkSize?: number } = { nowMs: 0 }
): PutResult {
	const key = normaliseUri(uri);
	if (key === null) throw new Error(`not a storable stream uri: ${uri}`);
	ensureFileTables(sql);

	sql.exec('DELETE FROM cfw_file_chunk WHERE uri = ?', key);
	const chunks = chunkBytes(bytes, opts.chunkSize ?? FILE_CHUNK_BYTES);
	for (const [seq, chunk] of chunks.entries()) {
		sql.exec('INSERT INTO cfw_file_chunk (uri, seq, bytes) VALUES (?, ?, ?)', key, seq, chunk);
	}
	sql.exec(
		`INSERT INTO cfw_file (uri, size, modified, mime, chunks, mirrored)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(uri) DO UPDATE SET
       size = excluded.size,
       modified = excluded.modified,
       mime = excluded.mime,
       chunks = excluded.chunks,
       mirrored = 0`,
		key,
		bytes.length,
		opts.nowMs,
		opts.mime ?? null,
		chunks.length
	);
	// mirrored resets to 0 above, so the queue entry has to come back too: a replaced file whose
	// old copy is already in R2 would otherwise serve the PREVIOUS bytes off the custom domain
	// forever, which looks like a caching bug and is a correctness one
	queueMirror(sql, key, 'put', opts.nowMs);
	return { uri: key, size: bytes.length, chunks: chunks.length };
}

export function statFile(sql: FileSql, uri: string): FileStat | null {
	const key = normaliseUri(uri);
	if (key === null) return null;
	ensureFileTables(sql);
	const row = rows<FileRow>(
		sql,
		'SELECT uri, size, modified, mime, chunks, mirrored FROM cfw_file WHERE uri = ?',
		key
	)[0];
	if (row === undefined) return null;
	return toStat(row);
}

/**
 * Reads a whole file, or null when it is not stored.
 *
 * Chunks are ordered by `seq` explicitly. Relying on insertion order would work until the first
 * overwrite and then quietly reassemble the file wrong, which is the kind of corruption that
 * survives every test that only ever writes once.
 */
export function getFile(sql: FileSql, uri: string): Uint8Array | null {
	const meta = statFile(sql, uri);
	if (meta === null) return null;
	const chunkRows = rows<{ bytes: ArrayBuffer | Uint8Array }>(
		sql,
		'SELECT bytes FROM cfw_file_chunk WHERE uri = ? ORDER BY seq',
		meta.uri
	);
	const out = new Uint8Array(meta.size);
	let at = 0;
	for (const row of chunkRows) {
		const chunk =
			row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes as ArrayBuffer);
		// clamped rather than trusted: `size` and the stored chunks are two sources of truth for
		// one length, and a mismatch must not write past the end of the buffer
		const take = Math.min(chunk.length, out.length - at);
		if (take <= 0) break;
		out.set(chunk.subarray(0, take), at);
		at += take;
	}
	return at === meta.size ? out : out.subarray(0, at);
}

/**
 * Reads one chunk, for a read that has to be divisible across invocations.
 *
 * Returns null for a file that is not stored AND for a `seq` past the end, because both mean "no
 * bytes here" to a caller walking chunks until it runs out.
 */
export function getFileChunk(sql: FileSql, uri: string, seq: number): Uint8Array | null {
	const key = normaliseUri(uri);
	if (key === null) return null;
	ensureFileTables(sql);
	const row = rows<{ bytes: ArrayBuffer | Uint8Array }>(
		sql,
		'SELECT bytes FROM cfw_file_chunk WHERE uri = ? AND seq = ?',
		key,
		Math.floor(seq)
	)[0];
	if (row === undefined) return null;
	return row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes as ArrayBuffer);
}

/** Deletes a file and queues the R2 copy for removal. Reports whether anything was there. */
export function deleteFile(sql: FileSql, uri: string, nowMs: number): boolean {
	const meta = statFile(sql, uri);
	if (meta === null) return false;
	sql.exec('DELETE FROM cfw_file_chunk WHERE uri = ?', meta.uri);
	sql.exec('DELETE FROM cfw_file WHERE uri = ?', meta.uri);
	// queued even when the file was never mirrored: `mirrored` describes what the DO believes, and
	// a mirror that raced a delete would otherwise leave the object served from R2 after the file
	// is gone. A delete of an absent object is a no-op, so the cheap direction is the safe one.
	queueMirror(sql, meta.uri, 'delete', nowMs);
	return true;
}

/**
 * Lists stored files under a URI prefix.
 *
 * Escapes the LIKE metacharacters in the prefix. Drupal filenames legitimately contain `_`, which
 * is a single-character wildcard in LIKE, so an unescaped prefix would match sibling directories --
 * and a directory listing that returns another directory's files is how a delete-by-prefix removes
 * the wrong thing. The 50-byte LIKE-pattern ceiling measured on this platform applies, so a longer
 * prefix is filtered in JS instead.
 */
export function listFiles(sql: FileSql, prefix: string, limit = 1_000): FileStat[] {
	ensureFileTables(sql);
	const key = normaliseUri(prefix) ?? String(prefix ?? '');
	const pattern = `${key.replace(/([%_\\])/g, '\\$1')}%`;
	const capped = Math.max(1, Math.floor(limit));
	// the 50-byte LIKE-pattern ceiling is a measured platform limit, so a longer prefix cannot be
	// pushed into SQL at all and is filtered here instead
	const matched =
		pattern.length <= 50
			? rows<FileRow>(
					sql,
					"SELECT uri, size, modified, mime, chunks, mirrored FROM cfw_file WHERE uri LIKE ? ESCAPE '\\' ORDER BY uri LIMIT ?",
					pattern,
					capped
				)
			: rows<FileRow>(
					sql,
					'SELECT uri, size, modified, mime, chunks, mirrored FROM cfw_file ORDER BY uri'
				)
					.filter((r) => String(r.uri).startsWith(key))
					.slice(0, capped);
	return matched.map(toStat);
}

/**
 * Moves a file, which Drupal does on nearly every managed upload.
 *
 * Implemented as a metadata rename plus a chunk re-key rather than a read-modify-write, so moving a
 * 3 MB file does not pull 3 MB through the isolate. Refuses to clobber silently: `file_move()` has
 * its own replace semantics and deciding them here would override the caller's.
 */
export function renameFile(
	sql: FileSql,
	from: string,
	to: string,
	nowMs: number,
	opts: { overwrite?: boolean } = {}
): boolean {
	const src = normaliseUri(from);
	const dst = normaliseUri(to);
	if (src === null || dst === null) return false;
	if (src === dst) return true;
	const meta = statFile(sql, src);
	if (meta === null) return false;
	if (statFile(sql, dst) !== null) {
		if (!opts.overwrite) return false;
		deleteFile(sql, dst, nowMs);
	}
	sql.exec('UPDATE cfw_file_chunk SET uri = ? WHERE uri = ?', dst, src);
	sql.exec(
		'UPDATE cfw_file SET uri = ?, modified = ?, mirrored = 0 WHERE uri = ?',
		dst,
		nowMs,
		src
	);
	sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', src);
	queueMirror(sql, dst, 'put', nowMs);
	// the old object has to leave R2 as well, and it is a DIFFERENT key from the new one, so this
	// is a second queue row rather than an update of the first. It is also gated separately: a
	// rename OUT of `public://` refuses the put and still runs this delete, which is exactly the
	// case where forgetting it would leave the old bytes public forever.
	queueMirror(sql, src, 'delete', nowMs);
	return true;
}

export type MirrorTask = { uri: string; op: 'put' | 'delete'; attempts: number };

/** The next files to push to or remove from R2, oldest first. */
export function pendingMirrors(sql: FileSql, limit = 10): MirrorTask[] {
	ensureFileTables(sql);
	return rows<{ uri: string; op: string; attempts: number }>(
		sql,
		'SELECT uri, op, attempts FROM cfw_file_mirror_queue ORDER BY queued_at LIMIT ?',
		Math.max(1, Math.floor(limit))
	).map((row) => ({
		uri: String(row.uri),
		op: String(row.op) === 'delete' ? 'delete' : 'put',
		attempts: Number(row.attempts)
	}));
}

/** How many attempts a mirror gets before it is dropped rather than retried forever. */
export const MIRROR_STRIKES = 3;

/**
 * Records a mirror outcome.
 *
 * A failure that has struck out DROPS the queue row instead of holding it:
 * the file is already durable in the Durable Object and serves from there, so an unmirrored file is
 * a lost optimisation rather than a lost file. Retrying forever would spend the rows-written meter
 * -- the one that binds regeneration -- on a bucket that is not coming back.
 */
export function recordMirror(
	sql: FileSql,
	uri: string,
	outcome: { ok: boolean; error?: string }
): { dropped: boolean; attempts: number } {
	ensureFileTables(sql);
	const key = normaliseUri(uri) ?? uri;
	if (outcome.ok) {
		sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', key);
		sql.exec('UPDATE cfw_file SET mirrored = 1 WHERE uri = ?', key);
		return { dropped: false, attempts: 0 };
	}
	const row = rows<{ attempts: number }>(
		sql,
		'SELECT attempts FROM cfw_file_mirror_queue WHERE uri = ?',
		key
	)[0];
	const attempts = Number(row?.attempts ?? 0) + 1;
	if (attempts >= MIRROR_STRIKES) {
		sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', key);
		return { dropped: true, attempts };
	}
	sql.exec(
		'UPDATE cfw_file_mirror_queue SET attempts = ?, last_error = ? WHERE uri = ?',
		attempts,
		String(outcome.error ?? '').slice(0, 400),
		key
	);
	return { dropped: false, attempts };
}

/**
 * The slice of R2 this module needs, narrowed so the drain is drivable over a stand-in.
 *
 * Structural rather than `R2Bucket`, for the same reason `FileSql` is structural: the interesting
 * cases are a `put` that throws, a bucket binding that is absent, and a refusal that must happen
 * BEFORE either -- none of which need a real bucket to exercise, and all of which a real bucket
 * would make slow and non-deterministic to reach.
 */
export type MirrorBucket = {
	put(key: string, value: Uint8Array, options?: unknown): Promise<unknown>;
	delete(key: string): Promise<unknown>;
};

/** What one drain pass did, in the terms the meters care about. */
export type MirrorDrain = {
	/** operations that reached the bucket and succeeded */
	mirrored: number;
	deleted: number;
	/** attempts that failed and remain queued for another pass */
	failed: number;
	/** attempts that failed for the last time and were given up on */
	droppedAfterStrikes: number;
	/**
	 * rows the drain REFUSED to send, by scheme.
	 *
	 * Reported rather than silently skipped. A queue row that cannot be mirrored is either a
	 * private file (correct, and this is the count that proves the rule is live) or a bug in
	 * whatever enqueued it, and a silent skip cannot tell those apart.
	 */
	refused: number;
	/** true when there is no bucket bound at all, which is the free-tier default */
	noBucket?: boolean;
};

/**
 * The R2 key a stream URI maps to.
 *
 * Keeps the scheme in the key rather than stripping it. `public://a.png` becoming `a.png` would
 * put two schemes in one namespace the moment a second one is ever mirrored, and a key collision
 * between an access-controlled file and a public one is the failure this whole module is arranged
 * to prevent. Costs seven characters.
 */
export function mirrorKey(uri: string, site = 'site'): string | null {
	const key = normaliseUri(uri);
	if (key === null) return null;
	// SITE-SCOPED, because one deployment can serve many objects into one bucket and this key had
	// no site component at all: `public://logo.png` was `public/logo.png` for every one of them
	return `f/${encodeURIComponent(site)}/${key.replace('://', '/')}`;
}

/**
 * Pushes queued files to R2 and removes the ones that left.
 *
 * Serving a page from R2 on a custom domain costs **zero Worker requests**,
 * which is the only lever on the serving ceiling -- every other optimisation moves CPU or rows
 * while the ceiling stays at 3M visits/month. The queue existed and drained nowhere, so the
 * ceiling stayed saturated.
 *
 * The refusal is re-checked here, having already been checked at enqueue, because of the boundary
 * rule: `isMirrorable()` at enqueue guards the queue, and a queue row
 * can outlive the state that admitted it. Only the check adjacent to the `put` guards the bucket.
 *
 * Sequential rather than concurrent. A pass runs inside one invocation against a 10 ms
 * CPU budget, and `limit` is what bounds it; firing N puts at once would make the slowest one
 * decide the invocation and remove the only control there is over that.
 */
export async function drainMirrors(
	sql: FileSql,
	bucket: MirrorBucket | null | undefined,
	opts: { limit?: number; site?: string } = {}
): Promise<MirrorDrain> {
	const out: MirrorDrain = {
		mirrored: 0,
		deleted: 0,
		failed: 0,
		droppedAfterStrikes: 0,
		refused: 0
	};
	// no bucket is the FREE-TIER DEFAULT, not an error: the object is the durable copy and R2 is
	// an offload. Reporting it lets a caller tell "nothing to do" from "not configured".
	if (!bucket) return { ...out, noBucket: true };

	for (const task of pendingMirrors(sql, opts.limit ?? 10)) {
		const key = mirrorKey(task.uri, opts.site ?? 'site');
		if (key === null || !isMirrorable(task.uri)) {
			// dropped rather than left to be re-read every pass: it can never become sendable,
			// so holding it would make the queue permanently non-empty and starve real work
			sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', task.uri);
			out.refused += 1;
			continue;
		}
		try {
			if (task.op === 'delete') {
				await bucket.delete(key);
				// the file row is gone already, so there is nothing to mark mirrored; clearing
				// the queue row is the whole of the bookkeeping
				sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', task.uri);
				out.deleted += 1;
				continue;
			}
			const bytes = getFile(sql, task.uri);
			if (bytes === null) {
				// the file was deleted between enqueue and drain. Not a failure and not a retry:
				// there is nothing to push and the delete is queued separately.
				sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', task.uri);
				continue;
			}
			const meta = statFile(sql, task.uri);
			await bucket.put(key, bytes, {
				httpMetadata: meta?.mime ? { contentType: meta.mime } : undefined
			});
			recordMirror(sql, task.uri, { ok: true });
			out.mirrored += 1;
		} catch (error) {
			const outcome = recordMirror(sql, task.uri, {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			});
			if (outcome.dropped) out.droppedAfterStrikes += 1;
			else out.failed += 1;
		}
	}
	return out;
}

/** Total bytes stored, for a quota reading the UI can show before a user hits a limit. */
export function storedBytes(sql: FileSql): { files: number; bytes: number } {
	ensureFileTables(sql);
	const row = rows<{ n: number; b: number | null }>(
		sql,
		'SELECT COUNT(*) AS n, SUM(size) AS b FROM cfw_file'
	)[0];
	return { files: Number(row?.n ?? 0), bytes: Number(row?.b ?? 0) };
}
