import { describe, expect, it } from 'vitest';
import { bindIntegers, isWholeNumber } from '../../../src/db/integer-bindings';

const CAST = '+CAST(? AS INTEGER)';

describe('which values are rewritten', () => {
	it('takes a safe integer and a BigInt inside the safe range, and nothing else', () => {
		expect(isWholeNumber(0)).toBe(true);
		expect(isWholeNumber(-7)).toBe(true);
		expect(isWholeNumber(9n)).toBe(true);
		expect(isWholeNumber(Number.MAX_SAFE_INTEGER)).toBe(true);
		expect(isWholeNumber(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
		expect(isWholeNumber(2n ** 60n)).toBe(false);
		expect(isWholeNumber(1.5)).toBe(false);
		expect(isWholeNumber(Number.NaN)).toBe(false);
		expect(isWholeNumber('0')).toBe(false);
		expect(isWholeNumber(null)).toBe(false);
		expect(isWholeNumber(true)).toBe(false);
	});
});

describe('bindIntegers', () => {
	it('leaves a statement alone when nothing bound is a whole number', () => {
		const text = 'SELECT * FROM t WHERE a = ? AND b = ?';
		expect(bindIntegers(text, ['x', 1.5])).toBe(text);
		expect(bindIntegers(text, [])).toBe(text);
	});

	it('rewrites each placeholder by position, keeping the ones bound to other types', () => {
		expect(bindIntegers('SELECT * FROM t WHERE a = ? AND b = ? AND c = ?', [0, 'x', 7])).toBe(
			`SELECT * FROM t WHERE a = ${CAST} AND b = ? AND c = ${CAST}`
		);
	});

	it('covers an IN list, LIMIT and OFFSET, an INSERT and an UPDATE', () => {
		expect(
			bindIntegers('SELECT 1 FROM t WHERE a IN (?, ?) LIMIT ? OFFSET ?', [1, 2, 3, 4])
		).toBe(`SELECT 1 FROM t WHERE a IN (${CAST}, ${CAST}) LIMIT ${CAST} OFFSET ${CAST}`);
		expect(bindIntegers('INSERT INTO t (a, b) VALUES (?, ?)', [0, 'x'])).toBe(
			`INSERT INTO t (a, b) VALUES (${CAST}, ?)`
		);
		expect(bindIntegers('UPDATE t SET n = n + ? WHERE id = ?', [1, 5])).toBe(
			`UPDATE t SET n = n + ${CAST} WHERE id = ${CAST}`
		);
	});

	it('does not touch a question mark inside a literal, a quoted name or a comment', () => {
		expect(
			bindIntegers(
				'SELECT \'?\', "a?b", `c?d` FROM t WHERE a = ? -- why?\n AND b = ?',
				[1, 2]
			)
		).toBe(`SELECT '?', "a?b", \`c?d\` FROM t WHERE a = ${CAST} -- why?\n AND b = ${CAST}`);
		expect(bindIntegers('SELECT /* is it? */ a FROM t WHERE a = ?', [1])).toBe(
			`SELECT /* is it? */ a FROM t WHERE a = ${CAST}`
		);
		expect(bindIntegers("SELECT 'it''s ?' FROM t WHERE a = ?", [1])).toBe(
			`SELECT 'it''s ?' FROM t WHERE a = ${CAST}`
		);
	});

	it('leaves a numbered placeholder alone, which it cannot place by position', () => {
		expect(bindIntegers('SELECT ?1, ?2 FROM t WHERE a = ?', [1, 2, 3])).toBe(
			`SELECT ?1, ?2 FROM t WHERE a = ${CAST}`
		);
	});

	it('handles an unterminated literal without looping', () => {
		expect(bindIntegers("SELECT 'oops ? WHERE a = ?", [1])).toBe("SELECT 'oops ? WHERE a = ?");
	});
});
