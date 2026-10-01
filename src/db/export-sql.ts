import { fnv1a32 } from '../util/hash';
import type { SqlLike } from './migrate-sql';

/**
 * Tables the restore path itself lives in, excluded outright (no DDL, drops or rows).
 *
 * A dump with `cfw_import_chunk` would contain itself, and one with `cfw_migrate` would overwrite
 * the cursor that makes the replay resumable.
 */
export const RESTORE_OWNED_TABLES = ['cfw_migrate', 'cfw_import', 'cfw_import_chunk'];

/**
 * Name prefixes belonging to something other than the site.
 *
 * `sqlite_` is the engine's and refuses creation; `__miniflare` is the local harness's; `_cf_` is
 * the Durable Object runtime's, and the authorizer refuses to read `_cf_METADATA`, so one `SELECT`
 * fails the whole dump with `not authorized: SQLITE_AUTH`.
 */
export const RUNTIME_OWNED_PREFIXES = ['sqlite_', '__miniflare', '_cf_'];

/**
 * Tables dumped structure-only, following drush's `--structure-tables-key=common`.
 *
 * A restored stale `cache_container` would boot the site on another site's container, and
 * `cachetags` checksums that disagree with their bins leave rows present and permanently rejected.
 * It also makes a dump storable: on the shipped pack the seven statements over the
 * 100,000-character ceiling are all cache rows (largest 960,544); without them the widest is
 * 89,364.
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

/**
 * The `cfw_meta` keys a dump withholds by default.
 *
 * A dump goes to migration tooling, support and backup storage, and `cfw_meta` is not regenerable:
 * it carries the owner token and a live Cloudflare OAuth token with `email:write`. `hash_salt`
 * signs login links and form tokens, so a dump holding it can mint a valid password-reset URL.
 * `?secrets=1` is how a restore asks for them.
 */
export const SECRET_META_KEYS = new Set([
	'owner_token',
	'cf_oauth_token',
	'cf_oauth_client_id',
	'hash_salt',
	// the SMTP password, in plaintext inside a JSON blob
	'site_smtp_settings'
]);

/**
 * Key prefixes a dump withholds, for credentials whose key carries an id.
 *
 * An exact list cannot match a computed key: `git_token_<remoteId>` and `git_token_pending` hold a
 * provider token with repository write scope, and `git_hooksecret_<remoteId>` the webhook signing
 * secret. A prefix also covers the next secret keyed by id.
 */
export const SECRET_META_PREFIXES = ['git_token_', 'git_hooksecret_'] as const;

/**
 * The same keys as SQLite's `hex()` renders them.
 *
 * The row reader selects `typeof(col) AS t<i>` and `hex(col) AS h<i>`; the value exists only as
 * uppercase hex (`t<i>` is the type name).
 */
const SECRET_META_HEX = new Set(
	[...SECRET_META_KEYS].map((k) =>
		[...new TextEncoder().encode(k)]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')
			.toUpperCase()
	)
);

/** the prefixes as hex, so a computed key can be matched without decoding every row */
const SECRET_META_HEX_PREFIXES = SECRET_META_PREFIXES.map((p) =>
	[...new TextEncoder().encode(p)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase()
);

/** whether this row is a secret `cfw_meta` row; the key is column `k` */
export function isSecretMetaRow(
	table: string,
	columns: readonly string[],
	raw: Record<string, unknown>
): boolean {
	if (table !== 'cfw_meta') return false;
	const at = columns.indexOf('k');
	if (at < 0) return false;
	const hex = String(raw[`h${at}`] ?? '').toUpperCase();
	if (SECRET_META_HEX.has(hex)) return true;
	// hex is two characters per byte, so a byte prefix is a string prefix and needs no decode
	return SECRET_META_HEX_PREFIXES.some((p) => hex.startsWith(p));
}

/** options that shape a dump; a resumed export must repeat them */
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
	 * Well under the 100,000-character ceiling by default (the surrounding `INSERT` costs too).
	 */
	maxLiteralChars?: number;
	/** characters per chunk for {@link dumpChunk}; see {@link DUMP_CHARS_PER_CHUNK} */
	maxCharsPerChunk?: number;
	/** carry {@link SECRET_META_KEYS}; a faithful restore needs them, a backup does not */
	secrets?: boolean;
}

/**
 * Default literal budget, under half the statement ceiling because an append statement also
 * carries the `WHERE` clause addressing the row (long for a composite key).
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
 * Each piece is a valid literal of the same kind, so concatenating them reproduces the value. Hex
 * is cut on byte boundaries and text on whole characters (never halving a multi-byte sequence).
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

/** the whole dump and its accounting */
export interface DumpResult {
	sql: string;
	statements: number;
	/** characters, not bytes (a UTF-8 literal is wider on the wire) */
	chars: number;
	/** rows emitted per table, including the tables that emitted none */
	tables: Record<string, number>;
	/**
	 * The widest single statement, for judging whether the dump can be replayed.
	 *
	 * A Durable Object caps statement text at 100,000 characters, and `/export?all=1` can emit a
	 * 960,544-character `cache_container` row that stores fine and fails mid-restore.
	 */
	maxStatementChars: number;
	/** false when any statement exceeds the ceiling, so a caller can refuse before storing it */
	replayable: boolean;
	/** values too wide for one statement, rebuilt with `col = col || ...` appends */
	splitValues: number;
	/** rows withheld by {@link SECRET_META_KEYS}; a dump must say what it is not carrying */
	redacted: number;
	/**
	 * The tables emitted structure-only, resolved from `REGENERABLE_TABLES` so a report cannot go
	 * stale when the list changes.
	 */
	structureOnly: string[];
	/**
	 * Tables paged by `OFFSET` because they are `WITHOUT ROWID`.
	 *
	 * `OFFSET` paging re-scans and can repeat or skip a row if the site writes mid-export. Empty on
	 * every schema this ships with.
	 */
	offsetPaged: string[];
}

/** the Durable Object ceiling on statement text */
export const DO_MAX_STATEMENT_CHARS = 100_000;

/**
 * The Durable Object ceiling on a single stored record.
 *
 * It differs from the statement cap: a value inside the record cap can still be unexportable,
 * since a SQL literal costs two hex characters per byte.
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

// fatal, so text that is not valid UTF-8 is caught, not replaced with `U+FFFD`
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * One column value as a SQL literal that replays to the same bytes and the same storage class.
 *
 * @param type the value's own `typeof()` (SQLite types values, so one column can hold all five)
 * @param hex `hex()` of the value: raw bytes for a blob, exact text rendering for text and integer
 * @param real the column read directly, only ever a real; see the `CASE` guard in `columnSelect`
 */
export function encodeLiteral(type: string, hex: string, real: number | null): string {
	if (type === 'null') return 'NULL';
	if (type === 'real') {
		const n = Number(real);
		if (n === Infinity) return '9e999';
		if (n === -Infinity) return '-9e999';
		if (Object.is(n, -0)) return '-0.0';
		// an integral double must keep its `.0` or SQLite stores it back as an integer
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

/** the typeof, hex and real-only projection that both row readers select */
function columnSelect(columns: string[]): string {
	return columns
		.map(
			(c, i) =>
				`typeof(${ident(c)}) AS t${i}, hex(${ident(c)}) AS h${i}, ` +
				`CASE WHEN typeof(${ident(c)}) = 'real' THEN ${ident(c)} END AS r${i}`
		)
		.join(', ');
}

/** the `typeof`/`hex`/real `SELECT` for one table (`CASE` keeps wide integers out of JS numbers) */
function rowReader(table: string, columns: string[], limit: number): string {
	const select = columnSelect(columns);
	return `SELECT ${select} FROM ${ident(table)}${limit > 0 ? ` LIMIT ${limit}` : ''}`;
}

/**
 * The same `SELECT`, positioned.
 *
 * Keyset, not `OFFSET`, wherever the table has a rowid: `OFFSET` re-scans on every resume (O(c^2)
 * over c chunks) and repeats or skips rows when the site writes mid-export. A `WITHOUT ROWID` table
 * falls back to `OFFSET` and reports it through {@link DumpChunk.offsetPaged}.
 *
 * @param bounded false for a table's first query, which has no `WHERE`: rowids are signed, so no
 *   start value means "before every row" (`_rowid_ > 0` dropped Drupal's anonymous user at uid 0)
 */
function pagedRowReader(
	table: string,
	columns: string[],
	keyed: boolean,
	batch: number,
	bounded: boolean
): string {
	const select = columnSelect(columns);
	if (!keyed) {
		return `SELECT ${select} FROM ${ident(table)} LIMIT ${batch} OFFSET ?`;
	}
	return (
		`SELECT _rowid_ AS __rid, ${select} FROM ${ident(table)} ` +
		`${bounded ? 'WHERE _rowid_ > ? ' : ''}ORDER BY _rowid_ LIMIT ${batch}`
	);
}

/** `WITHOUT ROWID` is table-level, so the DDL is the only place it shows */
function hasRowid(ddl: string): boolean {
	return !/\)\s*WITHOUT\s+ROWID\s*;?\s*$/i.test(ddl);
}

/** column names in declaration order, via the table-valued pragma (binds the name, no quoting) */
export function tableColumns(sql: SqlLike, table: string): string[] {
	return sql
		.exec('SELECT name FROM pragma_table_info(?)', table)
		.toArray()
		.map((r) => String(r.name));
}

/**
 * Dumps the object's SQL as replayable statements, on the host side (no interpreter boot).
 *
 * The PHP `exportDatabase()` mishandles storage classes: blobs become quoted text, a NUL ends the
 * literal, and a 19-digit integer goes out as a string. Here every value is read as `typeof()` plus
 * `hex()`, never as the column: a Durable Object integer read is lossy above 2^53, while `hex()` of
 * an integer is its exact decimal text. Reals are read directly (a double crosses into JS exactly).
 *
 * Order is drops, tables, rows, then indexes, views and triggers; indexes come last because each
 * is another charged row per insert.
 */
export function dumpDatabase(sql: SqlLike, opts: DumpOptions = {}): DumpResult {
	const lines: string[] = [];
	const counts: Record<string, number> = {};
	let splitValues = 0;
	let redacted = 0;
	let structureOnly: string[] = [];
	let offsetPaged: string[] = [];
	let cursor: DumpCursor = DUMP_START;
	// summed from the chunks (a `CREATE TABLE` spans lines, so counting newlines miscounts)
	let statements = 0;
	let maxStatementChars = 0;
	let replayable = true;

	// the one-shot dump is the chunked one run to exhaustion (two paths would drift apart)
	for (let guard = 0; guard < MAX_DUMP_CHUNKS; guard++) {
		const chunk = dumpChunk(sql, cursor, opts);
		if (chunk.sql) lines.push(chunk.sql);
		for (const [table, n] of Object.entries(chunk.tables))
			counts[table] = (counts[table] ?? 0) + n;
		splitValues += chunk.splitValues;
		redacted += chunk.redacted;
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
		redacted,
		structureOnly,
		offsetPaged
	};
}

/**
 * Where a resumable export has got to.
 *
 * Plain JSON, since it travels to the client between invocations. The table is named, not indexed:
 * an index into a list rebuilt from `sqlite_master` shifts when a table is created or dropped
 * mid-export and would resume into the wrong table.
 */
export interface DumpCursor {
	phase: 'ddl' | 'rows' | 'later' | 'done';
	/** the table being emitted, by name */
	table?: string | null;
	/**
	 * Keyset position: the last rowid emitted for {@link DumpCursor.table}.
	 *
	 * Null means nothing emitted yet and is not 0: rowid 0 is a real row (Drupal's anonymous user).
	 */
	afterRowid?: number | null;
	/** `OFFSET` position, used only for a `WITHOUT ROWID` table */
	offset?: number | null;
	/** rows emitted from this table so far, so `limitPerTable` survives a resume */
	emitted?: number;
	/**
	 * Fingerprint of the dump shape this cursor belongs to.
	 *
	 * Options arrive separately on every call, so resuming `?all=1` with defaults would splice two
	 * dumps; {@link dumpChunk} throws on a mismatch.
	 */
	shape?: string;
}

/** the beginning, so a caller never has to know the phase names */
export const DUMP_START: DumpCursor = { phase: 'ddl' };

/** a runaway guard on the one-shot loop, not a limit anyone should reach */
const MAX_DUMP_CHUNKS = 100_000;

/**
 * Characters per chunk. An export writes nothing and costs memory and CPU by bytes, so it is sized
 * by characters; a restore writes, so it is sized by statement count
 * (`IMPORT_STATEMENTS_PER_CHUNK`). 40 `cfw_file_chunk` rows would be 16 million characters.
 */
export const DUMP_CHARS_PER_CHUNK = 1_000_000;

/** rows per query before the budget is re-checked; starts small and adapts upward */
const FIRST_BATCH_ROWS = 8;
const MAX_BATCH_ROWS = 500;

/** one bounded slice of a dump and where to resume */
export interface DumpChunk {
	sql: string;
	statements: number;
	chars: number;
	/** rows emitted in this chunk, per table */
	tables: Record<string, number>;
	maxStatementChars: number;
	replayable: boolean;
	splitValues: number;
	/** rows withheld by {@link SECRET_META_KEYS}; a dump must say what it is not carrying */
	redacted: number;
	structureOnly: string[];
	/** tables paged by `OFFSET` because they have no rowid; see {@link pagedRowReader} */
	offsetPaged: string[];
	/** where to resume; pass it back verbatim */
	cursor: DumpCursor;
	/** true when this chunk completes the dump */
	done: boolean;
}

/** FNV-1a over the shape-bearing options, so a mismatched resume is refused rather than spliced */
function shapeOf(tables: string[], included: string[], limit: number, budget: number): string {
	const text = `${limit}|${budget}|${tables.join(',')}|${included.join(',')}`;
	return fnv1a32(text).toString(36);
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
		// runtime-owned objects (`_cf_` appears on first storage API use)
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
		// dropped before the tables (a table drop takes its indexes and triggers with it)
		plan.drops.unshift(`DROP ${keyword} IF EXISTS ${ident(name)};`);
		plan.laterDdl.push(ddl);
	}
	return plan;
}

/**
 * The statements for one row; a chunk boundary may fall between rows, never inside one.
 *
 * A split value is an `INSERT` plus its appends plus, for a blob, the closing `unhex()`; the row is
 * wrong until the last lands.
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

	// a value wider than the statement ceiling is built across statements with `col = col || ?`
	// (`cfw_file_chunk` rows are 200,000 bytes = 400,000 hex characters against 100,000)
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
	// a blob is built as text and converted once at the end: `||` yields TEXT (`typeof(x'41' ||
	// x'42')` is `text`), so appending onto a blob column silently empties the file on restore
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
	previous?: string
): DumpCursor {
	const from = previous === undefined ? 0 : tables.indexOf(previous) + 1;
	for (let i = Math.max(0, from); i < tables.length; i++) {
		const name = tables[i] as string;
		if (includeRows(name)) {
			return { phase: 'rows', table: name, afterRowid: null, offset: 0, emitted: 0 };
		}
	}
	return { phase: 'later' };
}

/**
 * One bounded slice of a dump, plus where to resume.
 *
 * Phases run `ddl`, `rows`, `later`, `done`; indexes come after the data (each is a charged row
 * per insert).
 *
 * @param cursor {@link DUMP_START} to begin, then whatever the previous chunk returned
 * @throws if `cursor.shape` disagrees with `opts` (two different dumps would be spliced)
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
	let redacted = 0;
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
			redacted,
			structureOnly,
			offsetPaged,
			cursor: next.phase === 'done' ? { phase: 'done', shape } : { ...next, shape },
			done: next.phase === 'done'
		};
	};

	// the whole schema goes in one chunk (bounded by object count; statements must stand alone)
	if (cursor.phase === 'ddl') {
		lines.push(...plan.drops, ...plan.tableDdl);
		// name every table with 0 (a table missing from the report differs from one with no rows)
		for (const name of plan.tables) counts[name] = 0;
		return finish(nextRowCursor(plan.tables, includeRows));
	}
	if (cursor.phase === 'later') {
		lines.push(...plan.laterDdl);
		return finish({ phase: 'done' });
	}
	if (cursor.phase === 'done') return finish({ phase: 'done' });

	let table = cursor.table ?? undefined;
	// undefined, not 0 (0 is a real rowid)
	let afterRowid =
		cursor.afterRowid === null || cursor.afterRowid === undefined
			? undefined
			: Number(cursor.afterRowid);
	let offset = Number(cursor.offset ?? 0);
	let emitted = Number(cursor.emitted ?? 0);

	// a table dropped mid-export is skipped, not resumed into
	if (table !== undefined && !plan.tables.includes(table)) {
		return finish(nextRowCursor(plan.tables, includeRows, table));
	}

	while (table !== undefined) {
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
			const bounded = keyed && afterRowid !== undefined;
			const rows = sql
				.exec(
					pagedRowReader(table, columns, keyed, take, bounded),
					...(keyed ? (bounded ? [afterRowid as number] : []) : [offset])
				)
				.toArray();
			if (rows.length === 0) {
				exhausted = true;
				break;
			}
			let consumed = 0;
			for (const raw of rows) {
				if (isSecretMetaRow(table, columns, raw) && opts.secrets !== true) {
					// consumed so the cursor advances; only the value is withheld
					counts[table] = (counts[table] ?? 0) + 1;
					redacted++;
					emitted++;
					consumed++;
					if (keyed) afterRowid = Number(raw.__rid);
					continue;
				}
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
				// boundaries fall between rows (a cut inside a split value truncates it)
				if (chars >= charBudget) break;
			}
			if (consumed < rows.length) break;
			if (rows.length < take) {
				exhausted = true;
				break;
			}
			// adapt the batch to the budget left (200 KB blobs settle to a few rows per query)
			const perRow = Math.max(1, Math.floor(chars / Math.max(1, emitted)));
			batch = Math.max(1, Math.min(MAX_BATCH_ROWS, Math.floor(charBudget / perRow)));
		}

		if (!exhausted && !(limit > 0 && emitted >= limit)) {
			return finish({
				phase: 'rows',
				table,
				afterRowid: afterRowid ?? null,
				offset,
				emitted
			});
		}
		const resume = nextRowCursor(plan.tables, includeRows, table);
		if (resume.phase !== 'rows') return finish(resume);
		table = resume.table as string;
		afterRowid = undefined;
		offset = 0;
		emitted = 0;
		if (chars >= charBudget) {
			return finish({ phase: 'rows', table, afterRowid: null, offset: 0, emitted: 0 });
		}
	}

	return finish({ phase: 'later' });
}
