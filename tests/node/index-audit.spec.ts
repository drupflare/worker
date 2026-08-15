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
		// 1,342 / 3,939 / 0.6314 before the content type; the 14 rows it adds are 6 config, 8
		// key_value, and the ratio barely moves because the two new tables ship empty
		expect(audit.totals.dataRows).toBe(1356);
		expect(audit.totals.chargedRows).toBe(3967);
		expect(audit.totals.indexRows / audit.totals.chargedRows).toBeCloseTo(0.6305, 3);
	});
});

describe.skipIf(SKIP)('router_alias, verified against the shipped rows rather than quoted', () => {
	it('is charged on all 419 routes while 402 of them store a NULL', () => {
		const sparse = audit.sparse.find((s) => s.index === 'router_alias');
		expect(sparse).toBeDefined();
		expect(sparse?.rows).toBe(ROUTES);
		expect(sparse?.nullRows).toBe(402);
		// the figure this project has been quoting as "96% NULL" is 402/419 = 95.9%, so it stands
		expect(sparse?.nullFraction).toBeCloseTo(0.959, 3);
	});

	it('prices the partial index at 402 charged rows off every full rebuild', () => {
		const sparse = audit.sparse.find((s) => s.index === 'router_alias');
		// a rebuild is 1 DELETE row + 4 INSERT rows per route = 5 * 419 = 2,095 charged rows;
		// a partial index stops paying for the 402 NULL routes, so 2,095 -> 1,693
		const rebuild = ROUTES * 5;
		expect(rebuild).toBe(2095);
		expect(rebuild - (sparse?.savedPerRewrite ?? 0)).toBe(1693);
		expect((sparse?.savedPerRewrite ?? 0) / rebuild).toBeCloseTo(0.192, 3);
	});

	it('finds the sparse indexes by measurement, so a new one cannot hide', () => {
		// the sweep is over every single-column index in the schema, not a lookup of a known name
		expect(audit.sparse.map((s) => s.index)).toEqual([
			'router_alias',
			'users_field_data_user_field__mail'
		]);
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
