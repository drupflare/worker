/**
 * A restore sent in parts, for a dump above the single-body ceiling.
 *
 * The client declares the dump (size, part count, sha256), sends statement-aligned parts in any
 * order, and commits. A part is verified and parsed when it arrives and stored whole in one row;
 * a commit verifies the whole digest, then writes the replay chunks `storeImport()` would have
 * written, a few parts per call, so no call holds more than one part of the dump.
 * @module
 */
import { createHash } from 'node:crypto';
import { RESTORE_PART_MAX_BYTES } from '../ops/body-limit';
import { firstRow } from '../util/sql';
import { DO_SQLITE_MAX_STATEMENT_CHARS } from './heap-store';
import {
	IMPORT_STATEMENTS_PER_CHUNK,
	ensureImportTables,
	isIdentityMetaStatement,
	splitSqlStatementsStrict,
	type StoredImport
} from './import-sql';
import type { SqlLike, StorageLike } from './migrate-sql';

/** how long an upload is kept after the last call that changed it */
export const RESTORE_UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;

/** the most parts one upload may declare, which bounds the status reply */
export const RESTORE_MAX_PARTS = 8192;

/** the raw bytes one commit call assembles; at least one part is always taken */
export const ASSEMBLE_BYTES_PER_CALL = 16 * 1024 * 1024;

/** the DDL for the staging tables, which a dump never carries (`RESTORE_OWNED_TABLES`) */
export const RESTORE_PARTS_DDL = [
	`CREATE TABLE IF NOT EXISTS cfw_restore_upload (
	id TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	generation TEXT NOT NULL,
	total_bytes INTEGER NOT NULL,
	total_parts INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	state TEXT NOT NULL,
	assemble_part INTEGER NOT NULL DEFAULT 0,
	import_id INTEGER,
	next_seq INTEGER NOT NULL DEFAULT 0,
	statements INTEGER NOT NULL DEFAULT 0
)`,
	`CREATE TABLE IF NOT EXISTS cfw_restore_part (
	upload_id TEXT NOT NULL,
	part INTEGER NOT NULL,
	bytes INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	body BLOB NOT NULL,
	PRIMARY KEY (upload_id, part)
)`
];

/** creates the staging tables when absent */
export function ensureRestoreTables(sql: SqlLike): void {
	for (const ddl of RESTORE_PARTS_DDL) sql.exec(ddl);
}

/** why a paged restore call was refused, and the HTTP status that says so */
export class RestorePartsError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
		readonly extra: Record<string, unknown> = {}
	) {
		super(message);
		this.name = 'RestorePartsError';
	}
}

/** where an upload stands, as the routes report it */
export type UploadStatus = {
	id: string;
	state: 'open' | 'verified' | 'assembling';
	generation: string;
	bytes: number;
	parts: number;
	sha256: string;
	receivedParts: number[];
	bytesReceived: number;
	assembledParts: number;
	expiresAt: number;
};

/** what one commit call did */
export type CommitResult =
	| { done: false; state: 'verified' | 'assembling'; assembledParts: number; parts: number }
	| { done: true; import: StoredImport };

type UploadRow = {
	id: string;
	created_at: number;
	expires_at: number;
	generation: string;
	total_bytes: number;
	total_parts: number;
	sha256: string;
	state: 'open' | 'verified' | 'assembling';
	assemble_part: number;
	import_id: number | null;
	next_seq: number;
	statements: number;
};

/** the dump ceiling for a paged restore, from `MAX_RESTORE_PAGED_BYTES` or the default */
export function pagedCeiling(value: unknown, fallback: number): number {
	const raw = Number(value ?? fallback);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** hex SHA-256 of bytes */
export function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/i;

function toBytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	return new Uint8Array(0);
}

function loadUpload(sql: SqlLike, id: string): UploadRow | undefined {
	return firstRow(sql.exec('SELECT * FROM cfw_restore_upload WHERE id = ?', id)) as
		UploadRow | undefined;
}

/** the upload an id names; an expired one is purged and refused as gone */
function requireUpload(sql: SqlLike, storage: StorageLike, id: string, nowMs: number): UploadRow {
	ensureRestoreTables(sql);
	ensureImportTables(sql);
	const row = loadUpload(sql, id);
	if (row === undefined) {
		throw new RestorePartsError('unknown_upload', 404, 'no upload with that id');
	}
	if (Number(row.expires_at) <= nowMs) {
		purgeUpload(sql, storage, id);
		throw new RestorePartsError('expired', 410, 'the upload expired and was removed');
	}
	return row;
}

/** removes an upload with its parts and any replay chunks it had started */
export function purgeUpload(sql: SqlLike, storage: StorageLike, id: string): boolean {
	ensureRestoreTables(sql);
	ensureImportTables(sql);
	return storage.transactionSync(() => {
		const row = loadUpload(sql, id);
		if (row === undefined) return false;
		if (row.import_id !== null && row.import_id !== undefined) {
			sql.exec('DELETE FROM cfw_import_chunk WHERE import_id = ?', Number(row.import_id));
			sql.exec('DELETE FROM cfw_import WHERE id = ?', Number(row.import_id));
		}
		sql.exec('DELETE FROM cfw_restore_part WHERE upload_id = ?', id);
		sql.exec('DELETE FROM cfw_restore_upload WHERE id = ?', id);
		return true;
	});
}

/** removes every upload past its expiry; returns how many went */
export function purgeExpiredUploads(sql: SqlLike, storage: StorageLike, nowMs: number): number {
	ensureRestoreTables(sql);
	const due = sql
		.exec('SELECT id FROM cfw_restore_upload WHERE expires_at <= ?', nowMs)
		.toArray() as { id: string }[];
	let purged = 0;
	for (const { id } of due) if (purgeUpload(sql, storage, String(id))) purged += 1;
	return purged;
}

/** the status of an upload, or of the one open upload when `id` is omitted; undefined when none */
export function uploadStatus(
	sql: SqlLike,
	storage: StorageLike,
	nowMs: number,
	id?: string
): UploadStatus | undefined {
	ensureRestoreTables(sql);
	purgeExpiredUploads(sql, storage, nowMs);
	const row =
		id === undefined
			? (firstRow(
					sql.exec('SELECT * FROM cfw_restore_upload ORDER BY created_at LIMIT 1')
				) as UploadRow | undefined)
			: loadUpload(sql, id);
	if (row === undefined) {
		if (id !== undefined) {
			throw new RestorePartsError('unknown_upload', 404, 'no upload with that id');
		}
		return undefined;
	}
	const parts = sql
		.exec('SELECT part, bytes FROM cfw_restore_part WHERE upload_id = ? ORDER BY part', row.id)
		.toArray() as { part: number; bytes: number }[];
	return {
		id: String(row.id),
		state: row.state,
		generation: String(row.generation),
		bytes: Number(row.total_bytes),
		parts: Number(row.total_parts),
		sha256: String(row.sha256),
		receivedParts: parts.map((p) => Number(p.part)),
		bytesReceived: parts.reduce((n, p) => n + Number(p.bytes), 0),
		assembledParts: Number(row.assemble_part),
		expiresAt: Number(row.expires_at)
	};
}

/**
 * Declares a dump. One upload is open at a time: the same declaration again returns that upload
 * (a retry after a lost reply), a different one is refused with the open upload's id.
 *
 * @returns the upload, and whether this call created it
 */
export function beginUpload(
	sql: SqlLike,
	storage: StorageLike,
	opts: {
		label: string;
		bytes: number;
		parts: number;
		sha256: string;
		nowMs: number;
		maxBytes: number;
	}
): { status: UploadStatus; created: boolean } {
	const { bytes, parts } = opts;
	if (!Number.isSafeInteger(bytes) || bytes < 1) {
		throw new RestorePartsError('bad_request', 400, 'bytes must be a positive integer');
	}
	if (!Number.isSafeInteger(parts) || parts < 1 || parts > RESTORE_MAX_PARTS) {
		throw new RestorePartsError(
			'bad_request',
			400,
			`parts must be an integer from 1 to ${RESTORE_MAX_PARTS}`
		);
	}
	if (!HEX64.test(opts.sha256)) {
		throw new RestorePartsError('bad_request', 400, 'sha256 must be 64 hex characters');
	}
	if (opts.label === '' || opts.label.length > 200) {
		throw new RestorePartsError('bad_request', 400, 'label must be 1 to 200 characters');
	}
	if (bytes > opts.maxBytes) {
		throw new RestorePartsError(
			'too_large',
			413,
			`a paged restore takes at most ${opts.maxBytes} bytes`,
			{ limit: opts.maxBytes }
		);
	}
	if (parts > bytes || bytes > parts * RESTORE_PART_MAX_BYTES) {
		throw new RestorePartsError(
			'bad_request',
			400,
			`${parts} part(s) of at most ${RESTORE_PART_MAX_BYTES} bytes cannot carry ${bytes} bytes`
		);
	}
	const sha256 = opts.sha256.toLowerCase();

	const open = uploadStatus(sql, storage, opts.nowMs);
	if (open !== undefined) {
		const same =
			open.sha256 === sha256 &&
			open.bytes === bytes &&
			open.parts === parts &&
			open.generation === opts.label;
		if (!same) {
			throw new RestorePartsError('busy', 409, 'another paged restore is open on this site', {
				upload: open.id,
				bytes: open.bytes,
				parts: open.parts
			});
		}
		sql.exec(
			'UPDATE cfw_restore_upload SET expires_at = ? WHERE id = ?',
			opts.nowMs + RESTORE_UPLOAD_TTL_MS,
			open.id
		);
		return {
			status: uploadStatus(sql, storage, opts.nowMs, open.id) as UploadStatus,
			created: false
		};
	}

	const id = crypto.randomUUID();
	sql.exec(
		`INSERT INTO cfw_restore_upload
			(id, created_at, expires_at, generation, total_bytes, total_parts, sha256, state)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
		id,
		opts.nowMs,
		opts.nowMs + RESTORE_UPLOAD_TTL_MS,
		opts.label,
		bytes,
		parts,
		sha256
	);
	return { status: uploadStatus(sql, storage, opts.nowMs, id) as UploadStatus, created: true };
}

/** decodes a part as UTF-8 without altering a byte, so the stored bytes re-encode to the digest */
function decodePart(body: Uint8Array): string {
	return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
}

/**
 * Stores one part. The digest is checked against the bytes, the part must be whole statements,
 * and no statement may exceed what a Durable Object runs. A repeat with the same digest writes
 * nothing; a different body for the same number replaces it while the upload is open.
 *
 * @returns whether this call wrote the part
 */
export function putPart(
	sql: SqlLike,
	storage: StorageLike,
	opts: { id: string; part: number; body: Uint8Array; sha256: string; nowMs: number }
): { stored: boolean; status: UploadStatus } {
	const upload = requireUpload(sql, storage, opts.id, opts.nowMs);
	if (upload.state !== 'open') {
		throw new RestorePartsError('closed', 409, 'the upload is being committed; no more parts');
	}
	const { part, body } = opts;
	if (!Number.isSafeInteger(part) || part < 0 || part >= Number(upload.total_parts)) {
		throw new RestorePartsError(
			'bad_request',
			400,
			`part must be an integer from 0 to ${Number(upload.total_parts) - 1}`
		);
	}
	if (body.length < 1) throw new RestorePartsError('bad_request', 400, 'the part is empty');
	if (body.length > RESTORE_PART_MAX_BYTES) {
		throw new RestorePartsError(
			'too_large',
			413,
			`a part is at most ${RESTORE_PART_MAX_BYTES} bytes`,
			{ limit: RESTORE_PART_MAX_BYTES }
		);
	}
	if (!HEX64.test(opts.sha256)) {
		throw new RestorePartsError('bad_request', 400, 'x-part-sha256 must be 64 hex characters');
	}
	const digest = sha256Hex(body);
	if (digest !== opts.sha256.toLowerCase()) {
		throw new RestorePartsError('digest', 422, `part ${part} does not match its sha256`, {
			part,
			actual: digest
		});
	}

	const held = firstRow(
		sql.exec(
			'SELECT sha256 FROM cfw_restore_part WHERE upload_id = ? AND part = ?',
			opts.id,
			part
		)
	) as { sha256: string } | undefined;
	if (held !== undefined && String(held.sha256) === digest) {
		return {
			stored: false,
			status: uploadStatus(sql, storage, opts.nowMs, opts.id) as UploadStatus
		};
	}

	let text: string;
	try {
		text = decodePart(body);
	} catch {
		throw new RestorePartsError('not_utf8', 422, `part ${part} is not valid UTF-8`, { part });
	}
	const { statements, tail } = splitSqlStatementsStrict(text);
	if (tail !== '') {
		throw new RestorePartsError(
			'not_aligned',
			422,
			`part ${part} ends inside a statement; cut parts between statements`,
			{ part }
		);
	}
	const wide = statements.findIndex((s) => s.length > DO_SQLITE_MAX_STATEMENT_CHARS);
	if (wide >= 0) {
		throw new RestorePartsError(
			'statement_too_long',
			422,
			`statement ${wide} of part ${part} is over ${DO_SQLITE_MAX_STATEMENT_CHARS} characters`,
			{ part, statement: wide }
		);
	}

	const others = firstRow(
		sql.exec(
			'SELECT COALESCE(SUM(bytes), 0) AS n FROM cfw_restore_part WHERE upload_id = ? AND part <> ?',
			opts.id,
			part
		)
	) as { n: number };
	if (Number(others.n) + body.length > Number(upload.total_bytes)) {
		throw new RestorePartsError(
			'too_large',
			413,
			'the parts sent are larger than the declared dump',
			{ declared: Number(upload.total_bytes) }
		);
	}

	storage.transactionSync(() => {
		sql.exec(
			'INSERT OR REPLACE INTO cfw_restore_part (upload_id, part, bytes, sha256, body) VALUES (?, ?, ?, ?, ?)',
			opts.id,
			part,
			body.length,
			digest,
			body
		);
		sql.exec(
			'UPDATE cfw_restore_upload SET expires_at = ? WHERE id = ?',
			opts.nowMs + RESTORE_UPLOAD_TTL_MS,
			opts.id
		);
	});
	return {
		stored: true,
		status: uploadStatus(sql, storage, opts.nowMs, opts.id) as UploadStatus
	};
}

/** one part's bytes, read on its own so the dump is never held whole */
function readPart(sql: SqlLike, id: string, part: number): Uint8Array {
	const row = firstRow(
		sql.exec('SELECT body FROM cfw_restore_part WHERE upload_id = ? AND part = ?', id, part)
	) as { body: unknown } | undefined;
	if (row === undefined) {
		throw new RestorePartsError('incomplete', 409, `part ${part} is missing`, {
			missing: [part]
		});
	}
	return toBytes(row.body);
}

/**
 * Advances a commit by one call. The first call checks that every part is present and verifies
 * the whole digest over the parts in order. Each call then turns parts into replay chunks, up to
 * `budgetBytes` of raw parts, and deletes each part as its chunks land. The call that assembles
 * the last part makes the import visible to `latestImport()`; the caller arms the alarm after it.
 */
export function commitUpload(
	sql: SqlLike,
	storage: StorageLike,
	opts: { id: string; nowMs: number; budgetBytes?: number }
): CommitResult {
	const upload = requireUpload(sql, storage, opts.id, opts.nowMs);
	const total = Number(upload.total_parts);

	if (upload.state === 'open') {
		const held = sql
			.exec(
				'SELECT part, bytes FROM cfw_restore_part WHERE upload_id = ? ORDER BY part',
				opts.id
			)
			.toArray() as { part: number; bytes: number }[];
		const have = new Set(held.map((p) => Number(p.part)));
		const missing: number[] = [];
		for (let part = 0; part < total && missing.length < 100; part++) {
			if (!have.has(part)) missing.push(part);
		}
		const size = held.reduce((n, p) => n + Number(p.bytes), 0);
		if (missing.length > 0) {
			throw new RestorePartsError('incomplete', 409, `${missing.length} part(s) missing`, {
				missing
			});
		}
		if (size !== Number(upload.total_bytes)) {
			throw new RestorePartsError(
				'incomplete',
				409,
				`the parts hold ${size} bytes, the dump was declared as ${upload.total_bytes}`,
				{ held: size, declared: Number(upload.total_bytes) }
			);
		}
		const whole = createHash('sha256');
		for (let part = 0; part < total; part++) whole.update(readPart(sql, opts.id, part));
		if (whole.digest('hex') !== String(upload.sha256)) {
			throw new RestorePartsError(
				'whole_digest',
				422,
				'the parts in order do not match the declared sha256'
			);
		}
		sql.exec('UPDATE cfw_restore_upload SET state = ? WHERE id = ?', 'verified', opts.id);
		upload.state = 'verified';
	}

	const budget = opts.budgetBytes ?? ASSEMBLE_BYTES_PER_CALL;
	let spent = 0;
	let next = Number(upload.assemble_part);
	let importId = upload.import_id === null ? null : Number(upload.import_id);
	let seq = Number(upload.next_seq);
	let statementCount = Number(upload.statements);

	while (next < total && (spent === 0 || spent < budget)) {
		const body = readPart(sql, opts.id, next);
		const statements = splitSqlStatementsStrict(decodePart(body)).statements.filter(
			(s) => !isIdentityMetaStatement(s)
		);
		const groups: string[][] = [];
		for (let i = 0; i < statements.length; i += IMPORT_STATEMENTS_PER_CHUNK) {
			groups.push(statements.slice(i, i + IMPORT_STATEMENTS_PER_CHUNK));
		}
		storage.transactionSync(() => {
			if (importId === null) {
				// -1 chunks never equals a chunk count, so `latestImport()` skips it until the end
				const row = firstRow(
					sql.exec(
						`INSERT INTO cfw_import
							(created_at, generation, total_chunks, total_statements, source)
						 VALUES (?, ?, -1, 0, ?) RETURNING id`,
						opts.nowMs,
						String(upload.generation),
						'/__restore-parts'
					)
				) as { id: number | bigint } | undefined;
				importId = Number(row?.id ?? 0);
				if (importId === 0) throw new Error('the import row did not come back with an id');
			}
			groups.forEach((group, i) => {
				sql.exec(
					'INSERT OR REPLACE INTO cfw_import_chunk (import_id, seq, statements) VALUES (?, ?, ?)',
					importId,
					seq + i,
					JSON.stringify(group.map((s) => ({ s })))
				);
			});
			sql.exec(
				'DELETE FROM cfw_restore_part WHERE upload_id = ? AND part = ?',
				opts.id,
				next
			);
			sql.exec(
				`UPDATE cfw_restore_upload
				 SET state = 'assembling', assemble_part = ?, import_id = ?, next_seq = ?, statements = ?,
					expires_at = ?
				 WHERE id = ?`,
				next + 1,
				importId,
				seq + groups.length,
				statementCount + statements.length,
				opts.nowMs + RESTORE_UPLOAD_TTL_MS,
				opts.id
			);
		});
		seq += groups.length;
		statementCount += statements.length;
		spent += body.length;
		next += 1;
	}

	if (next < total) {
		return { done: false, state: 'assembling', assembledParts: next, parts: total };
	}

	if (statementCount === 0 || importId === null) {
		purgeUpload(sql, storage, opts.id);
		throw new RestorePartsError('empty', 422, 'dump contains no statements');
	}
	const finalId = importId;
	storage.transactionSync(() => {
		sql.exec(
			'UPDATE cfw_import SET total_chunks = ?, total_statements = ? WHERE id = ?',
			seq,
			statementCount,
			finalId
		);
		sql.exec('DELETE FROM cfw_restore_upload WHERE id = ?', opts.id);
	});
	return {
		done: true,
		import: {
			id: finalId,
			chunks: seq,
			statements: statementCount,
			generation: String(upload.generation)
		}
	};
}

/** ends an upload and removes everything it stored; false when there was none */
export function abortUpload(sql: SqlLike, storage: StorageLike, id: string): boolean {
	ensureRestoreTables(sql);
	return purgeUpload(sql, storage, id);
}
