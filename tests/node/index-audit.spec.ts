import { beforeAll, describe, expect, it } from 'vitest';
import {
	auditSchema,
	chargePerInsertedRow,
	loadPack,
	parseCreateIndex,
	parseCreateTable,
	RECORDED_FILL_CHARGED_ROWS,
	type Audit
} from '../../scripts/measure/index-audit';
import { splitChargedRows } from '../../src/db/write-tally';
import { CFW_PAGE_DDL, SHIPPED } from '../helpers/shipped-ddl';
import { artifactGate } from './helpers/artifact-gate';

/**
 * The index audit against the schema that actually ships.
 *
 * The charge model is measured in workerd (`tests/unit/db/index-charge-model.spec.ts`); what cannot
 * be done there is read `assets/drupal-sql/`, so the two halves are split by lane. This one pins the
 * figures the report quotes -- 419 routes, 402 of them with a NULL alias, 14 cache bins at 4x -- so
 * that a schema change upstream fails here instead of quietly invalidating a conclusion.
 *
 * It also guards the DDL the workers lane measures against: those strings are copied out of the pack
 * and cannot be re-read there, so the two are compared by parsed shape here. Whitespace is free to
 * differ; an index is not.
 */

const SKIP = artifactGate(['assets/drupal-sql']);

/** the shipped route count, and the denominator for every router figure */
const ROUTES = 419;

let audit: Audit;

beforeAll(async () => {
	if (SKIP) return;
	audit = auditSchema(await loadPack('assets/drupal-sql'));
});

describe.skipIf(SKIP)('the shipped schema, counted', () => {
	it('carries 71 tables and 157 CREATE INDEX, matching the pack manifest', () => {
		expect(audit.totals.tables).toBe(71);
		expect(audit.totals.explicitIndexes).toBe(157);
	});

	it('has NO table that charges 1.0 rows per row, so the floor is 2 and not 1', () => {
		expect(audit.perTable.filter((t) => t.chargePerRow === 1)).toHaveLength(0);
		expect(audit.totals.minChargePerRow).toBe(2);
	});

	it('spends five eighths of every stored row on index maintenance', () => {
		// 1,342 / 3,939 / 0.6314 before the content type, 1,356 / 3,967 / 0.6305 after it. Enabling
		// drupflare in the pack took 40 stale cache rows OUT -- rows keyed to the pre-install module
		// list, which the runtime would have read as warm and wrong -- so the count falls while the
		// ratio rises: a cache row is cheap in indexes and dropping it leaves the index-heavy tables
		// a larger share. 3,883 -> 3,464 is the partial router_alias index
		expect(audit.totals.dataRows).toBe(1316);
		expect(audit.totals.chargedRows).toBe(3464);
		expect(audit.totals.indexRows / audit.totals.chargedRows).toBeCloseTo(0.5883, 3);
	});

	/**
	 * The model prices a row that matches NO partial predicate, and that is a lower bound.
	 *
	 * `chargePerInsertedRow()` drops partial indexes from the count outright, which is exact for the
	 * 402 routes storing a NULL alias and wrong by one for the 17 that carry one. Pinned here rather
	 * than corrected in the model: per INSERTED row the model is right, because the row being priced
	 * either matches the predicate or does not, and the audit cannot know which until it counts.
	 */
	it('under-reports the shipped total by exactly the rows a partial index does store', () => {
		const aliased = ROUTES - 402;
		expect(aliased).toBe(17);
		expect(audit.totals.chargedRows + aliased).toBe(3481);
	});
});

/**
 * The alias index, after the lever was applied rather than priced.
 *
 * This block used to assert that `router_alias` was a full index over rows that are 96% NULL, and
 * to price what a partial one WOULD save. `CfwMatcherDumper::ensurePartialAliasIndex()` now makes
 * it partial and the pack ships it that way, so the same facts are asserted from the other side:
 * the index is partial, the saving is realised, and the sweep that found it no longer lists it.
 */
describe.skipIf(SKIP)('router_alias, now partial in the pack that ships', () => {
	it('ships as a partial index rather than one entry per route', () => {
		const index = (audit.indexesByTable.get('router') ?? []).find(
			(i) => i.name === 'router_alias'
		);
		expect(index, 'the pack must still carry an alias index at all').toBeDefined();
		expect(index?.partial, 'a full index here is the regression this guards').toBe(true);
	});

	it('drops the router charge from 4 rows per route to 3', () => {
		const router = audit.perTable.find((t) => t.table === 'router');
		expect(router?.dataRows).toBe(ROUTES);
		expect(router?.chargePerRow).toBe(3);
	});

	it('takes 402 charged rows off every full rebuild, and not 419', () => {
		// a rebuild is 1 DELETE row + the insert charge per route. Before: 5 * 419 = 2,095. After,
		// the 402 NULL routes pay 4 and the 17 aliased ones still pay 5, because a partial index
		// stores an entry for a row that MATCHES it
		const before = ROUTES * 5;
		const aliased = 17;
		const after = (ROUTES - aliased) * 4 + aliased * 5;
		expect(before).toBe(2095);
		expect(after).toBe(1693);
		expect(before - after).toBe(402);
		expect((before - after) / before).toBeCloseTo(0.192, 3);
	});

	it('finds the sparse indexes by measurement, so a new one cannot hide', () => {
		// the sweep is over every single-column index in the schema, not a lookup of a known name,
		// and it skips indexes that are ALREADY partial -- so this list is the remaining candidates
		expect(audit.sparse.map((s) => s.index)).toEqual(['users_field_data_user_field__mail']);
	});
});

/**
 * READ `savedPerRewrite`, NOT `nullFraction`. The one remaining candidate is a false positive.
 *
 * `users_field_data_user_field__mail` reports 50% NULL, which reads like the router finding and is
 * nothing like it: the table ships TWO rows, anonymous with a NULL mail and admin with one. The
 * fraction is a fact about a 2-row sample, not a prediction, and every user a real site registers
 * arrives WITH a mail -- so the partial form would save one charged row once and never again, while
 * giving up the `IS NULL` lookup the way router did.
 *
 * Pinned so the next sweep of this list does not apply the lever on the strength of a percentage.
 */
describe.skipIf(SKIP)('the remaining sparse index, and why it is left alone', () => {
	it('is sparse only because the table ships two rows', () => {
		const mail = audit.sparse.find((s) => s.index === 'users_field_data_user_field__mail');
		expect(mail?.rows).toBe(2);
		expect(mail?.nullRows).toBe(1);
		expect(mail?.nullFraction).toBe(0.5);
	});

	it('would save ONE charged row, against router_alias 402', () => {
		const mail = audit.sparse.find((s) => s.index === 'users_field_data_user_field__mail');
		expect(mail?.savedPerRewrite).toBe(1);
		// the ranking is by rows saved rather than by fraction, which is what keeps this honest
		expect(audit.sparse[0]?.savedPerRewrite).toBe(1);
	});
});

describe.skipIf(SKIP)('the cache bins, which are the fill path', () => {
	it('ships 14 bins, and 13 of them now charge 2 rows per stored row rather than 4', () => {
		// the 26 secondary indexes are gone: nothing on this runtime reads them, because
		// DatabaseBackend::getMultiple() selects by cid and garbageCollection() cannot run here
		const bins = audit.perTable.filter((t) => t.table.startsWith('cache_'));
		expect(bins).toHaveLength(14);
		for (const bin of bins.filter((b) => b.table !== 'cache_data')) {
			expect(bin.chargePerRow, bin.table).toBe(2);
			expect(bin.explicitIndexes, bin.table).toEqual([]);
		}
	});

	it('KEEPS both indexes on cache_data, which is the one bin the host GCs', () => {
		// gcPass() caps it with ORDER BY created and sweeps it with expire < ?; dropping these
		// would turn every alarm into a full scan of the bin
		const data = audit.perTable.find((t) => t.table === 'cache_data');
		expect(data?.chargePerRow).toBe(4);
		expect(data?.explicitIndexes.map((i) => i.name).sort()).toEqual([
			'cache_data_created',
			'cache_data_expire'
		]);
	});
});

/**
 * A RECORDED TOTAL IS A FACT ABOUT THE SCHEMA IT WAS TAKEN ON.
 *
 * `splitFill()` divides a charged-row total by the CURRENT factor, so once the 26 bin indexes went,
 * it re-decomposed the historical 12-row fill as 6 data rows -- a fill that really stored 3. The
 * measurement did not change; the divisor did. This is the project's own rule about subtrahends
 * pointed at a decomposition, and dropping the indexes is what surfaced it.
 *
 * So the historical split is pinned against the factors in force when it was measured, and the
 * current schema gets its own assertion instead of overwriting the old one.
 */
describe.skipIf(SKIP)('the recorded fill, decomposed', () => {
	/** every cache bin charged 4 per stored row when the 12-row fill was recorded */
	const AS_MEASURED = { cache_dynamic_page_cache: 4, cache_page: 4 };

	it('was 3 data rows and 9 index entries ON THE 4x SCHEMA IT WAS MEASURED ON', () => {
		const split = splitChargedRows(RECORDED_FILL_CHARGED_ROWS, AS_MEASURED);
		expect(split.dataRows).toBe(3);
		expect(split.indexRows).toBe(9);
		expect(split.indexShare).toBe(0.75);
		expect(split.rows.every((r) => r.exact)).toBe(true);
	});

	it('put 6 of dynamic_page_cache 8 rows in the indexes and only 2 in the data', () => {
		const split = splitChargedRows(RECORDED_FILL_CHARGED_ROWS, AS_MEASURED);
		const dpc = split.rows.find((r) => r.table === 'cache_dynamic_page_cache');
		expect(dpc?.chargedRows).toBe(8);
		expect(dpc?.dataRows).toBe(2);
		expect(dpc?.indexRows).toBe(6);
	});

	it('and the SAME fill now charges 6 rather than 12, which is the win', () => {
		// 3 data rows unchanged; the bins that stored them went from 4x to 2x
		const split = splitChargedRows(RECORDED_FILL_CHARGED_ROWS, AS_MEASURED);
		const nowCharged = split.rows.reduce((n, r) => {
			const bin = audit.perTable.find((t) => t.table === r.table);
			return n + r.dataRows * (bin?.chargePerRow ?? 0);
		}, 0);
		expect(nowCharged).toBe(6);
	});
});

describe.skipIf(SKIP)('the DDL the workers lane measures still matches the pack', () => {
	it.each(Object.entries(SHIPPED))('%s parses to the same shape as the pack', (_key, shipped) => {
		const packTable = [...audit.tables.values()].find((t) => t.name === shipped.table);
		expect(packTable, `${shipped.table} is not in the pack`).toBeDefined();

		const local = parseCreateTable(shipped.ddl[0] as string);
		expect(local?.pk).toEqual(packTable?.pk);
		expect(local?.pkIsRowid).toBe(packTable?.pkIsRowid);
		expect(local?.autoincrement).toBe(packTable?.autoincrement);
		expect(local?.columns.map((c) => c.name)).toEqual(packTable?.columns.map((c) => c.name));

		const localIndexes = shipped.ddl.slice(1).map((d) => parseCreateIndex(d));
		const packIndexes = audit.indexesByTable.get(shipped.table) ?? [];
		expect(localIndexes.map((i) => i?.name).sort()).toEqual(
			packIndexes.map((i) => i.name).sort()
		);
		expect(
			chargePerInsertedRow(
				local!,
				localIndexes.filter((i) => i !== null)
			)
		).toBe(audit.perTable.find((t) => t.table === shipped.table)?.chargePerRow);
	});

	it('prices the host serve table at 2, which no pack statement can drift', () => {
		// cfw_page is created by src/site-do.ts rather than shipped in the pack, so this is the one
		// DDL here with no pack counterpart; it is included because the fill writes to it
		const table = parseCreateTable(CFW_PAGE_DDL);
		expect(table?.pkIsRowid).toBe(false);
		expect(chargePerInsertedRow(table!, [])).toBe(2);
	});
});
