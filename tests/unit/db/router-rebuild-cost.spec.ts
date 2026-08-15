import { describe, expect, it } from 'vitest';
import type { Sql } from '../../helpers/serve-do';
import { freshSite, inObject } from '../../helpers/serve-do';

/**
 * What a router rebuild actually costs on the meter that binds regeneration, and whether
 * splitting it would help.
 *
 * A module enable measured 20,533 rows written, of which `router` was
 * **17,188 (84%)**, and the roadmap recorded that as "one non-resumable burst" with an open
 * question: can it be chunked? Two facts settle it and neither needed a deploy.
 *
 * FIRST, core already chunks it, and the chunk boundary is not where the cost is.
 * `MatcherDumper::dump()` splits the inserts at 50 (`core/lib/Drupal/Core/Routing/
 * MatcherDumper.php:108`) and wraps **every chunk plus the opening full-table DELETE** in one
 * transaction, with the reason in the source: "The transaction makes it atomic to avoid unstable
 * router states due to random failures." Splitting across Durable Object invocations would commit
 * the DELETE, so a request landing between two alarms matches nothing -- a 404 site, not a slow
 * one. Chunking is therefore already done, and doing it harder is a correctness regression that
 * saves nothing: the meter counts rows, and the same rows are written either way.
 *
 * SECOND, and this is the part that had to be measured rather than reasoned: the site has **419
 * routes**, so 17,188 rows would be **41 rows per route**. A delete-then-insert cycle cannot
 * produce that unless something multiplies it, and a factor of 41 is a claim about the meter, not
 * about Drupal. Measured here against real Durable Object SQL with the packed schema, one rebuild
 * is **5 rows per route** -- 1 to delete, 4 to insert -- so one rebuild is 2,095 rows and the
 * enable paid for about **eight of them**. The cost is a REPEAT, and the lever is stopping it, not
 * splitting it.
 *
 * The per-route figures are pinned exactly rather than bounded, because they are the whole finding
 * and a bound would let the asymmetry drift unnoticed. If Cloudflare changes how index entries are
 * billed, this file going red is the correct outcome: every conclusion above moves with it.
 */

/** the router table exactly as it exists in `assets/drupal/site.sqlite`, read out of sqlite_master */
const ROUTER_DDL = [
	`CREATE TABLE "router" (
		"name" VARCHAR(255) NOT NULL DEFAULT '',
		"path" VARCHAR(255) NOT NULL DEFAULT '',
		"pattern_outline" VARCHAR(255) NOT NULL DEFAULT '',
		"fit" INTEGER NOT NULL DEFAULT 0,
		"route" BLOB DEFAULT NULL,
		"number_parts" INTEGER NOT NULL DEFAULT 0,
		"alias" VARCHAR(255) DEFAULT NULL,
		PRIMARY KEY ("name")
	)`,
	`CREATE INDEX "router_pattern_outline_parts" ON "router" ("pattern_outline", "number_parts")`,
	`CREATE INDEX "router_alias" ON "router" ("alias")`
];

/** the measured route count of the packed site, which is what turns rows into rows-per-route */
const REAL_ROUTES = 419;

/** rows a rebuild wrote on the edge, `router` only, from the module-enable measurement */
const MEASURED_ROUTER_ROWS = 17_188;

/**
 * Rows one rebuild charges per route: 1 to delete it, 4 to re-insert it.
 *
 * The 4 is the table row plus three index entries -- `PRIMARY KEY (name)`,
 * `router_pattern_outline_parts` and `router_alias` -- so **60% of a rebuild is index
 * maintenance** and only 20% is the route data itself.
 */
const ROWS_PER_ROUTE_REBUILD = 5;

/** routes carrying a non-null `alias`, counted in the packed database: 17 of 419 */
const ROUTES_WITH_ALIAS = 17;

type Cursor = { rowsWritten: number };

/**
 * A serialized Symfony Route is the `route` blob and it is not small; a 4-byte stand-in would
 * measure a different storage shape. 900 bytes is the median of the packed table.
 */
function routeBlob(n: number): string {
	return `O:31:"Symfony\\Component\\Routing\\Route":${n}:` + 'x'.repeat(900);
}

/**
 * Routes per INSERT statement, and it is NOT core's 50.
 *
 * `MatcherDumper` chunks at 50 rows over 6 fields, which is 300 bound parameters, and Durable
 * Object SQLite refuses anything over 100 -- the first draft of this spec died on "too many SQL
 * variables at offset 415" before measuring anything. So core's own chunk size is unusable here
 * and the driver's re-chunking is load-bearing rather than an optimisation: 16 rows is 96
 * parameters, the largest whole route that fits.
 */
const ROUTES_PER_STATEMENT = 16;

/** builds the table, optionally without the two secondary indexes, and returns the write cost */
function seedRouter(sql: Sql, rows: number, opts: { indexes?: boolean } = {}) {
	const withIndexes = opts.indexes !== false;
	sql.exec('DROP TABLE IF EXISTS router');
	sql.exec(ROUTER_DDL[0] as string);
	if (withIndexes) {
		sql.exec(ROUTER_DDL[1] as string);
		sql.exec(ROUTER_DDL[2] as string);
	}

	let inserted = 0;
	for (let start = 0; start < rows; start += ROUTES_PER_STATEMENT) {
		const size = Math.min(ROUTES_PER_STATEMENT, rows - start);
		const tuples: string[] = [];
		const binds: unknown[] = [];
		for (let i = 0; i < size; i++) {
			const n = start + i;
			tuples.push('(?, ?, ?, ?, ?, ?)');
			binds.push(
				`route.${n}`,
				`/path/${n}/{arg}`,
				`/path/${n}/%`,
				(1 << (n % 5)) | 1,
				routeBlob(n),
				3
			);
		}
		const cursor = sql.exec(
			`INSERT INTO router (name, path, pattern_outline, fit, route, number_parts) VALUES ${tuples.join(', ')}`,
			...binds
		) as Cursor;
		inserted += cursor.rowsWritten;
	}
	return inserted;
}

describe('what one router row costs in Durable Object SQL', () => {
	it('charges MORE than one row per inserted route, because indexes are rows too', async () => {
		const cost = await inObject(freshSite(), (site) => seedRouter(site.sql, 100));
		// 100 logical routes, but the meter sees the table row plus every index entry
		expect(cost).toBeGreaterThan(100);
		expect(cost % 100).toBe(0);
	});

	it('names the per-route multiplier, and it is the index count plus the row', async () => {
		const withIndexes = await inObject(freshSite(), (site) => seedRouter(site.sql, 100));
		const withoutIndexes = await inObject(freshSite(), (site) =>
			seedRouter(site.sql, 100, { indexes: false })
		);
		// the bare table still costs more than one per row (the PRIMARY KEY is itself an index)
		expect(withoutIndexes / 100).toBeGreaterThanOrEqual(1);
		// each secondary index adds its own entry per row
		expect(withIndexes).toBeGreaterThan(withoutIndexes);
		expect((withIndexes - withoutIndexes) / 100).toBe(2);
	});

	it('scales linearly in routes, so the cost is per-row and not per-statement', async () => {
		const [small, large] = await inObject(freshSite(), (site) => [
			seedRouter(site.sql, 50),
			seedRouter(site.sql, 200)
		]);
		expect(large).toBe((small as number) * 4);
	});
});

describe('the delete half, which is what makes a rebuild a rebuild', () => {
	it('charges ONE row per route to empty the table, not one per index entry', async () => {
		const cost = await inObject(freshSite(), (site) => {
			const inserted = seedRouter(site.sql, 100);
			const deleted = (site.sql.exec('DELETE FROM router') as Cursor).rowsWritten;
			return { inserted, deleted };
		});
		// THE ASYMMETRY, and it was worth measuring because the obvious guess is wrong. An
		// INSERT is charged for the table row AND every index entry it creates; a DELETE of the
		// same rows is charged once per row and nothing for tearing those index entries down.
		// So a rebuild is not 2x an install -- it is 1.25x, and all of the head-room is on the
		// insert side.
		expect(cost.deleted).toBe(100);
		expect(cost.inserted).toBe(400);
	});

	it('makes a full rebuild cost 5 rows per route, of which 3 are index maintenance', async () => {
		const cost = await inObject(freshSite(), (site) => {
			const first = seedRouter(site.sql, 100);
			const deleted = (site.sql.exec('DELETE FROM router') as Cursor).rowsWritten;
			// core re-inserts into the SAME table inside the same transaction
			let second = 0;
			for (let start = 0; start < 100; start += ROUTES_PER_STATEMENT) {
				const tuples: string[] = [];
				const binds: unknown[] = [];
				for (let i = 0; i < Math.min(ROUTES_PER_STATEMENT, 100 - start); i++) {
					const n = start + i;
					tuples.push('(?, ?, ?, ?, ?, ?)');
					binds.push(
						`route.${n}`,
						`/path/${n}/{arg}`,
						`/path/${n}/%`,
						1,
						routeBlob(n),
						3
					);
				}
				second += (
					sqlExec(
						site.sql,
						`INSERT INTO router (name, path, pattern_outline, fit, route, number_parts) VALUES ${tuples.join(', ')}`,
						binds
					) as Cursor
				).rowsWritten;
			}
			return { first, deleted, second };
		});
		// one rebuild over 100 routes: 100 deleted + 400 inserted
		expect(cost.deleted + cost.second).toBe(500);
		expect((cost.deleted + cost.second) / 100).toBe(ROWS_PER_ROUTE_REBUILD);
	});
});

/** binds an array without spreading at every call site */
function sqlExec(sql: Sql, text: string, binds: unknown[]) {
	return sql.exec(text, ...binds);
}

describe('reconciling 17,188 against 419 real routes', () => {
	it('shows ONE rebuild cannot account for it, so the enable rebuilds repeatedly', async () => {
		const perRebuild = await inObject(freshSite(), (site) => {
			const inserted = seedRouter(site.sql, REAL_ROUTES);
			const deleted = (site.sql.exec('DELETE FROM router') as Cursor).rowsWritten;
			return inserted + deleted;
		});

		expect(perRebuild).toBe(REAL_ROUTES * ROWS_PER_ROUTE_REBUILD);

		// THE FINDING, and it reverses what the roadmap recorded. "One non-resumable burst" was
		// wrong about the SHAPE of the cost: one rebuild of the real table is 2,095 rows, and the
		// enable wrote 17,188. The expensive thing is being REPEATED, roughly eight times, not
		// being large. That matters because it moves the lever: you cannot split an atomic
		// transaction, but you can stop running it eight times.
		expect(MEASURED_ROUTER_ROWS / perRebuild).toBeGreaterThan(6);
		expect(MEASURED_ROUTER_ROWS / perRebuild).toBeLessThan(10);
	});

	it('makes the eightfold repeat, not the rebuild size, the biggest single lever', async () => {
		const perRebuild = REAL_ROUTES * ROWS_PER_ROUTE_REBUILD;
		const wasted = MEASURED_ROUTER_ROWS - perRebuild;
		// a single rebuild would be 12% of what an enable pays for the router today
		expect(perRebuild / MEASURED_ROUTER_ROWS).toBeLessThan(0.13);
		// collapsing the repeats to one recovers ~74% of the WHOLE enable, since router is 84%
		expect(wasted / 20_533).toBeGreaterThan(0.7);
	});
});

describe('the index lever, priced rather than asserted', () => {
	it('charges the alias index on all 419 routes though only 17 carry an alias', async () => {
		const cost = await inObject(freshSite(), (site) => {
			const full = seedRouter(site.sql, REAL_ROUTES);
			const bare = seedRouter(site.sql, REAL_ROUTES, { indexes: false });
			return { full, bare };
		});
		// two secondary indexes, one row each, on every route
		expect(cost.full - cost.bare).toBe(REAL_ROUTES * 2);
		// the alias half of that is charged against rows that are 96% NULL
		expect(ROUTES_WITH_ALIAS / REAL_ROUTES).toBeLessThan(0.05);
	});

	it('shows a PARTIAL alias index charges only the routes that have one', async () => {
		const cost = await inObject(freshSite(), (site) => {
			// bare table plus the pattern index, then a partial alias index: the form that
			// still serves `condition('alias', $name)` in RouteProvider::getRouteAliases()
			// while storing nothing for the 402 NULL rows
			sqlExec(site.sql, 'DROP TABLE IF EXISTS router', []);
			site.sql.exec(ROUTER_DDL[0] as string);
			site.sql.exec(ROUTER_DDL[1] as string);
			site.sql.exec(
				`CREATE INDEX "router_alias" ON "router" ("alias") WHERE "alias" IS NOT NULL`
			);
			let inserted = 0;
			for (let start = 0; start < REAL_ROUTES; start += ROUTES_PER_STATEMENT) {
				const size = Math.min(ROUTES_PER_STATEMENT, REAL_ROUTES - start);
				const tuples: string[] = [];
				const binds: unknown[] = [];
				for (let i = 0; i < size; i++) {
					const n = start + i;
					tuples.push('(?, ?, ?, ?, ?, ?)');
					binds.push(
						`route.${n}`,
						`/path/${n}/{arg}`,
						`/path/${n}/%`,
						1,
						routeBlob(n),
						3
					);
				}
				inserted += (
					sqlExec(
						site.sql,
						`INSERT INTO router (name, path, pattern_outline, fit, route, number_parts) VALUES ${tuples.join(', ')}`,
						binds
					) as Cursor
				).rowsWritten;
			}
			return inserted;
		});

		// every route is NULL-aliased here, so the partial index stores nothing at all and the
		// insert falls from 4 rows per route to 3 -- a 25% cut on the insert side
		expect(cost).toBe(REAL_ROUTES * 3);
	});
});
