import { describe, expect, it } from 'vitest';
import type { Sql } from '../../helpers/serve-do';
import { freshSite, inObject } from '../../helpers/serve-do';
import { SHIPPED } from '../../helpers/shipped-ddl';

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
 * on the schema that shipped THEN was **5 rows per route** -- 1 to delete, 4 to insert -- so one
 * rebuild was 2,095 rows and the enable paid for about **eight of them**. The cost is a REPEAT,
 * and the lever is stopping it, not splitting it.
 *
 * The alias index is now PARTIAL, which takes a rebuild to **1,693**. That lever was priced in this
 * file for months before anything applied it; the control below is what keeps the price honest.
 *
 * The per-route figures are pinned exactly rather than bounded, because they are the whole finding
 * and a bound would let the asymmetry drift unnoticed. If Cloudflare changes how index entries are
 * billed, this file going red is the correct outcome: every conclusion above moves with it.
 */

/** the router table exactly as the pack ships it; `index-audit.spec.ts` holds it to that */
const ROUTER_DDL = SHIPPED['router']?.ddl as string[];

/** the index as core declares it, kept only as the control that prices the partial form */
const FULL_ALIAS_DDL = `CREATE INDEX "router_alias" ON "router" ("alias")`;

/** the measured route count of the packed site, which is what turns rows into rows-per-route */
const REAL_ROUTES = 419;

/** routes carrying a non-null `alias`, counted in the packed database: 17 of 419 */
const ROUTES_WITH_ALIAS = 17;

/** rows a rebuild wrote on the edge, `router` only, from the module-enable measurement */
const MEASURED_ROUTER_ROWS = 17_188;

/**
 * Rows one rebuild charged per route BEFORE the alias index became partial: 1 to delete, 4 to
 * re-insert.
 *
 * The 4 is the table row plus three index entries -- `PRIMARY KEY (name)`,
 * `router_pattern_outline_parts` and `router_alias`. Kept as the baseline every saving is measured
 * against, and as the arithmetic that reconciles 17,188.
 */
const ROWS_PER_ROUTE_FULL_INDEX = 5;

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

/** the alias pass writes 3 columns, so 33 rows is 99 parameters */
const ALIASES_PER_STATEMENT = 33;

/** creates the table, with the shipped partial alias index or core's full one */
function createRouter(sql: Sql, opts: { indexes?: boolean; fullAlias?: boolean } = {}) {
	sql.exec('DROP TABLE IF EXISTS router');
	sql.exec(ROUTER_DDL[0] as string);
	if (opts.indexes === false) return;
	sql.exec(ROUTER_DDL[1] as string);
	sql.exec(opts.fullAlias ? FULL_ALIAS_DDL : (ROUTER_DDL[2] as string));
}

/**
 * The routes pass: 6 columns, no alias, so every row it writes stores a NULL there.
 *
 * This is `MatcherDumper::dump()` lines 110-143 verbatim in shape. It is the pass that writes 402
 * of the packed table's 419 rows.
 */
function insertRoutes(sql: Sql, rows: number): number {
	let inserted = 0;
	for (let start = 0; start < rows; start += ROUTES_PER_STATEMENT) {
		const size = Math.min(ROUTES_PER_STATEMENT, rows - start);
		const tuples: string[] = [];
		const binds: unknown[] = [];
		for (let i = 0; i < size; i++) {
			const n = start + i;
			tuples.push('(?, ?, ?, ?, ?, ?)');
			binds.push(`route.${n}`, `/path/${n}/{arg}`, `/path/${n}/%`, 1, routeBlob(n), 3);
		}
		inserted += (
			sql.exec(
				`INSERT INTO router (name, path, pattern_outline, fit, route, number_parts) VALUES ${tuples.join(', ')}`,
				...binds
			) as Cursor
		).rowsWritten;
	}
	return inserted;
}

/**
 * The alias pass: 3 columns, and the only rows in the table that store a non-null alias.
 *
 * `MatcherDumper::dump()` lines 146-161. These are the rows a partial index still pays for.
 */
function insertAliases(sql: Sql, rows: number): number {
	let inserted = 0;
	for (let start = 0; start < rows; start += ALIASES_PER_STATEMENT) {
		const size = Math.min(ALIASES_PER_STATEMENT, rows - start);
		const tuples: string[] = [];
		const binds: unknown[] = [];
		for (let i = 0; i < size; i++) {
			const n = start + i;
			tuples.push('(?, ?, ?)');
			binds.push(`alias.${n}`, routeBlob(n), `target.route.${n}`);
		}
		inserted += (
			sql.exec(
				`INSERT INTO router (name, route, alias) VALUES ${tuples.join(', ')}`,
				...binds
			) as Cursor
		).rowsWritten;
	}
	return inserted;
}

/** builds the table and fills it the way core does, returning the insert cost */
function seedRouter(
	sql: Sql,
	rows: number,
	opts: { indexes?: boolean; fullAlias?: boolean; aliases?: number } = {}
) {
	createRouter(sql, opts);
	const aliases = opts.aliases ?? 0;
	return insertRoutes(sql, rows - aliases) + insertAliases(sql, aliases);
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
		expect(withIndexes).toBeGreaterThan(withoutIndexes);
		// ONE secondary index bills these rows, not two: they all store a NULL alias, and the
		// shipped alias index is partial
		expect((withIndexes - withoutIndexes) / 100).toBe(1);
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
			const inserted = seedRouter(site.sql, 100, { fullAlias: true });
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

	it('cost 5 rows per route on the full index, of which 3 were index maintenance', async () => {
		const cost = await inObject(freshSite(), (site) => {
			seedRouter(site.sql, 100, { fullAlias: true });
			const deleted = (site.sql.exec('DELETE FROM router') as Cursor).rowsWritten;
			// core re-inserts into the SAME table inside the same transaction
			const second = insertRoutes(site.sql, 100);
			return { deleted, second };
		});
		expect(cost.deleted + cost.second).toBe(500);
		expect((cost.deleted + cost.second) / 100).toBe(ROWS_PER_ROUTE_FULL_INDEX);
	});
});

describe('reconciling 17,188 against 419 real routes', () => {
	it('shows ONE rebuild cannot account for it, so the enable rebuilds repeatedly', async () => {
		const perRebuild = await inObject(freshSite(), (site) => {
			const inserted = seedRouter(site.sql, REAL_ROUTES, { fullAlias: true });
			const deleted = (site.sql.exec('DELETE FROM router') as Cursor).rowsWritten;
			return inserted + deleted;
		});

		expect(perRebuild).toBe(REAL_ROUTES * ROWS_PER_ROUTE_FULL_INDEX);

		// THE FINDING, and it reverses what the roadmap recorded. "One non-resumable burst" was
		// wrong about the SHAPE of the cost: one rebuild of the real table is 2,095 rows, and the
		// enable wrote 17,188. The expensive thing is being REPEATED, roughly eight times, not
		// being large. That matters because it moves the lever: you cannot split an atomic
		// transaction, but you can stop running it eight times.
		expect(MEASURED_ROUTER_ROWS / perRebuild).toBeGreaterThan(6);
		expect(MEASURED_ROUTER_ROWS / perRebuild).toBeLessThan(10);
	});

	it('makes the eightfold repeat, not the rebuild size, the biggest single lever', () => {
		const perRebuild = REAL_ROUTES * ROWS_PER_ROUTE_FULL_INDEX;
		const wasted = MEASURED_ROUTER_ROWS - perRebuild;
		// a single rebuild would be 12% of what an enable pays for the router today
		expect(perRebuild / MEASURED_ROUTER_ROWS).toBeLessThan(0.13);
		// collapsing the repeats to one recovers ~74% of the WHOLE enable, since router is 84%
		expect(wasted / 20_533).toBeGreaterThan(0.7);
	});
});

/**
 * The index lever, measured on the shipped schema against core's own as the control.
 *
 * This block used to price a partial index that nothing created. It now measures the one that
 * ships, so the saving is a reading rather than a projection.
 */
describe('the partial alias index, measured against the full one it replaced', () => {
	it('bills the full index on all 419 routes though only 17 carry an alias', async () => {
		const cost = await inObject(freshSite(), (site) => {
			const full = seedRouter(site.sql, REAL_ROUTES, {
				fullAlias: true,
				aliases: ROUTES_WITH_ALIAS
			});
			const bare = seedRouter(site.sql, REAL_ROUTES, {
				indexes: false,
				aliases: ROUTES_WITH_ALIAS
			});
			return { full, bare };
		});
		// two secondary indexes, one row each, on every route
		expect(cost.full - cost.bare).toBe(REAL_ROUTES * 2);
		// the alias half of that is charged against rows that are 96% NULL
		expect(ROUTES_WITH_ALIAS / REAL_ROUTES).toBeLessThan(0.05);
	});

	it('charges the shipped index only on the 17 rows that store an alias', async () => {
		const cost = await inObject(freshSite(), (site) => {
			const partial = seedRouter(site.sql, REAL_ROUTES, { aliases: ROUTES_WITH_ALIAS });
			const bare = seedRouter(site.sql, REAL_ROUTES, {
				indexes: false,
				aliases: ROUTES_WITH_ALIAS
			});
			return { partial, bare };
		});
		// pattern_outline on all 419, plus alias on 17 only
		expect(cost.partial - cost.bare).toBe(REAL_ROUTES + ROUTES_WITH_ALIAS);
	});

	it('takes a full rebuild from 2,095 charged rows to 1,693', async () => {
		const cost = await inObject(freshSite(), (site) => {
			const full = seedRouter(site.sql, REAL_ROUTES, {
				fullAlias: true,
				aliases: ROUTES_WITH_ALIAS
			});
			const fullDeleted = (site.sql.exec('DELETE FROM router') as Cursor).rowsWritten;
			const partial = seedRouter(site.sql, REAL_ROUTES, { aliases: ROUTES_WITH_ALIAS });
			const partialDeleted = (site.sql.exec('DELETE FROM router') as Cursor).rowsWritten;
			return {
				full: full + fullDeleted,
				partial: partial + partialDeleted
			};
		});

		expect(cost.full).toBe(2095);
		expect(cost.partial).toBe(1693);
		// 402 rows off every rebuild, which is the 402 routes that store a NULL and not all 419
		expect(cost.full - cost.partial).toBe(402);
		expect((cost.full - cost.partial) / cost.full).toBeCloseTo(0.192, 3);
	});

	it('keeps the lookup the index exists for, and gives up only the IS NULL scan', async () => {
		const plans = await inObject(freshSite(), (site) => {
			createRouter(site.sql, {});
			// toArray() rather than spreading the cursor: it is iterable at runtime but the type
			// does not declare `[Symbol.iterator]`, which only the tests tsconfig catches
			const read = (q: string) =>
				site.sql
					.exec(q)
					.toArray()
					.map((r) => String((r as { detail: string }).detail))
					.join(' ');
			return {
				// RouteProvider::getRouteAliases() -- implies the predicate, so the index applies
				lookup: read(`EXPLAIN QUERY PLAN SELECT name FROM router WHERE alias = 'x'`),
				// RouteProvider::getAllRoutes() -- returns 402 of 419 rows and now scans
				enumerate: read(
					`EXPLAIN QUERY PLAN SELECT name, route FROM router WHERE alias IS NULL`
				)
			};
		});

		expect(plans.lookup).toContain('router_alias');
		expect(plans.enumerate).not.toContain('router_alias');
		expect(plans.enumerate).toContain('SCAN');
	});
});
