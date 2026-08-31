import { describe, expect, it } from 'vitest';
import { replicaName } from '../../src/ops/replica-routing';
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
