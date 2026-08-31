import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Enabling a Drupal module, and what one costs.
 *
 * IT RUNS HERE RATHER THAN UNDER `wrangler dev` BECAUSE THE HARNESS WAS THE LIMIT. An enable used to
 * take the dev process down -- two on separate sites succeeded and the third killed it -- with a
 * bare `✘ [ERROR]` from miniflare's proxy controller. That controller is a `wrangler dev` construct
 * and this lane has none: `runInDurableObject` reaches the instance in the process the test runs
 * in. The same enable survives here and answers a second request afterwards, which is what the
 * first two cases below pin.
 *
 * THE COST FIGURE MOVED 4.7x AND THE CAUSE WAS THE DRIVER, NOT DRUPAL. `token` measured **20,592
 * charged rows**, a fifth of the free plan's daily ceiling for one module, and 17,188 of those were
 * the router. That was never the table's price: a raw `DELETE` plus 419 reinserts costs 2,095. Core
 * `Insert::execute()` ends in `lastInsertId()`, a buffered insert has no rowid yet, and the driver
 * replayed the whole buffer to find one -- so the dumper's nine chunks re-applied and rolled back
 * the growing router eight times over. `RowidPlan` in the `cfw_do_sqlite` driver predicts the rowid
 * instead. Measured after: **4,427 rows, 422 router statements over 420 routes**, which is exactly
 * one DELETE and one insert per row.
 *
 * **THE 32-SECOND EDGE FAILURE WAS A LOCK, AND THE INSTALL WAS NEVER THE EXPENSIVE PART.** A
 * deployed enable was read as running out of CPU doing its own work. It was not:
 * `DatabaseLockBackend` stores `microtime(TRUE) + $timeout` as a lock's expiry and frees the row
 * when `microtime(TRUE)` passes it, and `microtime()` returns 0 on the edge -- so a row is written
 * with expire 30, tested against now 0, and never becomes free. `RouteBuilder::rebuild()` then
 * falls into `wait()`, which polls with `usleep()` for 30 seconds; there is no other thread to
 * yield to, so that spins and is billed as CPU. `CfwLockBackend` replaces it, because one site is
 * one Durable Object is one thread and the concurrent writer a lock excludes cannot be constructed.
 *
 * Measured on a throwaway `cfw-*` deploy, 2026-08-15, cpuTime from `wrangler tail`:
 *
 *   | build          |   n | median cpuTime | outcome                          |
 *   | database lock  |   6 |     32,500 ms  | `exceededCpu`, identical cap     |
 *   | CfwLockBackend |   3 |      6,810 ms  | completes, then storage resets   |
 *
 * and split one stage per invocation, since microtime() cannot time a phase from inside:
 *
 *   | stage (own invocation)     | median cpuTime | delta  |
 *   | boot only                  |      3,101 ms  | 3,101  |
 *   | + discovery, requirements  |      3,065 ms  | ~0     |
 *   | + moduleHandler->loadAll() |      5,240 ms  | +2,175 |
 *   | + the install itself       |      6,810 ms  | +1,570 |
 *
 * So the install is the SMALLEST component and boot is the largest. Rows were never the binding
 * constraint on this track and neither was the installer.
 *
 * THE +2,175 ROW IS RETRACTED, kept above only because the other rows come from the same run.
 * Timed directly in this lane, where `microtime()` works, `loadAll()` is **6 ms across 30 files**,
 * a second call is 0 ms, and the stage opens 29 more files than the one before it. A subtraction
 * of two whole-invocation totals at n=3 is not evidence about a call that measures 6 ms.
 *
 * **IT STILL DOES NOT LAND ON THE EDGE**, for a different and now-isolated reason: the invocation
 * completes the install -- "token module installed." appears in the tail -- and is then reset with
 * "Internal error in Durable Object storage caused object to be reset". Every row rolls back, so a
 * site that tried reads back at 420 routes with no `token` config. The per-record limit is not it
 * (the widest row is the 487,567-byte container, against 2,199,995); the open suspect is the ~4,400
 * rows and ~970 KB of container blobs landing in ONE implicit transaction, which is what
 * decomposing across invocations would split.
 */

const REQUEST_TIMEOUT = 600_000;

const call = (site: ServeDo, path: string) =>
	site.fetch(new Request(`https://do.local${path}`)).then((r) => r.json() as Promise<Payload>);

type Payload = Record<string, unknown>;

const migrate = (site: ServeDo, query = '?all=1&prefill=0') => call(site, `/__migrate${query}`);

const enable = (site: ServeDo, module: string) =>
	call(site, `/__enable?module=${encodeURIComponent(module)}`);

/** a SQL read, which is the cheapest possible proof the object is still answering */
const sql = (site: ServeDo, query: string) => call(site, `/__sql?q=${encodeURIComponent(query)}`);

describe('a module enable in the workers pool lane', () => {
	/**
	 * Step 1: survival. Everything else is gated on this.
	 */
	it(
		'enables token and the object still answers afterwards',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				const enabled = await enable(site, 'token');
				// the follow-up is what matters: under wrangler dev this never returned
				const after = await sql(site, 'SELECT COUNT(*) AS c FROM config');
				return { enabled, after };
			});

			expect(
				out.enabled['ok'],
				`enable did not succeed: ${JSON.stringify(out.enabled).slice(0, 500)}`
			).toBe(true);
			expect(out.enabled['discoverable']).toBe(true);
			// the object survived the install and answered a second request
			expect(out.after['ok'], 'the object stopped answering after the enable').toBe(true);
			expect(Number(out.enabled['rowsWritten'])).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * Step 1b: two enables in one object, which is where `wrangler dev` fell over hardest.
	 *
	 * Separated from the case above so a failure here is legible as "the second one" rather than
	 * being blamed on the first.
	 */
	it(
		'survives a second enable in the same object',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				const first = await enable(site, 'token');
				const second = await enable(site, 'ctools');
				const after = await sql(site, 'SELECT COUNT(*) AS c FROM config');
				return { first, second, after };
			});

			expect(out.first['ok']).toBe(true);
			expect(
				out.second['ok'],
				`the second enable failed: ${JSON.stringify(out.second).slice(0, 500)}`
			).toBe(true);
			expect(out.after['ok']).toBe(true);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * The affordability figure, and the regression guard on the router.
	 *
	 * A ROW COUNT, not a duration: per RULE 0 no absolute CPU number can come from a local run, and
	 * rows are what bind the regeneration ceiling anyway.
	 *
	 * The router assertion is the one with teeth. A rebuild is one DELETE plus one insert per row,
	 * so statements can only exceed rows by the handful of aliases -- and a quadratic replay shows
	 * up here as an order of magnitude rather than a few percent: the same enable measured **3,012**
	 * router statements over 421 rows before `RowidPlan`. Pinning statements rather than rows is
	 * intended; rows move when a schema gains an index, and that is a different finding.
	 */
	it(
		'reports what one enable costs in charged rows',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				return enable(site, 'token');
			});
			const rows = Number(out['rowsWritten'] ?? 0);
			const routerStatements = Number(out['routerStatements'] ?? 0);
			const routes = Number(out['routes'] ?? 0);
			expect(rows).toBeGreaterThan(0);
			// pinned loosely: this is a budget observation, not a regression pin on an exact number
			expect(rows).toBeLessThan(100_000);
			expect(routes).toBeGreaterThan(400);
			expect(
				routerStatements,
				`one dump is a DELETE plus a row each; ${routerStatements} over ${routes} routes is a replay`
			).toBeLessThanOrEqual(routes + 8);
			console.log(
				`[enable] token: ${rows} charged rows, ${Number(out['writeStatements'] ?? 0)} statements, ` +
					`${routerStatements} of them router over ${routes} routes\n` +
					JSON.stringify(out['byTable']).slice(0, 400)
			);
		},
		REQUEST_TIMEOUT
	);
});
