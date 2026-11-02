import { describe, expect, it } from 'vitest';
import { DO_REQ_RATE, WFP_BASE } from '../../scripts/economics/pricing';
import { DURABLE_OBJECTS, WORKERS_FOR_PLATFORMS } from '../../scripts/economics/rates';
import {
	ASSET_PAGE_HEADROOM,
	ASSET_PUBLISH,
	assetPublishBudget,
	billedGbS,
	coldUrlCost,
	COST_PER_VIEW,
	CPU_UNDERSTATEMENT,
	DEFAULT_MIX,
	DO_GB_ALLOCATED,
	DO_INVOCATIONS_PER_COLD_FILL,
	DURATION_CALIBRATION,
	editorialRowsPerDay,
	envelope,
	FILL_WINDOW_AMORTISATION,
	fleetIdleGbS,
	fleetStorage,
	FREE_CPU_MS_CAP,
	FREE_QUOTAS,
	HEAP_PACK_RATIO,
	IDLE_GB_S_PER_DAY,
	INSTALL_CPU_MS,
	KEEP_WARM_MS,
	keepWarmFleetCost,
	METER_FLUSH_SECONDS,
	METER_FLUSH_SECONDS_UNDER_LOAD,
	offWorkerArm,
	optimalOffWorker,
	PAID_DURATION,
	paidDurationCost,
	queueArm,
	REQUESTS_PER_PAGE_LOAD,
	ROWS_PER_FILL,
	ROWS_PER_FILL_NO_DBLOG,
	ROWS_PER_WRITE,
	rowsForWarmthMix,
	scoreInstall,
	scoreRejection,
	scoreWorkload,
	SECONDS_PER,
	SECONDS_PER_DAY,
	SEED_CACHE_TRIM,
	SHIPPING_ROWS_PER_FILL,
	SITE_STORAGE_BYTES,
	STEADY_STATE_WARMTH,
	storageCeiling,
	WARM_INTERVAL_MS,
	WORKFLOW_STEP_CPU_MS
} from '../../scripts/measure/free-envelope';

describe('the SERVING ceiling, where a cache hit is not free', () => {
	it('is bound by Worker requests, not by CPU or DO', () => {
		const env = envelope();
		expect(env.servingBoundBy).toBe('worker');
	});

	it('caps free at ~100,000 views/day even when 85% never touch PHP', () => {
		// a cached view is still a counted worker request, so caching rescues cpu and not this ceiling
		const env = envelope();
		expect(env.servingViewsPerDay).toBe(100_000);
	});

	it('does not improve when the mix becomes ALL edge hits', () => {
		const allCached = envelope({ edgeHit: 1, doHit: 0, miss: 0 });
		expect(allCached.servingViewsPerDay).toBe(100_000);
		expect(allCached.servingBoundBy).toBe('worker');
	});

	it('leaves the other meters with real headroom, which is why they are not the story', () => {
		const env = envelope();
		expect(env.perMeterViewCeiling.do).toBeGreaterThan(env.perMeterViewCeiling.worker * 4);
		expect(env.perMeterViewCeiling.rows).toBeGreaterThan(env.perMeterViewCeiling.worker * 4);
	});
});

describe('the REGENERATION ceiling, which is the one that decides the product', () => {
	it('is ROWS-bound on the alarm chain, which is the path a default deploy takes', () => {
		// a boot sliced at 8 ms per alarm is not real; a free worker drains a batch in one invocation (k=20)
		// SITE_WARM is still subtracted, and still spends 10,800 DO requests
		const env = envelope(DEFAULT_MIX, { windowed: false });
		expect(env.regenerationsPerDay).toBe(10_866);
		expect(env.regenerationBoundBy).toBe('rows');
	});

	it('gives the fill window the SAME ceiling, because the gap was the slicing artifact', () => {
		// a firing is one invocation on both paths; an extra divide by 25 gave ceilings 4x apart
		const env = envelope(DEFAULT_MIX, { windowed: true });
		expect(env.regenerationsPerDay).toBe(10_866);
		expect(env.regenerationBoundBy).toBe('rows');
	});

	it('is ROWS-bound on BOTH paths, which is what decides the work order', () => {
		expect(envelope(DEFAULT_MIX, { windowed: false }).regenerationBoundBy).toBe('rows');
		expect(envelope(DEFAULT_MIX, { windowed: true }).regenerationBoundBy).toBe('rows');
	});

	it('prices every measured warmth class, because no single figure describes a fill', () => {
		// the spread is 20x, so the model has to name which case it is charging for
		const perDay = (warmth: 'warmReassemble' | 'realRender' | 'firstEverForPath') =>
			envelope(DEFAULT_MIX, { windowed: true, warmth }).regenerationsPerDay;
		expect(perDay('warmReassemble')).toBeGreaterThan(perDay('realRender'));
		expect(perDay('realRender')).toBeGreaterThan(perDay('firstEverForPath'));
		// the flat 17 overstates every per-path class now; only the once-per-object fill exceeds it
		expect(ROWS_PER_FILL.realRender).toBeLessThan(17);
		expect(ROWS_PER_FILL.firstEverForPath).toBeLessThan(17);
		expect(ROWS_PER_FILL.firstFillOnFreshObject).toBeGreaterThan(17);
	});
});

describe('scoring the target workload, which is what the roadmap should be graded against', () => {
	it('3M visits/month serves with EXACTLY zero headroom', () => {
		// 3,000,000 / 30 is exactly the worker request quota; any further counted request breaks the day
		const v = scoreWorkload(3_000_000, 0.01, { windowed: true });
		expect(v.targetVisitsPerDay).toBe(100_000);
		expect(v.servingFits).toBe(true);
		expect(v.headroom.servingRatio).toBeCloseTo(1.0, 5);
	});

	it('at 1% dynamic the alarm chain covers it 2.5x over', () => {
		// 2.48x once warming is in the budget; earlier models read 4.8x, 1.05x and 2.78x
		const v = scoreWorkload(3_000_000, 0.01, { windowed: false });
		expect(v.fillsNeededPerDay).toBe(1_000);
		expect(v.regenerationFits).toBe(true);
		// the measured one-invocation firing takes this to 10.87x
		expect(v.headroom.regenerationRatio).toBeGreaterThan(10.5);
		expect(v.headroom.regenerationRatio).toBeLessThan(11.2);
	});

	it('PASSES at 1% dynamic with the fill window, with ~7x headroom', () => {
		const v = scoreWorkload(3_000_000, 0.01, { windowed: true });
		expect(v.verdict).toBe('fits');
		// 5x before the row and warmth-class corrections; the headroom is real, not an artefact
		expect(v.headroom.regenerationRatio).toBeGreaterThan(7);
	});

	it('passes at 0.1% dynamic even on the alarm chain', () => {
		const v = scoreWorkload(3_000_000, 0.001, { windowed: false });
		expect(v.verdict).toBe('fits');
	});

	it('reports serving-over above 3M/month, separately from regeneration', () => {
		const v = scoreWorkload(6_000_000, 0.0001, { windowed: true });
		expect(v.servingFits).toBe(false);
		expect(v.verdict).toBe('serving-over');
	});

	it('reports both-over when a workload misses on both ceilings', () => {
		const v = scoreWorkload(30_000_000, 0.05, { windowed: false });
		expect(v.verdict).toBe('both-over');
	});

	it('requires BOTH ceilings, so a servable-but-unregenerable site is not a pass', () => {
		// a site that serves 3M cached visits but cannot refresh them is stale; the verdict must refuse
		// the case moved with the ceiling (2%, then 3% at 2,777 fills a day, then 20%); the assertion did not
		const v = scoreWorkload(3_000_000, 0.2, { windowed: false });
		expect(v.servingFits).toBe(true);
		expect(v.verdict).not.toBe('fits');
	});
});

describe('the constants are the measured ones', () => {
	it('quotas are the documented free-plan dailies', () => {
		expect(FREE_QUOTAS.workerRequestsPerDay).toBe(100_000);
		// the one that makes slicing cost something: it explicitly includes alarm invocations
		expect(FREE_QUOTAS.doRequestsPerDay).toBe(100_000);
		expect(FREE_QUOTAS.rowsWrittenPerDay).toBe(100_000);
		expect(FREE_QUOTAS.durationGbSPerDay).toBe(13_000);
	});

	it('bills duration against the 128 MB an object is ALLOCATED, not what it uses', () => {
		// 0.128 is the decimal reading; cloudflare's worked example gives 128,000 GB-s per 1,000,000 s
		// the binary reading (0.125) was 2.4% low everywhere it appeared
		expect(DO_GB_ALLOCATED).toBe(0.128);
		expect(SECONDS_PER_DAY).toBe(86_400);
		expect(IDLE_GB_S_PER_DAY).toBe(SECONDS_PER_DAY * DO_GB_ALLOCATED);
		expect(IDLE_GB_S_PER_DAY).toBeCloseTo(11_059.2, 4);
		// an idle object uses 85.1% of the daily duration allowance; the binary reading gave 83.1%
		expect(IDLE_GB_S_PER_DAY / FREE_QUOTAS.durationGbSPerDay).toBeCloseTo(0.851, 3);
	});

	it('carries the read meter, which is 50x the write meter and was never modelled', () => {
		// reads have their own 5,000,000 a day meter; a workload must read 50 rows per row written before reads bind
		expect(FREE_QUOTAS.rowsReadPerDay).toBe(5_000_000);
		expect(FREE_QUOTAS.rowsReadPerDay / FREE_QUOTAS.rowsWrittenPerDay).toBe(50);
	});

	it('counts a setAlarm() as one row written, which an idle site pays 360 times a day', () => {
		expect(FREE_QUOTAS.rowsPerAlarmArm).toBe(1);
		// the keep-warm chain re-arms every 240 s: 86,400 / 240 = 360 arms, 360 rows, before the
		// site serves anything
		const armsPerDay = SECONDS_PER_DAY / 240;
		expect(armsPerDay * FREE_QUOTAS.rowsPerAlarmArm).toBe(360);
		expect(
			(armsPerDay * FREE_QUOTAS.rowsPerAlarmArm) / FREE_QUOTAS.rowsWrittenPerDay
		).toBeCloseTo(0.0036, 5);
	});

	it('an edge hit costs one Worker request and nothing else', () => {
		expect(COST_PER_VIEW.edgeHit).toEqual({ worker: 1, do: 0 });
	});

	it('charges ONE invocation per firing, because that is what a deployed free worker does', () => {
		expect(DO_INVOCATIONS_PER_COLD_FILL).toBe(1);
		// still exported and not divided into the invocation term; no measurement backs it
		expect(FILL_WINDOW_AMORTISATION).toBe(25);
	});
});

// duration is billed on wall clock against the 128 MB an object is allocated; it does not bind
// it is reported anyway; cpuTime excludes awaits, so every ceiling computed from it is an upper bound
describe('the DURATION meter, which is reported whether or not it binds', () => {
	it('does not bind at the serving ceiling, and says how much slack is left', () => {
		const e = envelope(DEFAULT_MIX, { windowed: true });
		expect(e.servingBoundBy).toBe('worker');
		expect(e.duration.availableGbS).toBe(FREE_QUOTAS.durationGbSPerDay);
		// ~271 of 13,000 GB-s; a render holding the object 50x longer would move this and nothing else
		expect(e.duration.servingUseGbS).toBeGreaterThan(0);
		expect(e.duration.servingUseGbS).toBeLessThan(FREE_QUOTAS.durationGbSPerDay * 0.1);
	});

	it('does not bind regeneration, by more than 10x on the conservative arm', () => {
		// the steady-state fill measured 308 ms at worst, deployed, so duration sits far above rows
		// it read 4-6x while a fill was priced at 2,127 ms (the cold-bins mixture)
		const e = envelope(DEFAULT_MIX, { windowed: true });
		const byDuration = Math.floor(e.duration.availableGbS / e.duration.perFillGbS);
		expect(e.regenerationBoundBy).toBe('rows');
		expect(byDuration).toBeGreaterThan(e.regenerationsPerDay * 10);
	});

	it('charges a cold fill far above a warm one, because boot is wall clock too', () => {
		const warm = envelope(DEFAULT_MIX, { windowed: true });
		const cold = envelope(DEFAULT_MIX, { windowed: true, fillWarmth: 'cold' });
		expect(cold.duration.perFillGbS / warm.duration.perFillGbS).toBeCloseTo(
			SECONDS_PER.coldRender / SECONDS_PER.warmRender,
			5
		);
		// and even then rows still bind, so the boot is not the regeneration story
		expect(cold.regenerationBoundBy).toBe('rows');
	});
});

// prices always-warm replicas only; a hibernating replica is unscored here and unmeasured anywhere
// a replica buys throughput, never quota, because rows are account-wide
describe('always-warm objects, which is only ONE of the replica architectures', () => {
	it('fits exactly ONE on free, at 83% of the allowance', () => {
		expect(FREE_QUOTAS.durationGbSPerDay / IDLE_GB_S_PER_DAY).toBeLessThan(2);
		expect(FREE_QUOTAS.durationGbSPerDay / IDLE_GB_S_PER_DAY).toBeGreaterThan(1);

		const one = envelope(DEFAULT_MIX, { windowed: true, alwaysWarmObjects: 1 });
		expect(one.duration.availableGbS).toBeCloseTo(1_940.8, 4);
		// serving still holds, because a cached view barely touches the meter
		expect(one.servingViewsPerDay).toBe(100_000);

		// and so does regeneration; at the measured 308 ms a fill, 1,940.8 GB-s funds more than rows allow
		const none = envelope(DEFAULT_MIX, { windowed: true });
		expect(one.regenerationBoundBy).toBe('rows');
		expect(one.regenerationsPerDay).toBe(none.regenerationsPerDay);
		expect(one.duration.availableGbS).toBeLessThan(none.duration.availableGbS);
	});

	it('takes BOTH ceilings to zero at two, before a single visitor arrives', () => {
		const two = envelope(DEFAULT_MIX, { windowed: true, alwaysWarmObjects: 2 });
		expect(two.duration.alwaysWarmGbS).toBeCloseTo(22_118.4, 4);
		expect(two.duration.availableGbS).toBeLessThan(0);
		expect(two.servingViewsPerDay).toBe(0);
		expect(two.servingBoundBy).toBe('duration');
		expect(two.regenerationsPerDay).toBe(0);
		expect(two.regenerationBoundBy).toBe('duration');
	});

	it('scores through scoreWorkload too, so a proposal cannot dodge it', () => {
		const v = scoreWorkload(3_000_000, 0.01, { windowed: true, alwaysWarmObjects: 2 });
		expect(v.verdict).toBe('both-over');
	});
});

describe('HIBERNATING replicas, which the always-warm arithmetic does not touch', () => {
	it('spends no idle duration at all, so eight of them still fit', () => {
		expect(fleetIdleGbS(8, 'hibernating')).toBe(0);
		const eight = envelope(DEFAULT_MIX, {
			windowed: true,
			alwaysWarmObjects: 8,
			replicaMode: 'hibernating'
		});
		expect(eight.duration.alwaysWarmGbS).toBe(0);
		expect(eight.servingViewsPerDay).toBe(100_000);
		expect(eight.regenerationBoundBy).toBe('rows');
	});

	it('is the SAME fleet size that always-warm refuses', () => {
		const warm = envelope(DEFAULT_MIX, { windowed: true, alwaysWarmObjects: 2 });
		const hibernating = envelope(DEFAULT_MIX, {
			windowed: true,
			alwaysWarmObjects: 2,
			replicaMode: 'hibernating'
		});
		expect(warm.servingViewsPerDay).toBe(0);
		expect(hibernating.servingViewsPerDay).toBeGreaterThan(0);
	});

	it('does NOT price the wake, and the model says so rather than implying zero', () => {
		// a hibernating replica pays a wake this model does not price; 0 here means not modelled
		// a wake restores or re-boots a 96 MiB interpreter on this runtime
		expect(fleetIdleGbS(4, 'hibernating')).toBe(0);
		expect(fleetIdleGbS(4, 'alwaysWarm')).toBe(4 * IDLE_GB_S_PER_DAY);
	});
});

// the paid plan, where the free-tier conclusion inverts at small replica counts
// rates are not verified by this project, so paidDurationCost() returns verified: false
describe('paid-plan duration, where "expensive" turns out to be wrong', () => {
	it('carries the unverified flag with the number, not in a comment', () => {
		expect(paidDurationCost(1).verified).toBe(false);
	});

	it('reads the duration price off the one rate card, with the date it was retrieved', () => {
		expect(PAID_DURATION.usdPerMillionGbS).toBe(DURABLE_OBJECTS.usdPerMillionGbS);
		expect(PAID_DURATION.includedGbSPerMonth).toBe(DURABLE_OBJECTS.gbSIncluded);
		expect(DURABLE_OBJECTS.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(DO_REQ_RATE).toBe(DURABLE_OBJECTS.usdPerMillionRequests);
		expect(WFP_BASE).toBe(WORKERS_FOR_PLATFORMS.usdPerMonth);
	});

	it('puts ONE always-warm replica INSIDE the included allowance', () => {
		const one = paidDurationCost(1);
		expect(one.gbSPerMonth).toBeCloseTo(331_776, 3);
		expect(one.gbSPerMonth).toBeLessThan(PAID_DURATION.includedGbSPerMonth);
		expect(one.billableGbS).toBe(0);
		expect(one.usd).toBe(0);
	});

	it('makes TWO cost a few dollars a month, not a cliff', () => {
		const two = paidDurationCost(2);
		expect(two.gbSPerMonth).toBeCloseTo(663_552, 3);
		expect(two.billableGbS).toBeCloseTo(263_552, 3);
		expect(two.usd).toBeCloseTo(3.29, 2);
	});

	it('so the paid objection is throughput and consistency, never the duration bill', () => {
		// on paid, always-warm duration is a line item, not a wall; ask about throughput, rows and consistency
		expect(paidDurationCost(4).usd).toBeCloseTo(11.59, 2);
		expect(paidDurationCost(4).usd).toBeLessThan(20);
	});
});

// an in-worker refusal still spends a worker request; only a rule evaluated before the worker saves one
// a waf's "requests blocked" count decides nothing here, since serving is the meter that binds
describe('rejecting bad traffic, scored against the meters rather than counted', () => {
	it('saves NOTHING on the serving meter when the Worker does the rejecting', () => {
		const saving = scoreRejection(10_000, 'worker');
		// `isNeverDrupal()` and `bodyTooLarge()` are this case: the Worker has to run to refuse
		expect(saving.saved.worker).toBe(0);
		expect(saving.savedShare.worker).toBe(0);
		// while the meters it DOES save on are the ones that were not binding
		expect(saving.saved.do).toBeGreaterThan(0);
		expect(saving.saved.rows).toBeGreaterThan(0);
		expect(saving.saved.durationGbS).toBeGreaterThan(0);
	});

	it('saves the Worker request only when the rule runs BEFORE the Worker', () => {
		const inWorker = scoreRejection(10_000, 'worker');
		const atEdge = scoreRejection(10_000, 'edge');
		expect(atEdge.saved.worker).toBe(10_000);
		expect(atEdge.savedShare.worker).toBeCloseTo(0.1, 10);
		// and the other three are identical, which is what makes the Worker column the whole
		// argument for a WAF rule over an in-Worker check
		expect(atEdge.saved.do).toBe(inWorker.saved.do);
		expect(atEdge.saved.rows).toBe(inWorker.saved.rows);
	});

	it('shows the ROWS meter is where a scanner actually hurts', () => {
		// a scanner's misses are fills: 1,000 of them is 9,000 rows (9% of the day) against 1% of the worker meter
		// it was 13% before the serve tables became WITHOUT ROWID
		const saving = scoreRejection(1_000, 'edge');
		expect(saving.savedShare.rows).toBeGreaterThan(saving.savedShare.worker * 5);
		expect(saving.savedShare.rows).toBeCloseTo(0.08, 5);
	});

	it('is zero on every meter for zero traffic, so the model cannot flatter a rule', () => {
		const saving = scoreRejection(0, 'edge');
		expect(saving.saved).toEqual({ worker: 0, do: 0, rows: 0, durationGbS: 0 });
	});
});

describe('the off-Worker path, the ONLY lever on the serving ceiling', () => {
	// static assets are free but cannot hold a runtime-rendered page; an r2 public bucket on a custom domain can
	// it is the one input that moves the serving ceiling off exactly 100,000 a day
	it('raises the ceiling 5.9x AND MOVES THE BINDING METER off Worker requests', () => {
		// once serving leaves the worker, worker requests stop binding; past here the lever is the do hits
		// after the rows correction the binding pair was rows at 17.2 per fill and do requests at 13.2
		const base = envelope({ edgeHit: 0.85, doHit: 0.14, miss: 0.01 });
		const off = envelope({ edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 0.85 });
		// an off-worker visit is priced as r2 class b reads (10M a month), so r2 binds before the do ceiling
		expect(base.servingBoundBy).toBe('worker');
		expect(off.servingBoundBy).toBe('r2ClassB');
		expect(off.perMeterViewCeiling.worker).toBe(666_666);
		// the rows figure moves with the warming subtraction and the do figure does not (1,344 rows a day)
		expect(off.perMeterViewCeiling.rows).toBe(1_086_634);
		expect(off.perMeterViewCeiling.do).toBe(524_705);
	});

	it('but trimming rows STOPS paying on the serving ceiling once DO binds', () => {
		// at 13.2 rows per fill the serving ceiling is do-bound, so cutting rows to 8 does not move it
		// a lever the binding meter does not respond to is not a lever
		const withDblog = envelope({ edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 0.85 });
		const without = envelope(
			{ edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 0.85 },
			{ rowsPerFill: ROWS_PER_FILL_NO_DBLOG }
		);
		expect(withDblog.servingBoundBy).toBe('r2ClassB');
		expect(without.perMeterViewCeiling.rows).toBeGreaterThan(
			withDblog.perMeterViewCeiling.rows
		);
		expect(without.servingViewsPerDay).toBe(withDblog.servingViewsPerDay);
	});

	it('serving every cached page off the Worker is R2-bound at 3.37x, not the 12.5x once claimed', () => {
		// 10M class b reads a month is 333,333 a day; with no cdn in front, ~3.37x the 100,000 worker ceiling
		// the earlier 12.5x (37.5M) figure came from a sentence about a different product
		const all = envelope(
			{ edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 0.99 },
			{ rowsPerFill: ROWS_PER_FILL_NO_DBLOG }
		);
		expect(all.servingBoundBy).toBe('r2ClassB');
		expect(all.servingViewsPerDay).toBe(336_700);
		expect(all.servingViewsPerDay / 100_000).toBeCloseTo(3.37, 1);
	});

	it('CDN absorption is the only thing that lifts it past 3.37x, and it is an assumption', () => {
		// absorption defaults to 0 because it has never been measured; a caller passing one states an assumption
		// the ceiling scales as 3.37x / (1 - absorption) until another meter binds, which at 0.9 is rows
		const mix = { edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 0.99 };
		const none = envelope(mix, { rowsPerFill: ROWS_PER_FILL_NO_DBLOG });
		const half = envelope(mix, { rowsPerFill: ROWS_PER_FILL_NO_DBLOG, cdnAbsorption: 0.5 });
		expect(half.servingViewsPerDay).toBe(none.servingViewsPerDay * 2);
		expect(half.servingBoundBy).toBe('r2ClassB');

		const most = envelope(mix, { rowsPerFill: ROWS_PER_FILL_NO_DBLOG, cdnAbsorption: 0.9 });
		expect(most.servingBoundBy).not.toBe('r2ClassB');
	});

	it('clamps absorption rather than trusting a caller to pass a fraction', () => {
		const mix = { edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 0.99 };
		expect(envelope(mix, { cdnAbsorption: -1 }).servingBoundBy).toBe('r2ClassB');
		// absorption of 1 means nothing reaches R2 at all, so the R2 meter stops binding
		expect(envelope(mix, { cdnAbsorption: 2 }).servingBoundBy).not.toBe('r2ClassB');
	});

	it('turns 3M/month from saturated into comfortable', () => {
		// 3M/month currently fits at exactly 1.00x with zero headroom
		const saturated = scoreWorkload(3_000_000, 0.01, { windowed: true });
		expect(saturated.headroom.servingRatio).toBeCloseTo(1.0, 5);

		const withAssets = scoreWorkload(3_000_000, 0.01, {
			windowed: true,
			mix: { edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 0.85 }
		});
		expect(withAssets.verdict).toBe('fits');
		// was >5.5 while off-Worker serving was modelled as free; R2's read meter makes it ~3.4x
		expect(withAssets.headroom.servingRatio).toBeGreaterThan(3.3);
	});

	it('cannot move more off the Worker than there are cached views to move', () => {
		// 1.5 is the over-claim case; 0.99 equals edgeHit + doHit, so it never reaches the clamp
		const overClaimed = envelope({ edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 1.5 });
		const everything = envelope({ edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 0.99 });
		expect(overClaimed.servingViewsPerDay).toBe(everything.servingViewsPerDay);
		// past the optimum it hurts: more mirroring spends a 333,333/day r2 meter to save a 100,000/day one
		// 0.77 peaks at 432,900 views a day and 0.99 falls back to 336,700
		const edgeOnly = envelope({ edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 0.85 });
		expect(everything.servingViewsPerDay).toBeLessThan(edgeOnly.servingViewsPerDay);

		const optimum = envelope({ edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 0.77 });
		expect(optimum.servingViewsPerDay).toBe(432_900);
		expect(optimum.servingViewsPerDay).toBeGreaterThan(everything.servingViewsPerDay);
		expect(optimum.servingViewsPerDay).toBeGreaterThan(edgeOnly.servingViewsPerDay);
	});

	it('leaves the REGENERATION ceiling untouched, because serving renders nothing', () => {
		const off = envelope({ edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 0.85 });
		const plain = envelope({ edgeHit: 0.85, doHit: 0.14, miss: 0.01 });
		expect(off.regenerationsPerDay).toBe(plain.regenerationsPerDay);
	});

	it('defaults to zero off-Worker, so the model never flatters the current architecture', () => {
		const base = envelope({ edgeHit: 0.85, doHit: 0.14, miss: 0.01 });
		expect(base.servingBoundBy).toBe('worker');
		expect(base.servingViewsPerDay).toBe(100_000);
	});
});

describe('the fill BATCH, which the model shipped without and the code already had', () => {
	// src/site-do.ts defaults FILL_BATCH_SIZE to 5; the batch amortises the alarm re-arm row
	// the first version of this model lacked it and understated a ceiling the shipped code already beat
	it('barely moves the ceiling now, because rows bind at either batch size', () => {
		// with one invocation per firing the batch only amortises the re-arm row: about 1.1x on the ceiling
		// it still sizes latency and isolate memory: a batch is N workloads in one invocation, which reset four sites at 25
		expect(envelope(DEFAULT_MIX, { windowed: false, fillBatch: 1 }).regenerationsPerDay).toBe(
			9_900
		);
		expect(envelope(DEFAULT_MIX, { windowed: false }).regenerationsPerDay).toBe(10_866);
	});

	it('moves the windowed path from DO-bound to ROWS-bound', () => {
		// boot is not the windowed constraint: rows bind even unbatched (5,813 to 7,575 rows per fill)
		// the batch still raises the ceiling, but it no longer changes which meter binds
		const unbatched = envelope(DEFAULT_MIX, { windowed: true, fillBatch: 1 });
		const shipped = envelope(DEFAULT_MIX, { windowed: true });
		expect(unbatched.regenerationBoundBy).toBe('rows');
		expect(shipped.regenerationBoundBy).toBe('rows');
		expect(shipped.regenerationsPerDay).toBe(10_866);
	});

	it('shows boot work is still nearly saturated, but LESS so since rows-per-fill fell', () => {
		// batch 5 -> 100 is a 20x reduction in boot cost per fill. It bought 1.1% while a fill cost
		// 12 rows and buys **2.1%** at 9, which is the reopening this assertion's previous comment
		// predicted in so many words: boot-directed work is bounded by rows-per-fill, so making rows
		// cheaper is what makes boot matter more. Still small; no longer shrinking.
		const at5 = envelope(DEFAULT_MIX, { windowed: true, fillBatch: 5 }).regenerationsPerDay;
		const at100 = envelope(DEFAULT_MIX, { windowed: true, fillBatch: 100 }).regenerationsPerDay;
		expect(at100 / at5).toBeGreaterThan(1.02);
		expect(at100 / at5).toBeLessThan(1.03);
	});

	it('shows rows work paying all the way down to a fraction of a row per fill', () => {
		const ladder = [17, 8, 4, 2, 1].map(
			(rows) =>
				envelope(DEFAULT_MIX, { windowed: true, rowsPerFill: rows }).regenerationsPerDay
		);
		// the binding third meter is now duration; the r2 class a term applies only when a mirror exists
		expect(ladder[1]! / ladder[0]!).toBeGreaterThan(2);
		expect(ladder[2]! / ladder[0]!).toBeGreaterThan(4);
		// 2 to 1 still gains, because the r2 class a term no longer applies to a config that writes nothing to r2
		expect(ladder[4]!).toBeGreaterThan(ladder[3]!);
		// duration takes over only below ~0.27 rows/fill now; it was ~1.9 at the cold-bins figure
		expect(envelope(DEFAULT_MIX, { windowed: true, rowsPerFill: 1 }).regenerationBoundBy).toBe(
			'rows'
		);
		expect(
			envelope(DEFAULT_MIX, { windowed: true, rowsPerFill: 0.25 }).regenerationBoundBy
		).toBe('duration');
		// and the R2 term still applies when a mirror really exists
		expect(
			envelope(DEFAULT_MIX, { windowed: true, rowsPerFill: 1, mirror: true })
				.regenerationBoundBy
		).toBe('r2ClassA');
	});

	it('treats a batch below 1 as 1 rather than dividing by zero', () => {
		expect(envelope(DEFAULT_MIX, { fillBatch: 0 }).regenerationsPerDay).toBeGreaterThan(0);
		expect(envelope(DEFAULT_MIX, { fillBatch: -5 }).regenerationsPerDay).toBeGreaterThan(0);
	});
});

describe('the THIRD meter, which neither ceiling can see', () => {
	it('records the Cloudflare Images monthly cap', () => {
		// free allows 5,000 unique transforms a month and fails as a hard cap, not a bill
		// each image style is a unique transform on /cdn-cgi/image/: 10 styles over 2,000 images is 4x the cap
		expect(FREE_QUOTAS.imageTransformsPerMonth).toBe(5_000);
	});

	it('is a MONTHLY figure, unlike every other quota here', () => {
		// mixing it into a per-day comparison would understate it by 30x in the dangerous direction
		expect(FREE_QUOTAS.imageTransformsPerMonth).toBeLessThan(FREE_QUOTAS.workerRequestsPerDay);
	});
});

describe('Workflows on free, where the figure quoted for it was a PAID one', () => {
	// free allows 1,024 steps per instance and 3,000 a day; 25,000 is the paid per-instance ceiling
	// a step buys divisibility, not cpu: each still gets the same 10 ms as any invocation
	it('does not pretend a step buys more CPU', () => {
		expect(WORKFLOW_STEP_CPU_MS).toBe(10);
	});

	it('records the FREE per-instance limit, not the paid 25,000', () => {
		expect(FREE_QUOTAS.workflowStepsPerInstance).toBe(1_024);
		expect(FREE_QUOTAS.workflowStepsPerDay).toBe(3_000);
	});

	it('an install FITS one free instance, which is what makes free equivalent here', () => {
		// 6,810 ms of edge cpuTime (n=3) at 10 ms a step
		const v = scoreInstall();
		expect(v.stepsPerInstall).toBe(681);
		expect(v.fitsOneInstance).toBe(true);
		expect(v.problems).toEqual([]);
	});

	it('supports 4 installs/day on free, which is thin for an admin operation', () => {
		// the edge figure moves this 18 -> 4, which is a real product constraint
		expect(scoreInstall().installsPerDay).toBe(4);
	});

	it('REFUSES to claim an install fits when it does not', () => {
		// a module 10x heavier must be named against the per-instance limit, not planned past step 1,024
		const heavy = scoreInstall(INSTALL_CPU_MS * 10);
		expect(heavy.fitsOneInstance).toBe(false);
		expect(heavy.problems.join(' ')).toContain('1024');
		expect(heavy.problems.join(' ')).toContain('child instances');
	});

	it('flags that a Workflow invocation spends the SERVING quota', () => {
		// it shares the serving quota, the same trap as the cron trigger; serving is saturated at 3M a month
		expect(scoreInstall().sharesServingQuota).toBe(true);
	});
});

// the rows-per-fill default is settled by pricing a distribution of warmth classes, not one
// firstEverForPath understates the ceiling 5x; a bare realRender rested on argument until priced
describe('pricing a spread of warmth classes instead of picking one', () => {
	it('weights each class by its share, using the weights AS GIVEN', () => {
		expect(rowsForWarmthMix({ realRender: 1 })).toBe(ROWS_PER_FILL.realRender);
		expect(rowsForWarmthMix({ realRender: 0.5, warmReassemble: 0.5 })).toBe(
			(ROWS_PER_FILL.realRender + ROWS_PER_FILL.warmReassemble) / 2
		);
	});

	it('does NOT normalise a mix that misses 1, because that is a caller bug', () => {
		// silently rescaling would turn a typo into a plausible number, which is the whole
		// failure mode this model exists to prevent
		expect(rowsForWarmthMix({ realRender: 0.5 })).toBe(ROWS_PER_FILL.realRender / 2);
	});

	it('refuses a negative weight rather than letting it cancel another class', () => {
		expect(() => rowsForWarmthMix({ realRender: 1, warmReassemble: -1 })).toThrow(RangeError);
		expect(() => rowsForWarmthMix({ realRender: Number.NaN })).toThrow(RangeError);
	});

	it('is empty-safe', () => {
		expect(rowsForWarmthMix({})).toBe(0);
	});

	it('leaves firstFillAfterMigrate OUT of a steady-state day', () => {
		// once per object lifetime is not a rate; putting it in a per-day mix is a category error
		expect(STEADY_STATE_WARMTH.firstFillAfterMigrate).toBeUndefined();
	});

	it('sums to a whole day', () => {
		const total = Object.values(STEADY_STATE_WARMTH).reduce((a, b) => a + b, 0);
		expect(total).toBeCloseTo(1, 10);
	});
});

describe('THE ANSWER: the realRender default is CONSERVATIVE once the classes are re-measured', () => {
	// the mix prices below the single-class default because the cold tail got cheaper
	// firstEverForPath stood at 62 and re-measures at 24 (n=3); the mix is 10.10 against a 12 default
	it('prices the mix BELOW the single-class default, because the cold tail got cheaper', () => {
		const mixed = rowsForWarmthMix(STEADY_STATE_WARMTH);
		const single = ROWS_PER_FILL.realRender;
		expect(mixed).toBeLessThan(single);
		// the direction is the claim; the band survives a pack that moves the tail, and fails on a return to 62
		expect((single - mixed) / single).toBeGreaterThan(0.05);
		expect((single - mixed) / single).toBeLessThan(0.35);
	});

	it('leaves the shipped ceiling understated rather than overstated', () => {
		const base = envelope(DEFAULT_MIX, { windowed: true }).regenerationsPerDay;
		const mixed = envelope(DEFAULT_MIX, {
			windowed: true,
			warmthMix: STEADY_STATE_WARMTH
		}).regenerationsPerDay;
		expect(base).toBe(10_866);
		// the steady state regenerates more than the quoted figure, so the docs number is a floor
		expect(mixed).toBeGreaterThan(base);
	});

	it('shows the WORST case still understates the ceiling, now by about 1.9x', () => {
		const real = envelope(DEFAULT_MIX, { windowed: true, warmth: 'realRender' });
		const worst = envelope(DEFAULT_MIX, { windowed: true, warmth: 'firstEverForPath' });
		// charging every regeneration a once-per-path cost still understates the ceiling, by about 1.9x
		expect(real.regenerationsPerDay / worst.regenerationsPerDay).toBeGreaterThan(1.5);
	});

	it('keeps the once-per-object fill out of any per-day mix', () => {
		// firstFillOnFreshObject is 157 rows, paid once per object; the fleet model charges it per site, never per day
		expect(ROWS_PER_FILL.firstFillOnFreshObject).toBeGreaterThan(
			ROWS_PER_FILL.firstEverForPath
		);
		expect(
			(STEADY_STATE_WARMTH as Record<string, number | undefined>)['firstFillOnFreshObject']
		).toBeUndefined();
	});

	it('keeps rowsPerFill as the most-specific override, ahead of both', () => {
		const pinned = envelope(DEFAULT_MIX, {
			windowed: true,
			rowsPerFill: 13,
			warmth: 'firstEverForPath',
			warmthMix: STEADY_STATE_WARMTH
		});
		const bare = envelope(DEFAULT_MIX, { windowed: true, rowsPerFill: 13 });
		expect(pinned.regenerationsPerDay).toBe(bare.regenerationsPerDay);
	});

	it('threads the mix through scoreWorkload, not just envelope', () => {
		const v = scoreWorkload(3_000_000, 0.01, {
			windowed: true,
			warmthMix: STEADY_STATE_WARMTH
		});
		expect(v.verdict).toBe('fits');
		expect(v.envelope.regenerationBoundBy).toBe('rows');
	});
});

// the off-worker lever has a maximum: past the crossing, mirroring more spends r2 reads to save worker requests
// optimalOffWorker() derives the share from envelope(), so the report and page-mirror.ts cannot drift apart
describe('the optimal mirror share', () => {
	it('reproduces the 77% / 432,900 the report quotes, from the model rather than a constant', () => {
		const o = optimalOffWorker();
		expect(o.share).toBeCloseTo(0.769, 3);
		expect(o.viewsPerDay).toBe(432_900);
		// the Worker meter is what it is still bound by at the peak, which is why the peak is a peak
		expect(o.boundBy).toBe('worker');
	});

	it('shows what maximising gives up', () => {
		const o = optimalOffWorker();
		// mirroring everything mirrorable falls BACK, and by a fifth
		expect(o.atFullMirror.share).toBeCloseTo(0.99, 3);
		expect(o.atFullMirror.viewsPerDay).toBe(336_700);
		expect(o.costOfMaximising).toBe(96_200);
		expect(o.costOfMaximising / o.viewsPerDay).toBeGreaterThan(0.22);
	});

	it('is measured against mirroring nothing, which is exactly the Worker ceiling', () => {
		const o = optimalOffWorker();
		expect(o.atNoMirror.viewsPerDay).toBe(FREE_QUOTAS.workerRequestsPerDay);
		expect(o.viewsPerDay).toBeGreaterThan(o.atNoMirror.viewsPerDay);
	});

	it('never proposes mirroring more than the cacheable share', () => {
		const o = optimalOffWorker();
		expect(o.share).toBeLessThanOrEqual(DEFAULT_MIX.edgeHit + DEFAULT_MIX.doHit);
	});

	// cdn absorption raises the peak but does not make mirroring everything the answer
	// at absorption 1 the ceiling lands on rows, so past that share mirroring buys nothing
	it('moves with cdnAbsorption, and the ceiling lands on another meter rather than vanishing', () => {
		const none = optimalOffWorker();
		const half = optimalOffWorker(undefined, { cdnAbsorption: 0.5 });
		const all = optimalOffWorker(undefined, { cdnAbsorption: 1 });

		expect(half.viewsPerDay).toBeGreaterThan(none.viewsPerDay);
		expect(all.viewsPerDay).toBeGreaterThanOrEqual(half.viewsPerDay);

		expect(all.boundBy).toBe('rows');
		expect(all.share).toBeLessThan(DEFAULT_MIX.edgeHit + DEFAULT_MIX.doHit);
		expect(all.costOfMaximising).toBeGreaterThanOrEqual(0);
	});

	it('picks the SMALLEST share that reaches the peak, so nothing is mirrored for free', () => {
		const o = optimalOffWorker(undefined, { cdnAbsorption: 1 });
		// one step below the reported share must be strictly worse, or the share is not minimal
		const justUnder = envelope(
			{ ...DEFAULT_MIX, offWorker: o.share - o.step },
			{ cdnAbsorption: 1 }
		);
		expect(justUnder.servingViewsPerDay).toBeLessThan(o.viewsPerDay);
	});
});

describe('the keep-warm chain, priced across a FLEET rather than one site', () => {
	// a firing writes one setAlarm row; the meter flush has its own clock, so at 240 s arms outnumber flushes
	it('costs 360 arms a day per site and one flush per 96 of them', () => {
		const one = keepWarmFleetCost(1);
		expect(one.armsPerSitePerDay).toBe(360);
		// 360 setAlarm rows + 96 packed meter rows (720 at a 60 s checkpoint; 1,080 before that)
		expect(one.rowsPerDay).toBe(456);
		expect(one.rowShare).toBeCloseTo(0.00456, 6);
	});

	it('spends TWO account-wide meters, not one', () => {
		const fleet = keepWarmFleetCost(100);
		expect(fleet.rowsPerDay).toBe(45_600);
		// the do request quota includes alarm invocations, so the same 360 arms are charged twice
		expect(fleet.doRequestsPerDay).toBe(36_000);
		expect(fleet.rowShare).toBeCloseTo(0.456, 6);
		expect(fleet.doRequestShare).toBeCloseTo(0.36, 6);
	});

	/** rows bind before requests, which is what makes the meter flush worth its own term */
	it('saturates a free account at 219 sites with ZERO visitors', () => {
		// 219 sites saturate a free account with zero visitors; earlier flush costs gave 92 and 138
		expect(keepWarmFleetCost(1).saturatingSites).toBe(219);
		const saturated = keepWarmFleetCost(219);
		expect(saturated.rowShare).toBeLessThanOrEqual(1);
		expect(keepWarmFleetCost(220).rowsPerDay).toBeGreaterThan(FREE_QUOTAS.rowsWrittenPerDay);
	});

	// the 8 s interval that ships under SITE_WARM; the flush is amortised here, not charged per firing
	it('amortises the meter flush at the 8 s warming interval', () => {
		const warm = keepWarmFleetCost(1, 8_000);
		expect(warm.armsPerSitePerDay).toBe(10_800);
		// 10,800 setAlarm rows + 96 flushes; envelope() subtracts this before dividing (12,240 and 13,680 before)
		expect(warm.rowsPerDay).toBe(10_896);
		expect(warm.rowShare).toBeCloseTo(0.10896, 4);
		expect(warm.doRequestShare).toBeCloseTo(0.108, 4);
	});

	// the published ceiling assumed a site that does not stay resident; an unset paid site warms at 8 s
	// it spends 10,896 rows and 10,800 do requests a day first; a site at the ceiling is far above the ~505 crossing
	it('is subtracted from the budget the regeneration ceiling divides', () => {
		const warmed = envelope(DEFAULT_MIX, { windowed: true });
		const unwarmed = envelope(DEFAULT_MIX, { windowed: true, warmed: false });

		// the control: with warming off the model answers what it published for a year
		expect(unwarmed.warming.rowsPerDay).toBe(0);
		expect(unwarmed.regenerationsPerDay).toBe(12_195);

		expect(warmed.warming.rowsPerDay).toBe(10_896);
		expect(warmed.warming.doRequestsPerDay).toBe(10_800);
		expect(warmed.warming.rowShare).toBeCloseTo(0.10896, 4);
		// 10.9% of the row budget gone, so the ceiling is 10.9% lower and not a rounding difference
		expect(warmed.regenerationsPerDay).toBe(10_866);
		expect(warmed.regenerationsPerDay / unwarmed.regenerationsPerDay).toBeCloseTo(0.8911, 3);
	});

	it('prices a longer interval as cheaper, so an operator can buy the ceiling back', () => {
		const shipped = envelope(DEFAULT_MIX, { windowed: true });
		const slower = envelope(DEFAULT_MIX, { windowed: true, keepWarmMs: 16_000 });
		expect(slower.warming.rowsPerDay).toBeLessThan(shipped.warming.rowsPerDay);
		expect(slower.regenerationsPerDay).toBeGreaterThan(shipped.regenerationsPerDay);
	});

	// the arm term scales with the interval and the meter term does not, so the two are modelled separately
	// the checkpoint has its own 900 s clock, so halving the arms leaves the meter term untouched
	it('halves only the arm term, because the checkpoint is on its own clock', () => {
		const shipping = keepWarmFleetCost(100, KEEP_WARM_MS);
		const halved = keepWarmFleetCost(100, KEEP_WARM_MS * 2);
		expect(halved.armsPerSitePerDay).toBe(shipping.armsPerSitePerDay / 2);
		expect(halved.doRequestsPerDay).toBe(shipping.doRequestsPerDay / 2);
		// the control: if the meter term had halved too this would be an equality
		expect(halved.rowsPerDay).toBeGreaterThan(shipping.rowsPerDay / 2);
		expect(halved.rowsPerDay).toBeLessThan(shipping.rowsPerDay);
		// and what is left over is exactly the meter term, which did not move
		const meterTerm = shipping.rowsPerDay - shipping.doRequestsPerDay;
		expect(halved.rowsPerDay - halved.doRequestsPerDay).toBe(meterTerm);
	});
});

describe('the duration meter, calibrated on a deployed object', () => {
	it('reproduces the billed GB-s from the wall clock, exactly', () => {
		// 10.026244 s * 0.128 GB. If this ever drifts, either the allocation changed or the
		// reading was taken from the wrong dataset again
		const seconds = DURATION_CALIBRATION.activeTimeUs / 1_000_000;
		expect(billedGbS(seconds)).toBeCloseTo(DURATION_CALIBRATION.durationGbS, 9);
	});

	it('confirms 0.128 from BILLING rather than from a docs example', () => {
		const seconds = DURATION_CALIBRATION.activeTimeUs / 1_000_000;
		expect(DURATION_CALIBRATION.durationGbS / seconds).toBeCloseTo(DO_GB_ALLOCATED, 9);
	});

	it('records how far cpuTime understates it, which is the caveat with a number on it', () => {
		// 2,612x on a workload that spends its time awaiting. Every ceiling computed from
		// SECONDS_PER is a LOWER bound and the gap is unbounded, not small
		expect(CPU_UNDERSTATEMENT).toBeGreaterThan(2_000);
		expect(DURATION_CALIBRATION.cpuTimeUs).toBeLessThan(DURATION_CALIBRATION.activeTimeUs);
	});

	it('bills nothing for negative or zero wall clock', () => {
		expect(billedGbS(0)).toBe(0);
		expect(billedGbS(-5)).toBe(0);
	});
});

describe('a queue-backed fill, which is the lever Queues going free reopened', () => {
	// cloudflare bills a message three times (write, read, delete), so 10,000 operations are 3,333 messages
	it('divides the operation quota by the three operations a message costs', () => {
		expect(FREE_QUOTAS.queueOperationsPerMessage).toBe(3);
		expect(queueArm().messagesPerDay).toBe(3_333);
	});

	// priced under one batching assumption; per-page billing against a batched alarm arm made queue ops look binding
	it('carries a batch per message, so the message quota is not the binding meter', () => {
		const arm = queueArm(undefined, { windowed: true });
		expect(arm.pathsPerMessage).toBe(5);
		expect(arm.fillsFromMessagesPerDay).toBe(16_665);
		expect(arm.fillsFromMessagesPerDay).toBeGreaterThan(arm.alarmRegenerationsPerDay);
		expect(arm.queueBoundBy).not.toBe('queueOps');
	});

	// a queue removes the amortised alarm re-arm row (1/batch of a row): close to free, close to worthless
	it('moves the windowed ceiling by about 1.5%, not by 2.27x in either direction', () => {
		const arm = queueArm(undefined, { windowed: true });
		expect(arm.alarmRegenerationsPerDay).toBe(10_866);
		expect(arm.ratio).toBeGreaterThan(1);
		expect(arm.ratio).toBeLessThan(1.05);
	});

	// and the cold arm now behaves like the windowed one, for the reason the two converged
	it('buys the same ~2.5% on the cold arm, because both paths are rows-bound now', () => {
		// both paths are rows-bound, so a queue only drops the amortised re-arm row; it adds a meter and replaces none
		const arm = queueArm();
		expect(arm.queueRegenerationsPerDay).toBeGreaterThan(arm.alarmRegenerationsPerDay);
		expect(arm.ratio).toBeGreaterThan(1);
		expect(arm.ratio).toBeLessThan(1.05);
	});

	// a queue adds worker requests on top of the do requests a fill still needs
	// batching cuts those from one per fill to one per message
	it('spends Worker requests on top of the DO requests the fill still needs', () => {
		const arm = queueArm(undefined, { windowed: true });
		expect(arm.workerRequestsPerDay).toBe(Math.ceil(arm.queueRegenerationsPerDay / 5));
		expect(arm.workerRequestsPerDay).toBeGreaterThan(0);
		expect(arm.workerRequestsPerDay).toBeLessThan(arm.queueRegenerationsPerDay);
	});
});

// the sixth meter, and the only one that is not a daily rate: it answers "how many sites"
describe('stored bytes, the meter that counts CUSTOMERS rather than traffic', () => {
	it('is bound by the snapshot rather than by the database', () => {
		// over 5x the seed before the packed cache_container row was fixed, 2.26x after (36,569,088 to 10,420,224 bytes)
		// the snapshot still dominates, by less than it did
		expect(SITE_STORAGE_BYTES.heapSnapshot).toBeGreaterThan(SITE_STORAGE_BYTES.seed * 2);
	});

	// the arms differ ~1.7x once the image is packed (was 3.3x); the default is packed because packed ships
	it('charges the packed image by default, since that is what a site stores', () => {
		const on = storageCeiling(true);
		const off = storageCeiling(false);
		expect(on.packed).toBe(true);
		// the formula is pinned, not the count: a page of packed PHP moves the count (122 to 121 pages)
		const expected = (heap: number) =>
			Math.floor(FREE_QUOTAS.storageBytes / (SITE_STORAGE_BYTES.seed + heap));
		expect(on.sitesPerAccount).toBe(expected(SITE_STORAGE_BYTES.packedHeapSnapshot));
		expect(storageCeiling(true, 0, false).sitesPerAccount).toBe(
			expected(SITE_STORAGE_BYTES.heapSnapshot)
		);
		expect(off.sitesPerAccount).toBeGreaterThan(on.sitesPerAccount);
	});

	// HEAP_IMAGE is off by default: a deployed A/B read the restore at 1,912 ms cpu against 1,264 booting
	// the test asserts the direction only, not the magnitude
	it('holds more tenants when a stored image is packed than when it is not', () => {
		const raw = storageCeiling(true, 0, false);
		const packed = storageCeiling(true, 0, true);
		expect(packed.sitesPerAccount).toBeGreaterThan(raw.sitesPerAccount);
		// bounded by the image's SHARE of a site, so it can never reach the codec's own ratio --
		// the seed does not compress and is charged in full either way
		expect(packed.sitesPerAccount / raw.sitesPerAccount).toBeLessThan(HEAP_PACK_RATIO);
	});

	// the seed cache trim was measured on two packs: a sign flip on the traced-list pack, a saving on the from-source one
	// both readings stay on record, since asserting one alone would erase the refuting measurement
	it('records both packs the seed cache trim was measured on', () => {
		// the traced-list pack: saves at provisioning, gives more than all of it back on the render
		expect(SEED_CACHE_TRIM.savedAtProvisioning).toBeGreaterThan(0);
		expect(SEED_CACHE_TRIM.savedAfterOneRender).toBeLessThan(0);
		expect(SEED_CACHE_TRIM.extraRowsOnFirstRender).toBeGreaterThan(0);

		// the from-source pack: the sign does not change, and the verdict follows the sign
		expect(SEED_CACHE_TRIM.savedAfterOneRenderFromSourcePack).toBeGreaterThan(0);
		expect(SEED_CACHE_TRIM.refuted).toBe(false);
		// and it is priced on BOTH meters, because storage is a cap and rows are a rate
		expect(SEED_CACHE_TRIM.extraTenantsFromSourcePack).toBeGreaterThan(0);
		expect(SEED_CACHE_TRIM.extraRowsOnFirstRenderFromSourcePack).toBeGreaterThan(0);
	});

	describe('a FLEET against the cap, which is what the hard limit actually asks', () => {
		it('fits at the ceiling and not one site past it', () => {
			const ceiling = storageCeiling(true).sitesPerAccount;
			expect(fleetStorage(ceiling).fits).toBe(true);
			expect(fleetStorage(ceiling + 1).fits).toBe(false);
		});

		it('reports the share so a fleet under the cap still shows how close it is', () => {
			const half = Math.floor(storageCeiling(true).sitesPerAccount / 2);
			const v = fleetStorage(half);
			expect(v.share).toBeGreaterThan(0.4);
			expect(v.share).toBeLessThan(0.6);
			expect(v.usedBytes).toBe(half * v.perSiteBytes);
		});

		it('holds more sites without an image than with one', () => {
			// derived from the imaged ceiling, not a chosen count: one site past it must not fit with an image
			// and must fit without, whatever the pack measures
			const past = storageCeiling(true).sitesPerAccount + 1;
			expect(fleetStorage(past, { heapSnapshot: true }).fits).toBe(false);
			expect(fleetStorage(past, { heapSnapshot: false }).fits).toBe(true);
		});

		it('charges nothing for zero sites and refuses to charge for negative ones', () => {
			expect(fleetStorage(0).usedBytes).toBe(0);
			expect(fleetStorage(-5).sites).toBe(0);
		});
	});

	// 23,724,032 came from an unmigrated object, which now builds a container and reads high
	// quoting it would understate the fleet; the bare-object figure is not a site's storage
	it('uses the provisioned snapshot size, not the bare-object one', () => {
		expect(SITE_STORAGE_BYTES.heapSnapshot).not.toBe(23_724_032);
		expect(storageCeiling(true).sitesPerAccount).toBeGreaterThan(
			Math.floor(FREE_QUOTAS.storageBytes / (SITE_STORAGE_BYTES.seed + 23_724_032))
		);
	});

	it('charges the content a real site accumulates', () => {
		const bare = storageCeiling(false);
		const withContent = storageCeiling(false, 10_000_000);
		expect(withContent.sitesPerAccount).toBeLessThan(bare.sitesPerAccount);
	});

	// reported beside the verdict rather than folded into it; the rate ceilings score one site
	it('rides on the verdict without changing it', () => {
		const v = scoreWorkload(3_000_000, 0.01);
		expect(v.storage.withSnapshot.sitesPerAccount).toBe(storageCeiling(true).sitesPerAccount);
		expect(v.verdict).toBe('fits');
	});
});

describe('what a cold url costs its first visitor', () => {
	it('prices the alarm retry as two Worker requests and three DO requests', () => {
		const alarm = coldUrlCost().find((m) => m.mechanism === 'alarmRetry');
		expect(alarm).toBeDefined();
		expect(alarm!.worker).toBe(2);
		expect(alarm!.do).toBe(3);
		// the extra row is the `setAlarm()`, on top of what the fill itself writes
		expect(alarm!.rows).toBe(1 + ROWS_PER_FILL.realRender);
		expect(alarm!.fitsFreeCap).toBe(true);
	});

	it('refuses the inline boot on the CAP rather than on a budget', () => {
		const inline = coldUrlCost().find((m) => m.mechanism === 'inlineBoot');
		// cheapest on every meter and still refused: 1,398 ms against a 10 ms cap is 140x, which is
		// why raising RENDER_BUDGET_MS moved nothing
		expect(inline!.worker).toBe(1);
		expect(inline!.do).toBe(1);
		expect(inline!.fitsFreeCap).toBe(false);
		expect(inline!.peakInvocationMs / FREE_CPU_MS_CAP).toBeGreaterThan(100);
	});

	it('marks the skeleton unavailable, which is an artifact gap and not a cost', () => {
		const skeleton = coldUrlCost().find((m) => m.mechanism === 'skeleton');
		expect(skeleton!.available).toBe(false);
		// it would be the cheapest of the three if it could be served at all
		expect(skeleton!.rows).toBe(0);
		expect(coldUrlCost().filter((m) => m.available).length).toBe(2);
	});

	it('shows the retry MOVES cost rather than removing it', () => {
		const [alarm, inline] = [coldUrlCost()[0]!, coldUrlCost()[1]!];
		expect(alarm.worker).toBeGreaterThan(inline.worker);
		expect(alarm.do).toBeGreaterThan(inline.do);
		expect(alarm.rows).toBeGreaterThan(inline.rows);
	});
});

// the row quota is a write budget that an editor also spends; a node revision is 218 charged rows
// so 50 revisions a day outweighed the whole warming chain, and the model did not know it
describe('the daily row quota, split by what spends it', () => {
	it('adds up, so the split is a decomposition rather than four separate figures', () => {
		const w = envelope(DEFAULT_MIX, { windowed: true }).writeBudget;
		expect(w.warmingRows + w.editorialRows + w.regenerationRows).toBe(w.quotaRows);
		expect(w.quotaRows).toBe(FREE_QUOTAS.rowsWrittenPerDay);
	});

	// no real site's editorial rate is measured here, so the default is zero
	// a caller who knows the rate passes it
	it('prices no editing until a caller states a rate', () => {
		expect(envelope(DEFAULT_MIX, { windowed: true }).writeBudget.editorialRows).toBe(0);
		expect(editorialRowsPerDay()).toBe(0);
		expect(editorialRowsPerDay({})).toBe(0);
	});

	it('costs the measured rows per write, not a flat one', () => {
		// TECHNICAL_REPORT.md's Writes table, deployed, n=8 per class
		expect(editorialRowsPerDay({ nodeRevision: 1 })).toBe(ROWS_PER_WRITE.nodeRevision);
		expect(editorialRowsPerDay({ nodeCreate: 2, fileCreate: 3 })).toBe(
			2 * ROWS_PER_WRITE.nodeCreate + 3 * ROWS_PER_WRITE.fileCreate
		);
		// a revision is over twice a user create, so one figure for "a write" cannot describe both
		expect(ROWS_PER_WRITE.nodeRevision).toBeGreaterThan(2 * ROWS_PER_WRITE.userCreate);
	});

	// editorial writes spend the same row budget as fills
	// the narrowed replay took a revision to 53 rows, so fifty is 2,350 rows, under a quarter of the chain
	it('takes a busy editorial day off the regeneration ceiling', () => {
		const quiet = envelope(DEFAULT_MIX, { windowed: true });
		const busy = envelope(DEFAULT_MIX, { windowed: true, editorial: { nodeRevision: 50 } });
		expect(busy.writeBudget.editorialRows).toBe(50 * ROWS_PER_WRITE.nodeRevision);
		expect(busy.regenerationsPerDay).toBeLessThan(quiet.regenerationsPerDay);
	});

	it('cannot drive the budget negative', () => {
		const over = envelope(DEFAULT_MIX, { windowed: true, editorial: { nodeRevision: 10_000 } });
		expect(over.writeBudget.regenerationRows).toBe(0);
		expect(over.regenerationsPerDay).toBe(0);
	});

	it('ignores a negative rate rather than crediting rows back', () => {
		expect(editorialRowsPerDay({ nodeCreate: -5 })).toBe(0);
	});
});

// the assets arm and the R2 arm, under the observed no-billing case and the Workers Cache exception
describe('the off-Worker arms', () => {
	const mirrorable = DEFAULT_MIX.edgeHit + DEFAULT_MIX.doHit;
	const warmingDo = keepWarmFleetCost(1, WARM_INTERVAL_MS).doRequestsPerDay;

	it('lifts the Worker meter off the assets arm and lands on DO requests when assets are not billed', () => {
		const a = offWorkerArm('assets', 'notBilled');
		expect(a.todayViewsPerDay).toBe(FREE_QUOTAS.workerRequestsPerDay);
		expect(a.boundBy).toBe('do');
		const doPerView = DEFAULT_MIX.miss * COST_PER_VIEW.missAndFill.do;
		expect(a.viewsPerDay).toBe(
			Math.floor((FREE_QUOTAS.doRequestsPerDay - warmingDo) / doPerView)
		);
		expect(a.viewsPerDay).toBeGreaterThan(20 * a.todayViewsPerDay);
	});

	it('leaves regeneration at the shipping default, because a published page reads no R2 object', () => {
		const a = offWorkerArm('assets', 'notBilled');
		const shipping = envelope(DEFAULT_MIX, { rowsPerFill: SHIPPING_ROWS_PER_FILL });
		expect(a.regenerationsPerDay).toBe(shipping.regenerationsPerDay);
		expect(a.regenerationBoundBy).toBe('rows');
	});

	it('moves with the share it is given and never past the cacheable share', () => {
		const half = offWorkerArm('assets', 'notBilled', { share: 0.5 });
		expect(half.viewsPerDay).toBe(2 * FREE_QUOTAS.workerRequestsPerDay);
		expect(half.boundBy).toBe('worker');
		expect(offWorkerArm('assets', 'notBilled', { share: 5 }).share).toBe(mirrorable);
	});

	it('caps the R2 arm on Class B reads, and regeneration on Class A writes', () => {
		const r = offWorkerArm('r2', 'notBilled');
		const perDay = (perMonth: number) => Math.floor(perMonth / 30);
		expect(r.boundBy).toBe('r2ClassB');
		expect(r.viewsPerDay).toBe(Math.floor(FREE_QUOTAS.r2ClassBPerMonth / 30 / mirrorable));
		expect(r.viewsPerDay).toBe(optimalOffWorker().atFullMirror.viewsPerDay);
		expect(r.regenerationBoundBy).toBe('r2ClassA');
		expect(r.regenerationsPerDay).toBe(perDay(FREE_QUOTAS.r2ClassAPerMonth));
		// mirroring costs regeneration: the same site with no mirror regenerates more
		expect(r.regenerationsPerDay).toBeLessThan(
			envelope(DEFAULT_MIX, { rowsPerFill: SHIPPING_ROWS_PER_FILL }).regenerationsPerDay
		);
	});

	it('is worth about eight times the reads when a Cache Rule absorbs seven in eight', () => {
		const plain = offWorkerArm('r2', 'notBilled');
		const ruled = offWorkerArm('r2', 'notBilled', { cdnAbsorption: 7 / 8 });
		expect(ruled.viewsPerDay / plain.viewsPerDay).toBeCloseTo(8, 0);
		expect(ruled.boundBy).toBe('r2ClassB');
	});

	it('gives neither arm relief under the Workers Cache exception', () => {
		const assets = offWorkerArm('assets', 'billedAsWorker');
		const r2 = offWorkerArm('r2', 'billedAsWorker');
		const ceiling = Math.floor(FREE_QUOTAS.workerRequestsPerDay / REQUESTS_PER_PAGE_LOAD);
		expect(assets.todayViewsPerDay).toBe(ceiling);
		expect(assets.viewsPerDay).toBe(ceiling);
		expect(assets.workerPerView).toBe(REQUESTS_PER_PAGE_LOAD);
		// an R2 page is the one request that never reaches the Worker, so it saves one of 66
		expect(r2.workerPerView).toBeCloseTo(REQUESTS_PER_PAGE_LOAD - mirrorable, 10);
		expect(r2.viewsPerDay).toBeLessThan(ceiling * 1.02);
		expect(r2.boundBy).toBe('worker');
	});

	it('prices the same pages as today under notBilled, so the baseline is the shipping ceiling', () => {
		for (const via of ['assets', 'r2'] as const) {
			expect(offWorkerArm(via, 'notBilled').todayViewsPerDay).toBe(
				envelope(DEFAULT_MIX, { rowsPerFill: SHIPPING_ROWS_PER_FILL }).servingViewsPerDay
			);
		}
	});

	it('keeps the publish budget to the slowest measured deploy and the debounce', () => {
		const fast = assetPublishBudget(Infinity, 1);
		expect(fast.serialCap).toBe(Math.floor(SECONDS_PER_DAY / ASSET_PUBLISH.deploySeconds.max));
		expect(fast.publishesPerDay).toBe(fast.serialCap);
		const slow = assetPublishBudget(Infinity, 60);
		expect(slow.byDebounce).toBe(1_440);
		expect(slow.publishesPerDay).toBe(1_440);
		expect(assetPublishBudget(5, 60).publishesPerDay).toBe(5);
		expect(assetPublishBudget(-3, 60).publishesPerDay).toBe(0);
	});

	it('shows a save the debounce plus the measured time to visibility', () => {
		const w = assetPublishBudget(5, 60).staleSeconds;
		expect(w.min).toBe(60 + ASSET_PUBLISH.visibleSeconds.min);
		expect(w.max).toBe(60 + ASSET_PUBLISH.visibleSeconds.max);
	});

	it('leaves room for pages beside the pack in one Worker version, and no DO storage', () => {
		expect(ASSET_PAGE_HEADROOM.free).toBe(
			ASSET_PUBLISH.filesPerVersion.free - ASSET_PUBLISH.packFiles
		);
		expect(ASSET_PAGE_HEADROOM.paid).toBeGreaterThan(ASSET_PAGE_HEADROOM.free);
		// the republish evidence is small and the model says so by carrying n
		expect(ASSET_PUBLISH.completed).toBe(4);
		expect(ASSET_PUBLISH.resets).toBe(0);
	});
});

// the meter flush runs on a clock that depends on how much of the day's budget is left
describe('the meter flush interval', () => {
	it('is 900 s on an idle day and 60 s once the budget is spent', () => {
		expect(METER_FLUSH_SECONDS).toBe(900);
		expect(METER_FLUSH_SECONDS_UNDER_LOAD).toBe(60);
	});

	it('moves warming from 10,896 rows a site-day to 12,240 at the heavy-use interval', () => {
		const idle = keepWarmFleetCost(1, WARM_INTERVAL_MS);
		const loaded = keepWarmFleetCost(1, WARM_INTERVAL_MS, METER_FLUSH_SECONDS_UNDER_LOAD);
		expect(idle.rowsPerDay).toBe(10_896);
		expect(loaded.rowsPerDay).toBe(12_240);
		expect(loaded.rowsPerDay - idle.rowsPerDay).toBe(
			(SECONDS_PER_DAY / METER_FLUSH_SECONDS_UNDER_LOAD -
				SECONDS_PER_DAY / METER_FLUSH_SECONDS) *
				FREE_QUOTAS.rowsPerMeterFlush
		);
	});
});
