import type { SqlLike } from './migrate-sql';

/**
 * The export half of backup/restore, on the HOST side rather than in PHP.
 *
 * `exportDatabase()` in `src/drupal/site-php.ts` predates this and reads through the driver's bridge,
 * which costs an interpreter boot and cannot represent three of the five storage classes it meets:
 * it has no BLOB branch at all, so a blob is emitted as a quoted TEXT literal and changes storage
 * class; a value carrying a NUL is emitted raw into statement text, which SQLite parses as the end of
 * the string (measured: `unrecognized token`); and its `^-?[0-9]{1,18}$` test sends a 19-digit integer
 * out as a quoted string.
 *
 * So every value here is read as `typeof()` plus `hex()` and never as the column itself. That is the
 * same discipline as `readRows()` in `scripts/pack-sql.ts` and for a stronger reason: a Durable Object
 * SQLite integer read is LOSSY above 2^53, and `hex()` of an integer returns the hex of its exact
 * decimal rendering, so the digits never pass through a double. REAL is the one class read directly,
 * because a double crosses into JS exactly and its text rendering does not round-trip.
 */

/**
 * Tables the restore path itself lives in.
 *
 * Excluded outright -- no DDL, no DROP, no rows. A dump that carried `cfw_import_chunk` would contain
 * itself, and one that carried `cfw_migrate` would have a replay overwrite the very cursor that makes
 * the replay resumable, from inside the transaction that cursor is protecting.
 */
export const RESTORE_OWNED_TABLES = ['cfw_migrate', 'cfw_import', 'cfw_import_chunk'];

/**
 * Tables dumped as STRUCTURE ONLY, following drush's `--structure-tables-key=common`.
 *
 * Not a size optimisation. Restoring a stale `cache_container` would boot the restored site on the
 * previous site's service container, and `cachetags` checksums that disagree with the bins they
 * describe leave rows that are present and permanently rejected -- the failure shape the pack
 * provenance notes already record. All of it regenerates.
 *
 * It also happens to be what makes a real site's dump storable at all: measured on the shipped pack,
 * the seven statements over the 100,000-character Durable Object ceiling are ALL cache rows, the
 * largest 960,544 characters of `cache_container`. With them structure-only the widest statement left
 * is 89,364.
 */
export const REGENERABLE_TABLES = [
	/^cache(_|$)/,
	/^cachetags$/,
	/^sessions$/,
	/^semaphore$/,
	/^flood$/,
	/^queue$/,
	/^watchdog$/,
	/^history$/,
	/^search_(dataset|index|total)$/,
	// the host's own rendered-page cache; a restored database renders different pages
	/^cfw_page$/
];

/** whether a table's rows regenerate, so a dump carries its schema and not its contents */
export function isRegenerable(table: string): boolean {
	return REGENERABLE_TABLES.some((p) => p.test(table));
}

export interface DumpOptions {
	/** rows per table, for a cheap sample; 0 or absent is every row */
	limitPerTable?: number;
	/**
	 * Rows-only filter, defaulting to `!isRegenerable`. DDL is always emitted, so a trimmed dump
	 * still restores the whole schema. Pass `() => true` for a byte-exact copy.
	 */
	includeRows?: (table: string) => boolean;
}

export interface DumpResult {
	sql: string;
	statements: number;
	/** characters, not bytes -- a UTF-8 literal is wider on the wire than it is here */
	chars: number;
	/** rows emitted per table, including the tables that emitted none */
	tables: Record<string, number>;
}

interface MasterRow {
	type: string;
	name: string;
	tbl_name: string;
	sql: string;
}

/** `"` doubled, which is how SQLite escapes an identifier */
function ident(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** `'` doubled, which is how SQLite escapes a string literal */
function quote(text: string): string {
	return `'${text.replace(/'/g, "''")}'`;
}

function bytesFromHex(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length >> 1);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

// fatal, so TEXT that is not valid UTF-8 is caught rather than replaced with U+FFFD and shipped
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * One column value as a SQL literal that replays back to the same bytes AND the same storage class.
 *
 * @param type the value's own `typeof()`, not the column's declared type -- SQLite types values, not
 *   columns, so one column can hold all five
 * @param hex `hex()` of the value: the raw bytes for a blob, and the bytes of the exact text rendering
 *   for text and integer
 * @param real the column read directly, and ONLY ever a real; see the CASE guard in `rowReader`
 */
export function encodeLiteral(type: string, hex: string, real: number | null): string {
	if (type === 'null') return 'NULL';
	if (type === 'real') {
		const n = Number(real);
		if (n === Infinity) return '9e999';
		if (n === -Infinity) return '-9e999';
		if (Object.is(n, -0)) return '-0.0';
		// an integral double must keep its `.0` or SQLite stores it back as INTEGER
		return Number.isInteger(n) && Math.abs(n) < 1e21 ? `${n}.0` : String(n);
	}
	// hex() of an integer is its decimal rendering, so the digits never touch a double
	if (type === 'integer') return strictUtf8.decode(bytesFromHex(hex));
	if (type === 'blob') return `x'${hex}'`;

	const bytes = bytesFromHex(hex);
	let text: string;
	try {
		text = strictUtf8.decode(bytes);
	} catch {
		// TEXT holding bytes that are not valid UTF-8; the cast keeps the bytes and the class
		return `CAST(x'${hex}' AS TEXT)`;
	}
	// a NUL inside statement text ends the literal as far as the parser is concerned
	return text.includes('\0') ? `CAST(x'${hex}' AS TEXT)` : quote(text);
}

/** the three-way SELECT for one table, and the CASE that keeps a wide integer out of a JS number */
function rowReader(table: string, columns: string[], limit: number): string {
	const select = columns
		.map(
			(c, i) =>
				`typeof(${ident(c)}) AS t${i}, hex(${ident(c)}) AS h${i}, ` +
				`CASE WHEN typeof(${ident(c)}) = 'real' THEN ${ident(c)} END AS r${i}`
		)
		.join(', ');
	return `SELECT ${select} FROM ${ident(table)}${limit > 0 ? ` LIMIT ${limit}` : ''}`;
}

/** column names in declaration order; the table-valued form binds the name rather than quoting it */
export function tableColumns(sql: SqlLike, table: string): string[] {
	return sql
		.exec('SELECT name FROM pragma_table_info(?)', table)
		.toArray()
		.map((r) => String(r.name));
}

/**
 * Dumps the object's SQL as replayable statements.
 *
 * Ordered drops, then tables, then rows, then indexes and views and triggers. Indexes come LAST
 * because every index on a table is another charged row per insert, and rows written is the meter that
 * binds regeneration -- building them after the data costs one pass instead of one per row.
 */
export function dumpDatabase(sql: SqlLike, opts: DumpOptions = {}): DumpResult {
	const limit = Number.isInteger(opts.limitPerTable) ? Number(opts.limitPerTable) : 0;
	const includeRows = opts.includeRows ?? ((t: string) => !isRegenerable(t));
	const owned = new Set(RESTORE_OWNED_TABLES);

	const master = sql
		.exec(
			`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL
			 ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, name`
		)
		.toArray() as unknown as MasterRow[];

	const drops: string[] = [];
	const tableDdl: string[] = [];
	const laterDdl: string[] = [];
	const tables: string[] = [];

	for (const row of master) {
		const name = String(row.name ?? '');
		const owner = String(row.tbl_name ?? name);
		// engine-owned objects refuse to be created, and miniflare adds its own bookkeeping
		if (!name || name.startsWith('sqlite_') || name.startsWith('__miniflare')) continue;
		if (owned.has(name) || owned.has(owner)) continue;
		const ddl = `${String(row.sql).replace(/;+\s*$/, '')};`;
		if (row.type === 'table') {
			drops.push(`DROP TABLE IF EXISTS ${ident(name)};`);
			tableDdl.push(ddl);
			tables.push(name);
			continue;
		}
		const keyword = row.type === 'view' ? 'VIEW' : row.type === 'trigger' ? 'TRIGGER' : 'INDEX';
		// dropped before the tables, since dropping a table takes its indexes and triggers with it
		drops.unshift(`DROP ${keyword} IF EXISTS ${ident(name)};`);
		laterDdl.push(ddl);
	}

	const rows: string[] = [];
	const counts: Record<string, number> = {};
	for (const table of tables) {
		counts[table] = 0;
		if (!includeRows(table)) continue;
		const columns = tableColumns(sql, table);
		if (columns.length === 0) continue;
		const names = columns.map(ident).join(', ');
		for (const raw of sql.exec(rowReader(table, columns, limit)).toArray()) {
			const values = columns.map((_, i) =>
				encodeLiteral(
					String(raw[`t${i}`]),
					String(raw[`h${i}`] ?? ''),
					raw[`r${i}`] as number | null
				)
			);
			rows.push(`INSERT INTO ${ident(table)} (${names}) VALUES (${values.join(', ')});`);
			counts[table]++;
		}
	}

	const lines = [...drops, ...tableDdl, ...rows, ...laterDdl];
	const dump = lines.join('\n');
	return { sql: dump, statements: lines.length, chars: dump.length, tables: counts };
}
