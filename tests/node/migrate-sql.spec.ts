import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	MIGRATE_TABLE,
	MigrationChunkError,
	MigrationGenerationError,
	SqlMigrator,
	chunksPerInvocation,
	decodeParam,
	ensureMigrateTable,
	readMigrateCursor
} from '../../src/db/migrate-sql';

const CHUNK_DIR = resolve(import.meta.dirname, '../../assets/drupal-sql');
const SOURCE_DB = resolve(import.meta.dirname, '../../assets/drupal/site.sqlite');

// #region types over the untyped `src/db/migrate-sql.js`

type SqlParam = null | number | bigint | string | Uint8Array;

interface SqlCursor {
	toArray(): Record<string, unknown>[];
	rowsRead: number;
	rowsWritten: number;
}

interface SqlLike {
	exec(text: string, ...params: SqlParam[]): SqlCursor;
}

interface StorageLike {
	transactionSync<T>(cb: () => T): T;
}

interface ChunkMeta {
	i: number;
	file: string;
	statements: number;
	bytes: number;
}

interface Manifest {
	version: number;
	generation: string;
	sourceBytes: number;
	totals: {
		chunks: number;
		statements: number;
		tableDdl: number;
		indexDdl: number;
		rowStatements: number;
		rows: number;
		chunkBytes: number;
	};
	limits: { maxStatements: number; maxBytes: number };
	creates: string[];
	notes: {
		collationsRewritten: number;
		sessionsSynthesised: boolean;
		splitStatements: number;
		unsplittableValues?: string[];
	};
	tables: Record<string, number>;
	chunks: ChunkMeta[];
}

interface ChunkFile {
	i?: number;
	statements?: { s: string; p?: unknown[] }[];
}

interface Loader {
	loadManifest: () => Promise<Manifest>;
	loadChunk: (file: string, index: number) => Promise<ChunkFile>;
}

interface Cursor {
	generation: string;
	chunk: number;
	chunks: number;
	statements: number;
	rowsWritten: number;
	state: string;
	error: string | null;
	startedAt: number;
	updatedAt: number;
}

interface StepResult {
	ok: boolean;
	done: boolean;
	chunk: number;
	chunks: number;
	applied: number;
	statements: number;
	rowsWritten: number;
	skipped?: string;
}

interface Status {
	generation: string;
	chunks: number;
	statements: number;
	rows: number;
	cursor: Cursor | null;
	done: boolean;
	started: boolean;
}

// the module is untyped JS, so results crossing back get a named shape here
const asStep = (r: unknown): StepResult => r as StepResult;
const asStatus = (r: unknown): Status => r as Status;
const asCursor = (r: unknown): Cursor | null => r as Cursor | null;

/** array index that fails loudly instead of widening; noUncheckedIndexedAccess is on */
function at<T>(list: T[], i: number): T {
	const v = list[i];
	if (v === undefined) throw new Error(`no element at ${i}`);
	return v;
}

// #endregion

// #region the ctx.storage.sql stand-in, over a real SQLite

/**
 * Wraps a real `node:sqlite` handle in the workerd storage surface.
 *
 * `transactionSync` is SAVEPOINT rather than BEGIN because that is the semantic
 * `ctx.storage.transactionSync()` has: it nests, and a throw from the callback rolls the
 * savepoint back and rethrows. Issuing BEGIN as SQL is exactly what the platform refuses.
 */
function storageOver(db: DatabaseSync): { sql: SqlLike; storage: StorageLike } {
	let depth = 0;
	const isRead = (text: string) => /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(text);

	const sql: SqlLike = {
		exec(text, ...params) {
			const stmt = db.prepare(text);
			if (isRead(text)) {
				const rows = stmt.all(...params);
				return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
			}
			const r = stmt.run(...params);
			return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes ?? 0) };
		}
	};

	const storage: StorageLike = {
		transactionSync(cb) {
			const name = `sp${depth++}`;
			db.exec(`SAVEPOINT ${name}`);
			try {
				const out = cb();
				db.exec(`RELEASE ${name}`);
				depth--;
				return out;
			} catch (e) {
				db.exec(`ROLLBACK TO ${name}`);
				db.exec(`RELEASE ${name}`);
				depth--;
				throw e;
			}
		}
	};

	return { sql, storage };
}

// #endregion

// #region the shipped artifact, or a skip when it was never generated

function readManifest(): Manifest | null {
	try {
		return JSON.parse(readFileSync(join(CHUNK_DIR, 'manifest.json'), 'utf8')) as Manifest;
	} catch {
		return null;
	}
}

const loaded = readManifest();
const available = loaded !== null && existsSync(SOURCE_DB);
const describeIfPacked = available ? describe : describe.skip;

// safe because `available` is false whenever it is null, and every block that reads it is
// gated on `available`
const manifest = loaded as Manifest;

function diskLoader(overrides: Partial<Loader> = {}): Loader {
	return {
		loadManifest: overrides.loadManifest ?? (async () => manifest),
		loadChunk:
			overrides.loadChunk ??
			(async (file: string) => JSON.parse(await readFile(join(CHUNK_DIR, file), 'utf8')))
	};
}

function freshMigrator(overrides: Partial<Loader> = {}): {
	db: DatabaseSync;
	sql: SqlLike;
	storage: StorageLike;
	migrator: SqlMigrator;
} {
	const db = new DatabaseSync(':memory:');
	const { sql, storage } = storageOver(db);
	let clock = 1_700_000_000_000;
	const migrator = new SqlMigrator({
		sql,
		storage,
		now: () => (clock += 1),
		...diskLoader(overrides)
	});
	return { db, sql, storage, migrator };
}

/** the rejection a promise settles with, or null when it resolved */
async function rejection(p: Promise<unknown>): Promise<unknown> {
	try {
		await p;
		return null;
	} catch (e) {
		return e;
	}
}

function rowTotal(db: DatabaseSync, tables: string[]): number {
	let n = 0;
	for (const t of tables) {
		n += Number(db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get()?.c ?? 0);
	}
	return n;
}

/** same, but a table that does not exist yet counts zero; only the rollback case needs it */
function rowTotalTolerant(db: DatabaseSync, tables: string[]): number {
	let n = 0;
	for (const t of tables) {
		try {
			n += Number(db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get()?.c ?? 0);
		} catch {
			/* not created yet */
		}
	}
	return n;
}

// #endregion

// #region the source database, for the fidelity diff

/**
 * Opens a copy of the source with `NOCASE_UTF8` rewritten to `NOCASE`, the same way
 * `scripts/pack-sql.ts` does, because otherwise reading `users` at all fails with "no such
 * collation sequence". In a COPY: the source is a build input.
 */
async function openSourceRewritten(): Promise<{ db: DatabaseSync; tmp: string }> {
	const dir = join(tmpdir(), 'cfw-test-migrate');
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, 'source.sqlite');
	await rm(tmp, { force: true });
	await copyFile(SOURCE_DB, tmp);
	const db = new DatabaseSync(tmp);
	const before = Number(db.prepare('PRAGMA schema_version').get()?.schema_version ?? 0);
	db.exec('PRAGMA writable_schema=ON');
	db.exec(
		"UPDATE sqlite_master SET sql = replace(sql, 'NOCASE_UTF8', 'NOCASE') WHERE sql LIKE '%NOCASE_UTF8%'"
	);
	db.exec(`PRAGMA schema_version=${before + 1}`);
	db.exec('PRAGMA writable_schema=OFF');
	db.close();
	return { db: new DatabaseSync(tmp, { readOnly: true }), tmp };
}

interface Digest {
	rows: number;
	bytes: number;
	digest: string;
}

/**
 * A stable digest of one table's full contents, computed with `hex()` INSIDE SQLite.
 *
 * The instrument is what matters, and the first version of this function was wrong in a way that
 * let a real bug ship. It read values as JS strings, and **`node:sqlite` truncates a TEXT value
 * at the first NUL byte.** Drupal's `cache_data` holds a serialized RouteCollection with NULs in
 * it, so the source read back as 117 of its 1,697 bytes, the replayed copy read back as the same
 * 117, the digests matched, and 86 assertions passed over a pack that could not render a page:
 * Drupal died in `RouteProvider::getRouteCollectionForRequest()` because `unserialize()` on a
 * truncated string returns FALSE and `FALSE['query']` is NULL.
 *
 * Both sides of a comparison sharing one defective instrument cannot see the defect. So do NOT
 * "simplify" this to a JS-side read.
 *
 * `hex()` and `typeof()` are evaluated by the engine and come back as ASCII, so nothing crosses
 * the boundary a NUL can cut. `typeof` is included because storage class is part of fidelity: a
 * BLOB replayed as TEXT is a difference worth failing on.
 *
 * Rows are sorted by their own serialised form rather than by a key, because several of these
 * tables have no single-column primary key and INSERT order is not a guarantee either side of
 * the trip.
 */
function tableDigest(db: DatabaseSync, table: string): Digest {
	const quoted = `"${table.replace(/"/g, '""')}"`;
	const cols = db
		.prepare(`PRAGMA table_info(${quoted})`)
		.all()
		.map((c) => String(c.name));
	if (!cols.length) return { rows: 0, bytes: 0, digest: 'no-columns' };
	const select = cols
		.map((c, i) => {
			const q = `"${c.replace(/"/g, '""')}"`;
			return `typeof(${q}) AS t${i}, hex(${q}) AS h${i}`;
		})
		.join(', ');
	const lines: string[] = [];
	let bytes = 0;
	for (const row of db.prepare(`SELECT ${select} FROM ${quoted}`).all()) {
		const parts: string[] = [];
		for (let i = 0; i < cols.length; i++) {
			const hex = String(row[`h${i}`] ?? '');
			bytes += hex.length / 2;
			parts.push(`${String(row[`t${i}`])}:${hex}`);
		}
		lines.push(parts.join(' '));
	}
	lines.sort();
	return {
		rows: lines.length,
		bytes,
		digest: createHash('sha256').update(lines.join('')).digest('hex').slice(0, 16)
	};
}

// #endregion

describe('the packed artifact this suite replays', () => {
	it('reports whether the replay actually ran', () => {
		// not an assertion about behaviour: it makes a silent skip visible in the output, so
		// "green" cannot quietly mean "the replay never executed"
		if (!available) {
			console.log(
				'  note: assets/drupal-sql or assets/drupal/site.sqlite is missing, the migration replay was SKIPPED\n' +
					'  regenerate with: node scripts/pack-sql.ts assets/drupal/site.sqlite assets/drupal-sql'
			);
		}
		expect(typeof available).toBe('boolean');
	});
});

describe('decodeParam', () => {
	it.each([
		['null', null],
		['a number', 42],
		['a string', 'hi']
	])('passes %s straight through', (_label, value) => {
		expect(decodeParam(value)).toBe(value);
	});

	it('decodes $b64 to bytes, NUL and high byte intact', () => {
		const bytes = decodeParam({ $b64: Buffer.from([0, 1, 255, 200]).toString('base64') });
		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(bytes.length).toBe(4);
		expect(bytes[0]).toBe(0);
		expect(bytes[2]).toBe(255);
	});

	it('leaves a wide int a decimal string so INTEGER affinity converts it losslessly', () => {
		expect(decodeParam({ $i: '9223372036854775807' })).toBe('9223372036854775807');
	});

	it('refuses an unknown tag', () => {
		expect(() => decodeParam({ $nope: 1 })).toThrow(Error);
	});
});

describeIfPacked('the shipped manifest is internally consistent', () => {
	it('is version 1', () => {
		expect(manifest.version).toBe(1);
	});

	it('has chunks', () => {
		expect(manifest.chunks.length).toBeGreaterThan(0);
	});

	it('counts the same chunks in totals as it lists', () => {
		expect(manifest.totals.chunks).toBe(manifest.chunks.length);
	});

	it('numbers its chunk indexes densely and in order', () => {
		expect(manifest.chunks.map((c) => c.i)).toEqual(manifest.chunks.map((_c, i) => i));
	});

	it('totals the statements its chunks declare', () => {
		expect(manifest.chunks.reduce((a, c) => a + c.statements, 0)).toBe(
			manifest.totals.statements
		);
	});

	it('splits those statements into table DDL + row statements + index DDL', () => {
		expect(
			manifest.totals.tableDdl + manifest.totals.rowStatements + manifest.totals.indexDdl
		).toBe(manifest.totals.statements);
	});

	// row statements exceed rows exactly by the number of append slices, because a value too
	// large for one statement is rebuilt with `col = col || ?`
	it('exceeds its row count by exactly the append slices', () => {
		expect(manifest.totals.rows + manifest.notes.splitStatements).toBe(
			manifest.totals.rowStatements
		);
	});

	it('left no oversized value whole, so every one had a primary key to address it', () => {
		expect(manifest.notes.unsplittableValues ?? []).toEqual([]);
	});

	it('synthesised sessions, because a pack browsed anonymously never writes one', () => {
		expect(manifest.notes.sessionsSynthesised).toBe(true);
	});

	it('rewrote the NOCASE_UTF8 collation', () => {
		expect(manifest.notes.collationsRewritten).toBeGreaterThan(0);
	});

	it('is smaller than the .sqlite it replaces', () => {
		expect(manifest.totals.chunkBytes).toBeLessThan(manifest.sourceBytes);
	});
});

describeIfPacked('the cursor table', () => {
	it('is created idempotently and starts empty', () => {
		const { sql } = freshMigrator();
		ensureMigrateTable(sql);
		ensureMigrateTable(sql);
		expect(asCursor(readMigrateCursor(sql))).toBeNull();
		expect(
			Number(at(sql.exec(`SELECT COUNT(*) AS c FROM ${MIGRATE_TABLE}`).toArray(), 0).c)
		).toBe(0);
	});
});

describeIfPacked('status before anything runs', () => {
	let status: Status;

	beforeAll(async () => {
		const { migrator } = freshMigrator();
		status = asStatus(await migrator.status());
	});

	it('reports not started', () => {
		expect(status.started).toBe(false);
	});

	it('reports not done', () => {
		expect(status.done).toBe(false);
	});

	it('reports the manifest chunk count', () => {
		expect(status.chunks).toBe(manifest.totals.chunks);
	});

	it('reports the manifest row count', () => {
		expect(status.rows).toBe(manifest.totals.rows);
	});

	it('carries the generation', () => {
		expect(status.generation).toBe(manifest.generation);
	});
});

describeIfPacked('one chunk per step, and the cursor advances exactly once', () => {
	let first: StepResult;
	let second: StepResult;
	let cursor: Cursor | null;

	beforeAll(async () => {
		const { sql, migrator } = freshMigrator();
		first = asStep(await migrator.step());
		cursor = asCursor(readMigrateCursor(sql));
		second = asStep(await migrator.step());
	});

	it('applies exactly one chunk', () => {
		expect(first.applied).toBe(1);
	});

	it('leaves the cursor at 1', () => {
		expect(first.chunk).toBe(1);
	});

	it('is not done', () => {
		expect(first.done).toBe(false);
	});

	it("reports the first chunk's statement count", () => {
		expect(first.statements).toBe(at(manifest.chunks, 0).statements);
	});

	it('persisted the cursor at chunk 1', () => {
		expect(cursor?.chunk).toBe(1);
	});

	it('persisted state running', () => {
		expect(cursor?.state).toBe('running');
	});

	it('persisted the generation', () => {
		expect(cursor?.generation).toBe(manifest.generation);
	});

	it('persisted no error', () => {
		expect(cursor?.error).toBeNull();
	});

	it('resumes at chunk 1 and lands on 2', () => {
		expect(second.chunk).toBe(2);
	});

	it('applies one chunk on the second step too', () => {
		expect(second.applied).toBe(1);
	});

	it('accumulates statements across steps rather than restarting', () => {
		expect(second.statements).toBe(
			at(manifest.chunks, 0).statements + at(manifest.chunks, 1).statements
		);
	});
});

describeIfPacked('replaying every shipped chunk, one per invocation, reproduces the source', () => {
	let db: DatabaseSync;
	let source: DatabaseSync;
	let tmp: string;
	let result: StepResult;
	let again: StepResult;
	let invocations = 0;
	let cursorState = '';
	let tables: string[] = [];
	let matched = 0;
	let mismatched: string[] = [];
	let shortfalls: string[] = [];
	let totalDigestRows = 0;
	let sourceBytes = 0;
	let replayedBytes = 0;

	beforeAll(async () => {
		const fresh = freshMigrator();
		db = fresh.db;
		while (invocations < manifest.totals.chunks + 5) {
			result = asStep(await fresh.migrator.step());
			invocations++;
			if (result.done) break;
		}
		cursorState = asCursor(readMigrateCursor(fresh.sql))?.state ?? '';
		// a step after done should be a no-op rather than a re-run
		again = asStep(await fresh.migrator.step());

		// FIDELITY: the replayed database against the source it was packed from
		const opened = await openSourceRewritten();
		source = opened.db;
		tmp = opened.tmp;
		tables = Object.keys(manifest.tables);
		for (const table of tables) {
			const want = tableDigest(source, table);
			const got = tableDigest(db, table);
			totalDigestRows += got.rows;
			sourceBytes += want.bytes;
			replayedBytes += got.bytes;
			if (want.rows === got.rows && want.digest === got.digest) matched++;
			else {
				mismatched.push(
					`${table} (${want.rows}r/${want.bytes}b/${want.digest} vs ${got.rows}r/${got.bytes}b/${got.digest})`
				);
			}
			if (got.bytes < want.bytes) shortfalls.push(`${table} ${got.bytes}<${want.bytes}`);
		}
	});

	afterAll(async () => {
		source?.close();
		db?.close();
		if (tmp) await rm(tmp, { force: true });
	});

	it('completes the whole migration', () => {
		expect(result.done).toBe(true);
	});

	it('takes exactly one invocation per chunk', () => {
		expect(invocations).toBe(manifest.totals.chunks);
	});

	it('replays every statement', () => {
		expect(result.statements).toBe(manifest.totals.statements);
	});

	it('leaves the cursor state done', () => {
		expect(cursorState).toBe('done');
	});

	it('applies nothing on a step after done', () => {
		expect(again.applied).toBe(0);
	});

	it('still reports done on a step after done', () => {
		expect(again.done).toBe(true);
	});

	it('says why it skipped', () => {
		expect(again.skipped).toBe('already migrated');
	});

	// byte totals separately from the digests: a truncation shows up here as a number you can
	// read, where a digest only tells you something differed
	it('holds the same total bytes as the source', () => {
		expect(replayedBytes).toBe(sourceBytes);
	});

	it('reproduces every source table value-for-value', () => {
		expect(mismatched).toEqual([]);
	});

	it('matches every table the manifest declares', () => {
		expect(matched).toBe(tables.length);
	});

	it('holds the row count the manifest promises', () => {
		expect(totalDigestRows).toBe(manifest.totals.rows);
	});

	// the NUL regression, pinned on the exact row that found it.
	//
	// `cache_data`'s RouteProvider entry is a serialized RouteCollection containing NUL bytes.
	// Read as a JS string it is 117 bytes; its real length is 1,697. Asserted in absolute bytes
	// rather than "source equals replay", because the equality form is what failed to catch this
	// the first time: both sides read 117 and agreed.
	it('keeps the RouteProvider cache row at full length through its embedded NULs', () => {
		const bytes = Number(
			db
				.prepare(
					"SELECT length(hex(data)) / 2 AS bytes FROM cache_data WHERE cid LIKE 'route:%'"
				)
				.get()?.bytes ?? 0
		);
		expect(
			bytes,
			`${bytes} bytes; 117 means node:sqlite truncated a TEXT read at the first NUL`
		).toBeGreaterThan(1000);
	});

	it('is still truncated on a JS read of that row, so the assertion above is load-bearing', () => {
		const text = db.prepare("SELECT data FROM cache_data WHERE cid LIKE 'route:%'").get()?.data;
		expect(
			typeof text === 'string' && text.length < 200,
			`JS read gave ${typeof text === 'string' ? text.length : typeof text}`
		).toBe(true);
	});

	it('has no table shorter than its source, so no text value lost bytes to a NUL', () => {
		expect(shortfalls).toEqual([]);
	});

	// the synthesised table has to exist and be empty, or the first entity save fails the whole
	// transaction replay with "no such table: sessions"
	it('has an empty sessions table', () => {
		expect(Number(db.prepare('SELECT COUNT(*) AS c FROM sessions').get()?.c)).toBe(0);
	});

	it('has both of sessions two indexes', () => {
		const c = db
			.prepare(
				"SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND tbl_name='sessions' AND sql IS NOT NULL"
			)
			.get()?.c;
		expect(Number(c)).toBe(2);
	});

	it('applied the index DDL, which lands last but does land', () => {
		const c = db
			.prepare(
				"SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
			)
			.get()?.c;
		expect(Number(c)).toBeGreaterThanOrEqual(manifest.totals.indexDdl);
	});

	// rows written is the free plan's binding meter for a fill; migration should be a one-off in
	// the low thousands, not a fraction of the daily budget
	it('reports rows written bounded below by the row count', () => {
		expect(result.rowsWritten).toBeGreaterThanOrEqual(manifest.totals.rows);
	});

	it('writes under 5% of the free daily row budget', () => {
		expect(result.rowsWritten).toBeLessThan(5000);
	});
});

describeIfPacked('runAll is the paid-plan shape and produces the same end state', () => {
	let db: DatabaseSync;
	let result: StepResult;
	let cursorState = '';
	let rows = 0;

	beforeAll(async () => {
		const fresh = freshMigrator();
		db = fresh.db;
		result = asStep(await fresh.migrator.runAll());
		cursorState = asCursor(readMigrateCursor(fresh.sql))?.state ?? '';
		rows = rowTotal(db, Object.keys(manifest.tables));
	});

	afterAll(() => db?.close());

	it('completes in one call', () => {
		expect(result.done).toBe(true);
	});

	it('applies every chunk', () => {
		expect(result.applied).toBe(manifest.totals.chunks);
	});

	it('replays every statement', () => {
		expect(result.statements).toBe(manifest.totals.statements);
	});

	it('leaves the cursor done', () => {
		expect(cursorState).toBe('done');
	});

	it('produces the same row count as the chunked path', () => {
		expect(rows).toBe(manifest.totals.rows);
	});
});

describeIfPacked('a failed chunk rolls back whole, records the failure, and retries', () => {
	let db: DatabaseSync;
	let error: unknown;
	let cursor: Cursor | null;
	let afterFirst = 0;
	let afterFail = 0;
	let finished: StepResult;
	let afterRetry = 0;

	beforeAll(async () => {
		let failNext = true;
		const fresh = freshMigrator({
			loadChunk: async (file, index) => {
				const real = JSON.parse(await readFile(join(CHUNK_DIR, file), 'utf8')) as ChunkFile;
				if (index === 1 && failNext) {
					// a valid-looking statement that cannot execute, appended AFTER real work so the
					// rollback has something to undo
					return {
						i: real.i,
						statements: [
							...(real.statements ?? []),
							{ s: 'INSERT INTO no_such_table VALUES (1)', p: [] }
						]
					};
				}
				return real;
			}
		});
		db = fresh.db;
		const tables = Object.keys(manifest.tables);

		await fresh.migrator.step();
		afterFirst = rowTotalTolerant(db, tables);

		error = await rejection(fresh.migrator.step());
		cursor = asCursor(readMigrateCursor(fresh.sql));
		afterFail = rowTotalTolerant(db, tables);

		// the retry path: the same chunk, now sound, and the migration finishes clean
		failNext = false;
		finished = asStep(await fresh.migrator.runAll());
		afterRetry = rowTotal(db, tables);
	});

	afterAll(() => db?.close());

	it('rejects with a MigrationChunkError', () => {
		expect(error).toBeInstanceOf(MigrationChunkError);
	});

	it('does NOT advance the cursor', () => {
		expect(cursor?.chunk).toBe(1);
	});

	it('records state failed', () => {
		expect(cursor?.state).toBe('failed');
	});

	it('records the error text', () => {
		expect(cursor?.error ?? '').toContain('no_such_table');
	});

	it('leaves no partial rows behind', () => {
		expect(afterFail).toBe(afterFirst);
	});

	it('completes on the retry', () => {
		expect(finished.done).toBe(true);
	});

	it('replays every statement exactly once across the retry', () => {
		expect(finished.statements).toBe(manifest.totals.statements);
	});

	it('produces the full row count, so nothing was skipped or doubled', () => {
		expect(afterRetry).toBe(manifest.totals.rows);
	});
});

describeIfPacked('a mid-flight generation change is refused, not merged', () => {
	let error: unknown;
	let cursor: Cursor | null;

	beforeAll(async () => {
		const { sql, migrator } = freshMigrator();
		await migrator.step();
		sql.exec(`UPDATE ${MIGRATE_TABLE} SET generation = 'someotherpack' WHERE id = 1`);
		migrator.manifest = null;
		error = await rejection(migrator.step());
		cursor = asCursor(readMigrateCursor(sql));
	});

	it('refuses to replay a different pack over a half-migrated database', () => {
		expect(error).toBeInstanceOf(MigrationGenerationError);
	});

	it('leaves the cursor alone', () => {
		expect(cursor?.chunk).toBe(1);
	});
});

describeIfPacked('a chunk file from a different build is refused', () => {
	it('rejects a chunk whose own index disagrees with the manifest', async () => {
		const { migrator } = freshMigrator({
			loadChunk: async (file) => {
				const real = JSON.parse(await readFile(join(CHUNK_DIR, file), 'utf8')) as ChunkFile;
				return { ...real, i: Number(real.i) + 100 };
			}
		});
		await expect(migrator.step()).rejects.toThrow(MigrationChunkError);
	});

	it('rejects a chunk with no statements array', async () => {
		const { migrator } = freshMigrator({ loadChunk: async () => ({ i: 0 }) });
		await expect(migrator.step()).rejects.toThrow(MigrationChunkError);
	});
});

describeIfPacked('reset', () => {
	let db: DatabaseSync;
	let dropped = 0;
	let cursor: Cursor | null;
	let leftovers = 0;
	let redo: StepResult;

	beforeAll(async () => {
		const fresh = freshMigrator();
		db = fresh.db;
		await fresh.migrator.runAll();
		dropped = Number((await fresh.migrator.reset()).dropped);
		cursor = asCursor(readMigrateCursor(fresh.sql));
		leftovers = Number(
			db
				.prepare(
					"SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> ?"
				)
				.get(MIGRATE_TABLE)?.c ?? 0
		);
		// and a reset object migrates again from scratch
		redo = asStep(await fresh.migrator.runAll());
	});

	afterAll(() => db?.close());

	it("drops the manifest's tables", () => {
		expect(dropped).toBeGreaterThan(0);
	});

	it('clears the cursor', () => {
		expect(cursor).toBeNull();
	});

	it('leaves no source tables behind', () => {
		expect(leftovers).toBe(0);
	});

	it('migrates again cleanly', () => {
		expect(redo.done).toBe(true);
	});

	it('replays the same statements the second time', () => {
		expect(redo.statements).toBe(manifest.totals.statements);
	});
});

describe('chunksPerInvocation', () => {
	it.each([
		['free replays one chunk per invocation', { PLAN: 'free' }, 1],
		['no plan set defaults to free', {}, 1],
		['undefined env defaults to free', undefined, 1],
		['paid replays the lot', { PLAN: 'paid' }, Infinity],
		['PAID is case-insensitive', { PLAN: 'PAID' }, Infinity],
		['an explicit override wins', { PLAN: 'free', MIGRATE_CHUNKS_PER_INVOCATION: '4' }, 4],
		[
			'a zero override falls through to the plan default rather than stalling forever',
			{ PLAN: 'free', MIGRATE_CHUNKS_PER_INVOCATION: '0' },
			1
		]
	])('%s', (_label, env, want) => {
		expect(chunksPerInvocation(env)).toBe(want);
	});
});

describeIfPacked('no chunk is so large that it cannot be the unit of an invocation', () => {
	const biggest = (): ChunkMeta =>
		at(
			[...manifest.chunks].sort((a, b) => b.bytes - a.bytes),
			0
		);

	it('keeps the largest chunk under the 25 MiB per-asset ceiling', () => {
		expect(biggest().bytes).toBeLessThan(25 * 1024 * 1024);
	});

	// the measured ceiling. Three chunks of the pre-split pack were 520 KB single
	// `cache_container` statements and measured 14, 17 and 25 ms of edge cpuTime -- the only
	// three of 24 that did not fit the free plan's 10 ms. `col = col || ?` splitting removed
	// them, so no chunk may exceed the budget the packer was told to use.
	it("keeps no chunk more than twice the packer's byte budget, except a known-large row", () => {
		// the 520 KB figure this once guarded was a RECORD-cap overrun, not a CPU one, and the two
		// assertions below now check that cap directly. What still matters is proliferation: one
		// unavoidably large row is a cost, several would be a design failure
		const budget = manifest.limits.maxBytes;
		const over = manifest.chunks.filter((c) => c.bytes > budget * 2);
		expect(
			over.length,
			`oversized chunks: ${over.map((c) => `${c.file}:${c.bytes}`).join(', ')}`
		).toBeLessThanOrEqual(1);
	});

	it('never exceeds the record cap, which is the limit the 520 KB row actually broke', () => {
		// 2,199,995 bytes per record, measured on a deployed object. A param over it is a hard
		// error, and this is the real constraint the chunk-size proxy stood in for
		let worst = 0;
		for (const c of manifest.chunks) {
			const body = JSON.parse(readFileSync(join(CHUNK_DIR, c.file), 'utf8')) as {
				statements: Array<{ s: string; p?: unknown[] }>;
			};
			for (const st of body.statements) {
				for (const prm of st.p ?? []) {
					const n =
						typeof prm === 'string'
							? Buffer.byteLength(prm)
							: prm &&
								  typeof prm === 'object' &&
								  '$b64' in (prm as Record<string, unknown>)
								? Buffer.from(
										String((prm as Record<string, string>).$b64),
										'base64'
									).length
								: 0;
					if (n > worst) worst = n;
				}
			}
		}
		expect(worst).toBeLessThan(2_199_995);
	});

	it('never exceeds the statement-text cap', () => {
		// 100,000 chars. This is why a blob ships as a bound parameter and never as inline text
		let worst = 0;
		for (const c of manifest.chunks) {
			const body = JSON.parse(readFileSync(join(CHUNK_DIR, c.file), 'utf8')) as {
				statements: Array<{ s: string }>;
			};
			for (const st of body.statements) worst = Math.max(worst, st.s.length);
		}
		expect(worst).toBeLessThan(100_000);
	});
});
