import { describe, expect, it } from 'vitest';
import {
	FLOOR_KWH_YEAR,
	PRODUCTION_SHAPES,
	productionKwhYear,
	savingPct,
	type ProductionShape
} from '../../scripts/economics/energy';

const [matched, peak, single] = PRODUCTION_SHAPES as [
	ProductionShape,
	ProductionShape,
	ProductionShape
];

describe('production energy arm', () => {
	it('reproduces the sized deployments in kWh a site-year', () => {
		expect(productionKwhYear(matched)).toBeCloseTo(465, 0);
		expect(productionKwhYear(peak)).toBeCloseTo(848, 0);
		expect(productionKwhYear(single)).toBeCloseTo(155, 0);
		expect(FLOOR_KWH_YEAR).toBeCloseTo(24.8, 1);
	});

	it('scales with every factor of the node count', () => {
		const base = productionKwhYear(matched);
		expect(productionKwhYear({ ...matched, regions: 6 })).toBeCloseTo(base * 2, 6);
		expect(productionKwhYear({ ...matched, nodesPerRegion: 8 })).toBeCloseTo(base * 2, 6);
		expect(productionKwhYear({ ...matched, vcpu: 8 })).toBeCloseTo(base * 2, 6);
		expect(productionKwhYear({ ...matched, util: 0.3 })).toBeGreaterThan(base);
	});

	it('saves more as the deployment gets bigger', () => {
		for (const views of [100_000, 1_000_000, 10_000_000, 30_000_000]) {
			const savings = [1, 2, 3, 6].map((regions) =>
				savingPct(productionKwhYear({ ...matched, regions }), views)
			);
			for (let i = 1; i < savings.length; i++)
				expect(savings[i]).toBeGreaterThan(savings[i - 1]!);
		}
	});

	it('keeps the floor below every production shape', () => {
		for (const s of PRODUCTION_SHAPES)
			expect(productionKwhYear(s)).toBeGreaterThan(FLOOR_KWH_YEAR);
		expect(savingPct(FLOOR_KWH_YEAR, 1_000_000)).toBeLessThan(
			savingPct(productionKwhYear(single), 1_000_000)
		);
	});
});
