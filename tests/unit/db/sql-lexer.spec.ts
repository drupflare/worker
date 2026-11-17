import { describe, expect, it } from 'vitest';
import {
	matchingParen,
	splitStatements,
	tokenize,
	utf8Length,
	type Token
} from '../../../src/db/sql/lexer';

/** every token as "type:text", whitespace left out unless asked for */
function lex(sql: string, trivia = false): string[] {
	return tokenize(sql)
		.filter((t) => trivia || t.type !== 'whitespace')
		.map((t) => `${t.type}:${t.text}`);
}

/** whether every slice matches and the texts concatenate to the input */
function contractHolds(sql: string): boolean {
	let joined = '';
	let expected = 0;
	for (const t of tokenize(sql)) {
		if (
			t.offset !== expected ||
			t.length !== t.text.length ||
			t.length < 1 ||
			sql.slice(t.offset, t.offset + t.length) !== t.text
		) {
			return false;
		}
		expected += t.length;
		joined += t.text;
	}
	return joined === sql && expected === sql.length;
}

describe('whitespace, identifiers and punctuation', () => {
	it('lexes a select list into words and commas', () => {
		expect(lex('SELECT a, b FROM t')).toEqual([
			'identifier:SELECT',
			'identifier:a',
			'punct:,',
			'identifier:b',
			'identifier:FROM',
			'identifier:t'
		]);
	});

	it('makes every whitespace byte class one whitespace token', () => {
		expect(lex(' \t\n\r\f\v', true)).toEqual(['whitespace: \t\n\r\f\v']);
	});

	it('continues an identifier on dollar, underscore and non-ASCII characters', () => {
		expect(lex('wp_a$b caf\u00e9')).toEqual(['identifier:wp_a$b', 'identifier:caf\u00e9']);
	});

	it('does not treat a no-break space as whitespace', () => {
		expect(lex('a\u00a0b', true)).toEqual(['identifier:a\u00a0b']);
	});

	it('makes a dot between names punctuation', () => {
		expect(lex('wp.posts.ID')).toEqual([
			'identifier:wp',
			'punct:.',
			'identifier:posts',
			'punct:.',
			'identifier:ID'
		]);
	});

	it('makes parentheses, semicolons and braces punctuation', () => {
		expect(lex('(a);{b}')).toEqual([
			'punct:(',
			'identifier:a',
			'punct:)',
			'punct:;',
			'punct:{',
			'identifier:b',
			'punct:}'
		]);
	});
});

describe('quoted identifiers', () => {
	it('lexes a backtick identifier as one token', () => {
		expect(lex('`post_title`')).toEqual(['quoted_identifier:`post_title`']);
	});

	it('keeps a doubled backtick inside the identifier', () => {
		expect(lex('`a``b` x')).toEqual(['quoted_identifier:`a``b`', 'identifier:x']);
	});

	it('keeps a semicolon inside backticks out of the punctuation', () => {
		expect(lex('`a;b`')).toEqual(['quoted_identifier:`a;b`']);
	});

	it('takes a backslash literally inside backticks', () => {
		expect(lex('`a\\` b')).toEqual(['quoted_identifier:`a\\`', 'identifier:b']);
	});

	it('makes an unterminated backtick one error to the end', () => {
		expect(lex('a `bc d')).toEqual(['identifier:a', 'error:`bc d']);
	});
});

describe('strings', () => {
	it('lexes a single quoted string as one token', () => {
		expect(lex("'hello world'")).toEqual(["string:'hello world'"]);
	});

	it('lexes a double quoted string as a string, as in the default sql_mode', () => {
		expect(lex('"abc"')).toEqual(['string:"abc"']);
	});

	it('keeps a doubled quote inside the string', () => {
		expect(lex("'it''s' x")).toEqual(["string:'it''s'", 'identifier:x']);
		expect(lex('"a""b" x')).toEqual(['string:"a""b"', 'identifier:x']);
	});

	it('does not end a string on a backslash quote', () => {
		expect(lex("'a\\'b' x")).toEqual(["string:'a\\'b'", 'identifier:x']);
		expect(lex('"a\\"b" x')).toEqual(['string:"a\\"b"', 'identifier:x']);
	});

	it('lets the quote after an escaped backslash end the string', () => {
		expect(lex("'a\\\\' x")).toEqual(["string:'a\\\\'", 'identifier:x']);
	});

	it('keeps semicolons and comment markers inside a string as text', () => {
		expect(lex("'a; -- b # c /* d */'")).toEqual(["string:'a; -- b # c /* d */'"]);
	});

	it('lexes an empty string as a string', () => {
		expect(lex("''")).toEqual(["string:''"]);
	});

	it('makes an unterminated string one error to the end', () => {
		expect(lex("a 'bc d")).toEqual(['identifier:a', "error:'bc d"]);
	});

	it('makes a string that ends in a lone backslash an error', () => {
		expect(lex("'abc\\")).toEqual(["error:'abc\\"]);
	});

	it('gives a national string its own class', () => {
		expect(lex("N'abc' n'd'")).toEqual(["national_string:N'abc'", "national_string:n'd'"]);
		expect(lex('N x')).toEqual(['identifier:N', 'identifier:x']);
	});

	it('lexes a charset introducer as an identifier then a string', () => {
		expect(lex("_utf8mb4'x'")).toEqual(['identifier:_utf8mb4', "string:'x'"]);
	});

	it('lexes a 5000 character string as one token', () => {
		const tokens = tokenize(`SELECT '${'q'.repeat(5000)}' FROM t`);
		expect(tokens).toHaveLength(7);
		expect((tokens[2] as Token).length).toBe(5002);
		expect((tokens[2] as Token).offset).toBe(7);
	});

	it('lexes a long string full of doubled quotes and escapes as one token', () => {
		const literal = `'${"a''b\\'c;".repeat(700)}'`;
		const tokens = tokenize(`${literal};`);
		expect(tokens).toHaveLength(2);
		expect((tokens[0] as Token).length).toBe(literal.length);
		expect(contractHolds(`${literal}${"'" + 'q'.repeat(5000) + "'"}`)).toBe(true);
	});
});

describe('comments', () => {
	it('needs whitespace after the dashes of a dash comment', () => {
		expect(lex('SELECT 1 -- note\nFROM t')).toEqual([
			'identifier:SELECT',
			'number:1',
			'comment:-- note',
			'identifier:FROM',
			'identifier:t'
		]);
		expect(lex('5--1')).toEqual(['number:5', 'operator:-', 'operator:-', 'number:1']);
		expect(lex('a --')).toEqual(['identifier:a', 'comment:--']);
		expect(lex('a --\tx\nb')).toEqual(['identifier:a', 'comment:--\tx', 'identifier:b']);
	});

	it('runs a hash comment to the end of the line', () => {
		expect(lex("a # x ' y\nb")).toEqual(['identifier:a', "comment:# x ' y", 'identifier:b']);
	});

	it('lexes a block comment as one token, across lines too', () => {
		expect(lex('a /* x; y */ b')).toEqual([
			'identifier:a',
			'comment:/* x; y */',
			'identifier:b'
		]);
		expect(lex('/* a\nb */x')).toEqual(['comment:/* a\nb */', 'identifier:x']);
	});

	it('starts the star slash search after the opener', () => {
		expect(lex('/*/ x */ y')).toEqual(['comment:/*/ x */', 'identifier:y']);
	});

	it('treats a bang or MariaDB comment as executable and an optimizer hint as plain', () => {
		expect(lex('/*!40101 SET x=1 */')).toEqual(['executable_comment:/*!40101 SET x=1 */']);
		expect(lex('/*M!100100 x */')).toEqual(['executable_comment:/*M!100100 x */']);
		expect(lex('/*+ NO_RANGE_OPTIMIZATION(t) */')).toEqual([
			'comment:/*+ NO_RANGE_OPTIMIZATION(t) */'
		]);
	});

	it('makes an unterminated block comment one error to the end', () => {
		expect(lex('a /* b')).toEqual(['identifier:a', 'error:/* b']);
	});

	it('lexes a lone slash as an operator', () => {
		expect(lex('a / b')).toEqual(['identifier:a', 'operator:/', 'identifier:b']);
	});
});

describe('numbers, hex and bit values', () => {
	it('lexes integers and decimals', () => {
		expect(lex('1 22 3.5 4. .5')).toEqual([
			'number:1',
			'number:22',
			'number:3.5',
			'number:4.',
			'number:.5'
		]);
	});

	it('lexes exponents with and without a sign', () => {
		expect(lex('1e5 2E+3 4.5e-6 .5E2')).toEqual([
			'number:1e5',
			'number:2E+3',
			'number:4.5e-6',
			'number:.5E2'
		]);
	});

	it('does not read an e without digits as an exponent', () => {
		expect(lex('1e')).toEqual(['identifier:1e']);
	});

	it('reads digits that run into letters as an identifier', () => {
		expect(lex('12abc 1ea')).toEqual(['identifier:12abc', 'identifier:1ea']);
	});

	it('makes a leading dot after a name punctuation', () => {
		expect(lex('t.5')).toEqual(['identifier:t', 'punct:.', 'number:5']);
	});

	it('lexes 0x and X quote hex literals', () => {
		expect(lex('0xDEADbeef')).toEqual(['hex:0xDEADbeef']);
		expect(lex("X'ff00' x'AB' X''")).toEqual(["hex:X'ff00'", "hex:x'AB'", "hex:X''"]);
	});

	it('makes a bad X quote body an error through the closing quote', () => {
		expect(lex("X'zz' a")).toEqual(["error:X'zz'", 'identifier:a']);
		expect(lex("X'ab")).toEqual(["error:X'ab"]);
	});

	it('lexes 0b and b quote bit literals', () => {
		expect(lex('0b1011')).toEqual(['bit:0b1011']);
		expect(lex("b'101' B'0'")).toEqual(["bit:b'101'", "bit:B'0'"]);
		expect(lex("b'12'")).toEqual(["error:b'12'"]);
	});

	it('reads a 0x with no digits, or with letters after them, as an identifier', () => {
		expect(lex('0xzz')).toEqual(['identifier:0xzz']);
		expect(lex('0x1Fg')).toEqual(['identifier:0x1Fg']);
		expect(lex('x')).toEqual(['identifier:x']);
	});
});

describe('variables and placeholders', () => {
	it('lexes user and system variables', () => {
		expect(lex('@a')).toEqual(['variable:@a']);
		expect(lex('@@global.sql_mode')).toEqual(['variable:@@global.sql_mode']);
		expect(lex('@\'a b\' @`c` @"d"')).toEqual([
			"variable:@'a b'",
			'variable:@`c`',
			'variable:@"d"'
		]);
	});

	it('keeps the variable and the operator of an assignment apart', () => {
		expect(lex('@a:=1')).toEqual(['variable:@a', 'operator::=', 'number:1']);
	});

	it('makes an at sign with no name an error', () => {
		expect(lex('@ @@')).toEqual(['error:@', 'error:@@']);
		expect(lex("@'abc")).toEqual(["error:@'abc"]);
	});

	it('treats a question mark as an operator byte and a colon name as two tokens', () => {
		expect(lex('a = ?')).toEqual(['identifier:a', 'operator:=', 'operator:?']);
		expect(lex(':name')).toEqual(['operator::', 'identifier:name']);
	});
});

describe('operators', () => {
	it('lexes the multi-byte operators', () => {
		expect(lex('<=> <> != <= >= || && << >> := -> ->>')).toEqual([
			'operator:<=>',
			'operator:<>',
			'operator:!=',
			'operator:<=',
			'operator:>=',
			'operator:||',
			'operator:&&',
			'operator:<<',
			'operator:>>',
			'operator::=',
			'operator:->',
			'operator:->>'
		]);
	});

	it('lexes the one-byte operators', () => {
		expect(lex('+ - * / % = < > ! & | ^ ~ :')).toEqual(
			'+ - * / % = < > ! & | ^ ~ :'.split(' ').map((o) => `operator:${o}`)
		);
	});

	it('prefers a longer operator over a shorter prefix', () => {
		expect(lex('a<=>b a<=b')).toEqual([
			'identifier:a',
			'operator:<=>',
			'identifier:b',
			'identifier:a',
			'operator:<=',
			'identifier:b'
		]);
	});

	it('lets a json path operator take a string', () => {
		expect(lex("c->'$.a'")).toEqual(['identifier:c', 'operator:->', "string:'$.a'"]);
	});
});

describe('malformed and binary input', () => {
	it('makes a backslash, a square bracket or a NUL outside a string an error', () => {
		expect(lex('a \\ b')).toEqual(['identifier:a', 'error:\\', 'identifier:b']);
		expect(lex('[a]')).toEqual(['error:[', 'identifier:a', 'error:]']);
		expect(lex('a\0b')).toEqual(['identifier:a', 'error:\0', 'identifier:b']);
	});

	it('keeps a NUL inside a string in the string', () => {
		expect(lex("'a\0b'")).toEqual(["string:'a\0b'"]);
	});

	it('lexes and round-trips every code unit below 256', () => {
		let binary = '';
		for (let c = 0; c < 256; c++) binary += String.fromCharCode(c);
		expect(contractHolds(binary)).toBe(true);
		const quoted = `'${binary.replace(/['\\]/g, '')}'`;
		expect(tokenize(quoted)).toHaveLength(1);
	});

	it('gives an empty input no tokens', () => {
		expect(tokenize('')).toEqual([]);
	});

	it('gives a token a type, offset, length and text', () => {
		expect(tokenize("SELECT 'a'")[2]).toEqual({
			type: 'string',
			offset: 7,
			length: 3,
			text: "'a'"
		});
	});

	it('never throws and always round-trips on 3000 seeded random inputs', () => {
		let seed = 20261116;
		const next = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed;
		};
		const alphabet = 'abc019 \t\n\'"`\\/*-#!@.;(),:?<>=|&+0xXbBnN_$\0\u0080\u00ff\ud83d\ude00';
		const chars = [...alphabet];
		for (let round = 0; round < 3000; round++) {
			let input = '';
			const size = next() % 41;
			for (let k = 0; k < size; k++) input += chars[next() % chars.length];
			expect(contractHolds(input), JSON.stringify(input)).toBe(true);
		}
	});
});

describe('round trip over realistic statements', () => {
	const statements = [
		"SELECT SQL_CALC_FOUND_ROWS wp_posts.ID FROM wp_posts WHERE 1=1 AND wp_posts.post_type = 'post' AND ((wp_posts.post_status = 'publish')) GROUP BY wp_posts.ID ORDER BY wp_posts.post_date DESC LIMIT 0, 10",
		"INSERT INTO `wp_options` (`option_name`, `option_value`, `autoload`) VALUES ('a', 'b\\'c;d', 'yes') ON DUPLICATE KEY UPDATE `option_name` = VALUES(`option_name`)",
		"SELECT * FROM wp_postmeta WHERE meta_value LIKE '%\\_x\\%%' -- trailing\n# another\n/* block */",
		"SET @@session.sql_mode = 'NO_ZERO_DATE', @x := 0x1F, @y = b'101', @z = 1.5e3",
		"/*!40101 SET NAMES utf8mb4 */; SELECT N'\u00e9' <=> X'ff'"
	];

	it('keeps exact offsets for each statement', () => {
		for (const statement of statements) expect(contractHolds(statement)).toBe(true);
	});

	it('finds no error token in a real post query', () => {
		expect(tokenize(statements[0] as string).filter((t) => t.type === 'error')).toEqual([]);
	});
});

describe('byte offsets on multi-byte text', () => {
	const sql = "SELECT 'caf\u00e9 \u20ac \ud83d\ude00', \u00e9t\u00e9 FROM t";

	it('counts offsets in UTF-16 code units, so a slice equals the text', () => {
		expect(contractHolds(sql)).toBe(true);
	});

	it('turns a code unit offset into the UTF-8 byte offset', () => {
		const bytes = new TextEncoder();
		for (const t of tokenize(sql)) {
			expect(utf8Length(sql, t.offset)).toBe(bytes.encode(sql.slice(0, t.offset)).length);
			expect(utf8Length(t.text)).toBe(bytes.encode(t.text).length);
		}
		const from = tokenize(sql).find((t) => t.text === 'FROM') as Token;
		expect(utf8Length(sql, from.offset)).toBe(from.offset + 2 + 1 + 2 + 2);
		expect(utf8Length('a\ud800b')).toBe(5);
	});

	it('reads a high surrogate after a backslash as one escaped unit', () => {
		expect(lex("'a\\\ud83d\ude00'")).toEqual(["string:'a\\\ud83d\ude00'"]);
		expect(lex("'a\\\ud83d")).toEqual(["error:'a\\\ud83d"]);
	});
});

describe('splitting statements', () => {
	it('splits at top-level semicolons', () => {
		expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
		expect(splitStatements('a; b')).toEqual(['a', 'b']);
	});

	it('does not split on a semicolon inside a string, a backtick name or a comment', () => {
		expect(splitStatements("INSERT INTO t VALUES ('a;b', `c;d`) /* e;f */; SELECT 2")).toEqual([
			"INSERT INTO t VALUES ('a;b', `c;d`)",
			'SELECT 2'
		]);
	});

	it('drops a comment and leaves a space so neighbours do not fuse', () => {
		expect(splitStatements('SELECT/* x */1;')).toEqual(['SELECT 1']);
	});

	it('keeps an executable comment', () => {
		expect(splitStatements('/*!40101 SET x=1 */; SELECT 1')).toEqual([
			'/*!40101 SET x=1 */',
			'SELECT 1'
		]);
	});

	it('drops empty statements', () => {
		expect(splitStatements(' ;; \n ; ')).toEqual([]);
	});

	it('keeps the rest as one statement after an unterminated string', () => {
		expect(splitStatements("SELECT 'a; SELECT 2")).toEqual(["SELECT 'a; SELECT 2"]);
	});

	it('keeps an error token in the statement text', () => {
		expect(splitStatements('SELECT \\ 1; SELECT 2')).toEqual(['SELECT \\ 1', 'SELECT 2']);
	});

	it('trims only the six whitespace bytes MySQL knows', () => {
		expect(splitStatements('\u00a0a\u00a0;')).toEqual(['\u00a0a\u00a0']);
	});
});

describe('matching parentheses', () => {
	it('finds the close of a nested call and of an inner pair', () => {
		const tokens = tokenize('f(a, (b), g(c)) x');
		expect(matchingParen(tokens, 1)).toBe(14);
		expect(matchingParen(tokens, 5)).toBe(7);
	});

	it('ignores a parenthesis in a trailing string comment', () => {
		const tokens = tokenize(
			"CREATE TABLE r (a int) ENGINE=InnoDB COMMENT='Maps (access, page and title)'"
		);
		expect(matchingParen(tokens, 6)).toBe(10);
	});

	it('ignores parentheses inside strings, backticks and comments', () => {
		expect(matchingParen(tokenize("(')' `)` /* ) */ # )\n)"), 0)).toBe(9);
	});

	it('answers -1 for an unclosed, non-parenthesis, out-of-range or string start', () => {
		expect(matchingParen(tokenize('(a (b)'), 0)).toBe(-1);
		expect(matchingParen(tokenize('a (b)'), 0)).toBe(-1);
		expect(matchingParen(tokenize('(a)'), 9)).toBe(-1);
		expect(matchingParen(tokenize("'(' )"), 0)).toBe(-1);
	});
});
