import { describe, expect, it } from 'vitest';
import { readSourceTables, writeTargetTable } from '../../src/db/write-tally';
import { writeWorkload, type WriteWorkload } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * How much of the speculative replay a table-level filter could remove: measured at zero.
 *
 * It scores the lever and does not build it. `readSourceTables()` returns `null` for anything it
 * cannot parse and that counts as NOT skippable, so every figure here is a lower bound.
 */

const PASS = 'Sp3culative!Pass';
const REQUEST_TIMEOUT = 240_000;

type Payload = Record<string, unknown>;

const call = (site: ServeDo, path: string, init?: RequestInit) =>
	site.fetch(new Request(`https://do.local${path}`, init));

type Scored = {
	label: string;
	speculative: number;
	replayed: number;
	skippable: number;
	skippableStatements: number;
	unparseable: number;
	unattributed: number;
	overlap: number;
	withRead: number;
	noRead: number;
	/** WHY the driver refused to predict, per reason; the counts are the driver's own */
	refusals: Record<string, number>;
};

async function score(site: ServeDo, label: string, run: () => Promise<Payload>): Promise<Scored> {
	const spec0 = site.txnSpeculative ?? 0;
	const stmt0 = site.txnStatements ?? 0;
	const skip0 = site.txnSkippable ?? 0;
	const skipStmt0 = site.txnSkippableStatements ?? 0;
	const unparse0 = site.txnSkipUnparseable ?? 0;
	const unattr0 = site.txnSkipUnattributed ?? 0;
	const overlap0 = site.txnSkipOverlap ?? 0;
	const withRead0 = site.txnSpeculativeWithRead ?? 0;
	const noRead0 = site.txnSpeculativeNoRead ?? 0;
	const result = await run();
	if (result['ok'] !== true) {
		throw new Error(`${label} failed: ${String(result['error'] ?? JSON.stringify(result))}`);
	}
	const driver = (result['driver'] ?? {}) as Record<string, unknown>;
	return {
		label,
		refusals: (driver['refusals'] ?? {}) as Record<string, number>,
		speculative: (site.txnSpeculative ?? 0) - spec0,
		replayed: (site.txnStatements ?? 0) - stmt0,
		skippable: (site.txnSkippable ?? 0) - skip0,
		skippableStatements: (site.txnSkippableStatements ?? 0) - skipStmt0,
		unparseable: (site.txnSkipUnparseable ?? 0) - unparse0,
		unattributed: (site.txnSkipUnattributed ?? 0) - unattr0,
		overlap: (site.txnSkipOverlap ?? 0) - overlap0,
		withRead: (site.txnSpeculativeWithRead ?? 0) - withRead0,
		noRead: (site.txnSpeculativeNoRead ?? 0) - noRead0
	};
}

const workload = (site: ServeDo, op: WriteWorkload, seq: number, nid = 0) =>
	site.runJson(writeWorkload(op, { seq, nid })) as Promise<Payload>;

let cached: Promise<Scored[]> | null = null;

async function measure(): Promise<Scored[]> {
	return inObject(freshSite(), async (site: ServeDo) => {
		await call(site, '/__migrate?all=1&prefill=0');
		await call(site, '/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass: PASS, siteName: 'Speculative' }),
			headers: { 'content-type': 'application/json' }
		});
		// warm each op once, so a scored run pays for the operation and not for a cold cache
		const first = (await workload(site, 'node-create', 1)) as Payload;
		const nid = Number(first['id'] ?? 0);
		await workload(site, 'node-revision', 2, nid);
		await workload(site, 'user-create', 1);
		await workload(site, 'alias-create', 1, nid);

		const out: Scored[] = [];
		out.push(await score(site, 'node-create', () => workload(site, 'node-create', 11)));
		out.push(
			await score(site, 'node-revision', () => workload(site, 'node-revision', 12, nid))
		);
		out.push(await score(site, 'user-create', () => workload(site, 'user-create', 11)));
		out.push(await score(site, 'alias-create', () => workload(site, 'alias-create', 11, nid)));
		return out;
	});
}

const measured = () => (cached ??= measure());

describe('the table filter proposed for the speculative replay', () => {
	it(
		'reports the skippable share of every content write',
		async () => {
			const rows = await measured();
			const total = rows.reduce(
				(acc, r) => ({
					speculative: acc.speculative + r.speculative,
					replayed: acc.replayed + r.replayed,
					skippable: acc.skippable + r.skippable,
					skippableStatements: acc.skippableStatements + r.skippableStatements,
					unparseable: acc.unparseable + r.unparseable,
					unattributed: acc.unattributed + r.unattributed,
					overlap: acc.overlap + r.overlap,
					withRead: acc.withRead + r.withRead,
					noRead: acc.noRead + r.noRead
				}),
				{
					speculative: 0,
					replayed: 0,
					skippable: 0,
					skippableStatements: 0,
					unparseable: 0,
					unattributed: 0,
					overlap: 0,
					withRead: 0,
					noRead: 0
				}
			);
			console.log(
				JSON.stringify(
					{
						perOp: rows,
						total,
						skippableShareOfReplays:
							total.speculative > 0 ? total.skippable / total.speculative : null,
						skippableShareOfStatements:
							total.replayed > 0 ? total.skippableStatements / total.replayed : null
					},
					null,
					1
				)
			);
			// the instrument has to have seen the thing it is measuring; a zero here means the
			// counters never ran, which reads identically to "no opportunity" and is not the same
			expect(total.speculative).toBeGreaterThan(0);

			// every remaining replay is ONE reason and it is not the predicted one: three mechanisms
			// were proposed, and what is left is a table written twice inside one buffer
			const reasons = rows.reduce<Record<string, number>>((acc, r) => {
				for (const [k, v] of Object.entries(r.refusals ?? {})) {
					acc[k] = (acc[k] ?? 0) + v;
				}
				return acc;
			}, {});
			expect(Object.keys(reasons)).toEqual(['table-written-again']);
			expect(reasons['table-written-again']).toBeGreaterThan(0);
			expect(reasons['supplied-rowid-unreadable']).toBeUndefined();
			expect(total.replayed).toBeGreaterThan(0);

			// MEASURED 2026-08-27: 24 replays / 128 statements over four content writes, NONE
			// carrying a read -- so a read filter saves nothing. Predicting the AUTOINCREMENT id
			// from `sqlite_sequence` took it to 18 / 119; the residue supplies its own rowid.
			expect(total.withRead).toBe(0);
			expect(total.noRead).toBe(total.speculative);
			expect(total.skippable).toBe(0);
			// a regression here means the prediction stopped working and the replays came back
			expect(total.speculative).toBeLessThanOrEqual(18);
			expect(total.replayed).toBeLessThanOrEqual(119);
		},
		REQUEST_TIMEOUT
	);

	it('counts a read against an untouched table as skippable and one against a written table not', () => {
		// the classifier itself, driven directly, because the figure above is only as good as this
		expect(
			readable('SELECT nid FROM node WHERE nid = ?', ['INSERT INTO users_field_data'])
		).toBe(true);
		expect(readable('SELECT nid FROM node WHERE nid = ?', ['INSERT INTO node (nid)'])).toBe(
			false
		);
		// unparseable read, or a write whose table could not be attributed: never skippable
		expect(readable('WITH x AS (SELECT 1) SELECT * FROM x', ['INSERT INTO users'])).toBe(false);
		expect(readable('SELECT nid FROM node', ['PRAGMA table_info(node)'])).toBe(false);
	});
});

/** the same decision `execTxn()` makes, so the share above is not scored by a different rule */
function readable(readSql: string, writes: string[]): boolean {
	const read = readSourceTables(readSql);
	const written = writes.map((w) => writeTargetTable(w));
	if (!read || written.includes(null)) return false;
	const dirty = new Set(written.map((t) => String(t).toLowerCase()));
	return !read.some((t) => dirty.has(t.toLowerCase()));
}
