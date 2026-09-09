import { describe, expect, it } from 'vitest';
import { freshSite, inObject } from '../helpers/serve-do';

/**
 * Whether the COMMIT is what a write pays for, which B6 has to establish before optimising it.
 *
 * B6a proposes draining a batch of forwarded statement sets into one `transactionSync` with explicit
 * commit sequence numbers. The roadmap's own note on it is the right one: "the commit is not
 * currently the measured bottleneck, and per RULE 0 it should not be optimised before it is shown to
 * bind." So this measures whether it binds rather than building the batching.
 *
 * THE COMPARISON. N statements applied in one `transactionSync` against the same N applied in N
 * transactions. If per-transaction overhead dominated, the second arm would cost several times the
 * first and batching would be the lever; if the statements dominate, batching moves nothing and the
 * mechanism closes.
 *
 * ROWS RATHER THAN A CLOCK, and that is not a compromise. `Date.now()` does not advance across
 * synchronous work in a Worker -- the whole of RULE 0 -- so a duration taken around a
 * `transactionSync` here reads 0 and would be a fabricated measurement. Rows written IS the meter
 * this project is scored against, it is exact, and it answers the question directly: if a commit
 * costs rows of its own, batching removes them and the count differs. If it does not, there is
 * nothing for batching to remove.
 */

const TIMEOUT = 900_000;
const N = 40;

/**
 * The object's own transaction, reached through a narrow cast: `ServeDo` does not declare it.
 *
 * CALLED ON THE STORAGE OBJECT, not detached from it. Handing the bare method around gives
 * workerd's "Illegal invocation: function called with incorrect `this` reference", because the
 * binding is a host object and its methods are not free functions.
 */
function txn(site: unknown, fn: () => void): void {
	const storage = (site as { ctx: { storage: { transactionSync: (f: () => void) => void } } }).ctx
		.storage;
	storage.transactionSync(fn);
}

describe('what a commit costs, before anything is built to make it cheaper', () => {
	it(
		'charges the same rows whether the statements share one transaction or take N',
		async () => {
			const stub = freshSite();
			const out = await inObject(stub, (site) => {
				site.ensureServeTables();
				site.sql.exec(
					'CREATE TABLE IF NOT EXISTS cfw_commit_probe (k INTEGER PRIMARY KEY, v TEXT) WITHOUT ROWID'
				);

				const before = site.dailyRows();
				txn(site, () => {
					for (let i = 0; i < N; i++) {
						site.sql.exec('INSERT INTO cfw_commit_probe (k, v) VALUES (?, ?)', i, 'x');
					}
				});
				const batched = site.dailyRows() - before;

				const mid = site.dailyRows();
				for (let i = 0; i < N; i++) {
					txn(site, () => {
						site.sql.exec(
							'INSERT INTO cfw_commit_probe (k, v) VALUES (?, ?)',
							N + i,
							'x'
						);
					});
				}
				const individual = site.dailyRows() - mid;

				return { batched, individual };
			});

			// the control: the probe actually wrote something, so an equality below is not two zeros
			expect(out.batched, 'the batched arm wrote nothing').toBeGreaterThanOrEqual(N);
			expect(out.individual).toBeGreaterThanOrEqual(N);

			// THE FINDING. A commit charges no rows of its own, so N transactions cost exactly what
			// one costs and batching has nothing to remove from this meter
			expect(
				out.individual,
				`one transaction charged ${out.batched} rows and ${N} charged ${out.individual}`
			).toBe(out.batched);
		},
		TIMEOUT
	);

	it(
		'and the statements are what the rows are charged for',
		async () => {
			// the other half: doubling the statements doubles the cost, so the per-statement term is
			// the one that binds. An optimisation aimed anywhere else is aimed at 0
			const stub = freshSite();
			const out = await inObject(stub, (site) => {
				site.ensureServeTables();
				site.sql.exec(
					'CREATE TABLE IF NOT EXISTS cfw_commit_probe2 (k INTEGER PRIMARY KEY, v TEXT) WITHOUT ROWID'
				);
				const before = site.dailyRows();
				txn(site, () => {
					for (let i = 0; i < N; i++) {
						site.sql.exec('INSERT INTO cfw_commit_probe2 (k, v) VALUES (?, ?)', i, 'x');
					}
				});
				const one = site.dailyRows() - before;
				const mid = site.dailyRows();
				txn(site, () => {
					for (let i = 0; i < N * 2; i++) {
						site.sql.exec(
							'INSERT INTO cfw_commit_probe2 (k, v) VALUES (?, ?)',
							N + i,
							'x'
						);
					}
				});
				const two = site.dailyRows() - mid;
				return { one, two };
			});
			expect(out.two).toBeGreaterThan(out.one);
			// linear in the statement count, within the slack a counter that also records its own
			// flushes leaves
			expect(out.two / out.one).toBeGreaterThan(1.5);
			expect(out.two / out.one).toBeLessThan(2.5);
		},
		TIMEOUT
	);
});
