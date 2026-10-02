import { describe, expect, it } from 'vitest';
import {
	CORES,
	FLOOR_KWH_YEAR,
	IDLE_W,
	PEAK_W,
	PRODUCTION_SHAPES,
	THREADS_PER_HOST,
	W_PER_CORE,
	productionKwhYear,
	type ProductionShape
} from '../../scripts/economics/energy';
import {
	FLEET_TABLE_VIEWS,
	SHARED_ARMS,
	carbonKg,
	fleetGapKwh,
	saving,
	sharedHostingArm,
	sharedHostingPublished,
	waterDirectL,
	waterIndirectL
} from '../../scripts/economics/fleet';
import {
	asCar,
	asHome,
	asServers,
	energyJ,
	energyKwh,
	inUnit,
	sig3
} from '../../scripts/economics/fmt';
import {
	COST,
	HOST_SHAPES,
	OPPONENTS,
	WASM_RENDER_RATIO,
	drupflareKwhYearOnMix,
	drupflareMjPerView,
	drupflareRenderRate,
	headline,
	joulesPerView,
	opponentMjPerView,
	renderRate,
	savingPct
} from '../../scripts/economics/perview';

describe('energy units', () => {
	it('picks the SI prefix that makes the number read naturally', () => {
		expect(energyJ(0.0089)).toBe('8.90 mJ');
		expect(energyJ(139.5)).toBe('140 J');
		expect(energyJ(13_953)).toBe('14.0 kJ');
		expect(energyJ(4_200_000)).toBe('4.20 MJ');
		expect(energyKwh(0.0295)).toBe('29.5 Wh');
		expect(energyKwh(465.1)).toBe('465 kWh');
		expect(energyKwh(2480)).toBe('2.48 MWh');
	});

	it('converts into a column unit', () => {
		expect(inUnit(0.0089, 'mJ')).toBeCloseTo(8.9, 6);
		expect(inUnit(2500, 'kJ')).toBeCloseTo(2.5, 6);
		expect(sig3(13_953.1)).toBe('13,953');
	});
});

describe('analogies round down', () => {
	it('counts whole servers and never rounds up', () => {
		expect(asServers(18.75)).toBe('18 servers not built');
		expect(asServers(187.5)).toBe('187 servers not built');
		expect(asServers(1)).toBe('1 server not built');
		expect(asServers(1.99)).toBe('1 server not built');
	});

	it('states a share below one server as the unit fraction that fits under it', () => {
		expect(asServers(0.2)).toBe('a fifth of one server not built');
		expect(asServers(0.1875)).toBe('a sixth of one server not built');
		expect(asServers(0.5)).toBe('a half of one server not built');
		expect(asServers(0.01)).toBe('1/100 of one server not built');
	});

	it('floors homes, cars and pounds', () => {
		expect(asHome(43.9)).toBe('43 US homes for a year');
		expect(asHome(15.7 / 365.25)).toBe('one US home for 15 days');
		expect(asCar(38.8)).toBe('38 cars off the road');
		expect(asCar(0.0399)).toBe('400 lb CO2e');
	});
});

describe('energy per view, all-in', () => {
	it('turns a whole-year energy into joules per view and back', () => {
		// 1 kWh over 12 views is 3.6 MJ over 12 views
		expect(joulesPerView(1, 1)).toBeCloseTo(3.6e6 / 12, 6);
		const v = 1_000_000;
		const kwh = (headline(v).production * v * 12) / 3.6e6;
		expect(kwh).toBeCloseTo(productionKwhYear(matched), 6);
		expect((headline(v).drupflare * v * 12) / 3.6e6).toBeCloseTo(drupflareKwhYearOnMix(v), 9);
	});

	it('states the saving as a multiple and a percentage that agree', () => {
		for (const v of [10_000, 1_000_000, 30_000_000]) {
			const h = headline(v);
			expect(h.productionMultiple).toBeCloseTo(h.production / h.drupflare, 6);
			expect(h.productionSaving).toBeCloseTo((1 - 1 / h.productionMultiple) * 100, 9);
			expect(h.peakSized).toBeGreaterThan(h.production);
			expect(h.peakMultiple).toBeGreaterThan(h.productionMultiple);
		}
	});

	it('charges the mix, logged-in views included, to the same annual figure', () => {
		expect(drupflareKwhYearOnMix(1_000_000) * 1000).toBeCloseTo(18.3, 1);
		expect(savingPct(productionKwhYear(peak), 1_000_000)).toBeGreaterThan(99.99);
	});
});

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
		expect(COST.drupflareHit).toBeCloseTo(4.6, 1);
		expect(COST.nginxHit).toBeCloseTo(1.9, 1);
		expect(COST.drupflareRender).toBeGreaterThan(COST.nativeRender);
	});

	it('reproduces the energy per view on the mix', () => {
		expect(drupflareMjPerView(1_000_000)).toBeCloseTo(5.5, 1);
		expect(drupflareMjPerView(30_000_000)).toBeCloseTo(5.4, 1);
		const [fpm, nginx, pantheon, shield, floor] = OPPONENTS as [
			(typeof OPPONENTS)[0],
			(typeof OPPONENTS)[0],
			(typeof OPPONENTS)[0],
			(typeof OPPONENTS)[0],
			(typeof OPPONENTS)[0]
		];
		expect(opponentMjPerView(fpm, 1_000_000)).toBeCloseTo(15.8, 1);
		expect(opponentMjPerView(nginx, 1_000_000)).toBeCloseTo(45.7, 1);
		expect(opponentMjPerView(pantheon, 1_000_000)).toBeCloseTo(13.7, 1);
		expect(opponentMjPerView(shield, 1_000_000)).toBeCloseTo(7.9, 1);
		expect(opponentMjPerView(floor, 1_000_000)).toBeCloseTo(6.2, 1);
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
		expect(productionKwhYear(matched)).toBeCloseTo(224.2, 1);
		expect(productionKwhYear(peak)).toBeCloseTo(390.0, 1);
		expect(productionKwhYear(single)).toBeCloseTo(74.7, 1);
		expect(FLOOR_KWH_YEAR).toBeCloseTo(9.34, 2);
	});

	it('takes its inputs from the SPECpower result', () => {
		// power_ssj2008-20251021-01543: Dell PowerEdge R6725, EPYC 9845, 2 chips
		expect(IDLE_W).toBe(135);
		expect(PEAK_W).toBe(711);
		expect(CORES).toBe(320);
		expect(THREADS_PER_HOST).toBe(640);
		expect(W_PER_CORE).toBeCloseTo(711 / 320, 9);
	});

	it('follows from those inputs: nodes times the vCPU share of a host times power times PUE', () => {
		const watts = 135 + (711 - 135) * 0.15;
		const expected = (12 * (4 / 640) * watts * 1.54 * 8766) / 1000;
		expect(productionKwhYear(matched)).toBeCloseTo(expected, 9);
		expect(FLOOR_KWH_YEAR).toBeCloseTo(((watts / 320) * 1.54 * 8766) / 1000, 9);
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

describe('fleet energy, carbon and water', () => {
	it('quotes the arm with the smallest saving', () => {
		for (const v of [10_000, 1_000_000, 20_000_000, 1_000_000_000]) {
			const published = sharedHostingPublished(1000, v);
			for (const arm of SHARED_ARMS)
				expect(published.kwh).toBeLessThanOrEqual(sharedHostingArm(arm, 1000, v).kwh);
		}
	});

	it('charges native costs less than drupflare costs on the same anonymous views', () => {
		const same = sharedHostingArm('same-cost', 1000, 20_000_000).kwh;
		const native = sharedHostingArm('native-nginx', 1000, 20_000_000).kwh;
		expect(native).toBeLessThan(same);
		expect(sharedHostingArm('native-fpm', 1000, 20_000_000).kwh).toBeGreaterThan(native);
	});

	it('moves the 1,000-site carbon and water at 10,000 views to the published arm', () => {
		const gap = fleetGapKwh(1000, 10_000);
		expect(carbonKg(gap)).toBeCloseTo(701, 0);
		expect(waterDirectL(gap) + waterIndirectL(gap)).toBeCloseTo(8989, -1);
		expect(carbonKg(gap)).toBeLessThan(703);
	});

	it('prices one site per year in carbon and water from its kWh', () => {
		const peakKwh = productionKwhYear(peak);
		expect(carbonKg(peakKwh)).toBeCloseTo(150, 0);
		expect(waterDirectL(peakKwh)).toBeCloseTo(146, 0);
		expect(waterIndirectL(peakKwh)).toBeCloseTo(1775, -1);
		expect(carbonKg(productionKwhYear(matched), 140)).toBeCloseTo(31.4, 1);
	});

	it('keeps the fleet saving falling as traffic rises', () => {
		const s = FLEET_TABLE_VIEWS.map((v) => saving(v));
		for (let i = 1; i < s.length; i++) expect(s[i]).toBeLessThan(s[i - 1]!);
		expect(saving(10_000)).toBeGreaterThan(99.9);
	});
});
