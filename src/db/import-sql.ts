import { DO_SQLITE_MAX_STATEMENT_CHARS } from './heap-store';
import type {
	MigrationChunk,
	MigrationLoader,
	MigrationManifest,
	SqlLike,
	StorageLike
} from './migrate-sql';

/**
 * The other half of `/export`, which had none: replaying a dump back into a Durable Object.
 *
 * The chunk SIZE is bounded by statement count rather than by bytes, following the correction that
 * cost two separate defects: a text-byte budget does not bound what replaying a statement costs. See
 * "a chunk sized by the wrong quantity" in `TECHNICAL_REPORT.md`.
 */

/** statements per import chunk; the migration pack uses comparable units and measures 0-3 ms each */
export const IMPORT_STATEMENTS_PER_CHUNK = 40;

export const IMPORT_DDL = `
CREATE TABLE IF NOT EXISTS cfw_import (
	id INTEGER PRIMARY KEY,
	created_at INTEGER NOT NULL,
	generation TEXT NOT NULL,
	total_chunks INTEGER NOT NULL,
	total_statements INTEGER NOT NULL,
	source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cfw_import_chunk (
	import_id INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	statements TEXT NOT NULL,
	PRIMARY KEY (import_id, seq)
);
`.trim();

export function ensureImportTables(sql: SqlLike): void {
	for (const statement of IMPORT_DDL.split(';')) {
		const trimmed = statement.trim();
		if (trimmed.length > 0) sql.exec(`${trimmed};`);
	}
}

/**
 * Splits a SQL dump into individual statements.
 *
 * Quote-aware, because a naive split on `;` breaks the moment a dump contains one inside a string --
 * and a Drupal dump certainly does: serialised config, rendered HTML and watchdog messages are full of
 * them. Getting this wrong would not error; it would replay a truncated statement and leave a
 * plausible database, which is this project's signature failure.
 *
 * SQLite string literals escape a quote by doubling it, so a `''` inside a quoted run is content and
 * not a terminator.
 */
export function splitSqlStatements(dump: string): string[] {
	const out: string[] = [];
	let current = '';
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < dump.length; i++) {
		const ch = dump[i] as string;

		if (inSingle) {
			current += ch;
			if (ch === "'") {
				// a doubled quote is an escaped quote, so consume both and stay inside the literal
				if (dump[i + 1] === "'") {
					current += "'";
					i++;
				} else {
					inSingle = false;
				}
			}
			continue;
		}
		if (inDouble) {
			current += ch;
			if (ch === '"') {
				if (dump[i + 1] === '"') {
					current += '"';
					i++;
				} else {
					inDouble = false;
				}
			}
			continue;
		}

		if (ch === "'") {
			inSingle = true;
			current += ch;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			current += ch;
			continue;
		}
		// a `--` comment runs to end of line and may legally contain a semicolon
		if (ch === '-' && dump[i + 1] === '-') {
			const nl = dump.indexOf('\n', i);
			i = nl === -1 ? dump.length : nl;
			continue;
		}
		if (ch === ';') {
			const statement = current.trim();
			if (statement.length > 0) out.push(statement);
			current = '';
			continue;
		}
		current += ch;
	}

	const tail = current.trim();
	if (tail.length > 0) out.push(tail);
	return out;
}

export type StoredImport = {
	id: number;
	chunks: number;
	statements: number;
	generation: string;
};

/** a statement no replay could ever execute, named at STORE time rather than mid-restore */
export class ImportStatementTooLongError extends Error {
	index: number;
	chars: number;

	constructor(index: number, chars: number) {
		super(
			`statement ${index} is ${chars} characters, over the ${DO_SQLITE_MAX_STATEMENT_CHARS} ` +
				`Durable Object SQLite allows. Storing it would build a restore point that fails partway ` +
				`through its own replay, with the database already half overwritten.`
		);
		this.name = 'ImportStatementTooLongError';
		this.index = index;
		this.chars = chars;
	}
}

/**
 * Stores a dump as replay chunks and returns what a loader will find.
 *
 * ATOMIC, for the same reason the replay is: the parent row and every chunk commit together or not at
 * all. Without that, an invocation killed midway leaves a `cfw_import` row claiming N chunks with
 * fewer than N stored -- and that row is what `latestImport()` offers a rollback as a restore point.
 * The replay would start, run until the first missing chunk, and stop with the database half
 * overwritten and the backup only partly applied.
 *
 * @param sql the object's own SQL
 * @param dump the SQL text, as `dumpDatabase()` or `/export` produces it
 * @param opts `storage` supplies the transaction; `generation` labels the import; `source` records
 *   where it came from, for the audit trail a rollback needs
 */
export function storeImport(
	sql: SqlLike,
	dump: string,
	opts: {
		storage: StorageLike;
		generation: string;
		source: string;
		nowMs: number;
		perChunk?: number;
	}
): StoredImport {
	ensureImportTables(sql);
	const statements = splitSqlStatements(dump);
	if (statements.length === 0) throw new Error('dump contains no statements');

	// checked before anything is written, so an unreplayable dump costs nothing and is refused by
	// NAME. A dump inlines its values as literals, so one oversized blob is all it takes
	statements.forEach((s, i) => {
		if (s.length > DO_SQLITE_MAX_STATEMENT_CHARS) {
			throw new ImportStatementTooLongError(i, s.length);
		}
	});

	const perChunk = Math.max(1, opts.perChunk ?? IMPORT_STATEMENTS_PER_CHUNK);
	const chunks: string[][] = [];
	for (let i = 0; i < statements.length; i += perChunk) {
		chunks.push(statements.slice(i, i + perChunk));
	}

	const id = opts.storage.transactionSync(() => {
		const row = sql
			.exec(
				`INSERT INTO cfw_import
					(created_at, generation, total_chunks, total_statements, source)
				 VALUES (?, ?, ?, ?, ?) RETURNING id`,
				opts.nowMs,
				opts.generation,
				chunks.length,
				statements.length,
				opts.source
			)
			.toArray()[0] as { id: number | bigint } | undefined;
		const assigned = Number(row?.id ?? 0);
		if (assigned === 0) throw new Error('the import row did not come back with an id');

		chunks.forEach((group, seq) => {
			sql.exec(
				'INSERT OR REPLACE INTO cfw_import_chunk (import_id, seq, statements) VALUES (?, ?, ?)',
				assigned,
				seq,
				// the packed shape the migrator already reads: {s, p?}. No params, because a dump
				// inlines its values -- which is also why a chunk is bounded by statement COUNT here
				JSON.stringify(group.map((s) => ({ s })))
			);
		});
		return assigned;
	});

	return {
		id,
		chunks: chunks.length,
		statements: statements.length,
		generation: opts.generation
	};
}

/**
 * The newest COMPLETE stored import, or null.
 *
 * Completeness is checked rather than assumed, because this is the value `shouldRollback()` reads as
 * "a restore point that actually exists" and a torn one does not exist as a restore point -- it is a
 * database that gets half overwritten and then stops. `storeImport()` is atomic now, so a torn row
 * cannot be created any more; this stays as the guard for one written before it was.
 */
export function latestImport(sql: SqlLike): StoredImport | null {
	ensureImportTables(sql);
	const row = sql
		.exec(
			`SELECT i.id, i.generation, i.total_chunks, i.total_statements
			 FROM cfw_import i
			 WHERE i.total_chunks =
				(SELECT COUNT(*) FROM cfw_import_chunk c WHERE c.import_id = i.id)
			 ORDER BY i.id DESC LIMIT 1`
		)
		.toArray()[0] as
		| {
				id: number | bigint;
				generation: string;
				total_chunks: number | bigint;
				total_statements: number | bigint;
		  }
		| undefined;
	if (!row) return null;
	return {
		id: Number(row.id),
		generation: String(row.generation),
		chunks: Number(row.total_chunks),
		statements: Number(row.total_statements)
	};
}

/**
 * A `MigrationLoader` over a stored import, so the existing migrator replays it unchanged.
 *
 * `chunks[].file` is the seq as a string. The migrator treats `file` as an opaque handle it hands
 * back to `loadChunk`, so nothing needs a filesystem or a fetch.
 */
export function storedImportLoader(sql: SqlLike, importId: number): MigrationLoader {
	return {
		async loadManifest(): Promise<MigrationManifest> {
			const row = sql
				.exec(
					'SELECT generation, total_chunks, total_statements FROM cfw_import WHERE id = ?',
					importId
				)
				.toArray()[0] as
				| {
						generation: string;
						total_chunks: number | bigint;
						total_statements: number | bigint;
				  }
				| undefined;
			if (!row) throw new Error(`no stored import ${importId}`);
			const chunks = Number(row.total_chunks);
			return {
				// the generation is the IMPORT's, not the pack's, so a replayed dump cannot be mistaken
				// for the shipped migration and skipped as already-done
				generation: `import:${importId}:${row.generation}`,
				// a backup is the one thing allowed to replay over a finished, different generation;
				// without this the migrator skips the whole restore as "already migrated"
				replaces: true,
				totals: {
					chunks,
					statements: Number(row.total_statements),
					rows: Number(row.total_statements)
				},
				chunks: Array.from({ length: chunks }, (_, seq) => ({ file: String(seq) }))
			};
		},
		async loadChunk(file: string): Promise<MigrationChunk> {
			const row = sql
				.exec(
					'SELECT seq, statements FROM cfw_import_chunk WHERE import_id = ? AND seq = ?',
					importId,
					Number(file)
				)
				.toArray()[0] as { seq: number | bigint; statements: string } | undefined;
			if (!row) throw new Error(`stored import ${importId} has no chunk ${file}`);
			// `i` is the seq READ BACK from the row, never the index the caller asked for. Echoing the
			// argument made the migrator's cross-check compare a value to itself, so it could not fail
			return { i: Number(row.seq), statements: JSON.parse(String(row.statements)) };
		}
	};
}
