/**
 * The free-tier product envelope: two ceilings, not one.
 *
 *   bun scripts/measure/free-envelope.ts [--visits=3000000] [--dynamic=0.01] [--warmth=realRender]
 *
 * SERVING is how many visits/month can be answered at all, bound by Worker requests because a cache
 * hit still costs one. REGENERATION is how many distinct pages can be rendered per day, bound by DO
 * requests and rows written, and it is far smaller. A proposal has to clear both.
 *
 * `offWorkerFraction` is the only input that raises the serving ceiling: an asset request and an R2
 * custom domain are both served without invoking the Worker. Enabling the Workers Caching feature
 * removes that, since it bills every request including the normally-free ones.
 *
 * The measurements behind each figure are in `TECHNICAL_REPORT.md`.
 */

/** Documented free-plan daily quotas. Sources are in the report's PLATFORM LIMITS table. */
export const FREE_QUOTAS = {
	/** account-wide, resets midnight UTC, Error 1027 */
	workerRequestsPerDay: 100_000,
	/** explicitly "includes ... alarm invocations", which is what makes slicing cost something */
	doRequestsPerDay: 100_000,
	rowsWrittenPerDay: 100_000,
	/**
	 * Rows READ per day on free, which is 50x the write allowance and was never modelled.
	 *
	 * Nothing here was wrong -- the model simply had no read meter -- but the omission made it easy
	 * to assume reads and writes shared the 100,000. They do not, and the ratio is the point: a
	 * workload has to read 50 rows for every row it writes before reads become the binding meter,
	 * which a Drupal render does not come close to.
	 */
	rowsReadPerDay: 5_000_000,
	/**
	 * A `setAlarm()` call is billed as ONE ROW WRITTEN, documented.
	 *
	 * Not a quota; a cost this model had no line for. The keep-warm chain re-arms every 240 s, so
	 * an idle site spends 360 rows/day before serving anything -- 0.36% of the write allowance for
	 * doing nothing, and it scales with how often anything arms an alarm.
	 */
	rowsPerAlarmArm: 1,
	/**
	 * Queue operations per day on free, since 2026-02-04.
	 *
	 * ONE MESSAGE COSTS THREE: Cloudflare bills each 64 KB written, read or deleted, so a delivered
	 * message is a write, a read and a delete. 10,000/3 is the real message ceiling and a retry adds
	 * another read.
	 */
	queueOperationsPerDay: 10_000,
	queueOperationsPerMessage: 3,
	/**
	 * R2 operations, per MONTH, and they are what actually bound an off-Worker serving path.
	 *
	 * Class B is a READ, so it is the serving meter; Class A is a WRITE, so it is a regeneration one.
	 * These exist because "requests to static assets are free and unlimited" describes Workers Static
	 * Assets -- deploy-time uploads, which cannot hold a page rendered at runtime -- and the project
	 * spent months quoting that sentence for an R2 mechanism it does not cover.
	 */
	r2ClassBPerMonth: 10_000_000,
	r2ClassAPerMonth: 1_000_000,
	/**
	 * Cloudflare Images UNIQUE transformations per MONTH, not per day.
	 *
	 * A third meter neither ceiling sees, and the dangerous part is that it fails as a HARD CAP rather
	 * than as a bill. `CfwImageToolkit` defers every manipulation to a `/cdn-cgi/image/` URL, so an
	 * image style IS a transformation: 10 styles over 2,000 images is 20,000 uniques, 4x over, and
	 * nothing in the project would say so. A unique is one source image plus one parameter set.
	 */
	imageTransformsPerMonth: 5_000,
	/**
	 * Workflow STEPS per day on free. Paid gets 500,000/month.
	 *
	 * A fourth meter. Workflows IS available on free -- functional equivalence holds -- but the
	 * checklist's "25,000 separately-budgeted steps" is the PAID per-instance ceiling. Free is
	 * **1,024 steps per instance** and this daily total across all of them.
	 */
	workflowStepsPerDay: 3_000,
	/** steps in ONE workflow instance on free; paid defaults to 10,000 and configures to 25,000 */
	workflowStepsPerInstance: 1_024,
	/**
	 * Durable Object DURATION, GB-seconds per day. A FIFTH meter, and the model shipped without it.
	 *
	 * Billed against the **128 MB an object is allocated regardless of what it uses**, and billed on
	 * **WALL CLOCK rather than CPU** -- so every render figure this model carries is `cpuTime` and
	 * therefore an UNDERSTATEMENT of what this meter charges. Read the slack it reports as an upper
	 * bound, never as a margin.
	 */
	durationGbSPerDay: 13_000
} as const;

/**
 * GB a Durable Object is billed for while it is alive, whatever it actually uses.
 *
 * **0.128, THE DECIMAL READING, AND THIS WAS 0.125 UNTIL 2026-08-23.** Cloudflare's own worked
 * example fixes it: "1,000,000 seconds * 128 MB / 1 GB = 128,000 GB-s". 128 MB over 1 GB is 0.128
 * when both are decimal, and the binary reading (128 MiB / 1 GiB = 0.125) is what this model used.
 * 2.4% low everywhere it appeared, which took the idle-object figure from 11,059.2 to 10,800 GB-s
 * and understated every duration cost derived from it.
 */
export const DO_GB_ALLOCATED = 0.128;

/** seconds in a day, named because the idle-object arithmetic below is the whole point of it */
export const SECONDS_PER_DAY = 86_400;

/**
 * GB-s an object bills for existing continuously for a day while doing nothing.
 *
 * **83% of the entire free allowance.** The docs are explicit that an object which is idle and
 * ELIGIBLE for hibernation is not billed even before the runtime hibernates it -- but one that is
 * idle and UNABLE to hibernate bills the whole time. No request count and no row count would show it.
 *
 * The five disqualifying conditions are Cloudflare's and are transcribed in `src/ops/hibernation.ts`
 * rather than paraphrased here, because an earlier version of this comment listed "an un-awaited
 * `waitUntil`" and "a dangling timer" from memory and omitted the one that actually fires in this
 * codebase: an outbound TCP socket, which `src/ops/mail.ts` opens for every SMTP send.
 */
export const IDLE_GB_S_PER_DAY = SECONDS_PER_DAY * DO_GB_ALLOCATED;

/**
 * The three replica architectures, which are NOT one item and were scored as one.
 *
 * Replicas were closed as "dead on free" on the strength of the always-warm arithmetic below. That closes
 * ONE of these and says nothing about the other two -- an object that is idle and eligible for
 * hibernation accrues no duration at all, so a replica that hibernates between requests costs its
 * wake and its work and nothing else.
 *
 * `hibernating` is the interesting free-plan design and **nobody has measured one**. What it trades
 * is wall-clock latency on the wake for duration it never spends, and on this runtime a wake means
 * restoring or re-booting a 96 MiB interpreter. Score it with a measured wake, not with this.
 */
export type ReplicaMode = 'alwaysWarm' | 'hibernating';

/**
 * Duration a replica fleet spends per day, before serving anything.
 *
 * @param replicas how many objects the fleet holds.
 * @param mode `alwaysWarm` bills the whole day per object; `hibernating` bills only what it works,
 *   which this function reports as ZERO because the work is already priced per view by
 *   `envelope()`. That is the whole difference between the two, stated as arithmetic.
 */
export function fleetIdleGbS(replicas: number, mode: ReplicaMode): number {
	return mode === 'alwaysWarm' ? Math.max(0, replicas) * IDLE_GB_S_PER_DAY : 0;
}

/** the keep-warm chain's re-arm interval, `KEEP_WARM_MS` in `src/ops/cron.ts` */
export const KEEP_WARM_MS = 240_000;

/**
 * What the keep-warm chain costs a FLEET before a single visitor arrives.
 *
 * **THE PER-SITE FIGURE IS SMALL AND THE FLEET FIGURE IS NOT, and only the per-site one was ever
 * written down.** 360 rows/day is 0.36% of the write allowance, which reads as noise. But the free
 * DO quotas are ACCOUNT-WIDE, so a host running N sites on one account multiplies it, and the same
 * 360 arms also spend the DO REQUEST allowance because that quota "includes alarm invocations".
 * Two meters, same multiplier, neither modelled.
 *
 * **AND THE CHAIN BUYS NOTHING IT IS BELIEVED TO BUY.** An armed alarm is absent from Cloudflare's
 * hibernation-eligibility list, so it does not hold the object resident -- see
 * {@link ../../src/ops/hibernation.ts}. It costs two meters and delivers no warmth. This function
 * exists so that trade is arithmetic rather than an assumption.
 *
 * @param sites how many sites share one account's daily allowance.
 * @param keepWarmMs the re-arm interval; the default is what ships.
 */
export function keepWarmFleetCost(
	sites: number,
	keepWarmMs: number = KEEP_WARM_MS
): {
	armsPerSitePerDay: number;
	rowsPerDay: number;
	doRequestsPerDay: number;
	rowShare: number;
	doRequestShare: number;
	/** sites at which keep-warm alone saturates the tighter of the two meters */
	saturatingSites: number;
} {
	const armsPerSitePerDay = Math.floor((SECONDS_PER_DAY * 1000) / Math.max(1, keepWarmMs));
	const perDay = Math.max(0, sites) * armsPerSitePerDay;
	const rowsPerDay = perDay * FREE_QUOTAS.rowsPerAlarmArm;
	return {
		armsPerSitePerDay,
		rowsPerDay,
		// an alarm invocation is itself a billed DO request, so the chain spends both meters
		doRequestsPerDay: perDay,
		rowShare: rowsPerDay / FREE_QUOTAS.rowsWrittenPerDay,
		doRequestShare: perDay / FREE_QUOTAS.doRequestsPerDay,
		saturatingSites: Math.floor(
			Math.min(FREE_QUOTAS.rowsWrittenPerDay, FREE_QUOTAS.doRequestsPerDay) /
				Math.max(1, armsPerSitePerDay)
		)
	};
}

/**
 * Paid-plan duration, which inverts the free-plan conclusion at small replica counts.
 *
 * **SUPPLIED BY GREGORY 2026-08-23 FROM CLOUDFLARE'S PRICING PAGE, NOT VERIFIED BY THIS PROJECT.**
 * Marked because a pricing figure nobody re-read is exactly the class of number this repository has
 * had go stale three times. `paidDurationCost()` returns `verified: false` so the caveat travels
 * with the answer rather than staying in a comment.
 */
export const PAID_DURATION = {
	includedGbSPerMonth: 400_000,
	usdPerMillionGbS: 12.5
} as const;

/** what a fleet costs per month on the paid plan, above the included allowance */
export function paidDurationCost(
	replicas: number,
	mode: ReplicaMode = 'alwaysWarm',
	daysPerMonth = 30
): { gbSPerMonth: number; billableGbS: number; usd: number; verified: false } {
	const gbSPerMonth = fleetIdleGbS(replicas, mode) * daysPerMonth;
	const billableGbS = Math.max(0, gbSPerMonth - PAID_DURATION.includedGbSPerMonth);
	return {
		gbSPerMonth,
		billableGbS,
		usd: (billableGbS / 1_000_000) * PAID_DURATION.usdPerMillionGbS,
		verified: false
	};
}

/**
 * Wall-clock seconds a Durable Object is alive for, per event class.
 *
 * DERIVED FROM `cpuTime`, which is the honest caveat: cpuTime excludes the time an invocation
 * spends awaiting, and this meter charges for that too. Treat every duration ceiling computed from
 * these as an upper bound.
 */
/**
 * The duration meter, calibrated against a deployed object rather than inferred.
 *
 * MEASURED 2026-08-23 on `cfw-duration-probe`, a Durable Object with no PHP in it, driven with ten
 * 1,000 ms holds and read back from `durableObjectsPeriodicGroups`:
 *
 * | field        | reading    |
 * | ------------ | ---------- |
 * | `activeTime` | 10,026,244 |
 * | `cpuTime`    | 3,838      |
 * | `duration`   | 1.283359232 |
 *
 * `10.026244 s * 0.128 GB` is 1.283359232 GB-s exactly, so `activeTime` is MICROSECONDS of wall
 * clock and {@link DO_GB_ALLOCATED} is confirmed from billing rather than from a docs example.
 *
 * **THE RATIO IS THE POINT: 2,612x.** cpuTime does not see time spent awaiting and this meter
 * charges for it, so every figure derived from {@link SECONDS_PER} is a LOWER bound. "GraphQL
 * cannot see duration" was the wrong dataset, not a platform limit.
 */
export const DURATION_CALIBRATION = {
	/** microseconds of wall clock the probe was held for */
	activeTimeUs: 10_026_244,
	/** microseconds of CPU the same invocations spent */
	cpuTimeUs: 3_838,
	/** GB-s Cloudflare billed for it */
	durationGbS: 1.283359232,
	measured: true
} as const;

/** how far cpuTime understates billed duration, on a workload that spends its time awaiting */
export const CPU_UNDERSTATEMENT =
	DURATION_CALIBRATION.activeTimeUs / DURATION_CALIBRATION.cpuTimeUs;

/** GB-s an object bills for a measured number of wall-clock seconds */
export function billedGbS(wallClockSeconds: number): number {
	return Math.max(0, wallClockSeconds) * DO_GB_ALLOCATED;
}

export const SECONDS_PER = {
	/** answered by the Worker or the edge; the object is never woken */
	edgeHit: 0,
	/** one indexed read on the fast storage lane */
	doHit: 0.003,
	/** a warm render, 2,127 ms measured */
	warmRender: 2.127,
	/** a cold render, 6,140 ms measured: boot plus render in one invocation */
	coldRender: 6.14
} as const;

/**
 * CPU per Workflow step on free, in ms.
 *
 * The step does NOT buy more CPU -- it buys a SEPARATELY BUDGETED one. Free Workflows still get the same
 * 10 ms per invocation, so a step is the divisibility primitive and nothing more. That is exactly what a
 * module install needs and exactly not what "Workflows give you 5 minutes" would imply.
 */
export const WORKFLOW_STEP_CPU_MS = 10;

/** measured native cost of `en` (install) plus the `cr` flush it forces, in ms */
export const INSTALL_CPU_MS = 1_344.7 + 282.9;

export type InstallVerdict = {
	/** steps one install needs if perfectly divisible at the free per-step CPU */
	stepsPerInstall: number;
	fitsOneInstance: boolean;
	installsPerDay: number;
	/** a Workflow invocation is charged against the SAME 100k/day as a Worker request */
	sharesServingQuota: true;
	problems: string[];
};

/**
 * Whether a module install fits free's Workflow budgets.
 *
 * The trap this closes: a Workflow invocation is billed against the **same** 100,000/day request quota as
 * a Worker request ("shared with Workers requests"), so an install spends the serving ceiling. Same shape
 * as the cron trigger, and the serving ceiling is saturated at 3M/month.
 */
export function scoreInstall(cpuMs: number = INSTALL_CPU_MS): InstallVerdict {
	const stepsPerInstall = Math.ceil(cpuMs / WORKFLOW_STEP_CPU_MS);
	const problems: string[] = [];
	const fitsOneInstance = stepsPerInstall <= FREE_QUOTAS.workflowStepsPerInstance;
	if (!fitsOneInstance) {
		problems.push(
			`${stepsPerInstall} steps exceeds the free per-instance limit of ${FREE_QUOTAS.workflowStepsPerInstance}; it would need child instances`
		);
	}
	return {
		stepsPerInstall,
		fitsOneInstance,
		installsPerDay: Math.floor(FREE_QUOTAS.workflowStepsPerDay / stepsPerInstall),
		sharesServingQuota: true,
		problems
	};
}

/**
 * Per-page-view cost vectors, measured.
 *
 * An edge HIT costs a Worker request and nothing else -- and that one request is the whole serving
 * problem, because it is charged whether or not PHP ever runs.
 */
export const COST_PER_VIEW = {
	edgeHit: { worker: 1, do: 0, rows: 0 },
	doHit: { worker: 1, do: 1, rows: 0 },
	missAndFill: { worker: 1, do: 3, rows: 18 }
} as const;

/** rows per fill once `dblog` is uninstalled; the report measures both */
export const ROWS_PER_FILL_NO_DBLOG = 8;

/**
 * DO invocations to complete ONE fill when every alarm pays the boot again.
 *
 * Measured: the object hibernates after ~10 s idle and DISCARDS the interpreter, so boot is 3,754 ms
 * of edge cpuTime against a 40 ms render. Sliced at 8 ms that is ~475 invocations to buy one fill.
 */
export const DO_INVOCATIONS_PER_COLD_FILL = 475;

/**
 * How much the WebSocket fill window is worth.
 *
 * Each incoming message resets the CPU budget inside ONE object lifetime, so N messages buy N budgets
 * without N boots. The report puts this at ~25x what the alarm chain can fill.
 */
/**
 * The shipped `FILL_BATCH_SIZE` default (`src/site-do.ts:412`).
 *
 * One alarm firing fills N pages before re-arming, which amortises TWO per-firing costs across N: the
 * sliced boot, and the single row `setAlarm()` writes. The model shipped without this and therefore
 * understated a ceiling the code already beat -- the same stale-metric failure the model exists to
 * prevent, pointing the other way.
 */
export const DEFAULT_FILL_BATCH = 5;

/**
 * Rows a fill writes, per warmth class, excluding the re-arm a batch amortises.
 *
 * THIS REPLACES A FLAT 17, and the flat figure was wrong twice over.
 *
 * First, it was taken through an instrument that could only see Drupal's statements. The tally
 * hung off `execSql()`, which is the PHP driver's entry point, so every write the host made on
 * its own behalf was invisible -- including `cfw_page`, which stores the whole rendered page and
 * is the single largest write in a fill. Wrapping the storage handle instead (`countingSql()`)
 * raised a measured first fill from 12 rows to 23: 48% of the cost was never counted.
 *
 * Second, and this is the part no single number can express, the cost depends entirely on what is
 * already warm. Measured on one object, same front page, byte-identical output:
 *
 *   - re-fill with the render and dynamic_page_cache rows warm ... 3 rows
 *   - first fill of the front page on a freshly migrated site ... 19 rows
 *   - first fill of a path never rendered on this object ....... 62 rows
 *
 * A 20x spread, so picking from it requires knowing WHICH case the ceiling is about. `realRender` is
 * the default because the regeneration ceiling prices a re-render after invalidation;
 * `firstEverForPath` is 5x that and its bulk is one-time-per-path warming.
 *
 * Every figure here is POST-`cache_page`, which now resolves to a null backend.
 */
export const ROWS_PER_FILL = {
	/** page bin only, dynamic_page_cache left warm: a reassemble rather than a render */
	warmReassemble: 3,
	/** both bins empty -- a real render, and what a tag invalidation costs to undo */
	realRender: 13,
	/** the front page on a freshly migrated object, which also writes cfw_meta and the queue */
	firstFillAfterMigrate: 19,
	/**
	 * a path never routed on this object; mostly one-time cache_render/routes/discovery.
	 *
	 * 62 HERE AND 67 IN THE MEASUREMENT TABLE ARE BOTH RIGHT, and the difference has been
	 * "corrected" in the wrong direction once. 67 is what was measured BEFORE the `page` bin was
	 * nulled; 62 is the same fill after, because Drupal's internal page cache was adding 4-5 rows on
	 * top of every class. `warmReassemble` carries the same relationship more visibly, 8 -> 3. Every
	 * figure in this object is post-`cache_page`; the report's table is the historical reading.
	 */
	firstEverForPath: 62
} as const;

export type FillWarmth = keyof typeof ROWS_PER_FILL;

/** how a day's fills are spread across the warmth classes; fractions, not counts */
export type WarmthMix = Partial<Record<FillWarmth, number>>;

/**
 * A steady-state day's spread of fills, and **these weights are an assumption, not a measurement**.
 *
 * Stated that way. The four ROW figures above were each measured on a real object; the
 * weights below were not, and labelling them would be the difference between a model and a guess
 * wearing a model's clothes. They exist so a caller can price a distribution instead of being forced
 * to pick one class and pretend the other three do not happen -- which was the open question this
 * closes.
 *
 * The reasoning behind each weight, so it can be argued with rather than inherited:
 *
 *   - `realRender` dominates, because the regeneration ceiling is about pages being re-rendered
 *     after a tag invalidation, and that is what an invalidation leaves behind.
 *   - `warmReassemble` is a real minority: a fill whose `dynamic_page_cache` row survived does
 *     three rows of work, and edits that touch only the page bin produce exactly that.
 *   - `firstEverForPath` is a small tail. Its bulk is one-time-per-path `cache_render`,
 *     `cache_routes` and `cache_discovery`, so a steady-state day pays it only for paths the
 *     object has genuinely never served.
 *   - `firstFillAfterMigrate` is ABSENT rather than zero-weighted: it happens once per
 *     object lifetime, so it is not a rate at all and putting it in a per-day mix is a category
 *     error.
 */
export const STEADY_STATE_WARMTH: WarmthMix = {
	warmReassemble: 0.25,
	realRender: 0.7,
	firstEverForPath: 0.05
};

/**
 * Weighted rows per fill for a spread of warmth classes.
 *
 * Weights are used AS GIVEN rather than normalised, matching `envelope()`'s treatment of
 * `TrafficMix`: a mix that does not sum to 1 is a mistake in the caller, and silently rescaling it
 * would hide the mistake behind a plausible number.
 *
 * @throws if a weight is negative, which cannot mean anything and would quietly cancel another
 *   class out.
 */
export function rowsForWarmthMix(mix: WarmthMix): number {
	let rows = 0;
	for (const [warmth, weight] of Object.entries(mix) as Array<[FillWarmth, number]>) {
		if (!Number.isFinite(weight) || weight < 0) {
			throw new RangeError(`warmth weight for ${warmth} must be a non-negative number`);
		}
		rows += ROWS_PER_FILL[warmth] * weight;
	}
	return rows;
}

export const FILL_WINDOW_AMORTISATION = 25;

export type TrafficMix = {
	edgeHit: number;
	doHit: number;
	miss: number;
	/**
	 * Fraction of visits served with NO Worker invocation, and the only lever on the serving ceiling.
	 *
	 * "FREE AND UNLIMITED" APPLIES TO ONE OF THE TWO CANDIDATES AND NOT THE OTHER. Workers Static
	 * Assets are free and unlimited, and are uploaded at DEPLOY time -- so a rendered page cannot go
	 * there. The runtime-writable candidate is an R2 public bucket on a custom domain, and R2's free
	 * tier is 10 million CLASS B operations per month plus 1 million Class A, which is not unlimited.
	 *
	 * So the honest arithmetic for R2-served pages is: 10M Class B/month is 333,333/day against the
	 * 100,000/day Worker-request ceiling, a floor of about 3.3x rather than the 12.5x this project
	 * quoted. Anything above that floor depends on Cloudflare's CDN absorbing reads in front of the
	 * bucket, and that hit ratio has never been measured here. Writes are not the constraint: 1M
	 * Class A/month is 33,333/day against a 7,575/day regeneration ceiling.
	 *
	 * The model still treats this fraction as costing nothing, so a figure it produces above ~3.3x of
	 * the Worker ceiling is an UPPER BOUND that assumes the CDN carries the difference.
	 *
	 * Taken out of `edgeHit` FIRST and then out of `doHit`, and it removes the DO cost too: a page
	 * answered from an asset layer touches neither the Worker nor the object. The edge-hit/DO-hit
	 * distinction simply does not exist for a page that lives in R2, so a model that only drained
	 * `edgeHit` would understate the ceiling and stop at the DO meter for no real reason.
	 */
	offWorker?: number;
};

/** the report's realistic mix */
export const DEFAULT_MIX: TrafficMix = { edgeHit: 0.85, doHit: 0.14, miss: 0.01 };

export type Envelope = {
	/** max page views/day before the first meter runs out, and which meter that is */
	servingViewsPerDay: number;
	servingBoundBy: 'worker' | 'do' | 'rows' | 'r2ClassB' | 'duration';
	perMeterViewCeiling: {
		worker: number;
		do: number;
		rows: number;
		r2ClassB: number;
		duration: number;
	};
	/** distinct pages that can be RENDERED per day, which is the real product question */
	regenerationsPerDay: number;
	regenerationBoundBy: 'do' | 'rows' | 'r2ClassA' | 'duration';
	windowed: boolean;
	/**
	 * The duration meter, reported whether or not it binds.
	 *
	 * `alwaysWarmGbS` is spent BEFORE any traffic, so it is the number that prices always-warm
	 * render replicas: two objects held alive for a day is 21,600 GB-s against an allowance of
	 * 13,000, over on their own.
	 */
	duration: {
		allowanceGbS: number;
		alwaysWarmGbS: number;
		availableGbS: number;
		perViewGbS: number;
		perFillGbS: number;
		/** how much of the allowance a day at `servingViewsPerDay` would actually use */
		servingUseGbS: number;
		/** fraction of the allowance left after the always-warm objects; negative means over */
		slackFraction: number;
	};
};

/**
 * Computes both ceilings for a traffic mix.
 *
 * @param mix fractions; they are used as given rather than normalised, because a mix that does not sum
 *   to 1 is a mistake in the caller and silently rescaling it would hide the mistake.
 */
export function envelope(
	mix: TrafficMix = DEFAULT_MIX,
	opts: {
		windowed?: boolean;
		rowsPerFill?: number;
		fillBatch?: number;
		/** which warmth class to price; ignored when `rowsPerFill` is given outright */
		warmth?: FillWarmth;
		/**
		 * a SPREAD of warmth classes, which is what a real day is. Overrides `warmth`, and is
		 * itself overridden by `rowsPerFill`; the precedence runs most-specific-wins so a caller
		 * that pins an exact figure always gets it.
		 */
		warmthMix?: WarmthMix;
		/**
		 * Fraction of off-Worker reads that Cloudflare's CDN answers in front of the bucket, so they
		 * never become an R2 Class B operation.
		 *
		 * EXPLICIT AND DEFAULTED TO ZERO, because it is the one number in this model nobody has
		 * measured. At 0 the R2 ceiling is 333,333 views/day -- 3.33x the Worker ceiling -- and the
		 * true figure is `3.33x / (1 - absorption)`. Passing a value here is a stated assumption, not
		 * a measurement, and the report says so.
		 */
		cdnAbsorption?: number;
		/**
		 * Objects held alive continuously, which is what a render replica IS.
		 *
		 * Charged against the duration allowance before a single request is served, because an
		 * object that cannot hibernate bills for wall clock rather than for work. Defaults to 0:
		 * the shipping design lets an idle object hibernate.
		 */
		alwaysWarmObjects?: number;
		/**
		 * How the replica fleet behaves when idle.
		 *
		 * `alwaysWarm` is what `alwaysWarmObjects` used to mean unconditionally, and scoring every
		 * replica design that way is what closed replicas too widely. `hibernating` spends no idle
		 * duration at all -- it pays a WAKE instead, which this model does not price and which has
		 * never been measured on this runtime.
		 */
		replicaMode?: ReplicaMode;
		/** which render a fill pays for; a cold object pays the boot again */
		fillWarmth?: 'warm' | 'cold';
	} = {}
): Envelope {
	// the batch amortises the re-arm row across N pages, so rows/fill is per-page rows + 1/N rather
	// than a flat figure. `rowsPerFill` still overrides outright, for the dblog comparison.
	const batch = Math.max(1, Math.floor(opts.fillBatch ?? DEFAULT_FILL_BATCH));
	const perPageRows =
		opts.rowsPerFill ??
		(opts.warmthMix
			? rowsForWarmthMix(opts.warmthMix)
			: ROWS_PER_FILL[opts.warmth ?? 'realRender']);
	const rowsPerFill = opts.rowsPerFill !== undefined ? perPageRows : perPageRows + 1 / batch;
	// an off-Worker visit costs ZERO Worker requests AND zero DO requests: the asset layer answers it
	// without either. Drain edgeHit first, then doHit, because a cached page in R2 is served the same
	// way regardless of which tier would otherwise have answered it.
	const wanted = Math.max(0, Math.min(mix.offWorker ?? 0, mix.edgeHit + mix.doHit));
	const offEdge = Math.min(wanted, mix.edgeHit);
	const offDo = wanted - offEdge;
	// per-DAY from a per-MONTH quota, at 30 days, named rather than folded into a literal
	const DAYS_PER_MONTH = 30;
	const absorption = Math.max(0, Math.min(1, opts.cdnAbsorption ?? 0));
	const perView = {
		worker:
			(mix.edgeHit - offEdge) * COST_PER_VIEW.edgeHit.worker +
			(mix.doHit - offDo) * COST_PER_VIEW.doHit.worker +
			mix.miss * COST_PER_VIEW.missAndFill.worker,
		do:
			(mix.edgeHit - offEdge) * COST_PER_VIEW.edgeHit.do +
			(mix.doHit - offDo) * COST_PER_VIEW.doHit.do +
			mix.miss * COST_PER_VIEW.missAndFill.do,
		rows: mix.miss * rowsPerFill,
		// only the off-Worker share touches R2 at all, and only the part the CDN does not absorb
		r2ClassB: wanted * (1 - absorption)
	};

	// DURATION, the meter nothing counted. An off-Worker read never wakes the object, a DO hit is
	// one indexed read, and a miss holds the object for a whole render
	const renderSeconds =
		opts.fillWarmth === 'cold' ? SECONDS_PER.coldRender : SECONDS_PER.warmRender;
	const perViewSeconds =
		(mix.edgeHit - offEdge) * SECONDS_PER.edgeHit +
		(mix.doHit - offDo) * SECONDS_PER.doHit +
		mix.miss * renderSeconds;
	const perViewGbS = perViewSeconds * DO_GB_ALLOCATED;
	const perFillGbS = renderSeconds * DO_GB_ALLOCATED;
	// spent before any traffic, and ONLY when the fleet cannot hibernate. A hibernating replica
	// bills for its wake and its work, both of which are already priced per view above
	const alwaysWarmGbS = fleetIdleGbS(
		opts.alwaysWarmObjects ?? 0,
		opts.replicaMode ?? 'alwaysWarm'
	);
	const availableGbS = FREE_QUOTAS.durationGbSPerDay - alwaysWarmGbS;

	const ceilings = {
		worker: perView.worker > 0 ? FREE_QUOTAS.workerRequestsPerDay / perView.worker : Infinity,
		do: perView.do > 0 ? FREE_QUOTAS.doRequestsPerDay / perView.do : Infinity,
		rows: perView.rows > 0 ? FREE_QUOTAS.rowsWrittenPerDay / perView.rows : Infinity,
		r2ClassB:
			perView.r2ClassB > 0
				? FREE_QUOTAS.r2ClassBPerMonth / DAYS_PER_MONTH / perView.r2ClassB
				: Infinity,
		// a negative allowance is a ceiling of 0, not of Infinity: the always-warm objects have
		// already spent the day before a visitor arrives
		duration:
			perViewGbS > 0
				? Math.max(0, availableGbS) / perViewGbS
				: availableGbS < 0
					? 0
					: Infinity
	};

	const servingViewsPerDay = Math.floor(
		Math.min(ceilings.worker, ceilings.do, ceilings.rows, ceilings.r2ClassB, ceilings.duration)
	);
	const servingBoundBy = (['worker', 'do', 'rows', 'r2ClassB', 'duration'] as const).reduce(
		(best, meter) => (ceilings[meter] < ceilings[best] ? meter : best),
		'worker' as const
	);

	// REGENERATION is a separate budget: a fill's DO cost is the sliced boot, not the 3 of a warm hit.
	//
	// The boot is paid ONCE PER FIRING, and a firing fills `batch` pages, so it divides by the batch as
	// well as by the window. Stated rather than assumed: the two amortise the same boot by different
	// mechanisms -- the window keeps one object alive across messages, the batch does more work per
	// wake -- so multiplying them is only valid while a windowed firing still fills a full batch.
	const amortisation = (opts.windowed ? FILL_WINDOW_AMORTISATION : 1) * batch;
	const invocationsPerFill = DO_INVOCATIONS_PER_COLD_FILL / amortisation;
	const byDo = FREE_QUOTAS.doRequestsPerDay / invocationsPerFill;
	const byRows = FREE_QUOTAS.rowsWrittenPerDay / rowsPerFill;
	const byR2ClassA = FREE_QUOTAS.r2ClassAPerMonth / DAYS_PER_MONTH;
	const byDuration = perFillGbS > 0 ? Math.max(0, availableGbS) / perFillGbS : Infinity;
	const regenCeilings = { do: byDo, rows: byRows, r2ClassA: byR2ClassA, duration: byDuration };

	return {
		servingViewsPerDay,
		servingBoundBy,
		perMeterViewCeiling: {
			worker: Math.floor(ceilings.worker),
			do: Math.floor(ceilings.do),
			rows: Math.floor(ceilings.rows),
			r2ClassB: Math.floor(ceilings.r2ClassB),
			duration: Math.floor(ceilings.duration)
		},
		duration: {
			allowanceGbS: FREE_QUOTAS.durationGbSPerDay,
			alwaysWarmGbS,
			availableGbS,
			perViewGbS,
			perFillGbS,
			servingUseGbS:
				Math.min(
					ceilings.worker,
					ceilings.do,
					ceilings.rows,
					ceilings.r2ClassB,
					ceilings.duration
				) * perViewGbS,
			slackFraction: availableGbS / FREE_QUOTAS.durationGbSPerDay
		},
		// Class A is a WRITE, so it prices regeneration rather than serving: one mirrored page per
		// fill. 1M/month is 33,333/day against a rows-bound ceiling of ~7,575, so it is not close --
		// but it is in the model now rather than assumed away
		regenerationsPerDay: Math.floor(Math.min(byDo, byRows, byR2ClassA, byDuration)),
		regenerationBoundBy: (['do', 'rows', 'r2ClassA', 'duration'] as const).reduce(
			(best, meter) => (regenCeilings[meter] < regenCeilings[best] ? meter : best),
			'do' as const
		),
		windowed: Boolean(opts.windowed)
	};
}

/**
 * What a queue-backed fill would cost, against the alarm chain it would replace.
 *
 * Executable rather than written down: a queue removes the `setAlarm()` row and the alarm's own
 * invocation, and adds a meter with a much lower ceiling, so all three have to be priced at once.
 */
export type QueueArm = {
	/** deliverable messages/day, which is the operation quota divided by the three each one costs */
	messagesPerDay: number;
	/** the regeneration ceiling with the alarm chain, and with a queue in front of it */
	alarmRegenerationsPerDay: number;
	queueRegenerationsPerDay: number;
	/** which meter binds each arm */
	alarmBoundBy: Envelope['regenerationBoundBy'] | 'queueOps';
	queueBoundBy: Envelope['regenerationBoundBy'] | 'queueOps';
	/** Worker requests the consumer spends, which come off the SERVING ceiling */
	workerRequestsPerDay: number;
	/** > 1 means the queue helps */
	ratio: number;
};

export function queueArm(
	mix: TrafficMix = DEFAULT_MIX,
	opts: Parameters<typeof envelope>[1] = {}
): QueueArm {
	const alarm = envelope(mix, opts);
	// the two costs a queue actually removes: one alarm row and one alarm invocation per fill
	const relieved = envelope(mix, {
		...opts,
		rowsPerFill: Math.max(1, (opts.rowsPerFill ?? ROWS_PER_FILL.realRender) - 1)
	});
	const messagesPerDay = Math.floor(
		FREE_QUOTAS.queueOperationsPerDay / FREE_QUOTAS.queueOperationsPerMessage
	);
	const queued = Math.min(relieved.regenerationsPerDay, messagesPerDay);
	return {
		messagesPerDay,
		alarmRegenerationsPerDay: alarm.regenerationsPerDay,
		queueRegenerationsPerDay: queued,
		alarmBoundBy: alarm.regenerationBoundBy,
		queueBoundBy:
			messagesPerDay < relieved.regenerationsPerDay
				? 'queueOps'
				: relieved.regenerationBoundBy,
		workerRequestsPerDay: queued,
		ratio: alarm.regenerationsPerDay > 0 ? queued / alarm.regenerationsPerDay : 0
	};
}

/** what a mirror share is worth, and what maximising it would cost */
export type MirrorOptimum = {
	/** the `offWorker` share that maximises serving views */
	share: number;
	viewsPerDay: number;
	boundBy: Envelope['servingBoundBy'];
	/** mirroring everything that CAN be mirrored, which is the intuitive move and the wrong one */
	atFullMirror: { share: number; viewsPerDay: number };
	/** mirroring nothing, so the win is measured against a baseline rather than asserted */
	atNoMirror: { viewsPerDay: number };
	/** views/day given up by maximising instead of optimising; zero when they coincide */
	costOfMaximising: number;
	/** sweep resolution, so a caller can see how precise `share` is */
	step: number;
};

/**
 * The mirror share that maximises serving views, because this lever has a MAXIMUM and not a limit.
 *
 * Moving a view off the Worker spends R2's 333,333/day Class B meter to save the 100,000/day Worker
 * meter, so past the crossing point mirroring more makes the site smaller. On the default mix at zero
 * CDN absorption the peak is around 77% and mirroring everything falls back to roughly 337,000 --
 * giving up about a fifth of the ceiling the mirror exists to buy.
 *
 * **Numeric rather than analytic, deliberately.** The ceilings do cross at a solvable point, but
 * `envelope()` drains `edgeHit` before `doHit`, so the Worker cost is piecewise-linear with a knee at
 * `edgeHit` and the closed form needs a case per piece. A sweep evaluates the real function -- the
 * one every other caller uses -- so it cannot drift away from it, which a parallel derivation would.
 *
 * The optimum MOVES with the traffic mix and with `cdnAbsorption`, so call this rather than
 * hardcoding a share. Raising absorption does NOT walk the answer towards "mirror everything":
 * measured at absorption 1, where R2's read meter cannot bind at all, the peak arrives at 0.888 and
 * is bound by ROWS -- so past that point mirroring more buys nothing and still costs writes. The
 * ceiling always ends up on some other meter.
 */
export function optimalOffWorker(
	mix: TrafficMix = DEFAULT_MIX,
	opts: Parameters<typeof envelope>[1] & { step?: number } = {}
): MirrorOptimum {
	const step = Math.max(0.0001, Math.min(0.1, opts.step ?? 0.001));
	const mirrorable = Math.max(0, mix.edgeHit + mix.doHit);

	const at = (share: number) => envelope({ ...mix, offWorker: share }, opts);

	let best = { share: 0, env: at(0) };
	for (let share = step; share <= mirrorable + 1e-9; share += step) {
		const capped = Math.min(share, mirrorable);
		const env = at(capped);
		// strict >, so the SMALLEST share achieving the peak wins: mirroring more for the same
		// ceiling is pure R2 spend with nothing bought
		if (env.servingViewsPerDay > best.env.servingViewsPerDay) best = { share: capped, env };
	}

	const full = at(mirrorable);
	const none = at(0);
	return {
		share: best.share,
		viewsPerDay: best.env.servingViewsPerDay,
		boundBy: best.env.servingBoundBy,
		atFullMirror: { share: mirrorable, viewsPerDay: full.servingViewsPerDay },
		atNoMirror: { viewsPerDay: none.servingViewsPerDay },
		costOfMaximising: best.env.servingViewsPerDay - full.servingViewsPerDay,
		step
	};
}

/**
 * What rejecting bad traffic saves, per meter.
 *
 * The number every WAF reports is "requests blocked", and it is the one number that does not
 * matter here: what matters is which of the four meters the blocked traffic was going to spend.
 *
 * **THE DISTINCTION THAT DECIDES IT: where the rejection happens.** An in-Worker refusal --
 * `isNeverDrupal()` and `bodyTooLarge()` in `src/site.ts` -- still costs ONE WORKER REQUEST,
 * because the Worker has to run to refuse. It saves the DO hop, the rows and the duration and
 * saves nothing at all on the meter that binds SERVING. A WAF or Turnstile rule evaluated before
 * the Worker is invoked costs zero Worker requests and is the only kind that moves that ceiling.
 *
 * Same shape as "a cache hit is not free": the intuitive saving is on the meter that is already
 * saturated, and the real saving is on the meters that were not binding.
 */
export type RejectionSaving = {
	/** requests/day the rejection removes */
	rejectedPerDay: number;
	/** where the refusal is evaluated, which is what decides the Worker column */
	at: 'worker' | 'edge';
	saved: { worker: number; do: number; rows: number; durationGbS: number };
	/** what fraction of each daily allowance that is */
	savedShare: { worker: number; do: number; rows: number; duration: number };
};

/**
 * Scores a rejection rate against every meter.
 *
 * @param rejectedPerDay
 *   Requests/day the rule would refuse.
 * @param at
 *   `worker` for a refusal inside the Worker, `edge` for one evaluated before it is invoked.
 * @param wouldHaveCost
 *   What a refused request would have cost had it been served. Defaults to the miss-and-fill
 *   profile, which is the pessimistic and the interesting case: a scanner asks for paths that are
 *   never cached, so every one of them is a MISS.
 */
export function scoreRejection(
	rejectedPerDay: number,
	at: 'worker' | 'edge' = 'worker',
	wouldHaveCost: { worker: number; do: number; rows: number; seconds: number } = {
		worker: COST_PER_VIEW.missAndFill.worker,
		do: COST_PER_VIEW.missAndFill.do,
		rows: ROWS_PER_FILL.realRender,
		seconds: SECONDS_PER.warmRender
	}
): RejectionSaving {
	const n = Math.max(0, rejectedPerDay);
	// the Worker request is saved ONLY when the refusal happens before the Worker runs
	const savedWorker = at === 'edge' ? n * wouldHaveCost.worker : 0;
	const saved = {
		worker: savedWorker,
		do: n * wouldHaveCost.do,
		rows: n * wouldHaveCost.rows,
		durationGbS: n * wouldHaveCost.seconds * DO_GB_ALLOCATED
	};

	return {
		rejectedPerDay: n,
		at,
		saved,
		savedShare: {
			worker: saved.worker / FREE_QUOTAS.workerRequestsPerDay,
			do: saved.do / FREE_QUOTAS.doRequestsPerDay,
			rows: saved.rows / FREE_QUOTAS.rowsWrittenPerDay,
			duration: saved.durationGbS / FREE_QUOTAS.durationGbSPerDay
		}
	};
}

export type Verdict = {
	targetVisitsPerMonth: number;
	targetVisitsPerDay: number;
	dynamicFraction: number;
	fillsNeededPerDay: number;
	envelope: Envelope;
	servingFits: boolean;
	regenerationFits: boolean;
	/** the whole point: a workload passes only when BOTH ceilings hold */
	verdict: 'fits' | 'serving-over' | 'regeneration-over' | 'both-over';
	headroom: { servingRatio: number; regenerationRatio: number };
};

/**
 * Scores a target workload against the envelope.
 *
 * Both ceilings must hold. A workload that serves fine but cannot regenerate its pages is not a
 * working Drupal host; it is a static site with a stale cache.
 */
export function scoreWorkload(
	targetVisitsPerMonth: number,
	dynamicFraction: number,
	opts: {
		windowed?: boolean;
		mix?: TrafficMix;
		rowsPerFill?: number;
		fillBatch?: number;
		warmth?: FillWarmth;
		warmthMix?: WarmthMix;
		/**
		 * Fraction of off-Worker reads that Cloudflare's CDN answers in front of the bucket, so they
		 * never become an R2 Class B operation.
		 *
		 * EXPLICIT AND DEFAULTED TO ZERO, because it is the one number in this model nobody has
		 * measured. At 0 the R2 ceiling is 333,333 views/day -- 3.33x the Worker ceiling -- and the
		 * true figure is `3.33x / (1 - absorption)`. Passing a value here is a stated assumption, not
		 * a measurement, and the report says so.
		 */
		cdnAbsorption?: number;
		/** objects held alive continuously; see `envelope()` */
		alwaysWarmObjects?: number;
		fillWarmth?: 'warm' | 'cold';
	} = {}
): Verdict {
	const perDay = targetVisitsPerMonth / 30;
	const env = envelope(opts.mix ?? DEFAULT_MIX, {
		windowed: opts.windowed,
		rowsPerFill: opts.rowsPerFill,
		fillBatch: opts.fillBatch,
		warmth: opts.warmth,
		warmthMix: opts.warmthMix,
		cdnAbsorption: opts.cdnAbsorption,
		alwaysWarmObjects: opts.alwaysWarmObjects,
		fillWarmth: opts.fillWarmth
	});
	const fillsNeededPerDay = perDay * dynamicFraction;
	const servingFits = perDay <= env.servingViewsPerDay;
	const regenerationFits = fillsNeededPerDay <= env.regenerationsPerDay;

	const verdict: Verdict['verdict'] = servingFits
		? regenerationFits
			? 'fits'
			: 'regeneration-over'
		: regenerationFits
			? 'serving-over'
			: 'both-over';

	return {
		targetVisitsPerMonth,
		targetVisitsPerDay: Math.round(perDay),
		dynamicFraction,
		fillsNeededPerDay: Math.round(fillsNeededPerDay),
		envelope: env,
		servingFits,
		regenerationFits,
		verdict,
		headroom: {
			servingRatio: env.servingViewsPerDay / perDay,
			regenerationRatio:
				fillsNeededPerDay > 0 ? env.regenerationsPerDay / fillsNeededPerDay : Infinity
		}
	};
}

if (import.meta.main) {
	const arg = (name: string, fallback: number): number => {
		const hit = process.argv.find((a: string) => a.startsWith(`--${name}=`));
		return hit ? Number(hit.slice(name.length + 3)) : fallback;
	};
	const visits = arg('visits', 3_000_000);
	const dynamic = arg('dynamic', 0.01);
	// `--warmth=<class>` prices one class, `--warmth=mix` prices STEADY_STATE_WARMTH. Neither is
	// the default: `realRender` stays it, because the regeneration ceiling is about a page being
	// re-rendered after an invalidation and that is exactly what one class describes.
	const warmthArg = process.argv.find((a: string) => a.startsWith('--warmth='))?.slice(9);
	const useMix = warmthArg === 'mix';
	if (warmthArg && !useMix && !(warmthArg in ROWS_PER_FILL)) {
		console.error(
			`unknown --warmth=${warmthArg}; expected 'mix' or one of ${Object.keys(ROWS_PER_FILL).join(', ')}`
		);
		process.exit(2);
	}
	const warmth = useMix ? undefined : (warmthArg as FillWarmth | undefined);
	const warmthMix = useMix ? STEADY_STATE_WARMTH : undefined;
	const pricedAs = useMix
		? `mix (${rowsForWarmthMix(STEADY_STATE_WARMTH).toFixed(2)} rows/fill, ASSUMED weights)`
		: `${warmth ?? 'realRender'} (${ROWS_PER_FILL[warmth ?? 'realRender']} rows/fill)`;
	console.log(`priced as         ${pricedAs}`);

	for (const windowed of [false, true]) {
		const v = scoreWorkload(visits, dynamic, { windowed, warmth, warmthMix });
		console.log(`\n=== fill window: ${windowed ? 'ON (~25x)' : 'OFF (alarm chain)'} ===`);
		console.log(
			`target            ${v.targetVisitsPerMonth.toLocaleString()}/month = ${v.targetVisitsPerDay.toLocaleString()}/day`
		);
		console.log(
			`serving ceiling   ${v.envelope.servingViewsPerDay.toLocaleString()}/day (bound by ${v.envelope.servingBoundBy}) -> ${v.servingFits ? 'FITS' : 'OVER'} (${v.headroom.servingRatio.toFixed(2)}x)`
		);
		console.log(
			`fills needed      ${v.fillsNeededPerDay.toLocaleString()}/day at ${(dynamic * 100).toFixed(1)}% dynamic`
		);
		console.log(
			`regen ceiling     ${v.envelope.regenerationsPerDay.toLocaleString()}/day (bound by ${v.envelope.regenerationBoundBy}) -> ${v.regenerationFits ? 'FITS' : 'OVER'} (${v.headroom.regenerationRatio.toFixed(2)}x)`
		);
		// reported whether or not it binds; a meter nobody looks at is how the first four were missed
		const d = v.envelope.duration;
		console.log(
			`duration          ${Math.round(d.servingUseGbS).toLocaleString()} of ${d.availableGbS.toLocaleString()} GB-s/day used at the serving ceiling (${(d.slackFraction * 100).toFixed(0)}% of the allowance available; cpuTime-derived, so an UNDERSTATEMENT)`
		);
		console.log(`VERDICT           ${v.verdict.toUpperCase()}`);
	}
}
