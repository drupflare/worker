import { describe, expect, it } from 'vitest';
import {
	DO_GB_ALLOCATED,
	WORKLOADS,
	allocationAgreement,
	cpuUnderstatement,
	durationFromActive,
	flattenPeriodic,
	perOperation,
	siteFor,
	type PeriodicRow
} from '../../scripts/measure/gbs-per-operation.js';
import {
	percentile,
	replicaFor,
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
		// the measured 2,612x, which is why no ceiling here may be derived from cpuTime
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
									dimensions: { objectId: 'gbs-render-warm' },
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
				objectId: 'gbs-render-warm',
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
		for (const id of ['migrate', 'render-cold', 'render-warm', 'node-save', 'cron']) {
			expect(ids.has(id), `${id} is not driven`).toBe(true);
		}
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

	it('summarises an empty burst without throwing', () => {
		const out = summarise(samples([]));
		expect(out.n).toBe(0);
		expect(Number.isNaN(out.p50)).toBe(true);
	});
});
