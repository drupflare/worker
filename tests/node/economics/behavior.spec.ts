import { describe, expect, it } from 'vitest';
import {
	ARCHETYPES,
	DECORATION_CPU,
	DEFAULT_EXPONENT,
	DEFAULT_PAGES,
	OWN_SITES,
	RETURN_BY_FIRST_VISIT_PAGES,
	RETURN_CONTEXT,
	SOURCES,
	breakEvenSavedShare,
	breakEvenViews,
	caseOf,
	evenUpTo,
	expectedDistinct,
	fitZipf,
	fixedVisit,
	month,
	pmfMean,
	popularityOf,
	requestsPerView,
	returnProbability,
	savedShare,
	shapeOf,
	simulate,
	tieredPopularity,
	uniformPopularity,
	verdictOf,
	visitPmf,
	zipfPopularity,
	type Figure,
	type Source
} from '../../../scripts/economics/behavior';
import { account } from '../../../scripts/economics/bill';
import { SPOOL_REQUESTS } from '../../../scripts/economics/measured';
import { WORKERS_PAID } from '../../../scripts/economics/rates';
import { loadOff, workerLoad } from '../../../scripts/economics/spool';

const QUICK = 20_000;
const points = ARCHETYPES.flatMap((a) =>
	(['low', 'central', 'high'] as const).map((w) => ({ a, w, point: a[w] }))
);

const figures = (): Figure[] => {
	const out: Figure[] = [];
	for (const a of ARCHETYPES) {
		for (const w of ['low', 'central', 'high'] as const) {
			const p = a[w];
			out.push(p);
			if (p.singlePage) out.push(p.singlePage);
			if (p.tail) out.push(p.tail.share, p.tail.mean);
		}
		for (const x of [a.pages, a.topShare, a.topTenShare]) if (x) out.push(x);
	}
	out.push(...RETURN_BY_FIRST_VISIT_PAGES.map((x) => x.share), ...RETURN_CONTEXT);
	return out;
};

describe('every input has a source', () => {
	it('names a cited publication, how it was read and what it measures', () => {
		for (const x of figures()) {
			expect(Object.keys(SOURCES)).toContain(x.source);
			expect(['verified', 'own analytics', 'measured here']).toContain(x.read);
			expect(x.definition.length).toBeGreaterThan(10);
			expect(Number.isFinite(x.value)).toBe(true);
		}
	});

	it('gives a link for every figure read from a publication', () => {
		for (const x of figures().filter((y) => y.read === 'verified')) {
			expect(SOURCES[x.source]).toHaveProperty('url');
			expect((SOURCES[x.source] as Source).url).toMatch(/^https:\/\//);
		}
	});

	it('keeps views a visit ordered from low to high', () => {
		for (const a of ARCHETYPES) {
			expect(a.low.value).toBeLessThanOrEqual(a.central.value);
			expect(a.central.value).toBeLessThanOrEqual(a.high.value);
		}
	});
});

describe('the visit model', () => {
	it('sums to one and has the input mean and single-page share', () => {
		for (const { point } of points) {
			const pmf = visitPmf(shapeOf(point));
			expect(pmf.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 9);
			expect(pmfMean(pmf)).toBeCloseTo(point.value, 6);
			if (point.singlePage) expect(pmf[0]).toBeCloseTo(point.singlePage.value, 9);
		}
	});

	it('gives sampled visits the input mean and single-page share', () => {
		for (const a of ARCHETYPES) {
			const s = simulate(caseOf(a, 'central'), SPOOL_REQUESTS, QUICK);
			const input = a.central.singlePage?.value ?? 1 / a.central.value;
			expect(s.views / s.visits).toBeGreaterThan(a.central.value * 0.96);
			expect(s.views / s.visits).toBeLessThan(a.central.value * 1.04);
			expect(Math.abs(s.singlePage / s.visits - input)).toBeLessThan(0.02);
		}
	});

	it('refuses a mean and single-page share no visit can have', () => {
		expect(() => visitPmf({ mean: 1.2, singlePage: 0.5 })).toThrow();
		expect(() => visitPmf({ mean: 0.5 })).toThrow();
		expect(visitPmf({ mean: 1 })).toEqual([1]);
	});

	it('is deterministic across two runs', () => {
		const c = caseOf(ARCHETYPES[5]!, 'central');
		expect(simulate(c, SPOOL_REQUESTS, QUICK)).toEqual(simulate(c, SPOOL_REQUESTS, QUICK));
	});

	it('changes with the seed', () => {
		const c = caseOf(ARCHETYPES[5]!, 'central');
		expect(simulate(c, SPOOL_REQUESTS, QUICK, 1).on).not.toBe(
			simulate(c, SPOOL_REQUESTS, QUICK, 2).on
		);
	});
});

describe('requests with spool on', () => {
	it('never exceed requests with spool off for any views, distinct pages and documents before control', () => {
		for (const before of [0, 1, 2, 3, 5]) {
			const k = { ...SPOOL_REQUESTS, documentsBeforeControl: before };
			for (let views = 1; views <= 80; views++) {
				for (let distinct = 1; distinct <= views; distinct++) {
					const v = { views, distinct };
					expect(workerLoad(v, k).documents).toBeLessThanOrEqual(loadOff(v).documents);
				}
			}
		}
	});

	it('never exceed requests with spool off in any sampled archetype', () => {
		for (const { a, w } of points) {
			const s = simulate(caseOf(a, w), SPOOL_REQUESTS, 5000);
			expect(s.on).toBeLessThanOrEqual(s.off);
			expect(s.off).toBe(s.views);
		}
	});

	it('save nothing on a one-page visit and cost the decoration CPU', () => {
		const blog = ARCHETYPES.find((a) => a.label === 'blog')!;
		const s = simulate(caseOf(blog, 'central'), SPOOL_REQUESTS, QUICK);
		expect(s.on).toBe(s.off);
		expect(savedShare(s)).toBe(0);
		const views = 30_000_000;
		const m = month(views, requestsPerView(s), DECORATION_CPU.upperMs);
		expect(m.verdict).toBe('DEFICIT');
		expect(m.diff).toBeCloseTo(
			(DECORATION_CPU.upperMs * views * WORKERS_PAID.usdPerMillionCpuMs) / 1e6,
			6
		);
		expect(month(views, requestsPerView(s), DECORATION_CPU.lowerMs).verdict).toBe('even');
	});

	it('count a return visit as one request for each distinct page', () => {
		const news = ARCHETYPES.find((a) => a.label === 'news')!;
		const s = simulate(caseOf(news, 'central'), SPOOL_REQUESTS, QUICK);
		expect(s.returnVisits).toBeGreaterThan(0);
		const without = simulate(
			{ ...caseOf(news, 'central'), returns: false },
			SPOOL_REQUESTS,
			QUICK
		);
		expect(without.returnVisits).toBe(0);
		expect(requestsPerView(s)).toBeLessThanOrEqual(requestsPerView(without) + 0.01);
	});

	it('lands the news return share near the benchmark rate', () => {
		const news = ARCHETYPES.find((a) => a.label === 'news')!;
		const s = simulate(caseOf(news, 'central'), SPOOL_REQUESTS, QUICK);
		const bench = RETURN_CONTEXT[0]!.value;
		expect(Math.abs(s.returnVisits / (s.visits - s.returnVisits) - bench)).toBeLessThan(0.05);
	});

	it('interpolates the return share through the three read points and holds flat past them', () => {
		for (const p of RETURN_BY_FIRST_VISIT_PAGES) {
			expect(returnProbability(p.pages)).toBe(p.share.value);
		}
		expect(returnProbability(3)).toBeGreaterThan(returnProbability(2));
		expect(returnProbability(3)).toBeLessThan(returnProbability(5));
		expect(returnProbability(40)).toBe(returnProbability(5));
	});
});

describe('page popularity', () => {
	it('sums to one and recovers the top-page share it was fitted to', () => {
		for (const s of OWN_SITES) {
			const exponent = fitZipf(s.pages, s.top);
			const pop = zipfPopularity(s.pages, exponent);
			expect(pop.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
			expect(pop[0]).toBeCloseTo(s.top, 9);
		}
		expect(fitZipf(100, 0.01)).toBe(0);
	});

	it('holds both measured shares in the tiered shape', () => {
		const pop = tieredPopularity(405, 0.44, 0.62);
		expect(pop.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
		expect(pop[0]).toBe(0.44);
		expect(pop.slice(0, 10).reduce((a, b) => a + b, 0)).toBeCloseTo(0.62, 9);
	});

	it('uses the own-site fit where an archetype has a top-page share and the default elsewhere', () => {
		const personal = ARCHETYPES.find((a) => a.label === 'personal or portfolio')!;
		expect(popularityOf(personal)[0]).toBeCloseTo(0.44, 9);
		const news = ARCHETYPES.find((a) => a.label === 'news')!;
		expect(popularityOf(news)).toEqual(zipfPopularity(DEFAULT_PAGES, DEFAULT_EXPONENT));
	});

	it('draws fewer distinct pages and saves more than a uniform draw over the same pages', () => {
		const pages = 1000;
		const real = zipfPopularity(pages, DEFAULT_EXPONENT);
		const flat = uniformPopularity(pages);
		for (const views of [10, 20, 50]) {
			expect(expectedDistinct(real, views)).toBeLessThan(expectedDistinct(flat, views));
			const a = fixedVisit(real, views);
			const b = fixedVisit(flat, views);
			expect(a.distinct).toBeLessThan(b.distinct);
			expect(a.on).toBeLessThan(b.on);
		}
	});

	it('matches the sampled distinct pages to the expected value', () => {
		const pop = zipfPopularity(200, DEFAULT_EXPONENT);
		const x = fixedVisit(pop, 20, SPOOL_REQUESTS, 40_000);
		expect(Math.abs(x.distinct - expectedDistinct(pop, 20))).toBeLessThan(0.1);
	});
});

describe('break even', () => {
	it('needs fewer views on a concentrated site than on a uniform one', () => {
		const real = breakEvenViews(zipfPopularity(1000, DEFAULT_EXPONENT))!;
		const flat = breakEvenViews(uniformPopularity(1000));
		expect(flat === undefined || flat > real).toBe(true);
	});

	it('needs more views to pay for the decoration CPU than to save one request', () => {
		const pop = zipfPopularity(DEFAULT_PAGES, DEFAULT_EXPONENT);
		const dollars = breakEvenViews(pop, breakEvenSavedShare(DECORATION_CPU.upperMs))!;
		expect(dollars).toBeGreaterThan(breakEvenViews(pop)!);
		expect(breakEvenSavedShare(DECORATION_CPU.lowerMs)).toBe(0);
		expect(breakEvenSavedShare(DECORATION_CPU.upperMs)).toBeGreaterThan(0);
	});
});

describe('the bill', () => {
	it('is the same with spool on and off while the allowances absorb the CPU', () => {
		for (const views of [10_000, 100_000, 1_000_000]) {
			expect(month(views, 1, DECORATION_CPU.upperMs).verdict).toBe('even');
		}
		const upTo = evenUpTo(1, DECORATION_CPU.upperMs)!;
		expect(upTo).toBeGreaterThan(1_000_000);
		expect(month(upTo, 1, DECORATION_CPU.upperMs).diff).toBeLessThan(0.005);
		expect(month(upTo * 2, 1, DECORATION_CPU.upperMs).verdict).toBe('DEFICIT');
	});

	it('is the existing model when spool changes nothing and adds no CPU', () => {
		const m = month(30_000_000, 1, 0);
		expect(m.paidOff).toBeCloseTo(account(1, 30_000_000).total, 6);
		expect(m.paidOn).toBeCloseTo(m.paidOff, 6);
	});

	it('turns into a bonus once spool removes enough requests', () => {
		expect(month(100_000_000, 0.5, DECORATION_CPU.lowerMs).verdict).toBe('BONUS');
		expect(verdictOf(0.001)).toBe('even');
		expect(verdictOf(-1)).toBe('BONUS');
		expect(verdictOf(1)).toBe('DEFICIT');
	});

	it('prices a free site at the paid base on the paid plan', () => {
		const m = month(10_000, 1, DECORATION_CPU.upperMs);
		expect(m.freeOff).toBe(true);
		expect(m.paidOff).toBe(5);
	});
});
