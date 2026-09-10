import { describe, expect, it } from 'vitest';
import { replicaName } from '../../src/ops/replica-routing';
import { ID_PARTITION_LANES, idStride, nextLaneId } from '../../src/ops/write-forwarding';
import { inObject, markProvisioned, namedSite, type ServeDo } from '../helpers/serve-do';

/**
 * The lane's end of forwarding, against a real primary object.
 *
 * The unit tests cover the guard downgrade and the commit decision separately. What neither reaches
 * is the hop: a lane collecting during an invocation, pinning the generation it read at, and landing
 * the batch on another object.
 */

const TIMEOUT = 900_000;
const SITE = 'fwlane.example';

function role(site: ServeDo, as: 'primary' | 'replica'): void {
	(site.env as Record<string, unknown>).REPLICA_READ_ONLY = as === 'replica' ? '1' : '0';
}

/** the payload shape `cfwSqlTxn` is handed, which is what the guard passes to the collector */
function txn(sql: string, params: unknown[] = []): string {
	return JSON.stringify({ statements: [{ sql, params }], commit: true });
}

async function preparePrimary(): Promise<void> {
	await inObject(namedSite(SITE), (site) => {
		role(site, 'primary');
		markProvisioned(site);
		site.ensureServeTables();
		site.sql.exec(
			'CREATE TABLE IF NOT EXISTS node_field_data (nid INTEGER PRIMARY KEY, title TEXT)'
		);
		site.sql.exec("INSERT OR REPLACE INTO node_field_data (nid, title) VALUES (1, 'before')");
		site.sql.exec(
			'CREATE TABLE IF NOT EXISTS some_contrib_thing (id INTEGER PRIMARY KEY, label TEXT)'
		);
	});
}

describe('a lane lands its writes on the primary', () => {
	it(
		'collects during the invocation and commits at the end',
		async () => {
			await preparePrimary();
			const out = await inObject(namedSite(replicaName(SITE, 1)), async (lane) => {
				role(lane, 'replica');
				lane.ensureServeTables();
				lane.collectForward(
					['UPDATE node_field_data SET title = ?'],
					txn('UPDATE node_field_data SET title = ? WHERE nid = 1', ['forwarded'])
				);
				return lane.flushForward();
			});

			expect(out?.action, out?.reason).toBe('commit');

			const title = await inObject(namedSite(SITE), (site) => {
				const row = site.sql
					.exec('SELECT title FROM node_field_data WHERE nid = 1')
					.toArray()[0] as { title: string };
				return row.title;
			});
			// the lane never committed this itself; its own transaction was rolled back
			expect(title).toBe('forwarded');
		},
		TIMEOUT
	);

	it(
		'keeps nothing of its own, so the lane stays at its applied generation',
		async () => {
			await preparePrimary();
			const laneTitle = await inObject(namedSite(replicaName(SITE, 2)), async (lane) => {
				role(lane, 'replica');
				lane.ensureServeTables();
				lane.sql.exec(
					'CREATE TABLE IF NOT EXISTS node_field_data (nid INTEGER PRIMARY KEY, title TEXT)'
				);
				lane.sql.exec(
					"INSERT OR REPLACE INTO node_field_data (nid, title) VALUES (1, 'lane')"
				);
				lane.collectForward(
					['UPDATE node_field_data SET title = ?'],
					txn('UPDATE node_field_data SET title = ? WHERE nid = 1', ['forwarded'])
				);
				await lane.flushForward();
				const row = lane.sql
					.exec('SELECT title FROM node_field_data WHERE nid = 1')
					.toArray()[0] as { title: string };
				return row.title;
			});

			// collecting is not applying. The lane's copy arrives by replication like any other
			// authoritative write, not by having executed it
			expect(laneTitle).toBe('lane');
		},
		TIMEOUT
	);

	it(
		'drops replica-local writes rather than forwarding them',
		async () => {
			await preparePrimary();
			const out = await inObject(namedSite(replicaName(SITE, 3)), async (lane) => {
				role(lane, 'replica');
				lane.ensureServeTables();
				// a cache fill is the lane's own business and the primary must not be asked to
				// commit one; forwarding it would replicate a lane's cache back to everybody
				lane.collectForward(
					['INSERT INTO cache_render VALUES (1)'],
					txn('INSERT INTO cache_render (cid) VALUES (1)')
				);
				return lane.flushForward();
			});

			expect(out).toBeNull();
		},
		TIMEOUT
	);

	it(
		'forwards nothing when nothing was collected',
		async () => {
			const out = await inObject(namedSite(replicaName(SITE, 4)), async (lane) => {
				role(lane, 'replica');
				lane.ensureServeTables();
				return lane.flushForward();
			});
			expect(out).toBeNull();
		},
		TIMEOUT
	);

	it(
		'refuses when it has no primary to forward to',
		async () => {
			const out = await inObject(namedSite('fwlane.notalane'), async (site) => {
				role(site, 'replica');
				site.ensureServeTables();
				site.collectForward(
					['UPDATE node_field_data SET title = ?'],
					txn('UPDATE node_field_data SET title = ?', ['x'])
				);
				return site.flushForward();
			});

			// a var-configured replica is not a lane and has no primary; it keeps refusing
			expect(out?.action).toBe('refuse');
			expect(out?.reason).toContain('no primary');
		},
		TIMEOUT
	);
});

function maxNid(site: ServeDo): number {
	return Number(
		(
			site.sql
				.exec('SELECT COALESCE(MAX(nid), 0) AS m FROM node_field_data')
				.toArray()[0] as { m: number }
		).m
	);
}

/**
 * Which id space the object tells its driver to mint from.
 *
 * The driver predicts a buffered insert's id by arithmetic against THIS object's database and then
 * forwards the statement to a primary that would append its own. Nothing errors -- the visitor is
 * redirected to a node id the primary never assigned -- so the partition has to reach PHP, and it
 * reaches it as two connection options in `settings.php`.
 */
describe('what a lane knows about the ids it has already minted', () => {
	it(
		'records the id it forwarded, so a second mint cannot repeat the first',
		async () => {
			// The stride stops two LANES minting the same id. It does nothing about ONE lane minting
			// the same id twice: the lane rolls its own write back and the committed batch is never
			// applied here, so its table maximum is unchanged and the next insert would compute the
			// same base. The high-water mark is what moves the base instead of the row.
			await preparePrimary();
			const out = await inObject(namedSite(replicaName(SITE, 1)), async (lane) => {
				role(lane, 'replica');
				lane.ensureServeTables();
				lane.sql.exec(
					'CREATE TABLE IF NOT EXISTS node_field_data (nid INTEGER PRIMARY KEY, title TEXT)'
				);
				lane.sql.exec(
					"INSERT OR REPLACE INTO node_field_data (nid, title) VALUES (1, 'before')"
				);
				const maxBefore = maxNid(lane);

				lane.collectForward(
					['INSERT INTO node_field_data (nid, title) VALUES (5, ?)'],
					txn('INSERT INTO node_field_data (nid, title) VALUES (5, ?)', ['minted'])
				);
				const forwarded = await lane.flushForward();

				return {
					forwarded,
					maxBefore,
					maxAfter: maxNid(lane),
					mark: lane.metaGet('lane_high:node_field_data')
				};
			});

			expect(out.forwarded?.action, out.forwarded?.reason).toBe('commit');
			expect(await inObject(namedSite(SITE), maxNid)).toBe(5);

			// the lane still keeps nothing of its own, which is the read-path invariant
			expect(out.maxBefore).toBe(1);
			expect(out.maxAfter).toBe(1);
			// so the base the driver mints from is the mark, and 5 is now behind it
			expect(out.mark).toBe('5');
			expect(nextLaneId(Number(out.mark), 1, 3)).toBe(9);
			expect(nextLaneId(out.maxAfter, 1, 3)).toBe(5);
		},
		TIMEOUT
	);

	it(
		'forwards the driver report that lets an originated id commit at all',
		async () => {
			// An unclassified table is an origination hazard, so the primary refuses it -- unless
			// this lane minted the id from its own residue class, which only the driver knows. The
			// report rides on the `cfwSqlTxn` payload as `minted`, and `flushForward()` is the half
			// that had it and sent `{statements, parent}` anyway.
			await preparePrimary();
			const insert = 'INSERT INTO some_contrib_thing ("id", "label") VALUES (5, ?)';
			const forward = (payload: string) =>
				inObject(namedSite(replicaName(SITE, 6)), async (lane) => {
					role(lane, 'replica');
					lane.ensureServeTables();
					lane.collectForward([insert], payload);
					return lane.flushForward();
				});

			const reported = await forward(
				JSON.stringify({
					statements: [{ sql: insert, params: ['minted'], minted: 'some_contrib_thing' }],
					commit: true
				})
			);
			expect(reported?.action, reported?.reason).toBe('commit');

			// the same batch with the report stripped: the statement text is identical, so anything
			// deriving the allow-list from the SQL would still commit it
			const unreported = await forward(txn(insert, ['minted']));
			expect(unreported?.action).toBe('refuse');
			expect(unreported?.reason).toContain('may not mint');
		},
		TIMEOUT
	);

	it(
		'records nothing for a batch the primary would not commit',
		async () => {
			await preparePrimary();
			const out = await inObject(namedSite(replicaName(SITE, 5)), async (lane) => {
				role(lane, 'replica');
				lane.ensureServeTables();
				// an allocation table is an origination hazard, so the primary refuses the batch
				lane.collectForward(
					['INSERT INTO sequences (value) VALUES (7)'],
					txn('INSERT INTO sequences (value) VALUES (7)')
				);
				const forwarded = await lane.flushForward();
				return { forwarded, mark: lane.metaGet('lane_high:sequences') };
			});

			expect(out.forwarded?.action).toBe('refuse');
			// a mark for a row the primary never took would skip ids on every lane forever
			expect(out.mark).toBeNull();
		},
		TIMEOUT
	);
});

describe('the lane identity the driver mints from', () => {
	function partition(name: string, env: Record<string, unknown>) {
		return inObject(namedSite(name), (site) => {
			Object.assign(site.env as Record<string, unknown>, env);
			return site.idPartition();
		});
	}

	it(
		'gives a forwarding lane a class WITHOUT being told the pool size',
		async () => {
			// THE DEFECT. This read `replicaCount(env)`, and the canonical `wrangler.jsonc` sets no
			// `REPLICA_COUNT` -- so a real lane came back `lanes: 0`, the driver's
			// `$lane >= 1 && $lanes >= 1` was false, and it strided on nothing. Every deployed pool
			// ran with no partition at all, which is the property a conflict retry rests on, while
			// the cases below passed on a count set by hand
			const out = await partition(replicaName('fwid.unset', 2), { WRITE_FORWARD: '1' });
			expect(out).toEqual({ lane: 2, lanes: ID_PARTITION_LANES });
			expect(idStride(out.lane, out.lanes)).toEqual({ offset: 2, stride: 33 });
		},
		TIMEOUT
	);

	it(
		'ignores REPLICA_COUNT entirely, so two writers cannot disagree about it',
		async () => {
			const lane = replicaName('fwid.told', 2);
			const said3 = await partition(lane, { WRITE_FORWARD: '1', REPLICA_COUNT: '3' });
			const said0 = await partition(lane, { WRITE_FORWARD: '1', REPLICA_COUNT: '0' });
			// the count was a fact two parties had to agree on and they did not; a constant needs no
			// agreement, and a lane cannot read the primary's `lanes_provisioned` anyway because
			// `cfw_meta` is replica-local by design
			expect(said3).toEqual(said0);
			expect(said3.lanes).toBe(ID_PARTITION_LANES);
		},
		TIMEOUT
	);

	it(
		'leaves the primary unpartitioned, which is what the driver implements',
		async () => {
			// THIS USED TO ASSERT `{ lane: 0, lanes: 3 }` under a comment saying the primary "takes
			// slice 0 rather than no slice". `Connection::__construct()` strides only when
			// `$lane >= 1`, so lane 0 is stride 1 and every id is in its class -- the comment
			// described arithmetic the driver does not implement. What keeps a lane's id safe is
			// that the primary validates the batch, not that it holds a slice
			const out = await partition('fwid.primary', { WRITE_FORWARD: '1', REPLICA_COUNT: '3' });
			expect(out).toEqual({ lane: 0, lanes: 0 });
			expect(idStride(out.lane, out.lanes)).toEqual({ offset: 0, stride: 1 });
		},
		TIMEOUT
	);

	it(
		'gives every LANE in a pool a residue class no other lane can mint',
		async () => {
			const env = { WRITE_FORWARD: '1' };
			const lanes = [
				await partition(replicaName('fwid.set', 1), env),
				await partition(replicaName('fwid.set', 2), env),
				await partition(replicaName('fwid.set', 3), env)
			];
			const offsets = lanes.map((w) => idStride(w.lane, w.lanes).offset);
			expect(new Set(offsets).size, `two lanes share a residue: ${offsets}`).toBe(3);
			// and none of them is the unpartitioned class, so a lane never mints where an
			// unstrided writer would land first
			expect(offsets).not.toContain(0);
			for (const w of lanes) expect(idStride(w.lane, w.lanes).stride).toBe(33);

			const minted = lanes.map((w) => nextLaneId(5, w.lane, w.lanes));
			expect(new Set(minted).size, `two lanes mint the same id: ${minted}`).toBe(3);
		},
		TIMEOUT
	);

	it(
		'holds at the top of the range, where a modulus would wrap onto the primary',
		async () => {
			// `replicaCount()` and `rememberLanes()` both clamp at 32, so lane 32 is reachable. With
			// a stride of 32 it would land on offset 0; the stride is 33 for exactly this reason
			const top = await partition(replicaName('fwid.top', 32), { WRITE_FORWARD: '1' });
			expect(idStride(top.lane, top.lanes).offset).toBe(32);
			expect(idStride(top.lane, top.lanes).offset).not.toBe(0);
		},
		TIMEOUT
	);

	it(
		'gives the primary nothing when the site has no pool',
		async () => {
			expect(
				await partition('fwid.solo', { WRITE_FORWARD: '1', REPLICA_COUNT: '0' })
			).toEqual({ lane: 0, lanes: 0 });
		},
		TIMEOUT
	);

	it(
		'a retried batch carries an id no other writer could have taken meanwhile',
		async () => {
			// `flushForward()` retries a conflict by re-sending the SAME statements, supplied rowids
			// included, against a generation the primary has moved to. That is safe ONLY because the
			// residue classes are disjoint across every writer -- otherwise whatever committed in
			// between could have taken one of these ids. The property was an argument until here
			const env = { WRITE_FORWARD: '1' };
			const writers = await Promise.all([
				partition(replicaName('retry.pool', 1), env),
				partition(replicaName('retry.pool', 2), env),
				partition(replicaName('retry.pool', 3), env)
			]);

			// every OTHER writer, minting from the same base the retrying lane read at
			const lane = writers[0]!;
			const mine = nextLaneId(5, lane.lane, lane.lanes);
			const theirs = writers
				.filter((w) => w.lane !== lane.lane)
				.flatMap((w) => [0, 1, 2, 3, 4].map((k) => nextLaneId(5 + k, w.lane, w.lanes)));

			expect(theirs, `another writer can mint ${mine}`).not.toContain(mine);
		},
		TIMEOUT
	);

	it(
		'lets an unrouted LANE hibernate, and never the primary',
		async () => {
			// warming is per OBJECT, so a warmed pool multiplied it: 32 idle lanes re-arming every
			// 8 s is 345,600 rows/day serving nothing. A quiet PRIMARY still pays the cold boot when
			// a visitor arrives, so it keeps warming
			const idleOf = (name: string) =>
				inObject(namedSite(name), (site) => {
					(site as any).doRequestsSinceFlush = 0;
					(site as any).inflightPeak = 0;
					return (site as any).laneIsIdle();
				});
			expect(await idleOf(replicaName('warm.pool', 1))).toBe(true);
			expect(await idleOf('warm.pool')).toBe(false);

			// and a lane that IS taking traffic keeps itself resident
			const busy = await inObject(namedSite(replicaName('warm.pool', 2)), (site) => {
				(site as any).doRequestsSinceFlush = 5;
				return (site as any).laneIsIdle();
			});
			expect(busy).toBe(false);
		},
		TIMEOUT
	);

	it(
		'gives a lane nothing while forwarding is off',
		async () => {
			// the lane refuses the write outright, so there is nothing to mint an id for and the
			// driver has to keep the arithmetic it always had
			expect(
				await partition(replicaName('fwid.off', 1), {
					WRITE_FORWARD: '0',
					REPLICA_COUNT: '3'
				})
			).toEqual({ lane: 0, lanes: 0 });
		},
		TIMEOUT
	);

	it(
		'still gives a lane its class when REPLICA_COUNT is the empty string',
		async () => {
			// THIS CASE ASSERTED THE DEFECT. It pinned `{ lane: 0, lanes: 0 }` for a real lane whose
			// count was unset, which is the state the canonical config ships -- so the spec agreed
			// with the bug and went green on every commit while `/user` answered 500 from a lane
			const out = await partition(replicaName('fwid.unsized', 1), {
				WRITE_FORWARD: '1',
				REPLICA_COUNT: ''
			});
			expect(out).toEqual({ lane: 1, lanes: ID_PARTITION_LANES });
			expect(idStride(out.lane, out.lanes)).toEqual({ offset: 1, stride: 33 });
		},
		TIMEOUT
	);
});
