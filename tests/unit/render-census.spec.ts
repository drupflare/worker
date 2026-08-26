import { describe, expect, it } from 'vitest';
import {
	CFW_PAGE_CHARGED_ROWS,
	keyRepeats,
	NOTHING,
	removalFor,
	scoreLever,
	shapeRepeats,
	spread
} from '../../scripts/measure/render-census';
import { census, type CensusCall } from '../../src/ops/statement-census';

/**
 * The arithmetic `scripts/measure/render-census.ts` does once it has a reading.
 *
 * The driver itself needs the pack and the shipping interpreter, so it lives in `ARTIFACT_SPECS` and
 * every line of the scoring would go uncovered with it. These are the gate lane's copy: fabricated
 * censuses, no PHP, same functions.
 *
 * THE ONE CLAIM WORTH A TEST OF ITS OWN is that three of a removal's four columns are not meters.
 * A statement is a wasm import inside an invocation the object already paid for, rows READ have an
 * allowance 50x the write one, and result bytes are CPU. Scoring a lever that removes thirty
 * statements as a win is the failure this file exists to make impossible.
 */

const call = (over: Partial<CensusCall> = {}): CensusCall => ({
	name: 'cfwSqlExec',
	fingerprint: 'SELECT ? FROM "cache_render" WHERE "cid" IN (?)',
	table: 'cache_render',
	rowsRead: 0,
	rowsWritten: 0,
	rows: 0,
	resultBytes: 0,
	viaTxn: false,
	key: null,
	...over
});

describe('scoring a lever against the two ceilings', () => {
	it('moves NEITHER ceiling for a lever that removes statements, reads and bytes', () => {
		const s = scoreLever(
			'all the statements',
			{
				statements: 30,
				rowsRead: 500,
				rowsWritten: 0,
				resultBytes: 1_000_000
			},
			9
		);
		expect(s.moves).toBe('neither');
		expect(s.regeneration.after).toBe(s.regeneration.before);
		expect(s.serving.after).toBe(s.serving.before);
	});

	it('moves the REGENERATION ceiling for a lever that removes charged rows', () => {
		const s = scoreLever('the bin', { ...NOTHING, rowsWritten: 6 }, 9);
		expect(s.moves).toBe('regeneration');
		expect(s.rowsPerFill).toEqual({ before: 9, after: 3 });
		expect(s.regeneration.after).toBeGreaterThan(s.regeneration.before);
		// the serving ceiling is bound by Worker requests, which a row cannot touch
		expect(s.serving.after).toBe(s.serving.before);
	});

	it('never divides by zero, however much a lever claims to remove', () => {
		const s = scoreLever('everything', { ...NOTHING, rowsWritten: 9_999 }, 9);
		expect(s.rowsPerFill.after).toBe(1);
		expect(Number.isFinite(s.regeneration.after)).toBe(true);
	});

	it('scores a zero removal as changing nothing rather than as an error', () => {
		const s = scoreLever('prepared statements', { ...NOTHING }, 9);
		expect(s.moves).toBe('neither');
		expect(s.rowsPerFill).toEqual({ before: 9, after: 9 });
	});
});

describe('reading a removal off a census', () => {
	it('sums the rows a predicate selects and nothing else', () => {
		const c = census([
			call({
				fingerprint: 'DELETE FROM "cache_dynamic_page_cache"',
				table: 'cache_dynamic_page_cache',
				rowsWritten: 2,
				resultBytes: 82
			}),
			call({
				fingerprint: 'INSERT INTO "cache_dynamic_page_cache" VALUES (?)',
				table: 'cache_dynamic_page_cache',
				rowsWritten: 4,
				resultBytes: 164
			}),
			call({ table: 'cache_render', rowsRead: 17, resultBytes: 16_612 })
		]);
		expect(removalFor(c, (r) => r.table === 'cache_dynamic_page_cache')).toEqual({
			statements: 2,
			rowsRead: 0,
			rowsWritten: 6,
			resultBytes: 246
		});
	});

	it('answers a zero removal when the predicate matches nothing', () => {
		const c = census([call({ rowsRead: 3 })]);
		expect(removalFor(c, (r) => r.table === 'watchdog')).toEqual(NOTHING);
	});
});

describe('separating a batchable repeat from a redundant one', () => {
	/** one fingerprint run `keys.length` times, one execution per cid */
	const overCids = (keys: string[]) =>
		census(keys.map((key) => call({ key, rows: 1, rowsRead: 4, resultBytes: 100 })));

	it('calls repeats over DIFFERENT cids batchable, and removes no rows or bytes for them', () => {
		const c = overCids(['a', 'b', 'c', 'd', 'e', 'f']);
		// six reads of six cids collapse to one `getMultiple`, so five statements go and the
		// same 24 rows are still read and the same 600 bytes still come back
		expect(shapeRepeats(c)).toEqual({ ...NOTHING, statements: 5 });
		expect(keyRepeats(c)).toEqual(NOTHING);
	});

	it('calls a repeat of the SAME cid redundant, and prorates its rows off', () => {
		const c = census([
			call({ key: 'a', rows: 1, rowsRead: 2, rowsWritten: 2, resultBytes: 100 }),
			call({ key: 'a', rows: 1, rowsRead: 2, rowsWritten: 2, resultBytes: 100 })
		]);
		expect(keyRepeats(c)).toEqual({
			statements: 1,
			rowsRead: 2,
			rowsWritten: 2,
			resultBytes: 100
		});
		// and it is NOT also counted as batchable; the two answer disjoint questions
		expect(shapeRepeats(c)).toEqual({ ...NOTHING, statements: 0 });
	});

	it('counts every repeat of a keyless statement as batchable, since it cannot tell', () => {
		// a bare `DELETE FROM x` or a lookup bound on an integer carries no cid, so there is
		// nothing to compare and calling any of it redundant would be a guess
		const c = census([call({ key: null }), call({ key: null }), call({ key: null })]);
		expect(shapeRepeats(c).statements).toBe(2);
		expect(keyRepeats(c)).toEqual(NOTHING);
	});

	it('leaves a fingerprint that ran once out of both', () => {
		const c = overCids(['only']);
		expect(shapeRepeats(c)).toEqual(NOTHING);
		expect(keyRepeats(c)).toEqual(NOTHING);
	});
});

describe('the spread a figure is quoted with', () => {
	it('reports min, max and n rather than a bare average', () => {
		expect(spread([15, 15, 16])).toEqual({ min: 15, max: 16, n: 3 });
	});

	it('collapses to one value when every run agreed', () => {
		expect(spread([7, 7, 7])).toEqual({ min: 7, max: 7, n: 3 });
	});
});

describe('the cfw_page charge', () => {
	it('is the schema factor for a TEXT primary key, which is not the rowid', () => {
		// one stored row plus one index entry. Named as a constant rather than measured because
		// on the shipped pack a fill stores no page at all, so there is nothing to read it off
		expect(CFW_PAGE_CHARGED_ROWS).toBe(2);
	});
});
