/**
 * Adds the return types a current core requires to module methods that override a typed one.
 *
 * Module code written before core typed a method fails to load with "Declaration must be
 * compatible". This is the install-time form of anachron's `ReturnTypeRewriter`: it finds the
 * methods a table of core signatures covers and inserts the type after the parameter list, keeping
 * every line where it was. It leaves a method alone when it cannot show the type is right and names
 * the method with the reason. The PHP class is the reference; `tests/node/return-types.spec.ts`
 * holds this port to its output byte for byte.
 *
 * @module
 */
import { CORE_PARENTS, CORE_RETURN_TYPES } from './generated/core-return-types';
import { type PhpToken, tokenize } from './php-tokens';

/** a class's parent and interfaces, with names resolved and no leading backslash */
export type ClassInfo = { extends: string | null; implements: string[] };

/** one method left alone, with why */
export type Refusal = { class: string; method: string; line: number; reason: string };

/** the return types of core classes and the parents the table does not redeclare */
export type ReturnTypeTable = {
	typed: Readonly<Record<string, Readonly<Record<string, string>>>>;
	parents: Readonly<Record<string, string>>;
};

/** the table the install tier uses */
export const CORE_TABLE: ReturnTypeTable = { typed: CORE_RETURN_TYPES, parents: CORE_PARENTS };

const INTERFACES: Record<string, Record<string, string>> = {
	ArrayAccess: {
		offsetexists: 'bool',
		offsetget: 'mixed',
		offsetset: 'void',
		offsetunset: 'void'
	},
	Iterator: { current: 'mixed', key: 'mixed', next: 'void', rewind: 'void', valid: 'bool' },
	IteratorAggregate: { getiterator: '\\Traversable' },
	Countable: { count: 'int' },
	JsonSerializable: { jsonserialize: 'mixed' }
};

const ARITY: Record<string, number> = {
	offsetexists: 1,
	offsetget: 1,
	offsetset: 2,
	offsetunset: 1,
	getiterator: 0,
	count: 0,
	jsonserialize: 0,
	current: 0,
	key: 0,
	next: 0,
	rewind: 0,
	valid: 0,
	normalize: 3
};

/** core functions whose result is always an array, which a return can rely on */
const ARRAY_FUNCTIONS = new Set([
	'array_change_key_case',
	'array_chunk',
	'array_column',
	'array_combine',
	'array_count_values',
	'array_diff',
	'array_diff_assoc',
	'array_diff_key',
	'array_fill',
	'array_fill_keys',
	'array_filter',
	'array_flip',
	'array_intersect',
	'array_intersect_assoc',
	'array_intersect_key',
	'array_keys',
	'array_map',
	'array_merge',
	'array_merge_recursive',
	'array_pad',
	'array_replace',
	'array_replace_recursive',
	'array_reverse',
	'array_slice',
	'array_splice',
	'array_unique',
	'array_values'
]);

/** the parent types a wider declared type can be narrowed to */
const NARROWABLE = new Set(['array', 'bool', 'int', 'string']);

/** the type a cast token casts to, for the casts the narrowing check reads */
const CAST_TYPES: Record<string, string> = {
	array: 'array',
	bool: 'bool',
	boolean: 'bool',
	int: 'int',
	integer: 'int',
	string: 'string',
	binary: 'string'
};

const NAMES = ['T_STRING', 'T_NAME_QUALIFIED', 'T_NAME_FULLY_QUALIFIED', 'T_NAME_RELATIVE'];
const BLANK = ['T_WHITESPACE', 'T_COMMENT', 'T_DOC_COMMENT'];

type Cls = ClassInfo & { fqn: string | null; open: number; close: number };
type Method = {
	name: string;
	line: number;
	close: number;
	arity: number;
	public: boolean;
	static: boolean;
	body: [number, number] | null;
	typed: boolean;
	open: number;
	declared: [number, number] | null;
};

const lower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const own = (o: object, k: string): boolean => Object.hasOwn(o, k);
const isTyped = (t: PhpToken): boolean => t.t.length > 1;
const trimLeft = (s: string, chars: string): string => {
	let i = 0;
	while (i < s.length && chars.includes(s[i] as string)) i++;
	return s.slice(i);
};
const trimRight = (s: string, chars: string): string => {
	let i = s.length;
	while (i > 0 && chars.includes(s[i - 1] as string)) i--;
	return s.slice(0, i);
};
const phpTrim = (s: string, chars = ' \n\r\t\v\0'): string => trimRight(trimLeft(s, chars), chars);

function nextNonSpace(tokens: PhpToken[], index: number): number | null {
	for (let k = index + 1; k < tokens.length; k++) {
		if (!BLANK.includes((tokens[k] as PhpToken).t)) return k;
	}
	return null;
}

function previousNonSpace(tokens: PhpToken[], index: number): number {
	for (let k = index - 1; k >= 0; k--) {
		if (!BLANK.includes((tokens[k] as PhpToken).t)) return k;
	}
	return -1;
}

const opens = (t: PhpToken): boolean =>
	t.t === '{' || t.t === 'T_CURLY_OPEN' || t.t === 'T_DOLLAR_OPEN_CURLY_BRACES';

function matchingBrace(tokens: PhpToken[], open: number): number | null {
	let depth = 0;
	for (let k = open; k < tokens.length; k++) {
		const t = tokens[k] as PhpToken;
		if (opens(t)) depth++;
		else if (t.t === '}' && --depth === 0) return k;
	}
	return null;
}

function matchingParen(tokens: PhpToken[], open: number): number | null {
	let depth = 0;
	for (let k = open; k < tokens.length; k++) {
		const t = (tokens[k] as PhpToken).t;
		if (t === '(') depth++;
		else if (t === ')' && --depth === 0) return k;
	}
	return null;
}

function resolveName(token: PhpToken, namespace: string, imports: Map<string, string>): string {
	const name = token.s;
	if (token.t === 'T_NAME_FULLY_QUALIFIED') return trimLeft(name, '\\');
	if (token.t === 'T_NAME_RELATIVE') {
		const rest = name.slice('namespace\\'.length);
		return namespace === '' ? rest : `${namespace}\\${rest}`;
	}
	const cut = name.indexOf('\\');
	const head = cut < 0 ? name : name.slice(0, cut);
	const known = imports.get(lower(head));
	if (known !== undefined) return known + (cut < 0 ? '' : name.slice(head.length));
	return namespace === '' ? name : `${namespace}\\${name}`;
}

function readImport(tokens: PhpToken[], at: number, imports: Map<string, string>): void {
	const next = nextNonSpace(tokens, at);
	if (next === null || (tokens[next] as PhpToken).t === '(') return;
	const first = (tokens[next] as PhpToken).t;
	if (first === 'T_FUNCTION' || first === 'T_CONST') return;
	let text = '';
	for (let k = next; k < tokens.length && (tokens[k] as PhpToken).t !== ';'; k++) {
		const tok = tokens[k] as PhpToken;
		if (!isTyped(tok)) text += tok.s;
		else if (tok.t === 'T_AS') text += ' as ';
		else if (!BLANK.includes(tok.t)) text += tok.s;
	}
	let prefix = '';
	let items = [text];
	const brace = text.indexOf('{');
	if (brace >= 0) {
		prefix = `${trimRight(text.slice(0, brace), '\\')}\\`;
		items = phpTrim(text.slice(brace + 1), '}').split(',');
	} else if (text.includes(',')) {
		items = text.split(',');
	}
	for (const item of items) {
		const parts = phpTrim(item).split(' as ');
		const name = prefix + trimLeft(phpTrim(parts[0] as string), '\\');
		if (name === prefix) continue;
		const last = name.lastIndexOf('\\');
		const alias =
			parts[1] !== undefined ? phpTrim(parts[1]) : last < 0 ? name : name.slice(last + 1);
		imports.set(lower(alias), name);
	}
}

function readClass(
	tokens: PhpToken[],
	at: number,
	namespace: string,
	imports: Map<string, string>
): Cls | null {
	const prev = previousNonSpace(tokens, at);
	if (prev >= 0 && (tokens[prev] as PhpToken).t === 'T_DOUBLE_COLON') return null;
	const next = nextNonSpace(tokens, at);
	if (next === null) return null;
	let fqn: string | null = null;
	let cursor = next;
	const nextTok = tokens[next] as PhpToken;
	if (nextTok.t === 'T_STRING') {
		fqn = namespace === '' ? nextTok.s : `${namespace}\\${nextTok.s}`;
		cursor = next + 1;
	} else if (nextTok.t === '(') {
		cursor = matchingParen(tokens, next) ?? next;
	}
	let extendsName: string | null = null;
	const implemented: string[] = [];
	let mode: 'extends' | 'implements' | null = null;
	for (let k = cursor; k < tokens.length; k++) {
		const token = tokens[k] as PhpToken;
		if (token.t === '{') {
			const close = matchingBrace(tokens, k);
			return close === null
				? null
				: { fqn, extends: extendsName, implements: implemented, open: k, close };
		}
		if (!isTyped(token)) continue;
		if (token.t === 'T_EXTENDS') mode = 'extends';
		else if (token.t === 'T_IMPLEMENTS') mode = 'implements';
		else if (NAMES.includes(token.t) && mode !== null) {
			const name = resolveName(token, namespace, imports);
			if (mode === 'extends') extendsName = name;
			else implemented.push(name);
		}
	}
	return null;
}

function findClasses(tokens: PhpToken[]): Cls[] {
	const out: Cls[] = [];
	let namespace = '';
	let imports = new Map<string, string>();
	const open: number[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as PhpToken;
		if (!isTyped(token)) continue;
		while (open.length > 0 && i > (open[open.length - 1] as number)) open.pop();
		if (token.t === 'T_NAMESPACE') {
			const next = nextNonSpace(tokens, i);
			const nextTok = next === null ? undefined : (tokens[next] as PhpToken);
			if (nextTok !== undefined && NAMES.includes(nextTok.t)) {
				namespace = trimLeft(nextTok.s, '\\');
				imports = new Map();
			} else if (nextTok?.t === '{') {
				namespace = '';
				imports = new Map();
			}
		} else if (token.t === 'T_USE' && open.length === 0) {
			readImport(tokens, i, imports);
		} else if (token.t === 'T_CLASS') {
			const cls = readClass(tokens, i, namespace, imports);
			if (cls !== null) {
				out.push(cls);
				open.push(cls.close);
			}
		}
	}
	return out;
}

function readMethod(tokens: PhpToken[], at: number): Method | null {
	let name = nextNonSpace(tokens, at);
	if (name !== null && (tokens[name] as PhpToken).t === '&') name = nextNonSpace(tokens, name);
	if (name === null || (tokens[name] as PhpToken).t !== 'T_STRING') return null;
	const open = nextNonSpace(tokens, name);
	const close =
		open === null || (tokens[open] as PhpToken).t !== '(' ? null : matchingParen(tokens, open);
	if (open === null || close === null) return null;
	let arity = 0;
	let depth = 0;
	for (let k = open + 1; k < close; k++) {
		const t = (tokens[k] as PhpToken).t;
		if (t === '(' || t === '[') depth++;
		else if (t === ')' || t === ']') depth--;
		else if (depth === 0 && t === 'T_VARIABLE') arity++;
	}
	let isPublic = true;
	let isStatic = false;
	for (let k = at - 1; k >= 0; k--) {
		const t = (tokens[k] as PhpToken).t;
		if (t.length === 1) break;
		if (t === 'T_STATIC') isStatic = true;
		else if (t === 'T_PRIVATE' || t === 'T_PROTECTED') isPublic = false;
		else if (![...BLANK, 'T_PUBLIC', 'T_ABSTRACT', 'T_FINAL'].includes(t)) break;
	}
	const after = nextNonSpace(tokens, close);
	let declared: [number, number] | null = null;
	let brace = after;
	if (after !== null && (tokens[after] as PhpToken).t === ':') {
		brace = after + 1;
		while (
			brace < tokens.length &&
			(tokens[brace] as PhpToken).t !== '{' &&
			(tokens[brace] as PhpToken).t !== ';'
		)
			brace++;
		declared = [after + 1, brace];
	}
	let body: [number, number] | null = null;
	if (brace !== null && tokens[brace]?.t === '{') {
		const end = matchingBrace(tokens, brace);
		body = end === null ? null : [brace, end];
	}
	const nameTok = tokens[name] as PhpToken;
	return {
		name: nameTok.s,
		line: nameTok.line,
		open,
		declared,
		close,
		arity,
		public: isPublic,
		static: isStatic,
		body,
		typed: after !== null && (tokens[after] as PhpToken).t === ':'
	};
}

function findMethods(tokens: PhpToken[], cls: Cls): Method[] {
	const out: Method[] = [];
	let depth = 0;
	for (let i = cls.open + 1; i < cls.close; i++) {
		const token = tokens[i] as PhpToken;
		if (opens(token)) depth++;
		else if (token.t === '}') depth--;
		else if (depth === 0 && token.t === 'T_FUNCTION') {
			const method = readMethod(tokens, i);
			if (method !== null) out.push(method);
		}
	}
	return out;
}

type Chain = { type: string | null; why: string | null; crossed: boolean };

function signature(
	cls: Cls,
	name: string,
	known: Map<string, ClassInfo>,
	typed: Map<string, Map<string, string>>,
	parents: Readonly<Record<string, string>>
): Chain {
	const interfaces = [...cls.implements];
	let parent = cls.extends;
	let crossed = false;
	const seen = new Set<string>();
	while (parent !== null && !seen.has(parent)) {
		seen.add(parent);
		const direct = typed.get(parent)?.get(name);
		if (direct !== undefined) return { type: direct, why: null, crossed };
		crossed = crossed || known.has(parent);
		const info = known.get(parent);
		const next = info?.extends ?? (own(parents, parent) ? (parents[parent] as string) : null);
		for (const interfaceName of info?.implements ?? []) interfaces.push(interfaceName);
		if (next === null && info === undefined && !typed.has(parent)) {
			return {
				type: null,
				why: `ancestor ${parent} is not in the module and not in the table`,
				crossed
			};
		}
		parent = next;
	}
	for (const interfaceName of interfaces) {
		for (const [owner, methods] of Object.entries(INTERFACES)) {
			if (lower(interfaceName) === lower(owner) && own(methods, name)) {
				return { type: methods[name] as string, why: null, crossed };
			}
		}
	}
	const php = new Set(Object.keys(INTERFACES).map(lower));
	for (const interfaceName of interfaces) {
		if (!php.has(lower(interfaceName))) {
			return {
				type: null,
				why: `interface ${interfaceName} is not readable, so the method may be required`,
				crossed
			};
		}
	}
	return { type: null, why: null, crossed };
}

function literalKind(parts: PhpToken[]): string | null {
	const first = parts[0] as PhpToken;
	if (parts.length === 1 && isTyped(first)) {
		if (first.t === 'T_LNUMBER') return 'int';
		if (first.t === 'T_DNUMBER') return 'float';
		if (first.t === 'T_CONSTANT_ENCAPSED_STRING') return 'string';
		if (first.t === 'T_STRING') {
			const word = lower(first.s);
			if (word === 'null') return 'null';
			if (word === 'true' || word === 'false') return 'bool';
		}
		return null;
	}
	const last = parts[parts.length - 1] as PhpToken;
	const short = first.t === '[' && last.t === ']';
	const long = isTyped(first) && first.t === 'T_ARRAY' && last.t === ')';
	return short || long ? 'array' : null;
}

function returnConflict(tokens: PhpToken[], at: number, type: string): string | null {
	const parts: PhpToken[] = [];
	let depth = 0;
	for (let k = at + 1; k < tokens.length; k++) {
		const token = tokens[k] as PhpToken;
		if (token.t === ';' && depth === 0) break;
		if (token.t === '(' || token.t === '[' || opens(token)) depth++;
		else if (token.t === ')' || token.t === ']' || token.t === '}') depth--;
		if (!isTyped(token) || !BLANK.includes(token.t)) parts.push(token);
	}
	if (type === 'void')
		return parts.length === 0 ? null : 'a return carries a value and the type is void';
	if (parts.length === 0) return `a bare return and the type is ${type}`;
	const kind = literalKind(parts);
	if (kind === null || type === 'mixed') return null;
	return kind === type ? null : `a return gives a ${kind} literal and the type is ${type}`;
}

function skipNested(tokens: PhpToken[], at: number, limit: number): number {
	for (let k = at + 1; k < limit; k++) {
		const t = (tokens[k] as PhpToken).t;
		if (t === '{') return matchingBrace(tokens, k) ?? limit;
		if (t === ';') return k;
	}
	return limit;
}

function bodyConflict(tokens: PhpToken[], body: [number, number], type: string): string | null {
	let returns = 0;
	let throws = false;
	let yields = false;
	for (let i = body[0] + 1; i < body[1]; i++) {
		const token = tokens[i] as PhpToken;
		if (!isTyped(token)) continue;
		if (token.t === 'T_FUNCTION' || token.t === 'T_CLASS') {
			i = skipNested(tokens, i, body[1]);
		} else if (token.t === 'T_YIELD' || token.t === 'T_YIELD_FROM') {
			yields = true;
			if (type !== 'mixed' && type !== 'Traversable') {
				return `the body is a generator and the type is ${type}`;
			}
		} else if (token.t === 'T_THROW') {
			throws = true;
		} else if (token.t === 'T_RETURN') {
			returns++;
			const reason = returnConflict(tokens, i, type);
			if (reason !== null) return reason;
		}
	}
	if (returns === 0 && !throws && !yields && type !== 'void') {
		return `the body never returns a value and the type is ${type}`;
	}
	return null;
}

function refusalFor(
	tokens: PhpToken[],
	method: Method,
	name: string,
	type: string | null
): string | null {
	if (!method.public)
		return 'the method is not public, so it does not override the parent method';
	if (method.arity !== ARITY[name]) {
		return `takes ${method.arity} parameters, the parent takes ${ARITY[name]}`;
	}
	if (type === null || method.body === null) return null;
	return bodyConflict(tokens, method.body, trimLeft(type, '\\'));
}

// #region narrowing a declared type that is wider than the parent's

/** the declared type as written when it is a supertype of the parent's to narrow, else null */
function widerThan(tokens: PhpToken[], method: Method, type: string, name: string): string | null {
	const parent = trimLeft(type, '\\');
	if (
		!NARROWABLE.has(parent) ||
		method.declared === null ||
		!method.public ||
		method.arity !== ARITY[name]
	) {
		return null;
	}
	let text = '';
	for (let k = method.declared[0]; k < method.declared[1]; k++) {
		const token = tokens[k] as PhpToken;
		if (!isTyped(token) || !BLANK.includes(token.t)) text += token.s;
	}
	if (text.includes('(') || text.includes(')') || text.includes('&')) return null;
	const members = (text.startsWith('?') ? [text.slice(1), 'null'] : text.split('|')).map((m) =>
		lower(trimLeft(m, '\\'))
	);
	if (members.length === 1 && members[0] === 'mixed') return text;
	return members.length > 1 && members.includes(parent) ? text : null;
}

/** the token replacements that turn a declared type into the parent's */
function narrowing(
	tokens: PhpToken[],
	declared: [number, number],
	parent: string
): Map<number, string> {
	const out = new Map<number, string>();
	for (let k = declared[0]; k < declared[1]; k++) {
		const token = tokens[k] as PhpToken;
		if (isTyped(token) && BLANK.includes(token.t)) continue;
		out.set(k, out.size === 0 ? parent : '');
	}
	return out;
}

/** the tokens of a return statement's value, without whitespace and comments */
function returnParts(tokens: PhpToken[], at: number): PhpToken[] {
	const parts: PhpToken[] = [];
	let depth = 0;
	for (let k = at + 1; k < tokens.length; k++) {
		const token = tokens[k] as PhpToken;
		if (token.t === ';' && depth === 0) break;
		if (token.t === '(' || token.t === '[' || opens(token)) depth++;
		else if (token.t === ')' || token.t === ']' || token.t === '}') depth--;
		if (!isTyped(token) || !BLANK.includes(token.t)) parts.push(token);
	}
	return parts;
}

/** whether the bracket at an index closes at the last token and nothing follows it */
function closesAtEnd(parts: PhpToken[], from: number): boolean {
	let depth = 0;
	const last = parts.length - 1;
	for (let k = from; k <= last; k++) {
		const token = parts[k] as PhpToken;
		if (token.t === '(' || token.t === '[' || opens(token)) depth++;
		else if (token.t === ')' || token.t === ']' || token.t === '}') {
			depth--;
			if (depth === 0) return k === last;
		}
	}
	return false;
}

/** whether an expression holds no operator outside brackets, so a cast binds all of it */
function isPrimary(parts: PhpToken[]): boolean {
	const allowed = [
		'T_VARIABLE',
		'T_STRING',
		'T_NAME_QUALIFIED',
		'T_NAME_FULLY_QUALIFIED',
		'T_OBJECT_OPERATOR',
		'T_NULLSAFE_OBJECT_OPERATOR',
		'T_DOUBLE_COLON',
		'T_LNUMBER',
		'T_DNUMBER',
		'T_CONSTANT_ENCAPSED_STRING'
	];
	let depth = 0;
	for (const token of parts) {
		if (token.t === '(' || token.t === '[' || opens(token)) depth++;
		else if (token.t === ')' || token.t === ']' || token.t === '}') depth--;
		else if (depth === 0 && (!isTyped(token) || !allowed.includes(token.t))) return false;
	}
	return parts.length > 0 && depth === 0;
}

function callName(parts: PhpToken[]): string | null {
	const first = parts[0] as PhpToken;
	if ((first.t !== 'T_STRING' && first.t !== 'T_NAME_FULLY_QUALIFIED') || parts[1]?.t !== '(') {
		return null;
	}
	return closesAtEnd(parts, 1) ? first.s : null;
}

function isParentCall(parts: PhpToken[], name: string): boolean {
	const [a, b, c, d] = parts as [PhpToken, PhpToken, PhpToken, PhpToken];
	return (
		parts.length >= 5 &&
		a.t === 'T_STRING' &&
		lower(a.s) === 'parent' &&
		b.t === 'T_DOUBLE_COLON' &&
		c.t === 'T_STRING' &&
		lower(c.s) === name &&
		d.t === '(' &&
		closesAtEnd(parts, 3)
	);
}

/** the type a cast token casts to, when it is one the check reads */
function castType(token: PhpToken): string | null {
	if (token.t !== 'T_CAST') return null;
	const word = lower(token.s.replace(/[()\s]/g, ''));
	return own(CAST_TYPES, word) ? (CAST_TYPES[word] as string) : null;
}

/** whether an expression is provably of a type from its tokens alone */
function isProvable(parts: PhpToken[], type: string, name: string, parentCall: boolean): boolean {
	const first = parts[0] as PhpToken;
	if (type === 'array' && (first.t === '[' || first.t === 'T_ARRAY')) {
		const open = first.t === '[' ? 0 : 1;
		return open < parts.length && closesAtEnd(parts, open);
	}
	if (!isTyped(first)) return false;
	if (parts.length === 1) return type !== 'array' && literalKind(parts) === type;
	const cast = castType(first);
	if (cast !== null) return cast === type && isPrimary(parts.slice(1));
	if (parentCall && isParentCall(parts, name)) return true;
	const call = callName(parts);
	return call !== null && type === 'array' && ARRAY_FUNCTIONS.has(lower(trimLeft(call, '\\')));
}

/** why a returned variable is not provably of the type, or null when every use keeps it so */
function variableConflict(
	tokens: PhpToken[],
	method: Method,
	variable: string,
	type: string,
	name: string,
	parentCall: boolean
): string | null {
	const body = method.body ?? [0, 0];
	for (let k = method.open + 1; k < method.close; k++) {
		const token = tokens[k] as PhpToken;
		if (token.t === 'T_VARIABLE' && token.s === variable) return `${variable} is a parameter`;
	}
	let assigned = 0;
	for (let i = body[0] + 1; i < body[1]; i++) {
		const token = tokens[i] as PhpToken;
		if (token.t !== 'T_VARIABLE' || token.s !== variable) continue;
		const prev = previousNonSpace(tokens, i);
		const next = nextNonSpace(tokens, i);
		const after = next === null ? null : (tokens[next] as PhpToken);
		const before = prev < 0 ? null : (tokens[prev] as PhpToken);
		if (after?.t === '[' && type === 'array') continue;
		if (before?.t === 'T_RETURN' && after?.t === ';') continue;
		if (before?.t === '(' && after?.t === ')') {
			const caller = previousNonSpace(tokens, prev);
			const word = caller < 0 ? null : (tokens[caller] as PhpToken);
			if (
				word !== null &&
				((word.t === 'T_KW' && ['isset', 'empty'].includes(lower(word.s))) ||
					(word.t === 'T_STRING' && ['count', 'is_array'].includes(lower(word.s))))
			) {
				continue;
			}
		}
		if (after?.t === '=' && before !== null && [';', '{', '}'].includes(before.t)) {
			const parts = returnParts(tokens, next as number);
			if (parts.length > 0 && isProvable(parts, type, name, parentCall)) {
				assigned++;
				continue;
			}
			return `${variable} is assigned a value not shown to be ${type}`;
		}
		return `${variable} is used in a way the check cannot follow`;
	}
	return assigned > 0 ? null : `${variable} is never assigned in the method`;
}

/** whether a body ends in a statement that returns or throws */
function endsInExit(tokens: PhpToken[], body: [number, number]): boolean {
	let depth = 0;
	let start = true;
	let last: number | null = null;
	for (let i = body[0] + 1; i < body[1]; i++) {
		const token = tokens[i] as PhpToken;
		if (isTyped(token) && BLANK.includes(token.t)) continue;
		if (start) {
			last = i;
			start = false;
		}
		if (token.t === '(' || token.t === '[' || opens(token)) {
			depth++;
		} else if (token.t === ')' || token.t === ']' || token.t === '}') {
			depth--;
			start = token.t === '}' && depth === 0;
		} else if (token.t === ';' && depth === 0) {
			start = true;
		}
	}
	const end = previousNonSpace(tokens, body[1]);
	return (
		last !== null &&
		(tokens[end] as PhpToken).t === ';' &&
		((tokens[last] as PhpToken).t === 'T_RETURN' || (tokens[last] as PhpToken).t === 'T_THROW')
	);
}

/** why narrowing a method's declared type could change what it returns, or null when it cannot */
function narrowConflict(
	tokens: PhpToken[],
	method: Method,
	name: string,
	type: string,
	parentCall: boolean
): string | null {
	const body = method.body;
	if (body === null) return 'the method has no body to check';
	const returns: number[] = [];
	for (let i = body[0] + 1; i < body[1]; i++) {
		const token = tokens[i] as PhpToken;
		if (!isTyped(token)) continue;
		if (token.t === 'T_FUNCTION' || token.t === 'T_CLASS') i = skipNested(tokens, i, body[1]);
		else if (token.t === 'T_YIELD' || token.t === 'T_YIELD_FROM')
			return 'the body is a generator';
		else if (token.t === 'T_RETURN') returns.push(i);
	}
	if (returns.length === 0) return 'the body has no return statement';
	if (!endsInExit(tokens, body)) return 'the body can end without a return';
	for (const at of returns) {
		const parts = returnParts(tokens, at);
		const line = (tokens[at] as PhpToken).line;
		if (parts.length === 0) return `a bare return on line ${line}`;
		if (isProvable(parts, type, name, parentCall)) continue;
		const first = parts[0] as PhpToken;
		const variable = parts.length === 1 && first.t === 'T_VARIABLE' && first.s !== '$this';
		const why = variable
			? variableConflict(tokens, method, first.s, type, name, parentCall)
			: null;
		if (variable && why === null) continue;
		return `the return on line ${line} is not shown to be ${type}${why === null ? '' : `: ${why}`}`;
	}
	return null;
}

// #endregion

const prepared = new WeakMap<object, Map<string, Map<string, string>>>();

function typedMap(table: ReturnTypeTable): Map<string, Map<string, string>> {
	let map = prepared.get(table.typed);
	if (map === undefined) {
		map = new Map(
			Object.entries(table.typed).map(([cls, methods]) => [
				cls,
				new Map(Object.entries(methods).map(([method, type]) => [lower(method), type]))
			])
		);
		prepared.set(table.typed, map);
	}
	return map;
}

/** the named classes one source declares, by fully qualified name */
export function indexClasses(code: string): Map<string, ClassInfo> {
	const out = new Map<string, ClassInfo>();
	for (const cls of findClasses(tokenize(code))) {
		if (cls.fqn !== null)
			out.set(cls.fqn, { extends: cls.extends, implements: cls.implements });
	}
	return out;
}

/**
 * Adds the missing return types to the methods the table covers, and narrows a declared type that
 * is wider than the parent's when every return is provably the parent's type. `index` is the classes
 * of the rest of the module; `refusals` receives each covered method left alone. Answers the source
 * and how many types it added or narrowed.
 */
export function rewriteSource(
	code: string,
	index: ReadonlyMap<string, ClassInfo> = new Map(),
	refusals: Refusal[] = [],
	table: ReturnTypeTable = CORE_TABLE
): { code: string; added: number } {
	const tokens = tokenize(code);
	const classes = findClasses(tokens);
	const known = new Map(index);
	for (const cls of classes) {
		if (cls.fqn !== null)
			known.set(cls.fqn, { extends: cls.extends, implements: cls.implements });
	}
	const typed = typedMap(table);
	const insert = new Map<number, string>();
	const replace = new Map<number, string>();
	let narrowed = 0;
	for (const cls of classes) {
		for (const method of findMethods(tokens, cls)) {
			const name = lower(method.name);
			if (!own(ARITY, name) || method.static) continue;
			const chain = signature(cls, name, known, typed, table.parents);
			if (method.typed) {
				const wider =
					chain.type === null ? null : widerThan(tokens, method, chain.type, name);
				if (wider === null) continue;
				const parent = trimLeft(chain.type as string, '\\');
				const why = narrowConflict(tokens, method, name, parent, !chain.crossed);
				if (why === null) {
					narrowed++;
					const edits = narrowing(tokens, method.declared ?? [0, 0], parent);
					for (const [k, text] of edits) if (!replace.has(k)) replace.set(k, text);
				} else {
					refusals.push({
						class: cls.fqn ?? 'class@anonymous',
						method: method.name,
						line: method.line,
						reason: `the declared type ${wider} is wider than the parent type ${parent} and ${why}`
					});
				}
				continue;
			}
			if (chain.type === null && chain.why === null) continue;
			const why = chain.why ?? refusalFor(tokens, method, name, chain.type);
			if (why !== null) {
				refusals.push({
					class: cls.fqn ?? 'class@anonymous',
					method: method.name,
					line: method.line,
					reason: why
				});
				continue;
			}
			insert.set(method.close, `: ${chain.type}`);
		}
	}
	if (insert.size === 0 && replace.size === 0) return { code, added: 0 };
	let out = '';
	tokens.forEach((token, at) => {
		out += (replace.get(at) ?? token.s) + (insert.get(at) ?? '');
	});
	return { code: out, added: insert.size + narrowed };
}

// #region module pass

/** the files a rewrite reads: PHP an extension tree can load */
const EXTENSION_FILE =
	/^(?:modules|themes|profiles)\/.+\.(?:php|module|inc|install|theme|engine|profile)$/;

/** a method name followed by its parameter list, which is the only shape the rewrite touches */
const COVERED =
	/function(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#(?!\[)[^\n]*)*(?:offsetexists|offsetget|offsetset|offsetunset|getiterator|count|jsonserialize|current|key|next|rewind|valid|normalize)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#(?!\[)[^\n]*)*\(/i;

/** a source file in a delivery */
export type ModuleSource = { path: string; source: string };

/** what a delivery's rewrite did */
export type ReturnTypeReport = {
	/** files whose text changed */
	files: number;
	/** return types added */
	methods: number;
	/** methods left alone, with why */
	refused: (Refusal & { path: string })[];
	/** return types added, by path */
	byPath: Record<string, number>;
};

/** an empty report to hand to a delivery */
export function emptyReport(): ReturnTypeReport {
	return { files: 0, methods: 0, refused: [], byPath: {} };
}

/** the part of a report that concerns the paths a commit wrote, added to `into` */
export function addWritten(
	into: ReturnTypeReport,
	from: ReturnTypeReport,
	written: ReadonlySet<string>
): void {
	for (const [path, count] of Object.entries(from.byPath)) {
		if (!written.has(path)) continue;
		into.files++;
		into.methods += count;
		into.byPath[path] = (into.byPath[path] ?? 0) + count;
	}
	for (const refusal of from.refused) if (written.has(refusal.path)) into.refused.push(refusal);
}

/** the refusals a receipt lists before it says how many more there were */
export const REFUSALS_LISTED = 25;

/** a report as a receipt carries it */
export function receiptOf(report: ReturnTypeReport): {
	files: number;
	methods: number;
	refused: number;
	refusals: ReturnTypeReport['refused'];
} {
	return {
		files: report.files,
		methods: report.methods,
		refused: report.refused.length,
		refusals: report.refused.slice(0, REFUSALS_LISTED)
	};
}

/** whether the environment switches the rewrite off; it is on unless `off` */
export function returnTypesOff(env: { ANACHRON_RETURN_TYPES?: string } | undefined): boolean {
	return lower(String(env?.ANACHRON_RETURN_TYPES ?? '').trim()) === 'off';
}

/**
 * Rewrites the extension files of a delivery and adds what it did to `report`.
 *
 * A source with no covered method name is never tokenized. When some file has one, every file of
 * the delivery is indexed, then the files `held` supplies for the same package, so a class that
 * extends one a smaller delivery left untouched still resolves. Files come back in the order given.
 */
export function addReturnTypes<T extends ModuleSource>(
	files: readonly T[],
	report: ReturnTypeReport,
	held?: () => Iterable<ModuleSource>,
	table: ReturnTypeTable = CORE_TABLE
): T[] {
	const eligible = files.filter((f) => EXTENSION_FILE.test(f.path));
	if (!eligible.some((f) => COVERED.test(f.source))) return [...files];
	const all = new Map<string, string>();
	for (const f of held?.() ?? []) all.set(f.path, f.source);
	for (const f of eligible) all.set(f.path, f.source);
	const index = new Map<string, ClassInfo>();
	for (const path of [...all.keys()].sort()) {
		const source = all.get(path) as string;
		if (!EXTENSION_FILE.test(path) || !/class/i.test(source)) continue;
		for (const [fqn, info] of indexClasses(source)) if (!index.has(fqn)) index.set(fqn, info);
	}
	const sources = new Map<string, string>();
	for (const f of [...eligible].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0
	)) {
		if (!COVERED.test(f.source)) continue;
		const found: Refusal[] = [];
		const done = rewriteSource(f.source, index, found, table);
		for (const refusal of found) report.refused.push({ path: f.path, ...refusal });
		if (done.added > 0) {
			report.files++;
			report.methods += done.added;
			report.byPath[f.path] = (report.byPath[f.path] ?? 0) + done.added;
			sources.set(f.path, done.code);
		}
	}
	return files.map((f) => {
		const code = sources.get(f.path);
		return code === undefined ? f : { ...f, source: code };
	});
}

// #endregion
