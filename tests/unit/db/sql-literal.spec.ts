import { describe, expect, it } from 'vitest';

import {
	decodeMysqlString,
	decodeStringToken,
	encodeSqliteString
} from '../../../src/db/sql/literal';

/** the MySQL string decode and the SQLite encode, with the cases of the PHP implementation */

describe('decodeMysqlString', () => {
	const cases: [string, string, string][] = [
		['plain text passes through', 'abc', 'abc'],
		['backslash n, r, t and b', 'a\\nb\\rc\\td\\be', 'a\nb\rc\td\x08e'],
		['backslash zero is a NUL', 'a\\0b', 'a\0b'],
		['backslash Z is ASCII 26', 'a\\Zb', 'a\x1ab'],
		['an escaped backslash is one backslash', 'a\\\\b', 'a\\b'],
		['an escaped quote is the quote', "a\\'b", "a'b"],
		['an escaped double quote is the quote', 'a\\"b', 'a"b'],
		['a doubled single quote is one quote', "a''b", "a'b"],
		['backslash percent keeps its backslash', 'a\\%b', 'a\\%b'],
		['backslash underscore keeps its backslash', 'a\\_b', 'a\\_b'],
		['an unknown escape is the character itself', 'a\\qb', 'aqb'],
		['a trailing backslash is kept', 'abc\\', 'abc\\'],
		['multibyte text passes through', 'café € 😀', 'café € 😀'],
		['an empty body is empty', '', '']
	];
	for (const [label, raw, expected] of cases) {
		it(label, () => expect(decodeMysqlString(raw)).toBe(expected));
	}

	it('reads a doubled double quote as one quote in a double quoted body', () => {
		expect(decodeMysqlString('a""b', '"')).toBe('a"b');
	});

	it('keeps a doubled single quote as two in a double quoted body', () => {
		expect(decodeMysqlString("a''b", '"')).toBe("a''b");
	});

	it('decodes a long body in one pass', () => {
		expect(decodeMysqlString("x\\n''y".repeat(2000))).toBe("x\n'y".repeat(2000));
	});
});

describe('encodeSqliteString', () => {
	it('quotes plain text', () => expect(encodeSqliteString('abc')).toBe("'abc'"));
	it('doubles a quote', () => expect(encodeSqliteString("a'b")).toBe("'a''b'"));
	it('leaves a backslash alone', () => expect(encodeSqliteString('a\\b')).toBe("'a\\b'"));
	it('turns a NUL into a cast of hex bytes', () => {
		expect(encodeSqliteString("a\0b'")).toBe("CAST(x'61006227' AS TEXT)");
	});
	it('writes a multibyte NUL value as UTF-8 bytes', () => {
		expect(encodeSqliteString('é\0')).toBe("CAST(x'c3a900' AS TEXT)");
	});
	it('encodes an empty value as two quotes', () => expect(encodeSqliteString('')).toBe("''"));
	it('keeps the stored value through decode then encode', () => {
		expect(encodeSqliteString(decodeMysqlString("it\\'s a \\\\ path"))).toBe(
			"'it''s a \\ path'"
		);
	});
});

describe('decodeStringToken', () => {
	it('strips single, double and national quotes', () => {
		expect(decodeStringToken("'a\\'b'")).toBe("a'b");
		expect(decodeStringToken('"a""b"')).toBe('a"b');
		expect(decodeStringToken("N'x'")).toBe('x');
		expect(decodeStringToken("n'it''s'")).toBe("it's");
	});
});
