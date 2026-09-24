import { describe, expect, it } from 'vitest';
import { drupflare } from '../../scripts/economics/fleet';
import { month } from '../../scripts/economics/pricing';
import { model, pageStoreFraction } from '../../scripts/measure/render-fraction';

const requestsPerDay = (views: number) => (views * 12) / 365;

describe("drupflare's render fraction follows saves, not a clock", () => {
	it('is saves times pages per save over requests, whatever the traffic', () => {
		for (const views of [10_000, 100_000, 20_000_000]) {
			expect(pageStoreFraction(views)).toBeCloseTo(25 / requestsPerDay(views), 12);
		}
		expect(pageStoreFraction(100)).toBe(1);
		expect(pageStoreFraction(0)).toBe(0);
	});

	// the page store has no TTL term; charging one at a single colo read 4.38% at 20M views
	it('sits far below the one-colo TTL floor it used to be priced at', () => {
		const floor = model({
			paths: 100,
			colos: 1,
			viewsPerMonth: 20_000_000,
			savesPerDay: 5,
			pagesPerSave: 5,
			zipf: 1
		}).fraction;
		expect(floor).toBeGreaterThan(0.04);
		expect(pageStoreFraction(20_000_000)).toBeLessThan(floor / 1000);
	});

	it('is the default every fleet model prices a render at', () => {
		const views = 10_000;
		const rf = pageStoreFraction(views);
		expect(month(1_000, views)[0]).toBe(month(1_000, views, rf)[0]);
		expect(month(1_000, views)[0]).not.toBe(month(1_000, views, 0.01)[0]);
		expect(drupflare(1_000, views)).toBe(drupflare(1_000, views, rf));
		expect(drupflare(1_000, views)).not.toBe(drupflare(1_000, views, 0.01));
	});
});

describe('the managed fleet bill', () => {
	it('charges a custom hostname past the hundred Cloudflare for SaaS includes', () => {
		const base = month(1_000, 10_000)[0];
		const [withDomains, parts] = month(1_000, 10_000, undefined, undefined, undefined, 1_000);
		expect(parts['hostnames']).toBeCloseTo(90, 9);
		expect(withDomains - base).toBeCloseTo(90, 9);
		expect(month(100, 10_000, undefined, undefined, undefined, 100)[1]['hostnames']).toBe(0);
	});
});
