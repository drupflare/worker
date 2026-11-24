/**
 * Uploaded module revisions: content-addressed blobs plus an immutable manifest per revision.
 *
 * Content-addressed because rows written is the meter: a blob already held costs zero rows, so an
 * upload charges one revision row plus the changed blobs. Nothing here touches the mounted tree;
 * the object applies a revision through the same path as a git pull.
 *
 * @module
 */
import { bytesToHex } from '../../util/hex';
import type { SelectedFile } from '../git/sync.js';
import { type BlobEncoding, blobBytes, bytesToSource } from './bytes';

/** the reads and writes this module needs, narrowed so it stays drivable over a fake */
export interface RevSql {
	exec(sql: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** how a revision's files arrived */
export type RevKind = 'upload' | 'git' | 'composer';

/** one stored revision as listed; `bytes` is always 0 here (see {@link revisionStatus}) */
export interface Revision {
	/** row id */
	id: number;
	/** package machine name */
	package: string;
	/** manifest hash */
	rev: string;
	/** how the files arrived */
	kind: RevKind;
	/** client-supplied label */
	label: string;
	/** client-supplied origin */
	origin: string;
	/** ms since epoch */
	createdAt: number;
	/** whether this revision is mounted */
	active: boolean;
	/** file count in the manifest */
	files: number;
	/** unset here; 0 */
	bytes: number;
}

/** one file as a client declares it, before its bytes have been sent */
export interface DeclaredFile {
	path: string;
	hash: string;
	bytes: number;
}

/** a file's bytes, with the hash the client claims for them */
export interface Blob {
	hash: string;
	/** the file's text, or its base64 when `encoding` says so */
	source: string;
	/** how `source` is written; text when absent. The hash covers the decoded bytes either way */
	encoding?: BlobEncoding;
}

/**
 * How many revisions of one package survive a commit; bounds the blob store on a site nobody
 * prunes.
 */
export const REVISION_RETENTION = 5;

/** a hash the client sent, checked before it is used as a key or interpolated anywhere */
const HEX64 = /^[0-9a-f]{64}$/;

/** whether a value is a lowercase sha256 hex string */
export function isRevHash(value: unknown): value is string {
	return typeof value === 'string' && HEX64.test(value);
}

/** sha256 of one file's bytes, which is the blob's identity and the only thing that names it */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
	return bytesToHex(await crypto.subtle.digest('SHA-256', bytes));
}

/** sha256 of a text file's UTF-8 bytes */
export async function hashSource(source: string): Promise<string> {
	return hashBytes(new TextEncoder().encode(source));
}

/**
 * The revision's identity: sha256 over the manifest sorted by path, so the same file set is the
 * same revision whatever order the client walked it in.
 */
export async function hashManifest(manifest: Record<string, string>): Promise<string> {
	const canonical = Object.keys(manifest)
		.sort()
		.map((path) => `${path}\0${manifest[path]}`)
		.join('\n');
	return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
}

/** creates the blob and revision tables when missing */
export function ensureRevTables(sql: RevSql): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_module_blob (
       hash TEXT PRIMARY KEY,
       source TEXT NOT NULL,
       bytes INTEGER NOT NULL
     )`
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_module_rev (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       package TEXT NOT NULL,
       rev TEXT NOT NULL,
       kind TEXT NOT NULL,
       label TEXT NOT NULL,
       origin TEXT NOT NULL,
       manifest TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       active INTEGER NOT NULL
     )`
	);
	sql.exec('CREATE INDEX IF NOT EXISTS cfw_module_rev_pkg ON cfw_module_rev (package, id)');
}

/** what a client already has on the site against what it still has to send */
export interface BlobPlan {
	have: string[];
	want: string[];
	/** bytes the client still has to upload, from what it declared */
	wantBytes: number;
}

/**
 * The have/want split for a declared upload. An unparseable hash is reported as wanted, so it
 * fails at {@link storeBlobs} where the bytes are verified rather than reading as present.
 */
export function planBlobs(sql: RevSql, declared: readonly DeclaredFile[]): BlobPlan {
	const wanted = new Map<string, number>();
	for (const file of declared) {
		if (!isRevHash(file.hash)) continue;
		wanted.set(file.hash, Math.max(0, Number(file.bytes) || 0));
	}
	const have: string[] = [];
	for (const hash of wanted.keys()) {
		const row = sql
			.exec('SELECT hash FROM cfw_module_blob WHERE hash = ?', hash)
			.toArray()
			.at(0);
		if (row) have.push(hash);
	}
	const held = new Set(have);
	const want = [...wanted.keys()].filter((hash) => !held.has(hash));
	// a hash that did not parse is neither held nor wanted by hash, so it is counted as wanted here
	const unparseable = declared.filter((file) => !isRevHash(file.hash)).map((file) => file.hash);
	return {
		have,
		want: [...want, ...unparseable],
		wantBytes: want.reduce((n, hash) => n + (wanted.get(hash) ?? 0), 0)
	};
}

/** what a declared upload would change, counted over every declared file */
export interface DeclaredPlan {
	counts: { added: number; modified: number; removed: number; unchanged: number };
	/** rows the apply would charge: one per write plus one per delete, as `planSync` counts them */
	rowsWritten: number;
	/** paths the site would stop carrying */
	removed: string[];
	/** stored files the commit does not name and keeps; 0 unless the commit keeps */
	kept: number;
}

/** how a commit treats the stored files it does not name */
export interface KeepOptions {
	/** stored files the commit does not name stay */
	keep?: boolean;
	/** with `keep`, stored paths to delete */
	remove?: readonly string[];
}

/**
 * The change counts for a declared file set, before any bytes have been sent. Not `planSync()`,
 * which compares sources and would call a file with no uploaded blob removed. A blob the site does
 * not hold is new bytes, so only a held blob can be `unchanged`.
 */
export function planDeclared(
	sql: RevSql,
	stored: ReadonlyMap<string, string>,
	declared: readonly DeclaredFile[],
	options: KeepOptions = {},
	executed?: (files: { path: string; source: string }[]) => { path: string; source: string }[]
): DeclaredPlan {
	const counts = { added: 0, modified: 0, removed: 0, unchanged: 0 };
	const seen = new Set<string>();
	let writes = 0;
	const held: { path: string; source: string }[] = [];
	for (const file of declared) {
		if (typeof file?.path !== 'string' || file.path === '') continue;
		seen.add(file.path);
		if (!stored.has(file.path)) {
			counts.added++;
			writes++;
			continue;
		}
		const blob = isRevHash(file.hash)
			? sql
					.exec('SELECT source FROM cfw_module_blob WHERE hash = ?', file.hash)
					.toArray()
					.at(0)
			: undefined;
		if (blob === undefined) {
			counts.modified++;
			writes++;
		} else {
			held.push({ path: file.path, source: String(blob['source']) });
		}
	}
	// a held blob is the client's bytes; the stored row is what the delivery pipeline made of them
	for (const file of executed ? executed(held) : held) {
		if (file.source === stored.get(file.path)) {
			counts.unchanged++;
		} else {
			counts.modified++;
			writes++;
		}
	}
	const removed: string[] = [];
	const doomed = new Set(options.keep === true ? (options.remove ?? []) : []);
	let kept = 0;
	for (const path of stored.keys()) {
		if (seen.has(path)) continue;
		if (options.keep === true && !doomed.has(path)) {
			kept++;
			continue;
		}
		counts.removed++;
		removed.push(path);
	}
	return { counts, rowsWritten: writes + removed.length, removed, kept };
}

/** the manifest a commit produces and what it carried over, or the reason it cannot */
export type CommitManifest =
	| { ok: true; manifest: Record<string, string>; kept: number; removed: string[] }
	| { ok: false; error: string };

/**
 * The manifest of a commit that may keep the active revision's files.
 *
 * Without `keep` the named files are the whole package. With it, the files the commit names
 * replace their paths in `prior` and every other path stays, less the paths in `remove`. A path
 * both named and removed is refused rather than guessed at, and so is a result with no files,
 * which would unmount the package.
 */
export function commitManifest(
	named: Readonly<Record<string, string>>,
	prior: Readonly<Record<string, string>>,
	options: KeepOptions
): CommitManifest {
	const remove = options.remove ?? [];
	if (options.keep !== true) {
		return remove.length > 0
			? { ok: false, error: 'remove needs keep to be true' }
			: { ok: true, manifest: { ...named }, kept: 0, removed: [] };
	}
	const clash = remove.find((path) => Object.hasOwn(named, path));
	if (clash !== undefined) {
		return { ok: false, error: `${clash} is both named and removed` };
	}
	const manifest: Record<string, string> = { ...prior, ...named };
	const removed: string[] = [];
	for (const path of remove) {
		if (!Object.hasOwn(manifest, path)) continue;
		delete manifest[path];
		removed.push(path);
	}
	const kept = Object.keys(prior).filter(
		(path) => !Object.hasOwn(named, path) && Object.hasOwn(manifest, path)
	).length;
	if (Object.keys(manifest).length === 0) {
		return { ok: false, error: 'a revision with no files would unmount the package' };
	}
	return { ok: true, manifest, kept, removed };
}

/** what {@link storeBlobs} stored, skipped as already held, and rejected */
export interface BlobStoreResult {
	stored: number;
	skipped: number;
	bytes: number;
	/** blobs whose bytes did not hash to the hash they were sent under */
	rejected: string[];
}

/**
 * Stores blobs, verifying each against its claimed hash. A security property: chosen bytes under
 * a chosen hash would otherwise reach a later `activate`.
 */
export async function storeBlobs(
	sql: RevSql,
	blobs: readonly Blob[],
	txn: (fn: () => void) => void
): Promise<BlobStoreResult> {
	const verified: { hash: string; source: string; bytes: number }[] = [];
	const rejected: string[] = [];
	let skipped = 0;
	for (const blob of blobs) {
		const bytes = isRevHash(blob?.hash) ? blobBytes(blob.source, blob.encoding) : undefined;
		if (bytes === undefined) {
			rejected.push(String(blob?.hash ?? ''));
			continue;
		}
		if ((await hashBytes(bytes)) !== blob.hash) {
			rejected.push(blob.hash);
			continue;
		}
		const held = sql
			.exec('SELECT hash FROM cfw_module_blob WHERE hash = ?', blob.hash)
			.toArray()
			.at(0);
		if (held) {
			skipped++;
			continue;
		}
		verified.push({ hash: blob.hash, source: bytesToSource(bytes), bytes: bytes.length });
	}
	// one transaction: a partly stored batch would leave a manifest naming a blob that is not there
	txn(() => {
		for (const blob of verified) {
			sql.exec(
				'INSERT OR IGNORE INTO cfw_module_blob (hash, source, bytes) VALUES (?, ?, ?)',
				blob.hash,
				blob.source,
				blob.bytes
			);
		}
	});
	return {
		stored: verified.length,
		skipped,
		bytes: verified.reduce((n, blob) => n + blob.bytes, 0),
		rejected
	};
}

/** every blob a manifest names, in path order, or null when one of them is missing */
export function materialise(
	sql: RevSql,
	manifest: Record<string, string>
): { files: SelectedFile[]; missing: string[] } {
	const files: SelectedFile[] = [];
	const missing: string[] = [];
	for (const path of Object.keys(manifest).sort()) {
		const hash = manifest[path] as string;
		const row = sql
			.exec('SELECT source, bytes FROM cfw_module_blob WHERE hash = ?', hash)
			.toArray()
			.at(0);
		if (!row) {
			missing.push(path);
			continue;
		}
		files.push({ path, source: String(row.source), bytes: Number(row.bytes) });
	}
	return { files, missing };
}

function readRow(row: Record<string, unknown>): Revision {
	const manifest = parseManifest(String(row['manifest'] ?? '{}'));
	return {
		id: Number(row['id']),
		package: String(row['package']),
		rev: String(row['rev']),
		kind: String(row['kind']) as RevKind,
		label: String(row['label'] ?? ''),
		origin: String(row['origin'] ?? ''),
		createdAt: Number(row['created_at'] ?? 0),
		active: Number(row['active'] ?? 0) === 1,
		files: Object.keys(manifest).length,
		bytes: 0
	};
}

/** a manifest that does not parse is an empty one, because a throw here loses the whole listing */
export function parseManifest(json: string): Record<string, string> {
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		const out: Record<string, string> = {};
		for (const [path, hash] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof hash === 'string') out[path] = hash;
		}
		return out;
	} catch {
		return {};
	}
}

/** a package's revisions, newest first, at most 200 */
export function listRevisions(sql: RevSql, pkg: string, limit = 20): Revision[] {
	const rows = sql
		.exec(
			`SELECT id, package, rev, kind, label, origin, manifest, created_at, active
         FROM cfw_module_rev WHERE package = ? ORDER BY id DESC LIMIT ?`,
			pkg,
			Math.max(1, Math.min(200, Math.trunc(limit) || 20))
		)
		.toArray();
	return rows.map(readRow);
}

/** the package's active revision, or null */
export function activeRevision(sql: RevSql, pkg: string): Revision | null {
	const row = sql
		.exec(
			`SELECT id, package, rev, kind, label, origin, manifest, created_at, active
         FROM cfw_module_rev WHERE package = ? AND active = 1 ORDER BY id DESC LIMIT 1`,
			pkg
		)
		.toArray()
		.at(0);
	return row ? readRow(row) : null;
}

/** the package's revision with this manifest hash, or null */
export function revisionByHash(sql: RevSql, pkg: string, rev: string): Revision | null {
	if (!isRevHash(rev)) return null;
	const row = sql
		.exec(
			`SELECT id, package, rev, kind, label, origin, manifest, created_at, active
         FROM cfw_module_rev WHERE package = ? AND rev = ? ORDER BY id DESC LIMIT 1`,
			pkg,
			rev
		)
		.toArray()
		.at(0);
	return row ? readRow(row) : null;
}

/** a revision's path-to-hash manifest by row id; empty when the row is gone */
export function manifestOf(sql: RevSql, id: number): Record<string, string> {
	const row = sql.exec('SELECT manifest FROM cfw_module_rev WHERE id = ?', id).toArray().at(0);
	return row ? parseManifest(String(row.manifest)) : {};
}

/**
 * The revision immediately before the active one, which is what a rollback means; null when there
 * is none, so the rollback refuses rather than reactivating the same revision.
 */
export function previousRevision(sql: RevSql, pkg: string): Revision | null {
	const active = activeRevision(sql, pkg);
	if (!active) return null;
	const row = sql
		.exec(
			`SELECT id, package, rev, kind, label, origin, manifest, created_at, active
         FROM cfw_module_rev WHERE package = ? AND id < ? ORDER BY id DESC LIMIT 1`,
			pkg,
			active.id
		)
		.toArray()
		.at(0);
	return row ? readRow(row) : null;
}

/** records a revision and makes it the active one; an identical manifest reuses its row */
export function recordRevision(
	sql: RevSql,
	entry: {
		package: string;
		rev: string;
		kind: RevKind;
		label: string;
		origin: string;
		manifest: Record<string, string>;
		nowMs: number;
	},
	txn: (fn: () => void) => void
): { id: number; reused: boolean } {
	const existing = revisionByHash(sql, entry.package, entry.rev);
	let id = existing?.id ?? 0;
	txn(() => {
		sql.exec('UPDATE cfw_module_rev SET active = 0 WHERE package = ?', entry.package);
		if (existing) {
			sql.exec('UPDATE cfw_module_rev SET active = 1 WHERE id = ?', existing.id);
			return;
		}
		sql.exec(
			`INSERT INTO cfw_module_rev
         (package, rev, kind, label, origin, manifest, created_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
			entry.package,
			entry.rev,
			entry.kind,
			entry.label,
			entry.origin,
			JSON.stringify(entry.manifest),
			entry.nowMs
		);
		id = Number(
			sql
				.exec(
					'SELECT id FROM cfw_module_rev WHERE package = ? ORDER BY id DESC LIMIT 1',
					entry.package
				)
				.toArray()
				.at(0)?.id ?? 0
		);
	});
	return { id, reused: existing !== null };
}

/** makes a stored revision active, or none with `null`, without writing a new row */
export function setActive(
	sql: RevSql,
	pkg: string,
	id: number | null,
	txn: (fn: () => void) => void
) {
	txn(() => {
		sql.exec('UPDATE cfw_module_rev SET active = 0 WHERE package = ?', pkg);
		if (id !== null) sql.exec('UPDATE cfw_module_rev SET active = 1 WHERE id = ?', id);
	});
}

/**
 * Deletes an inactive revision and the blobs no remaining manifest names (counted from the
 * manifests, not a stored counter). The active one is refused so the mounted tree keeps a record.
 */
export function dropRevision(
	sql: RevSql,
	pkg: string,
	rev: string,
	txn: (fn: () => void) => void
): { dropped: boolean; blobsFreed: number; reason?: string } {
	const target = revisionByHash(sql, pkg, rev);
	if (!target) return { dropped: false, blobsFreed: 0, reason: 'no such revision' };
	if (target.active) {
		return { dropped: false, blobsFreed: 0, reason: 'that revision is active' };
	}
	return dropById(sql, target.id, txn);
}

function dropById(
	sql: RevSql,
	id: number,
	txn: (fn: () => void) => void
): { dropped: boolean; blobsFreed: number } {
	const doomed = new Set(Object.values(manifestOf(sql, id)));
	const survivors = sql.exec('SELECT manifest FROM cfw_module_rev WHERE id != ?', id).toArray();
	for (const row of survivors) {
		for (const hash of Object.values(parseManifest(String(row.manifest)))) doomed.delete(hash);
	}
	let blobsFreed = 0;
	txn(() => {
		sql.exec('DELETE FROM cfw_module_rev WHERE id = ?', id);
		for (const hash of doomed) {
			sql.exec('DELETE FROM cfw_module_blob WHERE hash = ?', hash);
			blobsFreed++;
		}
	});
	return { dropped: true, blobsFreed };
}

/** drops everything past the retention window, newest kept; the active revision is never dropped */
export function retain(
	sql: RevSql,
	pkg: string,
	keep = REVISION_RETENTION,
	txn: (fn: () => void) => void = (fn) => fn()
): { dropped: number; blobsFreed: number } {
	const rows = sql
		.exec('SELECT id, active FROM cfw_module_rev WHERE package = ? ORDER BY id DESC', pkg)
		.toArray();
	let dropped = 0;
	let blobsFreed = 0;
	for (const [index, row] of rows.entries()) {
		if (index < Math.max(1, keep)) continue;
		if (Number(row.active) === 1) continue;
		const result = dropById(sql, Number(row.id), txn);
		if (result.dropped) {
			dropped++;
			blobsFreed += result.blobsFreed;
		}
	}
	return { dropped, blobsFreed };
}

/** what `status` reports per package: what is live, how big, and when it landed */
export function revisionStatus(sql: RevSql, pkg?: string) {
	const packages = pkg
		? [pkg]
		: sql
				.exec('SELECT DISTINCT package FROM cfw_module_rev ORDER BY package')
				.toArray()
				.map((row) => String(row.package));
	return packages.map((name) => {
		const active = activeRevision(sql, name);
		const manifest = active ? manifestOf(sql, active.id) : {};
		const bytes = Object.values(manifest).reduce((total, hash) => {
			const row = sql
				.exec('SELECT bytes FROM cfw_module_blob WHERE hash = ?', hash)
				.toArray()
				.at(0);
			return total + Number(row?.bytes ?? 0);
		}, 0);
		return {
			package: name,
			rev: active?.rev ?? null,
			kind: active?.kind ?? null,
			label: active?.label ?? null,
			origin: active?.origin ?? null,
			files: Object.keys(manifest).length,
			bytes,
			at: active?.createdAt ?? null,
			revisions: listRevisions(sql, name, 200).length
		};
	});
}
