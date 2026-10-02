import { describe, expect, it } from 'vitest';
import {
	FLOOR_KWH_YEAR,
	PRODUCTION_SHAPES,
	productionKwhYear,
	savingPct,
	type ProductionShape
} from '../../scripts/economics/energy';
import {
	COST,
	HOST_SHAPES,
	OPPONENTS,
	WASM_RENDER_RATIO,
	drupflareMjPerView,
	drupflareRenderRate,
	opponentMjPerView,
	renderRate
} from '../../scripts/economics/perview';

describe('energy per view', () => {
	const pct = (x: number) => x * 100;

	it('reproduces the render rate of each host shape at 1M views a month', () => {
		const at = (i: number) => pct(renderRate(HOST_SHAPES[i]!, 1_000_000));
		expect(at(0)).toBeCloseTo(45.7, 1);
		expect(at(1)).toBeCloseTo(7.34, 2);
		expect(at(2)).toBeCloseTo(3.04, 2);
		expect(at(3)).toBeCloseTo(0.38, 2);
		expect(pct(drupflareRenderRate(1_000_000))).toBeCloseTo(0.076, 3);
	});

	it('renders less often as the cache gets longer, shielded or purged', () => {
		for (const v of [100_000, 1_000_000, 10_000_000]) {
			expect(renderRate(HOST_SHAPES[0]!, v)).toBeGreaterThan(renderRate(HOST_SHAPES[1]!, v));
			expect(renderRate(HOST_SHAPES[1]!, v)).toBeGreaterThan(renderRate(HOST_SHAPES[3]!, v));
			expect(renderRate(HOST_SHAPES[3]!, v)).toBeGreaterThan(drupflareRenderRate(v));
		}
	});

	it('prices both penalties against drupflare', () => {
		expect(WASM_RENDER_RATIO).toBeCloseTo(1.65, 2);
		expect(COST.drupflareHit).toBeCloseTo(7.4, 1);
		expect(COST.nginxHit).toBeCloseTo(3.0, 1);
		expect(COST.drupflareRender).toBeGreaterThan(COST.nativeRender);
	});

	it('reproduces the energy per view on the mix', () => {
		expect(drupflareMjPerView(1_000_000)).toBeCloseTo(8.9, 1);
		expect(drupflareMjPerView(30_000_000)).toBeCloseTo(8.7, 1);
		const [fpm, nginx, pantheon, shield, floor] = OPPONENTS as [
			(typeof OPPONENTS)[0],
			(typeof OPPONENTS)[0],
			(typeof OPPONENTS)[0],
			(typeof OPPONENTS)[0],
			(typeof OPPONENTS)[0]
		];
		expect(opponentMjPerView(fpm, 1_000_000)).toBeCloseTo(25.5, 1);
		expect(opponentMjPerView(nginx, 1_000_000)).toBeCloseTo(73.9, 0);
		expect(opponentMjPerView(pantheon, 1_000_000)).toBeCloseTo(22.2, 1);
		expect(opponentMjPerView(shield, 1_000_000)).toBeCloseTo(12.8, 1);
		expect(opponentMjPerView(floor, 1_000_000)).toBeCloseTo(10.1, 1);
	});

	it('leaves the tightest cell narrow, and drupflare ahead in every cell', () => {
		for (const o of OPPONENTS)
			for (const v of [10_000, 100_000, 1_000_000, 10_000_000, 30_000_000])
				expect(opponentMjPerView(o, v)).toBeGreaterThan(drupflareMjPerView(v));
		const ratio = (i: number) =>
			opponentMjPerView(OPPONENTS[i]!, 30_000_000) / drupflareMjPerView(30_000_000);
		expect(ratio(3)).toBeCloseTo(1.42, 1);
		expect(ratio(4)).toBeCloseTo(1.1, 1);
	});
});

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
