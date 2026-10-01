/**
 * The other half of `/export`: replaying a SQL dump back into a Durable Object.
 * Chunks are bounded by statement count, not bytes (a byte budget does not bound replay cost).
 * @module
 */
import { firstRow } from '../util/sql';
import { DO_SQLITE_MAX_STATEMENT_CHARS } from './heap-store';
import type {
	MigrationChunk,
	MigrationLoader,
	MigrationManifest,
	SqlLike,
	StorageLike
} from './migrate-sql';

/** statements per import chunk; the migration pack uses comparable units at 0-3 ms each */
export const IMPORT_STATEMENTS_PER_CHUNK = 40;

/** the DDL for the import tables: one parent row per dump and one row per replay chunk */
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

/** creates the import tables if missing */
export function ensureImportTables(sql: SqlLike): void {
	for (const statement of IMPORT_DDL.split(';')) {
		const trimmed = statement.trim();
		if (trimmed.length > 0) sql.exec(`${trimmed};`);
	}
}

/**
 * Splits a SQL dump into statements, quote-aware: a Drupal dump has `;` inside strings, and a
 * naive split would replay truncated statements without erroring. A doubled quote (`''`) inside a
 * quoted run is content, not a terminator.
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
				// a doubled quote is an escape: consume both and stay in the literal
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
		// a `--` comment runs to end of line and may contain a semicolon
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

/** a stored dump: its row id, chunk and statement counts, and generation label */
export type StoredImport = {
	id: number;
	chunks: number;
	statements: number;
	generation: string;
};

/** a statement no replay could execute, refused at store time rather than mid-restore */
export class ImportStatementTooLongError extends Error {
	/** the offending statement's position in the dump */
	index: number;
	/** its length in characters */
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
 * Atomic: the parent row and every chunk commit together, or a killed invocation leaves a row
 * claiming N chunks that `latestImport()` offers as a restore point, and the replay would stop
 * at the first missing chunk with the database half overwritten.
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

	// checked before any write, so an unreplayable dump costs nothing (one big blob is enough)
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
		const row = firstRow(
			sql.exec(
				`INSERT INTO cfw_import
					(created_at, generation, total_chunks, total_statements, source)
				 VALUES (?, ?, ?, ?, ?) RETURNING id`,
				opts.nowMs,
				opts.generation,
				chunks.length,
				statements.length,
				opts.source
			)
		) as { id: number | bigint } | undefined;
		const assigned = Number(row?.id ?? 0);
		if (assigned === 0) throw new Error('the import row did not come back with an id');

		chunks.forEach((group, seq) => {
			sql.exec(
				'INSERT OR REPLACE INTO cfw_import_chunk (import_id, seq, statements) VALUES (?, ?, ?)',
				assigned,
				seq,
				// the migrator's packed shape {s, p?}; no params since a dump inlines its values
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
 * The newest complete stored import, or undefined.
 * `shouldRollback()` reads it as a restore point that exists, so a torn row (fewer chunks than
 * claimed) must not count; `storeImport()` is atomic, so this guards rows written before that.
 */
export function latestImport(sql: SqlLike): StoredImport | undefined {
	ensureImportTables(sql);
	const row = firstRow(
		sql.exec(
			`SELECT i.id, i.generation, i.total_chunks, i.total_statements
			 FROM cfw_import i
			 WHERE i.total_chunks =
				(SELECT COUNT(*) FROM cfw_import_chunk c WHERE c.import_id = i.id)
			 ORDER BY i.id DESC LIMIT 1`
		)
	) as
		| {
				id: number | bigint;
				generation: string;
				total_chunks: number | bigint;
				total_statements: number | bigint;
		  }
		| undefined;
	if (!row) return undefined;
	return {
		id: Number(row.id),
		generation: String(row.generation),
		chunks: Number(row.total_chunks),
		statements: Number(row.total_statements)
	};
}

/**
 * A `MigrationLoader` over a stored import, so the existing migrator replays it unchanged;
 * `chunks[].file` is the seq as a string (the migrator treats it as an opaque handle).
 */
export function storedImportLoader(sql: SqlLike, importId: number): MigrationLoader {
	return {
		async loadManifest(): Promise<MigrationManifest> {
			const row = firstRow(
				sql.exec(
					'SELECT generation, total_chunks, total_statements FROM cfw_import WHERE id = ?',
					importId
				)
			) as
				| {
						generation: string;
						total_chunks: number | bigint;
						total_statements: number | bigint;
				  }
				| undefined;
			if (!row) throw new Error(`no stored import ${importId}`);
			const chunks = Number(row.total_chunks);
			return {
				// the import's own generation, so the migrator cannot skip it as the shipped pack
				generation: `import:${importId}:${row.generation}`,
				// a backup may replay over a finished, different generation (else skipped)
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
			const row = firstRow(
				sql.exec(
					'SELECT seq, statements FROM cfw_import_chunk WHERE import_id = ? AND seq = ?',
					importId,
					Number(file)
				)
			) as { seq: number | bigint; statements: string } | undefined;
			if (!row) throw new Error(`stored import ${importId} has no chunk ${file}`);
			// `i` is read back from the row (echoing the argument makes the cross-check vacuous)
			return { i: Number(row.seq), statements: JSON.parse(String(row.statements)) };
		}
	};
}
