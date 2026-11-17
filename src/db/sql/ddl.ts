import { Refusal } from './classes';
import { matchingParen, tokenize, type Token } from './lexer';
import { decodeStringToken } from './literal';

/** a column default as MySQL stores it */
export type ColumnDefault =
	| { kind: 'none' }
	| { kind: 'null' }
	| { kind: 'string'; value: string }
	| { kind: 'number'; text: string }
	| { kind: 'current_timestamp' };

/** one column of a MySQL table, kept as MySQL describes it */
export interface ColumnDef {
	name: string;
	/** the type as MySQL 8 prints it: `bigint unsigned`, `varchar(60)`, `int` */
	type: string;
	/** the lowercase type name with no arguments */
	base: string;
	unsigned: boolean;
	notNull: boolean;
	def: ColumnDefault;
	autoIncrement: boolean;
	/** the effective collation of a character column, undefined for other types */
	collation: string | undefined;
	charset: string | undefined;
	comment: string;
}

/** one key column; `prefix` is the length of a prefixed key such as `meta_key(191)` */
export interface KeyPart {
	name: string;
	prefix?: number;
}

/** one index of a MySQL table */
export interface IndexDef {
	name: string;
	kind: 'primary' | 'unique' | 'key';
	parts: KeyPart[];
}

/** a MySQL table definition, enough to answer DESCRIBE and SHOW and to pick conflict targets */
export interface TableSchema {
	name: string;
	columns: ColumnDef[];
	indexes: IndexDef[];
	charset: string;
	collation: string;
	engine: string;
	comment: string;
}

/** the default collation MySQL 8 gives each character set */
const DEFAULT_COLLATIONS: Record<string, string> = {
	utf8mb4: 'utf8mb4_0900_ai_ci',
	utf8mb3: 'utf8mb3_general_ci',
	utf8: 'utf8mb3_general_ci',
	latin1: 'latin1_swedish_ci',
	ascii: 'ascii_general_ci',
	binary: 'binary'
};

const INT_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint']);
const TEXT_TYPES = new Set(['tinytext', 'text', 'mediumtext', 'longtext']);
const CHAR_TYPES = new Set(['char', 'varchar']);
const BLOB_TYPES = new Set(['tinyblob', 'blob', 'mediumblob', 'longblob', 'binary', 'varbinary']);
const TIME_TYPES = new Set(['date', 'datetime', 'timestamp', 'time', 'year']);
const FLOAT_TYPES = new Set(['float', 'double', 'real']);
const DECIMAL_TYPES = new Set(['decimal', 'numeric', 'dec']);

/** the default collation of a character set, or of the charset a collation name starts with */
export function defaultCollation(charset: string): string {
	return DEFAULT_COLLATIONS[charset] ?? `${charset}_general_ci`;
}

/** the character set a collation name belongs to */
export function charsetOfCollation(collation: string): string {
	const head = collation.split('_')[0] as string;
	return head === 'utf8' ? 'utf8mb3' : head;
}

/** whether a column of this type holds text, and so has a collation */
export function isCharacterType(base: string): boolean {
	return CHAR_TYPES.has(base) || TEXT_TYPES.has(base);
}

/** whether a column holds a number SQLite should store with numeric affinity */
export function isNumericType(base: string): boolean {
	return INT_TYPES.has(base) || FLOAT_TYPES.has(base) || DECIMAL_TYPES.has(base);
}

/** whether a column holds a whole number */
export function isIntegerType(base: string): boolean {
	return INT_TYPES.has(base);
}

/** the name a quoted or bare identifier token spells */
export function identName(token: Token): string {
	if (token.type === 'quoted_identifier') return token.text.slice(1, -1).replaceAll('``', '`');
	return token.text;
}

/** a backtick-quoted name for SQL text */
export function quoteName(name: string): string {
	return `\`${name.replaceAll('`', '``')}\``;
}

/** the tokens that are neither whitespace nor comments */
export function significant(tokens: readonly Token[]): Token[] {
	return tokens.filter((t) => t.type !== 'whitespace' && t.type !== 'comment');
}

const isWord = (t: Token | undefined, word: string): boolean =>
	t !== undefined && t.type === 'identifier' && t.text.toUpperCase() === word;

/** splits the tokens between `from` and `to` (exclusive) at top-level commas */
export function splitTopLevel(tokens: readonly Token[], from: number, to: number): Token[][] {
	const items: Token[][] = [];
	let current: Token[] = [];
	let depth = 0;
	for (let i = from; i < to; i++) {
		const t = tokens[i] as Token;
		if (t.type === 'punct' && t.text === '(') depth++;
		else if (t.type === 'punct' && t.text === ')') depth--;
		if (depth === 0 && t.type === 'punct' && t.text === ',') {
			items.push(current);
			current = [];
		} else current.push(t);
	}
	if (current.length > 0) items.push(current);
	return items;
}

/** MySQL 8 prints integer columns without a display width, except `tinyint(1)` */
function normalizeType(base: string, args: string[], unsigned: boolean): string {
	let name = base;
	if (name === 'integer') name = 'int';
	if (name === 'dec' || name === 'numeric') name = 'decimal';
	if (name === 'bool' || name === 'boolean') {
		name = 'tinyint';
		args = ['1'];
	}
	if (INT_TYPES.has(name) && !(name === 'tinyint' && args.join(',') === '1')) args = [];
	let out = args.length > 0 ? `${name}(${args.join(',')})` : name;
	if (unsigned) out += ' unsigned';
	return out;
}

interface ParsedColumn {
	column: ColumnDef;
	inlinePrimary: boolean;
	inlineUnique: boolean;
}

function parseColumn(items: Token[], tableCharset: string, tableCollation: string): ParsedColumn {
	const nameToken = items[0] as Token;
	const name = identName(nameToken);
	const typeToken = items[1];
	if (typeToken === undefined || typeToken.type !== 'identifier') {
		throw new Refusal('ddl-column-definition', `column ${name} has no type`, 1064);
	}
	let base = typeToken.text.toLowerCase();
	let i = 2;
	if (base === 'double' && isWord(items[i], 'PRECISION')) i++;
	const args: string[] = [];
	if (items[i]?.text === '(') {
		const close = matchingParen(items, i);
		if (close < 0)
			throw new Refusal('ddl-column-definition', `unclosed type for ${name}`, 1064);
		for (const part of splitTopLevel(items, i + 1, close)) {
			args.push(
				part.map((t) => (t.type === 'string' ? decodeStringToken(t.text) : t.text)).join('')
			);
		}
		i = close + 1;
	}
	if (base === 'enum' || base === 'set') {
		throw new Refusal('ddl-type-unsupported', `column ${name} is ${base}`);
	}
	let unsigned = false;
	let collation: string | undefined;
	let charset: string | undefined;
	let notNull = false;
	let def: ColumnDefault = { kind: 'none' };
	let autoIncrement = false;
	let comment = '';
	let inlinePrimary = false;
	let inlineUnique = false;
	while (i < items.length) {
		const t = items[i] as Token;
		const word = t.type === 'identifier' ? t.text.toUpperCase() : '';
		if (word === 'UNSIGNED') {
			unsigned = true;
			i++;
		} else if (word === 'SIGNED') {
			i++;
		} else if (word === 'ZEROFILL') {
			throw new Refusal('ddl-column-attribute', `column ${name} uses ZEROFILL`);
		} else if (word === 'NOT' && isWord(items[i + 1], 'NULL')) {
			notNull = true;
			i += 2;
		} else if (word === 'NULL') {
			i++;
		} else if (word === 'AUTO_INCREMENT') {
			autoIncrement = true;
			i++;
		} else if (word === 'PRIMARY') {
			inlinePrimary = true;
			i += isWord(items[i + 1], 'KEY') ? 2 : 1;
		} else if (word === 'UNIQUE') {
			inlineUnique = true;
			i += isWord(items[i + 1], 'KEY') ? 2 : 1;
		} else if (word === 'KEY') {
			inlinePrimary = true;
			i++;
		} else if (word === 'COMMENT' && items[i + 1]?.type === 'string') {
			comment = decodeStringToken((items[i + 1] as Token).text);
			i += 2;
		} else if (word === 'CHARACTER' && isWord(items[i + 1], 'SET')) {
			charset = (items[i + 2] as Token).text.toLowerCase();
			i += 3;
		} else if (word === 'CHARSET') {
			charset = (items[i + 1] as Token).text.toLowerCase();
			i += 2;
		} else if (word === 'COLLATE') {
			collation = (items[i + 1] as Token).text.toLowerCase();
			i += 2;
		} else if (word === 'DEFAULT') {
			const v = items[i + 1];
			if (v === undefined) throw new Refusal('ddl-column-definition', `column ${name}`, 1064);
			i += 2;
			if (v.type === 'string') def = { kind: 'string', value: decodeStringToken(v.text) };
			else if (v.type === 'number') def = { kind: 'number', text: v.text };
			else if (v.type === 'operator' && (v.text === '-' || v.text === '+')) {
				const n = items[i] as Token;
				i++;
				def = { kind: 'number', text: v.text + n.text };
			} else if (isWord(v, 'NULL')) def = { kind: 'null' };
			else if (isWord(v, 'CURRENT_TIMESTAMP') || isWord(v, 'NOW')) {
				def = { kind: 'current_timestamp' };
				if (items[i]?.text === '(') i = matchingParen(items, i) + 1;
			} else throw new Refusal('ddl-default-expression', `column ${name} default ${v.text}`);
		} else {
			throw new Refusal('ddl-column-attribute', `column ${name}: ${t.text}`);
		}
	}
	if (base === 'integer') base = 'int';
	if (base === 'dec' || base === 'numeric') base = 'decimal';
	if (base === 'bool' || base === 'boolean') base = 'tinyint';
	const known =
		INT_TYPES.has(base) ||
		TEXT_TYPES.has(base) ||
		CHAR_TYPES.has(base) ||
		BLOB_TYPES.has(base) ||
		TIME_TYPES.has(base) ||
		FLOAT_TYPES.has(base) ||
		DECIMAL_TYPES.has(base) ||
		base === 'json';
	if (!known) throw new Refusal('ddl-type-unsupported', `column ${name} is ${base}`);
	let effective: string | undefined;
	let effectiveCharset: string | undefined;
	if (isCharacterType(base)) {
		if (collation !== undefined) {
			effective = collation;
			effectiveCharset = charsetOfCollation(collation);
		} else if (charset !== undefined) {
			effectiveCharset = charset;
			effective = charset === tableCharset ? tableCollation : defaultCollation(charset);
		} else {
			effective = tableCollation;
			effectiveCharset = tableCharset;
		}
	}
	return {
		column: {
			name,
			type: normalizeType(base, args, unsigned),
			base,
			unsigned,
			notNull,
			def,
			autoIncrement,
			collation: effective,
			charset: effectiveCharset,
			comment
		},
		inlinePrimary,
		inlineUnique
	};
}

function parseKeyParts(tokens: readonly Token[], open: number): [KeyPart[], number] {
	const close = matchingParen(tokens, open);
	if (close < 0) throw new Refusal('ddl-column-definition', 'unclosed key list', 1064);
	const parts: KeyPart[] = [];
	for (const item of splitTopLevel(tokens, open + 1, close)) {
		const first = item[0] as Token;
		const part: KeyPart = { name: identName(first) };
		if (item[1]?.text === '(' && item[2] !== undefined) part.prefix = Number(item[2].text);
		parts.push(part);
	}
	return [parts, close + 1];
}

/**
 * Parses one `CREATE TABLE` the way dbDelta writes it.
 *
 * Anything the translator cannot give a correct SQLite form (foreign keys, full-text keys, enums,
 * generated columns, `CREATE TABLE ... LIKE`) throws a `Refusal` naming the construct.
 */
export function parseCreateTable(sql: string): { schema: TableSchema; ifNotExists: boolean } {
	const all = tokenize(sql);
	const t = significant(all);
	let i = 0;
	if (!isWord(t[i], 'CREATE'))
		throw new Refusal('ddl-create-unsupported', sql.slice(0, 40), 1064);
	i++;
	if (isWord(t[i], 'TEMPORARY')) throw new Refusal('ddl-create-unsupported', 'TEMPORARY');
	if (!isWord(t[i], 'TABLE')) throw new Refusal('ddl-create-unsupported', sql.slice(0, 40), 1064);
	i++;
	let ifNotExists = false;
	if (isWord(t[i], 'IF') && isWord(t[i + 1], 'NOT') && isWord(t[i + 2], 'EXISTS')) {
		ifNotExists = true;
		i += 3;
	}
	const nameToken = t[i];
	if (nameToken === undefined) throw new Refusal('ddl-column-definition', 'no table name', 1064);
	let tableName = identName(nameToken);
	i++;
	if (t[i]?.text === '.') {
		tableName = identName(t[i + 1] as Token);
		i += 2;
	}
	if (isWord(t[i], 'LIKE') || isWord(t[i], 'AS') || isWord(t[i], 'SELECT')) {
		throw new Refusal('ddl-create-like-select', tableName);
	}
	if (t[i]?.text !== '(') throw new Refusal('ddl-column-definition', 'expected (', 1064);
	const close = matchingParen(t, i);
	if (close < 0) throw new Refusal('ddl-column-definition', 'unclosed definition', 1064);
	const body = splitTopLevel(t, i + 1, close);

	let charset = 'utf8mb4';
	let collation: string | undefined;
	let engine = 'InnoDB';
	let comment = '';
	let k = close + 1;
	while (k < t.length) {
		const token = t[k] as Token;
		const word = token.type === 'identifier' ? token.text.toUpperCase() : '';
		const skipEq = (n: number) => (t[k + n]?.text === '=' ? n + 1 : n);
		if (word === 'DEFAULT') {
			k++;
		} else if (word === 'CHARACTER' && isWord(t[k + 1], 'SET')) {
			const at = skipEq(2);
			charset = (t[k + at] as Token).text.toLowerCase();
			k += at + 1;
		} else if (word === 'CHARSET') {
			const at = skipEq(1);
			charset = (t[k + at] as Token).text.toLowerCase();
			k += at + 1;
		} else if (word === 'COLLATE') {
			const at = skipEq(1);
			collation = (t[k + at] as Token).text.toLowerCase();
			k += at + 1;
		} else if (word === 'ENGINE') {
			const at = skipEq(1);
			engine = (t[k + at] as Token).text;
			k += at + 1;
		} else if (
			word === 'AUTO_INCREMENT' ||
			word === 'ROW_FORMAT' ||
			word === 'AVG_ROW_LENGTH'
		) {
			k += skipEq(1) + 1;
		} else if (word === 'COMMENT') {
			const at = skipEq(1);
			comment = decodeStringToken((t[k + at] as Token).text);
			k += at + 1;
		} else if (token.text === ';') {
			k++;
		} else {
			throw new Refusal('ddl-table-option', token.text);
		}
	}
	if (collation !== undefined && !t.some((x) => isWord(x, 'CHARACTER') || isWord(x, 'CHARSET'))) {
		charset = charsetOfCollation(collation);
	}
	const tableCollation = collation ?? defaultCollation(charset);

	const columns: ColumnDef[] = [];
	const indexes: IndexDef[] = [];
	for (const item of body) {
		const head = item[0] as Token;
		const word = head.type === 'identifier' ? head.text.toUpperCase() : '';
		if (word === 'PRIMARY') {
			const open = item.findIndex((x) => x.text === '(');
			const [parts] = parseKeyParts(item, open);
			indexes.push({ name: 'PRIMARY', kind: 'primary', parts });
		} else if (word === 'UNIQUE') {
			let n = 1;
			if (isWord(item[n], 'KEY') || isWord(item[n], 'INDEX')) n++;
			const open = item.findIndex((x) => x.text === '(');
			const [parts] = parseKeyParts(item, open);
			const name = open > n ? identName(item[n] as Token) : (parts[0] as KeyPart).name;
			indexes.push({ name, kind: 'unique', parts });
		} else if (word === 'KEY' || word === 'INDEX') {
			const open = item.findIndex((x) => x.text === '(');
			const [parts] = parseKeyParts(item, open);
			const name = open > 1 ? identName(item[1] as Token) : (parts[0] as KeyPart).name;
			indexes.push({ name, kind: 'key', parts });
		} else if (word === 'FULLTEXT' || word === 'SPATIAL') {
			throw new Refusal('ddl-fulltext-key', word);
		} else if (word === 'FOREIGN' || word === 'CONSTRAINT' || word === 'CHECK') {
			throw new Refusal('ddl-foreign-key', word);
		} else {
			const parsed = parseColumn(item, charset, tableCollation);
			if (parsed.column.autoIncrement && parsed.column.def.kind !== 'none') {
				throw new Refusal('ddl-column-attribute', `column ${parsed.column.name}`);
			}
			columns.push(parsed.column);
			if (parsed.inlinePrimary) {
				indexes.push({
					name: 'PRIMARY',
					kind: 'primary',
					parts: [{ name: parsed.column.name }]
				});
			}
			if (parsed.inlineUnique) {
				indexes.push({
					name: parsed.column.name,
					kind: 'unique',
					parts: [{ name: parsed.column.name }]
				});
			}
		}
	}
	const names = new Set(columns.map((c) => c.name.toLowerCase()));
	for (const index of indexes) {
		for (const part of index.parts) {
			if (!names.has(part.name.toLowerCase())) {
				throw new Refusal(
					'ddl-key-column',
					`Key column '${part.name}' doesn't exist in table`,
					1072
				);
			}
		}
	}
	for (const column of columns) {
		if (column.autoIncrement) {
			const pk = indexes.find((x) => x.kind === 'primary');
			const single = pk !== undefined && pk.parts.length === 1;
			if (
				!single ||
				(pk?.parts[0] as KeyPart).name.toLowerCase() !== column.name.toLowerCase()
			) {
				throw new Refusal('ddl-auto-increment-key', `column ${column.name}`);
			}
		}
	}
	return {
		schema: {
			name: tableName,
			columns,
			indexes,
			charset,
			collation: tableCollation,
			engine,
			comment
		},
		ifNotExists
	};
}

/** the SQLite collation clause for a MySQL collation, empty when SQLite's default is right */
export function sqliteCollation(collation: string | undefined): string {
	if (collation === undefined) return '';
	if (collation === 'binary' || collation.endsWith('_bin') || collation.endsWith('_cs'))
		return '';
	return ' COLLATE NOCASE';
}

function affinity(column: ColumnDef): string {
	const b = column.base;
	if (INT_TYPES.has(b)) return 'INTEGER';
	if (FLOAT_TYPES.has(b)) return 'REAL';
	if (DECIMAL_TYPES.has(b)) return 'NUMERIC';
	if (BLOB_TYPES.has(b)) return 'BLOB';
	return 'TEXT';
}

function sqliteDefault(column: ColumnDef): string {
	const d = column.def;
	if (d.kind === 'none') return '';
	if (d.kind === 'null') return ' DEFAULT NULL';
	if (d.kind === 'current_timestamp') return ' DEFAULT CURRENT_TIMESTAMP';
	const numeric = isNumericType(column.base);
	const text = d.kind === 'number' ? d.text : d.value;
	if (numeric && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text.trim())) {
		return ` DEFAULT ${text.trim()}`;
	}
	return ` DEFAULT '${text.replaceAll("'", "''")}'`;
}

/** the SQLite index name for a MySQL key: unique per database, where MySQL's is per table */
export function sqliteIndexName(table: string, index: string): string {
	return `${table}__${index}`;
}

/**
 * The SQLite statements that create a MySQL table: one `CREATE TABLE` and one `CREATE INDEX` per key.
 *
 * An AUTO_INCREMENT key becomes `INTEGER PRIMARY KEY AUTOINCREMENT`, so ids are never reused,
 * as InnoDB never reuses them. A prefixed key indexes the whole column; a prefix on a text or
 * blob column, or on a unique key, is refused because the whole-column form would differ.
 */
export function sqliteCreateStatements(schema: TableSchema, ifNotExists: boolean): string[] {
	const guard = ifNotExists ? 'IF NOT EXISTS ' : '';
	const primary = schema.indexes.find((x) => x.kind === 'primary');
	const byName = new Map(schema.columns.map((c) => [c.name.toLowerCase(), c]));
	const lines: string[] = [];
	let inlinePk = false;
	for (const column of schema.columns) {
		let line = `${quoteName(column.name)} ${affinity(column)}`;
		if (column.autoIncrement) {
			line += ' PRIMARY KEY AUTOINCREMENT';
			inlinePk = true;
		} else {
			line += sqliteCollation(column.collation);
			if (column.notNull) line += ' NOT NULL';
			line += sqliteDefault(column);
		}
		lines.push(line);
	}
	if (primary !== undefined && !inlinePk) {
		for (const part of primary.parts) {
			const c = byName.get(part.name.toLowerCase()) as ColumnDef;
			if (part.prefix !== undefined && isPrefixUnsafe(c, part, true)) {
				throw new Refusal('index-prefix-unsafe', `${schema.name}.${part.name}`);
			}
		}
		lines.push(`PRIMARY KEY (${primary.parts.map((p) => quoteName(p.name)).join(', ')})`);
	}
	const out = [`CREATE TABLE ${guard}${quoteName(schema.name)} (${lines.join(', ')})`];
	for (const index of schema.indexes) {
		if (index.kind === 'primary') continue;
		for (const part of index.parts) {
			const c = byName.get(part.name.toLowerCase()) as ColumnDef;
			if (part.prefix !== undefined && isPrefixUnsafe(c, part, index.kind === 'unique')) {
				throw new Refusal('index-prefix-unsafe', `${schema.name}.${index.name}`);
			}
		}
		const unique = index.kind === 'unique' ? 'UNIQUE ' : '';
		const cols = index.parts.map((p) => quoteName(p.name)).join(', ');
		out.push(
			`CREATE ${unique}INDEX ${guard}${quoteName(sqliteIndexName(schema.name, index.name))} ON ${quoteName(schema.name)} (${cols})`
		);
	}
	return out;
}

/** a prefix that is shorter than the column, on a text or blob column or on a unique key */
function isPrefixUnsafe(column: ColumnDef, part: KeyPart, unique: boolean): boolean {
	if (part.prefix === undefined) return false;
	if (TEXT_TYPES.has(column.base) || BLOB_TYPES.has(column.base)) return true;
	const m = /\((\d+)\)/.exec(column.type);
	const length = m === null ? Infinity : Number(m[1]);
	return unique && part.prefix < length;
}

/** whether a key part is a prefix shorter than its column (the index is wider than MySQL's) */
export function isShortPrefix(column: ColumnDef, part: KeyPart): boolean {
	if (part.prefix === undefined) return false;
	const m = /\((\d+)\)/.exec(column.type);
	return m === null || part.prefix < Number(m[1]);
}

/** the keys in the order MySQL lists them: primary, unique, then the rest in definition order */
export function orderedIndexes(schema: TableSchema): IndexDef[] {
	const rank = (x: IndexDef) => (x.kind === 'primary' ? 0 : x.kind === 'unique' ? 1 : 2);
	return schema.indexes
		.map((x, n) => ({ x, n }))
		.sort((a, b) => rank(a.x) - rank(b.x) || a.n - b.n)
		.map((e) => e.x);
}

function keyOf(schema: TableSchema, column: ColumnDef): string {
	const lc = column.name.toLowerCase();
	const inPrimary = schema.indexes.some(
		(x) => x.kind === 'primary' && x.parts.some((p) => p.name.toLowerCase() === lc)
	);
	if (inPrimary) return 'PRI';
	const unique = schema.indexes.some(
		(x) =>
			x.kind === 'unique' &&
			x.parts.length === 1 &&
			(x.parts[0] as KeyPart).name.toLowerCase() === lc
	);
	if (unique) return 'UNI';
	const first = schema.indexes.some((x) => (x.parts[0] as KeyPart).name.toLowerCase() === lc);
	return first ? 'MUL' : '';
}

function defaultText(column: ColumnDef): string | null {
	const d = column.def;
	if (d.kind === 'none' || d.kind === 'null') return null;
	if (d.kind === 'current_timestamp') return 'CURRENT_TIMESTAMP';
	return d.kind === 'number' ? d.text : d.value;
}

/** the rows MySQL answers to `DESCRIBE t` */
export function describeRows(schema: TableSchema): { columns: string[]; rows: unknown[][] } {
	return {
		columns: ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'],
		rows: schema.columns.map((c) => [
			c.name,
			c.type,
			c.notNull ? 'NO' : 'YES',
			keyOf(schema, c),
			defaultText(c),
			c.autoIncrement
				? 'auto_increment'
				: c.def.kind === 'current_timestamp'
					? 'DEFAULT_GENERATED'
					: ''
		])
	};
}

/** the rows MySQL answers to `SHOW FULL COLUMNS FROM t` */
export function fullColumnRows(schema: TableSchema): { columns: string[]; rows: unknown[][] } {
	return {
		columns: [
			'Field',
			'Type',
			'Collation',
			'Null',
			'Key',
			'Default',
			'Extra',
			'Privileges',
			'Comment'
		],
		rows: schema.columns.map((c) => [
			c.name,
			c.type,
			c.collation ?? null,
			c.notNull ? 'NO' : 'YES',
			keyOf(schema, c),
			defaultText(c),
			c.autoIncrement
				? 'auto_increment'
				: c.def.kind === 'current_timestamp'
					? 'DEFAULT_GENERATED'
					: '',
			'select,insert,update,references',
			c.comment
		])
	};
}

/** the rows MySQL answers to `SHOW INDEX FROM t`; cardinality is NULL because nothing here knows it */
export function indexRows(schema: TableSchema): { columns: string[]; rows: unknown[][] } {
	const byName = new Map(schema.columns.map((c) => [c.name.toLowerCase(), c]));
	const rows: unknown[][] = [];
	for (const index of orderedIndexes(schema)) {
		index.parts.forEach((part, n) => {
			const c = byName.get(part.name.toLowerCase()) as ColumnDef;
			rows.push([
				schema.name,
				index.kind === 'key' ? 1 : 0,
				index.name,
				n + 1,
				part.name,
				'A',
				null,
				part.prefix ?? null,
				null,
				c.notNull ? '' : 'YES',
				'BTREE',
				'',
				'',
				'YES',
				null
			]);
		});
	}
	return {
		columns: [
			'Table',
			'Non_unique',
			'Key_name',
			'Seq_in_index',
			'Column_name',
			'Collation',
			'Cardinality',
			'Sub_part',
			'Packed',
			'Null',
			'Index_type',
			'Comment',
			'Index_comment',
			'Visible',
			'Expression'
		],
		rows
	};
}

function showDefault(column: ColumnDef): string {
	const d = column.def;
	if (d.kind === 'none') return '';
	if (d.kind === 'null') return ' DEFAULT NULL';
	if (d.kind === 'current_timestamp') return ' DEFAULT CURRENT_TIMESTAMP';
	const text = d.kind === 'number' ? d.text : d.value;
	return ` DEFAULT '${text.replaceAll("'", "''")}'`;
}

/** the text MySQL answers to `SHOW CREATE TABLE t`, without the AUTO_INCREMENT=n table option */
export function showCreateTable(schema: TableSchema): string {
	const lines: string[] = [];
	for (const c of schema.columns) {
		let line = `  ${quoteName(c.name)} ${c.type}`;
		if (c.collation !== undefined && c.charset !== undefined) {
			if (c.collation !== defaultCollation(c.charset)) line += ` COLLATE ${c.collation}`;
		}
		if (c.notNull) line += ' NOT NULL';
		else if (c.def.kind === 'none') line += ' DEFAULT NULL';
		line += showDefault(c);
		if (c.autoIncrement) line += ' AUTO_INCREMENT';
		if (c.comment !== '') line += ` COMMENT '${c.comment.replaceAll("'", "''")}'`;
		lines.push(line);
	}
	for (const index of orderedIndexes(schema)) {
		const cols = index.parts
			.map((p) => quoteName(p.name) + (p.prefix === undefined ? '' : `(${p.prefix})`))
			.join(',');
		const head =
			index.kind === 'primary'
				? 'PRIMARY KEY'
				: index.kind === 'unique'
					? `UNIQUE KEY ${quoteName(index.name)}`
					: `KEY ${quoteName(index.name)}`;
		lines.push(`  ${head} (${cols})`);
	}
	let tail = `) ENGINE=${schema.engine} DEFAULT CHARSET=${schema.charset}`;
	if (schema.collation !== defaultCollation(schema.charset))
		tail += ` COLLATE=${schema.collation}`;
	return `CREATE TABLE ${quoteName(schema.name)} (\n${lines.join(',\n')}\n${tail}`;
}
