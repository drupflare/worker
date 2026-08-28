/**
 * What every index in the shipped schema costs on the meter that binds regeneration.
 *
 * `amplification()` in `src/db/write-tally.ts` reports charged rows per statement from a LIVE tally,
 * and its own docblock says what it cannot tell you: which index. This is the other half. It reads
 * the schema that actually ships -- `assets/drupal-sql/*.json`, the chunks the migration replays --
 * and reports, per table, how many charged rows one stored row costs and how many of those are index
 * maintenance rather than data.
 *
 * Deterministic: same pack in, same numbers out, no clock and no network. The charge model it applies
 * (`chargePerInsertedRow`) is not asserted here -- `tests/unit/db/index-charge-model.spec.ts` measures
 * it against real Durable Object SQL and fails if the model and the engine disagree.
 *
 * `bun scripts/measure/index-audit.ts [--dir=assets/drupal-sql] [--json] [--table=<name>]`
 */

import { splitChargedRows } from '../../src/db/write-tally.js';

/** one statement as the pack stores it */
export type PackStatement = { s: string; p: unknown[] };

export type ParsedColumn = {
	name: string;
	/** the declared type as written, uppercased; '' when the column has no type */
	type: string;
	/** declared `PRIMARY KEY` inline rather than in a table constraint */
	inlinePk: boolean;
	inlineUnique: boolean;
};

export type ParsedTable = {
	name: string;
	columns: ParsedColumn[];
	/** primary key columns in declaration order; empty when the table has no primary key */
	pk: string[];
	/**
	 * whether the primary key IS the rowid, in which case sqlite stores no separate index for it.
	 *
	 * True only for a single-column key whose declared type is exactly INTEGER. That covers both
	 * spellings the pack uses -- inline `"wid" INTEGER PRIMARY KEY AUTOINCREMENT` and the table
	 * constraint `PRIMARY KEY ("id")` over an INTEGER column -- because sqlite treats them the same.
	 */
	pkIsRowid: boolean;
	/** declared `WITHOUT ROWID`, so the table IS its primary-key B-tree and that key costs nothing */
	withoutRowid: boolean;
	/**
	 * whether the key is declared AUTOINCREMENT, which costs a charged row of its own.
	 *
	 * MEASURED, not reasoned. The model shipped without this and predicted 4 for `watchdog` on the
	 * grounds that a rowid key stores no index; real Durable Object SQL billed 5. The extra row is
	 * `sqlite_sequence`, rewritten on every insert.
	 */
	autoincrement: boolean;
	/** UNIQUE constraints declared in the table body; each is its own implicit index */
	uniqueConstraints: string[][];
};

export type ParsedIndex = {
	name: string;
	table: string;
	columns: string[];
	unique: boolean;
	/** carries a WHERE clause, so it stores an entry only for the rows that match */
	partial: boolean;
};

/** identifier, quoted `"x"` / `` `x` `` / `[x]` or bare */
const IDENT = String.raw`(?:"([^"]+)"|\x60([^\x60]+)\x60|\[([^\]]+)\]|([A-Za-z0-9_]+))`;

function ident(match: RegExpMatchArray, first: number): string {
	return (match[first] ?? match[first + 1] ?? match[first + 2] ?? match[first + 3] ?? '').trim();
}

/** splits on commas that are not inside parentheses or quotes */
function splitTopLevel(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote = '';
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i] as string;
		if (quote) {
			if (ch === quote) quote = '';
			continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') quote = ch;
		else if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === ',' && depth === 0) {
			parts.push(body.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(body.slice(start));
	return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** the identifiers inside a `(...)` list, dropping ASC/DESC/COLLATE noise */
function columnList(text: string): string[] {
	return splitTopLevel(text).map((part) => {
		const m = new RegExp(`^${IDENT}`).exec(part.trim());
		return m ? ident(m, 1) : part.trim();
	});
}

/** words that end a type name and begin a column constraint */
const CONSTRAINT_WORDS = new Set([
	'CONSTRAINT',
	'PRIMARY',
	'NOT',
	'NULL',
	'UNIQUE',
	'CHECK',
	'DEFAULT',
	'COLLATE',
	'REFERENCES',
	'GENERATED',
	'AS',
	'AUTOINCREMENT'
]);

/**
 * The declared type of a column definition's remainder, uppercased.
 *
 * Stops at the first constraint word, which is the whole reason this is not a regex over
 * `[A-Za-z ]*`. `"wid" INTEGER PRIMARY KEY AUTOINCREMENT` reads as the type `INTEGER PRIMARY KEY
 * AUTOINCREMENT` under the naive form, which is not `INTEGER`, so the rowid test fails and every
 * autoincrement table gets charged for a primary-key index sqlite never creates.
 */
export function declaredType(rest: string): string {
	// bare words only, so a `(255)` size spec ends the run the same way a constraint does
	const run = /^([A-Za-z][A-Za-z0-9_]*(?:\s+[A-Za-z][A-Za-z0-9_]*)*)/.exec(rest.trim());
	if (!run) return '';
	const words: string[] = [];
	for (const token of (run[1] as string).split(/\s+/)) {
		const word = token.toUpperCase();
		if (CONSTRAINT_WORDS.has(word)) break;
		words.push(word);
	}
	return words.join(' ');
}

export function parseCreateTable(sql: string): ParsedTable | null {
	const text = String(sql ?? '').trim();
	const head = new RegExp(
		`^CREATE\\s+(?:TEMP\\s+|TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}\\s*\\(`,
		'i'
	).exec(text);
	if (!head) return null;
	const open = text.indexOf('(', head[0].length - 1);
	const close = text.lastIndexOf(')');
	if (open < 0 || close <= open) return null;

	const columns: ParsedColumn[] = [];
	let pk: string[] = [];
	const uniqueConstraints: string[][] = [];

	for (const part of splitTopLevel(text.slice(open + 1, close))) {
		if (/^PRIMARY\s+KEY\s*\(/i.test(part)) {
			pk = columnList(part.slice(part.indexOf('(') + 1, part.lastIndexOf(')')));
			continue;
		}
		if (/^UNIQUE\s*\(/i.test(part)) {
			uniqueConstraints.push(
				columnList(part.slice(part.indexOf('(') + 1, part.lastIndexOf(')')))
			);
			continue;
		}
		// CHECK / FOREIGN KEY / CONSTRAINT are table constraints that store nothing
		if (/^(CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i.test(part)) continue;

		const m = new RegExp(`^${IDENT}\\s*(.*)$`, 's').exec(part);
		if (!m) continue;
		const name = ident(m, 1);
		const rest = (m[5] ?? '').trim();
		const type = declaredType(rest);
		const inlinePk = /\bPRIMARY\s+KEY\b/i.test(rest);
		const inlineUnique = /\bUNIQUE\b/i.test(rest);
		columns.push({ name, type, inlinePk, inlineUnique });
		if (inlinePk) pk = [name];
		if (inlineUnique && !inlinePk) uniqueConstraints.push([name]);
	}

	const pkType =
		pk.length === 1 ? (columns.find((c) => c.name === pk[0])?.type ?? '') : '<composite>';
	// `INTEGER PRIMARY KEY` is the rowid; `INT`, `BIGINT` and every other spelling is not
	const pkIsRowid = pk.length === 1 && pkType === 'INTEGER';
	const autoincrement = /\bAUTOINCREMENT\b/i.test(text.slice(open, close));

	return {
		name: ident(head, 1),
		columns,
		pk,
		pkIsRowid,
		// after the closing paren, so it is read from the whole statement rather than the body
		withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(text.slice(close)),
		autoincrement,
		uniqueConstraints
	};
}

export function parseCreateIndex(sql: string): ParsedIndex | null {
	const text = String(sql ?? '').trim();
	const m = new RegExp(
		`^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}\\s+ON\\s+${IDENT}\\s*\\(`,
		'i'
	).exec(text);
	if (!m) return null;
	const open = text.indexOf('(', m[0].length - 1);
	const wherePos = text.search(/\)\s*WHERE\s/i);
	const close = wherePos >= 0 ? wherePos : text.lastIndexOf(')');
	return {
		name: ident(m, 2),
		table: ident(m, 6),
		columns: columnList(text.slice(open + 1, close)),
		unique: Boolean(m[1]),
		partial: wherePos >= 0
	};
}

/** the table an INSERT targets, plus its column list and how many rows it carries */
export type ParsedInsert = { table: string; columns: string[]; rows: number };

export function parseInsert(sql: string): ParsedInsert | null {
	const text = String(sql ?? '').trim();
	const m = new RegExp(
		`^INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${IDENT}\\s*(\\([^)]*\\))?\\s*VALUES`,
		'i'
	).exec(text);
	if (!m) return null;
	const cols = m[5] ? columnList(m[5].slice(1, -1)) : [];
	// each `(...)` group after VALUES is one row
	const tail = text.slice(m[0].length);
	let depth = 0;
	let rows = 0;
	for (const ch of tail) {
		if (ch === '(') {
			if (depth === 0) rows++;
			depth++;
		} else if (ch === ')') depth--;
	}
	return { table: ident(m, 1), columns: cols, rows: Math.max(1, rows) };
}

/**
 * Charged rows one INSERTed row costs, from the schema alone.
 *
 * The meter counts an index entry as a row written, so the cost of storing one row is the table row
 * plus one entry per index that has to hold it: the primary key's implicit index unless the key IS
 * the rowid, one per UNIQUE constraint, and one per `CREATE INDEX`. A PARTIAL index is excluded --
 * it stores an entry only for the rows its WHERE clause admits, which is the whole reason it is worth
 * proposing, so counting it here would price the fix as if it changed nothing.
 *
 * Measured against the engine in `tests/unit/db/index-charge-model.spec.ts`; this function is the
 * model, that spec is the authority.
 */
export function chargePerInsertedRow(table: ParsedTable, indexes: ParsedIndex[]): number {
	const explicit = indexes.filter((i) => !i.partial).length;
	return 1 + implicitIndexCount(table) + (table.autoincrement ? 1 : 0) + explicit;
}

/**
 * indexes sqlite creates without being asked: the primary key's unless it is the rowid, plus UNIQUE
 *
 * A `WITHOUT ROWID` table IS its primary-key B-tree, so that key costs no separate entry. Reading
 * the DDL for it corrects an error this instrument made about its own shipped pack: with the 14
 * cache bins converted it still reported them at 2x, and printed "the floor in this schema is 2x"
 * and "factor 1.0 (nothing to win): NO TABLE" -- a verdict that would have closed the lever that
 * had already been applied.
 */
export function implicitIndexCount(table: ParsedTable): number {
	const key = table.pkIsRowid || table.pk.length === 0 || table.withoutRowid ? 0 : 1;
	return key + table.uniqueConstraints.length;
}

export type TableAudit = {
	table: string;
	/** rows the pack ships for this table */
	dataRows: number;
	/** `CREATE INDEX` entries on it, partial ones included */
	explicitIndexes: ParsedIndex[];
	/** primary-key and UNIQUE indexes sqlite creates without being asked */
	implicitIndexes: number;
	/** the `sqlite_sequence` row an AUTOINCREMENT key rewrites on every insert */
	sequenceRow: number;
	/** charged rows per stored row */
	chargePerRow: number;
	/** index entries one stored row creates: implicit plus every non-partial CREATE INDEX */
	indexRowsPerRow: number;
	/** the fraction of a stored row's cost that is index maintenance, sequence row excluded */
	indexShare: number;
	/** the table's whole shipped contents, priced */
	chargedRows: number;
};

/** an index whose column is mostly NULL, which is where a partial index pays */
export type SparseIndex = {
	index: string;
	table: string;
	column: string;
	rows: number;
	nullRows: number;
	nullFraction: number;
	/** charged rows a partial index would stop paying on a full rewrite of the table */
	savedPerRewrite: number;
};

export type Audit = {
	tables: Map<string, ParsedTable>;
	indexesByTable: Map<string, ParsedIndex[]>;
	rowsByTable: Map<string, number>;
	/** column values per table, only for tables whose INSERTs name their columns */
	perTable: TableAudit[];
	sparse: SparseIndex[];
	totals: {
		tables: number;
		explicitIndexes: number;
		implicitIndexes: number;
		dataRows: number;
		chargedRows: number;
		/** charged rows that are index entries, so the sequence rows are not folded in */
		indexRows: number;
		/** the smallest charge factor any table in the schema carries */
		minChargePerRow: number;
	};
};

/**
 * Reads a pack's statements into a schema audit.
 *
 * Takes statements rather than a directory so the analysis stays pure and the gate can drive it from
 * a fixture; `loadPack()` is the only part that touches a filesystem.
 */
export function auditSchema(statements: PackStatement[]): Audit {
	const tables = new Map<string, ParsedTable>();
	const indexesByTable = new Map<string, ParsedIndex[]>();
	const rowsByTable = new Map<string, number>();
	// null counts per table+column, accumulated over the shipped INSERTs
	const nulls = new Map<string, Map<string, number>>();

	for (const st of statements) {
		const table = parseCreateTable(st.s);
		if (table) {
			tables.set(table.name, table);
			continue;
		}
		const index = parseCreateIndex(st.s);
		if (index) {
			const list = indexesByTable.get(index.table) ?? [];
			list.push(index);
			indexesByTable.set(index.table, list);
			continue;
		}
		const insert = parseInsert(st.s);
		if (!insert) continue;
		rowsByTable.set(insert.table, (rowsByTable.get(insert.table) ?? 0) + insert.rows);
		if (insert.columns.length === 0 || insert.rows * insert.columns.length !== st.p.length) {
			continue;
		}
		const perColumn = nulls.get(insert.table) ?? new Map<string, number>();
		for (let row = 0; row < insert.rows; row++) {
			insert.columns.forEach((col, i) => {
				const value = st.p[row * insert.columns.length + i];
				if (value === null || value === undefined) {
					perColumn.set(col, (perColumn.get(col) ?? 0) + 1);
				}
			});
		}
		nulls.set(insert.table, perColumn);
	}

	const perTable: TableAudit[] = [];
	for (const [name, table] of tables) {
		const explicitIndexes = indexesByTable.get(name) ?? [];
		const implicitIndexes = implicitIndexCount(table);
		const chargePerRow = chargePerInsertedRow(table, explicitIndexes);
		const dataRows = rowsByTable.get(name) ?? 0;
		perTable.push({
			table: name,
			dataRows,
			explicitIndexes,
			implicitIndexes,
			sequenceRow: table.autoincrement ? 1 : 0,
			chargePerRow,
			indexRowsPerRow: implicitIndexes + explicitIndexes.filter((i) => !i.partial).length,
			indexShare:
				(implicitIndexes + explicitIndexes.filter((i) => !i.partial).length) / chargePerRow,
			chargedRows: dataRows * chargePerRow
		});
	}
	perTable.sort((a, b) => b.chargedRows - a.chargedRows || b.chargePerRow - a.chargePerRow || 0);

	const sparse: SparseIndex[] = [];
	for (const [tableName, list] of indexesByTable) {
		const rows = rowsByTable.get(tableName) ?? 0;
		if (rows === 0) continue;
		for (const index of list) {
			if (index.partial) continue;
			// a multi-column index stores an entry whenever ANY column is non-null, so only a
			// single-column index can be made partial on "column IS NOT NULL" without changing
			// what it can answer
			if (index.columns.length !== 1) continue;
			const column = index.columns[0] as string;
			const nullRows = nulls.get(tableName)?.get(column) ?? 0;
			if (nullRows === 0) continue;
			sparse.push({
				index: index.name,
				table: tableName,
				column,
				rows,
				nullRows,
				nullFraction: nullRows / rows,
				savedPerRewrite: nullRows
			});
		}
	}
	sparse.sort((a, b) => b.savedPerRewrite - a.savedPerRewrite);

	return {
		tables,
		indexesByTable,
		rowsByTable,
		perTable,
		sparse,
		totals: {
			tables: tables.size,
			explicitIndexes: [...indexesByTable.values()].reduce((n, l) => n + l.length, 0),
			implicitIndexes: perTable.reduce((n, t) => n + t.implicitIndexes, 0),
			dataRows: perTable.reduce((n, t) => n + t.dataRows, 0),
			chargedRows: perTable.reduce((n, t) => n + t.chargedRows, 0),
			indexRows: perTable.reduce((n, t) => n + t.dataRows * t.indexRowsPerRow, 0),
			minChargePerRow: perTable.reduce(
				(min, t) => Math.min(min, t.chargePerRow),
				Number.POSITIVE_INFINITY
			)
		}
	};
}

/**
 * The per-table charged rows a real fill wrote, read off the meter rather than modelled.
 *
 * From the tally in `TECHNICAL_REPORT.md` -- cold boot plus first render, 63 statements and 12
 * charged rows, 100% attributed. It is quoted here because the whole point of the decomposition is
 * to divide a MEASURED total by a charge factor; substituting a modelled total would make the answer
 * circular.
 */
export const RECORDED_FILL_CHARGED_ROWS: Record<string, number> = {
	cache_dynamic_page_cache: 8,
	cache_page: 4
};

/** the audit's charge factors as `splitChargedRows()` wants them */
export function chargeFactors(audit: Audit): Record<string, number> {
	const factors: Record<string, number> = {};
	for (const t of audit.perTable) factors[t.table] = t.chargePerRow;
	return factors;
}

/**
 * Splits a measured per-table charged-row total into data rows and index entries.
 *
 * The arithmetic lives in `splitChargedRows()` next to the `overheadShare()` it corrects; this only
 * supplies the factors the schema derived.
 */
export function splitFill(charged: Record<string, number>, audit: Audit) {
	return splitChargedRows(charged, chargeFactors(audit));
}

/** reads every `NNNN.json` chunk in a pack directory, in order */
export async function loadPack(dir: string): Promise<PackStatement[]> {
	const { readdirSync, readFileSync } = await import('node:fs');
	const files = readdirSync(dir)
		.filter((f) => /^\d+\.json$/.test(f))
		.sort();
	const out: PackStatement[] = [];
	for (const file of files) {
		const chunk = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as {
			statements: PackStatement[];
		};
		for (const st of chunk.statements) out.push(st);
	}
	return out;
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

if (import.meta.main) {
	const flag = (name: string, fallback: string): string =>
		process.argv.find((a: string) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ??
		fallback;
	const dir = flag('dir', 'assets/drupal-sql');
	const only = flag('table', '');
	const statements = await loadPack(dir);
	const audit = auditSchema(statements);

	if (process.argv.includes('--json')) {
		console.log(
			JSON.stringify(
				{
					totals: audit.totals,
					perTable: audit.perTable.map((t) => ({
						table: t.table,
						dataRows: t.dataRows,
						explicitIndexes: t.explicitIndexes.map((i) => i.name),
						implicitIndexes: t.implicitIndexes,
						sequenceRow: t.sequenceRow,
						chargePerRow: t.chargePerRow,
						indexRowsPerRow: t.indexRowsPerRow,
						indexShare: t.indexShare,
						chargedRows: t.chargedRows
					})),
					sparse: audit.sparse,
					fill: splitFill(RECORDED_FILL_CHARGED_ROWS, audit)
				},
				null,
				2
			)
		);
	} else {
		console.log(`pack              ${dir}`);
		console.log(
			`schema            ${audit.totals.tables} tables, ${audit.totals.explicitIndexes} CREATE INDEX, ` +
				`${audit.totals.implicitIndexes} implicit (primary key / UNIQUE)`
		);
		console.log(
			`shipped contents  ${audit.totals.dataRows.toLocaleString()} data rows -> ` +
				`${audit.totals.chargedRows.toLocaleString()} charged rows ` +
				`(${pct(audit.totals.indexRows / audit.totals.chargedRows)} index maintenance)`
		);

		console.log('\n=== charged rows per stored row, heaviest table first ===');
		console.log('rows       charge  index%  table');
		for (const t of audit.perTable) {
			if (only && t.table !== only) continue;
			if (!only && t.dataRows === 0 && t.chargePerRow <= 2) continue;
			console.log(
				`${String(t.dataRows).padStart(9)}  ${String(t.chargePerRow).padStart(5)}x  ` +
					`${pct(t.indexShare).padStart(6)}  ${t.table}` +
					(t.sequenceRow ? '  (+1 sqlite_sequence)' : '')
			);
		}

		const free = audit.perTable.filter((t) => t.chargePerRow === 1);
		console.log(
			`\nfactor 1.0 (nothing to win): ${free.length > 0 ? free.map((t) => t.table).join(', ') : 'NO TABLE'}`
		);
		console.log(
			`the floor in this schema is ${audit.totals.minChargePerRow}x, on ` +
				`${audit.perTable.filter((t) => t.chargePerRow === audit.totals.minChargePerRow).length} of ` +
				`${audit.totals.tables} tables`
		);

		const bins = audit.perTable.filter((t) => t.table.startsWith('cache_'));
		console.log(`\n=== the ${bins.length} cache bins, per index ===`);
		console.log('charge  table                      indexes');
		for (const bin of bins.slice().sort((a, b) => a.table.localeCompare(b.table))) {
			console.log(
				`${String(bin.chargePerRow).padStart(5)}x  ${bin.table.padEnd(25)}  ` +
					`PRIMARY KEY(cid) + ${bin.explicitIndexes.map((i) => i.name.replace(`${bin.table}_`, '')).join(', ')}`
			);
		}
		console.log(
			`dropping both secondary indexes on every bin: ${bins.length * 2} indexes, ` +
				`each bin ${bins[0]?.chargePerRow ?? 0}x -> ${(bins[0]?.chargePerRow ?? 0) - 2}x per stored row`
		);

		console.log('\n=== indexes charged on rows that store nothing ===');
		console.log('null%     nulls  saved/rewrite  index');
		for (const s of audit.sparse.slice(0, 12)) {
			console.log(
				`${pct(s.nullFraction).padStart(6)}  ${String(s.nullRows).padStart(7)}  ` +
					`${String(s.savedPerRewrite).padStart(13)}  ${s.index} (${s.table}.${s.column})`
			);
		}

		const fill = splitFill(RECORDED_FILL_CHARGED_ROWS, audit);
		console.log('\n=== the recorded fill, decomposed ===');
		console.log('charged  factor  data  index  exact  table');
		for (const r of fill.rows) {
			console.log(
				`${String(r.chargedRows).padStart(7)}  ${String(r.chargePerRow).padStart(5)}x  ` +
					`${String(r.dataRows).padStart(4)}  ${String(r.indexRows).padStart(5)}  ` +
					`${String(r.exact).padStart(5)}  ${r.table}`
			);
		}
		console.log(
			`total            ${fill.dataRows} data + ${fill.indexRows} index = ` +
				`${fill.dataRows + fill.indexRows} charged (${pct(fill.indexShare)} index maintenance)`
		);
	}
}
