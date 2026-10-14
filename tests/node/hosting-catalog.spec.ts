import { describe, expect, it } from 'vitest';
import {
	CATALOG,
	cheapestUsdMonth,
	cheapestUsdPerGiBMonth,
	consolidatedMemoryFloorUsdMonth,
	MATCHED_REGIONS,
	matchedUsdMonth,
	MEMORY_PER_BOX_GIB,
	needFor,
	quote,
	ranked
} from '../../scripts/economics/hosting';

describe('the hosting catalog', () => {
	it('sources every plan with a page and a quote', () => {
		for (const [key, provider] of Object.entries(CATALOG.providers))
			for (const plan of provider.plans) {
				expect(plan.source, `${key} ${plan.plan}`).toMatch(/^https:\/\//);
				expect(plan.quote.length, `${key} ${plan.plan}`).toBeGreaterThan(0);
				expect(plan.monthlyUSD).toBeGreaterThan(0);
				expect(plan.vcpu).toBeGreaterThan(0);
			}
	});

	it('sources every provider-level price it carries', () => {
		for (const [key, provider] of Object.entries(CATALOG.providers))
			for (const field of [
				provider.egressUSDPerGB,
				provider.diskUSDPerGBMonth,
				provider.ipv4USDMonthPerBox,
				provider.backups,
				provider.loadBalancerUSDMonth
			])
				if (field) {
					expect(field.source, key).toMatch(/^https:\/\//);
					expect(field.quote.length, key).toBeGreaterThan(0);
				}
	});
});

describe('the load a conventional origin carries', () => {
	it('is a quarter of a core at 3 million views a month, so one vCPU', () => {
		const need = needFor(3_000_000);
		expect(need.lambdaS).toBeCloseTo(5.7, 1);
		expect(need.cores).toBeCloseTo(0.25, 2);
		expect(need.vcpu).toBe(1);
	});

	it('is the measured page weight times the views', () => {
		expect(needFor(3_000_000).egressGB).toBeCloseTo(498, 0);
	});

	it('grows to whole vCPUs once a core is not enough, and a matched box needs more than a viable one', () => {
		expect(needFor(30_000_000, 'viable').vcpu).toBe(3);
		expect(needFor(30_000_000).vcpu).toBe(4);
		expect(needFor(100_000_000, 'viable').vcpu).toBe(9);
		expect(needFor(100_000_000, 'matched').vcpu).toBe(11);
	});
});

describe('pricing a host', () => {
	it('excludes plans below the per-box memory the operating system, stack and database need', () => {
		expect(MEMORY_PER_BOX_GIB).toBeCloseTo(1.285, 3);
		const q = quote('vultr', needFor(10_000))!;
		expect(q.plan).toBe('vc2-1c-2gb');
	});

	it('adds backups to the plan price', () => {
		const q = quote('digitalocean', needFor(10_000))!;
		expect(q.usd).toBeCloseTo(12 * 1.2, 5);
	});

	it('takes a per-plan backup price where the provider sets one', () => {
		const q = quote('linode', needFor(10_000))!;
		expect(q.usd).toBeCloseTo(12 + 2.5, 5);
	});

	it('does not price a plan whose transfer is exceeded and whose overage is unsourced', () => {
		expect(CATALOG.providers.lightsail!.egressUSDPerGB).toBeUndefined();
		expect(quote('lightsail', needFor(1_000_000))).toBeDefined();
		expect(quote('lightsail', { ...needFor(1_000_000), egressGB: 10_000 })).toBeUndefined();
	});

	it('ranks providers cheapest first', () => {
		const list = ranked(needFor(1_000_000));
		expect(list.length).toBeGreaterThan(2);
		for (let i = 1; i < list.length; i += 1)
			expect(list[i]!.usd).toBeGreaterThanOrEqual(list[i - 1]!.usd);
		expect(cheapestUsdMonth(1_000_000)).toBe(list[0]!.usd);
	});

	it('prices a latency-matched origin as one box per region plus the global load balancer', () => {
		const each = quote('digitalocean', needFor(30_000))!.usd;
		const lb = CATALOG.providers.digitalocean!.loadBalancerUSDMonth!.global;
		expect(matchedUsdMonth(30_000)).toBeCloseTo(MATCHED_REGIONS * each + lb, 5);
	});
});

describe('a consolidated host priced on memory alone', () => {
	it('is the cheapest plan price a GiB times the memory the sites hold', () => {
		const rate = cheapestUsdPerGiBMonth();
		expect(rate).toBeGreaterThan(0);
		expect(consolidatedMemoryFloorUsdMonth(1000, 0.25)).toBeCloseTo(250 * rate, 6);
		for (const p of Object.values(CATALOG.providers))
			for (const plan of p.plans)
				expect(plan.monthlyUSD / plan.memoryGiB).toBeGreaterThanOrEqual(rate);
	});
});
