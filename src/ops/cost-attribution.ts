import { isPaid, type PlanEnv } from './plan.js';
import { replicaCount } from './replica-routing.js';
import {
	THRESHOLDS,
	WARN_FRACTION,
	projectImageTransforms,
	readMeter,
	type FailureMode,
	type MeterPeriod,
	type MeterStatus,
	type Threshold
} from './thresholds.js';

/**
 * Which of a site's own activities spent each meter.
 *
 * `thresholdReport()` answers how close a meter is to its allowance; this answers what THIS site did
 * to get there. Several dimensions draw on one meter -- a cache miss, a render, a warming firing and
 * an outbound drain are all Durable Object requests -- so a meter total on its own cannot say which
 * of them to change.
 *
 * A dimension nothing counts is reported with the reason rather than as zero. Three of them read a
 * counter that exists and covers the wrong window: `alarmFirings` and `phpLaneEntries` are in-memory
 * and reset when the object is evicted, and `httpQueue` is a depth whose rows are deleted as they
 * drain. Scored against a daily allowance any of those gives a confident wrong percentage, which is
 * worse than a stated gap.
 *
 * No line carries a dollar figure. Every free-plan meter is an allowance rather than a bill, and no
 * per-unit price is recorded in this repository.
 */

/** the `/__serve-stats` fields this reads; absent and null both mean "not supplied" */
export type SiteSpend = {
	/** `dailyRows()`; a UTC-day total in `cfw_meta`, so it resets at midnight UTC */
	rowsToday?: number | null;
	/** `dailyDoRequests()`; the same UTC-day keying, and it counts what reached this object */
	doRequestsToday?: number | null;
	/** `storedBytes()` over this object's SQLite */
	storage?: number | null;
	/** `config` rows matching `image.style.%`; null on a site that has not migrated */
	imageStyles?: number | null;
	/** `file_managed` rows with an image mime; null on a site that has not migrated */
	managedImages?: number | null;
};

/** the environment a spend report reads: the plan, and the configured replica pool */
export type SpendEnv = PlanEnv & { REPLICA_COUNT?: string | null };

/** what a dimension is counted in */
export type SpendUnit = 'requests' | 'rows' | 'bytes' | 'transformations';

/** what running out of the meter does, once the plan is resolved */
export type Consequence = 'bills' | 'stops working' | 'requests are refused';

export type SpendLine = {
	/** stable id, safe to key a UI row on */
	id: string;
	label: string;
	/** what this dimension spent, or null when nothing here counts it */
	quantity: number | null;
	unit: SpendUnit;
	/** the meter it draws on; several dimensions share one */
	meter: string;
	meterLabel: string;
	/** `level` is a stored amount rather than a rate, which no meter period describes */
	period: MeterPeriod | 'level';
	/** the allowance for the resolved plan; null when the plan does not meter it */
	allowance: number | null;
	percentOfAllowance: number | null;
	status: MeterStatus;
	failure: FailureMode;
	consequence: Consequence;
	/** where the figure came from, or why there is none */
	source: string;
};

export type SpendReport = {
	plan: 'free' | 'paid';
	lines: SpendLine[];
	/** lines carrying a real quantity */
	counted: number;
	/** lines nothing counts, reported rather than shown as zero */
	uncounted: number;
	usd: null;
	usdReason: string;
};

/** free's read allowance, `FREE_QUOTAS.rowsReadPerDay`; a separate meter from the write side */
export const ROWS_READ_METER: Threshold = {
	id: 'rows-read',
	label: 'Durable Object rows read',
	period: 'day',
	free: 5_000_000,
	paid: null,
	failure: 'error',
	spentBy: 'a cached page served off the storage lane, and every render',
	note: '50x the write allowance, so a render reads nowhere near enough for this to bind first',
	unmeasurable:
		'countingSql() passes read-only statements through untouched, so nothing counts reads; read it from Cloudflare analytics'
};

/** account-wide Durable Object storage, `FREE_QUOTAS.storageBytes`; a level rather than a rate */
export const STORAGE_METER = {
	id: 'storage-bytes',
	label: 'Durable Object storage',
	free: 5_000_000_000,
	paid: null,
	failure: 'error' as FailureMode
} as const;

/** days a month is projected over; the free-envelope model uses the same 30 */
export const DAYS_PER_MONTH = 30;

const threshold = (id: string): Threshold => {
	const found = THRESHOLDS.find((t) => t.id === id);
	if (!found) throw new RangeError(`no threshold with id ${id}`);
	return found;
};

const num = (value: number | null | undefined): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;

function consequenceOf(failure: FailureMode, allowance: number | null): Consequence {
	// an unmetered allowance is not a free one; the plan bills the usage instead of capping it
	if (allowance === null) return 'bills';
	if (failure === 'hard-cap') return 'stops working';
	return failure === 'billed' ? 'bills' : 'requests are refused';
}

/** the same rule `readMeter()` applies, for the level meter whose period it has no vocabulary for */
function scoreLevel(
	quantity: number | null,
	allowance: number | null
): { fraction: number | null; status: MeterStatus } {
	if (allowance === null) return { fraction: null, status: 'unmetered' };
	if (quantity === null) return { fraction: null, status: 'unknown' };
	const fraction = allowance > 0 ? quantity / allowance : 0;
	return { fraction, status: fraction >= 1 ? 'over' : fraction >= WARN_FRACTION ? 'warn' : 'ok' };
}

// `env` is positionally required in both builders: optional, an omitted argument silently scored a
// paid site against free's allowances
function meteredLine(
	dimension: { id: string; label: string; unit: SpendUnit },
	meter: Threshold,
	quantity: number | null,
	source: string,
	env: SpendEnv | null | undefined
): SpendLine {
	const reading = readMeter(meter, quantity, env);
	return {
		id: dimension.id,
		label: dimension.label,
		quantity,
		unit: dimension.unit,
		meter: meter.id,
		meterLabel: meter.label,
		period: meter.period,
		allowance: reading.limit,
		percentOfAllowance: reading.fraction === null ? null : reading.fraction * 100,
		status: reading.status,
		failure: meter.failure,
		consequence: consequenceOf(meter.failure, reading.limit),
		source
	};
}

function storageLine(
	dimension: { id: string; label: string },
	quantity: number | null,
	source: string,
	env: SpendEnv | null | undefined
): SpendLine {
	const allowance = isPaid(env) ? STORAGE_METER.paid : STORAGE_METER.free;
	const { fraction, status } = scoreLevel(quantity, allowance);
	return {
		id: dimension.id,
		label: dimension.label,
		quantity,
		unit: 'bytes',
		meter: STORAGE_METER.id,
		meterLabel: STORAGE_METER.label,
		period: 'level',
		allowance,
		percentOfAllowance: fraction === null ? null : fraction * 100,
		status,
		failure: STORAGE_METER.failure,
		consequence: consequenceOf(STORAGE_METER.failure, allowance),
		source
	};
}

/**
 * Attributes one site's spend across the meters it draws on.
 *
 * Every dimension is reported, including the ones with no quantity. An omitted row and a null row
 * read the same in a table and mean opposite things, and the null is the one that needs acting on.
 */
export function attributeSpend(spend: SiteSpend, env?: SpendEnv | null): SpendReport {
	const workerRequests = threshold('worker-requests');
	const doRequests = threshold('do-requests');
	const rowsWritten = threshold('rows-written');
	const imageTransforms = threshold('image-transforms');

	const stored = num(spend.storage);
	const lanes = replicaCount(env ?? undefined);
	const styles = num(spend.imageStyles);
	const images = num(spend.managedImages);

	const lines: SpendLine[] = [
		meteredLine(
			{ id: 'image-transforms', label: 'Image transformations', unit: 'transformations' },
			imageTransforms,
			styles !== null && images !== null
				? projectImageTransforms({ images, styles }, env).uniques
				: null,
			styles !== null && images !== null
				? `${styles} image styles over ${images} managed images, one transformation each`
				: 'config and file_managed are absent until the site migrates, and 0 would read as a verified zero',
			env
		),
		meteredLine(
			{ id: 'page-views', label: 'Page views', unit: 'requests' },
			workerRequests,
			null,
			`${workerRequests.unmeasurable}; serveRequests is a lifetime total of what reached this object, so it is not this meter`,
			env
		),
		meteredLine(
			{ id: 'object-hops', label: 'Requests that reached the object', unit: 'requests' },
			doRequests,
			num(spend.doRequestsToday),
			'dailyDoRequests(), a UTC-day total; an eviction loses at most the requests since the last meter flush',
			env
		),
		meteredLine(
			{ id: 'renders', label: 'Renders', unit: 'requests' },
			doRequests,
			null,
			'phpLaneEntries counts requests that passed the storage lane in THIS incarnation, so it is neither a daily total nor a count of renders',
			env
		),
		meteredLine(
			{ id: 'warm-alarms', label: 'Warm alarm firings', unit: 'requests' },
			doRequests,
			null,
			'alarmFirings is in-memory and resets when the object is evicted, so it counts an incarnation rather than a day',
			env
		),
		meteredLine(
			{ id: 'outbound-fetches', label: 'Outbound fetches', unit: 'requests' },
			doRequests,
			null,
			'cfw_http_queue is a queue depth and a drained entry is deleted, so it cannot say how many fetches ran today',
			env
		),
		meteredLine(
			{ id: 'rows-written', label: 'Rows written', unit: 'rows' },
			rowsWritten,
			num(spend.rowsToday),
			'dailyRows(), a UTC-day total covering both the host and Drupal through countingSql()',
			env
		),
		meteredLine(
			{ id: 'rows-read', label: 'Rows read', unit: 'rows' },
			ROWS_READ_METER,
			null,
			ROWS_READ_METER.unmeasurable ?? 'nothing measures this yet',
			env
		),
		storageLine(
			{ id: 'stored-bytes', label: 'Stored bytes' },
			stored,
			'storedBytes() over this object; the allowance is ACCOUNT-WIDE, so this is one site out of it',
			env
		),
		storageLine(
			{ id: 'replica-copies', label: 'Replica pool storage' },
			stored === null ? null : stored * lanes,
			`REPLICA_COUNT is ${lanes}; each lane is its own object holding its own copy, and a lane that never provisioned holds none`,
			env
		)
	];

	return {
		plan: isPaid(env) ? 'paid' : 'free',
		lines,
		counted: lines.filter((l) => l.quantity !== null).length,
		uncounted: lines.filter((l) => l.quantity === null).length,
		usd: null,
		usdReason:
			'no per-unit price is recorded here, and every free-plan meter is an allowance rather than a bill; take a dollar figure from Cloudflare billing'
	};
}

/** what a projected line rests on, so a reader can tell a measurement from an extrapolation */
export type ProjectionBasis =
	'projected from today' | 'already a whole month' | 'a level, not a rate' | 'nothing counts it';

export type ProjectedLine = {
	id: string;
	label: string;
	meter: string;
	/** the daily rate the projection multiplies; null for a level or an already-monthly figure */
	perDay: number | null;
	month: number | null;
	allowance: number | null;
	percentOfAllowance: number | null;
	status: MeterStatus;
	basis: ProjectionBasis;
};

export type MonthProjection = {
	dayOfMonth: number;
	daysInMonth: number;
	/** how much of the month the counters have observed */
	elapsedFraction: number;
	/** true when the counters cover less than one whole day */
	partialDay: boolean;
	note: string;
	lines: ProjectedLine[];
};

function projectLine(line: SpendLine, days: number): ProjectedLine {
	const daily = line.period === 'day';
	const month = daily && line.quantity !== null ? line.quantity * days : line.quantity;
	const allowance = daily && line.allowance !== null ? line.allowance * days : line.allowance;
	const { fraction, status } = scoreLevel(month, allowance);
	return {
		id: line.id,
		label: line.label,
		meter: line.meter,
		perDay: daily ? line.quantity : null,
		month,
		allowance,
		percentOfAllowance: fraction === null ? null : fraction * 100,
		status,
		basis:
			line.quantity === null
				? 'nothing counts it'
				: daily
					? 'projected from today'
					: line.period === 'month'
						? 'already a whole month'
						: 'a level, not a rate'
	};
}

/**
 * A straight-line month from today's counters.
 *
 * Today's total is taken as the daily rate and multiplied by the days in the month. The elapsed
 * fraction is reported and never divided by: month-to-date over an elapsed fraction multiplies a
 * few hours of day 1 by thirty, and this input carries daily counters rather than a month-to-date
 * basis. `partialDay` says when the whole figure rests on one incomplete day.
 *
 * @param dayOfMonth clamped into 1..daysInMonth; a non-finite value reads as day 1.
 */
export function projectMonth(
	spend: SiteSpend,
	dayOfMonth: number,
	env?: SpendEnv | null,
	daysInMonth: number = DAYS_PER_MONTH
): MonthProjection {
	const days = Math.max(
		1,
		Math.floor(Number.isFinite(daysInMonth) ? daysInMonth : DAYS_PER_MONTH)
	);
	const day = Math.min(
		days,
		Math.max(1, Math.floor(Number.isFinite(dayOfMonth) ? dayOfMonth : 1))
	);
	return {
		dayOfMonth: day,
		daysInMonth: days,
		elapsedFraction: day / days,
		partialDay: day <= 1,
		note:
			day <= 1
				? `day 1 of ${days}: today's counters cover part of one day, and the month multiplies that by ${days}`
				: `today's counters are read as the daily rate; ${days - day} of ${days} days are not observed`,
		lines: attributeSpend(spend, env).lines.map((l) => projectLine(l, days))
	};
}
