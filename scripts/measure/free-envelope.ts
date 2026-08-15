/**
 * The free-tier PRODUCT envelope: two ceilings, not one.
 *
 *   bun scripts/measure/free-envelope.ts [--visits=3000000] [--dynamic=0.01] [--warmth=realRender]
 *
 * Every work item in this project has been scored against the **10 ms invocation
 * cap** -- "140x the cap", "85x the cap", "3 of 4 firings over the cap". That is the wrong objective
 * function. The 10 ms cap constrains one execution unit, and the architecture gets to choose what an
 * execution unit is; the report already measured a chain where 20 Durable Object hops accumulated
 * 142 ms of CPU with no single invocation over 10 ms. So "does a render fit in 10 ms" was never the
 * question. The question is whether the AGGREGATE daily budgets support the product's target workload.
 *
 * The cost model already said this and it governed nothing. `THE COST MODEL` section concluded
 * "Worker requests bind first, ~100,000 page views/day, ~3M/month" -- correct, present, and ignored by
 * every subsequent roadmap decision. This file is the fix: the envelope is arithmetic, so it is a
 * script with tests, and a proposal can be scored against it instead of against a CPU ceiling.
 *
 * The thing both the report and the critique conflate: there are **two independent ceilings**.
 *
 *   1. SERVING -- how many visits/month can be answered at all. Bound by Worker requests, because a
 *      cache HIT still costs one. ~100,000/day.
 *   2. REGENERATION -- how many distinct pages can be RENDERED per day. Bound by DO requests and rows
 *      written. This is the one that decides whether free is a real Drupal host, and it is far, far
 *      smaller.
 *
 * A "99% of traffic is cache hits" architecture rescues CPU and does **nothing** for the serving
 * ceiling, **as long as every hit still invokes the Worker** -- and `caches.default` inside a Worker
 * does. The decomposition trick is not free either: DO request quota explicitly includes alarm
 * invocations, so slicing spends the meter it is trying to dodge.
 *
 * The one lever that does move the serving ceiling, documented in both cases:
 *
 *   - **"Requests to static assets are free and unlimited"** -- Cloudflare Workers pricing. An asset
 *     request is served by the asset layer WITHOUT invoking the Worker, so it costs nothing against the
 *     100k/day request quota.
 *   - An **R2 public bucket on a CUSTOM DOMAIN** is served through Cloudflare Cache and never invokes a
 *     Worker either. A CDN hit costs no R2 operation; a CDN miss costs one Class B read. (Custom domain,
 *     not `r2.dev`: caching, WAF and access controls only exist on the custom-domain path. And "by
 *     default only certain file types are cached", so HTML needs a Cache Everything rule.)
 *
 * So `offWorkerFraction` is the fraction of visits answered without a Worker invocation, and it is the
 * only input to this model that can raise the serving ceiling at all.
 *
 * **The trap, which would silently destroy the free tier:** enabling the **Workers Caching** feature
 * bills EVERY request at the standard rate "including requests that are normally free: static asset
 * requests". A cache HIT then still costs a request and merely skips CPU. So that feature must stay OFF
 * on free -- it converts the one free serving path into a billed one.
 */

/** Documented free-plan daily quotas. Sources are in the report's PLATFORM LIMITS table. */
export const FREE_QUOTAS = {
	/** account-wide, resets midnight UTC, Error 1027 */
	workerRequestsPerDay: 100_000,
	/** explicitly "includes ... alarm invocations", which is what makes slicing cost something */
	doRequestsPerDay: 100_000,
	rowsWrittenPerDay: 100_000,
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
	workflowStepsPerInstance: 1_024
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
 * That is a 20x spread, so a flat estimate does not describe any real case -- and picking from it
 * requires knowing WHICH case the ceiling is about. The regeneration ceiling prices a page being
 * re-rendered after its cache was invalidated, so `realRender` is the default: both the `page`
 * and `dynamic_page_cache` bins empty, which is what `fillOne()` does by default and what an
 * invalidation leaves behind. `firstEverForPath` is 5x that, but its bulk is `cache_render`,
 * `cache_routes` and `cache_discovery` -- one-time-per-path costs paid while a site warms up, not
 * per-regeneration costs, so charging them to every regeneration understates the ceiling by 5x.
 *
 * Every figure here is POST-`cache_page`. Drupal's internal page cache used to add 4-5 rows on top
 * of each one, duplicating bytes the host already stores in `cfw_page`; the `page` bin now
 * resolves to a null backend (see `SERVICES_YAML` in `src/site-do.ts`). On a warm reassemble that
 * alone was 8 rows -> 3.
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
	servingBoundBy: 'worker' | 'do' | 'rows' | 'r2ClassB';
	perMeterViewCeiling: { worker: number; do: number; rows: number; r2ClassB: number };
	/** distinct pages that can be RENDERED per day, which is the real product question */
	regenerationsPerDay: number;
	regenerationBoundBy: 'do' | 'rows' | 'r2ClassA';
	windowed: boolean;
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

	const ceilings = {
		worker: perView.worker > 0 ? FREE_QUOTAS.workerRequestsPerDay / perView.worker : Infinity,
		do: perView.do > 0 ? FREE_QUOTAS.doRequestsPerDay / perView.do : Infinity,
		rows: perView.rows > 0 ? FREE_QUOTAS.rowsWrittenPerDay / perView.rows : Infinity,
		r2ClassB:
			perView.r2ClassB > 0
				? FREE_QUOTAS.r2ClassBPerMonth / DAYS_PER_MONTH / perView.r2ClassB
				: Infinity
	};

	const servingViewsPerDay = Math.floor(
		Math.min(ceilings.worker, ceilings.do, ceilings.rows, ceilings.r2ClassB)
	);
	const servingBoundBy = (['worker', 'do', 'rows', 'r2ClassB'] as const).reduce(
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

	return {
		servingViewsPerDay,
		servingBoundBy,
		perMeterViewCeiling: {
			worker: Math.floor(ceilings.worker),
			do: Math.floor(ceilings.do),
			rows: Math.floor(ceilings.rows),
			r2ClassB: Math.floor(ceilings.r2ClassB)
		},
		// Class A is a WRITE, so it prices regeneration rather than serving: one mirrored page per
		// fill. 1M/month is 33,333/day against a rows-bound ceiling of ~7,575, so it is not close --
		// but it is in the model now rather than assumed away
		regenerationsPerDay: Math.floor(Math.min(byDo, byRows, byR2ClassA)),
		regenerationBoundBy:
			byDo <= byRows && byDo <= byR2ClassA
				? 'do'
				: byRows <= byR2ClassA
					? 'rows'
					: 'r2ClassA',
		windowed: Boolean(opts.windowed)
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
	} = {}
): Verdict {
	const perDay = targetVisitsPerMonth / 30;
	const env = envelope(opts.mix ?? DEFAULT_MIX, {
		windowed: opts.windowed,
		rowsPerFill: opts.rowsPerFill,
		fillBatch: opts.fillBatch,
		warmth: opts.warmth,
		warmthMix: opts.warmthMix
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
		console.log(`VERDICT           ${v.verdict.toUpperCase()}`);
	}
}
