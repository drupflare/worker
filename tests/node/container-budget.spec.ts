import { describe, expect, it } from 'vitest';
import {
	INCLUDED_ALLOWANCE,
	INSTANCE_TYPES,
	armApplications,
	budgetVerdict,
	budgetedRuntimeMs,
	resolveInstance,
	spend
} from '../../scripts/measure/container-budget.js';

const HOUR = 3_600_000;

describe('what a container arm has spent', () => {
	it('bills memory and disk on provisioned resources for the wall time', () => {
		const s = spend(INSTANCE_TYPES['standard-2']!, HOUR);
		expect(s.memoryGibHours).toBeCloseTo(6, 6);
		expect(s.diskGbHours).toBeCloseTo(12, 6);
	});

	it('charges every running millisecond to the vCPU meter, which is an upper bound', () => {
		// CPU bills on ACTIVE usage; a guard that assumed idle would under-count the one meter it
		// cannot observe, so the bound is deliberately the worst case
		const s = spend(INSTANCE_TYPES['standard-2']!, HOUR);
		expect(s.vcpuMinutes).toBeCloseTo(60, 6);
		expect(spend(INSTANCE_TYPES['standard-4']!, HOUR).vcpuMinutes).toBeCloseTo(240, 6);
	});

	it('costs nothing for no runtime, and never negative', () => {
		for (const spec of Object.values(INSTANCE_TYPES)) {
			expect(spend(spec, 0)).toEqual({ memoryGibHours: 0, vcpuMinutes: 0, diskGbHours: 0 });
			expect(spend(spec, -HOUR).memoryGibHours).toBe(0);
		}
	});

	it('refuses an instance type it cannot cost', () => {
		expect(() => resolveInstance('standard-9')).toThrow(/unknown instance type/);
		expect(() => resolveInstance('')).toThrow(/unknown instance type/);
	});
});

describe('the stop line', () => {
	it('passes a fresh arm and fails one that has run past its share', () => {
		const spec = INSTANCE_TYPES['standard-2']!;
		expect(budgetVerdict(spec, 0).over).toBe(false);
		expect(budgetVerdict(spec, 1000 * HOUR).over).toBe(true);
	});

	it('names memory as the binding meter until standard-4, where the CPU bound overtakes it', () => {
		// Pinned because it decides which instance a rig should pick, and because assuming memory
		// always binds is wrong: the included allowance is balanced at lite and basic, memory-rich
		// through standard-2, and CPU-poor at standard-4.
		for (const name of ['lite', 'basic', 'standard-1', 'standard-2', 'standard-3']) {
			expect(budgetVerdict(INSTANCE_TYPES[name]!, HOUR).binding).toBe('memoryGibHours');
		}
		expect(budgetVerdict(INSTANCE_TYPES['standard-4']!, HOUR).binding).toBe('vcpuMinutes');
	});

	it('leaves memory binding in practice, because the CPU figure is a worst case', () => {
		// standard-4 only flips because the guard charges every running ms to the vCPU meter. An arm
		// that is 50% idle is memory-bound there too, which is why the guard must not be read as a
		// measurement of CPU.
		const spec = INSTANCE_TYPES['standard-4']!;
		expect(budgetVerdict(spec, HOUR).fraction.vcpuMinutes).toBeGreaterThan(
			budgetVerdict(spec, HOUR).fraction.memoryGibHours
		);
		expect(spend(spec, HOUR).vcpuMinutes).toBeCloseTo(240, 6);
	});

	it('reserves half the included allowance by default', () => {
		const spec = INSTANCE_TYPES['standard-2']!;
		// 25 GiB-h allowance, half of it, at 6 GiB provisioned
		const expected = ((INCLUDED_ALLOWANCE.memoryGibHours * 0.5) / 6) * HOUR;
		expect(budgetedRuntimeMs(spec)).toBeCloseTo(expected, -2);
		expect(budgetVerdict(spec, expected).over).toBe(true);
		expect(budgetVerdict(spec, expected * 0.99).over).toBe(false);
	});

	it('tightens when the reserve is lowered and never exceeds the full allowance', () => {
		const spec = INSTANCE_TYPES['standard-2']!;
		const tenth = budgetedRuntimeMs(spec, INCLUDED_ALLOWANCE, 0.1);
		const half = budgetedRuntimeMs(spec, INCLUDED_ALLOWANCE, 0.5);
		const whole = budgetedRuntimeMs(spec, INCLUDED_ALLOWANCE, 1);
		expect(tenth).toBeLessThan(half);
		expect(half).toBeLessThan(whole);
		expect(spend(spec, whole).memoryGibHours).toBeCloseTo(INCLUDED_ALLOWANCE.memoryGibHours, 6);
	});

	it('reports remaining wall time that agrees with the verdict it is derived from', () => {
		const spec = INSTANCE_TYPES['standard-3']!;
		const ran = 20 * 60_000;
		const v = budgetVerdict(spec, ran);
		expect(v.over).toBe(false);
		// running exactly the remaining time lands on the stop line
		expect(budgetVerdict(spec, ran + v.remainingMs).over).toBe(true);
		expect(budgetVerdict(spec, ran + v.remainingMs * 0.99).over).toBe(false);
	});

	it('costs a lite arm far more runtime than a standard-4 one', () => {
		// the smallest instance is the one a reusable rig should default to when a run only needs
		// reachability rather than throughput
		expect(budgetedRuntimeMs(INSTANCE_TYPES['lite']!)).toBeGreaterThan(
			budgetedRuntimeMs(INSTANCE_TYPES['standard-4']!) * 20
		);
	});
});

describe('which container applications a teardown still owes', () => {
	// observed 2026-09-21: `wrangler delete` reported success while the application stayed active
	// with one live instance, so the worker delete is half a teardown and this is the other half
	const listing = JSON.stringify([
		{ id: 'a1', name: 'cfw-vps-vpsarm' },
		{ id: 'a2', name: 'drupflare-test_SitePhpDurableObject' },
		{ id: 'a3', name: 'cfw-vps-second' }
	]);

	it('claims every application the worker prefixes and nothing else', () => {
		expect(armApplications(listing, 'cfw-vps').map((a) => a.id)).toEqual(['a1', 'a3']);
	});

	it('leaves another worker alone', () => {
		expect(armApplications(listing, 'cfw-energy-probe')).toEqual([]);
	});

	it('reads past the wrangler banner to the first bracket', () => {
		const banner = 'wrangler 4.127.1\nupdate available\n' + listing;
		expect(armApplications(banner, 'cfw-vps').map((a) => a.id)).toEqual(['a1', 'a3']);
	});

	it('claims nothing it cannot parse, so a broken listing never reads as a clean teardown', () => {
		// a half-parsed listing would let the caller delete some and report all, which is the
		// failure this whole path exists to remove
		for (const bad of ['', 'Error: not authenticated', '[{"id":', '{"id":"a1"}']) {
			expect(armApplications(bad, 'cfw-vps')).toEqual([]);
		}
	});

	it('skips an entry missing an id, which cannot be deleted by id', () => {
		const partial = JSON.stringify([
			{ name: 'cfw-vps-vpsarm' },
			{ id: 'a4', name: 'cfw-vps-x' }
		]);
		expect(armApplications(partial, 'cfw-vps').map((a) => a.id)).toEqual(['a4']);
	});
});
