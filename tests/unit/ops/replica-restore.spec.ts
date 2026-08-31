import { describe, expect, it } from 'vitest';
import {
	MAX_BOUND_PARAMS,
	chunkRefusal,
	planRestore,
	restoreStatements,
	type RestoreChunk
} from '../../../src/ops/replica-restore';

/**
 * What a bulk copy carries, and what it refuses.
 *
 * The two directions are asymmetric and both are asserted: a table the classifier calls
 * local or side-effecting is never copied, while a table it cannot classify IS copied and named. The
 * second is the opposite of the request-time rule, because a missing row on a replica has no error
 * attached to it and a surplus one does.
 */

const SCHEMA = 'pack-7';

function chunk(over: Partial<RestoreChunk> = {}): RestoreChunk {
	return {
		generation: 12,
		schemaVersion: SCHEMA,
		table: 'key_value',
		columns: ['collection', 'name', 'value'],
		rows: [['state', 'system.private_key', 'k']],
		...over
	};
}

describe('which tables a restore copies', () => {
	it('never copies state the replica owns itself', () => {
		const plan = planRestore(['cfw_page', 'cache_config', 'cachetags', '_cf_KV']);
		expect(plan.every((t) => !t.copy)).toBe(true);
		expect(plan.map((t) => t.status)).toEqual([
			'LOCAL_EPHEMERAL',
			'LOCAL_EPHEMERAL',
			'LOCAL_EPHEMERAL',
			'LOCAL_EPHEMERAL'
		]);
	});

	it('never copies an outbound effect', () => {
		const [mail] = planRestore(['cfw_mail_queue']);
		expect(mail?.copy).toBe(false);
		expect(mail?.status).toBe('PRIMARY_ONLY_SIDE_EFFECT');
	});

	it('copies authoritative and derived state', () => {
		const plan = planRestore(['config', 'sequences', 'router']);
		expect(plan.every((t) => t.copy)).toBe(true);
	});

	it('copies an unclassified table and says so', () => {
		// the opposite of the request-time rule. A replica missing this table would fail wherever it
		// is read, with nothing naming the restore as the cause
		const [unknown] = planRestore(['some_contrib_thing']);
		expect(unknown?.status).toBe('UNKNOWN');
		expect(unknown?.copy).toBe(true);
		expect(unknown?.reason).toContain('unclassified');
	});

	it("skips sqlite's own bookkeeping and anything not an identifier", () => {
		const plan = planRestore(['sqlite_sequence', 'drop table x']);
		expect(plan.map((t) => t.copy)).toEqual([false, false]);
	});
});

describe('what a chunk must satisfy before it lands', () => {
	it('accepts a well-formed first chunk', () => {
		expect(chunkRefusal(chunk({ first: true }), SCHEMA, null)).toBeNull();
	});

	it('refuses a table the plan would not copy', () => {
		expect(chunkRefusal(chunk({ table: 'cfw_page' }), SCHEMA, null)).toContain('not copyable');
	});

	it('refuses a column that is not an identifier', () => {
		const bad = chunk({ columns: ['collection', 'name", "x'], rows: [['a', 'b']] });
		expect(chunkRefusal(bad, SCHEMA, null)).toContain('not an identifier');
	});

	it('refuses a row of the wrong width', () => {
		expect(chunkRefusal(chunk({ rows: [['a', 'b']] }), SCHEMA, null)).toContain('wrong width');
	});

	it('refuses more columns than the driver can bind', () => {
		const wide = Array.from({ length: MAX_BOUND_PARAMS + 1 }, (_, i) => `c${i}`);
		const refusal = chunkRefusal(chunk({ columns: wide, rows: [] }), SCHEMA, null);
		expect(refusal).toContain('bound-parameter limit');
	});

	it('refuses a schema the replica does not hold', () => {
		expect(chunkRefusal(chunk(), 'pack-8', null)).toContain('schema mismatch');
		expect(chunkRefusal(chunk(), null, null)).toContain('schema mismatch');
	});

	it('refuses a chunk read at a different generation from the one that began the copy', () => {
		// THE TORN COPY. Table A at 12 and table B at 13 is a state the primary was never in, and no
		// generation number on the replica afterwards would describe it
		expect(chunkRefusal(chunk({ generation: 13 }), SCHEMA, 12)).toContain('torn copy');
		expect(chunkRefusal(chunk({ generation: 12 }), SCHEMA, 12)).toBeNull();
	});

	it('refuses a generation that is not a number', () => {
		expect(chunkRefusal(chunk({ generation: Number.NaN }), SCHEMA, null)).toContain(
			'not a number'
		);
	});
});

describe('the statements a chunk becomes', () => {
	it('clears the table only on the first chunk', () => {
		const first = restoreStatements(chunk({ first: true }));
		expect(first[0]?.sql).toBe('DELETE FROM "key_value"');
		expect(restoreStatements(chunk())[0]?.sql).toContain('INSERT');
	});

	it('inserts one row per statement, in column order', () => {
		const rows = [
			['state', 'a', '1'],
			['state', 'b', '2']
		];
		const out = restoreStatements(chunk({ rows }));
		expect(out).toHaveLength(2);
		expect(out[0]?.sql).toBe(
			'INSERT OR REPLACE INTO "key_value" ("collection", "name", "value") VALUES (?, ?, ?)'
		);
		expect(out[1]?.params).toEqual(['state', 'b', '2']);
	});
});
