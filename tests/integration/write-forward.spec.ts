import { describe, expect, it } from 'vitest';
import { replicaName } from '../../src/ops/replica-routing';
import { ID_PARTITION_LANES, idStride } from '../../src/ops/write-forwarding';
import { inObject, markProvisioned, namedSite, type ServeDo } from '../helpers/serve-do';

/**
 * A lane executes the write; the primary commits it.
 *
 * The read pool refuses every authoritative write, which leaves a site whose bottleneck is saves with
 * one thread. Form processing, validation and the response render are not authoritative, so only the
 * commit has to be serialised, and the driver already replays a buffered statement list and rolls it
 * back on request.
 */

const TIMEOUT = 900_000;

function role(site: ServeDo, as: 'primary' | 'replica'): void {
	(site.env as Record<string, unknown>).REPLICA_READ_ONLY = as === 'replica' ? '1' : '0';
}

type Answer = {
	action?: string;
	reason?: string;
	generation?: number;
	primaryGeneration?: number;
	error?: string;
};

async function forward(
	site: ServeDo,
	body: Record<string, unknown>
): Promise<{ status: number; body: Answer }> {
	const res = await site.fetch(
		new Request('https://do.local/__replica?action=forward', {
			method: 'POST',
			body: JSON.stringify(body),
			headers: { 'content-type': 'application/json' }
		})
	);
	return { status: res.status, body: (await res.json()) as Answer };
}

function seedTable(site: ServeDo): void {
	site.sql.exec(
		'CREATE TABLE IF NOT EXISTS node_field_data (nid INTEGER PRIMARY KEY, title TEXT)'
	);
	site.sql.exec("INSERT OR REPLACE INTO node_field_data (nid, title) VALUES (1, 'before')");
}

describe('the primary commits what a lane ran', () => {
	it(
		'applies the batch and advances the generation',
		async () => {
			const out = await inObject(namedSite('forward.applies'), async (site) => {
				role(site, 'primary');
				markProvisioned(site);
				site.ensureServeTables();
				seedTable(site);
				const before = site.commitSeq();
				const answer = await forward(site, {
					statements: [
						{
							sql: 'UPDATE node_field_data SET title = ? WHERE nid = 1',
							params: ['after'],
							table: 'node_field_data'
						}
					],
					parent: before
				});
				const title = site.sql
					.exec('SELECT title FROM node_field_data WHERE nid = 1')
					.toArray()[0] as { title: string };
				return { before, answer, title: title.title, after: site.commitSeq() };
			});

			expect(out.answer.status).toBe(200);
			expect(out.answer.body.action).toBe('commit');
			expect(out.title).toBe('after');
			// the generation moves, so a lane fencing on it sees the write
			expect(out.after).toBeGreaterThan(out.before);
			expect(out.answer.body.generation).toBe(out.after);
		},
		TIMEOUT
	);

	it(
		'records the batch for replication, so lanes converge on it',
		async () => {
			const records = await inObject(namedSite('forward.replicates'), async (site) => {
				role(site, 'primary');
				markProvisioned(site);
				site.ensureServeTables();
				site.ensureReplicationLog();
				seedTable(site);
				await forward(site, {
					statements: [
						{
							sql: 'UPDATE node_field_data SET title = ? WHERE nid = 1',
							params: ['replicated'],
							table: 'node_field_data'
						}
					],
					parent: site.commitSeq()
				});
				const res = await site.fetch(
					new Request('https://do.local/__replica?action=log&since=0')
				);
				return (await res.json()) as { records: { statements: unknown[] }[] };
			});

			// a forwarded write is an authoritative write like any other; a lane that missed it
			// would serve a database the primary was never in
			expect(records.records.length).toBeGreaterThan(0);
			expect(records.records[0]?.statements.length).toBeGreaterThan(0);
		},
		TIMEOUT
	);
});

describe('the log row a lane carries', () => {
	it(
		'commits the write beside it and appends the row with an id the primary allocates',
		async () => {
			const out = await inObject(namedSite('forward.defers'), async (site) => {
				role(site, 'primary');
				markProvisioned(site);
				site.ensureServeTables();
				site.ensureReplicationLog();
				seedTable(site);
				site.sql.exec(
					'CREATE TABLE IF NOT EXISTS watchdog (wid INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT)'
				);
				site.sql.exec("INSERT INTO watchdog (wid, type) VALUES (5, 'earlier')");
				const answer = await forward(site, {
					statements: [
						{
							sql: 'UPDATE node_field_data SET title = ? WHERE nid = 1',
							params: ['logged'],
							table: 'node_field_data'
						},
						{
							sql: 'INSERT INTO watchdog ("wid", "type") VALUES (5, ?)',
							params: ['user'],
							table: 'watchdog',
							minted: 'watchdog'
						}
					],
					parent: site.commitSeq()
				});
				const log = await (
					await site.fetch(new Request('https://do.local/__replica?action=log&since=0'))
				).json();
				return {
					answer,
					title: site.sql
						.exec('SELECT title FROM node_field_data WHERE nid = 1')
						.toArray()[0],
					rows: site.sql.exec('SELECT wid, type FROM watchdog ORDER BY wid').toArray(),
					log: JSON.stringify(log)
				};
			});

			// it used to answer 422, and the primary re-ran the whole request
			expect(out.answer.status).toBe(200);
			expect(out.answer.body.action).toBe('commit');
			expect(out.title).toEqual({ title: 'logged' });
			// the lane minted 5, which the primary already used; the row lands at the next id instead
			expect(out.rows).toEqual([
				{ wid: 5, type: 'earlier' },
				{ wid: 6, type: 'user' }
			]);
			// a primary-only effect: no lane holds the table, so the row is not replicated
			expect(out.log).not.toContain('watchdog');
		},
		TIMEOUT
	);
});

describe('what the primary refuses', () => {
	it(
		'conflicts when the lane read an older generation',
		async () => {
			const out = await inObject(namedSite('forward.conflict'), async (site) => {
				role(site, 'primary');
				markProvisioned(site);
				site.ensureServeTables();
				seedTable(site);
				site.advanceCommit();
				site.advanceCommit();
				return forward(site, {
					statements: [
						{
							sql: 'UPDATE node_field_data SET title = ?',
							params: ['stale'],
							table: 'node_field_data'
						}
					],
					parent: 0
				});
			});

			// 409 rather than 422: the lane can re-read and try again
			expect(out.status).toBe(409);
			expect(out.body.action).toBe('conflict');
			expect(out.body.primaryGeneration).toBeGreaterThan(0);
		},
		TIMEOUT
	);

	it(
		'refuses an allocation outright, because a retry cannot fix a minted value',
		async () => {
			const out = await inObject(namedSite('forward.mint'), async (site) => {
				role(site, 'primary');
				markProvisioned(site);
				site.ensureServeTables();
				return forward(site, {
					statements: [
						{ sql: 'INSERT INTO sequences (value) VALUES (1)', table: 'sequences' }
					],
					parent: site.commitSeq()
				});
			});

			// 422 rather than 409: nothing the lane does next makes this batch acceptable
			expect(out.status).toBe(422);
			expect(out.body.action).toBe('refuse');
			expect(out.body.reason).toContain('may not mint');
		},
		TIMEOUT
	);

	it(
		'refuses to be forwarded to from another lane',
		async () => {
			const out = await inObject(
				namedSite(replicaName('forward.fromlane', 1)),
				async (site) => {
					role(site, 'primary');
					site.ensureServeTables();
					return forward(site, {
						statements: [{ sql: 'UPDATE config SET data = 1', table: 'config' }],
						parent: 0
					});
				}
			);

			// a lane is not a sequencer; forwarding to one would give a site two of them
			expect(out.status).toBe(409);
			expect(out.body.error).toContain('not to another lane');
		},
		TIMEOUT
	);

	it(
		'leaves the row untouched when it refuses',
		async () => {
			const title = await inObject(namedSite('forward.untouched'), async (site) => {
				role(site, 'primary');
				markProvisioned(site);
				site.ensureServeTables();
				seedTable(site);
				await forward(site, {
					statements: [
						{
							sql: "UPDATE node_field_data SET title = 'sneaked' WHERE nid = 1",
							table: 'node_field_data'
						},
						{ sql: 'INSERT INTO sequences (value) VALUES (1)', table: 'sequences' }
					],
					parent: site.commitSeq()
				});
				const row = site.sql
					.exec('SELECT title FROM node_field_data WHERE nid = 1')
					.toArray()[0] as { title: string };
				return row.title;
			});

			// the whole batch is judged before any of it runs, so one bad statement cannot land the
			// rest of it
			expect(title).toBe('before');
		},
		TIMEOUT
	);
});

/**
 * The residue classes, and the writer that was left out of them.
 *
 * Lanes mint forwarded ids from class `lane mod (ID_PARTITION_LANES + 1)`. That is only disjoint if
 * EVERY writer strides, and the primary did not: it minted plain sequential ids and so reached a
 * lane's reserved value within one stride. Measured on four deployed pools, where every
 * authenticated POST answered 500 with `UNIQUE constraint failed: watchdog.wid` -- a login writes a
 * dblog row and `wid` is AUTOINCREMENT.
 */
describe('the primary takes a residue class of its own', () => {
	it(
		'does not stride a site that has no pool',
		async () => {
			const partition = await inObject(namedSite('partition.nopool'), (site) => {
				role(site, 'primary');
				site.ensureServeTables();
				return site.idPartition();
			});
			// a site that never provisions a lane would pay sparser ids for nothing to be disjoint from
			expect(partition).toEqual({ lane: 0, lanes: 0 });
		},
		TIMEOUT
	);

	it(
		'strides once the site has provisioned a lane',
		async () => {
			const partition = await inObject(namedSite('partition.pooled'), (site) => {
				role(site, 'primary');
				site.ensureServeTables();
				site.metaSet('lanes_provisioned', '4');
				return site.idPartition();
			});
			// WITHOUT THE PRIMARY STRIDING THIS IS `{ lane: 0, lanes: 0 }` and the classes overlap
			expect(partition).toEqual({ lane: 0, lanes: ID_PARTITION_LANES });
		},
		TIMEOUT
	);

	it('keeps the primary class clear of every lane the router can address', () => {
		const primary = idStride(0, ID_PARTITION_LANES);
		expect(primary.offset).toBe(0);
		const seen = new Set<number>([primary.offset]);
		for (let lane = 1; lane <= ID_PARTITION_LANES; lane += 1) {
			const { offset, stride } = idStride(lane, ID_PARTITION_LANES);
			expect(stride).toBe(primary.stride);
			expect(seen.has(offset), `lane ${lane} reuses residue ${offset}`).toBe(false);
			seen.add(offset);
		}
		// every writer the router can address, the primary included, holds one class
		expect(seen.size).toBe(ID_PARTITION_LANES + 1);
	});
});
