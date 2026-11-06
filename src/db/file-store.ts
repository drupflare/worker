/**
 * Durable file storage in `ctx.storage.sql`, chunked because a record caps at 2,199,995 bytes.
 * R2 is an offload: a failing bucket degrades to serving from the object. With `FILE_STORE=r2`
 * a file whose put was verified is evicted from the object after a grace window and R2 holds the
 * only copy of its bytes.
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
	/** bumped by every write, so an in-flight R2 put can tell its bytes were replaced */
	rev: number;
	/** whether the object holds no chunks and R2 has the only copy of the bytes */
	evicted: boolean;
};

/** the `cfw_file` columns as SQLite hands them back */
type FileRow = {
	uri: string;
	size: number;
	modified: number;
	mime: string | null;
	chunks: number;
	mirrored: number;
	rev: number;
	evicted: number;
};

const FILE_COLUMNS = 'uri, size, modified, mime, chunks, mirrored, rev, evicted';

/** coerces a raw row into a `FileStat` */
function toStat(row: FileRow): FileStat {
	return {
		uri: String(row.uri),
		size: Number(row.size),
		modified: Number(row.modified),
		mime: row.mime === null ? null : String(row.mime),
		chunks: Number(row.chunks),
		mirrored: Number(row.mirrored) === 1,
		rev: Number(row.rev),
		evicted: Number(row.evicted) === 1
	};
}

/** the file's bytes live only in R2, and a synchronous reader cannot wait for them */
export class FileOffloadedError extends Error {
	constructor(readonly uri: string) {
		super(`${uri} is offloaded to R2`);
		this.name = 'FileOffloadedError';
	}
}

/** `cfw_file` columns added after the first release, as `ALTER TABLE` clauses */
const ADDED_COLUMNS: readonly (readonly [string, string])[] = [
	['rev', 'INTEGER NOT NULL DEFAULT 0'],
	['touched', 'INTEGER NOT NULL DEFAULT 0'],
	['evicted', 'INTEGER NOT NULL DEFAULT 0'],
	['hash', 'TEXT']
];

/** handles already migrated, so the column check costs one read per object rather than per call */
const migrated = new WeakSet<object>();

/** creates the file, chunk and mirror-queue tables when absent */
export function ensureFileTables(sql: FileSql): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_file (
      uri TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      modified INTEGER NOT NULL,
      mime TEXT,
      chunks INTEGER NOT NULL,
      mirrored INTEGER NOT NULL DEFAULT 0,
      rev INTEGER NOT NULL DEFAULT 0,
      touched INTEGER NOT NULL DEFAULT 0,
      evicted INTEGER NOT NULL DEFAULT 0,
      hash TEXT
    )`
	);
	if (!migrated.has(sql)) {
		const have = new Set(
			rows<{ name: string }>(sql, "SELECT name FROM pragma_table_info('cfw_file')").map((r) =>
				String(r.name)
			)
		);
		for (const [name, type] of ADDED_COLUMNS) {
			if (!have.has(name)) sql.exec(`ALTER TABLE cfw_file ADD COLUMN ${name} ${type}`);
		}
		// partial, so a file costs an index row only once its put is verified
		sql.exec(
			`CREATE INDEX IF NOT EXISTS cfw_file_evictable ON cfw_file (touched)
       WHERE mirrored = 1 AND evicted = 0 AND hash IS NOT NULL`
		);
		migrated.add(sql);
	}
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
 * The schemes that may leave the object when R2 is the store and a private bucket is bound.
 * The private bucket has no custom domain, so a guessable key there exposes nothing.
 */
export const OFFLOAD_SCHEMES: readonly string[] = ['public', 'private'];

/**
 * Whether a URI may be mirrored off the object; rechecked in `drainMirrors()` because a stale
 * queue row can outlive the rule (a public file replaced by a private one at the same URI).
 */
export function isMirrorable(
	uri: string,
	schemes: readonly string[] = MIRRORABLE_SCHEMES
): boolean {
	const key = normaliseUri(uri);
	if (key === undefined) return false;
	return schemes.includes(schemeOf(key));
}

/** the lower-case scheme of a normalised URI */
function schemeOf(key: string): string {
	return key.slice(0, key.indexOf('://')).toLowerCase();
}

/**
 * Queues one mirror operation unless the URI is not mirrorable; returns whether it queued.
 * The scheme is per-URI, so renaming `public://a` to `private://b` still deletes the old object.
 */
export function queueMirror(
	sql: FileSql,
	uri: string,
	op: 'put' | 'delete',
	nowMs: number,
	schemes: readonly string[] = MIRRORABLE_SCHEMES
): boolean {
	if (!isMirrorable(uri, schemes)) return false;
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
	opts: {
		mime?: string;
		nowMs: number;
		chunkSize?: number;
		schemes?: readonly string[];
	} = { nowMs: 0 }
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
		`INSERT INTO cfw_file (uri, size, modified, mime, chunks, mirrored, rev, touched, evicted, hash)
     VALUES (?, ?, ?, ?, ?, 0, 1, ?, 0, NULL)
     ON CONFLICT(uri) DO UPDATE SET
       size = excluded.size,
       modified = excluded.modified,
       mime = excluded.mime,
       chunks = excluded.chunks,
       mirrored = 0,
       rev = cfw_file.rev + 1,
       touched = excluded.touched,
       evicted = 0,
       hash = NULL`,
		key,
		bytes.length,
		opts.nowMs,
		opts.mime ?? null,
		chunks.length,
		opts.nowMs
	);
	// `mirrored` reset above, so requeue or R2 keeps serving the previous bytes forever
	queueMirror(sql, key, 'put', opts.nowMs, opts.schemes);
	return { uri: key, size: bytes.length, chunks: chunks.length };
}

/** the file's metadata, or undefined when it is not stored */
export function statFile(sql: FileSql, uri: string): FileStat | undefined {
	const key = normaliseUri(uri);
	if (key === undefined) return undefined;
	ensureFileTables(sql);
	const row = rows<FileRow>(sql, `SELECT ${FILE_COLUMNS} FROM cfw_file WHERE uri = ?`, key)[0];
	if (row === undefined) return undefined;
	return toStat(row);
}

/**
 * Reads a whole file (chunks ordered by `seq`), or undefined when it is not stored.
 * Throws {@link FileOffloadedError} for an evicted file: an empty answer would read as an empty file.
 */
export function getFile(sql: FileSql, uri: string): Uint8Array | undefined {
	const meta = statFile(sql, uri);
	if (meta === undefined) return undefined;
	if (meta.evicted) throw new FileOffloadedError(meta.uri);
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

/**
 * Reads one chunk; undefined for a missing file or a `seq` past the end.
 * Throws {@link FileOffloadedError} when the miss is an evicted file, checked only on a miss.
 */
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
	if (row === undefined) {
		if (statFile(sql, key)?.evicted) throw new FileOffloadedError(key);
		return undefined;
	}
	return row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes as ArrayBuffer);
}

/**
 * Deletes a file and queues its R2 copy for removal; reports whether anything was there.
 * An evicted file has no chunks, so the queued delete is the only thing that frees its bytes.
 */
export function deleteFile(
	sql: FileSql,
	uri: string,
	nowMs: number,
	schemes: readonly string[] = MIRRORABLE_SCHEMES
): boolean {
	const meta = statFile(sql, uri);
	if (meta === undefined) return false;
	sql.exec('DELETE FROM cfw_file_chunk WHERE uri = ?', meta.uri);
	sql.exec('DELETE FROM cfw_file WHERE uri = ?', meta.uri);
	// queued even when never mirrored: a mirror racing the delete would leave the object in R2
	queueMirror(sql, meta.uri, 'delete', nowMs, schemes);
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
					`SELECT ${FILE_COLUMNS} FROM cfw_file WHERE uri LIKE ? ESCAPE '\\' ORDER BY uri LIMIT ?`,
					pattern,
					capped
				)
			: // keep the `LIMIT` and range: unbounded, every `url_stat()` miss read all of `cfw_file`
				rows<FileRow>(
					sql,
					`SELECT ${FILE_COLUMNS} FROM cfw_file WHERE uri >= ? AND uri < ? ORDER BY uri LIMIT ?`,
					key,
					prefixCeiling(key),
					capped
				).filter((r) => String(r.uri).startsWith(key));
	return matched.map(toStat);
}

/**
 * Moves a file by re-keying its rows, so the bytes never cross the isolate.
 * Refuses to clobber unless `overwrite` is set; `file_move()` owns replace semantics.
 * Refuses an evicted source and queues its restore: R2 has no rename, and a re-keyed row would
 * point at an object that does not exist yet.
 */
export function renameFile(
	sql: FileSql,
	from: string,
	to: string,
	nowMs: number,
	opts: { overwrite?: boolean; schemes?: readonly string[] } = {}
): boolean {
	const src = normaliseUri(from);
	const dst = normaliseUri(to);
	if (src === undefined || dst === undefined) return false;
	if (src === dst) return true;
	const meta = statFile(sql, src);
	if (meta === undefined) return false;
	if (meta.evicted) {
		queueHydrate(sql, src, nowMs);
		return false;
	}
	if (statFile(sql, dst) !== undefined) {
		if (!opts.overwrite) return false;
		deleteFile(sql, dst, nowMs, opts.schemes);
	}
	sql.exec('UPDATE cfw_file_chunk SET uri = ? WHERE uri = ?', dst, src);
	sql.exec(
		'UPDATE cfw_file SET uri = ?, modified = ?, mirrored = 0, rev = rev + 1, touched = ?, hash = NULL WHERE uri = ?',
		dst,
		nowMs,
		nowMs,
		src
	);
	sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', src);
	queueMirror(sql, dst, 'put', nowMs, opts.schemes);
	// the old key is a separate queue row; a rename out of `public://` still needs this delete
	queueMirror(sql, src, 'delete', nowMs, opts.schemes);
	return true;
}

/** one queued R2 operation and how many times it has failed */
export type MirrorTask = { uri: string; op: 'put' | 'delete' | 'hydrate'; attempts: number };

/**
 * The next queued operations, oldest first; `ops` narrows them, because the write drain and the
 * restore drain run under different budgets.
 */
export function pendingMirrors(
	sql: FileSql,
	limit = 10,
	ops?: readonly MirrorTask['op'][]
): MirrorTask[] {
	ensureFileTables(sql);
	const filter = ops === undefined ? '' : `WHERE op IN (${ops.map(() => '?').join(', ')}) `;
	return rows<{ uri: string; op: string; attempts: number }>(
		sql,
		`SELECT uri, op, attempts FROM cfw_file_mirror_queue ${filter}ORDER BY queued_at LIMIT ?`,
		...(ops ?? []),
		Math.max(1, Math.floor(limit))
	).map((row) => ({
		uri: String(row.uri),
		op: row.op === 'delete' ? 'delete' : row.op === 'hydrate' ? 'hydrate' : 'put',
		attempts: Number(row.attempts)
	}));
}

/**
 * Queues the restore of an evicted file into the object; there is no scheme check, because a
 * restore moves bytes toward the object and leaks nothing. A queued put or delete for the same
 * URI is replaced, and neither can exist for an evicted row.
 */
export function queueHydrate(sql: FileSql, uri: string, nowMs: number): void {
	sql.exec(
		`INSERT INTO cfw_file_mirror_queue (uri, op, queued_at, attempts)
     VALUES (?, 'hydrate', ?, 0)
     ON CONFLICT(uri) DO UPDATE SET op = 'hydrate', queued_at = excluded.queued_at, attempts = 0`,
		uri,
		nowMs
	);
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

/** the slice of an R2 object a restore or a Worker-side read needs */
export type StoredObject = {
	size: number;
	body: ReadableStream | null;
	arrayBuffer(): Promise<ArrayBuffer>;
};

/** a bucket that can also be read, which `FILE_STORE=r2` needs once bytes leave the object */
export type FileBucket = MirrorBucket & { get(key: string): Promise<StoredObject | null> };

/** the two buckets a file can live in; `private` has no custom domain */
export type FileBuckets = { public?: FileBucket; private?: FileBucket };

/** what one drain pass did, in the terms the meters care about */
export type MirrorDrain = {
	/** operations that reached the bucket and succeeded */
	mirrored: number;
	/** puts that reached R2 but were replaced in the object meanwhile; the new bytes stay queued */
	superseded: number;
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
	opts: {
		limit?: number;
		site?: string;
		/** takes `private://` files; leave unset and they are refused as before */
		privateBucket?: MirrorBucket;
		/** send a sha256 for R2 to check, confirm the stored size, and record the hash */
		verify?: boolean;
	} = {}
): Promise<MirrorDrain> {
	const out: MirrorDrain = {
		mirrored: 0,
		superseded: 0,
		deleted: 0,
		failed: 0,
		droppedAfterStrikes: 0,
		refused: 0
	};
	// no bucket is the free-tier default, not an error (reported so "not configured" is visible)
	if (!bucket) return { ...out, noBucket: true };
	const schemes = opts.privateBucket ? OFFLOAD_SCHEMES : MIRRORABLE_SCHEMES;

	for (const task of pendingMirrors(sql, opts.limit ?? 10, ['put', 'delete'])) {
		const key = mirrorKey(task.uri, opts.site ?? 'site');
		if (key === undefined || !isMirrorable(task.uri, schemes)) {
			// dropped: it can never become sendable and would starve real work
			sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', task.uri);
			out.refused += 1;
			continue;
		}
		const target =
			schemeOf(normaliseUri(task.uri) ?? '') === 'private' ? opts.privateBucket! : bucket;
		try {
			if (task.op === 'delete') {
				await target.delete(key);
				// the file row is gone, so clearing the queue row is all the bookkeeping
				sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', task.uri);
				out.deleted += 1;
				continue;
			}
			const meta = statFile(sql, task.uri);
			if (meta === undefined || meta.evicted) {
				// deleted between enqueue and drain; the delete is queued separately
				sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', task.uri);
				continue;
			}
			const bytes = getFile(sql, task.uri);
			if (bytes === undefined) {
				sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', task.uri);
				continue;
			}
			const hash = opts.verify ? await sha256Hex(bytes) : undefined;
			const stored = await target.put(key, bytes, {
				httpMetadata: meta.mime ? { contentType: meta.mime } : undefined,
				...(hash === undefined ? {} : { sha256: hash })
			});
			if (hash !== undefined) {
				const size = (stored as { size?: number } | null)?.size;
				if (size !== bytes.length)
					throw new Error(`r2 stored ${size} of ${bytes.length} bytes`);
			}
			if (settleMirror(sql, task.uri, meta.rev, hash)) out.mirrored += 1;
			else out.superseded += 1;
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

/** hex SHA-256, which R2 checks against what it received when a put carries `sha256` */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
	return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Records a landed put, but only if the file still holds the bytes that were sent.
 * The put is awaited and other requests run meanwhile; a rewrite bumps `rev` and re-queues, so
 * marking the new bytes mirrored here would hide them from the drain (and, under `FILE_STORE=r2`,
 * evict a file whose R2 copy is stale).
 */
function settleMirror(sql: FileSql, uri: string, rev: number, hash: string | undefined): boolean {
	const key = normaliseUri(uri) ?? uri;
	if (statFile(sql, key)?.rev !== rev) return false;
	sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', key);
	sql.exec('UPDATE cfw_file SET mirrored = 1, hash = ? WHERE uri = ?', hash ?? null, key);
	return true;
}

/** R2 operations a drain pass spent; a superseded put still reached the bucket */
export function r2OpsSpent(drained: MirrorDrain): number {
	return (
		drained.mirrored +
		drained.superseded +
		drained.deleted +
		drained.failed +
		drained.droppedAfterStrikes
	);
}

/**
 * Evicts files whose put was verified and that have not been written or restored for `graceMs`,
 * deleting their chunks so R2 holds the only copy. Runs no R2 call, so a spent write budget cannot
 * stop it. The grace window keeps a file in the object while Drupal is still reading it back (the
 * next request of an upload form), because PHP cannot wait for R2.
 */
export function evictMirrored(
	sql: FileSql,
	opts: { nowMs: number; graceMs: number; limit: number; schemes: readonly string[] }
): { evicted: number; bytes: number } {
	ensureFileTables(sql);
	let evicted = 0;
	let bytes = 0;
	const due = rows<{ uri: string; rev: number; size: number }>(
		sql,
		`SELECT uri, rev, size FROM cfw_file
     WHERE mirrored = 1 AND evicted = 0 AND hash IS NOT NULL AND touched <= ?
     ORDER BY touched LIMIT ?`,
		opts.nowMs - opts.graceMs,
		Math.max(1, Math.floor(opts.limit))
	);
	for (const row of due) {
		const uri = String(row.uri);
		if (!isMirrorable(uri, opts.schemes)) continue;
		// no await since the select, so `rev` cannot have moved
		sql.exec('DELETE FROM cfw_file_chunk WHERE uri = ?', uri);
		sql.exec('UPDATE cfw_file SET evicted = 1 WHERE uri = ? AND rev = ?', uri, Number(row.rev));
		evicted += 1;
		bytes += Number(row.size);
	}
	return { evicted, bytes };
}

/** when the earliest verified, still-resident file becomes evictable, or undefined when none is */
export function nextEvictionAt(sql: FileSql, graceMs: number): number | undefined {
	ensureFileTables(sql);
	const row = rows<{ t: number | null }>(
		sql,
		'SELECT MIN(touched) AS t FROM cfw_file WHERE mirrored = 1 AND evicted = 0 AND hash IS NOT NULL'
	)[0];
	return row?.t === null || row?.t === undefined ? undefined : Number(row.t) + graceMs;
}

/** the bucket a URI's scheme maps to, or undefined when that one is not bound */
function bucketFor(buckets: FileBuckets, uri: string): FileBucket | undefined {
	return schemeOf(normaliseUri(uri) ?? '') === 'private' ? buckets.private : buckets.public;
}

/**
 * Opens an evicted file's R2 object and checks its size against the row.
 * Throws when the bucket is not bound (a site moved back to a config without it) or the object is
 * missing; both are real faults, and an empty answer would read as an empty file.
 */
export async function fetchOffloaded(
	buckets: FileBuckets,
	meta: FileStat,
	site = 'site'
): Promise<StoredObject> {
	const bucket = bucketFor(buckets, meta.uri);
	if (!bucket) throw new Error(`${meta.uri} is offloaded and its R2 bucket is not bound`);
	const key = mirrorKey(meta.uri, site) as string;
	const object = await bucket.get(key);
	if (object === null) throw new Error(`${meta.uri} is missing from R2 (${key})`);
	if (object.size !== meta.size) {
		throw new Error(`${meta.uri} is ${object.size} bytes in R2, expected ${meta.size}`);
	}
	return object;
}

/** reads a whole file from the object, or from R2 when it was evicted; undefined when not stored */
export async function readFile(
	sql: FileSql,
	buckets: FileBuckets,
	uri: string,
	site = 'site'
): Promise<Uint8Array | undefined> {
	const meta = statFile(sql, uri);
	if (meta === undefined) return undefined;
	if (!meta.evicted) return getFile(sql, uri);
	return new Uint8Array(await (await fetchOffloaded(buckets, meta, site)).arrayBuffer());
}

/**
 * Restores one evicted file into the object; false when it was not evicted or changed meanwhile.
 * The chunks are written after the await with no gap, so a concurrent write cannot interleave.
 */
export async function hydrateFile(
	sql: FileSql,
	buckets: FileBuckets,
	uri: string,
	opts: { nowMs: number; site?: string }
): Promise<boolean> {
	const meta = statFile(sql, uri);
	if (meta === undefined || !meta.evicted) return false;
	const bytes = new Uint8Array(
		await (await fetchOffloaded(buckets, meta, opts.site)).arrayBuffer()
	);
	if (statFile(sql, uri)?.rev !== meta.rev) return false;
	sql.exec('DELETE FROM cfw_file_chunk WHERE uri = ?', meta.uri);
	const chunks = chunkBytes(bytes);
	for (const [seq, chunk] of chunks.entries()) {
		sql.exec(
			'INSERT INTO cfw_file_chunk (uri, seq, bytes) VALUES (?, ?, ?)',
			meta.uri,
			seq,
			chunk
		);
	}
	// `touched` restarts the grace window, so a restored file is not evicted before it is read
	sql.exec(
		'UPDATE cfw_file SET evicted = 0, touched = ?, chunks = ? WHERE uri = ? AND rev = ?',
		opts.nowMs,
		chunks.length,
		meta.uri,
		meta.rev
	);
	return true;
}

/** what one restore pass did */
export type HydrateDrain = { hydrated: number; failed: number; droppedAfterStrikes: number };

/**
 * Restores queued files from R2. R2 reads are Class B operations and do not spend the write
 * budget, so this runs when that budget is spent.
 */
export async function drainHydrates(
	sql: FileSql,
	buckets: FileBuckets,
	opts: { limit?: number; site?: string; nowMs: number }
): Promise<HydrateDrain> {
	const out: HydrateDrain = { hydrated: 0, failed: 0, droppedAfterStrikes: 0 };
	for (const task of pendingMirrors(sql, opts.limit ?? 10, ['hydrate'])) {
		try {
			const restored = await hydrateFile(sql, buckets, task.uri, opts);
			sql.exec('DELETE FROM cfw_file_mirror_queue WHERE uri = ?', task.uri);
			if (restored) out.hydrated += 1;
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

/**
 * Queues a verified put for every file the object still holds unmirrored or unverified, so a site
 * that moves onto `FILE_STORE=r2` offloads what it already stored. Enqueues only; the drain does
 * the work under its own limits. Returns how many files it queued.
 */
export function queueBackfill(sql: FileSql, nowMs: number, schemes: readonly string[]): number {
	ensureFileTables(sql);
	let queued = 0;
	for (const scheme of schemes) {
		const prefix = `${scheme}://`;
		const count = rows<{ n: number }>(
			sql,
			'SELECT COUNT(*) AS n FROM cfw_file WHERE evicted = 0 AND hash IS NULL AND uri >= ? AND uri < ?',
			prefix,
			prefixCeiling(prefix)
		)[0];
		sql.exec(
			`INSERT INTO cfw_file_mirror_queue (uri, op, queued_at, attempts)
       SELECT uri, 'put', ?, 0 FROM cfw_file
       WHERE evicted = 0 AND hash IS NULL AND uri >= ? AND uri < ?
       ON CONFLICT(uri) DO NOTHING`,
			nowMs,
			prefix,
			prefixCeiling(prefix)
		);
		queued += Number(count?.n ?? 0);
	}
	return queued;
}

/**
 * Queues a restore for every evicted file, so a site can be moved to a config without the bucket.
 * Returns how many it queued; `storedBytes().offloaded.files` reaching 0 says the move is safe.
 */
export function queueRehydrateAll(sql: FileSql, nowMs: number): number {
	ensureFileTables(sql);
	const count = rows<{ n: number }>(
		sql,
		'SELECT COUNT(*) AS n FROM cfw_file WHERE evicted = 1'
	)[0];
	sql.exec(
		`INSERT INTO cfw_file_mirror_queue (uri, op, queued_at, attempts)
     SELECT uri, 'hydrate', ?, 0 FROM cfw_file WHERE evicted = 1
     ON CONFLICT(uri) DO UPDATE SET op = 'hydrate', queued_at = excluded.queued_at, attempts = 0`,
		nowMs
	);
	return Number(count?.n ?? 0);
}

/**
 * The `private://` URI a visitor path names, or undefined; Drupal serves private files at
 * `/system/files/<path>`, and the object restores an evicted one before PHP reads it.
 */
export function privateUriForPath(path: string): string | undefined {
	const prefix = '/system/files/';
	const clean = path.split('?')[0] ?? '';
	if (!clean.startsWith(prefix)) return undefined;
	try {
		return normaliseUri(`private://${decodeURIComponent(clean.slice(prefix.length))}`);
	} catch {
		return undefined;
	}
}

/**
 * File count and total bytes stored, for a quota reading.
 * `bytes` is every byte the site owns, wherever it sits; `offloaded` is the part held only in R2,
 * which is what the object's 5 GB figure no longer carries.
 */
export function storedBytes(sql: FileSql): {
	files: number;
	bytes: number;
	offloaded: { files: number; bytes: number };
} {
	ensureFileTables(sql);
	const row = rows<{ n: number; b: number | null; oc: number | null; ob: number | null }>(
		sql,
		`SELECT COUNT(*) AS n, SUM(size) AS b, SUM(evicted) AS oc,
       SUM(CASE WHEN evicted = 1 THEN size ELSE 0 END) AS ob
     FROM cfw_file`
	)[0];
	return {
		files: Number(row?.n ?? 0),
		bytes: Number(row?.b ?? 0),
		offloaded: { files: Number(row?.oc ?? 0), bytes: Number(row?.ob ?? 0) }
	};
}
