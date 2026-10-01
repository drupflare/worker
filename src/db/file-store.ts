/**
 * Durable file storage in `ctx.storage.sql`, chunked because a record caps at 2,199,995 bytes.
 * R2 is only an offload; a failing bucket degrades to serving from the object.
 * @module
 */
import { binaryToBytes } from '../util/base64';

/** the slice of `ctx.storage.sql` this module uses; structural so a mock can drive it */
export type FileSql = {
	exec(sql: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
};

/** one typed read; the cast lives here because `FileSql` is non-generic */
function rows<T>(sql: FileSql, text: string, ...bindings: unknown[]): T[] {
	return sql.exec(text, ...bindings).toArray() as unknown as T[];
}

/**
 * Bytes per chunk, well under the 2,199,995-byte record ceiling (key and columns count too).
 * Matches `heap-store.ts`.
 */
export const FILE_CHUNK_BYTES = 200_000;

/** one stored file's metadata, without its bytes */
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

/** coerces a raw row into a `FileStat` */
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

/** creates the file, chunk and mirror-queue tables when absent */
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
	// the R2 offload queue: a row means durable in the object, not yet mirrored
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
 * Normalises a stream URI so one file has one key (`public://a//b.png` is `public://a/b.png`).
 * Rejects `..` rather than resolving it, so a URI cannot address another scheme's bytes.
 */
export function normaliseUri(uri: string): string | undefined {
	const raw = String(uri ?? '').trim();
	const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw);
	if (!match) return undefined;
	const scheme = (match[1] as string).toLowerCase();
	const parts = (match[2] as string).split('/').filter((p) => p !== '' && p !== '.');
	if (parts.some((p) => p === '..')) return undefined;
	return `${scheme}://${parts.join('/')}`;
}

/**
 * The only schemes that may leave the object for a public bucket (allow-list, so new ones fail
 * closed); `private://` has per-user checks that an R2 object cannot, so it is never mirrored.
 */
export const MIRRORABLE_SCHEMES: readonly string[] = ['public'];

/**
 * Whether a URI may be mirrored off the object; rechecked in `drainMirrors()` because a stale
 * queue row can outlive the rule (a public file replaced by a private one at the same URI).
 */
export function isMirrorable(uri: string): boolean {
	const key = normaliseUri(uri);
	if (key === undefined) return false;
	const scheme = key.slice(0, key.indexOf('://')).toLowerCase();
	return MIRRORABLE_SCHEMES.includes(scheme);
}

/**
 * Queues one mirror operation unless the URI is not mirrorable; returns whether it queued.
 * The scheme is per-URI, so renaming `public://a` to `private://b` still deletes the old object.
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
 * Strided because spreading a 200 KB chunk into `fromCharCode` overflows the call stack.
 */
export function bytesToBase64(bytes: Uint8Array): string {
	let out = '';
	const stride = 8_192;
	for (let at = 0; at < bytes.length; at += stride) {
		out += String.fromCharCode(...bytes.subarray(at, Math.min(at + stride, bytes.length)));
	}
	return btoa(out);
}

/** base64 back to bytes, for the crossing out of PHP */
export function base64ToBytes(b64: string): Uint8Array {
	return binaryToBytes(atob(String(b64 ?? '')));
}

/** splits bytes into chunk-sized pieces; an empty file yields one empty chunk */
export function chunkBytes(bytes: Uint8Array, chunkSize = FILE_CHUNK_BYTES): Uint8Array[] {
	const size = Math.max(1, Math.floor(chunkSize));
	if (bytes.length === 0) return [new Uint8Array(0)];
	const out: Uint8Array[] = [];
	for (let at = 0; at < bytes.length; at += size) {
		out.push(bytes.subarray(at, Math.min(at + size, bytes.length)));
	}
	return out;
}

/** what `putFile` stored: the normalised key, byte size and chunk count */
export type PutResult = { uri: string; size: number; chunks: number };

/**
 * Stores a file, replacing any previous copy; old chunks go first so a shorter overwrite leaves
 * none for a later longer one to splice onto.
 */
export function putFile(
	sql: FileSql,
	uri: string,
	bytes: Uint8Array,
	opts: { mime?: string; nowMs: number; chunkSize?: number } = { nowMs: 0 }
): PutResult {
	const key = normaliseUri(uri);
	if (key === undefined) throw new Error(`not a storable stream uri: ${uri}`);
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
	// `mirrored` reset above, so requeue or R2 keeps serving the previous bytes forever
	queueMirror(sql, key, 'put', opts.nowMs);
	return { uri: key, size: bytes.length, chunks: chunks.length };
}

/** the file's metadata, or undefined when it is not stored */
export function statFile(sql: FileSql, uri: string): FileStat | undefined {
	const key = normaliseUri(uri);
	if (key === undefined) return undefined;
	ensureFileTables(sql);
	const row = rows<FileRow>(
		sql,
		'SELECT uri, size, modified, mime, chunks, mirrored FROM cfw_file WHERE uri = ?',
		key
	)[0];
	if (row === undefined) return undefined;
	return toStat(row);
}

/** reads a whole file (chunks ordered by `seq`), or undefined when it is not stored */
export function getFile(sql: FileSql, uri: string): Uint8Array | undefined {
	const meta = statFile(sql, uri);
	if (meta === undefined) return undefined;
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
		// clamped: `size` and the chunks are two sources for one length
		const take = Math.min(chunk.length, out.length - at);
		if (take <= 0) break;
		out.set(chunk.subarray(0, take), at);
		at += take;
	}
	return at === meta.size ? out : out.subarray(0, at);
}

/** reads one chunk; undefined for a missing file or a `seq` past the end */
export function getFileChunk(sql: FileSql, uri: string, seq: number): Uint8Array | undefined {
	const key = normaliseUri(uri);
	if (key === undefined) return undefined;
	ensureFileTables(sql);
	const row = rows<{ bytes: ArrayBuffer | Uint8Array }>(
		sql,
		'SELECT bytes FROM cfw_file_chunk WHERE uri = ? AND seq = ?',
		key,
		Math.floor(seq)
	)[0];
	if (row === undefined) return undefined;
	return row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes as ArrayBuffer);
}

/** deletes a file and queues its R2 copy for removal; reports whether anything was there */
export function deleteFile(sql: FileSql, uri: string, nowMs: number): boolean {
	const meta = statFile(sql, uri);
	if (meta === undefined) return false;
	sql.exec('DELETE FROM cfw_file_chunk WHERE uri = ?', meta.uri);
	sql.exec('DELETE FROM cfw_file WHERE uri = ?', meta.uri);
	// queued even when never mirrored: a mirror racing the delete would leave the object in R2
	queueMirror(sql, meta.uri, 'delete', nowMs);
	return true;
}

/**
 * The exclusive upper bound of a prefix range (last code unit incremented); an empty or
 * top-code-unit prefix gets a wide bound that the caller's `startsWith` filters.
 */
function prefixCeiling(prefix: string): string {
	if (prefix === '') return '\uffff';
	const last = prefix.charCodeAt(prefix.length - 1);
	if (last >= 0xffff) return `${prefix}\uffff`;
	return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/**
 * Lists stored files under a URI prefix, escaping `LIKE` wildcards (`_` is common in filenames
 * and would match sibling directories).
 */
export function listFiles(sql: FileSql, prefix: string, limit = 1_000): FileStat[] {
	ensureFileTables(sql);
	const key = normaliseUri(prefix) ?? String(prefix ?? '');
	const pattern = `${key.replace(/([%_\\])/g, '\\$1')}%`;
	const capped = Math.max(1, Math.floor(limit));
	// `LIKE` patterns cap at 50 bytes on this platform, so a longer prefix is filtered here
	const matched =
		pattern.length <= 50
			? rows<FileRow>(
					sql,
					"SELECT uri, size, modified, mime, chunks, mirrored FROM cfw_file WHERE uri LIKE ? ESCAPE '\\' ORDER BY uri LIMIT ?",
					pattern,
					capped
				)
			: // keep the `LIMIT` and range: unbounded, every `url_stat()` miss read all of `cfw_file`
				rows<FileRow>(
					sql,
					'SELECT uri, size, modified, mime, chunks, mirrored FROM cfw_file WHERE uri >= ? AND uri < ? ORDER BY uri LIMIT ?',
					key,
					prefixCeiling(key),
					capped
				).filter((r) => String(r.uri).startsWith(key));
	return matched.map(toStat);
}

/**
 * Moves a file by re-keying its rows, so the bytes never cross the isolate.
 * Refuses to clobber unless `overwrite` is set; `file_move()` owns replace semantics.
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
	if (src === undefined || dst === undefined) return false;
	if (src === dst) return true;
	const meta = statFile(sql, src);
	if (meta === undefined) return false;
	if (statFile(sql, dst) !== undefined) {
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
	// the old key is a separate queue row; a rename out of `public://` still needs this delete
	queueMirror(sql, src, 'delete', nowMs);
	return true;
}

/** one queued R2 operation and how many times it has failed */
export type MirrorTask = { uri: string; op: 'put' | 'delete'; attempts: number };

/** the next files to push to or remove from R2, oldest first */
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

/** attempts a mirror gets before it is dropped rather than retried forever */
export const MIRROR_STRIKES = 3;

/**
 * Records a mirror outcome; a failure past `MIRROR_STRIKES` drops the queue row.
 * The file still serves from the object, and retrying forever spends the rows-written meter.
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

/** the slice of R2 the drain needs; structural so a stand-in can drive it */
export type MirrorBucket = {
	put(key: string, value: Uint8Array, options?: unknown): Promise<unknown>;
	delete(key: string): Promise<unknown>;
};

/** what one drain pass did, in the terms the meters care about */
export type MirrorDrain = {
	/** operations that reached the bucket and succeeded */
	mirrored: number;
	deleted: number;
	/** attempts that failed and remain queued for another pass */
	failed: number;
	/** attempts that failed for the last time and were given up on */
	droppedAfterStrikes: number;
	/** rows refused as unmirrorable (a private file, or a bug in whatever enqueued it) */
	refused: number;
	/** true when there is no bucket bound at all, which is the free-tier default */
	noBucket?: boolean;
};

/**
 * The R2 key a stream URI maps to; keeps the scheme so a private and a public file never collide.
 */
export function mirrorKey(uri: string, site = 'site'): string | undefined {
	const key = normaliseUri(uri);
	if (key === undefined) return undefined;
	// site-scoped: many objects share one bucket
	return `f/${encodeURIComponent(site)}/${key.replace('://', '/')}`;
}

/**
 * Pushes queued files to R2 and removes the ones that left; a custom-domain hit costs no Worker
 * request. Re-checks `isMirrorable()` beside the `put`, and runs sequentially so `limit` bounds it.
 */
export async function drainMirrors(
	sql: FileSql,
	bucket: MirrorBucket | undefined,
	opts: { limit?: number; site?: string } = {}
): Promise<MirrorDrain> {
	const out: MirrorDrain = {
		mirrored: 0,
		deleted: 0,
		failed: 0,
		droppedAfterStrikes: 0,
		refused: 0
	};
	// no bucket is the free-tier default, not an error (reported so "not configured" is visible)
	if (!bucket) return { ...out, noBucket: true };

	for (const task of pendingMirrors(sql, opts.limit ?? 10)) {
		const key = mirrorKey(task.uri, opts.site ?? 'site');
		if (key === undefined || !isMirrorable(task.uri)) {
			// dropped: it can never become sendable and would starve real work
			sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', task.uri);
			out.refused += 1;
			continue;
		}
		try {
			if (task.op === 'delete') {
				await bucket.delete(key);
				// the file row is gone, so clearing the queue row is all the bookkeeping
				sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', task.uri);
				out.deleted += 1;
				continue;
			}
			const bytes = getFile(sql, task.uri);
			if (bytes === undefined) {
				// deleted between enqueue and drain; the delete is queued separately
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

/** file count and total bytes stored, for a quota reading */
export function storedBytes(sql: FileSql): { files: number; bytes: number } {
	ensureFileTables(sql);
	const row = rows<{ n: number; b: number | null }>(
		sql,
		'SELECT COUNT(*) AS n, SUM(size) AS b FROM cfw_file'
	)[0];
	return { files: Number(row?.n ?? 0), bytes: Number(row?.b ?? 0) };
}
