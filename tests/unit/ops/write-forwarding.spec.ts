import { describe, expect, it } from 'vitest';
import {
	hazardClass,
	idStride,
	laneHighWater,
	nextLaneId,
	partitionedTables,
	planForward,
	type ForwardStatement
} from '../../../src/ops/write-forwarding';

/**
 * What a lane may execute, and what only the primary may commit.
 *
 * The read pool refuses every authoritative write. That refusal is wider than the danger, and these
 * cases pin where the real edge is: a value two objects would mint differently cannot be forwarded at
 * all, while a value with a definite prior state can, because the parent generation detects the lost
 * update.
 */

describe('which writes a lane may not originate', () => {
	it('refuses an allocation', () => {
		// two objects allocating from their own copy mint the same id for different rows, and
		// nothing errors until the rows meet
		expect(hazardClass('sequences')).toBe('origination');
		expect(hazardClass('sqlite_sequence')).toBe('origination');
	});

	it('refuses the lazily minted installation secrets', () => {
		expect(hazardClass('key_value', 'state', 'system.private_key')).toBe('origination');
		expect(hazardClass('key_value', 'state', 'system.cron_key')).toBe('origination');
	});

	it('calls ordinary content an ordering hazard', () => {
		// a title has a prior state, so two writers are a lost update rather than a divergence
		expect(hazardClass('node_field_data')).toBe('ordering');
		expect(hazardClass('config')).toBe('ordering');
	});

	it('lets a lane own its own caches outright', () => {
		expect(hazardClass('cache_config')).toBe('none');
		expect(hazardClass('cfw_page')).toBe('none');
	});

	it('answers origination for anything it cannot classify', () => {
		// the strictest verdict for an unknown, which is the opposite of what the restore does with
		// one -- the direction that fails safely differs by question
		expect(hazardClass('some_contrib_thing')).toBe('origination');
		expect(hazardClass('')).toBe('origination');
	});
});

describe('partitioning the id space so two lanes cannot collide', () => {
	it('gives every lane a distinct offset on a shared stride', () => {
		const seen = new Set<string>();
		for (let lane = 0; lane <= 3; lane++) {
			const { offset, stride } = idStride(lane, 3);
			expect(stride).toBe(4);
			seen.add(`${offset}`);
		}
		// the primary is offset 0 and each lane takes one of the rest
		expect(seen.size).toBe(4);
	});

	it('mints ids no other lane can mint', () => {
		const lanes = 3;
		const minted = new Map<number, number>();
		for (let lane = 0; lane <= lanes; lane++) {
			let at = 0;
			for (let i = 0; i < 25; i++) {
				at = nextLaneId(at, lane, lanes);
				expect(minted.has(at), `lane ${lane} collided on ${at}`).toBe(false);
				minted.set(at, lane);
			}
		}
		expect(minted.size).toBe(100);
	});

	it('degenerates to every id when there are no lanes', () => {
		expect(idStride(0, 0)).toEqual({ offset: 0, stride: 1 });
		expect(nextLaneId(7, 0, 0)).toBe(8);
	});

	it('always moves forward', () => {
		for (let after = 0; after < 20; after++) {
			expect(nextLaneId(after, 2, 3)).toBeGreaterThan(after);
		}
	});
});

describe('whether the primary may commit what a lane executed', () => {
	const content: ForwardStatement[] = [
		{ sql: 'UPDATE node_field_data SET title = ?', params: ['x'], table: 'node_field_data' }
	];

	it('commits a batch built on the generation the primary is at', () => {
		expect(planForward({ statements: content, parent: 12, primaryGeneration: 12 })).toEqual({
			action: 'commit',
			reason: ''
		});
	});

	it('conflicts when the primary has moved', () => {
		// the lane read a database at 12, so a batch applied at 14 is a lost update wearing a
		// successful response
		const out = planForward({ statements: content, parent: 12, primaryGeneration: 14 });
		expect(out.action).toBe('conflict');
		expect(out.reason).toContain('the primary is at 14');
	});

	it('refuses an origination rather than conflicting on it', () => {
		// a retry cannot fix a value that was minted, which is why this is not a conflict
		const out = planForward({
			statements: [{ sql: 'INSERT INTO sequences', table: 'sequences' }],
			parent: 3,
			primaryGeneration: 3
		});
		expect(out.action).toBe('refuse');
		expect(out.reason).toContain('may not mint');
	});

	it('allows an origination the lane has been partitioned for', () => {
		// `some_contrib_thing` is unclassified, so it is an origination hazard by default; the
		// driver spliced a rowid from this lane's residue class into it, which is the one thing
		// that makes an originated id safe to commit here
		const out = planForward({
			statements: [
				{
					sql: 'INSERT INTO some_contrib_thing ("id") VALUES (5)',
					table: 'some_contrib_thing'
				}
			],
			parent: 3,
			primaryGeneration: 3,
			partitioned: ['some_contrib_thing']
		});
		expect(out.action).toBe('commit');
	});

	it('refuses an allocation table even when the lane claims it is partitioned', () => {
		// a rowid stride partitions ROWIDS. `sequences` allocates its VALUE, so nothing about the
		// stride keeps two writers apart, and a lane asking for it is a lane to disbelieve
		const out = planForward({
			statements: [{ sql: 'INSERT INTO sequences', table: 'sequences' }],
			parent: 3,
			primaryGeneration: 3,
			partitioned: ['sequences', 'sqlite_sequence']
		});
		expect(out.action).toBe('refuse');
		expect(out.reason).toContain('may not mint');
	});

	it('refuses a batch with nothing in it or no readable parent', () => {
		expect(planForward({ statements: [], parent: 1, primaryGeneration: 1 }).action).toBe(
			'refuse'
		);
		expect(
			planForward({ statements: content, parent: Number.NaN, primaryGeneration: 1 }).action
		).toBe('refuse');
	});

	it('refuses a statement whose table nothing named', () => {
		// an unattributed write is exactly the shape that would be forwarded as merely ordered
		const out = planForward({
			statements: [{ sql: 'INSERT INTO something (a) VALUES (1)' }],
			parent: 1,
			primaryGeneration: 1
		});
		expect(out.action).toBe('refuse');
	});
});

/**
 * What a lane has to remember about a batch it no longer holds.
 *
 * The committed batch is never applied here, so nothing in this object's own tables says which ids
 * it already spent. This is the only record of them.
 */
describe('the ids a forwarded batch spent', () => {
	it('reads the id the driver spliced into a rewritten insert', () => {
		// the shape RowidPlan::withSuppliedRowid() emits: key column first, id first in the tuple
		const out = laneHighWater([
			{
				sql: 'INSERT INTO node_field_data ("nid", "title") VALUES (9, ?)',
				table: 'node_field_data'
			}
		]);
		expect(out.get('node_field_data')).toBe(9);
	});

	it('keeps the highest per table and lower-cases the name the driver keys on', () => {
		const out = laneHighWater([
			{ sql: 'INSERT INTO Node ("nid") VALUES (13, ?)', table: 'Node' },
			{ sql: 'INSERT INTO node ("nid") VALUES (5, ?)', table: 'node' },
			{ sql: 'INSERT OR REPLACE INTO users ("uid", "name") VALUES (4, ?)', table: 'users' }
		]);
		expect(out.get('node')).toBe(13);
		expect(out.get('users')).toBe(4);
	});

	it('names a table as partitioned only where the driver reported minting one', () => {
		const batch: ForwardStatement[] = [
			{
				sql: 'INSERT INTO node_field_data ("nid", "title") VALUES (9, ?)',
				table: 'node_field_data',
				minted: 'node_field_data'
			},
			// the shape `laneHighWater()` reads positionally and this must not: the id is Drupal's,
			// not a value the driver minted from the stride
			{ sql: 'INSERT INTO sequences (value) VALUES (7)', table: 'sequences' },
			{ sql: 'UPDATE users_field_data SET name = ?', table: 'users_field_data' }
		];
		expect(partitionedTables(batch)).toEqual(['node_field_data']);
		// and the two lists do disagree, which is the reason for the second one
		expect([...laneHighWater(batch).keys()]).toContain('sequences');
	});

	it('drops an allocation table the driver somehow reported', () => {
		expect(
			partitionedTables([
				{ sql: 'INSERT INTO sequences ("value") VALUES (4)', minted: 'sequences' },
				{ sql: 'INSERT INTO sqlite_sequence ("seq") VALUES (4)', minted: 'sqlite_sequence' }
			])
		).toEqual([]);
	});

	it('reads nothing from a statement that mints nothing', () => {
		const out = laneHighWater([
			{ sql: 'UPDATE node_field_data SET title = ? WHERE nid = 1', table: 'node_field_data' },
			{ sql: 'INSERT INTO watchdog ("type", "wid") VALUES (?, 3)', table: 'watchdog' },
			{ sql: 'INSERT INTO key_value ("name") VALUES (?)', table: 'key_value' },
			{ sql: 'INSERT INTO node ("nid") VALUES (7, ?)' }
		]);
		expect(out.size).toBe(0);
	});
});
