import { describe, expect, it } from 'vitest';
import { maxLanes } from '../../../src/ops/replica-demand';
import { replicaCount } from '../../../src/ops/replica-routing';
import {
	cacheTagIncrement,
	deferrable,
	hazardClass,
	ID_PARTITION_LANES,
	idStride,
	keyValueTarget,
	laneHighWater,
	nextLaneId,
	partitionedTables,
	planForward,
	splitForward,
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

	it('drops a table the lane does not replicate, however the driver reported it', () => {
		// `watchdog` is PRIMARY_ONLY_SIDE_EFFECT, so `planRestore()` refuses to copy it and the lane
		// holds none of its rows. Its high-water mark is therefore 0 and the first id it mints in its
		// residue class is `wid = lane`, which the primary used when the site was new. Measured on a
		// provisioned lane: `count 0, seq null` against a primary at 61.
		expect(
			partitionedTables([
				{
					sql: 'INSERT INTO watchdog ("wid", "type") VALUES (5, ?)',
					table: 'watchdog',
					minted: 'watchdog'
				}
			])
		).toEqual([]);
	});

	it('refuses a forwarded batch carrying one, rather than committing a colliding id', () => {
		const plan = planForward({
			statements: [
				{
					sql: 'INSERT INTO watchdog ("wid", "type") VALUES (5, ?)',
					table: 'watchdog',
					minted: 'watchdog'
				}
			],
			parent: 4,
			primaryGeneration: 4,
			// the lane claims it partitioned the table; the primary re-filters and must not believe it
			partitioned: ['watchdog']
		});
		expect(plan.action).toBe('refuse');
		expect(plan.reason).toContain('watchdog');
	});

	it('defers the log row instead, with the lane-minted id dropped for the primary to allocate', () => {
		expect(
			deferrable({
				sql: 'INSERT INTO watchdog ("wid", "type") VALUES (5, ?)',
				params: ['user'],
				table: 'watchdog',
				minted: 'watchdog'
			})
		).toEqual({
			sql: 'INSERT INTO watchdog ("type") VALUES (?)',
			params: ['user'],
			table: 'watchdog'
		});
	});

	it('defers a log row bound by name, which is how Drupal inserts one', () => {
		expect(
			deferrable({
				sql: 'INSERT INTO watchdog (uid, type) VALUES (:db_insert_placeholder_0, :db_insert_placeholder_1)',
				params: { ':db_insert_placeholder_0': 1, ':db_insert_placeholder_1': 'user' },
				table: 'watchdog'
			} as unknown as ForwardStatement)
		).toEqual({
			sql: 'INSERT INTO watchdog (uid, type) VALUES (?, ?)',
			params: [1, 'user'],
			table: 'watchdog'
		});
	});

	// an id the driver did not report, a trailing clause, or another table stays in the batch
	it('keeps every shape it cannot prove disposable in the batch', () => {
		for (const statement of [
			{
				sql: 'INSERT INTO watchdog ("type", "wid") VALUES (?, 3)',
				params: ['x'],
				table: 'watchdog'
			},
			{
				sql: 'INSERT INTO watchdog ("type") VALUES (?) RETURNING wid',
				params: ['x'],
				table: 'watchdog'
			},
			{
				sql: 'INSERT INTO watchdog ("type") SELECT type FROM node',
				params: [],
				table: 'watchdog'
			},
			{ sql: 'UPDATE watchdog SET type = ?', params: ['x'], table: 'watchdog' },
			{ sql: 'INSERT INTO sessions ("sid") VALUES (?)', params: ['s'], table: 'sessions' }
		]) {
			expect(deferrable(statement), statement.sql).toBeNull();
		}
	});

	it('splits a batch so the log row no longer refuses the write beside it', () => {
		const update = {
			sql: 'UPDATE users SET name = ? WHERE uid = 1',
			params: ['a'],
			table: 'users'
		};
		const log = {
			sql: 'INSERT INTO watchdog ("type") VALUES (?)',
			params: ['user'],
			table: 'watchdog'
		};
		const { commit, deferred } = splitForward([update, log]);
		expect(commit).toEqual([update]);
		expect(deferred).toHaveLength(1);
		expect(planForward({ statements: commit, parent: 4, primaryGeneration: 4 }).action).toBe(
			'commit'
		);
	});

	// the autocomplete widget writes this on every form build; the table alone read as an origination
	it('classifies a key_value upsert by its collection, not its table', () => {
		const upsert = (collection: string, name: string): ForwardStatement => ({
			sql: 'INSERT INTO "key_value" ("collection", "name", "value") VALUES (:db_insert_placeholder_0, :db_insert_placeholder_1, :db_insert_placeholder_2) ON CONFLICT ("collection", "name") DO UPDATE SET "value" = excluded."value"',
			params: {
				':db_insert_placeholder_0': collection,
				':db_insert_placeholder_1': name,
				':db_insert_placeholder_2': 'x'
			} as unknown as unknown[],
			table: 'key_value'
		});
		expect(keyValueTarget(upsert('entity_autocomplete', 'h'))).toEqual({
			collection: 'entity_autocomplete',
			name: 'h'
		});
		const plan = (s: ForwardStatement) =>
			planForward({ statements: [s], parent: 1, primaryGeneration: 1 });
		expect(plan(upsert('entity_autocomplete', 'h')).action).toBe('commit');
		// the lazily minted secret is still refused, now by name rather than by accident
		expect(plan(upsert('state', 'system.private_key')).reason).toContain('key_value:state');
		// a shape it cannot read keeps the old verdict
		expect(
			plan({
				sql: 'DELETE FROM key_value WHERE collection = ?',
				params: ['x'],
				table: 'key_value'
			}).action
		).toBe('refuse');
	});

	it('rewrites both branches of a tag invalidation as the increment they mean', () => {
		const expected = {
			sql: 'INSERT INTO "cachetags" ("tag", "invalidations") VALUES (?, 1) ON CONFLICT ("tag") DO UPDATE SET "invalidations" = "invalidations" + 1',
			params: ['node_list'],
			table: 'cachetags'
		};
		expect(
			cacheTagIncrement({
				sql: 'INSERT INTO "cachetags" ("invalidations", "tag") VALUES (?, ?)',
				params: [1, 'node_list'],
				table: 'cachetags'
			})
		).toEqual(expected);
		expect(
			cacheTagIncrement({
				sql: 'UPDATE "cachetags" SET invalidations = invalidations + 1 WHERE tag = :db_condition_placeholder_0',
				params: { ':db_condition_placeholder_0': 'node_list' } as unknown as unknown[],
				table: 'cachetags'
			})
		).toEqual(expected);
		expect(
			cacheTagIncrement({ sql: 'DELETE FROM cachetags', params: [], table: 'cachetags' })
		).toBeNull();
		expect(
			splitForward([
				{
					sql: 'INSERT INTO cachetags (invalidations, tag) VALUES (?, ?)',
					params: [1, 't'],
					table: 'cachetags'
				}
			]).commit[0]?.params
		).toEqual(['t']);
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

/**
 * The lane ceiling, which is defined in five places and linked in none.
 *
 * `replicaCount()` and `rememberLanes()` clamp at 32, `DEFAULT_MAX_LANES` is 32, `maxLanes()`
 * clamps at 32, and `ID_PARTITION_LANES` is 32. Two of those carry docblocks saying they are
 * DERIVED from the router's clamp and neither imports it. Raise the clamp to 48 -- which
 * `replica-demand.ts` cites a measurement at -- and lanes 33 to 48 fall outside the residue
 * partition, which is the disjointness the forwarded-id conflict retry rests on. Nothing compared
 * them, so the drift would have been silent and the failure would have been two lanes minting the
 * same id.
 */
describe('the partition covers every lane the router can address', () => {
	it('gives the highest addressable lane a residue of its own', () => {
		const ceiling = replicaCount({ REPLICA_COUNT: '999' });
		expect(ceiling).toBeGreaterThan(0);
		// the partition has to reach at least as far as the router does
		expect(
			ID_PARTITION_LANES,
			'a lane the router can address falls outside the id partition'
		).toBeGreaterThanOrEqual(ceiling);
	});

	it('keeps every one of those lanes off the unpartitioned residue', () => {
		const ceiling = replicaCount({ REPLICA_COUNT: '999' });
		const offsets = new Set<number>();
		for (let lane = 1; lane <= ceiling; lane++) {
			const { offset, stride } = idStride(lane, ID_PARTITION_LANES);
			// 0 is where an unstrided writer lands first, so a lane must never hold it
			expect(offset, `lane ${lane} shares the unpartitioned residue`).not.toBe(0);
			expect(stride).toBe(ID_PARTITION_LANES + 1);
			offsets.add(offset);
		}
		expect(offsets.size, 'two lanes share a residue class').toBe(ceiling);
	});

	it('agrees with what autoscaling is allowed to build', () => {
		// `maxLanes()` bounds the pool the primary grows on its own, so it is the other end of the
		// same question: a lane it can create must be one the partition covers
		expect(ID_PARTITION_LANES).toBeGreaterThanOrEqual(maxLanes({ REPLICA_MAX_LANES: '999' }));
	});
});
