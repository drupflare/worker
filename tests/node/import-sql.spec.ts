import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	DUMP_START,
	RESTORE_OWNED_TABLES,
	dumpChunk,
	dumpDatabase,
	encodeLiteral,
	isRegenerable,
	type DumpCursor
} from '../../src/db/export-sql';
import { DO_SQLITE_MAX_STATEMENT_CHARS } from '../../src/db/heap-store';
import {
	IMPORT_STATEMENTS_PER_CHUNK,
	ensureImportTables,
	latestImport,
	splitSqlStatements,
	storeImport,
	storedImportLoader
} from '../../src/db/import-sql';
import type { SqlLike, StorageLike } from '../../src/db/migrate-sql';
import { SqlMigrator, readMigrateCursor } from '../../src/db/migrate-sql';

/**
 * The export half of backup/restore: the replay path `/export` never had.
 *
 * Until now the export produced a dump that **nothing could restore** -- the same defect class as a
 * heap snapshot with no restore, which this project has already paid for once. So the assertions that
 * matter most are about the SPLITTER, because a mis-split does not error: it replays a truncated
 * statement and leaves a plausible database. That is this project's signature failure and a dump of a
 * Drupal site is full of the thing that triggers it -- serialised config, rendered HTML and watchdog
 * messages all contain semicolons inside quoted strings.
 *
 * Against a real engine via `node:sqlite`, for the same reason `heap-snapshot-sql.spec.ts` is: bound
 * parameters, `RETURNING id` and row ordering are engine behaviour, and each has produced a defect here.
 */

/**
 * The workerd storage surface over a real SQLite, matching `storageOver()` in `migrate-sql.spec.ts`.
 *
 * `transactionSync` is SAVEPOINT because that is the semantic `ctx.storage.transactionSync()` has, and
 * issuing BEGIN as SQL is what the platform refuses. `RETURNING` counts as a read here because
 * `storeImport` gets the import id back off an INSERT.
 */
function storageOver(db: DatabaseSync): { sql: SqlLike; storage: StorageLike } {
	let depth = 0;
	const isRead = (t: string) =>
		/^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(t) || /\bRETURNING\b/i.test(t);

	const sql: SqlLike = {
		exec(text, ...params) {
			const stmt = db.prepare(text);
			if (isRead(text)) {
				const rows = stmt.all(...params) as Record<string, unknown>[];
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

/** the shipped pack's shape, so a restore is exercised against a site that ALREADY migrated */
function packLoader(generation = 'pack-gen') {
	return {
		loadManifest: async () => ({
			generation,
			totals: { chunks: 1, statements: 2, rows: 1 },
			chunks: [{ file: '0' }]
		}),
		loadChunk: async () => ({
			i: 0,
			statements: [
				{ s: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' },
				{ s: `INSERT INTO t (id, v) VALUES (1, 'shipped')` }
			]
		})
	};
}

describe('the splitter, where a silent truncation would live', () => {
	it('splits plain statements', () => {
		expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
	});

	it('does NOT split on a semicolon inside a single-quoted string', () => {
		// the case a naive split gets wrong, and a Drupal dump hits it on the first serialised config
		const dump = `INSERT INTO t VALUES ('a;b'); SELECT 2;`;
		expect(splitSqlStatements(dump)).toEqual([`INSERT INTO t VALUES ('a;b')`, 'SELECT 2']);
	});

	it('handles a DOUBLED quote as an escaped quote, not as a terminator', () => {
		// SQLite escapes a quote by doubling it, so `it''s` is one literal containing an apostrophe;
		// treating the second quote as closing would leave the rest of the dump "outside" a string
		const dump = `INSERT INTO t VALUES ('it''s; fine'); SELECT 2;`;
		expect(splitSqlStatements(dump)).toEqual([
			`INSERT INTO t VALUES ('it''s; fine')`,
			'SELECT 2'
		]);
	});

	it('does not split inside a double-quoted identifier', () => {
		const dump = `CREATE TABLE "we;ird" (a); SELECT 2;`;
		expect(splitSqlStatements(dump)).toEqual([`CREATE TABLE "we;ird" (a)`, 'SELECT 2']);
	});

	it('drops a -- comment even when it contains a semicolon', () => {
		const dump = 'SELECT 1; -- a comment; with a semicolon\nSELECT 2;';
		expect(splitSqlStatements(dump)).toEqual(['SELECT 1', 'SELECT 2']);
	});

	it('keeps a trailing statement with no terminating semicolon', () => {
		expect(splitSqlStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
	});

	it('ignores empty statements and stray whitespace', () => {
		expect(splitSqlStatements(';;  ;\n; SELECT 1;;')).toEqual(['SELECT 1']);
	});

	it('survives a serialised PHP payload, which is the real shape', () => {
		// exactly what config rows hold: braces, colons and semicolons inside one quoted value
		const serialised = `a:2:{s:4:"name";s:9:"CFW Bench";}`;
		const dump = `INSERT INTO config VALUES ('system.site','${serialised}'); SELECT 1;`;
		const out = splitSqlStatements(dump);
		expect(out).toHaveLength(2);
		expect(out[0]).toContain(serialised);
	});
});

describe('storing a dump, and replaying it through the EXISTING migrator loader', () => {
	let db: DatabaseSync;
	let sql: SqlLike;
	let storage: StorageLike;

	beforeEach(() => {
		db = new DatabaseSync(':memory:');
		({ sql, storage } = storageOver(db));
		ensureImportTables(sql);
	});

	const store = (dump: string, opts: { generation: string; perChunk?: number; nowMs?: number }) =>
		storeImport(sql, dump, {
			storage,
			source: 'test',
			nowMs: opts.nowMs ?? 1,
			generation: opts.generation,
			perChunk: opts.perChunk
		});

	it('creates its tables idempotently', () => {
		expect(() => ensureImportTables(sql)).not.toThrow();
	});

	it('chunks by STATEMENT COUNT, not by bytes', () => {
		// the correction that cost two defects: a byte budget does not bound what replay costs
		const dump = Array.from({ length: 95 }, (_, i) => `SELECT ${i};`).join('\n');
		const stored = store(dump, { generation: 'g1', perChunk: 40 });
		expect(stored.statements).toBe(95);
		expect(stored.chunks).toBe(3);
	});

	it('refuses a dump with no statements rather than storing an empty import', () => {
		expect(() => store('  ;; \n', { generation: 'g' })).toThrow(/no statements/);
	});

	it('refuses a statement no replay could execute, BEFORE writing anything', () => {
		// a dump inlines its values, so one oversized blob makes a restore point that dies partway
		// through its own replay. Refusing at store time costs nothing; refusing mid-restore costs
		// a half-overwritten database
		const huge = `INSERT INTO t VALUES ('${'a'.repeat(DO_SQLITE_MAX_STATEMENT_CHARS)}');`;
		expect(() => store(huge, { generation: 'g' })).toThrow(/over the 100000/);
		expect(latestImport(sql)).toBeNull();
	});

	it('reports the newest import', () => {
		store('SELECT 1;', { generation: 'old' });
		store('SELECT 1; SELECT 2;', { generation: 'new', nowMs: 2 });
		const latest = latestImport(sql);
		expect(latest?.generation).toBe('new');
		expect(latest?.statements).toBe(2);
	});

	it('returns null when nothing has been imported', () => {
		expect(latestImport(sql)).toBeNull();
	});

	it('does NOT offer a torn import as a restore point', () => {
		// a rollback onto a restore point missing chunks overwrites the database and then stops, which
		// is strictly worse than staying quarantined
		const whole = store('SELECT 1;', { generation: 'whole' });
		const torn = store('SELECT 1; SELECT 2; SELECT 3; SELECT 4;', {
			generation: 'torn',
			perChunk: 1
		});
		db.exec(`DELETE FROM cfw_import_chunk WHERE import_id = ${torn.id} AND seq = 2`);
		expect(latestImport(sql)?.id).toBe(whole.id);
	});

	it('stores the parent row and every chunk ATOMICALLY', () => {
		// the transaction is what makes a torn restore point impossible to create in the first place
		let calls = 0;
		const failing: StorageLike = {
			transactionSync<T>(cb: () => T): T {
				calls++;
				return storage.transactionSync(() => {
					cb();
					throw new Error('invocation killed midway');
				});
			}
		};
		expect(() =>
			storeImport(sql, 'SELECT 1; SELECT 2; SELECT 3;', {
				storage: failing,
				generation: 'g',
				source: 't',
				nowMs: 1,
				perChunk: 1
			})
		).toThrow(/killed midway/);
		expect(calls).toBe(1);
		expect(sql.exec('SELECT COUNT(*) AS n FROM cfw_import').toArray()[0]).toMatchObject({
			n: 0
		});
		expect(sql.exec('SELECT COUNT(*) AS n FROM cfw_import_chunk').toArray()[0]).toMatchObject({
			n: 0
		});
	});

	it('hands the migrator a manifest whose chunk count matches what was stored', async () => {
		const dump = Array.from({ length: 50 }, (_, i) => `SELECT ${i};`).join('\n');
		const stored = store(dump, { generation: 'g1', perChunk: 20 });
		const manifest = await storedImportLoader(sql, stored.id).loadManifest();
		expect(manifest.chunks).toHaveLength(stored.chunks);
		expect(manifest.totals.chunks).toBe(stored.chunks);
		expect(manifest.totals.statements).toBe(50);
	});

	it('namespaces the generation AND declares itself a replacement', async () => {
		// the namespace alone was not enough: the migrator's done branch never compared generations,
		// so a restore was skipped as already-migrated on every site that had finished migrating
		const stored = store('SELECT 1;', { generation: 'pack-gen' });
		const manifest = await storedImportLoader(sql, stored.id).loadManifest();
		expect(manifest.generation).not.toBe('pack-gen');
		expect(manifest.generation).toContain('import:');
		expect(manifest.replaces).toBe(true);
	});

	it('loads each chunk in the packed {s} shape the migrator already reads', async () => {
		const stored = store('SELECT 1; SELECT 2; SELECT 3;', { generation: 'g', perChunk: 2 });
		const loader = storedImportLoader(sql, stored.id);
		const first = await loader.loadChunk('0', 0);
		expect(first.i).toBe(0);
		expect(first.statements).toEqual([{ s: 'SELECT 1' }, { s: 'SELECT 2' }]);
		const second = await loader.loadChunk('1', 1);
		expect(second.statements).toEqual([{ s: 'SELECT 3' }]);
	});

	it('reports the chunk index it READ, not the one it was asked for', async () => {
		// echoing the argument made the migrator's cross-check compare a value to itself; a probe that
		// cannot fail is not a probe
		const stored = store('SELECT 1; SELECT 2;', { generation: 'g', perChunk: 1 });
		const chunk = await storedImportLoader(sql, stored.id).loadChunk('1', 0);
		expect(chunk.i).toBe(1);
	});

	it('refuses an unknown import and an unknown chunk by NAME rather than returning empty', async () => {
		// an empty chunk would replay as a no-op and the cursor would advance, so a missing chunk has
		// to raise or a partial restore reports success
		await expect(storedImportLoader(sql, 999).loadManifest()).rejects.toThrow(
			/no stored import/
		);
		const stored = store('SELECT 1;', { generation: 'g' });
		await expect(storedImportLoader(sql, stored.id).loadChunk('7', 7)).rejects.toThrow(
			/no chunk 7/
		);
	});

	it('round-trips a dump: split, store, load, and every statement comes back in order', async () => {
		const statements = [
			`CREATE TABLE t (a TEXT)`,
			`INSERT INTO t VALUES ('semi;colon')`,
			`INSERT INTO t VALUES ('quo''te')`,
			`SELECT COUNT(*) FROM t`
		];
		const stored = store(statements.map((s) => `${s};`).join('\n'), {
			generation: 'g',
			perChunk: 2
		});
		const loader = storedImportLoader(sql, stored.id);
		const manifest = await loader.loadManifest();
		const replayed: string[] = [];
		for (const [i, chunk] of manifest.chunks.entries()) {
			const loaded = await loader.loadChunk(chunk.file, i);
			for (const s of loaded.statements ?? []) replayed.push(s.s);
		}
		expect(replayed).toEqual(statements);
	});

	it('has a default chunk size in the range the migrator measured at 0-3 ms', () => {
		expect(IMPORT_STATEMENTS_PER_CHUNK).toBeGreaterThan(0);
		expect(IMPORT_STATEMENTS_PER_CHUNK).toBeLessThanOrEqual(200);
	});
});

/**
 * The direct falsification of "restore's loop is reversed".
 *
 * Every statement here depends on the one before it -- the UPDATE must see the INSERT, the DELETE must
 * see the row it removes -- and they straddle chunk boundaries, so any reversal at either level
 * (chunks replayed backwards, or statements reversed inside a chunk) produces a different final state
 * rather than the same rows in a different order.
 */
describe('the replay order, at both levels', () => {
	it('replays chunks and the statements inside them FORWARD', async () => {
		const db = new DatabaseSync(':memory:');
		const { sql, storage } = storageOver(db);
		const dump = [
			`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`,
			`INSERT INTO t (id, v) VALUES (1, 'one')`,
			`INSERT INTO t (id, v) VALUES (2, 'two')`,
			`INSERT INTO t (id, v) VALUES (3, 'three')`,
			`UPDATE t SET v = 'THREE' WHERE id = 3`,
			`INSERT INTO t (id, v) VALUES (4, 'four')`,
			`DELETE FROM t WHERE id = 1`,
			`INSERT INTO t (id, v) VALUES (5, 'five')`
		]
			.map((s) => `${s};`)
			.join('\n');
		const stored = storeImport(sql, dump, {
			storage,
			generation: 'g1',
			source: 'test',
			nowMs: 1,
			perChunk: 2
		});
		expect(stored.chunks).toBe(4);

		const migrator = new SqlMigrator({ sql, storage, ...storedImportLoader(sql, stored.id) });
		const order: number[] = [];
		for (let r = await migrator.step(); ; r = await migrator.step()) {
			order.push(r.chunk);
			if (r.done) break;
			if (order.length > 10) throw new Error('the replay did not converge');
		}
		expect(order).toEqual([1, 2, 3, 4]);
		expect(db.prepare('SELECT id, v FROM t ORDER BY id').all()).toEqual([
			{ id: 2, v: 'two' },
			{ id: 3, v: 'THREE' },
			{ id: 4, v: 'four' },
			{ id: 5, v: 'five' }
		]);
	});
});

/**
 * The defect a previous session filed as "restore's loop is reversed". It is not: chunk order, cursor
 * advancement and statement order within a chunk are all forward and correct, proven above against
 * order-sensitive statements. The real defect is one layer up.
 *
 * `SqlMigrator.step()` short-circuits on `cursor.state === 'done'` WITHOUT comparing generations, and
 * a restore shares the one `cfw_migrate` cursor row with the pack migration. So on any site that has
 * finished migrating -- which is every site a rollback would ever run on -- a restore returned
 * `{ ok: true, done: true, skipped: 'already migrated' }` and replayed nothing. A rollback reported
 * success and changed no data.
 *
 * The namespaced `import:<id>:<gen>` generation was written to prevent exactly this and could not: the
 * done branch never looks at the generation it is skipping.
 */
describe('a restore over a site that has ALREADY migrated', () => {
	let db: DatabaseSync;
	let sql: SqlLike;
	let storage: StorageLike;

	beforeEach(async () => {
		db = new DatabaseSync(':memory:');
		({ sql, storage } = storageOver(db));
		await new SqlMigrator({ sql, storage, ...packLoader() }).runAll();
		// the site is live and its data has since gone wrong
		db.exec(`UPDATE t SET v = 'CORRUPT' WHERE id = 1`);
	});

	function restorePoint(): number {
		const dump = [
			`DROP TABLE IF EXISTS t`,
			`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`,
			`INSERT INTO t (id, v) VALUES (1, 'restored')`
		]
			.map((s) => `${s};`)
			.join('\n');
		return storeImport(sql, dump, {
			storage,
			generation: 'backup-1',
			source: 'test',
			nowMs: 1,
			perChunk: 2
		}).id;
	}

	it('REPLAYS rather than reporting "already migrated" and changing nothing', async () => {
		const id = restorePoint();
		const result = await new SqlMigrator({
			sql,
			storage,
			...storedImportLoader(sql, id)
		}).runAll();

		expect(result.skipped).toBeUndefined();
		expect(result.applied).toBeGreaterThan(0);
		expect(db.prepare('SELECT v FROM t WHERE id = 1').all()[0]).toMatchObject({
			v: 'restored'
		});
	});

	it('replays one chunk per invocation, the free-plan shape, and resumes', async () => {
		const id = restorePoint();
		const migrator = new SqlMigrator({ sql, storage, ...storedImportLoader(sql, id) });
		let steps = 0;
		for (let r = await migrator.step(); !r.done; r = await migrator.step()) {
			if (++steps > 10) throw new Error('the restore did not converge');
		}
		expect(steps).toBeGreaterThan(0);
		expect(db.prepare('SELECT v FROM t WHERE id = 1').all()[0]).toMatchObject({
			v: 'restored'
		});
	});

	it('does NOT replay the same restore point twice', async () => {
		const id = restorePoint();
		await new SqlMigrator({ sql, storage, ...storedImportLoader(sql, id) }).runAll();
		const again = await new SqlMigrator({
			sql,
			storage,
			...storedImportLoader(sql, id)
		}).runAll();
		expect(again.skipped).toBe('already migrated');
		expect(again.applied).toBe(0);
	});

	it('still refuses to re-run the shipped PACK over a live site', async () => {
		// the done short-circuit is load-bearing for the pack: a redeploy that bumped the generation
		// must not replay a pack over a site that has been running and writing for months
		const result = await new SqlMigrator({
			sql,
			storage,
			...packLoader('pack-gen-v2')
		}).runAll();
		expect(result.skipped).toBe('already migrated');
		expect(db.prepare('SELECT v FROM t WHERE id = 1').all()[0]).toMatchObject({
			v: 'CORRUPT'
		});
	});

	it('refuses to replay a dump over a HALF-migrated database', async () => {
		// a fresh object whose pack migration is unfinished; a restore on top would produce a database
		// that is neither the pack nor the backup
		const fresh = new DatabaseSync(':memory:');
		const other = storageOver(fresh);
		const half = new SqlMigrator({
			sql: other.sql,
			storage: other.storage,
			loadManifest: async () => ({
				generation: 'pack-gen',
				totals: { chunks: 2, statements: 2, rows: 1 },
				chunks: [{ file: '0' }, { file: '1' }]
			}),
			loadChunk: async () => ({ statements: [{ s: 'CREATE TABLE t (id INTEGER)' }] })
		});
		await half.step({ maxChunks: 1 });
		expect(readMigrateCursor(other.sql)?.state).toBe('running');

		const id = storeImport(other.sql, 'SELECT 1;', {
			storage: other.storage,
			generation: 'backup-1',
			source: 'test',
			nowMs: 1
		}).id;
		await expect(
			new SqlMigrator({
				sql: other.sql,
				storage: other.storage,
				...storedImportLoader(other.sql, id)
			}).runAll()
		).rejects.toThrow(/generation mismatch/);
	});
});

// #region the round trip

/**
 * Reads every row of a table through a path the dump was NOT written by.
 *
 * `readRows()` in `scripts/pack-sql.ts` carries the reason and it is the sharpest instrument lesson in
 * this repo: `node:sqlite` returns a TEXT value as a JS string TRUNCATED AT THE FIRST NUL BYTE, and
 * the first version of that gate test compared source against replay THROUGH THAT SAME TRUNCATING
 * API, so both sides read 117 of 1,697 bytes and the digests matched.
 *
 * So this reads `CAST(c AS BLOB)` for the bytes and `setReadBigInts(true)` for the integers, where
 * `dumpDatabase()` reads `hex(c)` and never touches the column. Neither truncates, and they are
 * different mechanisms -- and the round trip additionally pins the bytes against hard-coded constants,
 * so a defect the two instruments somehow shared would still have to survive those.
 */
function readRowsIndependently(db: DatabaseSync, table: string) {
	const quoted = (n: string) => `"${n.replace(/"/g, '""')}"`;
	const columns = db
		.prepare('SELECT name FROM pragma_table_info(?)')
		.all(table)
		.map((r) => String(r.name));
	const select = columns
		.map((c, i) => `typeof(${quoted(c)}) AS t${i}, CAST(${quoted(c)} AS BLOB) AS b${i}`)
		.join(', ');
	const stmt = db.prepare(`SELECT ${select} FROM ${quoted(table)} ORDER BY rowid`);
	stmt.setReadBigInts(true);
	return stmt.all().map((row) =>
		Object.fromEntries(
			columns.map((c, i) => [
				c,
				{
					type: String(row[`t${i}`]),
					hex: Buffer.from((row[`b${i}`] as Uint8Array | null) ?? new Uint8Array())
						.toString('hex')
						.toUpperCase()
				}
			])
		)
	);
}

/** the schema as the engine reports it, so a dropped index or a rewritten DDL cannot pass */
function schemaOf(db: DatabaseSync) {
	return db
		.prepare(
			`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL
			   AND name NOT LIKE 'cfw_import%' AND name <> 'cfw_migrate'
			 ORDER BY type, name`
		)
		.all();
}

/** a source site holding one of every value a naive dump gets wrong */
function buildSource(): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	db.exec(`CREATE TABLE "od""d name" (
		id INTEGER PRIMARY KEY,
		"co""l" TEXT,
		body TEXT,
		payload BLOB,
		amount REAL,
		big INTEGER,
		maybe TEXT
	)`);
	db.exec(`CREATE INDEX idx_body ON "od""d name" (body)`);
	db.exec(`CREATE VIEW v_body AS SELECT id, body FROM "od""d name"`);
	db.exec(`CREATE TABLE empty_table (a TEXT)`);

	const insert = db.prepare(
		`INSERT INTO "od""d name" (id, "co""l", body, payload, amount, big, maybe)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	);
	// a BLOB carrying a raw newline, a NUL and a byte that is not valid UTF-8
	insert.run(
		1,
		'plain',
		'a:2:{s:4:"name";s:9:"CFW Bench";}',
		new Uint8Array([0x41, 0x0a, 0x00, 0x42, 0xff]),
		1.5,
		9007199254740993n,
		''
	);
	// a TEXT value with a single quote, and NULL where the row above has an empty string
	insert.run(2, "it's", "O'Brien said 'hi'; then left", null, -0.5, -9007199254740995n, null);
	// TEXT that itself carries a NUL and a newline -- the case a quoted literal cannot express
	db.exec(
		`INSERT INTO "od""d name" (id, "co""l", body, amount, big, maybe)
		 VALUES (3, CAST(x'41000A42' AS TEXT), CAST(x'6162630064656628' AS TEXT), 2.0, 0, '')`
	);
	// an integral REAL, which must not come back as an INTEGER
	insert.run(4, 'real', 'integral', null, 42, 1, null);
	return db;
}

describe('the round trip: export a database, restore it into a fresh store, compare', () => {
	let source: DatabaseSync;
	let dump: ReturnType<typeof dumpDatabase>;
	let replica: DatabaseSync;

	beforeEach(async () => {
		source = buildSource();
		dump = dumpDatabase(storageOver(source).sql);

		replica = new DatabaseSync(':memory:');
		const { sql, storage } = storageOver(replica);
		const stored = storeImport(sql, dump.sql, {
			storage,
			generation: 'backup-1',
			source: 'test',
			nowMs: 1,
			perChunk: 3
		});
		// one chunk per invocation, which is the free-plan shape and the one that can be interrupted
		const migrator = new SqlMigrator({ sql, storage, ...storedImportLoader(sql, stored.id) });
		for (let r = await migrator.step(), n = 0; !r.done; r = await migrator.step()) {
			if (++n > 200) throw new Error('the restore did not converge');
		}
	});

	it('reproduces the schema, indexes and views included', () => {
		expect(schemaOf(replica)).toEqual(schemaOf(source));
	});

	it('reproduces every value, byte for byte and storage class for storage class', () => {
		expect(readRowsIndependently(replica, 'od"d name')).toEqual(
			readRowsIndependently(source, 'od"d name')
		);
		expect(readRowsIndependently(replica, 'empty_table')).toEqual([]);
	});

	it('carries a BLOB with a raw newline and a NUL, as a BLOB', () => {
		const row = readRowsIndependently(replica, 'od"d name')[0];
		expect(row?.payload).toEqual({ type: 'blob', hex: '410A0042FF' });
	});

	it('carries TEXT containing a single quote', () => {
		const row = readRowsIndependently(replica, 'od"d name')[1];
		expect(row?.['co"l']).toEqual({ type: 'text', hex: '69742773' });
		expect(
			replica.prepare(`SELECT body FROM "od""d name" WHERE id = 2`).all()[0]
		).toMatchObject({ body: "O'Brien said 'hi'; then left" });
	});

	it('carries TEXT containing a NUL, which no quoted literal can express', () => {
		// the value the PHP exporter emits raw into statement text, where SQLite reads the NUL as the
		// end of the string: measured as `unrecognized token`
		const row = readRowsIndependently(replica, 'od"d name')[2];
		expect(row?.['co"l']).toEqual({ type: 'text', hex: '41000A42' });
		expect(row?.body).toEqual({ type: 'text', hex: '6162630064656628' });
	});

	it('carries an integer above 2^53 without going through a double', () => {
		const wide = replica.prepare(`SELECT big FROM "od""d name" WHERE id = 1`);
		wide.setReadBigInts(true);
		expect(wide.all()[0]).toMatchObject({ big: 9007199254740993n });
		const negative = replica.prepare(`SELECT big FROM "od""d name" WHERE id = 2`);
		negative.setReadBigInts(true);
		expect(negative.all()[0]).toMatchObject({ big: -9007199254740995n });
		// and the dump carries the digits bare, so nothing downstream has to un-quote them
		expect(dump.sql).toContain('9007199254740993');
		expect(dump.sql).not.toContain("'9007199254740993'");
	});

	it('keeps an empty string and a NULL apart', () => {
		const rows = readRowsIndependently(replica, 'od"d name');
		expect(rows[0]?.maybe).toEqual({ type: 'text', hex: '' });
		expect(rows[1]?.maybe).toEqual({ type: 'null', hex: '' });
		expect(rows[0]?.payload?.type).toBe('blob');
		expect(rows[1]?.payload?.type).toBe('null');
	});

	it('keeps an integral REAL a REAL', () => {
		// `2.0` emitted as `2` would come back as an INTEGER and change the column's storage class
		const rows = readRowsIndependently(replica, 'od"d name');
		expect(rows[2]?.amount).toEqual({ type: 'real', hex: '322E30' });
		expect(rows[3]?.big).toEqual({ type: 'integer', hex: '31' });
	});

	it('leaves the restore machinery OUT of the dump', () => {
		// a dump carrying `cfw_import_chunk` would contain itself, and one carrying `cfw_migrate`
		// would overwrite the cursor that makes the replay resumable, from inside its own transaction
		for (const table of RESTORE_OWNED_TABLES) expect(dump.sql).not.toContain(table);
		expect(dump.tables).not.toHaveProperty('cfw_migrate');
	});

	it('is replayable a second time over the database it produced', () => {
		// the DROP-then-CREATE shape; a dump that only restores onto an empty database is not a backup
		const { sql, storage } = storageOver(replica);
		const stored = storeImport(sql, dump.sql, {
			storage,
			generation: 'backup-2',
			source: 'test',
			nowMs: 2
		});
		return new SqlMigrator({ sql, storage, ...storedImportLoader(sql, stored.id) })
			.runAll()
			.then(() => {
				expect(readRowsIndependently(replica, 'od"d name')).toEqual(
					readRowsIndependently(source, 'od"d name')
				);
			});
	});
});

describe('the literal encoder, where the storage class is decided', () => {
	it('emits NULL, never an empty string', () => {
		expect(encodeLiteral('null', '', null)).toBe('NULL');
	});

	it('emits an empty TEXT and an empty BLOB differently', () => {
		expect(encodeLiteral('text', '', null)).toBe("''");
		expect(encodeLiteral('blob', '', null)).toBe("x''");
	});

	it('doubles a single quote rather than escaping it with a backslash', () => {
		// SQLite has no backslash escape; `\'` would end the literal and leave the rest of the dump
		// outside a string, which replays as a truncated statement rather than an error
		expect(encodeLiteral('text', Buffer.from("it's").toString('hex'), null)).toBe("'it''s'");
	});

	it('falls back to a byte cast for TEXT that is not valid UTF-8', () => {
		expect(encodeLiteral('text', 'FF', null)).toBe("CAST(x'FF' AS TEXT)");
	});

	it('keeps a leading byte-order mark instead of eating it', () => {
		// the decoder is `ignoreBOM: true` for this and not to satisfy a type: the default STRIPS a
		// leading U+FEFF, so the value would come back three bytes shorter than it went in
		expect(encodeLiteral('text', 'EFBBBF61', null)).toBe("'﻿a'");
	});

	it('keeps an integral REAL from collapsing to an INTEGER', () => {
		expect(encodeLiteral('real', '', 2)).toBe('2.0');
		expect(encodeLiteral('real', '', 1.5)).toBe('1.5');
		expect(encodeLiteral('real', '', Infinity)).toBe('9e999');
		expect(encodeLiteral('real', '', -Infinity)).toBe('-9e999');
		// `${-0}` is "0", which would drop the sign
		expect(encodeLiteral('real', '', -0)).toBe('-0.0');
		// past 1e21 the shortest JS rendering is already exponential, which SQLite reads as a float
		expect(encodeLiteral('real', '', 1e21)).toBe('1e+21');
	});

	it('emits an integer from its own digits, never from a JS number', () => {
		// a Durable Object SQLite integer read is lossy above 2^53, so the digits must not pass
		// through a double on the way out
		const hex = Buffer.from('9007199254740993').toString('hex');
		expect(encodeLiteral('integer', hex, null)).toBe('9007199254740993');
	});
});

/**
 * A restore that dies partway must not leave a database that is neither the old site nor the new one
 * and keeps answering requests.
 *
 * The mechanism is the cursor: a failed chunk rolls back and the cursor is left NOT `done`, and
 * `SiteDO.migratePartial()` in `src/site-do.ts` returns non-null for exactly that state, which makes
 * `/__serve` answer 503 and the alarm chain skip the fill lane. `tests/integration/serve-restore.spec.ts`
 * drives that end of it against a real Durable Object.
 */
describe('a restore that fails partway', () => {
	let db: DatabaseSync;
	let sql: SqlLike;
	let storage: StorageLike;
	let importId: number;

	beforeEach(async () => {
		db = new DatabaseSync(':memory:');
		({ sql, storage } = storageOver(db));
		await new SqlMigrator({ sql, storage, ...packLoader() }).runAll();

		const dump = [
			`DROP TABLE IF EXISTS t`,
			`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`,
			`INSERT INTO t (id, v) VALUES (1, 'restored')`,
			`INSERT INTO nonexistent (id) VALUES (1)`,
			`INSERT INTO t (id, v) VALUES (2, 'never reached')`
		]
			.map((s) => `${s};`)
			.join('\n');
		importId = storeImport(sql, dump, {
			storage,
			generation: 'backup-1',
			source: 'test',
			nowMs: 1,
			perChunk: 2
		}).id;
	});

	const migrator = () => new SqlMigrator({ sql, storage, ...storedImportLoader(sql, importId) });

	it('leaves the cursor NOT done, which is what stops the site serving', async () => {
		await expect(migrator().runAll()).rejects.toThrow(/chunk 1 failed and was rolled back/);
		const cursor = readMigrateCursor(sql);
		expect(cursor?.state).toBe('failed');
		expect(cursor?.state).not.toBe('done');
		expect(Number(cursor?.chunk)).toBeLessThan(Number(cursor?.chunks));
		expect(String(cursor?.error)).toContain('nonexistent');
	});

	it('rolls the failing chunk back whole rather than landing half of it', async () => {
		await expect(migrator().runAll()).rejects.toThrow();
		// `INSERT ... 'restored'` shares the chunk with the bad statement, so it must be gone too --
		// a chunk lands whole or not at all, which is what makes a retry safe
		expect(db.prepare('SELECT COUNT(*) AS n FROM t').all()[0]).toMatchObject({ n: 0 });
		// the chunk BEFORE it committed, so the DROP and the CREATE stand
		expect(readMigrateCursor(sql)?.chunk).toBe(1);
	});

	it('retries the SAME chunk rather than skipping past it', async () => {
		await expect(migrator().runAll()).rejects.toThrow(/chunk 1/);
		const before = readMigrateCursor(sql)?.chunk;
		await expect(migrator().runAll()).rejects.toThrow(/chunk 1/);
		expect(readMigrateCursor(sql)?.chunk).toBe(before);
	});

	it('finishes once the cause is removed, from where it stopped', async () => {
		await expect(migrator().runAll()).rejects.toThrow();
		db.exec('CREATE TABLE nonexistent (id INTEGER)');
		const done = await migrator().runAll();
		expect(done.done).toBe(true);
		expect(readMigrateCursor(sql)?.state).toBe('done');
		expect(db.prepare('SELECT COUNT(*) AS n FROM t').all()[0]).toMatchObject({ n: 2 });
	});
});

// #endregion

describe('what a dump carries and what it deliberately leaves behind', () => {
	function withCaches(): DatabaseSync {
		const db = new DatabaseSync(':memory:');
		db.exec(`CREATE TABLE cache_container (cid TEXT PRIMARY KEY, data BLOB)`);
		db.exec(`CREATE TABLE cachetags (tag TEXT PRIMARY KEY, invalidations INTEGER)`);
		db.exec(`CREATE TABLE cfw_page (path TEXT PRIMARY KEY, html TEXT)`);
		db.exec(`CREATE TABLE node_field_data (nid INTEGER PRIMARY KEY, title TEXT)`);
		db.exec(`INSERT INTO cache_container VALUES ('service_container', x'00')`);
		db.exec(`INSERT INTO cachetags VALUES ('config:core', 3)`);
		db.exec(`INSERT INTO cfw_page VALUES ('/', '<html>cached</html>')`);
		db.exec(`INSERT INTO node_field_data VALUES (1, 'Real content')`);
		return db;
	}

	it('names a regenerable table by pattern, not by a hand-kept list of exact names', () => {
		for (const t of [
			'cache_container',
			'cache_discovery',
			'cachetags',
			'sessions',
			'cfw_page'
		]) {
			expect(isRegenerable(t)).toBe(true);
		}
		// `cache_<bin>` is Drupal's own naming for a cache bin, so the prefix is the right unit;
		// a table that merely starts with the letters is not
		for (const t of ['node_field_data', 'config', 'users', 'cached_items', 'sessions_log']) {
			expect(isRegenerable(t)).toBe(false);
		}
	});

	it('dumps a regenerable table as STRUCTURE ONLY', () => {
		// a stale `cache_container` would boot the restored site on the previous site's service
		// container, and cachetags checksums that disagree with their bins are permanently rejected
		const dump = dumpDatabase(storageOver(withCaches()).sql);
		expect(dump.tables).toMatchObject({
			cache_container: 0,
			cachetags: 0,
			cfw_page: 0,
			node_field_data: 1
		});
		expect(dump.sql).toContain('CREATE TABLE cache_container');
		expect(dump.sql).not.toContain('service_container');
		expect(dump.sql).toContain('Real content');
	});

	it('takes every row when the caller asks for a byte-exact copy', () => {
		const dump = dumpDatabase(storageOver(withCaches()).sql, { includeRows: () => true });
		expect(dump.tables).toMatchObject({ cache_container: 1, cfw_page: 1 });
	});

	it('caps rows per table when asked, without touching the schema', () => {
		const db = withCaches();
		db.exec(`INSERT INTO node_field_data VALUES (2, 'Second'), (3, 'Third')`);
		const dump = dumpDatabase(storageOver(db).sql, { limitPerTable: 2 });
		expect(dump.tables.node_field_data).toBe(2);
		expect(dump.sql).toContain('CREATE TABLE node_field_data');
	});

	it('drops before it creates, so a dump replays onto a database that is not empty', () => {
		const dump = dumpDatabase(storageOver(withCaches()).sql);
		const statements = splitSqlStatements(dump.sql);
		const firstCreate = statements.findIndex((s) => s.startsWith('CREATE TABLE'));
		const lastDrop = statements.map((s) => s.startsWith('DROP ')).lastIndexOf(true);
		expect(lastDrop).toBeLessThan(firstCreate);
	});

	it('builds indexes AFTER the rows, because an index is a write multiplier', () => {
		const db = withCaches();
		db.exec(`CREATE INDEX idx_title ON node_field_data (title)`);
		const statements = splitSqlStatements(dumpDatabase(storageOver(db).sql).sql);
		const lastInsert = statements.map((s) => s.startsWith('INSERT ')).lastIndexOf(true);
		const createIndex = statements.findIndex((s) => s.startsWith('CREATE INDEX'));
		expect(createIndex).toBeGreaterThan(lastInsert);
	});
});

describe('the row at rowid 0, which the keyset used to use as its start sentinel', () => {
	/** Drupal's own shape: the anonymous user is `users` uid 0, and uid IS the rowid */
	function withAnonymous(): DatabaseSync {
		const db = new DatabaseSync(':memory:');
		db.exec(`CREATE TABLE users (uid INTEGER PRIMARY KEY, uuid TEXT, langcode TEXT)`);
		db.exec(`INSERT INTO users VALUES (0, 'anon-uuid', 'en'), (1, 'admin-uuid', 'en')`);
		return db;
	}

	it('EXPORTS it, rather than starting the keyset past it', () => {
		// `WHERE _rowid_ > ?` from a cursor of 0 skips rowid 0, and a rowid is signed so no number
		// means "before every row". Measured on the shipped pack before the fix: `users` held 2 rows
		// and the dump carried 1, so every backup silently lost the anonymous user
		const dump = dumpDatabase(storageOver(withAnonymous()).sql);
		expect(dump.tables.users).toBe(2);
		expect(dump.sql).toContain(`VALUES (0, 'anon-uuid', 'en')`);
	});

	it('carries it through a CHUNKED export as well, where the cursor is what resumes', () => {
		// one row per chunk, so the first boundary lands immediately after rowid 0
		const { sql } = storageOver(withAnonymous());
		let cursor: DumpCursor = DUMP_START;
		const parts: string[] = [];
		for (let guard = 0; guard < 50; guard++) {
			const chunk = dumpChunk(sql, cursor, { maxCharsPerChunk: 1, maxLiteralChars: 64 });
			if (chunk.sql) parts.push(chunk.sql);
			if (chunk.done) break;
			cursor = chunk.cursor;
		}
		const text = parts.join('\n');
		expect(text).toContain(`VALUES (0, 'anon-uuid', 'en')`);
		expect(text).toContain(`VALUES (1, 'admin-uuid', 'en')`);
	});

	it('keeps a NEGATIVE rowid too, which the same comparison also excluded', () => {
		const db = withAnonymous();
		db.exec(`INSERT INTO users VALUES (-5, 'negative-uuid', 'en')`);
		const dump = dumpDatabase(storageOver(db).sql);
		expect(dump.tables.users).toBe(3);
		expect(dump.sql).toContain(`VALUES (-5, 'negative-uuid', 'en')`);
	});
});
