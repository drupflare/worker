/** the most rows one console call returns */
export const CONSOLE_MAX_ROWS = 1000;

/** the longest statement, in characters */
export const CONSOLE_MAX_SQL = 10_000;

/** the most bound parameters */
export const CONSOLE_MAX_PARAMS = 100;

/** the longest time the caller may ask for, in milliseconds */
export const CONSOLE_MAX_TIMEOUT_MS = 30_000;

/** a value the console returns */
export type ConsoleCell = string | number | boolean | null;

/** a call read and checked, or the refusal to answer with */
export type ConsoleRead =
	| {
			ok: true;
			sql: string;
			params: (string | number | boolean | null)[];
			limit: number;
			timeoutMs: number;
	  }
	| { ok: false; status: number; code: ConsoleRefusal; message: string };

/** the refusal codes the console contract names */
export type ConsoleRefusal =
	'not_read_only' | 'timeout' | 'too_large' | 'unavailable' | 'statement_failed';

const refuse = (status: number, code: ConsoleRefusal, message: string): ConsoleRead => ({
	ok: false,
	status,
	code,
	message
});

/** removes comments and string literals, so a keyword inside either cannot decide a check */
export function blankLiterals(sql: string): string {
	let out = '';
	for (let i = 0; i < sql.length; i++) {
		const c = sql[i] as string;
		const next = sql[i + 1];
		if (c === '-' && next === '-') {
			while (i < sql.length && sql[i] !== '\n') i++;
			out += ' ';
		} else if (c === '/' && next === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end === -1 ? sql.length : end + 1;
			out += ' ';
		} else if (c === "'" || c === '"' || c === '`' || c === '[') {
			const close = c === '[' ? ']' : c;
			i++;
			while (i < sql.length) {
				if (sql[i] === close) {
					if (close !== ']' && sql[i + 1] === close) {
						i += 2;
						continue;
					}
					break;
				}
				i++;
			}
			out += c === "'" ? "''" : '""';
		} else {
			out += c;
		}
	}
	return out;
}

const WRITE_WORDS =
	/\b(insert|update|delete|replace|create|drop|alter|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b/i;

/**
 * Why a statement is not a plain read, or undefined when it is.
 *
 * One statement that starts with SELECT or WITH and names no write or schema keyword outside a
 * comment or a literal. The check is deliberately blunt: a column named `update` has to be quoted.
 * The route also rolls back anything that wrote, so this is the first of two guards.
 */
export function readOnlyRefusal(sql: string): string | undefined {
	const bare = blankLiterals(sql)
		.trim()
		.replace(/;+\s*$/, '');
	if (bare === '') return 'the statement is empty';
	if (bare.includes(';')) return 'send one statement';
	if (!/^(select|with|values)\b/i.test(bare)) return 'only SELECT and WITH statements are read';
	const word = WRITE_WORDS.exec(bare);
	if (word !== null) return `${word[1]?.toUpperCase()} is not a read`;
	return undefined;
}

/** a value as the console contract carries it; a blob is hex, and a wide integer stays exact */
export function cellOf(value: unknown): ConsoleCell {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
	if (typeof value === 'bigint') {
		return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(value)
			: value.toString();
	}
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		const bytes =
			value instanceof ArrayBuffer
				? new Uint8Array(value)
				: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		return `x'${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}'`;
	}
	return String(value);
}

/** reads a console request body and refuses what exceeds the contract's bounds */
export function readConsole(body: unknown): ConsoleRead {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return refuse(400, 'unavailable', 'the body must be a JSON object');
	}
	const raw = body as Record<string, unknown>;
	if (raw['v'] !== 1) return refuse(400, 'unavailable', 'v must be 1');
	const sql = raw['sql'];
	if (typeof sql !== 'string' || sql.trim() === '') {
		return refuse(400, 'unavailable', 'sql must be a non-empty string');
	}
	if (sql.length > CONSOLE_MAX_SQL) {
		return refuse(413, 'too_large', `sql is over ${CONSOLE_MAX_SQL} characters`);
	}
	const params = raw['params'] ?? [];
	if (!Array.isArray(params)) return refuse(400, 'unavailable', 'params must be an array');
	if (params.length > CONSOLE_MAX_PARAMS) {
		return refuse(413, 'too_large', `params is over ${CONSOLE_MAX_PARAMS} values`);
	}
	if (params.some((p) => p !== null && !['string', 'number', 'boolean'].includes(typeof p))) {
		return refuse(400, 'unavailable', 'a param must be a string, number, boolean or null');
	}
	const limit = raw['limit'] ?? CONSOLE_MAX_ROWS;
	if (!Number.isInteger(limit) || (limit as number) < 1) {
		return refuse(400, 'unavailable', 'limit must be a positive whole number');
	}
	if ((limit as number) > CONSOLE_MAX_ROWS) {
		return refuse(413, 'too_large', `limit is over ${CONSOLE_MAX_ROWS}`);
	}
	const timeoutMs = raw['timeoutMs'] ?? CONSOLE_MAX_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1) {
		return refuse(400, 'unavailable', 'timeoutMs must be a positive whole number');
	}
	if ((timeoutMs as number) > CONSOLE_MAX_TIMEOUT_MS) {
		return refuse(413, 'too_large', `timeoutMs is over ${CONSOLE_MAX_TIMEOUT_MS}`);
	}
	const refusal = readOnlyRefusal(sql);
	if (refusal !== undefined) return refuse(422, 'not_read_only', refusal);
	return {
		ok: true,
		sql,
		params: params as ConsoleCell[],
		limit: limit as number,
		timeoutMs: timeoutMs as number
	};
}
