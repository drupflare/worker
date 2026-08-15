import { bindable, toPositional } from '@drupflare/durabledb/do-sqlite';
import { describe, expect, it } from 'vitest';

/**
 * Ported from `scripts/test-do-sql.mjs` (31 hand-rolled assertions).
 *
 * `ctx.storage.sql` has no named parameters, so every Drupal query has to be rewritten to
 * positional form. A naive `String.replace` corrupts a `:` inside a string literal, a
 * quoted identifier or a comment -- and Drupal emits all three -- so those are the cases
 * that carry the weight, and the control below proves they are not vacuous.
 */

describe('toPositional: basics', () => {
	it('leaves a query with no params alone', () => {
		expect(toPositional('SELECT 1', [])).toEqual({ text: 'SELECT 1', values: [] });
	});

	it('passes an already-positional query through', () => {
		expect(toPositional('SELECT ?', [5])).toEqual({ text: 'SELECT ?', values: [5] });
	});

	it('rewrites a single named placeholder', () => {
		expect(toPositional('SELECT cid FROM cache WHERE cid = :cid', { ':cid': 'x' })).toEqual({
			text: 'SELECT cid FROM cache WHERE cid = ?',
			values: ['x']
		});
	});

	it('accepts a bare key with no leading colon', () => {
		expect(toPositional('SELECT cid FROM cache WHERE cid = :cid', { cid: 'y' })).toEqual({
			text: 'SELECT cid FROM cache WHERE cid = ?',
			values: ['y']
		});
	});

	it('preserves order across several placeholders', () => {
		expect(
			toPositional('SELECT * FROM n WHERE a = :a AND b = :b AND c = :c', {
				':a': 1,
				':b': 2,
				':c': 3
			})
		).toEqual({ text: 'SELECT * FROM n WHERE a = ? AND b = ? AND c = ?', values: [1, 2, 3] });
	});

	it('handles a Drupal-style expanded IN list', () => {
		expect(
			toPositional('SELECT * FROM n WHERE nid IN (:nids__0, :nids__1)', {
				':nids__0': 7,
				':nids__1': 8
			})
		).toEqual({ text: 'SELECT * FROM n WHERE nid IN (?, ?)', values: [7, 8] });
	});
});

describe('toPositional: the cases a naive replace breaks', () => {
	it('ignores a colon inside a single-quoted literal', () => {
		expect(toPositional("SELECT * FROM n WHERE t = 'a:b' AND x = :x", { ':x': 1 })).toEqual({
			text: "SELECT * FROM n WHERE t = 'a:b' AND x = ?",
			values: [1]
		});
	});

	it("handles an escaped '' inside a literal", () => {
		expect(
			toPositional("SELECT * FROM n WHERE t = 'it''s a:b' AND x = :x", { ':x': 1 })
		).toEqual({
			text: "SELECT * FROM n WHERE t = 'it''s a:b' AND x = ?",
			values: [1]
		});
	});

	it('ignores a colon inside a double-quoted identifier', () => {
		expect(toPositional('SELECT "we:ird" FROM n WHERE x = :x', { ':x': 2 })).toEqual({
			text: 'SELECT "we:ird" FROM n WHERE x = ?',
			values: [2]
		});
	});

	it('ignores a colon inside a line comment', () => {
		expect(toPositional('SELECT 1 -- note :notaparam\nWHERE x = :x', { ':x': 3 })).toEqual({
			text: 'SELECT 1 -- note :notaparam\nWHERE x = ?',
			values: [3]
		});
	});

	it('ignores a colon inside a block comment', () => {
		expect(toPositional('SELECT /* :nope */ 1 WHERE x = :x', { ':x': 4 })).toEqual({
			text: 'SELECT /* :nope */ 1 WHERE x = ?',
			values: [4]
		});
	});

	it('does not treat a :: cast as a placeholder', () => {
		expect(toPositional('SELECT x::text FROM n', {})).toEqual({
			text: 'SELECT x::text FROM n',
			values: []
		});
	});

	it('handles a placeholder at the very end of the string', () => {
		expect(toPositional('SELECT * FROM n WHERE x = :x', { ':x': 9 })).toEqual({
			text: 'SELECT * FROM n WHERE x = ?',
			values: [9]
		});
	});

	it('binds a repeated placeholder once per occurrence', () => {
		expect(toPositional('SELECT * FROM n WHERE a = :v OR b = :v', { ':v': 5 })).toEqual({
			text: 'SELECT * FROM n WHERE a = ? OR b = ?',
			values: [5, 5]
		});
	});

	it('keeps a null binding', () => {
		expect(toPositional('SELECT * FROM n WHERE x = :x', { ':x': null })).toEqual({
			text: 'SELECT * FROM n WHERE x = ?',
			values: [null]
		});
	});

	it('does not rescan a bound value that looks like a placeholder', () => {
		expect(toPositional('SELECT * FROM n WHERE x = :x', { ':x': ':y' })).toEqual({
			text: 'SELECT * FROM n WHERE x = ?',
			values: [':y']
		});
	});

	it('refuses a missing binding rather than emitting wrong SQL', () => {
		expect(() => toPositional('SELECT :missing', { ':other': 1 })).toThrow();
	});

	// THE CONTROL. If a naive rewriter passed the literal case too, every literal-safety
	// assertion above would be proving nothing.
	it('a naive rewriter really does corrupt the literal case', () => {
		const naive = (sql: string, params: Record<string, unknown>) => {
			let text = sql;
			const values: unknown[] = [];
			for (const [k, v] of Object.entries(params)) {
				const key = k.startsWith(':') ? k : `:${k}`;
				if (text.includes(key)) {
					text = text.split(key).join('?');
					values.push(v);
				}
			}
			return { text, values };
		};
		const bad = naive("SELECT * FROM n WHERE t = 'a:b' AND x = :b", { ':b': 1 });
		expect(bad.text).not.toBe("SELECT * FROM n WHERE t = 'a:b' AND x = ?");
	});
});

/**
 * Two platform facts meet in `bindable()`. `ctx.storage.sql` refuses a BigInt outright
 * ("Cannot convert a BigInt value to a number"), AND its cursor returns INTEGER columns as
 * JS doubles, so anything above 2^53 reads back altered -- 9007199254740993 comes back as
 * ...992, measured. Converting a wide BigInt to a decimal string would store it perfectly
 * and read it back wrong with nothing raised, so it is refused at the WRITE instead.
 */
describe('bindable', () => {
	it.each([
		['a safe-range BigInt becomes a number', 1n, 1],
		['2^53-1 is the last accepted value', 9007199254740991n, 9007199254740991],
		['a negative safe-range BigInt keeps its sign', -42n, -42],
		['a plain number is untouched', 42, 42],
		['a float is untouched', 1.5, 1.5],
		// a long digit string is a legitimate TEXT value and cannot be told apart from a
		// wide integer, so it is passed through
		['a numeric string is untouched', '9007199254740993', '9007199254740993'],
		['null is untouched', null, null]
	])('%s', (_label, input, expected) => {
		const got = bindable(input);
		expect(got).toBe(expected);
		expect(typeof got).toBe(typeof expected);
	});

	it.each([
		['2^53+1', 9007199254740993n],
		['int64 max', 9223372036854775807n],
		['2^53 itself', 9007199254740992n],
		['a wide negative', -9007199254740993n]
	])('refuses %s with UnreadableIntegerError', (_label, input) => {
		expect(() => bindable(input)).toThrowError(
			expect.objectContaining({ name: 'UnreadableIntegerError' })
		);
	});

	// the control: the value really is unreadable, which is what justifies refusing it
	// rather than storing it
	it('2^53+1 does not survive a JS double, so refusing it is not superstition', () => {
		expect(Number(9007199254740993n)).toBe(9007199254740992);
	});

	it('passes a Uint8Array blob through by reference', () => {
		const blob = new Uint8Array([1, 2, 3]);
		expect(bindable(blob)).toBe(blob);
	});
});
