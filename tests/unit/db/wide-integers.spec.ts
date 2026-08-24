import { describe, expect, it } from 'vitest';
import {
	castingWrapper,
	isLossyInteger,
	mergeWide,
	repairWideIntegers,
	suspectColumns,
	wrappable,
	type Row
} from '../../../src/db/wide-integers';

describe('detecting a value a double could not hold', () => {
	it('flags an integer past 2^53 and nothing else', () => {
		expect(isLossyInteger(9_007_199_254_740_993)).toBe(true);
		expect(isLossyInteger(9_223_372_036_854_776_000)).toBe(true);
		expect(isLossyInteger(-9_007_199_254_740_993)).toBe(true);
		expect(isLossyInteger(7)).toBe(false);
		expect(isLossyInteger(Number.MAX_SAFE_INTEGER)).toBe(false);
		expect(isLossyInteger(1.5)).toBe(false);
		expect(isLossyInteger('9007199254740993')).toBe(false);
		expect(isLossyInteger(null)).toBe(false);
	});

	it('leaves a REAL alone even though Number.isInteger accepts it', () => {
		// 1e300 is an integer by that predicate and is a float in SQLite, not a truncated INTEGER.
		// Casting it would turn a number into a string for no reason
		expect(Number.isInteger(1e300)).toBe(true);
		expect(isLossyInteger(1e300)).toBe(false);
	});

	it('names every affected column and no others', () => {
		const rows: Row[] = [
			{ id: 1, big: 9_007_199_254_740_993, txt: 'a' },
			{ id: 2, big: 7, txt: 'b' }
		];
		expect(suspectColumns(rows)).toEqual(['big']);
		expect(suspectColumns([{ id: 1 }])).toEqual([]);
		expect(suspectColumns([])).toEqual([]);
	});
});

describe('the wrapper statement', () => {
	it('projects every column and casts only the suspects', () => {
		expect(castingWrapper('SELECT a, b FROM t', ['a', 'b'], ['b'])).toBe(
			'SELECT "a", CAST("b" AS TEXT) AS "b" FROM (SELECT a, b FROM t)'
		);
	});

	it('drops a trailing semicolon, which is a syntax error inside a subquery', () => {
		expect(castingWrapper('SELECT a FROM t;  ', ['a'], ['a'])).toBe(
			'SELECT CAST("a" AS TEXT) AS "a" FROM (SELECT a FROM t)'
		);
	});

	it('doubles a quote inside a column name', () => {
		expect(castingWrapper('SELECT 1', ['we"ird'], ['we"ird'])).toContain('"we""ird"');
	});

	it('accepts what it can wrap and refuses what it cannot', () => {
		expect(wrappable('SELECT 1')).toBe(true);
		expect(wrappable('  select a from t')).toBe(true);
		expect(wrappable('-- a note\nSELECT 1')).toBe(true);
		expect(wrappable('/* block */ SELECT 1')).toBe(true);
		expect(wrappable('VALUES (1)')).toBe(true);
		expect(wrappable('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(false);
		expect(wrappable('PRAGMA table_info(t)')).toBe(false);
		expect(wrappable('UPDATE t SET a = 1')).toBe(false);
	});
});

describe('merging the exact digits back', () => {
	it('replaces by position and only the suspect columns', () => {
		const rows: Row[] = [{ big: 9_007_199_254_740_992, txt: 'a' }];
		const merged = mergeWide(rows, [{ big: '9007199254740993', txt: 'a' }], ['big']);
		expect(merged[0]?.big).toBe('9007199254740993');
		expect(merged[0]?.txt).toBe('a');
	});

	it('REFUSES on a length mismatch rather than pairing the wrong rows', () => {
		const rows: Row[] = [{ big: 1 }, { big: 2 }];
		expect(mergeWide(rows, [{ big: '99' }], ['big'])).toBe(rows);
	});
});

describe('the whole repair', () => {
	it('re-reads once and reports what it fixed', () => {
		const asked: string[] = [];
		const out = repairWideIntegers(
			'SELECT big FROM w',
			[{ big: 9_007_199_254_740_992 }],
			(wrapped) => {
				asked.push(wrapped);
				return [{ big: '9007199254740993' }];
			}
		);
		expect(asked).toEqual(['SELECT CAST("big" AS TEXT) AS "big" FROM (SELECT big FROM w)']);
		expect(out.rows[0]?.big).toBe('9007199254740993');
		expect(out.repair).toEqual({ columns: ['big'], rows: 1 });
	});

	it('never re-reads when nothing is wide', () => {
		let calls = 0;
		const out = repairWideIntegers('SELECT a FROM t', [{ a: 7 }], () => {
			calls++;
			return [];
		});
		expect(calls).toBe(0);
		expect(out.repair).toBeNull();
	});

	it('never re-reads a statement it cannot wrap', () => {
		let calls = 0;
		const out = repairWideIntegers(
			'WITH x AS (SELECT 1) SELECT big FROM x',
			[{ big: 9_007_199_254_740_992 }],
			() => {
				calls++;
				return [];
			}
		);
		expect(calls).toBe(0);
		expect(out.repair).toBeNull();
	});

	it('keeps the lossy value when the re-read throws, because this is the serving path', () => {
		const out = repairWideIntegers(
			'SELECT big FROM w',
			[{ big: 9_007_199_254_740_992 }],
			() => {
				throw new Error('no such column');
			}
		);
		expect(out.repair).toBeNull();
		expect(out.rows[0]?.big).toBe(9_007_199_254_740_992);
	});
});
