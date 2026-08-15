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
 * Name prefixes belonging to something other than the site.
 *
 * `sqlite_` is the engine's and refuses to be created; `__miniflare` is the local test harness's;
 * `_cf_` is the Durable Object runtime's and is the one that BITES -- the authorizer refuses to read
 * `_cf_METADATA` at all, so a single `SELECT` against it fails the entire dump with
 * `not authorized: SQLITE_AUTH` rather than returning nothing.
 */
export const RUNTIME_OWNED_PREFIXES = ['sqlite_', '__miniflare', '_cf_'];

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
	/**
	 * Largest literal a single statement may carry before the value is built across appends.
	 *
	 * Below the Durable Object's own 100,000-character ceiling by default, because the literal is
	 * not the whole statement -- the INSERT around it costs characters too.
	 */
	maxLiteralChars?: number;
	/** characters per chunk for {@link dumpChunk}; see {@link DUMP_CHARS_PER_CHUNK} */
	maxCharsPerChunk?: number;
}

/**
 * Default literal budget: comfortably inside the statement ceiling, with room for the statement.
 *
 * Half the ceiling rather than just under it, because an append statement carries the WHERE clause
 * addressing the row as well as the slice, and a composite key makes that clause long.
 */
export const DEFAULT_LITERAL_BUDGET = 40_000;

/** `x'4142'` to `'4142'`: the same digits as an ordinary string, for accumulation before unhex() */
function hexBody(literal: string): string {
	const hex = /^x'([0-9A-Fa-f]*)'$/.exec(literal);
	return hex ? `'${hex[1]}'` : literal;
}

/** the primary-key columns, which are what an append addresses a row by */
function primaryKeyColumns(sql: SqlLike, table: string): string[] {
	return sql
		.exec('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk', table)
		.toArray()
		.map((r) => String((r as Record<string, unknown>).name));
}

/**
 * Cuts an encoded literal into pieces each of which fits the budget.
 *
 * Splits INSIDE the quotes and keeps each piece a valid literal of the same kind, so concatenating
 * them reproduces the value exactly. A hex literal `x'..'` is cut on BYTE boundaries -- an odd cut
 * would produce an invalid hex string -- and a text literal is cut on whole characters so a
 * multi-byte sequence is never halved.
 */
export function sliceLiteral(literal: string, budget: number): string[] {
	const hex = /^x'([0-9A-Fa-f]*)'$/.exec(literal);
	if (hex) {
		const body = hex[1] as string;
		// two hex chars per byte, so the slice width is rounded down to an even number
		const width = Math.max(2, (budget - 4) & ~1);
		const out: string[] = [];
		for (let at = 0; at < body.length; at += width) {
			out.push(`x'${body.slice(at, at + width)}'`);
		}
		return out.length ? out : [`x''`];
	}
	const text = /^'([\s\S]*)'$/.exec(literal);
	if (text) {
		const body = text[1] as string;
		const width = Math.max(1, budget - 2);
		const out: string[] = [];
		let buf = '';
		for (const ch of body) {
			// never cut between a doubled quote pair, which would produce an unterminated literal
			if (buf.length + ch.length > width && !buf.endsWith("'")) {
				out.push(`'${buf}'`);
				buf = '';
			}
			buf += ch;
		}
		if (buf) out.push(`'${buf}'`);
		return out.length ? out : [`''`];
	}
	// a bare number or NULL is never over budget, so it is returned whole
	return [literal];
}

export interface DumpResult {
	sql: string;
	statements: number;
	/** characters, not bytes -- a UTF-8 literal is wider on the wire than it is here */
	chars: number;
	/** rows emitted per table, including the tables that emitted none */
	tables: Record<string, number>;
	/**
	 * The widest single statement, and whether the dump can be replayed at all.
	 *
	 * A Durable Object caps statement text at 100,000 characters, and `/export?all=1` happily emits
	 * a `cache_container` row measured at 960,544. The dump looked fine, stored fine, and would have
	 * failed mid-restore -- on the one path whose whole job is getting a customer's data back. A
	 * restore point nobody can replay is worse than none, because it reads as a backup.
	 */
	maxStatementChars: number;
	/** false when any statement exceeds the ceiling, so a caller can refuse before storing it */
	replayable: boolean;
	/** values too wide for one statement, rebuilt with `col = col || ...` appends */
	splitValues: number;
	/**
	 * The tables emitted STRUCTURE-ONLY, resolved rather than described.
	 *
	 * `REGENERABLE_TABLES` is a list of regexes in this file, so anything outside it had to restate
	 * the rule in prose and go stale silently when the list changed. Naming the tables the rule
	 * actually matched makes an off-boarding report correct by construction.
	 */
	structureOnly: string[];
	/**
	 * Tables paged by OFFSET rather than by a keyset, because they are `WITHOUT ROWID`.
	 *
	 * Named rather than silent: OFFSET paging re-scans, and it can repeat or skip a row if the site
	 * writes while the export is in flight. Empty on every schema this ships with.
	 */
	offsetPaged: string[];
}

/** the Durable Object ceiling on statement text; see DEEP DIVE B */
export const DO_MAX_STATEMENT_CHARS = 100_000;

/**
 * The Durable Object ceiling on a single stored record.
 *
 * Reported alongside the statement cap because they bite at different sizes and a migration has to
 * score against both: a value can sit comfortably inside the record cap and still be unexportable,
 * since inlining it as a SQL literal costs two hex characters per byte.
 */
export const DO_MAX_RECORD_BYTES = 2_199_995;

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

/**
 * The same SELECT, positioned.
 *
 * KEYSET, not OFFSET, wherever the table has a rowid. `LIMIT n OFFSET k` re-scans k rows on every
 * resume, so a table exported in c chunks costs O(c^2) reads, and it silently repeats or skips a row
 * if the site writes while the export is in flight -- which it will, because a site being exported
 * is a site that is still serving.
 *
 * A `WITHOUT ROWID` table has no keyset to use, so it falls back to OFFSET and says so through
 * {@link DumpChunk.offsetPaged}. Nothing in Drupal or in this host declares one today; the fallback
 * exists so a contrib module that does cannot produce a silently wrong export.
 */
function pagedRowReader(table: string, columns: string[], keyed: boolean, batch: number): string {
	const select = columns
		.map(
			(c, i) =>
				`typeof(${ident(c)}) AS t${i}, hex(${ident(c)}) AS h${i}, ` +
				`CASE WHEN typeof(${ident(c)}) = 'real' THEN ${ident(c)} END AS r${i}`
		)
		.join(', ');
	if (!keyed) {
		return `SELECT ${select} FROM ${ident(table)} LIMIT ${batch} OFFSET ?`;
	}
	return (
		`SELECT _rowid_ AS __rid, ${select} FROM ${ident(table)} ` +
		`WHERE _rowid_ > ? ORDER BY _rowid_ LIMIT ${batch}`
	);
}

/** `WITHOUT ROWID` is a table-level clause, so the DDL is the only place it is visible */
function hasRowid(ddl: string): boolean {
	return !/\)\s*WITHOUT\s+ROWID\s*;?\s*$/i.test(ddl);
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
	const lines: string[] = [];
	const counts: Record<string, number> = {};
	let splitValues = 0;
	let structureOnly: string[] = [];
	let offsetPaged: string[] = [];
	let cursor: DumpCursor = DUMP_START;
	// carried from the chunks rather than re-derived from the joined text: a `CREATE TABLE` out of
	// `sqlite_master` spans several lines, so counting newlines reports more statements than exist
	// and measures the widest LINE where the ceiling applies to the widest STATEMENT
	let statements = 0;
	let maxStatementChars = 0;
	let replayable = true;

	// the one-shot dump IS the chunked one, run to exhaustion. Not a convenience: two code paths
	// producing "the same" statements is how the chunked half drifts into producing a dump that no
	// longer restores, and nothing notices until someone tries to leave with their data
	for (let guard = 0; guard < MAX_DUMP_CHUNKS; guard++) {
		const chunk = dumpChunk(sql, cursor, opts);
		if (chunk.sql) lines.push(chunk.sql);
		for (const [table, n] of Object.entries(chunk.tables))
			counts[table] = (counts[table] ?? 0) + n;
		splitValues += chunk.splitValues;
		statements += chunk.statements;
		maxStatementChars = Math.max(maxStatementChars, chunk.maxStatementChars);
		replayable = replayable && chunk.replayable;
		structureOnly = chunk.structureOnly;
		offsetPaged = chunk.offsetPaged;
		if (chunk.done) break;
		cursor = chunk.cursor;
	}

	const dump = lines.join('\n');
	return {
		sql: dump,
		statements,
		chars: dump.length,
		tables: counts,
		maxStatementChars,
		replayable,
		splitValues,
		structureOnly,
		offsetPaged
	};
}

/**
 * Where a resumable export has got to.
 *
 * Plain JSON with no functions and no handles, because it travels back to the client between
 * invocations. The table is named rather than indexed: an index into a list rebuilt from
 * `sqlite_master` shifts the moment a table is created or dropped mid-export, so a resume would
 * enter the wrong table and produce a dump that restores cleanly and is wrong.
 */
export interface DumpCursor {
	phase: 'ddl' | 'rows' | 'later' | 'done';
	/** the table being emitted, by name */
	table?: string | null;
	/** keyset position: the last rowid emitted for {@link DumpCursor.table} */
	afterRowid?: number | null;
	/** OFFSET position, used only for a `WITHOUT ROWID` table */
	offset?: number | null;
	/** rows emitted from this table so far, so `limitPerTable` survives a resume */
	emitted?: number;
	/**
	 * Fingerprint of the dump SHAPE this cursor belongs to.
	 *
	 * The cursor describes POSITION; the options describe shape, and they arrive separately on every
	 * call because the HTTP surface rebuilds them from query parameters. Resuming an `?all=1` export
	 * with the default options would splice two different dumps into one that looks whole. Checked
	 * rather than trusted -- {@link dumpChunk} throws instead of splicing.
	 */
	shape?: string;
}

/** the beginning, so a caller never has to know the phase names */
export const DUMP_START: DumpCursor = { phase: 'ddl' };

/** a runaway guard on the one-shot loop, not a limit anyone should reach */
const MAX_DUMP_CHUNKS = 100_000;

/**
 * Characters per chunk.
 *
 * **BYTES, and the difference from the restore is the point.** `IMPORT_STATEMENTS_PER_CHUNK` sizes a
 * restore chunk by statement COUNT because a replay WRITES, and rows written is the meter that binds
 * regeneration. An export writes nothing; what it spends is the memory to hold the encoded text and
 * the CPU to hex it, both proportional to bytes. Sized by statement count instead, 40
 * `cfw_file_chunk` rows -- 16 million characters -- would pass as one small chunk.
 */
export const DUMP_CHARS_PER_CHUNK = 1_000_000;

/** rows per query before the budget is re-checked; adapts upward, and starts small on purpose */
const FIRST_BATCH_ROWS = 8;
const MAX_BATCH_ROWS = 500;

export interface DumpChunk {
	sql: string;
	statements: number;
	chars: number;
	/** rows emitted in THIS chunk, per table */
	tables: Record<string, number>;
	maxStatementChars: number;
	replayable: boolean;
	splitValues: number;
	structureOnly: string[];
	/** tables paged by OFFSET because they have no rowid; see {@link pagedRowReader} */
	offsetPaged: string[];
	/** where to resume; pass it back verbatim */
	cursor: DumpCursor;
	/** true when this chunk completes the dump */
	done: boolean;
}

/** FNV-1a over the shape-bearing options, so a mismatched resume is refused rather than spliced */
function shapeOf(tables: string[], included: string[], limit: number, budget: number): string {
	const text = `${limit}|${budget}|${tables.join(',')}|${included.join(',')}`;
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36);
}

interface SchemaPlan {
	drops: string[];
	tableDdl: string[];
	laterDdl: string[];
	tables: string[];
	rowid: Record<string, boolean>;
}

/** the schema half of a dump, cheap enough to rebuild on every chunk */
function schemaPlan(sql: SqlLike): SchemaPlan {
	const master = sql
		.exec(
			`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL
			 ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, name`
		)
		.toArray() as unknown as MasterRow[];

	const owned = new Set(RESTORE_OWNED_TABLES);
	const plan: SchemaPlan = { drops: [], tableDdl: [], laterDdl: [], tables: [], rowid: {} };

	for (const row of master) {
		const name = String(row.name ?? '');
		const owner = String(row.tbl_name ?? name);
		// Engine-owned objects refuse to be created, and miniflare adds its own bookkeeping. `_cf_`
		// is the Durable Object runtime's, and reading it is not merely useless -- the authorizer
		// REFUSES it, so one `SELECT ... FROM "_cf_METADATA"` fails the whole dump with
		// `not authorized: SQLITE_AUTH`. It appears the first time the storage API is used, which a
		// bare `/invalidate` does, so every site that had ever bumped a generation was unexportable
		if (!name || RUNTIME_OWNED_PREFIXES.some((p) => name.startsWith(p))) continue;
		if (owned.has(name) || owned.has(owner)) continue;
		const ddl = `${String(row.sql).replace(/;+\s*$/, '')};`;
		if (row.type === 'table') {
			plan.drops.push(`DROP TABLE IF EXISTS ${ident(name)};`);
			plan.tableDdl.push(ddl);
			plan.tables.push(name);
			plan.rowid[name] = hasRowid(ddl);
			continue;
		}
		const keyword = row.type === 'view' ? 'VIEW' : row.type === 'trigger' ? 'TRIGGER' : 'INDEX';
		// dropped before the tables, since dropping a table takes its indexes and triggers with it
		plan.drops.unshift(`DROP ${keyword} IF EXISTS ${ident(name)};`);
		plan.laterDdl.push(ddl);
	}
	return plan;
}

/**
 * The statements for ONE row, which is the unit a chunk boundary may fall between and never inside.
 *
 * A split value is an INSERT plus its appends plus, for a blob, the `unhex()` that converts it. The
 * row is not correct until the last of them lands, so they are produced together and emitted
 * together.
 */
function emitRow(
	table: string,
	columns: string[],
	keys: string[],
	names: string,
	raw: Record<string, unknown>,
	literalBudget: number
): { statements: string[]; split: boolean } {
	const values = columns.map((_, i) =>
		encodeLiteral(
			String(raw[`t${i}`]),
			String(raw[`h${i}`] ?? ''),
			raw[`r${i}`] as number | null
		)
	);

	// A VALUE WIDER THAN THE STATEMENT CEILING IS BUILT ACROSS STATEMENTS, not refused.
	//
	// `cfw_file_chunk` stores up to FILE_CHUNK_BYTES (200,000) per row and a literal costs two hex
	// characters per byte -- 400,000 against a 100,000 ceiling. So every uploaded file over ~50 KB
	// made the whole dump unreplayable, which is any ordinary photo, on the one path whose job is
	// letting a customer leave with their data. `scripts/pack-sql.ts` already solved this for the
	// shipped pack: SQLite can BUILD a value in place with `col = col || ?`
	const fat = values.findIndex(
		(v, i) => v.length > literalBudget && !keys.includes(columns[i] as string)
	);
	if (fat < 0 || keys.length === 0) {
		return {
			statements: [`INSERT INTO ${ident(table)} (${names}) VALUES (${values.join(', ')});`],
			split: false
		};
	}

	const whole = values[fat] as string;
	const isBlob = whole.startsWith("x'");
	const head = [...values];
	const slices = sliceLiteral(whole, literalBudget);
	// A BLOB IS BUILT AS TEXT AND CONVERTED ONCE AT THE END. `||` coerces both operands to TEXT --
	// measured here, `typeof(x'41' || x'42')` is `text` -- so appending straight onto a blob column
	// destroys it silently: the restore replays clean and the file comes back empty. `unhex()` is
	// available (`typeof(unhex('41'))` is `blob`), so the digits accumulate as an ordinary string
	head[fat] = isBlob ? hexBody(slices[0] as string) : (slices[0] as string);
	const statements = [`INSERT INTO ${ident(table)} (${names}) VALUES (${head.join(', ')});`];
	const where = keys.map((k) => `${ident(k)} = ${values[columns.indexOf(k)]}`).join(' AND ');
	const col = ident(columns[fat] as string);
	for (let i = 1; i < slices.length; i++) {
		const piece = isBlob ? hexBody(slices[i] as string) : (slices[i] as string);
		statements.push(`UPDATE ${ident(table)} SET ${col} = ${col} || ${piece} WHERE ${where};`);
	}
	if (isBlob)
		statements.push(`UPDATE ${ident(table)} SET ${col} = unhex(${col}) WHERE ${where};`);
	return { statements, split: true };
}

/** the next table with rows to emit after `previous`, or the `later` phase when there is none */
function nextRowCursor(
	tables: string[],
	includeRows: (t: string) => boolean,
	previous: string | null
): DumpCursor {
	const from = previous === null ? 0 : tables.indexOf(previous) + 1;
	for (let i = Math.max(0, from); i < tables.length; i++) {
		const name = tables[i] as string;
		if (includeRows(name)) {
			return { phase: 'rows', table: name, afterRowid: 0, offset: 0, emitted: 0 };
		}
	}
	return { phase: 'later' };
}

/**
 * One bounded slice of a dump, plus where to resume.
 *
 * Phases run `ddl` -> `rows` -> `later` -> `done`, and the order is load-bearing: indexes are built
 * after the data, since every index on a table is another charged row per insert.
 *
 * @param cursor {@link DUMP_START} to begin, then whatever the previous chunk returned
 * @throws if `cursor.shape` disagrees with `opts`, which means two different dumps are being spliced
 */
export function dumpChunk(
	sql: SqlLike,
	cursor: DumpCursor = DUMP_START,
	opts: DumpOptions = {}
): DumpChunk {
	const limit = Number.isInteger(opts.limitPerTable) ? Number(opts.limitPerTable) : 0;
	const includeRows = opts.includeRows ?? ((t: string) => !isRegenerable(t));
	const literalBudget = Math.max(64, Math.floor(opts.maxLiteralChars ?? DEFAULT_LITERAL_BUDGET));
	const charBudget = Math.max(
		literalBudget * 2,
		Math.floor(opts.maxCharsPerChunk ?? DUMP_CHARS_PER_CHUNK)
	);

	const plan = schemaPlan(sql);
	const withRows = plan.tables.filter(includeRows);
	const shape = shapeOf(plan.tables, withRows, limit, literalBudget);
	if (cursor.shape && cursor.shape !== shape) {
		throw new Error(
			`export cursor belongs to a different dump (${cursor.shape} against ${shape}); ` +
				'resume with the options the export started with, or start again'
		);
	}

	const structureOnly = plan.tables.filter((t) => isRegenerable(t));
	const offsetPaged = withRows.filter((t) => !plan.rowid[t]);
	const lines: string[] = [];
	const counts: Record<string, number> = {};
	let splitValues = 0;
	let chars = 0;

	const finish = (next: DumpCursor): DumpChunk => {
		const text = lines.join('\n');
		return {
			sql: text,
			statements: lines.length,
			chars: text.length,
			tables: counts,
			maxStatementChars: lines.reduce((n, line) => Math.max(n, line.length), 0),
			replayable: lines.every((line) => line.length <= DO_MAX_STATEMENT_CHARS),
			splitValues,
			structureOnly,
			offsetPaged,
			cursor: next.phase === 'done' ? { phase: 'done', shape } : { ...next, shape },
			done: next.phase === 'done'
		};
	};

	// the whole schema goes in one chunk: it is bounded by the number of objects rather than by the
	// data, and a partial one would leave a chunk whose statements do not stand alone
	if (cursor.phase === 'ddl') {
		lines.push(...plan.drops, ...plan.tableDdl);
		// every table is named with a zero here, including the structure-only ones. A table missing
		// from the report and a table that emitted no rows are different facts, and only the first
		// means something went wrong -- so the phase that knows the whole schema states them all
		for (const name of plan.tables) counts[name] = 0;
		return finish(nextRowCursor(plan.tables, includeRows, null));
	}
	if (cursor.phase === 'later') {
		lines.push(...plan.laterDdl);
		return finish({ phase: 'done' });
	}
	if (cursor.phase === 'done') return finish({ phase: 'done' });

	let table = cursor.table ?? null;
	let afterRowid = Number(cursor.afterRowid ?? 0);
	let offset = Number(cursor.offset ?? 0);
	let emitted = Number(cursor.emitted ?? 0);

	// a table dropped mid-export is skipped rather than resumed into; the alternative is discarding
	// an export that is otherwise entirely valid
	if (table !== null && !plan.tables.includes(table)) {
		return finish(nextRowCursor(plan.tables, includeRows, table));
	}

	while (table !== null) {
		if (counts[table] === undefined) counts[table] = 0;
		const columns = tableColumns(sql, table);
		const keys = primaryKeyColumns(sql, table);
		const names = columns.map(ident).join(', ');
		const keyed = plan.rowid[table] !== false;
		let batch = FIRST_BATCH_ROWS;
		let exhausted = columns.length === 0;

		while (!exhausted && chars < charBudget) {
			if (limit > 0 && emitted >= limit) break;
			const take = limit > 0 ? Math.min(batch, limit - emitted) : batch;
			const rows = sql
				.exec(pagedRowReader(table, columns, keyed, take), keyed ? afterRowid : offset)
				.toArray();
			if (rows.length === 0) {
				exhausted = true;
				break;
			}
			let consumed = 0;
			for (const raw of rows) {
				const { statements, split } = emitRow(
					table,
					columns,
					keys,
					names,
					raw,
					literalBudget
				);
				lines.push(...statements);
				chars += statements.reduce((n, s) => n + s.length + 1, 0);
				if (split) splitValues++;
				counts[table] = (counts[table] ?? 0) + 1;
				emitted++;
				consumed++;
				if (keyed) afterRowid = Number(raw.__rid);
				else offset++;
				// the boundary falls BETWEEN rows: a cut inside a split value would leave a restore
				// that replayed the INSERT and never the appends, so the row would be present and
				// truncated rather than absent
				if (chars >= charBudget) break;
			}
			if (consumed < rows.length) break;
			if (rows.length < take) {
				exhausted = true;
				break;
			}
			// adapt: aim the next query at the budget that is left, so a table of 200 KB blobs settles
			// to a couple of rows per query while a table of small config rows fills the chunk
			const perRow = Math.max(1, Math.floor(chars / Math.max(1, emitted)));
			batch = Math.max(1, Math.min(MAX_BATCH_ROWS, Math.floor(charBudget / perRow)));
		}

		if (!exhausted && !(limit > 0 && emitted >= limit)) {
			return finish({ phase: 'rows', table, afterRowid, offset, emitted });
		}
		const resume = nextRowCursor(plan.tables, includeRows, table);
		if (resume.phase !== 'rows') return finish(resume);
		table = resume.table as string;
		afterRowid = 0;
		offset = 0;
		emitted = 0;
		if (chars >= charBudget) {
			return finish({ phase: 'rows', table, afterRowid: 0, offset: 0, emitted: 0 });
		}
	}

	return finish({ phase: 'later' });
}
