import { describe, expect, it } from 'vitest';
import { account } from '../../scripts/economics/bill';
import { SPOOL_REQUESTS } from '../../scripts/economics/measured';
import {
	billWithSpool,
	breakEvenViews,
	freeViewsMonth,
	serverJoulesSaved,
	workerRequestsPerView
} from '../../scripts/economics/spool';
import { FREE_QUOTAS } from '../../scripts/measure/free-envelope';

describe('the Worker requests a view costs with spool', () => {
	it('is the views that miss the device plus the fixed set over a device', () => {
		expect(workerRequestsPerView(0.5, 20)).toBeCloseTo(
			0.5 + SPOOL_REQUESTS.fixedPerDevice / 20
		);
		expect(workerRequestsPerView(0, 10)).toBeCloseTo(1 + SPOOL_REQUESTS.fixedPerDevice / 10);
	});

	it('costs more than no spool when nothing is answered locally', () => {
		expect(workerRequestsPerView(0, 1000)).toBeGreaterThan(1);
	});

	it('ties with no spool at the break-even, and wins past it', () => {
		for (const z of [0.25, 0.5, 0.75]) {
			const v = breakEvenViews(z);
			expect(workerRequestsPerView(z, v)).toBeCloseTo(1);
			expect(workerRequestsPerView(z, v * 2)).toBeLessThan(1);
			expect(workerRequestsPerView(z, v / 2)).toBeGreaterThan(1);
		}
	});
});

describe('the free plan with spool', () => {
	it('carries the cap over one request a view when the fixed set vanishes', () => {
		expect(freeViewsMonth(0, 1e12)).toBeCloseTo(FREE_QUOTAS.workerRequestsPerDay * 30.44, 0);
	});

	it('carries fewer views than the cap for a device that leaves before the break-even', () => {
		const early = Math.floor(breakEvenViews(0.25)) - 1;
		expect(freeViewsMonth(0.25, early)).toBeLessThan(freeViewsMonth(0, 1e12));
		expect(freeViewsMonth(0.25, breakEvenViews(0.25) + 1)).toBeGreaterThan(
			freeViewsMonth(0, 1e12)
		);
	});
});

describe('the bill with spool', () => {
	it('is the existing model when no view is local and no device is new', () => {
		for (const views of [100_000, 10_000_000, 30_000_000]) {
			expect(billWithSpool(1, views, 0, 1e12).total).toBeCloseTo(account(1, views).total, 6);
		}
	});

	it('falls as the local share rises once the site pays for requests', () => {
		const bills = [0, 0.25, 0.5, 0.75].map((z) => billWithSpool(1, 30_000_000, z, 20).total);
		expect(bills).toEqual([...bills].sort((a, b) => b - a));
		expect(bills[3]).toBeLessThan(bills[0]!);
	});

	it('leaves a free site free while the added requests fit under the cap', () => {
		expect(billWithSpool(1, 100_000, 0.5, 20).free).toBe(true);
	});

	it('charges the paid base when the fixed requests push a free site over its cap', () => {
		const bill = billWithSpool(1, 3_000_000, 0, 1);
		expect(bill.free).toBe(false);
		expect(bill.total).toBeGreaterThan(0);
	});
});

describe('the server energy one local view spares', () => {
	it('is the cached serve CPU at the model watts, a few millijoules', () => {
		expect(serverJoulesSaved(1.8)).toBeCloseTo(0.0046, 4);
		expect(serverJoulesSaved(3.6)).toBeCloseTo(2 * serverJoulesSaved(1.8), 9);
	});
});
