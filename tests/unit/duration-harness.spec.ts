import { describe, expect, it } from 'vitest';
import {
	OPS,
	STRIPPED,
	keywordCost,
	rebuildStatements,
	restoreStatements,
	stripAutoincrement
} from '../../scripts/measure/autoinc-arm.js';
import {
	DO_GB_ALLOCATED,
	WORKLOADS,
	allocationAgreement,
	cpuUnderstatement,
	durationFromActive,
	flattenPeriodic,
	perOperation,
	siteFor,
	sitesFor,
	sumRows,
	type PeriodicRow
} from '../../scripts/measure/gbs-per-operation.js';
import {
	percentile,
	replicaFor,
	sampleUrl,
	scalingEfficiency,
	summarise,
	type Sample
} from '../../scripts/measure/replica-wake.js';

/**
 * The arithmetic both duration harnesses rest on.
 *
 * Neither script can run without a deployed worker, and that is exactly why the parts that are
 * deterministic are separated out and driven here. A percentile that is wrong at n=20, or a GB-s
 * conversion that assumes the wrong allocation, produces a plausible number nobody can check.
 */

const row = (over: Partial<PeriodicRow> = {}): PeriodicRow => ({
	objectId: 'obj',
	name: 'site',
	duration: 1.283359232,
	activeTime: 10_026_244,
	cpuTime: 3838,
	rowsRead: 0,
	rowsWritten: 0,
	...over
});

describe('GB-s per operation', () => {
	it('reproduces the deployed reading exactly, which is what pins the allocation', () => {
		// ten 1,000 ms holds on one object: activeTime 10,026,244 us, duration 1.283359232 GB-s.
		// `10.026244 * 0.128` is that figure, so 0.128 comes from billing rather than a docs example
		expect(durationFromActive(10_026_244)).toBeCloseTo(1.283359232, 9);
		expect(DO_GB_ALLOCATED).toBe(0.128);
	});

	it('agrees with itself when the allocation is right, and flags it when it is not', () => {
		expect(allocationAgreement(row())).toBeCloseTo(1, 6);
		// the binary 0.125 was used for a while and is 2.4% low everywhere
		expect(
			allocationAgreement(row({ duration: durationFromActive(10_026_244, 0.125) }))
		).toBeCloseTo(0.9765625, 6);
	});

	it('divides by completed units rather than by days', () => {
		expect(perOperation(row({ duration: 2 }), 10)).toBe(0.2);
	});

	it('answers 0 rather than dividing by zero when nothing completed', () => {
		expect(perOperation(row(), 0)).toBe(0);
		expect(perOperation(row(), -1)).toBe(0);
	});

	it('reports how far cpuTime understates the billed meter', () => {
		// the calibration row's own ratio; a render reads ~1x, so this is not a constant
		expect(cpuUnderstatement(row())).toBeCloseTo(2612.36, 1);
		expect(cpuUnderstatement(row({ cpuTime: 0 }))).toBe(Infinity);
	});

	it('flattens the GraphQL shape, and an empty answer is not a zero', () => {
		const body = {
			data: {
				viewer: {
					accounts: [
						{
							durableObjectsPeriodicGroups: [
								{
									dimensions: { objectId: 'a1b2c3', name: 'gbs-render-warm' },
									sum: {
										activeTime: 100,
										cpuTime: 1,
										duration: 0.5,
										rowsRead: 3,
										rowsWritten: 2
									}
								}
							]
						}
					]
				}
			}
		};
		expect(flattenPeriodic(body)).toEqual([
			{
				objectId: 'a1b2c3',
				name: 'gbs-render-warm',
				activeTime: 100,
				cpuTime: 1,
				duration: 0.5,
				rowsRead: 3,
				rowsWritten: 2
			}
		]);
		expect(flattenPeriodic({})).toEqual([]);
	});

	it('gives every workload class its own object, or nothing can be attributed', () => {
		const names = WORKLOADS.map((w) => siteFor('gbs', w.id));
		expect(new Set(names).size).toBe(WORKLOADS.length);
	});

	it('covers the classes that spend different meters', () => {
		const ids = new Set(WORKLOADS.map((w) => w.id));
		for (const id of ['migrate', 'render-binsempty', 'render-warm', 'node-save', 'cron']) {
			expect(ids.has(id), `${id} is not driven`).toBe(true);
		}
	});

	it('never provisions inside the class it is measuring', () => {
		// `/prefill` is not a route, so a provisioning step written that way rendered a 404 Drupal
		// page and charged it to the class. Every drive that provisions does it through `/migrate`
		for (const w of WORKLOADS) {
			for (const path of w.drive(siteFor('gbs', w.id), 0)) {
				expect(path.startsWith('/prefill'), `${w.id} drives /prefill`).toBe(false);
				if (path.startsWith('/migrate')) expect(w.provisions).toBe(true);
			}
		}
	});

	it('gives the provisioning class a fresh object per repeat', () => {
		const migrate = WORKLOADS.find((w) => w.provisions);
		expect(migrate).toBeDefined();
		// five repeats against one site would measure one migration and four short-circuits
		expect(new Set(sitesFor('gbs', migrate!, 5)).size).toBe(5);
		const render = WORKLOADS.find((w) => !w.provisions);
		expect(sitesFor('gbs', render!, 5)).toHaveLength(1);
	});

	it('sums every object a class occupies rather than reading one of them', () => {
		const rows = [
			row({ name: 'gbs-migrate-0', duration: 0.1, rowsWritten: 10 }),
			row({ name: 'gbs-migrate-1', duration: 0.2, rowsWritten: 20 }),
			row({ name: 'somebody-else', duration: 9, rowsWritten: 900 })
		];
		const summed = sumRows(rows, ['gbs-migrate-0', 'gbs-migrate-1']);
		expect(summed?.duration).toBeCloseTo(0.3, 9);
		expect(summed?.rowsWritten).toBe(30);
		// absent is "not ingested", never zero
		expect(sumRows(rows, ['gbs-nothing'])).toBeNull();
	});
});

describe('the AUTOINCREMENT arm, which needs no rebuilt interpreter', () => {
	const NODE_DDL =
		'CREATE TABLE "node" (\n"nid" INTEGER PRIMARY KEY AUTOINCREMENT CHECK ("nid">= 0), \n"type" VARCHAR(32) NOT NULL\n)';

	it('removes the keyword and nothing else', () => {
		const out = stripAutoincrement(NODE_DDL);
		expect(out).not.toBeNull();
		expect(out).not.toMatch(/AUTOINCREMENT/i);
		// the CHECK constraint and the column list are what make the two arms otherwise identical
		expect(out).toContain('CHECK ("nid">= 0)');
		expect(out).toContain('"type" VARCHAR(32) NOT NULL');
	});

	it('refuses a table that never had it, rather than silently producing a control', () => {
		expect(stripAutoincrement('CREATE TABLE "x" (id INTEGER PRIMARY KEY)')).toBeNull();
		expect(rebuildStatements('x', 'CREATE TABLE "x" (id INTEGER PRIMARY KEY)', [])).toBeNull();
	});

	it('rebuilds through a temporary name and restores every index', () => {
		const idx = ['CREATE UNIQUE INDEX "node_x" ON "node" ("nid")'];
		const stmts = rebuildStatements('node', NODE_DDL, idx) as string[];
		expect(stmts[0]).toContain('CREATE TABLE "node__noauto"');
		expect(stmts[0]).not.toMatch(/AUTOINCREMENT/i);
		expect(stmts[1]).toBe('INSERT INTO "node__noauto" SELECT * FROM "node"');
		expect(stmts[2]).toBe('DROP TABLE "node"');
		expect(stmts[3]).toBe('ALTER TABLE "node__noauto" RENAME TO "node"');
		// an index dropped with the table and not recreated would change the charge factor, which
		// is the multiplier the whole comparison is about
		expect(stmts.slice(4)).toEqual(idx);
	});

	it('strips only the content-path tables', () => {
		expect([...STRIPPED]).toEqual([
			'node',
			'node_revision',
			'path_alias',
			'file_managed',
			'users'
		]);
	});

	it('puts the keyword back, so one object can be measured in both states', () => {
		const plain = stripAutoincrement(NODE_DDL) as string;
		const stmts = restoreStatements('node', plain, []) as string[];
		expect(stmts[0]).toMatch(/INTEGER PRIMARY KEY AUTOINCREMENT/i);
		expect(stmts[0]).toContain('CREATE TABLE "node__auto"');
		// a round trip has to land back on the original, or the two arms are not the same table
		expect(stripAutoincrement(stmts[0] as string)).toBe(
			plain.replace('CREATE TABLE "node"', 'CREATE TABLE "node__auto"')
		);
		// refuses a table that already has it, so a no-op cannot masquerade as a restore
		expect(restoreStatements('node', NODE_DDL, [])).toBeNull();
	});

	it('drives all seven workloads, including the two that are never stripped', () => {
		expect([...OPS]).toHaveLength(7);
		for (const op of ['txn-autoinc', 'txn-rowid']) expect([...OPS]).toContain(op);
		// the synthetic pair is the invariant control: neither table is in STRIPPED
		for (const t of STRIPPED) expect(t.startsWith('amp_txn')).toBe(false);
	});

	it('reports the keyword as a ratio, and 0 rather than a division by zero', () => {
		expect(keywordCost(184, 159)).toBeCloseTo(1.157, 3);
		expect(keywordCost(184, 0)).toBe(0);
	});
});

describe('the replica wake percentiles', () => {
	const samples = (ms: number[]): Sample[] =>
		ms.map((v, i) => ({ ms: v, status: 200, site: `s${i}`, booted: true }));

	it('uses nearest rank, so no reported value was never observed', () => {
		const ms = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
		expect(percentile(ms, 50)).toBe(50);
		expect(percentile(ms, 95)).toBe(100);
		expect(percentile(ms, 99)).toBe(100);
		// every answer is a member of the input
		for (const p of [1, 25, 50, 75, 95, 99]) expect(ms).toContain(percentile(ms, p));
	});

	it('handles one sample and no samples', () => {
		expect(percentile([7], 99)).toBe(7);
		expect(Number.isNaN(percentile([], 50))).toBe(true);
	});

	it('counts the requests that arrived at an object with no interpreter up', () => {
		const mixed: Sample[] = [
			{ ms: 1400, status: 200, site: 'a', booted: false },
			{ ms: 20, status: 200, site: 'a', booted: true },
			{ ms: 22, status: 200, site: 'a', booted: true }
		];
		const out = summarise(mixed);
		expect(out.cold).toBe(1);
		expect(out.n).toBe(3);
		expect(out.max).toBe(1400);
	});

	it('reports the shortfall from linear rather than a bare ratio', () => {
		// 2 replicas doing exactly twice the work is 1.00
		expect(scalingEfficiency(10, 20, 2)).toBe(1);
		// 2 replicas doing 1.6x is 0.80, which is the number a product decision needs
		expect(scalingEfficiency(10, 16, 2)).toBeCloseTo(0.8, 6);
		expect(scalingEfficiency(0, 5, 2)).toBe(0);
	});

	it('spreads a burst across the replicas round robin', () => {
		expect(replicaFor('wake', 0, 4)).toBe('wake-r0');
		expect(replicaFor('wake', 5, 4)).toBe('wake-r1');
		const hit = new Set(Array.from({ length: 40 }, (_, i) => replicaFor('wake', i, 4)));
		expect(hit.size).toBe(4);
	});

	it('addresses one object when there is one replica', () => {
		const hit = new Set(Array.from({ length: 20 }, (_, i) => replicaFor('wake', i, 1)));
		expect(hit.size).toBe(1);
	});

	it('drives a path that runs PHP when the mode asks for the interpreter wake', () => {
		// the serving path answers a prefilled `cfw_page` HIT off the storage lane and never boots
		// PHP, so a wake read there is the object's and not the interpreter's
		expect(sampleUrl('https://e', 'wake-r0', '/', 'serve')).toContain('/serve?');
		expect(sampleUrl('https://e', 'wake-r0', '/', 'serve')).toContain('edge=0');
		expect(sampleUrl('https://e', 'wake-r0', '/', 'render')).toContain('/assemble?');
		expect(sampleUrl('https://e', 'wake-r0', '/', 'render')).toContain('bins=page');
	});

	it('summarises an empty burst without throwing', () => {
		const out = summarise(samples([]));
		expect(out.n).toBe(0);
		expect(Number.isNaN(out.p50)).toBe(true);
	});
});
