/** the lexical class of a token; a keyword is an `identifier` whose text the translator compares */
export type TokenType =
	| 'whitespace'
	| 'comment'
	| 'executable_comment'
	| 'identifier'
	| 'quoted_identifier'
	| 'string'
	| 'national_string'
	| 'hex'
	| 'bit'
	| 'number'
	| 'variable'
	| 'operator'
	| 'punct'
	| 'error';

/** one token of a MySQL statement; offset and length count UTF-16 code units of the input */
export interface Token {
	type: TokenType;
	offset: number;
	length: number;
	text: string;
}

const TAB = 9;
const LF = 10;
const VT = 11;
const FF = 12;
const CR = 13;
const SPACE = 32;
const BANG = 33;
const DQUOTE = 34;
const HASH = 35;
const DOLLAR = 36;
const PERCENT = 37;
const AMP = 38;
const SQUOTE = 39;
const LPAREN = 40;
const RPAREN = 41;
const STAR = 42;
const PLUS = 43;
const COMMA = 44;
const MINUS = 45;
const DOT = 46;
const SLASH = 47;
const COLON = 58;
const SEMI = 59;
const LT = 60;
const EQ = 61;
const GT = 62;
const QMARK = 63;
const AT = 64;
const BACKSLASH = 92;
const CARET = 94;
const UNDERSCORE = 95;
const BACKTICK = 96;
const LBRACE = 123;
const PIPE = 124;
const RBRACE = 125;
const TILDE = 126;
const DEL = 127;

/** 1 for every ASCII byte that continues an identifier: letters, digits, underscore, dollar */
const IDENT = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
	const lower = c | 0x20;
	IDENT[c] =
		(c >= 48 && c <= 57) || (lower >= 97 && lower <= 122) || c === UNDERSCORE || c === DOLLAR
			? 1
			: 0;
}

const isWhitespace = (c: number) => c === SPACE || (c >= TAB && c <= CR);
const isIdent = (c: number) => c >= 0x80 || IDENT[c] === 1;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isHexDigit = (c: number) => isDigit(c) || ((c | 0x20) >= 97 && (c | 0x20) <= 102);
const isBitDigit = (c: number) => c === 48 || c === 49;

/** the end of the run of bytes `accepts` takes, starting at `from` */
function span(sql: string, from: number, accepts: (c: number) => boolean): number {
	let i = from;
	while (i < sql.length && accepts(sql.charCodeAt(i))) i++;
	return i;
}

/** the end of a quoted run opened at `start`, or -1 when it never closes */
function scanQuoted(sql: string, start: number, quote: number, backslash: boolean): number {
	const length = sql.length;
	let i = start + 1;
	while (i < length) {
		const c = sql.charCodeAt(i);
		if (backslash && c === BACKSLASH) {
			i += 2;
			if (i > length) return -1;
			continue;
		}
		if (c !== quote) {
			i++;
			continue;
		}
		// a doubled quote is the quote character, not the end
		if (i + 1 < length && sql.charCodeAt(i + 1) === quote) {
			i += 2;
			continue;
		}
		return i + 1;
	}
	return -1;
}

/** the end of an exponent such as e5, E+5 or e-5 at `end`, or `end` when there is none */
function scanExponent(sql: string, end: number): number {
	const length = sql.length;
	if (end >= length || (sql.charCodeAt(end) | 0x20) !== 101) return end;
	let digits = end + 1;
	if (digits < length) {
		const sign = sql.charCodeAt(digits);
		if (sign === PLUS || sign === MINUS) digits++;
	}
	const run = span(sql, digits, isDigit) - digits;
	return run > 0 ? digits + run : end;
}

/** 3, 2 or 1: the width of the operator that starts at `i` */
function operatorLength(sql: string, i: number): number {
	const length = sql.length;
	const c0 = sql.charCodeAt(i);
	const c1 = i + 1 < length ? sql.charCodeAt(i + 1) : -1;
	const c2 = i + 2 < length ? sql.charCodeAt(i + 2) : -1;
	if (c0 === LT && c1 === EQ && c2 === GT) return 3;
	if (c0 === MINUS && c1 === GT && c2 === GT) return 3;
	switch (c0) {
		case LT:
			return c1 === GT || c1 === EQ || c1 === LT ? 2 : 1;
		case GT:
			return c1 === EQ || c1 === GT ? 2 : 1;
		case BANG:
		case COLON:
			return c1 === EQ ? 2 : 1;
		case PIPE:
			return c1 === PIPE ? 2 : 1;
		case AMP:
			return c1 === AMP ? 2 : 1;
		case MINUS:
			return c1 === GT ? 2 : 1;
		default:
			return 1;
	}
}

/**
 * Splits SQL into tokens, every byte of the input in exactly one token.
 *
 * Malformed input never throws: it becomes an `error` token and lexing carries on, so a statement
 * the translator does not understand is refused by name later instead of vanishing here. Code
 * units from 0x80 up are identifier characters, which is how MySQL treats multibyte names.
 * Placeholders are not special; wpdb finishes the SQL before it reaches this function.
 */
export function tokenize(sql: string): Token[] {
	const length = sql.length;
	const tokens: Token[] = [];
	let previous: TokenType = 'whitespace';
	let i = 0;
	while (i < length) {
		const c = sql.charCodeAt(i);
		let type: TokenType = 'error';
		let end = i + 1;
		switch (c) {
			case SPACE:
			case LF:
			case TAB:
			case CR:
			case FF:
			case VT:
				type = 'whitespace';
				end = span(sql, i, isWhitespace);
				break;

			case SQUOTE:
			case DQUOTE: {
				const close = scanQuoted(sql, i, c, true);
				type = close < 0 ? 'error' : 'string';
				end = close < 0 ? length : close;
				break;
			}

			case BACKTICK: {
				const close = scanQuoted(sql, i, BACKTICK, false);
				type = close < 0 ? 'error' : 'quoted_identifier';
				end = close < 0 ? length : close;
				break;
			}

			case 48:
			case 49:
			case 50:
			case 51:
			case 52:
			case 53:
			case 54:
			case 55:
			case 56:
			case 57: {
				type = 'number';
				end = i;
				if (c === 48 && i + 1 < length) {
					const marker = sql.charCodeAt(i + 1) | 0x20;
					if (marker === 120) {
						const run = span(sql, i + 2, isHexDigit) - (i + 2);
						type = 'hex';
						end = run > 0 ? i + 2 + run : i;
					} else if (marker === 98) {
						const run = span(sql, i + 2, isBitDigit) - (i + 2);
						type = 'bit';
						end = run > 0 ? i + 2 + run : i;
					}
				}
				let hasPoint = false;
				if (end === i) {
					type = 'number';
					end = span(sql, i, isDigit);
					if (end < length && sql.charCodeAt(end) === DOT) {
						hasPoint = true;
						end++;
						end = span(sql, end, isDigit);
					}
					end = scanExponent(sql, end);
				}
				// digits that run into letters are an identifier, as in MySQL
				if (!hasPoint && end < length && isIdent(sql.charCodeAt(end))) {
					type = 'identifier';
					end = span(sql, end, isIdent);
				}
				break;
			}

			case DOT:
				if (
					i + 1 < length &&
					isDigit(sql.charCodeAt(i + 1)) &&
					previous !== 'identifier' &&
					previous !== 'quoted_identifier'
				) {
					type = 'number';
					end = scanExponent(sql, span(sql, i + 1, isDigit));
				} else {
					type = 'punct';
				}
				break;

			case LPAREN:
			case RPAREN:
			case COMMA:
			case SEMI:
			case LBRACE:
			case RBRACE:
				type = 'punct';
				break;

			case HASH:
				type = 'comment';
				end = lineEnd(sql, i);
				break;

			case SLASH:
				if (i + 1 < length && sql.charCodeAt(i + 1) === STAR) {
					const close = sql.indexOf('*/', i + 2);
					if (close < 0) {
						end = length;
					} else {
						end = close + 2;
						const executable =
							(i + 2 < length && sql.charCodeAt(i + 2) === BANG) ||
							sql.startsWith('M!', i + 2);
						type = executable ? 'executable_comment' : 'comment';
					}
				} else {
					type = 'operator';
				}
				break;

			case MINUS: {
				const after = i + 2 < length ? sql.charCodeAt(i + 2) : 0;
				if (
					i + 1 < length &&
					sql.charCodeAt(i + 1) === MINUS &&
					(after <= SPACE || after === DEL)
				) {
					// a dash comment needs whitespace or a control byte after the two dashes
					type = 'comment';
					end = lineEnd(sql, i);
				} else {
					type = 'operator';
					end = i + operatorLength(sql, i);
				}
				break;
			}

			case PLUS:
			case STAR:
			case PERCENT:
			case EQ:
			case LT:
			case GT:
			case BANG:
			case AMP:
			case PIPE:
			case CARET:
			case TILDE:
			case COLON:
			case QMARK:
				type = 'operator';
				end = i + operatorLength(sql, i);
				break;

			case AT: {
				let name = i + 1;
				if (name < length && sql.charCodeAt(name) === AT) name++;
				const quote = name < length ? sql.charCodeAt(name) : -1;
				if (quote === SQUOTE || quote === DQUOTE || quote === BACKTICK) {
					const close = scanQuoted(sql, name, quote, quote !== BACKTICK);
					type = close < 0 ? 'error' : 'variable';
					end = close < 0 ? length : close;
				} else {
					let run = name;
					while (run < length) {
						const v = sql.charCodeAt(run);
						if (!isIdent(v) && v !== DOT) break;
						run++;
					}
					type = run > name ? 'variable' : 'error';
					end = run;
				}
				break;
			}

			default: {
				const lower = c | 0x20;
				if (c < 0x80 && c !== UNDERSCORE && c !== DOLLAR && (lower < 97 || lower > 122)) {
					// a stray byte MySQL has no token for
					break;
				}
				type = 'identifier';
				end = span(sql, i, isIdent);
				if (i + 1 < length && sql.charCodeAt(i + 1) === SQUOTE) {
					const prefixed: TokenType | undefined =
						lower === 120
							? 'hex'
							: lower === 98
								? 'bit'
								: lower === 110
									? 'national_string'
									: undefined;
					if (prefixed !== undefined && c < 0x80) {
						[type, end] = scanPrefixed(sql, i, prefixed);
					}
				}
				break;
			}
		}
		tokens.push({ type, offset: i, length: end - i, text: sql.slice(i, end) });
		if (type !== 'whitespace' && type !== 'comment' && type !== 'executable_comment') {
			previous = type;
		}
		i = end;
	}
	return tokens;
}

/** the end of the line that holds `from`, which is the end of a line comment */
function lineEnd(sql: string, from: number): number {
	const nl = sql.indexOf('\n', from);
	return nl < 0 ? sql.length : nl;
}

/** lexes X'..', b'..' and N'..' from the prefix letter at `start` */
function scanPrefixed(sql: string, start: number, type: TokenType): [TokenType, number] {
	if (type === 'national_string') {
		const close = scanQuoted(sql, start + 1, SQUOTE, true);
		return close < 0 ? ['error', sql.length] : [type, close];
	}
	const close = sql.indexOf("'", start + 2);
	if (close < 0) return ['error', sql.length];
	const accepts = type === 'hex' ? isHexDigit : isBitDigit;
	const valid = span(sql, start + 2, accepts) >= close;
	return [valid ? type : 'error', close + 1];
}

const EDGE_WHITESPACE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

/**
 * Splits a script into statements at top-level semicolons.
 *
 * A semicolon inside a string, a quoted name or a comment is not a boundary. Comments are dropped
 * and leave one space behind so the words on either side do not fuse; executable comments stay,
 * because MySQL runs their contents. Statements come back trimmed, without their semicolons.
 */
export function splitStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = '';
	for (const token of tokenize(sql)) {
		if (token.type === 'comment') {
			current += ' ';
		} else if (token.type === 'punct' && token.text === ';') {
			const trimmed = current.replace(EDGE_WHITESPACE, '');
			if (trimmed !== '') statements.push(trimmed);
			current = '';
		} else {
			current += token.text;
		}
	}
	const trimmed = current.replace(EDGE_WHITESPACE, '');
	if (trimmed !== '') statements.push(trimmed);
	return statements;
}

/**
 * The index of the parenthesis that closes the one at token index `open`.
 *
 * Parentheses inside strings, quoted names and comments are single tokens of another class, so
 * they never count. Answers -1 when `open` is not an opening parenthesis or is never closed.
 */
export function matchingParen(tokens: readonly Token[], open: number): number {
	const start = tokens[open];
	if (start === undefined || start.text !== '(' || start.type !== 'punct') return -1;
	let depth = 0;
	for (let i = open; i < tokens.length; i++) {
		const token = tokens[i] as Token;
		if (token.type !== 'punct') continue;
		if (token.text === '(') depth++;
		else if (token.text === ')' && --depth === 0) return i;
	}
	return -1;
}

/**
 * The UTF-8 byte count of `text` up to code unit `end`.
 *
 * Offsets in a token count UTF-16 code units; this turns one into the byte offset MySQL would
 * report, and `utf8Length(token.text)` is the token's byte length. A lone surrogate counts as
 * three bytes, the width of the replacement character `TextEncoder` writes for it.
 */
export function utf8Length(text: string, end: number = text.length): number {
	let bytes = 0;
	for (let i = 0; i < end; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) bytes += 1;
		else if (c < 0x800) bytes += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < end) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i++;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}
