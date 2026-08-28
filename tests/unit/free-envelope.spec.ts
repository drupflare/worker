import { describe, expect, it } from 'vitest';
import {
	billedGbS,
	coldUrlCost,
	COST_PER_VIEW,
	CPU_UNDERSTATEMENT,
	DEFAULT_MIX,
	DO_GB_ALLOCATED,
	DO_INVOCATIONS_PER_COLD_FILL,
	DURATION_CALIBRATION,
	envelope,
	FILL_WINDOW_AMORTISATION,
	fleetIdleGbS,
	FREE_CPU_MS_CAP,
	FREE_QUOTAS,
	IDLE_GB_S_PER_DAY,
	INSTALL_CPU_MS,
	KEEP_WARM_MS,
	keepWarmFleetCost,
	optimalOffWorker,
	PAID_DURATION,
	paidDurationCost,
	queueArm,
	ROWS_PER_FILL,
	ROWS_PER_FILL_NO_DBLOG,
	rowsForWarmthMix,
	scoreInstall,
	scoreRejection,
	scoreWorkload,
	SECONDS_PER,
	SECONDS_PER_DAY,
	SITE_STORAGE_BYTES,
	STEADY_STATE_WARMTH,
	storageCeiling,
	WORKFLOW_STEP_CPU_MS
} from '../../scripts/measure/free-envelope';

/**
 * The free-tier product envelope, as arithmetic that can score a proposal. The assertions catch
 * the two ways it goes wrong: cache hits treated as free (they cost a Worker request), and
 * decomposition treated as free (slicing spends the DO quota, which counts alarm invocations).
 */

describe('the SERVING ceiling, where a cache hit is not free', () => {
	it('is bound by Worker requests, not by CPU or DO', () => {
		const env = envelope();
		expect(env.servingBoundBy).toBe('worker');
	});

	it('caps free at ~100,000 views/day even when 85% never touch PHP', () => {
		// the point a "99% of traffic is cached" argument misses: every one of those hits is still a
		// counted Worker request, so caching rescues CPU and does nothing for this ceiling
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
	it('is ~2,777 renders/day on the alarm chain with the shipped batch of 5', () => {
		// 180 sliced invocations per cold fill over a batch of 5; read 1,052 until C176
		const env = envelope(DEFAULT_MIX, { windowed: false });
		expect(env.regenerationsPerDay).toBe(2_777);
		expect(env.regenerationBoundBy).toBe('do');
	});

	it('is ~7.2x better with the fill window, and ROWS still bind rather than DO', () => {
		const env = envelope(DEFAULT_MIX, { windowed: true });
		expect(env.regenerationsPerDay).toBe(7_575);
		expect(env.regenerationBoundBy).toBe('rows');
	});

	it('is DO-bound cold and ROWS-bound windowed, which is what decides the work order', () => {
		expect(envelope(DEFAULT_MIX, { windowed: false }).regenerationBoundBy).toBe('do');
		expect(envelope(DEFAULT_MIX, { windowed: true }).regenerationBoundBy).toBe('rows');
	});

	it('prices every measured warmth class, because no single figure describes a fill', () => {
		// the spread is 20x, so the model has to name which case it is charging for
		const perDay = (warmth: 'warmReassemble' | 'realRender' | 'firstEverForPath') =>
			envelope(DEFAULT_MIX, { windowed: true, warmth }).regenerationsPerDay;
		expect(perDay('warmReassemble')).toBeGreaterThan(perDay('realRender'));
		expect(perDay('realRender')).toBeGreaterThan(perDay('firstEverForPath'));
		// and the old overstated figure sits INSIDE the range while describing none of its cases
		expect(ROWS_PER_FILL.realRender).toBeLessThan(17);
		expect(ROWS_PER_FILL.firstEverForPath).toBeGreaterThan(17);
	});
});

describe('scoring the target workload, which is what the roadmap should be graded against', () => {
	it('3M visits/month serves with EXACTLY zero headroom', () => {
		// 3,000,000 / 30 = 100,000/day, which is precisely the Worker request quota. Not comfortable --
		// saturated. Any additional counted request, from any source, puts the day over.
		const v = scoreWorkload(3_000_000, 0.01, { windowed: true });
		expect(v.targetVisitsPerDay).toBe(100_000);
		expect(v.servingFits).toBe(true);
		expect(v.headroom.servingRatio).toBeCloseTo(1.0, 5);
	});

	it('at 1% dynamic the alarm chain covers it 2.8x over', () => {
		// corrected twice: 4.8x FAIL, 1.05x once batching was modelled, 2.78x once the cold boot was
		const v = scoreWorkload(3_000_000, 0.01, { windowed: false });
		expect(v.fillsNeededPerDay).toBe(1_000);
		expect(v.regenerationFits).toBe(true);
		expect(v.headroom.regenerationRatio).toBeGreaterThan(2.5);
		expect(v.headroom.regenerationRatio).toBeLessThan(3);
	});

	it('PASSES at 1% dynamic with the fill window, with ~7x headroom', () => {
		const v = scoreWorkload(3_000_000, 0.01, { windowed: true });
		expect(v.verdict).toBe('fits');
		// 5x before the row correction; the complete instrument and the right warmth class both
		// moved it up, so the headroom is real rather than an artefact
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
		// a site serving 3M cached visits it cannot refresh is a static site with a stale cache.
		// 3% rather than 2%: 2,777 fills/day now covers 2%, so the case had to move
		const v = scoreWorkload(3_000_000, 0.03, { windowed: false });
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
		// 0.128, the DECIMAL reading, and this asserted 0.125 until 2026-08-23. Cloudflare's own
		// worked example fixes it: "1,000,000 seconds * 128 MB / 1 GB = 128,000 GB-s". The binary
		// reading was 2.4% low everywhere it appeared
		expect(DO_GB_ALLOCATED).toBe(0.128);
		expect(SECONDS_PER_DAY).toBe(86_400);
		expect(IDLE_GB_S_PER_DAY).toBe(SECONDS_PER_DAY * DO_GB_ALLOCATED);
		expect(IDLE_GB_S_PER_DAY).toBeCloseTo(11_059.2, 4);
		// 85.1% of the daily allowance for an object doing nothing, not the 83.1% the binary
		// reading implied
		expect(IDLE_GB_S_PER_DAY / FREE_QUOTAS.durationGbSPerDay).toBeCloseTo(0.851, 3);
	});

	it('carries the read meter, which is 50x the write meter and was never modelled', () => {
		// nothing was wrong -- there was simply no read meter -- but the omission made it easy to
		// assume reads and writes shared the 100,000. A workload has to read 50 rows per row
		// written before reads bind, which a render does not approach
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
		expect(COST_PER_VIEW.edgeHit).toEqual({ worker: 1, do: 0, rows: 0 });
	});

	it('carries the cold-fill slicing cost and the window amortisation', () => {
		expect(DO_INVOCATIONS_PER_COLD_FILL).toBe(180);
		expect(FILL_WINDOW_AMORTISATION).toBe(25);
	});
});

/**
 * THE FIFTH METER: Durable Object DURATION.
 *
 * Billed on WALL CLOCK against the 128 MB an object is allocated regardless of use, and the model
 * had never carried it. It does NOT bind -- which is why it is reported as slack rather than left
 * out, because a meter nobody looks at is exactly how the first four were each missed in turn.
 *
 * Every figure feeding it is `cpuTime`, and cpuTime excludes time spent awaiting, so each ceiling
 * below is an UPPER BOUND on what the meter allows.
 */
describe('the DURATION meter, which is reported whether or not it binds', () => {
	it('does not bind at the serving ceiling, and says how much slack is left', () => {
		const e = envelope(DEFAULT_MIX, { windowed: true });
		expect(e.servingBoundBy).toBe('worker');
		expect(e.duration.availableGbS).toBe(FREE_QUOTAS.durationGbSPerDay);
		// ~271 of 13,000. The whole point of asserting it is that a later change which made a
		// render hold the object 50x longer would move this and nothing else in the model
		expect(e.duration.servingUseGbS).toBeGreaterThan(0);
		expect(e.duration.servingUseGbS).toBeLessThan(FREE_QUOTAS.durationGbSPerDay * 0.1);
	});

	it('does not bind regeneration either, by 6x', () => {
		const e = envelope(DEFAULT_MIX, { windowed: true });
		const byDuration = Math.floor(e.duration.availableGbS / e.duration.perFillGbS);
		expect(e.regenerationBoundBy).toBe('rows');
		expect(byDuration).toBeGreaterThan(e.regenerationsPerDay * 5);
	});

	it('charges a cold fill ~2.9x a warm one, because boot is wall clock too', () => {
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

/**
 * Prices ALWAYS-WARM replicas only, which is one of three architectures and not the interesting one.
 *
 * An object idle and ELIGIBLE to hibernate accrues nothing, so a hibernating replica is unscored
 * here and unmeasured anywhere. A replica buys throughput, never quota: rows are account-wide.
 */
describe('always-warm objects, which is only ONE of the replica architectures', () => {
	it('fits exactly ONE on free, at 83% of the allowance', () => {
		expect(FREE_QUOTAS.durationGbSPerDay / IDLE_GB_S_PER_DAY).toBeLessThan(2);
		expect(FREE_QUOTAS.durationGbSPerDay / IDLE_GB_S_PER_DAY).toBeGreaterThan(1);

		const one = envelope(DEFAULT_MIX, { windowed: true, alwaysWarmObjects: 1 });
		expect(one.duration.availableGbS).toBeCloseTo(1_940.8, 4);
		// serving still holds, because a cached view barely touches the meter
		expect(one.servingViewsPerDay).toBe(100_000);

		// BUT REGENERATION NO LONGER DOES, and the 0.125 error was hiding it. One always-warm
		// object leaves 1,940.8 GB-s, and at 0.272256 GB-s per warm fill that funds ~7,128
		// regenerations against the 7,575 rows allow -- so DURATION becomes the binding meter for
		// regeneration at ONE replica, not at two. The binary reading said rows still bound
		expect(one.regenerationBoundBy).toBe('duration');
		expect(one.regenerationsPerDay).toBeLessThan(
			envelope(DEFAULT_MIX, { windowed: true }).regenerationsPerDay
		);
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

	it('is the SAME fleet size that always-warm refuses, which is the whole point', () => {
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
		// an honest hole: a hibernating replica pays a wake, and on this runtime a wake means
		// restoring or re-booting a 96 MiB interpreter. `envelope()` prices per-view work and
		// knows nothing about a wake, so a 0 here is "not modelled", never "free"
		expect(fleetIdleGbS(4, 'hibernating')).toBe(0);
		expect(fleetIdleGbS(4, 'alwaysWarm')).toBe(4 * IDLE_GB_S_PER_DAY);
	});
});

/**
 * The PAID plan, where the free-tier conclusion inverts at small replica counts.
 *
 * Figures supplied 2026-08-23 and NOT verified by this project, which is why `paidDurationCost()`
 * returns `verified: false`: 400,000 GB-s/month included, then $12.50 per million.
 */
describe('paid-plan duration, where "expensive" turns out to be wrong', () => {
	it('carries the unverified flag with the number, not in a comment', () => {
		expect(paidDurationCost(1).verified).toBe(false);
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
		// four always-warm objects is $11.20/month. That is a line item, not a wall, which is why
		// "replicas are expensive" was the wrong reason to refuse them on paid -- the real
		// questions are whether they improve user-visible throughput, whether rows still bind, and
		// how a replica stays consistent with the object that owns the data
		expect(paidDurationCost(4).usd).toBeCloseTo(11.59, 2);
		expect(paidDurationCost(4).usd).toBeLessThan(20);
	});
});

/**
 * P37: what rejecting bad traffic is worth, per meter.
 *
 * The number a WAF reports is "requests blocked" and it is the one number that does not decide
 * anything here. These cases pin the distinction that does: an in-Worker refusal still spends a
 * Worker request, so it cannot move the meter that binds serving, and only a rule evaluated before
 * the Worker runs can.
 */
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
		// a scanner asks for paths that are never cached, so every request is a MISS and a fill.
		// 1,000 of them is 13,000 rows -- 13% of the day -- against 1% of the Worker meter
		const saving = scoreRejection(1_000, 'edge');
		expect(saving.savedShare.rows).toBeGreaterThan(saving.savedShare.worker * 5);
		expect(saving.savedShare.rows).toBeCloseTo(0.13, 5);
	});

	it('is zero on every meter for zero traffic, so the model cannot flatter a rule', () => {
		const saving = scoreRejection(0, 'edge');
		expect(saving.saved).toEqual({ worker: 0, do: 0, rows: 0, durationGbS: 0 });
	});
});

describe('the off-Worker path, the ONLY lever on the serving ceiling', () => {
	/**
	 * Documented, not inferred. Cloudflare Workers pricing: **"Requests to static assets are free and
	 * unlimited"** -- an asset request is answered without invoking the Worker at all. An R2 public
	 * bucket on a CUSTOM domain is likewise served through Cloudflare Cache with no Worker invocation.
	 *
	 * Everything else in this model leaves the serving ceiling at exactly 100,000/day. This is the one
	 * input that moves it, which is why it is the highest-value architectural question in the project.
	 */
	it('raises the ceiling 5.9x AND MOVES THE BINDING METER off Worker requests', () => {
		// >600,000 was the expectation (100,000/0.15), and it is wrong: once serving leaves the
		// Worker, Worker requests stop being the bottleneck. WHICH meter takes over moved with the
		// rows correction -- ROWS at 17.2/fill, DO REQUESTS at a measured 13.2 -- so past this point
		// the lever is the remaining DO hits, not rows per fill
		const base = envelope({ edgeHit: 0.85, doHit: 0.14, miss: 0.01 });
		const off = envelope({ edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 0.85 });
		//
		// CORRECTED AGAIN on 2026-08-14, and this time the meter itself was missing. An off-Worker
		// visit was modelled as costing NOTHING, on the strength of "requests to static assets are
		// free and unlimited" -- a sentence about Workers Static Assets, which are uploaded at deploy
		// time and cannot hold a runtime-rendered page. The mechanism is R2, metered at 10M Class B
		// reads/month, so R2 binds first and the DO ceiling below is what would take over after it.
		expect(base.servingBoundBy).toBe('worker');
		expect(off.servingBoundBy).toBe('r2ClassB');
		expect(off.perMeterViewCeiling.worker).toBe(666_666);
		expect(off.perMeterViewCeiling.rows).toBe(757_575);
		expect(off.perMeterViewCeiling.do).toBe(588_235);
	});

	it('but trimming rows STOPS paying on the serving ceiling once DO binds', () => {
		// this spec used to say "once rows bind, dropping dblog becomes the next lever". The rows
		// correction falsified it in the most useful way: at 13.2 rows per fill the serving ceiling
		// is DO-bound, so cutting rows per fill to 8 moves the rows meter and does not move the
		// ceiling AT ALL. A lever that the binding meter does not respond to is not a lever.
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
		// the full R2 architecture, priced against R2's own meter. 10M Class B reads/month is
		// 333,333/day, so with no CDN absorption in front of the bucket this is ~3.37x the 100,000/day
		// Worker ceiling -- NOT the 12.5x / 37.5M this project quoted for months from a sentence about
		// a different product.
		const all = envelope(
			{ edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 0.99 },
			{ rowsPerFill: ROWS_PER_FILL_NO_DBLOG }
		);
		expect(all.servingBoundBy).toBe('r2ClassB');
		expect(all.servingViewsPerDay).toBe(336_700);
		expect(all.servingViewsPerDay / 100_000).toBeCloseTo(3.37, 1);
	});

	it('CDN absorption is the only thing that lifts it past 3.37x, and it is an assumption', () => {
		// absorption defaults to 0 BECAUSE it has never been measured here. A caller that passes a
		// value is stating an assumption, and the ceiling scales as 3.37x / (1 - absorption) until
		// some other meter takes over -- which at 0.9 is rows.
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
		// the whole point: 3M/month currently fits at exactly 1.00x with zero headroom
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
		// over-claiming off-Worker traffic would overstate the ceiling. An earlier version compared
		// 0.99 against 0.85 and passed for the wrong reason -- 0.99 is not over-claiming when
		// edgeHit + doHit is exactly 0.99, so the clamp never ran. 1.5 is the case that does
		const overClaimed = envelope({ edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 1.5 });
		const everything = envelope({ edgeHit: 0.85, doHit: 0.14, miss: 0.01, offWorker: 0.99 });
		expect(overClaimed.servingViewsPerDay).toBe(everything.servingViewsPerDay);
		// AND PAST THE OPTIMUM IT HURTS: once R2's read meter binds, moving more off the Worker
		// spends a 333,333/day meter to save a 100,000/day one. 0.77 peaks at 432,900 views/day and
		// 0.99 falls back to 336,700, so the mirror should target the optimum rather than everything
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
	/**
	 * `src/site-do.ts:412` defaults `FILL_BATCH_SIZE` to 5, so one alarm firing fills five pages and
	 * amortises both per-firing costs across them: the sliced boot, and the single row `setAlarm()`
	 * writes. The first version of this model had neither, so it understated a ceiling the shipped code
	 * already beat -- the same stale-metric failure the model was written to prevent, pointing the other
	 * way. An external review caught it, not these tests, which is why they exist now.
	 */
	it('raises the cold ceiling 5x over an unbatched firing', () => {
		expect(envelope(DEFAULT_MIX, { windowed: false, fillBatch: 1 }).regenerationsPerDay).toBe(
			555
		);
		expect(envelope(DEFAULT_MIX, { windowed: false }).regenerationsPerDay).toBe(2_777);
	});

	it('moves the windowed path from DO-bound to ROWS-bound', () => {
		// the finding that reorders the roadmap: boot is not the constraint on the windowed path.
		// It survived the rows-per-fill correction (5,813 -> 7,575, rows still binding by 3.5x) and
		// the 2026-08-26 boot correction STRENGTHENED it -- at 180 invocations per cold fill rather
		// than 475, rows bind even UNBATCHED, so the batch no longer changes which meter binds at all.
		// It still raises the ceiling; it no longer rescues it from a DO budget.
		const unbatched = envelope(DEFAULT_MIX, { windowed: true, fillBatch: 1 });
		const shipped = envelope(DEFAULT_MIX, { windowed: true });
		expect(unbatched.regenerationBoundBy).toBe('rows');
		expect(shipped.regenerationBoundBy).toBe('rows');
		expect(shipped.regenerationsPerDay).toBe(7_575);
	});

	it('shows boot work is SATURATED: 20x more amortisation buys ~1%', () => {
		// batch 5 -> 100 is a 20x reduction in boot cost per fill and moves the ceiling 5,813 -> 5,878.
		// Every boot-directed item -- JSPI, the heap restore, always-warm objects -- is bounded by
		// this until rows-per-fill falls.
		const at5 = envelope(DEFAULT_MIX, { windowed: true, fillBatch: 5 }).regenerationsPerDay;
		const at100 = envelope(DEFAULT_MIX, { windowed: true, fillBatch: 100 }).regenerationsPerDay;
		expect(at100 / at5).toBeLessThan(1.02);
	});

	it('shows rows work pays until ~2 rows/fill, where DO takes over', () => {
		const ladder = [17, 8, 4, 2, 1].map(
			(rows) =>
				envelope(DEFAULT_MIX, { windowed: true, rowsPerFill: rows }).regenerationsPerDay
		);
		// monotonically better down to 2, then flat, because a THIRD meter takes over below that.
		//
		// the DO budget until the cold boot was corrected; R2 Class A binds first now
		expect(ladder[1]! / ladder[0]!).toBeGreaterThan(2);
		expect(ladder[2]! / ladder[0]!).toBeGreaterThan(4);
		expect(ladder[4]).toBe(ladder[3]);
		expect(envelope(DEFAULT_MIX, { windowed: true, rowsPerFill: 1 }).regenerationBoundBy).toBe(
			'r2ClassA'
		);
	});

	it('treats a batch below 1 as 1 rather than dividing by zero', () => {
		expect(envelope(DEFAULT_MIX, { fillBatch: 0 }).regenerationsPerDay).toBeGreaterThan(0);
		expect(envelope(DEFAULT_MIX, { fillBatch: -5 }).regenerationsPerDay).toBeGreaterThan(0);
	});
});

describe('the THIRD meter, which neither ceiling can see', () => {
	it('records the Cloudflare Images monthly cap', () => {
		// 5,000 unique transformations/month on free, and it fails as a HARD CAP rather than as a bill.
		// `CfwImageToolkit` defers every manipulation to a /cdn-cgi/image/ URL, so an image style IS a
		// transformation: 10 styles over 2,000 images is 20,000 uniques, 4x over, and nothing else in
		// this model would say so.
		expect(FREE_QUOTAS.imageTransformsPerMonth).toBe(5_000);
	});

	it('is a MONTHLY figure, unlike every other quota here', () => {
		// mixing it into a per-day comparison would understate it by 30x in the dangerous direction
		expect(FREE_QUOTAS.imageTransformsPerMonth).toBeLessThan(FREE_QUOTAS.workerRequestsPerDay);
	});
});

describe('Workflows on free, where the figure quoted for it was a PAID one', () => {
	/**
	 * Workflows IS available on the Workers Free plan, so functional equivalence holds -- free can install
	 * a module. But the checklist's "25,000 separately-budgeted steps" is the PAID per-instance ceiling.
	 * Free is **1,024 steps per instance** with **3,000 steps/day** across all of them, and a free
	 * Workflow step still gets the same 10 ms of CPU as any other invocation.
	 *
	 * The step buys DIVISIBILITY, not CPU. That is exactly what an install needs and exactly not what
	 * "Workflows give you five minutes" would imply.
	 */
	it('does not pretend a step buys more CPU', () => {
		expect(WORKFLOW_STEP_CPU_MS).toBe(10);
	});

	it('records the FREE per-instance limit, not the paid 25,000', () => {
		expect(FREE_QUOTAS.workflowStepsPerInstance).toBe(1_024);
		expect(FREE_QUOTAS.workflowStepsPerDay).toBe(3_000);
	});

	it('an install FITS one free instance, which is what makes free equivalent here', () => {
		// 6,810 ms of EDGE cpuTime (n=3) at 10 ms a step; read 163 from a native total, see C177
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
		// a hypothetical module 10x heavier: the verdict must name the per-instance limit rather than
		// silently planning something that dies at step 1,025
		const heavy = scoreInstall(INSTALL_CPU_MS * 10);
		expect(heavy.fitsOneInstance).toBe(false);
		expect(heavy.problems.join(' ')).toContain('1024');
		expect(heavy.problems.join(' ')).toContain('child instances');
	});

	it('flags that a Workflow invocation spends the SERVING quota', () => {
		// "shared with Workers requests" -- same trap as the cron trigger, against a ceiling that is
		// already saturated at 3M/month
		expect(scoreInstall().sharesServingQuota).toBe(true);
	});
});

/**
 * The rows-per-fill default, settled rather than left open.
 *
 * The question the roadmap carried was "worst case or `realRender`?", and both answers were bad:
 * `firstEverForPath` charges every regeneration a one-time-per-path cost and understates the ceiling
 * 5x, while a bare `realRender` was defended by an argument rather than by evidence. Pricing a
 * DISTRIBUTION settles it, and the result is that the default was already right.
 */
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

describe('THE ANSWER: the realRender default survives being priced as a distribution', () => {
	it('lands within 1% of the single-class default', () => {
		const mixed = rowsForWarmthMix(STEADY_STATE_WARMTH);
		const single = ROWS_PER_FILL.realRender;
		// 12.95 against 13. The cheap reassembles and the expensive cold paths very nearly
		// cancel, so the default is defensible on evidence rather than on an argument.
		expect(Math.abs(mixed - single) / single).toBeLessThan(0.01);
	});

	it('moves the regeneration ceiling by under 1%, so no pinned figure changes', () => {
		const base = envelope(DEFAULT_MIX, { windowed: true }).regenerationsPerDay;
		const mixed = envelope(DEFAULT_MIX, {
			windowed: true,
			warmthMix: STEADY_STATE_WARMTH
		}).regenerationsPerDay;
		expect(base).toBe(7_575);
		expect(Math.abs(mixed - base) / base).toBeLessThan(0.01);
	});

	it('shows why the WORST case was the wrong answer: it understates the ceiling 4x', () => {
		const real = envelope(DEFAULT_MIX, { windowed: true, warmth: 'realRender' });
		const worst = envelope(DEFAULT_MIX, { windowed: true, warmth: 'firstEverForPath' });
		// charging every regeneration a cost paid once per path, forever
		expect(real.regenerationsPerDay / worst.regenerationsPerDay).toBeGreaterThan(4);
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

/**
 * The mirror share, computed rather than quoted.
 *
 * RULE 0b says the off-Worker lever has a MAXIMUM and not a limit: past the crossing point, moving a
 * view off the Worker spends R2's 333,333/day read meter to save the 100,000/day Worker meter, so
 * mirroring more makes the site smaller. Two figures were carried as constants in the report and in
 * `page-mirror.ts` for months; `optimalOffWorker()` now derives them from the same `envelope()` every
 * other caller uses, which is what stops the two drifting apart.
 */
describe('the optimal mirror share', () => {
	it('reproduces the 77% / 432,900 the report quotes, from the model rather than a constant', () => {
		const o = optimalOffWorker();
		expect(o.share).toBeCloseTo(0.769, 3);
		expect(o.viewsPerDay).toBe(432_900);
		// the Worker meter is what it is still bound by at the peak, which is why the peak is a peak
		expect(o.boundBy).toBe('worker');
	});

	it('shows what maximising gives up, which is the whole point of the entry', () => {
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

	/**
	 * CDN absorption raises the peak and does NOT walk the answer to "mirror everything".
	 *
	 * At absorption 1 the R2 read meter cannot bind at all, and the ceiling still lands on another
	 * meter -- rows -- so past that share mirroring buys nothing and still costs writes. Anyone
	 * reasoning "if R2 reads were free we would mirror the lot" is wrong, and this is why.
	 */
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
	it('costs 360 arms a day per site, which is the figure that reads as noise', () => {
		const one = keepWarmFleetCost(1);
		expect(one.armsPerSitePerDay).toBe(360);
		expect(one.rowsPerDay).toBe(360);
		// 0.36% of the write allowance. Correct, and the reason nobody multiplied it
		expect(one.rowShare).toBeCloseTo(0.0036, 6);
	});

	it('spends TWO account-wide meters, not one', () => {
		const fleet = keepWarmFleetCost(100);
		expect(fleet.rowsPerDay).toBe(36_000);
		// the DO request quota "includes alarm invocations", so the same 360 arms are charged
		// twice over -- the model had a line for neither
		expect(fleet.doRequestsPerDay).toBe(36_000);
		expect(fleet.rowShare).toBeCloseTo(0.36, 6);
		expect(fleet.doRequestShare).toBeCloseTo(0.36, 6);
	});

	it('saturates a free account at 277 sites with ZERO visitors', () => {
		expect(keepWarmFleetCost(1).saturatingSites).toBe(277);
		const saturated = keepWarmFleetCost(277);
		expect(saturated.rowShare).toBeLessThanOrEqual(1);
		expect(keepWarmFleetCost(278).rowsPerDay).toBeGreaterThan(FREE_QUOTAS.rowsWrittenPerDay);
	});

	it('scales inversely with the interval, so the lever is arithmetic rather than a rewrite', () => {
		const shipping = keepWarmFleetCost(100, KEEP_WARM_MS);
		const halved = keepWarmFleetCost(100, KEEP_WARM_MS * 2);
		expect(halved.rowsPerDay).toBe(shipping.rowsPerDay / 2);
		expect(halved.saturatingSites).toBe(shipping.saturatingSites * 2 + 1);
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
	/**
	 * Cloudflare bills a message THREE times -- one write, one read, one delete -- so the 10,000
	 * daily operations are 3,333 deliverable messages and not 10,000.
	 */
	it('divides the operation quota by the three operations a message costs', () => {
		expect(FREE_QUOTAS.queueOperationsPerMessage).toBe(3);
		expect(queueArm().messagesPerDay).toBe(3_333);
	});

	// priced under ONE batching assumption. Billing a message per PAGE while crediting the alarm
	// arm a batch of five is what made queue ops look binding; symmetrically they never are
	it('carries a batch per message, so the message quota is not the binding meter', () => {
		const arm = queueArm(undefined, { windowed: true });
		expect(arm.pathsPerMessage).toBe(5);
		expect(arm.fillsFromMessagesPerDay).toBe(16_665);
		expect(arm.fillsFromMessagesPerDay).toBeGreaterThan(arm.alarmRegenerationsPerDay);
		expect(arm.queueBoundBy).not.toBe('queueOps');
	});

	// what a queue removes is the alarm RE-ARM row, amortised as `1/batch` and not a whole one, so
	// the refutation survives on a new mechanism: close to free, and close to worthless
	it('moves the windowed ceiling by about 1.5%, not by 2.27x in either direction', () => {
		const arm = queueArm(undefined, { windowed: true });
		expect(arm.alarmRegenerationsPerDay).toBe(7_575);
		expect(arm.ratio).toBeGreaterThan(1);
		expect(arm.ratio).toBeLessThan(1.05);
	});

	// and on the cold arm it buys nothing rather than something: DO requests still bind
	it('changes nothing on the cold arm, where DO requests bind first', () => {
		const arm = queueArm();
		expect(arm.queueRegenerationsPerDay).toBe(arm.alarmRegenerationsPerDay);
		expect(arm.ratio).toBe(1);
	});

	/**
	 * A queue ADDS a meter and replaces none, which is RULE 0b's decomposition trap.
	 *
	 * Every fill still needs its DO invocations; the consumer is Worker requests on top, taken off
	 * the serving ceiling. Batching cuts that from one per fill to one per MESSAGE, which is the
	 * half of the old refutation that the symmetric pricing improves rather than inverts.
	 */
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
		expect(SITE_STORAGE_BYTES.heapSnapshot).toBeGreaterThan(SITE_STORAGE_BYTES.seed * 5);
	});

	// the arms differ by ~9x, so HEAP_SNAPSHOT is a fleet-size decision and not only a latency one
	it('costs about 9x the sites to keep a stored heap', () => {
		const on = storageCeiling(true);
		const off = storageCeiling(false);
		expect(off.sitesPerAccount / on.sitesPerAccount).toBeGreaterThan(8);
		expect(on.sitesPerAccount).toBe(122);
		expect(off.sitesPerAccount).toBe(1083);
	});

	// a CONTROL against the figure this was mis-derived from: 23,724,032 came off an object that
	// had never migrated, 1.53x low
	it('uses the provisioned snapshot size, not the bare-object one', () => {
		expect(SITE_STORAGE_BYTES.heapSnapshot).not.toBe(23_724_032);
		expect(storageCeiling(true).sitesPerAccount).toBeLessThan(
			Math.floor(FREE_QUOTAS.storageBytes / (SITE_STORAGE_BYTES.seed + 23_724_032))
		);
	});

	it('charges the content a real site accumulates', () => {
		const bare = storageCeiling(false);
		const withContent = storageCeiling(false, 10_000_000);
		expect(withContent.sitesPerAccount).toBeLessThan(bare.sitesPerAccount);
	});

	// reported beside the verdict rather than folded into it: the rate ceilings score ONE site
	it('rides on the verdict without changing it', () => {
		const v = scoreWorkload(3_000_000, 0.01);
		expect(v.storage.withSnapshot.sitesPerAccount).toBe(122);
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
