/**
 * The host half of the health layer: pure-function tripwires, the ledger and quarantine.
 * It lives in JS because PHP cannot observe a JS throw out of a wasm import or its isolate dying.
 * @module
 */

/** severity ladder; the ledger stores the number so a query can range over it */
export const SEVERITY = {
	info: 0,
	warn: 1,
	error: 2,
	critical: 3
} as const;

/** a level name from the severity ladder */
export type Severity = keyof typeof SEVERITY;

/** one thing a tripwire noticed */
export interface Finding {
	/** stable dotted identifier; the breaker keys on this */
	code: string;
	severity: Severity;
	/** what it was about: a path, a bin, a table */
	scope: string;
	/** short human-readable detail; never unbounded */
	context: string;
}

/**
 * What the host can see at the end of a request or an alarm.
 * Primitives only: a tripwire holding the interpreter could keep a poisoned one alive.
 */
export interface Observation {
	/** HTTP status the object is about to return */
	status?: number;
	/** byte length of the body it is about to return */
	bytes?: number;
	/** the path that produced it */
	path?: string;
	/** rolling median byte length for this path, if known */
	medianBytes?: number;
	/** `globalThis.__cfwAsyncifyCalls`; anything above 0 means the stub was reached */
	asyncifyCalls?: number;
	/** mask depth at request end; must be 0 */
	maskDepth?: number;
	/** rows in `semaphore` after the request; must be 0 */
	semaphoreRows?: number;
	/** migration cursor state, if a migration exists at all */
	migrateChunk?: number;
	migrateChunks?: number;
	/** updb phase, if a run exists */
	updbPhase?: string;
	/** generation the packed assets were built for, against the one the database holds */
	packGeneration?: string;
	dbGeneration?: string;
	/** wasm linear memory high-water samples, oldest first */
	memorySamples?: number[];
	/** free-plan daily meters */
	rowsWritten?: number;
	rowsWrittenLimit?: number;
	doRequests?: number;
	doRequestsLimit?: number;
	/** the same two meters as rings of readings, oldest first, for the trend checks */
	rowsWrittenSamples?: number[];
	doRequestsSamples?: number[];
	/** rows in the health ledger itself, so it can police its own growth */
	ledgerRows?: number;
	/** unique image transformations the configuration implies (styles x images), a projection */
	imageTransforms?: number;
	/** the monthly allowance, when the plan has one */
	imageTransformsLimit?: number;
}

/** how far outside the rolling median a body may fall before it is an anomaly */
export const SIZE_ANOMALY_FACTOR = 3;

/** fraction of a daily free allowance that trips a budget warning */
export const BUDGET_WARN_FRACTION = 0.8;

/** how many rising samples in a row count as a leak rather than noise */
export const MEMORY_RISE_SAMPLES = 4;

/** capacity of one signal's ring; small, since the whole layer is per-object state */
export const TREND_RING_SAMPLES = 8;

/** fewest readings a slope claim may be made from (below five one outlier is the trend) */
export const TREND_MIN_SAMPLES = 5;

/** how many times the fitted rise must beat the wobble before it counts as a trend */
export const TREND_MIN_SNR = 2;

/**
 * How far ahead a budget projection may extrapolate, in samples; tied to the ring size.
 * Samples, never ms: `Date.now()` reads 0 inside the isolate on the edge.
 */
export const BUDGET_PROJECTION_SAMPLES = TREND_RING_SAMPLES;

/** rows the ledger may hold before its own GC rule trims it */
export const LEDGER_MAX_ROWS = 500;

/**
 * A 200 response with a zero-byte body, which a cache stores and re-serves as a real page.
 * Shipped once, when destructing `theme.registry` emptied every render after the first.
 */
export function renderEmpty(obs: Observation): Finding | undefined {
	if (obs.status !== 200) return undefined;
	if ((obs.bytes ?? 0) > 0) return undefined;
	return {
		code: 'render.empty',
		severity: 'critical',
		scope: obs.path ?? '?',
		context: `200 with ${obs.bytes ?? 0} bytes`
	};
}

/**
 * A body far outside the rolling median for its path; its only symptom was the byte count
 * when an unrestored uid 1 cached admin HTML (12,296 to 90,038 bytes) for anonymous visitors.
 */
export function renderSizeAnomaly(obs: Observation): Finding | undefined {
	const bytes = obs.bytes ?? 0;
	const median = obs.medianBytes ?? 0;
	if (obs.status !== 200 || median <= 0 || bytes <= 0) return undefined;
	const ratio = bytes / median;
	if (ratio <= SIZE_ANOMALY_FACTOR && ratio >= 1 / SIZE_ANOMALY_FACTOR) return undefined;
	return {
		code: 'render.size_anomaly',
		severity: 'error',
		scope: obs.path ?? '?',
		context: `${bytes} bytes against a median of ${median} (${ratio.toFixed(2)}x)`
	};
}

/**
 * The Asyncify stub was reached; only the `globalThis` counter shows it, PHP sees no fatal.
 * `warn`, not `error`: the stub returns -1 and `error` quarantined fresh sites on first cron.
 */
export function bridgeAsyncifyCalled(obs: Observation): Finding | undefined {
	const calls = obs.asyncifyCalls ?? 0;
	if (calls <= 0) return undefined;
	return {
		code: 'bridge.asyncify_called',
		severity: 'warn',
		scope: 'glue',
		context: `${calls} call(s) reached the Asyncify stub; a stream open failed`
	};
}

/**
 * The interrupt mask was still held when the request ended.
 * A leaked depth masks later suspension points forever, so slicing silently stops.
 */
export function bridgeMaskLeaked(obs: Observation): Finding | undefined {
	const depth = obs.maskDepth ?? 0;
	if (depth === 0) return undefined;
	return {
		code: 'bridge.mask_leaked',
		severity: 'error',
		scope: 'mask',
		context: `mask depth ${depth} at request end`
	};
}

/**
 * Rows left in `semaphore` after a request; shutdown never releases them here, and a held lock
 * stalls because `Lock::wait()` calls `usleep()` inside a wasm call nothing can interrupt.
 */
export function dbSemaphoreDirty(obs: Observation): Finding | undefined {
	const rows = obs.semaphoreRows ?? 0;
	if (rows <= 0) return undefined;
	return {
		code: 'db.semaphore_dirty',
		severity: 'warn',
		scope: 'semaphore',
		context: `${rows} row(s) left after the request`
	};
}

/**
 * Serving while the migration cursor is incomplete (Drupal renders a partial database and the
 * page is cached); a site with no cursor at all is a different state and is not flagged.
 */
export function migrateIncomplete(obs: Observation): Finding | undefined {
	const { migrateChunk, migrateChunks } = obs;
	if (migrateChunk === undefined || migrateChunks === undefined) return undefined;
	if (migrateChunks <= 0 || migrateChunk >= migrateChunks) return undefined;
	return {
		code: 'migrate.incomplete',
		severity: 'critical',
		scope: 'migration',
		context: `chunk ${migrateChunk} of ${migrateChunks}`
	};
}

/**
 * A database update run in the `halted` phase, which holds the alarm chain and never clears
 * itself (by design), so nothing else notices.
 */
export function updbHalted(obs: Observation): Finding | undefined {
	if (obs.updbPhase !== 'halted') return undefined;
	return {
		code: 'updb.halted',
		severity: 'error',
		scope: 'updb',
		context: 'a halted run is holding the alarm chain'
	};
}

/**
 * The packed assets and the database disagree about which generation they are.
 * An install bumps the counter, so an object restarted on the old pack serves a moved database.
 */
export function packGenerationMismatch(obs: Observation): Finding | undefined {
	const { packGeneration, dbGeneration } = obs;
	if (!packGeneration || !dbGeneration || packGeneration === dbGeneration) return undefined;
	return {
		code: 'pack.generation_mismatch',
		severity: 'critical',
		scope: 'pack',
		context: `pack ${packGeneration} against database ${dbGeneration}`
	};
}

/**
 * Mounted-filesystem bytes rising on every warm request; the sample is `MEMFS` resident bytes
 * (`HEAPU8.length` moves only on grow). Acts at a quiet moment: a recycle costs a 4,019 ms boot.
 */
export function memoryHighwaterRising(obs: Observation): Finding | undefined {
	const s = obs.memorySamples;
	if (!s || s.length < MEMORY_RISE_SAMPLES) return undefined;
	const tail = s.slice(-MEMORY_RISE_SAMPLES);
	for (let i = 1; i < tail.length; i++) {
		const prev = tail[i - 1];
		const cur = tail[i];
		if (prev === undefined || cur === undefined || cur <= prev) return undefined;
	}
	const first = tail[0] ?? 0;
	const last = tail[tail.length - 1] ?? 0;
	return {
		code: 'memory.highwater_rising',
		severity: 'warn',
		scope: 'isolate-bytes',
		context: `rose ${last - first} bytes over ${MEMORY_RISE_SAMPLES} samples`
	};
}

/**
 * A daily free-plan meter at or past its warn fraction.
 * Rows written (100,000/day, `setAlarm()` included) is the meter that binds fills.
 */
export function budgetPressure(obs: Observation): Finding[] {
	const out: Finding[] = [];
	const check = (used: number | undefined, limit: number | undefined, code: string) => {
		if (used === undefined || !limit || limit <= 0) return;
		const frac = used / limit;
		if (frac < BUDGET_WARN_FRACTION) return;
		out.push({
			code,
			severity: frac >= 1 ? 'error' : 'warn',
			scope: 'budget',
			context: `${used} of ${limit} (${(frac * 100).toFixed(1)}%)`
		});
	};
	check(obs.rowsWritten, obs.rowsWrittenLimit, 'budget.rows_written');
	check(obs.doRequests, obs.doRequestsLimit, 'budget.do_requests');
	return out;
}

/**
 * A fixed-size ring of readings for one signal, held by the caller beside the interpreter.
 * This module owns no state: its own history would keep a poisoned observation across a recycle.
 */
export class RingBuffer {
	/** most readings kept; older ones are dropped */
	readonly capacity: number;
	/** the readings, oldest first */
	private buf: number[] = [];

	constructor(capacity = TREND_RING_SAMPLES) {
		// a zero-capacity ring would silently swallow every push
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
		}
		this.capacity = capacity;
	}

	/** readings currently held */
	get length(): number {
		return this.buf.length;
	}

	/** appends a reading, dropping the oldest past capacity; a non-finite value is ignored */
	push(value: number): void {
		// a NaN sample poisons every later mean, so it is dropped at the door
		if (!Number.isFinite(value)) return;
		this.buf.push(value);
		if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
	}

	/** oldest first; a copy, so a caller cannot mutate the ring through it */
	samples(): number[] {
		return [...this.buf];
	}

	/** drops every reading */
	clear(): void {
		this.buf = [];
	}
}

/** what a least-squares fit over one ring says */
export interface Trend {
	/** slope in units per sample */
	slope: number;
	/** what the fit says the series rose across the whole window */
	rise: number;
	/** mean absolute residual from the fit line; the wobble the rise has to beat */
	noise: number;
	/** the rise points up and dominates the noise */
	rising: boolean;
}

/**
 * Least-squares slope over a ring; `rising` needs the rise to beat `TREND_MIN_SNR` times the
 * mean residual, since a bare `slope > 0` fires on wobble. A straight line (zero residual) passes.
 */
export function fitTrend(samples: number[] | undefined): Trend | undefined {
	if (!samples || samples.length < TREND_MIN_SAMPLES) return undefined;
	const n = samples.length;
	const xMean = (n - 1) / 2;
	const yMean = samples.reduce((a, b) => a + b, 0) / n;
	let cov = 0;
	let xVar = 0;
	for (let i = 0; i < n; i++) {
		const dx = i - xMean;
		cov += dx * ((samples[i] ?? 0) - yMean);
		xVar += dx * dx;
	}
	const slope = cov / xVar;
	const intercept = yMean - slope * xMean;
	let residual = 0;
	for (let i = 0; i < n; i++) {
		residual += Math.abs((samples[i] ?? 0) - (intercept + slope * i));
	}
	const noise = residual / n;
	const rise = slope * (n - 1);
	return { slope, rise, noise, rising: slope > 0 && rise >= TREND_MIN_SNR * noise };
}

/**
 * A daily meter whose trend crosses its allowance while the reading still looks fine.
 * Silent once the limit is crossed, so it never fires beside `budgetPressure` for one meter.
 */
export function budgetTrendProjected(obs: Observation): Finding[] {
	const out: Finding[] = [];
	const check = (samples: number[] | undefined, limit: number | undefined, code: string) => {
		if (!limit || limit <= 0) return;
		const trend = fitTrend(samples);
		if (!trend || !trend.rising) return;
		const last = samples?.[samples.length - 1] ?? 0;
		// already spent is budgetPressure's finding, not a forecast
		if (last >= limit) return;
		const projected = last + trend.slope * BUDGET_PROJECTION_SAMPLES;
		if (projected <= limit) return;
		out.push({
			code,
			severity: 'warn',
			scope: 'budget',
			context:
				`${last} of ${limit}, rising ${trend.slope.toFixed(1)}/sample -> ` +
				`~${Math.round(projected)} within ${BUDGET_PROJECTION_SAMPLES} samples`
		});
	};
	check(obs.rowsWrittenSamples, obs.rowsWrittenLimit, 'budget.rows_written_trend');
	check(obs.doRequestsSamples, obs.doRequestsLimit, 'budget.do_requests_trend');
	return out;
}

/**
 * Memory trending up with plateaus, which hide it from `memoryHighwaterRising`; silent when
 * that fired. `warn` schedules a quiet-moment recycle, since a mid-traffic reset costs 4,019 ms.
 */
export function memoryTrendRising(obs: Observation): Finding | undefined {
	// the monotonic case belongs to the check that already covers it
	if (memoryHighwaterRising(obs) !== undefined) return undefined;
	const samples = obs.memorySamples;
	const trend = fitTrend(samples);
	if (!trend || !trend.rising) return undefined;
	return {
		code: 'memory.trend_rising',
		severity: 'warn',
		scope: 'isolate-bytes',
		context:
			`trending up ~${Math.round(trend.rise)} bytes over ${samples?.length ?? 0} samples ` +
			`(${trend.slope.toFixed(1)}/request); recycle at the next quiet moment`
	};
}

/** the ledger over its row cap; guards the health layer exhausting the budget it watches */
export function ledgerOversized(obs: Observation): Finding | undefined {
	const rows = obs.ledgerRows ?? 0;
	if (rows <= LEDGER_MAX_ROWS) return undefined;
	return {
		code: 'health.ledger_oversized',
		severity: 'warn',
		scope: 'cfw_health',
		context: `${rows} rows against a cap of ${LEDGER_MAX_ROWS}`
	};
}

/**
 * The 5,000-a-month free image-transformation cap, projected from configuration; images just
 * stop transforming at the cap. Always `warn`: the fix is a human's config decision.
 */
export function imageCapProjected(obs: Observation): Finding | undefined {
	const { imageTransforms: used, imageTransformsLimit: limit } = obs;
	if (used === undefined || !limit || limit <= 0) return undefined;
	const fraction = used / limit;
	if (fraction < BUDGET_WARN_FRACTION) return undefined;
	const over = fraction >= 1;
	return {
		code: 'budget.image_transforms',
		severity: 'warn',
		scope: 'images',
		context: over
			? `${used} of ${limit}/month (${fraction.toFixed(2)}x over); transforms stop partway through the month`
			: `${used} of ${limit}/month (${(fraction * 100).toFixed(1)}%)`
	};
}

/** every host-side tripwire, in the order they are evaluated */
export const HOST_TRIPWIRES = [
	renderEmpty,
	renderSizeAnomaly,
	bridgeAsyncifyCalled,
	bridgeMaskLeaked,
	dbSemaphoreDirty,
	migrateIncomplete,
	updbHalted,
	packGenerationMismatch,
	memoryHighwaterRising,
	memoryTrendRising,
	ledgerOversized,
	imageCapProjected
] as const;

/** runs every host tripwire over one observation; O(1), inputs are scalars or capped rings */
export function runHostTripwires(obs: Observation): Finding[] {
	const found: Finding[] = [];
	for (const wire of HOST_TRIPWIRES) {
		const f = wire(obs);
		if (f) found.push(f);
	}
	found.push(...budgetPressure(obs));
	found.push(...budgetTrendProjected(obs));
	return found;
}

/** the repair ladder, re-exported from `repair.ts` where `recordOutcome()` runs it */
export { RUNGS as LADDER } from './repair';
export type { Rung };
import type { Rung } from './repair';

/**
 * Whether the object should stop serving rather than serve something wrong.
 * A 503 with `Retry-After` beats a 0-byte 200 that gets cached and served from the edge.
 */
export function quarantineDecision(findings: Finding[]): { quarantine: boolean; reason: string } {
	const critical = findings.filter((f) => SEVERITY[f.severity] >= SEVERITY.critical);
	if (critical.length === 0) return { quarantine: false, reason: '' };
	const first = critical[0];
	return {
		quarantine: true,
		reason: first ? `${first.code}: ${first.context}` : 'critical finding'
	};
}

/** the ledger, in DO SQLite; one table, two writers (this module and PHP) */
export const HEALTH_DDL = [
	`CREATE TABLE IF NOT EXISTS cfw_health (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ts INTEGER NOT NULL,
		code TEXT NOT NULL,
		severity INTEGER NOT NULL,
		scope TEXT NOT NULL DEFAULT '',
		context TEXT NOT NULL DEFAULT '',
		action TEXT NOT NULL DEFAULT '',
		outcome TEXT NOT NULL DEFAULT '',
		attempt INTEGER NOT NULL DEFAULT 0
	)`,
	// one index only: every query the layer makes is "recent, optionally by code". DO SQLite
	// bills one written row per index touched, so a third index would cost every insert
	`CREATE INDEX IF NOT EXISTS cfw_health_ts ON cfw_health (ts DESC)`
];

/** the shape this module needs from `ctx.storage.sql`; keeps it testable */
export interface HealthSql {
	exec(query: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** creates the ledger table and its index when absent */
export function ensureHealthTable(sql: HealthSql): void {
	for (const ddl of HEALTH_DDL) sql.exec(ddl);
}

/** context is truncated rather than trusted; an unbounded column is how a log table wins */
export const MAX_CONTEXT_BYTES = 400;

/** appends one finding to the ledger with the repair action taken, its outcome and attempt */
export function recordFinding(
	sql: HealthSql,
	finding: Finding,
	nowMs: number,
	action: Rung | '' = '',
	outcome = '',
	attempt = 0
): void {
	sql.exec(
		`INSERT INTO cfw_health (ts, code, severity, scope, context, action, outcome, attempt)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		nowMs,
		finding.code,
		SEVERITY[finding.severity],
		finding.scope.slice(0, 120),
		finding.context.slice(0, MAX_CONTEXT_BYTES),
		action,
		outcome,
		attempt
	);
}

/** trims the ledger to its cap, newest kept; returns rows deleted so the caller can bill them */
export function gcHealthLedger(sql: HealthSql, maxRows = LEDGER_MAX_ROWS): number {
	const rows = sql.exec('SELECT COUNT(*) AS n FROM cfw_health').toArray();
	const n = Number(rows[0]?.n ?? 0);
	if (n <= maxRows) return 0;
	const excess = n - maxRows;
	sql.exec(
		`DELETE FROM cfw_health WHERE id IN (
			SELECT id FROM cfw_health ORDER BY id ASC LIMIT ?
		)`,
		excess
	);
	return excess;
}
