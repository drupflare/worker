import { Refusal } from './classes';
import {
	describeRows,
	fullColumnRows,
	identName,
	indexRows,
	isIntegerType,
	isNumericType,
	isShortPrefix,
	parseCreateTable,
	quoteName,
	showCreateTable,
	sqliteCreateStatements,
	type ColumnDef,
	type KeyPart,
	type TableSchema
} from './ddl';
import { matchingParen, tokenize, utf8Length, type Token } from './lexer';
import { decodeStringToken, encodeSqliteString } from './literal';

/** a string value the translator lifts out of the statement text when the statement is too long */
export interface Lit {
	value: string;
}

/** one piece of SQLite text: verbatim text, or a string literal that may become a bound parameter */
export type Part = string | Lit;

/** one SQLite statement with the values it binds */
export interface Step {
	sql: string;
	params: unknown[];
}

/** what a statement changes in the session or the catalog once it succeeded */
export interface Effect {
	sqlMode?: string;
	charset?: string;
	collation?: string;
	resetFoundRows?: boolean;
	catalogSet?: TableSchema;
	catalogDrop?: string[];
}

/** how the insert id of a write is read back */
export type InsertIdMode = 'none' | 'generated' | 'explicit';

/** what the host does with a translated statement */
export type Plan =
	| { kind: 'error'; errno: number; sqlstate: string; message: string; refused?: string }
	| { kind: 'local'; result?: { columns: string[]; rows: unknown[][] }; effect?: Effect }
	| { kind: 'found-rows' }
	| {
			kind: 'read';
			step: Step;
			calc?: { countStep: Step } | { all: true };
			/** the LIMIT offset, which MySQL's FOUND_ROWS counts without SQL_CALC_FOUND_ROWS */
			offset?: number;
			/** the count without LIMIT, asked for only when a nonzero offset returned no rows */
			countStep?: Step;
	  }
	| {
			kind: 'write';
			steps: Step[];
			insertId: InsertIdMode;
			rows: number;
			odku?: { probe: Step };
	  }
	| { kind: 'ddl'; steps: Step[]; effect: Effect };

/** the result of translating one MySQL statement */
export interface Translation {
	/** the class-table rows the statement touched, in the order they were met */
	classes: string[];
	plan: Plan;
}

/** what every connection to one database shares: the stored schema and the translation cache */
export interface DatabaseState {
	catalog: Map<string, TableSchema>;
	loaded: boolean;
	/** bumps whenever the catalog changes, which retires every cached translation */
	epoch: number;
	cache: Map<string, { epoch: number; mode: string; translation: Translation }>;
	/** translations served from the cache and translations made, since the state was created */
	stats: { hits: number; misses: number };
}

/** a fresh database state with an empty catalog and an empty cache */
export function createDatabaseState(): DatabaseState {
	return {
		catalog: new Map(),
		loaded: false,
		epoch: 0,
		cache: new Map(),
		stats: { hits: 0, misses: 0 }
	};
}

/** the per-connection state a translation reads, plus the database state it shares */
export interface MysqlState {
	sqlMode: string;
	charset: string;
	collation: string;
	database: string;
	serverVersion: string;
	db: DatabaseState;
	foundRows: { count: number } | { countStep: Step } | undefined;
	maxStatementBytes: number;
	maxParams: number;
	maxLikeBytes: number;
}

/** the MySQL 8 default session mode, which is what a connection starts with */
export const DEFAULT_SQL_MODE =
	'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

/** a fresh session over an empty catalog */
export function createState(options: Partial<MysqlState> = {}): MysqlState {
	return {
		sqlMode: DEFAULT_SQL_MODE,
		charset: 'utf8mb4',
		collation: 'utf8mb4_0900_ai_ci',
		database: 'wordpress',
		serverVersion: '8.0.0-drupflare-sqlite',
		db: createDatabaseState(),
		foundRows: undefined,
		maxStatementBytes: 99_000,
		maxParams: 100,
		maxLikeBytes: 50,
		...options
	};
}

const SQL_MODES = [
	'REAL_AS_FLOAT',
	'PIPES_AS_CONCAT',
	'ANSI_QUOTES',
	'IGNORE_SPACE',
	'ONLY_FULL_GROUP_BY',
	'NO_UNSIGNED_SUBTRACTION',
	'NO_DIR_IN_CREATE',
	'ANSI',
	'NO_AUTO_VALUE_ON_ZERO',
	'NO_BACKSLASH_ESCAPES',
	'STRICT_TRANS_TABLES',
	'STRICT_ALL_TABLES',
	'NO_ZERO_IN_DATE',
	'NO_ZERO_DATE',
	'ALLOW_INVALID_DATES',
	'ERROR_FOR_DIVISION_BY_ZERO',
	'TRADITIONAL',
	'HIGH_NOT_PRECEDENCE',
	'NO_ENGINE_SUBSTITUTION',
	'PAD_CHAR_TO_FULL_LENGTH',
	'TIME_TRUNCATE_FRACTIONAL'
];

/** modes whose behaviour the translator does not reproduce, so setting them is refused */
const UNSUPPORTED_MODES = new Set([
	'REAL_AS_FLOAT',
	'PIPES_AS_CONCAT',
	'ANSI_QUOTES',
	'ANSI',
	'NO_BACKSLASH_ESCAPES',
	'HIGH_NOT_PRECEDENCE',
	'NO_UNSIGNED_SUBTRACTION',
	'TRADITIONAL'
]);

const strict = (state: MysqlState) => /STRICT_(TRANS|ALL)_TABLES/.test(state.sqlMode);

const KEYWORDS_BEFORE_PAREN = new Set([
	'IN',
	'NOT',
	'AND',
	'OR',
	'XOR',
	'EXISTS',
	'SELECT',
	'FROM',
	'WHERE',
	'ON',
	'USING',
	'JOIN',
	'AS',
	'UNION',
	'ALL',
	'ANY',
	'SOME',
	'BETWEEN',
	'LIKE',
	'CASE',
	'WHEN',
	'THEN',
	'ELSE',
	'END',
	'DISTINCT',
	'BY',
	'SET',
	'KEY',
	'INDEX',
	'PRIMARY',
	'UNIQUE',
	'INTO',
	'TABLE',
	'IS',
	'HAVING',
	'LIMIT',
	'OFFSET',
	'WITH',
	'ESCAPE',
	'REGEXP',
	'RLIKE',
	'INNER',
	'LEFT',
	'RIGHT',
	'OUTER',
	'CROSS',
	'NATURAL',
	'ORDER',
	'GROUP',
	'DIV',
	'MOD',
	'INTERVAL',
	'IGNORE',
	'VALUES',
	'VALUE'
]);

/** functions whose SQLite behaviour is the MySQL behaviour for the arguments WordPress passes */
const PASS_THROUGH_FUNCTIONS = new Set([
	'COUNT',
	'SUM',
	'MIN',
	'MAX',
	'COALESCE',
	'IFNULL',
	'NULLIF',
	'ABS',
	'REPLACE'
]);

const LOCK_FUNCTIONS = new Set([
	'GET_LOCK',
	'RELEASE_LOCK',
	'IS_FREE_LOCK',
	'IS_USED_LOCK',
	'RELEASE_ALL_LOCKS'
]);

const SELECT_MODIFIERS = new Set([
	'SQL_NO_CACHE',
	'SQL_CACHE',
	'SQL_SMALL_RESULT',
	'SQL_BIG_RESULT',
	'SQL_BUFFER_RESULT',
	'HIGH_PRIORITY'
]);

const LIST_MODIFIERS = new Set([
	...SELECT_MODIFIERS,
	'SQL_CALC_FOUND_ROWS',
	'STRAIGHT_JOIN',
	'DISTINCT',
	'ALL'
]);

const SYSTEM_VARIABLES: Record<string, (s: MysqlState) => string | number> = {
	sql_mode: (s) => s.sqlMode,
	version: (s) => s.serverVersion,
	version_comment: () => 'drupflare mysql translator over sqlite',
	character_set_client: (s) => s.charset,
	character_set_connection: (s) => s.charset,
	character_set_results: (s) => s.charset,
	collation_connection: (s) => s.collation,
	time_zone: () => 'UTC',
	autocommit: () => 1,
	lower_case_table_names: () => 0
};

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const upper = (t: Token | undefined) =>
	t !== undefined && t.type === 'identifier' ? t.text.toUpperCase() : '';

function refusalPlan(r: Refusal): Plan {
	return {
		kind: 'error',
		errno: r.errno,
		sqlstate: r.sqlstate,
		message: r.message,
		refused: r.id
	};
}

function errorPlan(errno: number, sqlstate: string, message: string): Plan {
	return { kind: 'error', errno, sqlstate, message };
}

/** renders parts to SQLite text, lifting the biggest literals to bound parameters if asked */
export function renderParts(parts: readonly Part[], lifted?: ReadonlySet<Lit>): Step {
	let sql = '';
	const params: unknown[] = [];
	const slot = new Map<Lit, number>();
	for (const part of parts) {
		if (typeof part === 'string') {
			sql += part;
		} else if (lifted?.has(part)) {
			let n = slot.get(part);
			if (n === undefined) {
				params.push(part.value);
				n = params.length;
				slot.set(part, n);
			}
			sql += `?${n}`;
		} else {
			sql += encodeSqliteString(part.value);
		}
	}
	return { sql, params };
}

/**
 * Finishes parts into one statement under the platform limits.
 *
 * Literals stay in the text. When the text would pass the statement byte limit, the biggest
 * literals become bound parameters (the byte limit is on the SQL text, not on a bound value),
 * and a statement that still does not fit, or needs more than the parameter limit, is refused.
 */
export function finish(parts: readonly Part[], state: MysqlState): Step {
	const inline = renderParts(parts);
	if (utf8Length(inline.sql) <= state.maxStatementBytes) return inline;
	const lits = [...new Set(parts.filter((p): p is Lit => typeof p !== 'string'))].sort(
		(a, b) => b.value.length - a.value.length
	);
	const lifted = new Set<Lit>();
	const counts = new Map<Lit, number>();
	for (const part of parts) {
		if (typeof part !== 'string') counts.set(part, (counts.get(part) ?? 0) + 1);
	}
	let size = utf8Length(inline.sql);
	for (const lit of lits) {
		if (size <= state.maxStatementBytes) break;
		if (lifted.size >= state.maxParams) break;
		lifted.add(lit);
		size -= (utf8Length(encodeSqliteString(lit.value)) - 3) * (counts.get(lit) ?? 1);
	}
	const step = renderParts(parts, lifted);
	if (utf8Length(step.sql) > state.maxStatementBytes || step.params.length > state.maxParams) {
		throw new Refusal('statement-too-large', `${utf8Length(inline.sql)} bytes`, 1153, '08S01');
	}
	return step;
}

interface RewriteOptions {
	valuesMode?: 'excluded';
	/** column types a literal in this position is coerced to, keyed by token index */
	state: MysqlState;
}

/** the rewriter for one statement: walks its tokens and emits SQLite parts */
class Rewriter {
	readonly classes: string[] = [];
	calc = false;
	lockRead = false;
	orderMark: number | undefined;
	limitMark: number | undefined;
	limitOffset = 0;
	unionSeen = false;
	depth = 0;
	valuesMode: 'excluded' | undefined;

	constructor(
		readonly tokens: readonly Token[],
		readonly state: MysqlState
	) {}

	note(id: string): void {
		if (!this.classes.includes(id)) this.classes.push(id);
	}

	/** the index of the next token that is not whitespace or a comment, or -1 */
	next(i: number, end: number = this.tokens.length): number {
		for (let j = i; j < end; j++) {
			const t = this.tokens[j] as Token;
			if (t.type !== 'whitespace' && t.type !== 'comment') return j;
		}
		return -1;
	}

	/** the index of the last significant token before i, or -1 */
	prev(i: number, start = 0): number {
		for (let j = i; j >= start; j--) {
			const t = this.tokens[j] as Token;
			if (t.type !== 'whitespace' && t.type !== 'comment') return j;
		}
		return -1;
	}

	text(i: number): string {
		return i < 0 ? '' : (this.tokens[i] as Token).text;
	}

	/** the top-level comma-separated ranges between open (exclusive) and close (exclusive) */
	ranges(from: number, to: number): [number, number][] {
		const out: [number, number][] = [];
		let depth = 0;
		let start = from;
		for (let i = from; i < to; i++) {
			const t = this.tokens[i] as Token;
			if (t.type === 'punct' && t.text === '(') depth++;
			else if (t.type === 'punct' && t.text === ')') depth--;
			else if (depth === 0 && t.type === 'punct' && t.text === ',') {
				out.push([start, i]);
				start = i + 1;
			}
		}
		if (start < to || out.length > 0) out.push([start, to]);
		return out;
	}

	emitRange(from: number, to: number): Part[] {
		const out: Part[] = [];
		this.emit(out, from, to);
		return out;
	}

	/** the original text of a token range, trimmed */
	sourceText(from: number, to: number): string {
		let s = '';
		for (let i = from; i < to; i++) s += (this.tokens[i] as Token).text;
		return s.trim();
	}

	/** the end (exclusive) of the operand that starts at the significant token j */
	operandEnd(j: number): number {
		const t = this.tokens[j] as Token;
		if (t.type === 'punct' && t.text === '(') {
			const close = matchingParen(this.tokens, j);
			return close < 0 ? j + 1 : close + 1;
		}
		if (t.type === 'identifier' || t.type === 'quoted_identifier') {
			let end = j + 1;
			for (;;) {
				const dot = this.next(end);
				if (dot >= 0 && this.text(dot) === '.' && this.next(dot + 1) >= 0) {
					end = this.next(dot + 1) + 1;
					continue;
				}
				break;
			}
			const paren = this.next(end);
			if (paren >= 0 && this.text(paren) === '(' && t.type === 'identifier') {
				const close = matchingParen(this.tokens, paren);
				return close < 0 ? end : close + 1;
			}
			return end;
		}
		return j + 1;
	}

	/** removes the operand and a preceding NOT from the end of out; undefined when it is not simple */
	popOperand(out: Part[]): { lhs: string; negated: boolean } | undefined {
		const trim = () => {
			while (
				out.length > 0 &&
				typeof out[out.length - 1] === 'string' &&
				/^\s*$/.test(out[out.length - 1] as string)
			) {
				out.pop();
			}
		};
		trim();
		let negated = false;
		const last = out[out.length - 1];
		if (typeof last === 'string' && last.toUpperCase() === 'NOT') {
			negated = true;
			out.pop();
			trim();
		}
		const ident = /^(`(?:[^`]|``)*`|[A-Za-z_$][A-Za-z0-9_$]*)$/;
		const names: string[] = [];
		for (;;) {
			const p = out[out.length - 1];
			if (typeof p !== 'string' || !ident.test(p)) return undefined;
			names.unshift(p);
			out.pop();
			const dot = out[out.length - 1];
			if (dot === '.') {
				names.unshift('.');
				out.pop();
				continue;
			}
			break;
		}
		return { lhs: names.join(''), negated };
	}

	emit(out: Part[], from: number, to: number): void {
		let i = from;
		while (i < to) {
			const t = this.tokens[i] as Token;
			switch (t.type) {
				case 'whitespace':
					out.push(t.text);
					i++;
					continue;
				case 'comment':
					this.note('comments');
					out.push(' ');
					i++;
					continue;
				case 'executable_comment':
					throw new Refusal('executable-comment', t.text.slice(0, 20));
				case 'error':
					throw new Refusal(
						'syntax-error',
						`near '${t.text.slice(0, 30)}'`,
						1064,
						'42000'
					);
				case 'string':
				case 'national_string':
					this.note('string-literal');
					out.push({ value: decodeStringToken(t.text) });
					i++;
					continue;
				case 'hex':
				case 'bit':
					throw new Refusal('hex-literal', t.text.slice(0, 20));
				case 'variable':
					throw new Refusal('variable-in-expression', t.text);
				case 'operator':
					i = this.operator(out, i);
					continue;
				case 'identifier':
					i = this.word(out, i, to);
					continue;
				case 'punct':
					if (t.text === ';') {
						throw new Refusal('syntax-error', 'more than one statement', 1064, '42000');
					}
					if (t.text === '(') this.depth++;
					else if (t.text === ')') this.depth--;
					out.push(t.text);
					i++;
					continue;
				default:
					out.push(t.text);
					i++;
			}
		}
	}

	private operator(out: Part[], i: number): number {
		const t = this.tokens[i] as Token;
		switch (t.text) {
			case '||':
				this.note('operator-logical');
				out.push(' OR ');
				break;
			case '&&':
				this.note('operator-logical');
				out.push(' AND ');
				break;
			case '<=>':
				this.note('operator-null-safe-equal');
				out.push(' IS ');
				break;
			case '->':
			case '->>':
				throw new Refusal('json-operator', t.text);
			case '?':
				throw new Refusal('syntax-error', "near '?'", 1064, '42000');
			default:
				out.push(t.text);
		}
		return i + 1;
	}

	private word(out: Part[], i: number, to: number): number {
		const t = this.tokens[i] as Token;
		const up = t.text.toUpperCase();
		const after = this.next(i + 1, to);
		const afterText = this.text(after);

		if (up === 'SQL_CALC_FOUND_ROWS') {
			this.calc = true;
			this.note('calc-found-rows');
			return i + 1;
		}
		if (SELECT_MODIFIERS.has(up)) {
			this.note('select-modifiers');
			return i + 1;
		}
		if (up === 'STRAIGHT_JOIN') {
			this.note('straight-join');
			const p = this.prev(i - 1);
			if (upper(this.tokens[p]) === 'SELECT') return i + 1;
			out.push('CROSS JOIN');
			return i + 1;
		}
		if (
			up === 'FOR' &&
			(upper(this.tokens[after]) === 'UPDATE' || upper(this.tokens[after]) === 'SHARE')
		) {
			this.note('locking-read');
			this.lockRead = true;
			const end = after + 1;
			const mod = upper(this.tokens[this.next(end, to)]);
			if (mod === 'NOWAIT' || mod === 'SKIP') throw new Refusal('locking-read-nowait', mod);
			return end;
		}
		if (up === 'LOCK' && upper(this.tokens[after]) === 'IN') {
			const a = this.next(after + 1, to);
			const b = this.next(a + 1, to);
			if (upper(this.tokens[a]) === 'SHARE' && upper(this.tokens[b]) === 'MODE') {
				this.note('locking-read');
				this.lockRead = true;
				return b + 1;
			}
		}
		if (up === 'LIMIT') return this.limit(out, i, to);
		if (up === 'ORDER' && upper(this.tokens[after]) === 'BY' && this.depth === 0) {
			this.orderMark ??= out.length;
		}
		if (up === 'UNION' && this.depth === 0) this.unionSeen = true;
		if (up === 'LIKE') return this.like(out, i, to);
		if (up === 'REGEXP' || up === 'RLIKE') return this.regexp(out, i, to);
		if (up === 'COLLATE' && after >= 0) {
			this.note('collate');
			out.push('COLLATE ');
			out.push(sqliteCollationName(this.text(after)));
			return after + 1;
		}
		if (up === 'MATCH' && afterText === '(') throw new Refusal('match-against', 'MATCH');
		if (
			(up === 'USE' || up === 'FORCE' || up === 'IGNORE') &&
			['INDEX', 'KEY'].includes(upper(this.tokens[after]))
		) {
			throw new Refusal('index-hint', `${up} ${upper(this.tokens[after])}`);
		}
		if (up === 'INTO' && ['OUTFILE', 'DUMPFILE'].includes(upper(this.tokens[after]))) {
			throw new Refusal('select-into', upper(this.tokens[after]));
		}
		if (up === 'INTO' && this.tokens[after]?.type === 'variable') {
			throw new Refusal('select-into', 'variable');
		}
		if (t.text.toLowerCase() === 'information_schema' && this.text(after) === '.') {
			return this.informationSchema(out, i, to);
		}
		if (up === 'VALUES' && afterText === '(' && this.valuesMode !== 'excluded') {
			throw new Refusal('values-function', 'VALUES() outside ON DUPLICATE KEY UPDATE');
		}
		const valuesCall = up === 'VALUES' && this.valuesMode === 'excluded';
		if (afterText === '(' && (valuesCall || !KEYWORDS_BEFORE_PAREN.has(up))) {
			return this.call(out, i, after);
		}
		out.push(t.text);
		return i + 1;
	}

	private limit(out: Part[], i: number, to: number): number {
		const a = this.next(i + 1, to);
		const comma = this.next(a + 1, to);
		const b = this.next(comma + 1, to);
		if (a >= 0 && comma >= 0 && this.text(comma) === ',' && b >= 0) {
			const ta = this.tokens[a] as Token;
			const tb = this.tokens[b] as Token;
			if (ta.type === 'number' && tb.type === 'number') {
				this.note('limit-offset');
				if (this.depth === 0) {
					this.limitMark ??= out.length;
					this.limitOffset = Number(ta.text);
				}
				out.push(`LIMIT ${tb.text} OFFSET ${ta.text}`);
				return b + 1;
			}
		}
		if (this.depth === 0) {
			this.limitMark ??= out.length;
			const kw = this.next(a + 1, to);
			const o = this.next(kw + 1, to);
			if (upper(this.tokens[kw]) === 'OFFSET' && this.tokens[o]?.type === 'number') {
				this.limitOffset = Number(this.text(o));
			}
		}
		out.push('LIMIT');
		return i + 1;
	}

	private like(out: Part[], i: number, to: number): number {
		const j = this.next(i + 1, to);
		if (j < 0) throw new Refusal('syntax-error', 'LIKE', 1064, '42000');
		this.note('like');
		const tj = this.tokens[j] as Token;
		const end = this.operandEnd(j);
		const nextWord = upper(this.tokens[this.next(end, to)]);
		if (tj.type === 'string' && nextWord !== 'ESCAPE') {
			const pattern = decodeStringToken(tj.text);
			if (utf8Length(pattern) > this.state.maxLikeBytes) {
				const popped = this.popOperand(out);
				const rewrite = popped === undefined ? undefined : longLike(popped.lhs, pattern);
				if (popped === undefined || rewrite === undefined) {
					throw new Refusal('like-pattern-too-long', `${utf8Length(pattern)} bytes`);
				}
				this.note('like-long');
				if (popped.negated) out.push('NOT ');
				out.push(...rewrite);
				return end;
			}
		}
		out.push('LIKE ');
		this.emit(out, j, end);
		if (nextWord !== 'ESCAPE') out.push(" ESCAPE '\\'");
		return end;
	}

	private regexp(out: Part[], i: number, to: number): number {
		const j = this.next(i + 1, to);
		const tj = this.tokens[j] as Token | undefined;
		if (tj === undefined || tj.type !== 'string') {
			throw new Refusal('regexp-other', 'the pattern is not a string literal');
		}
		const popped = this.popOperand(out);
		if (popped === undefined) {
			throw new Refusal('regexp-other', 'the left side is not a plain column');
		}
		const sql = compileRegexp(popped.lhs, decodeStringToken(tj.text));
		this.note('regexp');
		if (popped.negated) out.push('NOT ');
		out.push(...sql);
		return j + 1;
	}

	private informationSchema(out: Part[], i: number, to: number): number {
		const dot = this.next(i + 1, to);
		const table = this.next(dot + 1, to);
		if (table < 0 || (this.tokens[table] as Token).text.toUpperCase() !== 'TABLES') {
			throw new Refusal('information-schema-other', this.text(table));
		}
		this.note('information-schema-tables');
		const rows = [...this.state.db.catalog.values()];
		const db = this.state.database;
		const cols = (name: string, engine: string, collation: string) =>
			`SELECT 'def' AS TABLE_CATALOG, ${encodeSqliteString(db)} AS TABLE_SCHEMA, ${encodeSqliteString(name)} AS TABLE_NAME, 'BASE TABLE' AS TABLE_TYPE, ${encodeSqliteString(engine)} AS ENGINE, ${encodeSqliteString(collation)} AS TABLE_COLLATION`;
		const body =
			rows.length === 0
				? `SELECT NULL AS TABLE_CATALOG, NULL AS TABLE_SCHEMA, NULL AS TABLE_NAME, NULL AS TABLE_TYPE, NULL AS ENGINE, NULL AS TABLE_COLLATION WHERE 0`
				: rows.map((s) => cols(s.name, s.engine, s.collation)).join(' UNION ALL ');
		out.push(`(${body})`);
		const nx = this.next(table + 1, to);
		const hasAlias =
			nx >= 0 &&
			(this.tokens[nx] as Token).type === 'identifier' &&
			![
				'WHERE',
				'LIMIT',
				'ORDER',
				'GROUP',
				'HAVING',
				'JOIN',
				'INNER',
				'LEFT',
				'ON',
				'UNION'
			].includes(upper(this.tokens[nx]));
		if (!hasAlias) out.push(' AS TABLES');
		return table + 1;
	}

	private call(out: Part[], i: number, open: number): number {
		const nameToken = this.tokens[i] as Token;
		const name = nameToken.text.toUpperCase();
		const close = matchingParen(this.tokens, open);
		if (close < 0) throw new Refusal('syntax-error', `near '${nameToken.text}'`, 1064, '42000');
		const args = this.ranges(open + 1, close);
		const arg = (n: number) =>
			this.emitRange((args[n] as [number, number])[0], (args[n] as [number, number])[1]);
		const wrap = (parts: Part[]): Part[] => ['(', ...parts, ')'];
		const trimmed = (parts: Part[]): Part[] => {
			const copy = [...parts];
			while (typeof copy[0] === 'string' && /^\s*$/.test(copy[0])) copy.shift();
			while (
				typeof copy[copy.length - 1] === 'string' &&
				/^\s*$/.test(copy[copy.length - 1] as string)
			)
				copy.pop();
			return copy;
		};

		if (LOCK_FUNCTIONS.has(name)) throw new Refusal('get-lock', name);
		if (PASS_THROUGH_FUNCTIONS.has(name)) {
			this.note('fn-aggregate');
			out.push(nameToken.text, '(');
			this.emit(out, open + 1, close);
			out.push(')');
			return close + 1;
		}
		switch (name) {
			case 'CONCAT': {
				if (args.length === 0) throw new Refusal('syntax-error', 'CONCAT()', 1064, '42000');
				this.note('fn-concat');
				out.push('(');
				args.forEach((_, n) => {
					if (n > 0) out.push(' || ');
					out.push(...wrap(trimmed(arg(n))));
				});
				out.push(')');
				return close + 1;
			}
			case 'SUBSTRING':
			case 'SUBSTR':
			case 'MID': {
				if (args.length < 2 || args.length > 3) {
					throw new Refusal('function-form', `${name} with ${args.length} arguments`);
				}
				for (let n = 0; n < args.length; n++) {
					const [a, b] = args[n] as [number, number];
					for (let k = a; k < b; k++) {
						if (['FROM', 'FOR'].includes(upper(this.tokens[k]))) {
							throw new Refusal('function-form', 'SUBSTRING(... FROM ... FOR ...)');
						}
					}
				}
				this.note('fn-substring');
				out.push('substr(');
				args.forEach((_, n) => {
					if (n > 0) out.push(', ');
					out.push(...trimmed(arg(n)));
				});
				out.push(')');
				return close + 1;
			}
			case 'YEAR':
			case 'MONTH':
			case 'DAYOFMONTH':
			case 'DAY': {
				if (args.length !== 1) throw new Refusal('function-form', `${name} arguments`);
				this.note('fn-date-part');
				const [from, len] = name === 'YEAR' ? [1, 4] : name === 'MONTH' ? [6, 2] : [9, 2];
				out.push(`CAST(substr(`, ...trimmed(arg(0)), `, ${from}, ${len}) AS INTEGER)`);
				return close + 1;
			}
			case 'NOW':
			case 'CURRENT_TIMESTAMP': {
				if (args.length > 0) throw new Refusal('function-form', 'NOW(fsp)');
				this.note('fn-now');
				out.push("datetime('now')");
				return close + 1;
			}
			case 'DATE_SUB':
			case 'DATE_ADD': {
				if (args.length !== 2) throw new Refusal('function-form', `${name} arguments`);
				const [a, b] = args[1] as [number, number];
				const first = this.next(a, b);
				if (upper(this.tokens[first]) !== 'INTERVAL') {
					throw new Refusal('function-form', `${name} without INTERVAL`);
				}
				const unitIndex = this.prev(b - 1, first);
				const unit = upper(this.tokens[unitIndex]);
				const unitMap: Record<string, [string, number]> = {
					SECOND: ['seconds', 1],
					MINUTE: ['minutes', 1],
					HOUR: ['hours', 1],
					DAY: ['days', 1],
					WEEK: ['days', 7],
					MONTH: ['months', 1],
					YEAR: ['years', 1]
				};
				const spec = unitMap[unit];
				if (spec === undefined) throw new Refusal('function-form', `INTERVAL ${unit}`);
				this.note('fn-date-add');
				const sign = name === 'DATE_SUB' ? -1 : 1;
				const nIndex = this.next(first + 1, unitIndex);
				const single = nIndex >= 0 && this.next(nIndex + 1, unitIndex) < 0 ? nIndex : -1;
				out.push('datetime(', ...trimmed(arg(0)), ', ');
				if (
					single >= 0 &&
					(this.tokens[single] as Token).type === 'number' &&
					/^\d+$/.test(this.text(single))
				) {
					const value = sign * Number(this.text(single)) * spec[1];
					out.push(`'${value >= 0 ? '+' : ''}${value} ${spec[0]}')`);
				} else {
					const expr = trimmed(this.emitRange(first + 1, unitIndex));
					out.push(`printf('%+d ${spec[0]}', ${sign * spec[1]} * (`, ...expr, ')))');
				}
				return close + 1;
			}
			case 'VALUES': {
				if (this.valuesMode !== 'excluded' || args.length !== 1) {
					throw new Refusal(
						'values-function',
						'VALUES() outside ON DUPLICATE KEY UPDATE'
					);
				}
				const parts = trimmed(arg(0));
				const col = parts.join('').replace(/^.*\./, '');
				out.push(`excluded.${col}`);
				return close + 1;
			}
			default:
				throw new Refusal('function-unknown', name);
		}
	}
}

/** the SQLite collation for a MySQL collation name */
export function sqliteCollationName(name: string): string {
	const n = name.replaceAll('`', '').toLowerCase();
	if (n === 'binary' || n.endsWith('_bin') || n.endsWith('_cs')) return 'BINARY';
	if (n.endsWith('_ci')) return 'NOCASE';
	throw new Refusal('collation-unknown', name);
}

interface LikeShape {
	lead: boolean;
	trail: boolean;
	literal: string;
}

/** splits a LIKE pattern into optional edge wildcards around one literal, or undefined */
function likeShape(pattern: string): LikeShape | undefined {
	let i = 0;
	let lead = false;
	if (pattern[0] === '%') {
		lead = true;
		i = 1;
	}
	let literal = '';
	let trail = false;
	while (i < pattern.length) {
		const c = pattern[i] as string;
		if (c === '\\' && i + 1 < pattern.length) {
			literal += pattern[i + 1];
			i += 2;
		} else if (c === '%') {
			if (i !== pattern.length - 1) return undefined;
			trail = true;
			i++;
		} else if (c === '_') {
			return undefined;
		} else {
			literal += c;
			i++;
		}
	}
	return literal === '' ? undefined : { lead, trail, literal };
}

/** the SQLite expression for a LIKE whose pattern is over the platform's pattern limit */
function longLike(lhs: string, pattern: string): Part[] | undefined {
	const shape = likeShape(pattern);
	if (shape === undefined) return undefined;
	const lit: Lit = { value: asciiLower(shape.literal) };
	const n = [...shape.literal].length;
	if (shape.lead && shape.trail) return [`(instr(lower(${lhs}), `, lit, ') > 0)'];
	if (shape.trail) return [`(substr(lower(${lhs}), 1, ${n}) = `, lit, ')'];
	if (shape.lead) return [`(substr(lower(${lhs}), -${n}) = `, lit, ')'];
	return [`(${lhs} = `, { value: shape.literal }, ' COLLATE NOCASE)'];
}

interface ReSegment {
	kind: 'lit' | 'class' | 'any';
	text: string;
	n: number;
}

/** compiles ^literal[class]{n}(literal)?$ into SQLite expressions that need no REGEXP */
function compileRegexp(lhs: string, pattern: string): Part[] {
	if (!pattern.startsWith('^') || !pattern.endsWith('$') || pattern.endsWith('\\$')) {
		throw new Refusal('regexp-other', 'only anchored patterns (^...$) are translated');
	}
	const body = pattern.slice(1, -1);
	const variants: ReSegment[][] = [[]];
	let optionalSeen = false;
	let i = 0;
	const push = (seg: ReSegment) => {
		for (const v of variants) {
			const last = v[v.length - 1];
			if (seg.kind === 'lit' && last?.kind === 'lit') last.text += seg.text;
			else v.push({ ...seg });
		}
	};
	const quantifier = (): number => {
		const m = /^\{(\d+)\}/.exec(body.slice(i));
		if (m === null) return 1;
		i += m[0].length;
		return Number(m[1]);
	};
	while (i < body.length) {
		const c = body[i] as string;
		if (c === '[') {
			const close = body.indexOf(']', i + 1);
			if (close < 0 || body[i + 1] === '^' || body[i + 1] === ']') {
				throw new Refusal('regexp-other', 'unsupported character class');
			}
			const set = body.slice(i + 1, close);
			if (!/^([A-Za-z0-9_]-[A-Za-z0-9_]|[A-Za-z0-9_])+$/.test(set)) {
				throw new Refusal('regexp-other', 'unsupported character class');
			}
			i = close + 1;
			const n = quantifier();
			push({ kind: 'class', text: asciiLower(set), n });
		} else if (c === '.') {
			i++;
			push({ kind: 'any', text: '', n: quantifier() });
		} else if (c === '(') {
			const close = body.indexOf(')', i);
			const group = close < 0 ? '' : body.slice(i + 1, close);
			if (
				close < 0 ||
				body[close + 1] !== '?' ||
				!/^[A-Za-z0-9_ -]+$/.test(group) ||
				optionalSeen
			) {
				throw new Refusal(
					'regexp-other',
					'only one optional literal group (x)? is translated'
				);
			}
			optionalSeen = true;
			i = close + 2;
			const withGroup = variants.map((v) => v.map((s) => ({ ...s })));
			for (const v of withGroup) {
				const last = v[v.length - 1];
				if (last?.kind === 'lit') last.text += asciiLower(group);
				else v.push({ kind: 'lit', text: asciiLower(group), n: 1 });
			}
			variants.push(...withGroup);
		} else if (c === '\\') {
			const e = body[i + 1];
			if (e === undefined || /[A-Za-z0-9]/.test(e)) {
				throw new Refusal('regexp-other', 'unsupported escape');
			}
			i += 2;
			push({ kind: 'lit', text: e, n: 1 });
		} else if ('*+?{}|)^$'.includes(c)) {
			throw new Refusal('regexp-other', `unsupported operator ${c}`);
		} else {
			i++;
			if (body[i] === '{')
				throw new Refusal('regexp-other', 'a repeated literal is not translated');
			push({ kind: 'lit', text: asciiLower(c), n: 1 });
		}
	}
	const alternatives: Part[][] = [];
	for (const v of variants) {
		const parts: Part[] = [];
		let pos = 1;
		let total = 0;
		const conds: Part[][] = [];
		for (const seg of v) {
			const len = seg.kind === 'lit' ? [...seg.text].length : seg.n;
			if (seg.kind === 'lit') {
				conds.push([`substr(lower(${lhs}), ${pos}, ${len}) = `, { value: seg.text }]);
			} else if (seg.kind === 'class') {
				conds.push([`substr(lower(${lhs}), ${pos}, ${len}) NOT GLOB '*[^${seg.text}]*'`]);
			}
			pos += len;
			total += len;
		}
		parts.push(`(length(${lhs}) = ${total}`);
		for (const c of conds) parts.push(' AND ', ...c);
		parts.push(')');
		alternatives.push(parts);
	}
	const out: Part[] = ['('];
	alternatives.forEach((a, n) => {
		if (n > 0) out.push(' OR ');
		out.push(...a);
	});
	out.push(')');
	return out;
}

/** the numeric value MySQL reads from the front of a string, as SQL text */
export function numericPrefix(text: string, integer: boolean): { value: string; clean: boolean } {
	const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(text);
	if (m === null) return { value: '0', clean: text.trim() === '' ? false : false };
	const clean = m[0].length === text.length;
	if (integer) {
		const n = Number(m[0]);
		return {
			value: String(Number.isSafeInteger(Math.round(n)) ? Math.round(n) : m[0].trim()),
			clean
		};
	}
	return { value: m[0].trim(), clean };
}

const ZERO_DATES: Record<string, string> = {
	date: '0000-00-00',
	datetime: '0000-00-00 00:00:00',
	timestamp: '0000-00-00 00:00:00',
	time: '00:00:00',
	year: '0000'
};

function implicitDefault(column: ColumnDef): Part {
	if (isNumericType(column.base)) return '0';
	const zero = ZERO_DATES[column.base];
	if (zero !== undefined) return { value: zero };
	return { value: '' };
}

/** the schema of a table named by a token, or undefined when the catalog does not know it */
function schemaOf(state: MysqlState, name: string): TableSchema | undefined {
	return state.db.catalog.get(name.toLowerCase());
}

function tableNotFound(state: MysqlState, name: string): Plan {
	return errorPlan(1146, '42S02', `Table '${state.database}.${name}' doesn't exist`);
}

/** a MySQL error plan, or undefined, for a literal that cannot be stored in the column */
function coerce(
	state: MysqlState,
	column: ColumnDef,
	token: Token,
	row: number
): { part: Part } | { error: Plan } | undefined {
	if (token.type !== 'string') return undefined;
	const value = decodeStringToken(token.text);
	if (isNumericType(column.base)) {
		const { value: v, clean } = numericPrefix(value, isIntegerType(column.base));
		if (clean) return undefined;
		if (strict(state)) {
			return {
				error: errorPlan(
					1366,
					'HY000',
					`Incorrect ${isIntegerType(column.base) ? 'integer' : 'decimal'} value: '${value}' for column '${column.name}' at row ${row}`
				)
			};
		}
		return { part: v };
	}
	if (column.base in ZERO_DATES && column.base !== 'time') {
		const zero = ZERO_DATES[column.base] as string;
		if (value === zero && strict(state) && state.sqlMode.includes('NO_ZERO_DATE')) {
			return {
				error: errorPlan(
					1292,
					'22007',
					`Incorrect ${column.base} value: '${value}' for column '${column.name}' at row ${row}`
				)
			};
		}
	}
	return undefined;
}

class StatementTranslator {
	readonly sig: number[] = [];
	readonly r: Rewriter;

	constructor(
		readonly sql: string,
		readonly tokens: Token[],
		readonly state: MysqlState
	) {
		this.r = new Rewriter(tokens, state);
		tokens.forEach((t, n) => {
			if (t.type !== 'whitespace' && t.type !== 'comment') this.sig.push(n);
		});
	}

	word(n: number): string {
		return upper(this.tokens[this.sig[n] as number]);
	}

	at(n: number): Token | undefined {
		const i = this.sig[n];
		return i === undefined ? undefined : this.tokens[i];
	}

	/** the significant-index of the first top-level word in the set at or after n, or -1 */
	find(from: number, words: string[], to = this.sig.length): number {
		let depth = 0;
		for (let n = from; n < to; n++) {
			const t = this.at(n) as Token;
			if (t.type === 'punct' && t.text === '(') depth++;
			else if (t.type === 'punct' && t.text === ')') depth--;
			else if (depth === 0 && t.type === 'identifier' && words.includes(t.text.toUpperCase()))
				return n;
		}
		return -1;
	}

	translate(): Translation {
		const lead = this.word(0);
		let plan: Plan;
		switch (lead) {
			case 'SET':
				plan = this.set();
				break;
			case 'SELECT':
				plan = this.select();
				break;
			case 'INSERT':
			case 'REPLACE':
				plan = this.insert();
				break;
			case 'UPDATE':
				plan = this.update();
				break;
			case 'DELETE':
				plan = this.delete();
				break;
			case 'SHOW':
				plan = this.show();
				break;
			case 'DESCRIBE':
			case 'DESC':
			case 'EXPLAIN':
				plan = this.describe();
				break;
			case 'CREATE':
				plan = this.create();
				break;
			case 'DROP':
				plan = this.drop();
				break;
			case 'ALTER':
				throw new Refusal('alter-table', this.sql.slice(0, 40));
			case 'TRUNCATE':
				throw new Refusal('truncate', this.sql.slice(0, 40));
			case 'RENAME':
				throw new Refusal('alter-table', 'RENAME TABLE');
			case 'BEGIN':
			case 'START':
			case 'COMMIT':
			case 'ROLLBACK':
				throw new Refusal('transaction', lead);
			case 'SAVEPOINT':
			case 'RELEASE':
				throw new Refusal('savepoint', lead);
			case 'LOCK':
			case 'UNLOCK':
				throw new Refusal('lock-tables', lead);
			case 'LOAD':
				throw new Refusal('load-data', lead);
			case 'CALL':
			case 'PREPARE':
			case 'EXECUTE':
			case 'HANDLER':
				throw new Refusal('routines-triggers-views', lead);
			case 'OPTIMIZE':
			case 'ANALYZE':
			case 'REPAIR':
			case 'CHECK':
			case 'FLUSH':
			case 'KILL':
			case 'USE':
			case 'GRANT':
			case 'REVOKE':
				throw new Refusal('maintenance-statement', lead);
			default:
				if (lead === '' || this.tokens[this.sig[0] as number]?.text === '(') {
					if (
						this.tokens[this.sig[0] as number]?.text === '(' &&
						this.word(1) === 'SELECT'
					) {
						plan = this.select();
						break;
					}
				}
				throw new Refusal(
					'statement-unknown',
					lead || this.sql.slice(0, 20),
					1064,
					'42000'
				);
		}
		return { classes: this.r.classes, plan };
	}

	private note(id: string, enabled = true): void {
		if (enabled) this.r.note(id);
	}

	// #region session statements

	private set(): Plan {
		const w1 = this.word(1);
		if (w1 === 'NAMES') {
			this.note('set-names');
			const value = this.at(2);
			if (value === undefined) throw new Refusal('syntax-error', 'SET NAMES', 1064, '42000');
			const charset = (
				value.type === 'string' ? decodeStringToken(value.text) : value.text
			).toLowerCase();
			let collation = charset === 'utf8mb4' ? 'utf8mb4_0900_ai_ci' : `${charset}_general_ci`;
			if (this.word(3) === 'COLLATE') {
				const c = this.at(4);
				if (c === undefined) throw new Refusal('syntax-error', 'SET NAMES', 1064, '42000');
				collation = (
					c.type === 'string' ? decodeStringToken(c.text) : c.text
				).toLowerCase();
			}
			return {
				kind: 'local',
				effect: { charset, collation, resetFoundRows: true }
			};
		}
		let n = 1;
		if (['SESSION', 'LOCAL'].includes(w1)) n = 2;
		else if (w1 === 'GLOBAL') throw new Refusal('set-variable', 'GLOBAL');
		let name = this.at(n)?.text ?? '';
		if (name.startsWith('@@')) {
			name = name.slice(2).replace(/^(session|local)\./i, '');
		}
		if (name.toLowerCase() === 'sql_mode' && this.at(n + 1)?.text === '=') {
			const value = this.at(n + 2);
			let list: string;
			if (value !== undefined && value.type === 'string' && this.at(n + 3) === undefined) {
				list = decodeStringToken(value.text);
			} else {
				const rest: string[] = [];
				for (let k = n + 2; k < this.sig.length; k++) {
					const t = this.at(k) as Token;
					if (t.type !== 'identifier' && t.text !== ',') {
						throw new Refusal('set-variable', 'sql_mode value is not a mode list');
					}
					rest.push(t.text);
				}
				list = rest.join('');
			}
			this.note('set-sql-mode');
			return { kind: 'local', effect: { sqlMode: canonicalMode(list) } };
		}
		throw new Refusal('set-variable', this.at(n)?.text ?? '');
	}

	// #endregion

	// #region select

	private hostSelect(): Plan | undefined {
		const end = this.sig.length;
		const items: [number, number][] = [];
		let start = 1;
		for (let n = 1; n <= end; n++) {
			if (n === end || this.at(n)?.text === ',') {
				if (n === start) return undefined;
				items.push([start, n]);
				start = n + 1;
			}
		}
		const columns: string[] = [];
		const row: unknown[] = [];
		for (const [a, b] of items) {
			const first = this.at(a) as Token;
			const source = this.tokens
				.slice(this.sig[a] as number, (this.sig[b - 1] as number) + 1)
				.map((t) => t.text)
				.join('')
				.trim();
			if (first.type === 'variable' && first.text.startsWith('@@') && b - a === 1) {
				const name = first.text
					.slice(2)
					.replace(/^(session|local)\./i, '')
					.toLowerCase();
				const fn = SYSTEM_VARIABLES[name];
				if (fn === undefined) throw new Refusal('system-variable', first.text);
				this.note('select-system-variable');
				columns.push(source);
				row.push(fn(this.state));
			} else if (upper(first) === 'VERSION' && b - a === 3 && this.at(a + 1)?.text === '(') {
				this.note('select-version');
				columns.push(source);
				row.push(this.state.serverVersion);
			} else return undefined;
		}
		return { kind: 'local', result: { columns, rows: [row] } };
	}

	private select(): Plan {
		if (
			this.word(1) === 'FOUND_ROWS' &&
			this.at(2)?.text === '(' &&
			this.at(3)?.text === ')' &&
			this.sig.length === 4
		) {
			this.note('found-rows');
			return { kind: 'found-rows' };
		}
		if (this.find(1, ['FROM', 'WHERE', 'UNION']) < 0) {
			const host = this.hostSelect();
			if (host !== undefined) return host;
		}
		const r = this.r;
		const out: Part[] = [];
		const total = this.tokens.length;
		const from = this.find(1, ['FROM']);
		const selectIndex = this.sig[0] as number;
		const parenStart = this.tokens[selectIndex]?.text === '(';
		let listFrom = selectIndex + 1;
		out.push(this.tokens[selectIndex]?.text ?? 'SELECT');
		if (parenStart) {
			r.emit(out, selectIndex + 1, total);
			return this.finishRead(out);
		}
		// modifiers sit between SELECT and the list; the rewriter drops the hints
		const fromIndex = from < 0 ? total : (this.sig[from] as number);
		const items = r.ranges(listFrom, fromIndex);
		items.forEach(([a, b], n) => {
			if (n > 0) out.push(',');
			const piece = r.emitRange(a, b);
			const lead =
				/^((SQL_CALC_FOUND_ROWS|SQL_NO_CACHE|SQL_CACHE|SQL_SMALL_RESULT|SQL_BIG_RESULT|SQL_BUFFER_RESULT|HIGH_PRIORITY|STRAIGHT_JOIN|DISTINCT|ALL)\s+)*/i;
			const rendered = piece
				.map((p) => (typeof p === 'string' ? p : encodeSqliteString(p.value)))
				.join('')
				.trim()
				.replace(lead, '');
			out.push(...piece);
			const bare = this.tokens
				.slice(a, b)
				.filter((t) => t.type !== 'comment')
				.map((t) => t.text)
				.join('')
				.trim()
				.replace(lead, '');
			const words = this.tokens
				.slice(a, b)
				.filter((t) => t.type !== 'whitespace' && t.type !== 'comment');
			while (
				words.length > 1 &&
				words[0]?.type === 'identifier' &&
				LIST_MODIFIERS.has(words[0].text.toUpperCase())
			) {
				words.shift();
			}
			const only = words.length === 1 ? (words[0] as Token) : undefined;
			const literal =
				only !== undefined && (only.type === 'string' || only.type === 'national_string');
			const name = literal ? decodeStringToken((only as Token).text) : bare;
			if ((literal || rendered !== name) && !this.hasAlias(a, b))
				out.push(` AS ${quoteName(name)}`);
		});
		void listFrom;
		if (from >= 0) {
			r.emit(out, fromIndex, total);
		}
		return this.finishRead(out);
	}

	private hasAlias(a: number, b: number): boolean {
		const sigs: Token[] = [];
		for (let i = a; i < b; i++) {
			const t = this.tokens[i] as Token;
			if (t.type !== 'whitespace' && t.type !== 'comment') sigs.push(t);
		}
		if (sigs.some((t) => t.type === 'identifier' && t.text.toUpperCase() === 'AS')) return true;
		if (sigs.length < 2) return false;
		const last = sigs[sigs.length - 1] as Token;
		const prev = sigs[sigs.length - 2] as Token;
		if (last.type !== 'identifier' && last.type !== 'quoted_identifier') return false;
		if (['END', 'NULL', 'TRUE', 'FALSE'].includes(last.text.toUpperCase())) return false;
		if (prev.type === 'operator' || (prev.type === 'punct' && prev.text !== ')')) return false;
		return true;
	}

	private finishRead(out: Part[]): Plan {
		const r = this.r;
		const step = finish(out, this.state);
		if (r.calc) {
			const cut = r.orderMark ?? r.limitMark ?? out.length;
			const countStep = finish(
				['SELECT count(*) FROM (', ...out.slice(0, cut), ')'],
				this.state
			);
			if (r.limitMark === undefined) return { kind: 'read', step, calc: { all: true } };
			return { kind: 'read', step, calc: { countStep } };
		}
		if (r.limitOffset > 0 && r.limitMark !== undefined) {
			const cut = r.orderMark ?? r.limitMark;
			const countStep = finish(
				['SELECT count(*) FROM (', ...out.slice(0, cut), ')'],
				this.state
			);
			return { kind: 'read', step, offset: r.limitOffset, countStep };
		}
		return { kind: 'read', step };
	}

	// #endregion

	// #region show and describe

	private tableName(n: number): { name: string; next: number } {
		const t = this.at(n);
		if (t === undefined) throw new Refusal('syntax-error', 'missing table name', 1064, '42000');
		let name = identName(t);
		let next = n + 1;
		if (this.at(next)?.text === '.') {
			name = identName(this.at(next + 1) as Token);
			next += 2;
		}
		return { name, next };
	}

	private show(): Plan {
		let n = 1;
		let full = false;
		if (this.word(n) === 'FULL') {
			full = true;
			n++;
		}
		const w = this.word(n);
		if (w === 'COLUMNS' || w === 'FIELDS') {
			if (!['FROM', 'IN'].includes(this.word(n + 1)))
				throw new Refusal('syntax-error', 'SHOW COLUMNS', 1064, '42000');
			const { name, next } = this.tableName(n + 2);
			if (this.at(next) !== undefined) {
				if (['FROM', 'IN'].includes(this.word(next))) {
					/* a database qualifier changes nothing here */
				} else throw new Refusal('show-other', 'SHOW COLUMNS with LIKE or WHERE');
			}
			this.note('show-columns');
			const schema = schemaOf(this.state, name);
			if (schema === undefined) return tableNotFound(this.state, name);
			return { kind: 'local', result: full ? fullColumnRows(schema) : describeRows(schema) };
		}
		if (w === 'INDEX' || w === 'INDEXES' || w === 'KEYS') {
			const { name } = this.tableName(n + 2);
			this.note('show-index');
			const schema = schemaOf(this.state, name);
			if (schema === undefined) return tableNotFound(this.state, name);
			return { kind: 'local', result: indexRows(schema) };
		}
		if (w === 'TABLES' && !full) {
			let m = n + 1;
			if (['FROM', 'IN'].includes(this.word(m))) m += 2;
			let like: string | undefined;
			if (this.word(m) === 'LIKE') {
				const p = this.at(m + 1);
				if (p === undefined || p.type !== 'string')
					throw new Refusal('syntax-error', 'SHOW TABLES LIKE', 1064, '42000');
				like = decodeStringToken(p.text);
				m += 2;
			}
			if (this.at(m) !== undefined) throw new Refusal('show-other', 'SHOW TABLES WHERE');
			this.note('show-tables');
			const re =
				like === undefined
					? undefined
					: new RegExp(
							`^${like
								.replace(/\\([%_])/g, '\u0000$1')
								.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
								.replace(/%/g, '.*')
								.replace(/_/g, '.')
								.replace(/\u0000(.)/g, (_m, c: string) =>
									c === '%' ? '%' : '_'
								)}$`,
							's'
						);
			const names = [...this.state.db.catalog.values()]
				.map((s) => s.name)
				.filter((name) => re === undefined || re.test(name))
				.sort();
			const head = `Tables_in_${this.state.database}`;
			return {
				kind: 'local',
				result: {
					columns: [like === undefined ? head : `${head} (${like})`],
					rows: names.map((x) => [x])
				}
			};
		}
		if (w === 'CREATE' && this.word(n + 1) === 'TABLE') {
			const { name } = this.tableName(n + 2);
			this.note('show-create-table');
			const schema = schemaOf(this.state, name);
			if (schema === undefined) return tableNotFound(this.state, name);
			return {
				kind: 'local',
				result: {
					columns: ['Table', 'Create Table'],
					rows: [[schema.name, showCreateTable(schema)]]
				}
			};
		}
		throw new Refusal('show-other', this.sql.slice(0, 40));
	}

	private describe(): Plan {
		if (
			this.word(0) === 'EXPLAIN' &&
			['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FORMAT', 'ANALYZE'].includes(this.word(1))
		) {
			throw new Refusal('show-other', 'EXPLAIN of a statement');
		}
		const { name, next } = this.tableName(1);
		if (this.at(next) !== undefined)
			throw new Refusal('show-other', 'DESCRIBE with a column filter');
		this.note('describe');
		const schema = schemaOf(this.state, name);
		if (schema === undefined) return tableNotFound(this.state, name);
		return { kind: 'local', result: describeRows(schema) };
	}

	// #endregion

	// #region ddl

	private create(): Plan {
		if (this.word(1) !== 'TABLE' && !(this.word(1) === 'TEMPORARY')) {
			if (
				[
					'VIEW',
					'TRIGGER',
					'PROCEDURE',
					'FUNCTION',
					'EVENT',
					'OR',
					'ALGORITHM',
					'DEFINER'
				].includes(this.word(1))
			) {
				throw new Refusal('routines-triggers-views', this.word(1));
			}
			if (['INDEX', 'UNIQUE', 'FULLTEXT', 'SPATIAL'].includes(this.word(1))) {
				throw new Refusal('alter-table', 'CREATE INDEX');
			}
			throw new Refusal('statement-unknown', this.sql.slice(0, 30), 1064, '42000');
		}
		const { schema, ifNotExists } = parseCreateTable(this.sql);
		this.note('create-table');
		for (const c of schema.columns) {
			if (c.unsigned) this.note('ddl-unsigned');
			if (c.base === 'decimal') this.note('ddl-decimal');
			if (c.autoIncrement) this.note('auto-increment');
		}
		const byName = new Map(schema.columns.map((c) => [c.name.toLowerCase(), c]));
		for (const index of schema.indexes) {
			for (const p of index.parts as KeyPart[]) {
				if (isShortPrefix(byName.get(p.name.toLowerCase()) as ColumnDef, p))
					this.note('index-prefix');
			}
		}
		this.note('column-collation');
		const create = sqliteCreateStatements(schema, ifNotExists);
		const original = this.sql.trim().replace(/;\s*$/, '');
		const steps: Step[] = [
			...create.map((sql) => ({ sql, params: [] })),
			{
				sql: 'CREATE TABLE IF NOT EXISTS cfw_mysql_schema (name TEXT PRIMARY KEY, ddl TEXT NOT NULL)',
				params: []
			},
			finish(
				[
					ifNotExists ? 'INSERT OR IGNORE' : 'INSERT',
					' INTO cfw_mysql_schema (name, ddl) VALUES (',
					{ value: schema.name.toLowerCase() },
					', ',
					{ value: original },
					')'
				],
				this.state
			)
		];
		return { kind: 'ddl', steps, effect: { catalogSet: schema } };
	}

	private drop(): Plan {
		if (this.word(1) !== 'TABLE')
			throw new Refusal('routines-triggers-views', `DROP ${this.word(1)}`);
		let n = 2;
		let ifExists = false;
		if (this.word(n) === 'IF' && this.word(n + 1) === 'EXISTS') {
			ifExists = true;
			n += 2;
		}
		const names: string[] = [];
		for (;;) {
			const { name, next } = this.tableName(n);
			names.push(name);
			n = next;
			if (this.at(n)?.text === ',') {
				n++;
				continue;
			}
			break;
		}
		if (this.at(n) !== undefined)
			throw new Refusal('syntax-error', 'DROP TABLE', 1064, '42000');
		this.note('drop-table');
		const steps: Step[] = [
			{
				sql: 'CREATE TABLE IF NOT EXISTS cfw_mysql_schema (name TEXT PRIMARY KEY, ddl TEXT NOT NULL)',
				params: []
			}
		];
		for (const name of names) {
			steps.push({
				sql: `DROP TABLE ${ifExists ? 'IF EXISTS ' : ''}${quoteName(name)}`,
				params: []
			});
			steps.push(
				finish(
					['DELETE FROM cfw_mysql_schema WHERE name = ', { value: name.toLowerCase() }],
					this.state
				)
			);
		}
		return { kind: 'ddl', steps, effect: { catalogDrop: names.map((x) => x.toLowerCase()) } };
	}

	// #endregion

	// #region insert

	private insert(): Plan {
		const r = this.r;
		const isReplace = this.word(0) === 'REPLACE';
		let n = 1;
		let ignore = false;
		while (['LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'IGNORE'].includes(this.word(n))) {
			if (this.word(n) === 'IGNORE') ignore = true;
			n++;
		}
		if (this.word(n) === 'INTO') n++;
		const { name, next } = this.tableName(n);
		n = next;
		const schema = schemaOf(this.state, name);
		let columns: string[] | undefined;
		if (this.at(n)?.text === '(' && this.word(n + 1) !== 'SELECT') {
			const close = matchingParen(
				this.sig.map((i) => this.tokens[i] as Token),
				n
			);
			if (close < 0) throw new Refusal('syntax-error', 'INSERT', 1064, '42000');
			columns = [];
			for (let k = n + 1; k < close; k++) {
				const t = this.at(k) as Token;
				if (t.text === ',') continue;
				columns.push(identName(t));
			}
			n = close + 1;
		}
		const verb = isReplace ? 'INSERT OR REPLACE' : ignore ? 'INSERT OR IGNORE' : 'INSERT';
		if (isReplace) this.note('replace-into');
		else if (ignore) this.note('insert-ignore');
		const head = `${verb} INTO ${quoteName(name)}`;

		const kw = this.word(n);
		if (kw === 'SET') throw new Refusal('insert-set', name);
		if (kw === 'SELECT' || this.at(n)?.text === '(') {
			this.note('insert-select');
			if (this.find(n, ['ON']) >= 0 && this.find(n, ['DUPLICATE']) >= 0) {
				throw new Refusal('insert-select-odku', name);
			}
			const out: Part[] = [head];
			if (columns !== undefined) out.push(` (${columns.map(quoteName).join(', ')})`);
			out.push(' ');
			const selectOut: Part[] = [];
			r.emit(selectOut, this.sig[n] as number, this.tokens.length);
			return {
				kind: 'write',
				steps: [finish([...out, ...selectOut], this.state)],
				insertId: 'none',
				rows: 0
			};
		}
		if (kw !== 'VALUES' && kw !== 'VALUE')
			throw new Refusal('syntax-error', 'INSERT', 1064, '42000');
		n++;
		const tuples: [number, number][][] = [];
		const sigTokens = this.sig.map((i) => this.tokens[i] as Token);
		let k = n;
		for (;;) {
			if (this.at(k)?.text !== '(')
				throw new Refusal('syntax-error', 'INSERT VALUES', 1064, '42000');
			const close = matchingParen(sigTokens, k);
			if (close < 0) throw new Refusal('syntax-error', 'INSERT VALUES', 1064, '42000');
			const open = this.sig[k] as number;
			const end = this.sig[close] as number;
			tuples.push(r.ranges(open + 1, end));
			k = close + 1;
			if (this.at(k)?.text === ',') {
				k++;
				continue;
			}
			break;
		}
		let odkuAt = -1;
		if (this.word(k) === 'ON' && this.word(k + 1) === 'DUPLICATE') {
			if (this.word(k + 2) !== 'KEY' || this.word(k + 3) !== 'UPDATE') {
				throw new Refusal('syntax-error', 'ON DUPLICATE', 1064, '42000');
			}
			odkuAt = k + 4;
		} else if (this.at(k) !== undefined) {
			throw new Refusal(
				'syntax-error',
				`near '${(this.at(k) as Token).text}'`,
				1064,
				'42000'
			);
		}

		// columns the statement names, for coercion and the implicit defaults of a relaxed mode
		const named = columns ?? schema?.columns.map((c) => c.name);
		const defs = new Map(schema?.columns.map((c) => [c.name.toLowerCase(), c]) ?? []);
		const extra: Part[] = [];
		const extraNames: string[] = [];
		if (schema !== undefined && columns !== undefined) {
			const have = new Set(columns.map((c) => c.toLowerCase()));
			const pk = new Set(
				schema.indexes
					.filter((x) => x.kind === 'primary')
					.flatMap((x) => x.parts.map((p) => p.name.toLowerCase()))
			);
			for (const c of schema.columns) {
				if (have.has(c.name.toLowerCase()) || c.autoIncrement) continue;
				if (!(c.notNull || pk.has(c.name.toLowerCase())) || c.def.kind !== 'none') continue;
				if (strict(this.state)) {
					return errorPlan(
						1364,
						'HY000',
						`Field '${c.name}' doesn't have a default value`
					);
				}
				this.note('insert-implicit-default');
				extraNames.push(c.name);
				extra.push(implicitDefault(c));
			}
		}
		const out: Part[] = [head];
		const finalColumns = columns === undefined ? undefined : [...columns, ...extraNames];
		if (finalColumns !== undefined) out.push(` (${finalColumns.map(quoteName).join(', ')})`);
		out.push(' VALUES ');
		let row = 0;
		const tupleCells: Part[][][] = [];
		for (const tuple of tuples) {
			row++;
			const cells: Part[][] = [];
			tuple.forEach(([a, b], idx) => {
				const col = named?.[idx];
				const def = col === undefined ? undefined : defs.get(col.toLowerCase());
				const first = r.next(a, b);
				const only =
					first >= 0 && r.next(first + 1, b) < 0
						? (this.tokens[first] as Token)
						: undefined;
				if (def !== undefined && only !== undefined) {
					const c = coerce(this.state, def, only, row);
					if (c !== undefined) {
						if ('error' in c) throw new PlanError(c.error);
						this.note('insert-coercion');
						cells.push([c.part]);
						return;
					}
				}
				cells.push(this.trimParts(r.emitRange(a, b)));
			});
			for (const e of extra) cells.push([e]);
			tupleCells.push(cells);
		}
		tupleCells.forEach((cells, idx) => {
			if (idx > 0) out.push(', ');
			out.push('(', ...joinCells(cells), ')');
		});

		const autoCol = schema?.columns.find((c) => c.autoIncrement);
		let insertId: InsertIdMode = 'none';
		if (autoCol !== undefined) {
			const given = (finalColumns ?? named ?? []).some(
				(c) => c.toLowerCase() === autoCol.name.toLowerCase()
			);
			insertId = given ? 'explicit' : 'generated';
		}

		if (odkuAt < 0) {
			return {
				kind: 'write',
				steps: [finish(out, this.state)],
				insertId,
				rows: tuples.length
			};
		}
		return this.odku(
			name,
			schema,
			finalColumns ?? named,
			out,
			tupleCells,
			odkuAt,
			insertId,
			tuples.length
		);
	}

	private odku(
		name: string,
		schema: TableSchema | undefined,
		columns: string[] | undefined,
		out: Part[],
		tupleCells: Part[][][],
		at: number,
		insertId: InsertIdMode,
		rows: number
	): Plan {
		if (schema === undefined || columns === undefined) {
			throw new Refusal('odku-no-schema', name);
		}
		const r = this.r;
		this.note('insert-odku');
		const have = new Set(columns.map((c) => c.toLowerCase()));
		const candidates = schema.indexes.filter(
			(x) =>
				(x.kind === 'primary' || x.kind === 'unique') &&
				x.parts.every((p) => have.has(p.name.toLowerCase()))
		);
		r.valuesMode = 'excluded';
		const end = this.tokens.length;
		const startIndex = this.sig[at] as number;
		const assigns = r.ranges(startIndex, end);
		const sets: { col: string; expr: Part[] }[] = [];
		for (const [a, b] of assigns) {
			const eq = this.eqIndex(a, b);
			if (eq < 0) throw new Refusal('syntax-error', 'ON DUPLICATE KEY UPDATE', 1064, '42000');
			const colTokens = this.tokens
				.slice(a, eq)
				.filter((t) => t.type !== 'whitespace' && t.type !== 'comment');
			const col = identName(colTokens[colTokens.length - 1] as Token);
			const expr = r.emitRange(eq + 1, b);
			while (typeof expr[0] === 'string' && /^\s*$/.test(expr[0])) expr.shift();
			while (
				typeof expr[expr.length - 1] === 'string' &&
				/^\s*$/.test(expr[expr.length - 1] as string)
			)
				expr.pop();
			sets.push({ col, expr });
		}
		r.valuesMode = undefined;
		if (candidates.length === 0) {
			return { kind: 'write', steps: [finish(out, this.state)], insertId, rows };
		}
		const guard: Part[] = [];
		sets.forEach((s, n) => {
			if (n > 0) guard.push(' OR ');
			guard.push(
				`${quoteName(schema.name)}.${quoteName(s.col)} IS NOT (`,
				...s.expr,
				') COLLATE BINARY'
			);
		});
		for (const target of candidates) {
			out.push(
				` ON CONFLICT (${target.parts.map((p) => quoteName(p.name)).join(', ')}) DO UPDATE SET `
			);
			sets.forEach((s, n) => {
				if (n > 0) out.push(', ');
				out.push(`${quoteName(s.col)} = `, ...s.expr);
			});
			out.push(' WHERE ', ...guard);
		}
		const main = finish(out, this.state);
		const target = candidates[0] as (typeof candidates)[number];
		let probe: Step | undefined;
		if (candidates.length === 1) {
			const pk = schema.columns.find((c) => c.autoIncrement);
			const idx = target.parts.map((p) =>
				columns.findIndex((c) => c.toLowerCase() === p.name.toLowerCase())
			);
			const probeParts: Part[] = [
				`SELECT ${pk === undefined ? '1' : quoteName(pk.name)} FROM ${quoteName(schema.name)} WHERE (${target.parts.map((p) => quoteName(p.name)).join(', ')}) IN (SELECT ${target.parts.map((_, i) => `column${i + 1}`).join(', ')} FROM (VALUES `
			];
			tupleCells.forEach((cells, ti) => {
				if (ti > 0) probeParts.push(', ');
				probeParts.push('(', ...joinCells(idx.map((c) => cells[c] as Part[])), ')');
			});
			probeParts.push('))');
			probe = finish(probeParts, this.state);
		}
		if (probe === undefined) {
			return { kind: 'write', steps: [main], insertId, rows };
		}
		return { kind: 'write', steps: [main], insertId, rows, odku: { probe } };
	}

	/** the index of the top-level = between a and b, or -1 */
	private eqIndex(a: number, b: number): number {
		let depth = 0;
		for (let i = a; i < b; i++) {
			const t = this.tokens[i] as Token;
			if (t.type === 'punct' && t.text === '(') depth++;
			else if (t.type === 'punct' && t.text === ')') depth--;
			else if (depth === 0 && t.type === 'operator' && t.text === '=') return i;
		}
		return -1;
	}

	// #endregion

	// #region update and delete

	/** the token index range of the clause that starts with one of words, up to the next clause */
	private clauses(from: number): Record<string, [number, number]> {
		const found: [string, number][] = [];
		let depth = 0;
		for (let i = from; i < this.tokens.length; i++) {
			const t = this.tokens[i] as Token;
			if (t.type === 'punct' && t.text === '(') depth++;
			else if (t.type === 'punct' && t.text === ')') depth--;
			else if (depth === 0 && t.type === 'identifier') {
				const up = t.text.toUpperCase();
				if (up === 'WHERE' || up === 'LIMIT') found.push([up, i]);
				if (up === 'ORDER' && upper(this.tokens[this.r.next(i + 1)]) === 'BY')
					found.push(['ORDER', i]);
			}
		}
		const out: Record<string, [number, number]> = {};
		found.forEach(([k, i], n) => {
			out[k] = [i, found[n + 1]?.[1] ?? this.tokens.length];
		});
		return out;
	}

	private trimParts(parts: Part[]): Part[] {
		const p = [...parts];
		while (typeof p[0] === 'string' && /^\s*$/.test(p[0])) p.shift();
		while (typeof p[p.length - 1] === 'string' && /^\s*$/.test(p[p.length - 1] as string))
			p.pop();
		return p;
	}

	private update(): Plan {
		const r = this.r;
		let n = 1;
		let ignore = false;
		while (['LOW_PRIORITY', 'IGNORE'].includes(this.word(n))) {
			if (this.word(n) === 'IGNORE') ignore = true;
			n++;
		}
		const { name, next } = this.tableName(n);
		n = next;
		if (this.word(n) !== 'SET') {
			throw new Refusal('update-multi-table', name);
		}
		const setIndex = this.sig[n] as number;
		const clauses = this.clauses(setIndex);
		const setEnd = Math.min(...Object.values(clauses).map((c) => c[0]), this.tokens.length);
		const schema = schemaOf(this.state, name);
		const defs = new Map(schema?.columns.map((c) => [c.name.toLowerCase(), c]) ?? []);
		const assigns = r.ranges(setIndex + 1, setEnd);
		const sets: { col: string; expr: Part[] }[] = [];
		const assigned: string[] = [];
		let row = 1;
		for (const [a, b] of assigns) {
			const eq = this.eqIndex(a, b);
			if (eq < 0) throw new Refusal('syntax-error', 'UPDATE SET', 1064, '42000');
			const colTokens = this.tokens
				.slice(a, eq)
				.filter((t) => t.type !== 'whitespace' && t.type !== 'comment');
			const col = identName(colTokens[colTokens.length - 1] as Token);
			for (let i = eq + 1; i < b; i++) {
				const t = this.tokens[i] as Token;
				const followedByParen = this.text2(this.r.next(i + 1, b)) === '(';
				if (
					(t.type === 'identifier' || t.type === 'quoted_identifier') &&
					!followedByParen &&
					assigned.includes(identName(t).toLowerCase())
				) {
					throw new Refusal('update-sequential-assign', identName(t));
				}
			}
			assigned.push(col.toLowerCase());
			const def = defs.get(col.toLowerCase());
			const first = r.next(eq + 1, b);
			const only =
				first >= 0 && r.next(first + 1, b) < 0 ? (this.tokens[first] as Token) : undefined;
			let expr: Part[] | undefined;
			if (def !== undefined && only !== undefined) {
				const c = coerce(this.state, def, only, row);
				if (c !== undefined) {
					if ('error' in c) throw new PlanError(c.error);
					this.note('insert-coercion');
					expr = [c.part];
				}
			}
			expr ??= this.trimParts(r.emitRange(eq + 1, b));
			sets.push({ col, expr });
		}
		row++;
		this.note('update');
		const out: Part[] = [ignore ? 'UPDATE OR IGNORE ' : 'UPDATE ', quoteName(name), ' SET '];
		sets.forEach((s, i) => {
			if (i > 0) out.push(', ');
			out.push(`${quoteName(s.col)} = `, ...s.expr);
		});
		const where =
			clauses.WHERE === undefined
				? []
				: this.trimParts(r.emitRange(clauses.WHERE[0] + 1, clauses.WHERE[1]));
		const hasLimit = clauses.LIMIT !== undefined;
		const limitParts = hasLimit
			? this.trimParts(r.emitRange(clauses.LIMIT![0] + 1, clauses.LIMIT![1]))
			: [];
		if (hasLimit) {
			if (limitParts.join('').includes(','))
				throw new Refusal('update-order-limit', 'UPDATE ... LIMIT offset, count');
			this.note('update-order-limit');
		}
		const order =
			clauses.ORDER === undefined
				? []
				: this.trimParts(r.emitRange(r.next(clauses.ORDER[0] + 1) + 1, clauses.ORDER[1]));
		out.push(' WHERE ');
		if (hasLimit) {
			out.push(`rowid IN (SELECT rowid FROM ${quoteName(name)}`);
			if (where.length > 0) out.push(' WHERE ', ...where);
			if (order.length > 0) out.push(' ORDER BY ', ...order);
			out.push(' LIMIT ', ...limitParts, ') AND ');
		} else if (where.length > 0) {
			out.push('(', ...where, ') AND ');
		}
		out.push('(');
		sets.forEach((s, i) => {
			if (i > 0) out.push(' OR ');
			out.push(`${quoteName(s.col)} IS NOT (`, ...s.expr, ') COLLATE BINARY');
		});
		out.push(')');
		return { kind: 'write', steps: [finish(out, this.state)], insertId: 'none', rows: 0 };
	}

	private text2(i: number): string {
		return this.r.text(i);
	}

	private delete(): Plan {
		const r = this.r;
		let n = 1;
		while (['LOW_PRIORITY', 'QUICK', 'IGNORE'].includes(this.word(n))) n++;
		if (this.word(n) !== 'FROM') return this.deleteMulti(n);
		n++;
		const { name, next } = this.tableName(n);
		n = next;
		if (this.word(n) === 'USING') return this.deleteUsing(n);
		if (this.at(n) !== undefined && !['WHERE', 'ORDER', 'LIMIT'].includes(this.word(n))) {
			throw new Refusal('syntax-error', `near '${this.at(n)?.text}'`, 1064, '42000');
		}
		const from = (this.sig[n - 1] as number) + 1;
		const clauses = this.clauses(from);
		this.note('delete');
		const out: Part[] = [`DELETE FROM ${quoteName(name)}`];
		const where =
			clauses.WHERE === undefined
				? []
				: this.trimParts(
						r.emitRange(
							clauses.WHERE[0] + 1,
							Math.min(clauses.WHERE[1], this.tokens.length)
						)
					);
		if (clauses.LIMIT === undefined) {
			if (where.length > 0) out.push(' WHERE ', ...where);
			return { kind: 'write', steps: [finish(out, this.state)], insertId: 'none', rows: 0 };
		}
		const limitParts = this.trimParts(r.emitRange(clauses.LIMIT[0] + 1, clauses.LIMIT[1]));
		if (limitParts.join('').includes(','))
			throw new Refusal('delete-limit', 'DELETE ... LIMIT offset, count');
		this.note('delete-limit');
		const order =
			clauses.ORDER === undefined
				? []
				: this.trimParts(r.emitRange(r.next(clauses.ORDER[0] + 1) + 1, clauses.ORDER[1]));
		out.push(` WHERE rowid IN (SELECT rowid FROM ${quoteName(name)}`);
		if (where.length > 0) out.push(' WHERE ', ...where);
		if (order.length > 0) out.push(' ORDER BY ', ...order);
		out.push(' LIMIT ', ...limitParts, ')');
		return { kind: 'write', steps: [finish(out, this.state)], insertId: 'none', rows: 0 };
	}

	private deleteUsing(_n: number): Plan {
		throw new Refusal('delete-multi-table-distinct', 'DELETE FROM ... USING');
	}

	/** DELETE a, b FROM t a, t b WHERE ...: every alias must be the same table */
	private deleteMulti(n: number): Plan {
		const r = this.r;
		const targets: string[] = [];
		for (;;) {
			const t = this.at(n);
			if (t === undefined) throw new Refusal('syntax-error', 'DELETE', 1064, '42000');
			targets.push(identName(t).toLowerCase());
			n++;
			if (this.at(n)?.text === ',') {
				n++;
				continue;
			}
			break;
		}
		if (this.word(n) !== 'FROM') throw new Refusal('syntax-error', 'DELETE', 1064, '42000');
		n++;
		const refs: { table: string; alias: string }[] = [];
		for (;;) {
			const { name, next } = this.tableName(n);
			n = next;
			let alias = name;
			if (this.word(n) === 'AS') n++;
			const maybe = this.at(n);
			if (
				maybe !== undefined &&
				maybe.type !== 'punct' &&
				!['WHERE', 'ORDER', 'LIMIT'].includes(this.word(n))
			) {
				alias = identName(maybe);
				n++;
			}
			refs.push({ table: name, alias });
			if (this.at(n)?.text === ',') {
				n++;
				continue;
			}
			break;
		}
		const tables = new Set<string>();
		for (const t of targets) {
			const ref = refs.find((x) => x.alias.toLowerCase() === t);
			if (ref === undefined)
				throw new Refusal('delete-multi-table-distinct', `unknown alias ${t}`);
			tables.add(ref.table.toLowerCase());
		}
		if (tables.size !== 1)
			throw new Refusal('delete-multi-table-distinct', [...tables].join(', '));
		const clauses = this.clauses(this.sig[n - 1] as number);
		if (clauses.ORDER !== undefined || clauses.LIMIT !== undefined) {
			throw new Refusal('delete-multi-table-distinct', 'ORDER BY or LIMIT');
		}
		this.note('delete-multi-table');
		const real = refs.find((x) => x.alias.toLowerCase() === targets[0])?.table as string;
		const where =
			clauses.WHERE === undefined
				? []
				: this.trimParts(r.emitRange(clauses.WHERE[0] + 1, this.tokens.length));
		const fromList = refs
			.map((x) => `${quoteName(x.table)} AS ${quoteName(x.alias)}`)
			.join(', ');
		const out: Part[] = [`DELETE FROM ${quoteName(real)} WHERE rowid IN (`];
		[...new Set(targets)].forEach((t, i) => {
			const ref = refs.find((x) => x.alias.toLowerCase() === t) as { alias: string };
			if (i > 0) out.push(' UNION ');
			out.push(`SELECT ${quoteName(ref.alias)}.rowid FROM ${fromList}`);
			if (where.length > 0) out.push(' WHERE ', ...where);
		});
		out.push(')');
		return { kind: 'write', steps: [finish(out, this.state)], insertId: 'none', rows: 0 };
	}

	// #endregion
}

/** carries a MySQL error found while building a statement out of the builder */
class PlanError extends Error {
	constructor(readonly plan: Plan) {
		super('plan error');
	}
}

function joinCells(cells: Part[][]): Part[] {
	const out: Part[] = [];
	cells.forEach((c, i) => {
		if (i > 0) out.push(', ');
		out.push(...c);
	});
	return out;
}

/** puts a mode list in MySQL's canonical order and refuses modes this translator does not honour */
export function canonicalMode(value: string): string {
	const modes = value
		.split(',')
		.map((m) => m.trim().toUpperCase())
		.filter((m) => m !== '');
	for (const m of modes) {
		if (!SQL_MODES.includes(m)) {
			throw new Refusal('set-sql-mode-unknown', `'${m}'`, 1231, '42000');
		}
		if (UNSUPPORTED_MODES.has(m)) throw new Refusal('sql-mode-unsupported', m);
	}
	return SQL_MODES.filter((m) => modes.includes(m)).join(',');
}

/** one closing semicolon is part of a statement; a second, or a lone one, is left to refuse */
function dropTerminator(tokens: Token[]): void {
	const sig = tokens.filter((t) => t.type !== 'whitespace' && t.type !== 'comment');
	const last = sig[sig.length - 1];
	if (sig.length < 2 || last === undefined || last.type !== 'punct' || last.text !== ';') return;
	tokens.splice(tokens.lastIndexOf(last), 1);
}

/**
 * Translates one MySQL statement into the SQLite statements that answer it.
 *
 * Pure with respect to its inputs: it reads `state` (session mode, catalog) and never runs SQL.
 * A statement it cannot translate correctly comes back as an `error` plan naming the class row
 * that refused it, never as a silent no-op.
 */
export function translate(mysqlSql: string, state: MysqlState): Translation {
	const tokens = tokenize(mysqlSql);
	dropTerminator(tokens);
	const worker = new StatementTranslator(mysqlSql, tokens, state);
	if (worker.sig.length === 0) {
		return {
			classes: ['statement-unknown'],
			plan: errorPlan(1065, '42000', 'Query was empty')
		};
	}
	try {
		return worker.translate();
	} catch (e) {
		if (e instanceof Refusal) {
			return { classes: [e.id, ...worker.r.classes], plan: refusalPlan(e) };
		}
		if (e instanceof PlanError) return { classes: worker.r.classes, plan: e.plan };
		throw e;
	}
}
