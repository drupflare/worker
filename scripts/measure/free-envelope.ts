/**
 *   bun scripts/measure/free-envelope.ts [--visits=3000000] [--dynamic=0.01] [--warmth=realRender]
 */

import { meterFlushBudget } from '../../src/ops/day-meters';
import { DURABLE_OBJECTS } from '../economics/rates';
import { GENERATED_FREE_QUOTAS } from '../generated/quotas';

/** documented free-plan daily quotas, declared in `config/quotas.yml` */
export const FREE_QUOTAS = GENERATED_FREE_QUOTAS;

/** what one site occupies in Durable Object SQLite, measured on provisioned sites */
export const SITE_STORAGE_BYTES = {
	/** the seeded database after `/migrate?all=1`; 5,550,080 on the 11.4.6 from-source pack */
	seed: 5_550_080,
	/** heap snapshot kept on a migrated cold object; 11,206,656 on the 2026-09-09 build */
	heapSnapshot: 11_206_656,
	/** the same snapshot on a site that has been through `/firstrun` and served one page */
	warmHeapSnapshot: 9_699_328,
	/** the image with each chunk deflated, 3,134,727 bytes (3.575x); off by default */
	packedHeapSnapshot: 3_134_727
} as const;

/** storage ratio that deflating the stored chunks buys; the seed is charged in full */
export const HEAP_PACK_RATIO =
	SITE_STORAGE_BYTES.heapSnapshot / SITE_STORAGE_BYTES.packedHeapSnapshot;

/** GB a Durable Object is billed for while alive; 0.128 is the decimal reading of 128 MB / 1 GB */
export const DO_GB_ALLOCATED = 0.128;

/** seconds in a day, named because the idle-object arithmetic below is what uses it */
export const SECONDS_PER_DAY = 86_400;

/** GB-s per day an object that cannot hibernate bills while idle; see `src/ops/hibernation.ts` */
export const IDLE_GB_S_PER_DAY = SECONDS_PER_DAY * DO_GB_ALLOCATED;

/** the replica architectures, scored separately: an always-warm fleet and a hibernating one bill differently */
export type ReplicaMode = 'alwaysWarm' | 'hibernating';

/** duration a replica fleet spends per day before serving; `hibernating` bills none of it here */
export function fleetIdleGbS(replicas: number, mode: ReplicaMode): number {
	return mode === 'alwaysWarm' ? Math.max(0, replicas) * IDLE_GB_S_PER_DAY : 0;
}

/** the idle re-arm for a site that is not warming; `KEEP_WARM_MS` in `src/ops/cron.ts` */
export const KEEP_WARM_MS = 240_000;

/** the interval that keeps an object resident; `warmIntervalMs()` in `src/ops/cron.ts` */
export const WARM_INTERVAL_MS = 8_000;

/** how often the daily meters flush on an idle day; read from `meterFlushBudget()` */
export const METER_FLUSH_SECONDS =
	meterFlushBudget(0, FREE_QUOTAS.rowsWrittenPerDay).intervalMs / 1000;

/** the same interval once the budget is nearly spent, which is the heavy-use end of the range */
export const METER_FLUSH_SECONDS_UNDER_LOAD =
	meterFlushBudget(FREE_QUOTAS.rowsWrittenPerDay, FREE_QUOTAS.rowsWrittenPerDay).intervalMs /
	1000;

/** keep-warm chain cost per day across a fleet; warmth comes from `HIBERNATION_IDLE_MS` */
export function keepWarmFleetCost(
	sites: number,
	keepWarmMs: number = KEEP_WARM_MS,
	flushSeconds: number = METER_FLUSH_SECONDS
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
	// two terms: the meter flush runs on its own clock, and the firings cap how often it runs.
	const flushesPerSitePerDay = Math.min(
		armsPerSitePerDay,
		Math.floor(SECONDS_PER_DAY / flushSeconds)
	);
	const rowsPerDay =
		perDay * FREE_QUOTAS.rowsPerAlarmArm +
		Math.max(0, sites) * flushesPerSitePerDay * FREE_QUOTAS.rowsPerMeterFlush;
	return {
		armsPerSitePerDay,
		rowsPerDay,
		// an alarm invocation is itself a billed DO request, so the chain spends both meters
		doRequestsPerDay: perDay,
		rowShare: rowsPerDay / FREE_QUOTAS.rowsWrittenPerDay,
		doRequestShare: perDay / FREE_QUOTAS.doRequestsPerDay,
		// divide by rows per site, not arms; the flush term makes the two counts differ.
		saturatingSites: Math.floor(
			Math.min(
				FREE_QUOTAS.rowsWrittenPerDay /
					Math.max(
						1,
						armsPerSitePerDay * FREE_QUOTAS.rowsPerAlarmArm +
							flushesPerSitePerDay * FREE_QUOTAS.rowsPerMeterFlush
					),
				FREE_QUOTAS.doRequestsPerDay / Math.max(1, armsPerSitePerDay)
			)
		)
	};
}

/** paid-plan duration cost; figures are from Cloudflare's pricing page, unverified here */
export const PAID_DURATION = {
	includedGbSPerMonth: DURABLE_OBJECTS.gbSIncluded,
	usdPerMillionGbS: DURABLE_OBJECTS.usdPerMillionGbS
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

/** `activeTime` is wall-clock microseconds, confirmed from billing on a deployed probe */
export const DURATION_CALIBRATION = {
	/** microseconds of wall clock the probe was held for */
	activeTimeUs: 10_026_244,
	/** microseconds of CPU the same invocations spent */
	cpuTimeUs: 3_838,
	/** GB-s Cloudflare billed for it */
	durationGbS: 1.283359232,
	measured: true
} as const;

/** how far cpuTime understates billed duration: 2,612x on a waiting workload, about 1x on a render */
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
	/** dearest steady-state fill, 308 ms with three bins emptied, from `x-worker-ms` on a deployed object */
	warmRender: 0.308,
	/** a cold render, 6,140 ms measured: boot plus render in one invocation */
	coldRender: 6.14
} as const;

/** CPU per Workflow step on free, in ms; a step is a separate budget, not more CPU */
export const WORKFLOW_STEP_CPU_MS = 10;

/** CPU one module install costs on the edge, in ms; measured n=3 with `wrangler tail` */
export const INSTALL_CPU_MS = 6_810;

/** the native figure, kept for the wasm-to-native ratio; not an edge cost */
export const INSTALL_CPU_MS_NATIVE = 1_344.7;

export type InstallVerdict = {
	/** steps one install needs if perfectly divisible at the free per-step CPU */
	stepsPerInstall: number;
	fitsOneInstance: boolean;
	installsPerDay: number;
	/** a Workflow invocation is charged against the same 100k/day as a Worker request */
	sharesServingQuota: true;
	problems: string[];
};

/** whether a module install fits free's Workflow budgets, which share the Worker request quota */
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

/** per-page-view requests, measured; rows a fill writes live in `ROWS_PER_FILL`, not here */
export const COST_PER_VIEW = {
	edgeHit: { worker: 1, do: 0 },
	doHit: { worker: 1, do: 1 },
	missAndFill: { worker: 1, do: 3 }
} as const;

/** rows per fill once `dblog` is uninstalled; the report measures both */
export const ROWS_PER_FILL_NO_DBLOG = 8;

/** the boot a cold object pays before it can render, edge `cpuTime`, n=3 */
export const COLD_BOOT_CPU_MS = 1_398;

/** free's per-invocation CPU cap; the burst allowance is why a single shot is not a measurement */
export const FREE_CPU_MS_CAP = 10;

/** what one visitor to a COLD url costs, per mechanism */
export type ColdUrlCost = {
	mechanism: 'alarmRetry' | 'inlineBoot' | 'skeleton';
	/** billed Worker requests, including any that answer a warming page or a 503 */
	worker: number;
	/** billed DO requests, counting alarm invocations */
	do: number;
	/** rows written, including the `setAlarm()` row */
	rows: number;
	peakInvocationMs: number;
	fitsFreeCap: boolean;
	/** false when the mechanism lacks an ARTIFACT rather than a budget */
	available: boolean;
};

/** priced per visitor for the three ways a cold URL could answer HTML */
export function coldUrlCost(rowsPerFill: number = ROWS_PER_FILL.realRender): ColdUrlCost[] {
	return [
		{
			// models a sliced boot, which does not exist; a boot is one invocation (see DO_INVOCATIONS_PER_FIRING)
			mechanism: 'alarmRetry',
			worker: 2,
			do: 3,
			rows: 1 + rowsPerFill,
			peakInvocationMs: FREE_CPU_MS_CAP,
			fitsFreeCap: true,
			available: true
		},
		{
			// one invocation boots and renders: the whole 1,398 ms in one place
			mechanism: 'inlineBoot',
			worker: 1,
			do: 1,
			rows: rowsPerFill,
			peakInvocationMs: COLD_BOOT_CPU_MS,
			fitsFreeCap: COLD_BOOT_CPU_MS <= FREE_CPU_MS_CAP,
			available: true
		},
		{
			// no artifact: `cfw_page` is empty by DEFINITION on a cold url
			mechanism: 'skeleton',
			worker: 1,
			do: 1,
			rows: 0,
			peakInvocationMs: FREE_CPU_MS_CAP,
			fitsFreeCap: true,
			available: false
		}
	];
}

/** DO invocations one alarm firing costs, which is one; the old 180-slice model was refuted */
export const DO_INVOCATIONS_PER_FIRING = 1;

/** @deprecated the 180-slice model; kept so a reader who finds the old figure lands on the reason */
export const DO_INVOCATIONS_PER_COLD_FILL = DO_INVOCATIONS_PER_FIRING;

/** the shipped fill batch; amortises the re-arm row and bounds HIT latency and isolate memory */
export const DEFAULT_FILL_BATCH = 5;

/** rows a fill writes per warmth class, excluding the amortised re-arm; post `cache_page` */
export const ROWS_PER_FILL = {
	/** page bin only, dynamic_page_cache warm; priced on the front page's 2 rows, the dearer path */
	warmReassemble: 2,
	/** both bins empty on /user/login; the SQL-bins figure, the shipping default reads 1 */
	realRender: 8,
	/** the front page on a freshly migrated object; not re-measured on the `WITHOUT ROWID` pack */
	firstFillAfterMigrate: 19,
	/** a path never routed on this object, once the object has filled something else */
	firstEverForPath: 14,
	/** the first fill on a fresh object, which pays the shared-bin warm-up once; not a per-path rate */
	firstFillOnFreshObject: 83
} as const;

/** the four classes at the shipping default, with `dynamic_page_cache` and `menu` in memory */
export const ROWS_PER_FILL_MEMORY_BINS = {
	warmReassemble: 2,
	realRender: 1,
	firstFillAfterMigrate: ROWS_PER_FILL.firstFillAfterMigrate,
	firstEverForPath: 11,
	firstFillOnFreshObject: 79
} as const;

export type FillWarmth = keyof typeof ROWS_PER_FILL;

/** how a day's fills are spread across the warmth classes; fractions, not counts */
export type WarmthMix = Partial<Record<FillWarmth, number>>;

/** a steady-state day's spread of fills; these weights are an assumption, not a measurement */
export const STEADY_STATE_WARMTH: WarmthMix = {
	warmReassemble: 0.25,
	realRender: 0.7,
	firstEverForPath: 0.05
};

/** weighted rows per fill for a spread of warmth classes; weights are used as given, not normalised */
export function rowsForWarmthMix(
	mix: WarmthMix,
	table: Record<FillWarmth, number> = ROWS_PER_FILL
): number {
	let rows = 0;
	for (const [warmth, weight] of Object.entries(mix) as Array<[FillWarmth, number]>) {
		if (!Number.isFinite(weight) || weight < 0) {
			throw new RangeError(`warmth weight for ${warmth} must be a non-negative number`);
		}
		rows += table[warmth] * weight;
	}
	return rows;
}

/** the fill window multiplier, now unused by any ceiling; kept until its last reader goes */
export const FILL_WINDOW_AMORTISATION = 25;

export type TrafficMix = {
	edgeHit: number;
	doHit: number;
	miss: number;
	/** fraction of visits served with no Worker invocation; the only lever on the serving ceiling */
	offWorker?: number;
};

/** the report's realistic mix */
export const DEFAULT_MIX: TrafficMix = { edgeHit: 0.85, doHit: 0.14, miss: 0.01 };

/** rows an editorial write costs, from a deployed object (medians, n=8 per class); see the Writes table in `TECHNICAL_REPORT.md` */
export const ROWS_PER_WRITE = {
	nodeCreate: 42,
	nodeRevision: 47,
	userCreate: 17,
	fileCreate: 7,
	aliasCreate: 24
} as const;

export type EditorialDay = Partial<Record<keyof typeof ROWS_PER_WRITE, number>>;

/** rows a day of editing spends before regeneration; defaults to nothing, since no rate is measured */
export function editorialRowsPerDay(perDay: EditorialDay = {}): number {
	return (Object.keys(ROWS_PER_WRITE) as (keyof typeof ROWS_PER_WRITE)[]).reduce(
		(total, kind) => total + Math.max(0, perDay[kind] ?? 0) * ROWS_PER_WRITE[kind],
		0
	);
}

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
	/** rows and duration the keep-warm chain spends before traffic; reported, not folded in */
	warming: { rowsPerDay: number; doRequestsPerDay: number; rowShare: number };
	/** the daily row quota split by claimant: warming chain, editors and fills */
	writeBudget: {
		quotaRows: number;
		warmingRows: number;
		editorialRows: number;
		regenerationRows: number;
		/** rows per regeneration at this warmth, so the two halves can be reconciled by hand */
		rowsPerFill: number;
	};
	regenerationBoundBy: 'do' | 'rows' | 'r2ClassA' | 'duration';
	windowed: boolean;
	/** the duration meter, reported whether or not it binds */
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

/** computes both ceilings for a traffic mix; `mix` fractions are used as given, not normalised */
export function envelope(
	mix: TrafficMix = DEFAULT_MIX,
	opts: {
		windowed?: boolean;
		rowsPerFill?: number;
		fillBatch?: number;
		/** which warmth class to price; ignored when `rowsPerFill` is given outright */
		warmth?: FillWarmth;
		/** a spread of warmth classes; overridden by `rowsPerFill` when that is given */
		warmthMix?: WarmthMix;
		/** whether a fill writes an R2 object; implied by `offWorker > 0` unless `offWorkerVia` is assets */
		mirror?: boolean;
		/** what answers an off-Worker visit; `assets` reads no R2 object and a fill writes none */
		offWorkerVia?: 'r2' | 'assets';
		/** off-Worker reads the CDN answers before R2; 0 until a Cache Rule makes the hostname eligible */
		cdnAbsorption?: number;
		/** objects held alive continuously; charged against the duration allowance before any request */
		alwaysWarmObjects?: number;
		/** how the replica fleet behaves when idle; `hibernating` pays a wake, which is not priced */
		replicaMode?: ReplicaMode;
		/** which render a fill pays for; a cold object pays the boot again */
		fillWarmth?: 'warm' | 'cold';
		/** whether the site keeps itself resident; spends the budget being divided up */
		warmed?: boolean;
		/** the warming interval, when it is not the shipping `WARM_INTERVAL_MS` */
		keepWarmMs?: number;
		/** what editors do in a day; zero by default because no real site's rate is measured */
		editorial?: EditorialDay;
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
	// an off-Worker visit costs no Worker or DO request; the asset layer answers it. Drain edgeHit first.
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
		r2ClassB: opts.offWorkerVia === 'assets' ? 0 : wanted * (1 - absorption)
	};

	// duration, the meter nothing counted: an off-Worker read never wakes the object, a DO hit is one read,
	// and a miss holds the object for a whole render
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

	// warming is spent before any traffic, so one term is taken off the two meters it spends.
	const warming =
		(opts.warmed ?? true)
			? keepWarmFleetCost(1, opts.keepWarmMs ?? WARM_INTERVAL_MS)
			: { rowsPerDay: 0, doRequestsPerDay: 0 };
	// the editors' share, taken off the same meter; zero by default, so nothing moves unless a rate is given
	const editorialRows = editorialRowsPerDay(opts.editorial);
	const rowsAvailable = Math.max(
		0,
		FREE_QUOTAS.rowsWrittenPerDay - warming.rowsPerDay - editorialRows
	);
	const doAvailable = Math.max(0, FREE_QUOTAS.doRequestsPerDay - warming.doRequestsPerDay);

	const ceilings = {
		worker: perView.worker > 0 ? FREE_QUOTAS.workerRequestsPerDay / perView.worker : Infinity,
		do: perView.do > 0 ? doAvailable / perView.do : Infinity,
		rows: perView.rows > 0 ? rowsAvailable / perView.rows : Infinity,
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

	// a firing is one invocation that drains `batch` pages, so the invocation term is 1/batch alone.
	const amortisation = batch;
	const invocationsPerFill = DO_INVOCATIONS_PER_FIRING / amortisation;
	const byDo = doAvailable / invocationsPerFill;
	const byRows = rowsAvailable / rowsPerFill;
	// the R2 Class A term applies only when a fill writes an R2 object; a default deploy writes none.
	const mirrored =
		((mix.offWorker ?? 0) > 0 && opts.offWorkerVia !== 'assets') || opts.mirror === true;
	const byR2ClassA = mirrored ? FREE_QUOTAS.r2ClassAPerMonth / DAYS_PER_MONTH : Infinity;
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
		// class A is a write, so it prices regeneration: one mirrored page per fill, 33,333/day at 1M/month
		regenerationsPerDay: Math.floor(Math.min(byDo, byRows, byR2ClassA, byDuration)),
		warming: {
			rowsPerDay: warming.rowsPerDay,
			doRequestsPerDay: warming.doRequestsPerDay,
			rowShare: warming.rowsPerDay / FREE_QUOTAS.rowsWrittenPerDay
		},
		writeBudget: {
			quotaRows: FREE_QUOTAS.rowsWrittenPerDay,
			warmingRows: warming.rowsPerDay,
			editorialRows,
			regenerationRows: rowsAvailable,
			rowsPerFill
		},
		regenerationBoundBy: (['do', 'rows', 'r2ClassA', 'duration'] as const).reduce(
			(best, meter) => (regenCeilings[meter] < regenCeilings[best] ? meter : best),
			'do' as const
		),
		windowed: Boolean(opts.windowed)
	};
}

/** what a queue-backed fill would cost against the alarm chain it would replace */
export type QueueArm = {
	/** deliverable messages/day, which is the operation quota divided by the three each one costs */
	messagesPerDay: number;
	/** paths carried in ONE message body; the alarm arm's batch, applied to both */
	pathsPerMessage: number;
	/** fills the message quota alone allows, once each message carries a batch */
	fillsFromMessagesPerDay: number;
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
	const batch = Math.max(1, Math.floor(opts.fillBatch ?? DEFAULT_FILL_BATCH));

	/** one batch per message, the same batch the alarm arm is credited with; a multi-path body couples retries */
	const pathsPerMessage = batch;
	// the queue removes the re-arm row, already amortised as `+1/batch`; the per-page figure is the saving.
	const perPageRows =
		opts.rowsPerFill ??
		(opts.warmthMix
			? rowsForWarmthMix(opts.warmthMix)
			: ROWS_PER_FILL[opts.warmth ?? 'realRender']);
	const relieved = envelope(mix, { ...opts, rowsPerFill: perPageRows });

	const messagesPerDay = Math.floor(
		FREE_QUOTAS.queueOperationsPerDay / FREE_QUOTAS.queueOperationsPerMessage
	);
	const fillsFromMessagesPerDay = messagesPerDay * pathsPerMessage;
	const queued = Math.min(relieved.regenerationsPerDay, fillsFromMessagesPerDay);
	return {
		messagesPerDay,
		pathsPerMessage,
		fillsFromMessagesPerDay,
		alarmRegenerationsPerDay: alarm.regenerationsPerDay,
		queueRegenerationsPerDay: queued,
		alarmBoundBy: alarm.regenerationBoundBy,
		queueBoundBy:
			fillsFromMessagesPerDay < relieved.regenerationsPerDay
				? 'queueOps'
				: relieved.regenerationBoundBy,
		// one consumer invocation per MESSAGE now, not per fill; it still comes off the serving
		// ceiling, which is the half of the refutation that survives
		workerRequestsPerDay: Math.ceil(queued / pathsPerMessage),
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

/** the mirror share that maximises serving views; the lever has a maximum, not a limit */
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
		// strict >, so the smallest share at the peak wins; more mirroring is pure R2 spend
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

/** rows a fill writes at the shipping default, priced on the steady-state warmth mix */
export const SHIPPING_ROWS_PER_FILL = rowsForWarmthMix(
	STEADY_STATE_WARMTH,
	ROWS_PER_FILL_MEMORY_BINS
);

/** requests one first page load of the demo site makes, n=1: the page and 65 assets */
export const REQUESTS_PER_PAGE_LOAD = 66;

/** the platform side of republishing an asset, measured 2026-11-02 on a paid throwaway, small n */
export const ASSET_PUBLISH = {
	/** wall seconds of the deploy command over four completed republishes of the 17.6 MB script */
	deploySeconds: { min: 13.0, max: 16.4 },
	/** seconds from the deploy starting to the changed asset being served, same four republishes */
	visibleSeconds: { min: 11.9, max: 13.7 },
	/** completed republishes, and how many of them reset the warm object */
	completed: 4,
	resets: 0,
	/** files wrangler read from the assets directory on the first deploy of the canonical config */
	packFiles: 5_385,
	/** documented static asset files per Worker version */
	filesPerVersion: { free: 20_000, paid: 100_000 }
} as const;

/** page paths that fit beside the pack in one Worker version, per plan */
export const ASSET_PAGE_HEADROOM = {
	free: ASSET_PUBLISH.filesPerVersion.free - ASSET_PUBLISH.packFiles,
	paid: ASSET_PUBLISH.filesPerVersion.paid - ASSET_PUBLISH.packFiles
} as const;

/**
 * whether assets bill as Worker requests. 'billedAsWorker' is a scenario, not a billing reading: it
 * prices the Workers Cache exception that docs/impact/economics/free-vs-paid/index.md calls not shipped. 'notBilled' is the
 * shipped case and is also a model input, not a metered count.
 */
export type AssetBilling = 'notBilled' | 'billedAsWorker';

export type OffWorkerArm = {
	via: 'assets' | 'r2';
	billing: AssetBilling;
	/** fraction of views the arm answers off the Worker */
	share: number;
	/** billed Worker requests one view spends with the arm, and with neither */
	workerPerView: number;
	todayWorkerPerView: number;
	todayViewsPerDay: number;
	viewsPerDay: number;
	boundBy: Envelope['servingBoundBy'];
	regenerationsPerDay: number;
	regenerationBoundBy: Envelope['regenerationBoundBy'];
};

/**
 * scores one off-Worker arm under one billing scenario at the shipping default; a published page is
 * an asset and an R2 page never runs the Worker, and the 65 assets beside the page bill only if
 * static assets do
 */
export function offWorkerArm(
	via: 'assets' | 'r2',
	billing: AssetBilling,
	opts: Parameters<typeof envelope>[1] & { mix?: TrafficMix; share?: number } = {}
): OffWorkerArm {
	const mix = opts.mix ?? DEFAULT_MIX;
	const mirrorable = mix.edgeHit + mix.doHit;
	const share = Math.max(0, Math.min(opts.share ?? mirrorable, mirrorable));
	const base = { rowsPerFill: SHIPPING_ROWS_PER_FILL, ...opts };
	const env = envelope({ ...mix, offWorker: share }, { ...base, offWorkerVia: via });
	const today = envelope(mix, base);

	const subresources = billing === 'billedAsWorker' ? REQUESTS_PER_PAGE_LOAD - 1 : 0;
	const pageWorker = via === 'assets' && billing === 'billedAsWorker' ? 1 : 1 - share;
	const workerPerView = subresources + pageWorker;
	const todayWorkerPerView = subresources + 1;
	const ceilings = {
		worker: FREE_QUOTAS.workerRequestsPerDay / workerPerView,
		do: env.perMeterViewCeiling.do,
		rows: env.perMeterViewCeiling.rows,
		r2ClassB: env.perMeterViewCeiling.r2ClassB,
		duration: env.perMeterViewCeiling.duration
	};
	const todayCeilings = {
		worker: FREE_QUOTAS.workerRequestsPerDay / todayWorkerPerView,
		do: today.perMeterViewCeiling.do,
		rows: today.perMeterViewCeiling.rows,
		duration: today.perMeterViewCeiling.duration
	};
	const meters = Object.keys(ceilings) as Array<keyof typeof ceilings>;
	const boundBy = meters.reduce((best, m) => (ceilings[m] < ceilings[best] ? m : best), 'worker');
	return {
		via,
		billing,
		share,
		workerPerView,
		todayWorkerPerView,
		todayViewsPerDay: Math.floor(Math.min(...Object.values(todayCeilings))),
		viewsPerDay: Math.floor(Math.min(...Object.values(ceilings))),
		boundBy,
		regenerationsPerDay: env.regenerationsPerDay,
		regenerationBoundBy: env.regenerationBoundBy
	};
}

/** what a day of the assets arm's publishing allows; the serial cap is a measured throughput, not a quota */
export function assetPublishBudget(
	savesPerDay: number,
	debounceSeconds: number
): {
	publishesPerDay: number;
	serialCap: number;
	byDebounce: number;
	staleSeconds: { min: number; max: number };
} {
	const serialCap = Math.floor(SECONDS_PER_DAY / ASSET_PUBLISH.deploySeconds.max);
	const byDebounce = Math.floor(SECONDS_PER_DAY / Math.max(1, debounceSeconds));
	return {
		publishesPerDay: Math.min(Math.max(0, Math.floor(savesPerDay)), byDebounce, serialCap),
		serialCap,
		byDebounce,
		staleSeconds: {
			min: debounceSeconds + ASSET_PUBLISH.visibleSeconds.min,
			max: debounceSeconds + ASSET_PUBLISH.visibleSeconds.max
		}
	};
}

/** what rejecting bad traffic saves per meter; an in-Worker refusal still costs one Worker request */
export type RejectionSaving = {
	/** requests/day the rejection removes */
	rejectedPerDay: number;
	/** where the refusal is evaluated, which is what decides the Worker column */
	at: 'worker' | 'edge';
	saved: { worker: number; do: number; rows: number; durationGbS: number };
	/** what fraction of each daily allowance that is */
	savedShare: { worker: number; do: number; rows: number; duration: number };
};

/** scores a rejection rate against every meter; only `at: 'edge'` saves the Worker request */
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
	// the Worker request is saved only when the refusal happens before the Worker runs
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

export type StorageCeiling = {
	/** bytes one site occupies, seed plus the snapshot when it is kept */
	perSiteBytes: number;
	/** how many sites the account-wide allowance holds */
	sitesPerAccount: number;
	heapSnapshot: boolean;
	/** whether the stored chunks are deflated, which is what ships */
	packed: boolean;
};

/** how many sites fit the account-wide storage allowance; whether the snapshot is stored decides it */
export function storageCeiling(
	heapSnapshot: boolean,
	extraBytesPerSite = 0,
	packed = true
): StorageCeiling {
	const image = packed ? SITE_STORAGE_BYTES.packedHeapSnapshot : SITE_STORAGE_BYTES.heapSnapshot;
	const perSiteBytes =
		SITE_STORAGE_BYTES.seed + (heapSnapshot ? image : 0) + Math.max(0, extraBytesPerSite);
	return {
		perSiteBytes,
		sitesPerAccount: Math.floor(FREE_QUOTAS.storageBytes / perSiteBytes),
		heapSnapshot,
		packed
	};
}

export type StorageVerdict = {
	sites: number;
	perSiteBytes: number;
	usedBytes: number;
	/** fraction of the account-wide allowance the fleet occupies; over 1 means it does not fit */
	share: number;
	fits: boolean;
	/** sites the allowance holds at this per-site cost */
	sitesPerAccount: number;
};

/** whether a fleet of a given size fits the storage cap; the rate ceilings cannot see this */
export function fleetStorage(
	sites: number,
	opts: { heapSnapshot?: boolean; packed?: boolean; extraBytesPerSite?: number } = {}
): StorageVerdict {
	const ceiling = storageCeiling(
		opts.heapSnapshot ?? true,
		opts.extraBytesPerSite ?? 0,
		opts.packed ?? true
	);
	const n = Math.max(0, sites);
	const usedBytes = n * ceiling.perSiteBytes;
	return {
		sites: n,
		perSiteBytes: ceiling.perSiteBytes,
		usedBytes,
		share: usedBytes / FREE_QUOTAS.storageBytes,
		fits: usedBytes <= FREE_QUOTAS.storageBytes,
		sitesPerAccount: ceiling.sitesPerAccount
	};
}

/** cache-bin trim: 573,440 bytes retained per site for 205 charged rows, paid on the first render */
export const SEED_CACHE_TRIM = {
	savedAtProvisioning: 1_273_856,
	/** the traced-list pack, where the rebuild exceeded the shipped copy */
	savedAfterOneRender: -176_128,
	extraRowsOnFirstRender: 227,
	refuted: false,
	/** bytes retained after one render on the 11.4.6 pack; page-quantised, so +/- one page */
	savedAfterOneRenderFromSourcePack: 573_440,
	/** the quantum that figure is expressed in; SQLite's default page */
	pageBytes: 4_096,
	/** what those bytes buy against the 5 GB account cap */
	extraTenantsFromSourcePack: 80,
	/** and what they cost, once, on the meter that binds regeneration */
	extraRowsOnFirstRenderFromSourcePack: 205
} as const;

export type Verdict = {
	targetVisitsPerMonth: number;
	targetVisitsPerDay: number;
	dynamicFraction: number;
	fillsNeededPerDay: number;
	envelope: Envelope;
	servingFits: boolean;
	regenerationFits: boolean;
	/** a workload passes only when BOTH ceilings hold */
	verdict: 'fits' | 'serving-over' | 'regeneration-over' | 'both-over';
	headroom: { servingRatio: number; regenerationRatio: number };
	/** both storage arms, reported beside the verdict but not folded into it, since they score a fleet */
	storage: { withSnapshot: StorageCeiling; withoutSnapshot: StorageCeiling };
};

/** scores a target workload; both ceilings must hold, since a stale cache is not a Drupal host */
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
		/** off-Worker reads the CDN answers before R2; 0 until a Cache Rule makes the hostname eligible */
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
		},
		storage: {
			withSnapshot: storageCeiling(true),
			withoutSnapshot: storageCeiling(false)
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
	// `--warmth=<class>` prices one class and `--warmth=mix` the steady-state spread; the default stays realRender.
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
		console.log(`\n=== fill window: ${windowed ? 'ON' : 'OFF (alarm chain, the default)'} ===`);
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
		// the row quota is a write budget, and the line above is one claimant on it
		const w = v.envelope.writeBudget;
		console.log(
			`write budget      ${w.quotaRows.toLocaleString()} rows/day = ${w.warmingRows.toLocaleString()} warming + ${w.editorialRows.toLocaleString()} editorial + ${w.regenerationRows.toLocaleString()} regeneration, at ${w.rowsPerFill.toFixed(2)} rows/fill`
		);
		// reported whether or not it binds
		const d = v.envelope.duration;
		console.log(
			`duration          ${Math.round(d.servingUseGbS).toLocaleString()} of ${d.availableGbS.toLocaleString()} GB-s/day used at the serving ceiling (${(d.slackFraction * 100).toFixed(0)}% of the allowance available; cpuTime-derived, so an UNDERSTATEMENT)`
		);
		console.log(`VERDICT           ${v.verdict.toUpperCase()}`);
	}

	// these lines price `MEMORY_CACHE_BINS=none`; the shipping default is priced on the mix
	const shipping = envelope(DEFAULT_MIX, { rowsPerFill: SHIPPING_ROWS_PER_FILL });
	console.log(
		`\nshipping default  ${shipping.regenerationsPerDay.toLocaleString()}/day (bound by ${shipping.regenerationBoundBy}), ` +
			`dynamic_page_cache and menu in memory, priced on the warmth mix at ${SHIPPING_ROWS_PER_FILL.toFixed(2)} rows/fill`
	);

	// the two off-Worker arms, each under the observed no-billing case and the Workers Cache exception
	for (const billing of ['notBilled', 'billedAsWorker'] as const) {
		for (const via of ['assets', 'r2'] as const) {
			const a = offWorkerArm(via, billing);
			console.log(
				`${via.padEnd(6)} ${billing.padEnd(14)} ${a.todayViewsPerDay.toLocaleString()} -> ${a.viewsPerDay.toLocaleString()} views/day ` +
					`(${a.todayWorkerPerView.toFixed(2)} -> ${a.workerPerView.toFixed(2)} Worker requests a view, bound by ${a.boundBy}), ` +
					`regeneration ${a.regenerationsPerDay.toLocaleString()}/day (bound by ${a.regenerationBoundBy})`
			);
		}
	}
	const pagesFree = ASSET_PAGE_HEADROOM.free.toLocaleString();
	const pagesPaid = ASSET_PAGE_HEADROOM.paid.toLocaleString();
	console.log(
		`asset pages       ${pagesFree} paths beside the pack on free, ${pagesPaid} on paid, per Worker version`
	);
	const pub = assetPublishBudget(Infinity, 60);
	console.log(
		`asset publishing  at most ${pub.serialCap.toLocaleString()} a day serial at ${ASSET_PUBLISH.deploySeconds.max} s, ` +
			`${pub.byDebounce.toLocaleString()} at a 60 s debounce; a save is visible ` +
			`${pub.staleSeconds.min.toFixed(1)} to ${pub.staleSeconds.max.toFixed(1)} s later (n=${ASSET_PUBLISH.completed})`
	);

	// a fleet ceiling, not a traffic one, so it prints once outside the loop
	const s = scoreWorkload(visits, dynamic).storage;
	console.log(
		`\nstorage           ${s.withSnapshot.sitesPerAccount} sites with a stored heap ` +
			`(${(s.withSnapshot.perSiteBytes / 1e6).toFixed(1)} MB each), ` +
			`${s.withoutSnapshot.sitesPerAccount} without ` +
			`(${(s.withoutSnapshot.perSiteBytes / 1e6).toFixed(1)} MB each), ` +
			`against ${(FREE_QUOTAS.storageBytes / 1e9).toFixed(0)} GB account-wide`
	);
	// the no-image arm is the default, so it leads; an image is opt-in and costs both meters
	console.log(
		`heap image        OFF by default: the restore measured 1,912 ms of cpuTime (n=5) against ` +
			`1,264 ms (n=4) booting from the pack, so it costs storage AND CPU. When one IS stored ` +
			`the chunks are deflated (${HEAP_PACK_RATIO.toFixed(2)}x), which bounds the storage at ` +
			`${(SITE_STORAGE_BYTES.packedHeapSnapshot / 1e6).toFixed(2)} MB rather than ` +
			`${(SITE_STORAGE_BYTES.heapSnapshot / 1e6).toFixed(2)} MB`
	);
	console.log(
		`seed cache trim   REFUTED: ${SEED_CACHE_TRIM.savedAtProvisioning.toLocaleString()} bytes at provisioning, ` +
			`${SEED_CACHE_TRIM.savedAfterOneRender.toLocaleString()} after one render, ` +
			`+${SEED_CACHE_TRIM.extraRowsOnFirstRender} rows on it`
	);
}
