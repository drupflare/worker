import { describe, expect, it } from 'vitest';
import {
	batchableShare,
	CROSSING_NAMES,
	crossingsSince,
	emptyCrossings,
	rpcMigrationCost,
	snapshotCrossings,
	wrapCrossings
} from '../../../src/ops/crossings';

describe('wrapCrossings', () => {
	it('wraps only the capabilities that are functions and counts each call', () => {
		const binary: Record<string, unknown> = {
			cfwLog: (s: string) => `${s}!`,
			cfwCanSuspend: true
		};
		const tally = emptyCrossings();
		expect(wrapCrossings(binary, tally)).toEqual(['cfwLog']);
		expect(binary.cfwCanSuspend).toBe(true);

		const log = binary.cfwLog as (s: string) => string;
		expect(log('ab')).toBe('ab!');
		log('c');
		expect(tally).toEqual({ total: 2, byName: { cfwLog: 2 } });
	});

	it('tracks string bytes and the largest reply when the tally carries a bytes field', () => {
		const binary: Record<string, unknown> = {
			cfwLog: (s: string) => s.repeat(2),
			cfwStats: (n: number) => n
		};
		const tally = emptyCrossings();
		tally.bytes = { in: 0, out: 0, maxIn: 0, maxOut: 0, maxName: '' };
		wrapCrossings(binary, tally);

		(binary.cfwLog as (s: string) => string)('abc');
		// a non-string argument and reply count as zero bytes
		(binary.cfwStats as (n: number) => number)(7);
		expect(tally.bytes).toEqual({ in: 3, out: 6, maxIn: 3, maxOut: 6, maxName: 'cfwLog' });
	});

	it('appends a census record per call when the tally is armed with an array', () => {
		const binary: Record<string, unknown> = {
			cfwSqlExec: () => JSON.stringify({ rows: [] })
		};
		const tally = emptyCrossings();
		tally.calls = [];
		wrapCrossings(binary, tally);
		(binary.cfwSqlExec as (s: string) => string)(
			JSON.stringify({ sql: 'SELECT 1', params: [] })
		);
		expect(tally.calls).toHaveLength(1);
	});

	it('wraps nothing when the module carries no capability', () => {
		expect(wrapCrossings({}, emptyCrossings())).toEqual([]);
	});
});

describe('tally arithmetic', () => {
	it('crossingsSince keeps only the names that moved', () => {
		const before = { total: 3, byName: { cfwLog: 2, cfwMail: 1 } };
		const after = { total: 7, byName: { cfwLog: 2, cfwMail: 3, cfwZlib: 2 } };
		expect(crossingsSince(before, after)).toEqual({
			total: 4,
			byName: { cfwMail: 2, cfwZlib: 2 }
		});
	});

	it('snapshotCrossings is unaffected by later mutation of the tally', () => {
		const tally = { total: 1, byName: { cfwLog: 1 } };
		const snap = snapshotCrossings(tally);
		tally.total = 9;
		tally.byName.cfwLog = 9;
		expect(snap).toEqual({ total: 1, byName: { cfwLog: 1 } });
	});

	it('batchableShare splits a tally by whether the calls could coalesce', () => {
		const share = batchableShare({ total: 4, byName: { cfwLog: 1, cfwSqlExec: 3 } });
		expect(share).toEqual({ batchable: 1, serial: 3, fraction: 0.25 });
	});

	it('batchableShare of an empty tally is zero, not NaN', () => {
		expect(batchableShare(emptyCrossings()).fraction).toBe(0);
	});

	it('rpcMigrationCost adds one billed request per crossing and clamps a negative count', () => {
		expect(rpcMigrationCost(6)).toEqual({ today: 3, overRpc: 9, factor: 3, measured: true });
		expect(rpcMigrationCost(-4, 2).overRpc).toBe(2);
	});

	it('names every capability once', () => {
		expect(new Set(CROSSING_NAMES).size).toBe(CROSSING_NAMES.length);
	});
});
