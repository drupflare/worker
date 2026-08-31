import { describe, expect, it } from 'vitest';
import type { LogRecord } from '../../src/ops/replication-log';
import { freshSite, inObject, markProvisioned, type ServeDo } from '../helpers/serve-do';

/**
 * The log against a real object, which is where the store adapter can be wrong.
 *
 * The unit spec drives the decisions over a Map; what only this can check is that the two durable
 * mechanisms behave the way those decisions assume. `cfw_meta.v` is NOT NULL, so clearing the
 * in-flight marker writes an empty string rather than deleting the row, and an empty string that read
 * back as a marker would leave every replica permanently untrusted. And a chunk is rolled back by
 * `transactionSync` rather than by a fake that discards a buffer -- if the real one did not roll
 * back, the untrusted case would be silently the trusted-but-wrong case.
 */

const TIMEOUT = 120_000;
const PACK = 'test-fixture';

function record(over: Partial<LogRecord> = {}): LogRecord {
	const generation = over.generation ?? 1;
	return {
		generation,
		parent: over.parent ?? generation - 1,
		schemaVersion: over.schemaVersion ?? PACK,
		fingerprint: over.fingerprint ?? 'a'.repeat(64),
		statements: over.statements ?? [
			{ sql: 'INSERT INTO repl_probe (k, v) VALUES (?, ?)', params: ['one', '1'] },
			{ sql: 'INSERT INTO repl_probe (k, v) VALUES (?, ?)', params: ['two', '2'] }
		]
	};
}

type Outcome = { action: string; reason: string; applied: number; chunks: number };

async function post(site: ServeDo, rec: LogRecord, chunk?: number): Promise<Outcome> {
	const q = chunk === undefined ? '' : `&chunk=${chunk}`;
	const res = await site.fetch(
		new Request(`https://do.local/__replica?action=apply${q}`, {
			method: 'POST',
			body: JSON.stringify(rec),
			headers: { 'content-type': 'application/json' }
		})
	);
	return (await res.json()) as Outcome;
}

function probeRows(site: ServeDo): string[] {
	const rows = site.sql.exec('SELECT k FROM repl_probe ORDER BY k').toArray() as unknown as {
		k: string;
	}[];
	return rows.map((r) => r.k);
}

/**
 * A table of the applier's own, so a record's statements are real writes against real SQLite.
 *
 * The two `key_value` tables come with it because the report half fingerprints them, and a real
 * migrated object always has them; `markProvisioned()` stamps the cursor without creating any.
 */
function probeTable(site: ServeDo): void {
	site.sql.exec('CREATE TABLE IF NOT EXISTS repl_probe (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS key_value (collection TEXT, name TEXT, value BLOB,
			PRIMARY KEY (collection, name))`
	);
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS key_value_expire (collection TEXT, name TEXT, value BLOB,
			expire INTEGER, PRIMARY KEY (collection, name))`
	);
}

describe('a delivered generation lands in the database', () => {
	it(
		'applies, advances, and stays trusted across the empty-string marker',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site, PACK);
				probeTable(site);
				// chunked, so the marker is written and then cleared; this is the round trip that
				// `cfw_meta.v NOT NULL` could break
				const applied = await post(site, record({ generation: 1 }), 1);
				const res = await site.fetch(new Request('https://do.local/__replica'));
				return {
					applied,
					rows: probeRows(site),
					report: (await res.json()) as Record<string, any>
				};
			});

			expect(out.applied.action).toBe('apply');
			expect(out.applied.chunks).toBe(2);
			expect(out.rows).toEqual(['one', 'two']);
			expect(out.report.log.position.applied).toBe(1);
			// the cleared marker reads as ABSENT rather than as an unparseable one
			expect(out.report.log.position.inflight).toBeNull();
			expect(out.report.log.trust.trusted).toBe(true);
		},
		TIMEOUT
	);

	it(
		'rolls the whole record back when one statement fails',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site, PACK);
				probeTable(site);
				let threw = '';
				try {
					// the second statement violates the primary key, so the transaction must discard
					// the first as well
					await post(
						site,
						record({
							generation: 1,
							statements: [
								{
									sql: 'INSERT INTO repl_probe (k, v) VALUES (?, ?)',
									params: ['one', '1']
								},
								{
									sql: 'INSERT INTO repl_probe (k, v) VALUES (?, ?)',
									params: ['one', '2']
								}
							]
						})
					);
				} catch (e) {
					threw = String((e as Error)?.message ?? e);
				}
				const res = await site.fetch(new Request('https://do.local/__replica'));
				return {
					threw,
					rows: probeRows(site),
					report: (await res.json()) as Record<string, any>
				};
			});

			// THE CONTROL. An empty table is also what a record refused before it ran looks like, and
			// the two readings are opposite facts: this one has to be the constraint firing
			expect(out.threw.toLowerCase()).toMatch(/constraint|unique/);

			// nothing committed and the position did not move: cleanly valid at 0, which is the
			// property that makes a single-transaction record need no marker at all
			expect(out.rows).toEqual([]);
			expect(out.report.log.position.applied).toBe(0);
			expect(out.report.log.trust.trusted).toBe(true);
		},
		TIMEOUT
	);

	it(
		'refuses a record built at another pack and answers 409',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site, PACK);
				probeTable(site);
				const res = await site.fetch(
					new Request('https://do.local/__replica?action=apply', {
						method: 'POST',
						body: JSON.stringify(
							record({ generation: 1, schemaVersion: 'some-other-pack' })
						),
						headers: { 'content-type': 'application/json' }
					})
				);
				return {
					status: res.status,
					body: (await res.json()) as Outcome,
					rows: probeRows(site)
				};
			});

			expect(out.status).toBe(409);
			expect(out.body.action).toBe('refuse');
			expect(out.body.reason).toContain('schema mismatch');
			expect(out.rows).toEqual([]);
		},
		TIMEOUT
	);

	it(
		'refuses a GET on the apply action rather than treating it as a report',
		async () => {
			const status = await inObject(freshSite(), async (site) => {
				markProvisioned(site, PACK);
				const res = await site.fetch(
					new Request('https://do.local/__replica?action=apply')
				);
				return res.status;
			});
			expect(status).toBe(405);
		},
		TIMEOUT
	);

	it(
		'skips a re-delivery without replaying its statements',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site, PACK);
				probeTable(site);
				const first = await post(site, record({ generation: 1 }));
				// the same record again, as a retry after a lost response would deliver it
				const again = await post(site, record({ generation: 1 }));
				return { first, again, rows: probeRows(site) };
			});

			expect(out.first.action).toBe('apply');
			expect(out.again.action).toBe('duplicate');
			// two rows, not four, and not a primary-key failure that happens to look like safety
			expect(out.rows).toEqual(['one', 'two']);
		},
		TIMEOUT
	);
});
