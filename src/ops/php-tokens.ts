/**
 * A lossless PHP tokenizer that mirrors `token_get_all()` on PHP 8.5 for the token kinds the return
 * type rewrite reads.
 *
 * Joining every token's text gives the source back. A one-character token has the character as its
 * kind, as PHP gives it as a string; every other token has a `T_` name or `op`. Tokens the rewrite
 * never looks at share a kind: `T_KW` for a reserved word and `op` for a multi-character operator.
 * Short open tags are not recognised, which is the default in every shipped ini file.
 *
 * @module
 */

/** one token: its kind, its text and the line it starts on */
export type PhpToken = { t: string; s: string; line: number };

const RESERVED = new Set(
	(
		'abstract and array as break callable case catch class clone const continue declare default do echo else ' +
		'elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit die extends final finally ' +
		'fn for foreach function global goto if implements include include_once instanceof insteadof interface ' +
		'isset list match namespace new or print private protected public readonly require require_once return ' +
		'static switch throw trait try unset use var while xor yield __class__ __dir__ __file__ __function__ ' +
		'__line__ __method__ __namespace__ __trait__ __halt_compiler'
	).split(' ')
);

/** the reserved words the rewrite tells apart, by lowercase text */
const NAMED: Record<string, string> = {
	abstract: 'T_ABSTRACT',
	array: 'T_ARRAY',
	as: 'T_AS',
	class: 'T_CLASS',
	const: 'T_CONST',
	extends: 'T_EXTENDS',
	final: 'T_FINAL',
	function: 'T_FUNCTION',
	implements: 'T_IMPLEMENTS',
	namespace: 'T_NAMESPACE',
	private: 'T_PRIVATE',
	protected: 'T_PROTECTED',
	public: 'T_PUBLIC',
	return: 'T_RETURN',
	static: 'T_STATIC',
	throw: 'T_THROW',
	use: 'T_USE',
	yield: 'T_YIELD'
};

const OPERATORS = [
	'<=>',
	'**=',
	'...',
	'<<=',
	'>>=',
	'===',
	'!==',
	'??=',
	'?->',
	'->',
	'=>',
	'==',
	'!=',
	'<>',
	'<=',
	'>=',
	'&&',
	'||',
	'++',
	'--',
	'+=',
	'-=',
	'*=',
	'/=',
	'.=',
	'%=',
	'&=',
	'|=',
	'^=',
	'<<',
	'>>',
	'**',
	'??',
	'|>'
];

const CAST =
	/\(\s*(?:int|integer|bool|boolean|float|double|string|binary|array|object|unset|void)\s*\)/iy;
const HEREDOC =
	/<<<[ \t]*(?:'([A-Za-z_\u0080-￿][\w\u0080-￿]*)'|"([A-Za-z_\u0080-￿][\w\u0080-￿]*)"|([A-Za-z_\u0080-￿][\w\u0080-￿]*))(\r\n|\n|\r)/iy;
const NUMBER =
	/(?:0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*|0[bB][01]+(?:_[01]+)*|0[oO][0-7]+(?:_[0-7]+)*|(?:\d+(?:_\d+)*)?\.\d+(?:_\d+)*(?:[eE][+-]?\d+(?:_\d+)*)?|\d+(?:_\d+)*\.(?:\d+(?:_\d+)*)?(?:[eE][+-]?\d+(?:_\d+)*)?|\d+(?:_\d+)*[eE][+-]?\d+(?:_\d+)*|\d+(?:_\d+)*)/y;
const INT_MAX = 9223372036854775807n;

const isStart = (c: string | undefined): boolean =>
	c !== undefined &&
	((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c >= '\u0080');
const isWord = (c: string | undefined): boolean =>
	isStart(c) || (c !== undefined && c >= '0' && c <= '9');

/** how many lines a token's text ends: `\n`, and a `\r` that no `\n` follows, as the scanner counts */
function newlines(text: string): number {
	let n = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) n++;
	}
	return n;
}

function numberKind(text: string): string {
	if (/^0[xXbBoO]/.test(text)) {
		const digits = text.replace(/_/g, '');
		return BigInt(digits.replace(/^0[oO]/, '0o')) > INT_MAX ? 'T_DNUMBER' : 'T_LNUMBER';
	}
	if (/[.eE]/.test(text)) return 'T_DNUMBER';
	const digits = text.replace(/_/g, '');
	const value =
		/^0\d+$/.test(digits) && !/[89]/.test(digits) ? BigInt(`0o${digits}`) : BigInt(digits);
	return value > INT_MAX ? 'T_DNUMBER' : 'T_LNUMBER';
}

type Frame =
	| { mode: 'html' }
	| { mode: 'script' }
	| { mode: 'curly'; depth: number }
	| { mode: 'encaps'; term: string }
	| { mode: 'heredoc'; label: string }
	| { mode: 'nowdoc'; label: string };

/** tokenizes PHP source; never throws, and `tokens.map((t) => t.s).join('')` is the input */
export function tokenize(code: string): PhpToken[] {
	const out: PhpToken[] = [];
	const stack: Frame[] = [{ mode: 'html' }];
	let line = 1;
	let at = 0;
	let arrow = false;
	const n = code.length;

	const emit = (t: string, s: string): void => {
		if (s === '') return;
		out.push({ t, s, line });
		line += newlines(s);
		at += s.length;
	};

	/** the closing marker of a heredoc at `from`, with its indentation, or undefined */
	const closing = (from: number, label: string): string | undefined => {
		let k = from;
		while (code[k] === ' ' || code[k] === '\t') k++;
		if (code.startsWith(label, k) && !isWord(code[k + label.length])) {
			return code.slice(from, k + label.length);
		}
		return undefined;
	};

	/** the variable, offset or property a `$` in a string starts, as PHP tokenizes it */
	const interpolate = (): void => {
		const name = /\$[A-Za-z_\u0080-￿][\w\u0080-￿]*/y;
		name.lastIndex = at;
		const m = name.exec(code);
		if (!m) return;
		emit('T_VARIABLE', m[0]);
		if (code[at] === '[') {
			const close = code.indexOf(']', at);
			if (close > at) {
				const inner = code.slice(at + 1, close);
				emit('[', '[');
				const kind = inner.startsWith('$')
					? 'T_VARIABLE'
					: /^-?\d/.test(inner)
						? 'T_NUM_STRING'
						: isStart(inner[0])
							? 'T_STRING'
							: 'T_ENCAPSED_AND_WHITESPACE';
				emit(kind, inner);
				emit(']', ']');
			}
		} else if (
			(code.startsWith('->', at) && isStart(code[at + 2])) ||
			(code.startsWith('?->', at) && isStart(code[at + 3]))
		) {
			const op = code[at] === '?' ? '?->' : '->';
			emit(op === '->' ? 'T_OBJECT_OPERATOR' : 'T_NULLSAFE_OBJECT_OPERATOR', op);
			const word = /[A-Za-z_\u0080-￿][\w\u0080-￿]*/y;
			word.lastIndex = at;
			emit('T_STRING', word.exec(code)?.[0] ?? '');
		}
	};

	/** reads the inside of a double-quoted, backtick or heredoc string up to its end */
	const encaps = (frame: Frame): void => {
		let k = at;
		let lineStart =
			(frame.mode === 'heredoc' || frame.mode === 'nowdoc') &&
			(at === 0 || code[at - 1] === '\n' || code[at - 1] === '\r');
		const cut = (to: number): void => {
			if (to > at) emit('T_ENCAPSED_AND_WHITESPACE', code.slice(at, to));
		};
		for (; k < n;) {
			const c = code[k] as string;
			if (frame.mode === 'heredoc' || frame.mode === 'nowdoc') {
				if (lineStart) {
					const end = closing(k, frame.label);
					if (end !== undefined) {
						cut(k);
						emit('T_END_HEREDOC', end);
						stack.pop();
						return;
					}
				}
				lineStart = c === '\n' || (c === '\r' && code[k + 1] !== '\n');
			} else if (c === (frame as { term: string }).term) {
				cut(k);
				emit(c, c);
				stack.pop();
				return;
			}
			if (c === '\\' && frame.mode !== 'nowdoc') {
				k += 2;
				lineStart = false;
				continue;
			}
			if (frame.mode !== 'nowdoc') {
				if (c === '$' && isStart(code[k + 1])) {
					cut(k);
					interpolate();
					k = at;
					lineStart = false;
					continue;
				}
				if (c === '{' && code[k + 1] === '$') {
					cut(k);
					emit('T_CURLY_OPEN', '{');
					stack.push({ mode: 'curly', depth: 1 });
					return;
				}
				if (c === '$' && code[k + 1] === '{') {
					cut(k);
					emit('T_DOLLAR_OPEN_CURLY_BRACES', '${');
					const name = /[A-Za-z_\u0080-￿][\w\u0080-￿]*(?=[}[])/y;
					name.lastIndex = at;
					const m = name.exec(code);
					if (m) emit('T_STRING_VARNAME', m[0]);
					stack.push({ mode: 'curly', depth: 1 });
					return;
				}
			}
			k++;
		}
		cut(Math.min(k, n));
	};

	while (at < n) {
		const top = stack[stack.length - 1] as Frame;
		const c = code[at] as string;

		if (top.mode === 'html') {
			const m = /<\?php(?:[ \t]|\r\n|\n|\r|$)|<\?=/iy;
			let from = at;
			let found: RegExpExecArray | null = null;
			for (;;) {
				const hit = code.indexOf('<?', from);
				if (hit < 0) break;
				m.lastIndex = hit;
				found = m.exec(code);
				if (found) break;
				from = hit + 2;
			}
			if (!found) {
				emit('T_INLINE_HTML', code.slice(at));
				break;
			}
			emit('T_INLINE_HTML', code.slice(at, found.index));
			emit(found[0] === '<?=' ? 'T_OPEN_TAG_WITH_ECHO' : 'T_OPEN_TAG', found[0]);
			stack[stack.length - 1] = { mode: 'script' };
			continue;
		}

		if (top.mode === 'encaps' || top.mode === 'heredoc' || top.mode === 'nowdoc') {
			encaps(top);
			continue;
		}

		// script, or script inside `{$ ... }`
		if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
			let k = at;
			while (code[k] === ' ' || code[k] === '\t' || code[k] === '\r' || code[k] === '\n') k++;
			emit('T_WHITESPACE', code.slice(at, k));
			continue;
		}
		const keepArrow = arrow;
		arrow = false;

		if (c === '#' && code[at + 1] === '[') {
			emit('T_ATTRIBUTE', '#[');
			continue;
		}
		if (c === '#' || (c === '/' && code[at + 1] === '/')) {
			let k = at;
			while (
				k < n &&
				code[k] !== '\n' &&
				code[k] !== '\r' &&
				!(code[k] === '?' && code[k + 1] === '>')
			)
				k++;
			emit('T_COMMENT', code.slice(at, k));
			continue;
		}
		if (c === '/' && code[at + 1] === '*') {
			const close = code.indexOf('*/', at + 2);
			const end = close < 0 ? n : close + 2;
			const doc = code[at + 2] === '*' && /[ \t\r\n]/.test(code[at + 3] ?? '');
			emit(doc ? 'T_DOC_COMMENT' : 'T_COMMENT', code.slice(at, end));
			continue;
		}
		if (c === '?' && code[at + 1] === '>') {
			const tail = code.startsWith('\r\n', at + 2)
				? 2
				: /[\r\n]/.test(code[at + 2] ?? '')
					? 1
					: 0;
			emit('T_CLOSE_TAG', code.slice(at, at + 2 + tail));
			stack[stack.length - 1] = { mode: 'html' };
			continue;
		}
		if (c === '$' && isStart(code[at + 1])) {
			let k = at + 1;
			while (isWord(code[k])) k++;
			emit('T_VARIABLE', code.slice(at, k));
			continue;
		}
		if (
			(c >= '0' && c <= '9') ||
			(c === '.' &&
				code[at + 1] !== undefined &&
				code[at + 1]! >= '0' &&
				code[at + 1]! <= '9')
		) {
			NUMBER.lastIndex = at;
			const m = NUMBER.exec(code);
			if (m) {
				emit(numberKind(m[0]), m[0]);
				continue;
			}
		}
		if (c === "'") {
			let k = at + 1;
			while (k < n && code[k] !== "'") k += code[k] === '\\' ? 2 : 1;
			emit('T_CONSTANT_ENCAPSED_STRING', code.slice(at, Math.min(k + 1, n)));
			continue;
		}
		if (c === '"') {
			let k = at + 1;
			let plain = true;
			while (k < n && code[k] !== '"') {
				if (code[k] === '\\') {
					k += 2;
					continue;
				}
				if (
					(code[k] === '$' && (isStart(code[k + 1]) || code[k + 1] === '{')) ||
					(code[k] === '{' && code[k + 1] === '$')
				) {
					plain = false;
					break;
				}
				k++;
			}
			if (plain) {
				emit('T_CONSTANT_ENCAPSED_STRING', code.slice(at, Math.min(k + 1, n)));
			} else {
				emit('"', '"');
				stack.push({ mode: 'encaps', term: '"' });
			}
			continue;
		}
		if (c === '`') {
			emit('`', '`');
			stack.push({ mode: 'encaps', term: '`' });
			continue;
		}
		if (c === '<' && code.startsWith('<<<', at)) {
			HEREDOC.lastIndex = at;
			const m = HEREDOC.exec(code);
			if (m) {
				const label = (m[1] ?? m[2] ?? m[3]) as string;
				emit('T_START_HEREDOC', m[0]);
				stack.push({ mode: m[1] === undefined ? 'heredoc' : 'nowdoc', label });
				continue;
			}
		}
		if (c === '\\') {
			if (isStart(code[at + 1])) {
				let k = at + 1;
				for (;;) {
					while (isWord(code[k])) k++;
					if (code[k] === '\\' && isStart(code[k + 1])) k++;
					else break;
				}
				emit('T_NAME_FULLY_QUALIFIED', code.slice(at, k));
			} else {
				emit('T_NS_SEPARATOR', c);
			}
			continue;
		}
		if (isStart(c)) {
			let k = at;
			while (isWord(code[k])) k++;
			let qualified = false;
			while (code[k] === '\\' && isStart(code[k + 1])) {
				qualified = true;
				k++;
				while (isWord(code[k])) k++;
			}
			const text = code.slice(at, k);
			if (qualified) {
				emit(/^namespace\\/i.test(text) ? 'T_NAME_RELATIVE' : 'T_NAME_QUALIFIED', text);
				continue;
			}
			const lower = text.replace(/[A-Z]/g, (x) => x.toLowerCase());
			if (keepArrow) {
				emit('T_STRING', text);
			} else if (lower === 'yield') {
				const from = /yield[ \t\r\n]+from(?![\w\u0080-￿])/iy;
				from.lastIndex = at;
				const m = from.exec(code);
				if (m) emit('T_YIELD_FROM', m[0]);
				else emit('T_YIELD', text);
			} else if (lower === 'enum') {
				const next = /enum[ \t\r\n]+(?!extends\b|implements\b)[A-Za-z_\u0080-￿]/iy;
				next.lastIndex = at;
				emit(next.test(code) ? 'T_KW' : 'T_STRING', text);
			} else if (NAMED[lower] !== undefined) {
				emit(NAMED[lower], text);
			} else {
				emit(RESERVED.has(lower) ? 'T_KW' : 'T_STRING', text);
			}
			continue;
		}
		if (c === '(') {
			CAST.lastIndex = at;
			const m = CAST.exec(code);
			if (m) {
				emit('T_CAST', m[0]);
				continue;
			}
		}
		if (c === '&') {
			const two = code.slice(at, at + 2);
			if (two === '&&' || two === '&=') emit('op', two);
			else emit('T_AMPERSAND', c);
			continue;
		}
		if (c === ':' && code[at + 1] === ':') {
			emit('T_DOUBLE_COLON', '::');
			continue;
		}
		const op = OPERATORS.find((o) => code.startsWith(o, at));
		if (op !== undefined) {
			if (op === '->' || op === '?->') {
				emit(op === '->' ? 'T_OBJECT_OPERATOR' : 'T_NULLSAFE_OBJECT_OPERATOR', op);
				arrow = true;
			} else {
				emit('op', op);
			}
			continue;
		}
		if (top.mode === 'curly') {
			if (c === '{') top.depth++;
			else if (c === '}' && --top.depth === 0) stack.pop();
		}
		emit(c, c);
	}
	return out;
}
