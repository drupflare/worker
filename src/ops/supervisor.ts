/**
 * The host half of the health layer: tripwires, the ledger, the breaker, quarantine.
 *
 * Half of this has to be JavaScript, for one reason:
 * **a repair path must not depend on the subsystem it repairs.** PHP cannot observe a JS throw
 * out of a wasm import (measured twice -- `@` and `catch (\Throwable)` are both useless, and the
 * whole invocation dies), cannot observe its own isolate being killed, and cannot be trusted to
 * fix itself once poisoned. Detection and repair for those classes live here.
 *
 * Every tripwire in this file corresponds to a defect this project has ALREADY SHIPPED and then
 * found: a tripwire earns its place by having caught something real, so each one names its
 * incident.
 *
 * Everything here is a pure function of an observation, so it is testable without a Durable
 * Object, a wasm instance, or a clock. The wiring that gathers observations lives in
 * `src/site-do.js`; this module never reads global state.
 */

/** severity ladder; the ledger stores the number so a query can range over it */
export const SEVERITY = {
	info: 0,
	warn: 1,
	error: 2,
	critical: 3
} as const;

export type Severity = keyof typeof SEVERITY;

/** one thing a tripwire noticed */
export interface Finding {
	/** stable dotted identifier; the breaker keys on this */
	code: string;
	severity: Severity;
	/** what it was about -- a path, a bin, a table */
	scope: string;
	/** short human-readable detail; never unbounded */
	context: string;
}

/**
 * What the host can see at the end of a request or an alarm.
 *
 * Deliberately a flat bag of primitives rather than a live object: a tripwire that holds a
 * reference to the interpreter could keep a poisoned one alive.
 */
export interface Observation {
	/** HTTP status the object is about to return */
	status?: number;
	/** byte length of the body it is about to return */
	bytes?: number;
	/** the path that produced it */
	path?: string;
	/** rolling median byte length for THIS path, if known */
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
	/**
	 * Unique image transformations this site's CONFIGURATION implies: styles x images.
	 *
	 * A projection rather than a count, and that is the point -- the meter is a function of content
	 * and configuration, both known in advance, so the answer does not have to wait for the failure.
	 */
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

/** capacity of one signal's ring. Small: the whole layer is per-object state */
export const TREND_RING_SAMPLES = 8;

/**
 * Fewest readings a slope claim may be made from.
 *
 * Below five, one outlier IS the trend, and a check that fires on noise is worse than no check.
 */
export const TREND_MIN_SAMPLES = 5;

/** how many times the fitted rise must beat the wobble before it counts as a trend */
export const TREND_MIN_SNR = 2;

/**
 * How far ahead a budget projection may extrapolate, in samples.
 *
 * Tied to the ring size rather than picked, so the check never claims to see further forward than
 * it can see back. Samples, never milliseconds: `Date.now()` inside the isolate reads **0** on the
 * edge, so a time-based projection cannot be computed there at all.
 */
export const BUDGET_PROJECTION_SAMPLES = TREND_RING_SAMPLES;

/** rows the ledger may hold before its own GC rule trims it */
export const LEDGER_MAX_ROWS = 500;

/**
 * A 200 response with a zero-byte body.
 *
 * THIS SHIPPED. Destructing `theme.registry` on a persistent interpreter made render 1 return
 * 12,304 bytes and every render after it return 0, while rows-written per render jumped 15 -> 85.
 * A cache cannot tell an empty 200 from a real page, so it stores and re-serves it. This is the
 * tripwire the whole "quarantine beats wrong output" rule exists for.
 */
export function renderEmpty(obs: Observation): Finding | null {
	if (obs.status !== 200) return null;
	if ((obs.bytes ?? 0) > 0) return null;
	return {
		code: 'render.empty',
		severity: 'critical',
		scope: obs.path ?? '?',
		context: `200 with ${obs.bytes ?? 0} bytes`
	};
}

/**
 * A body whose length falls far outside the rolling median for its own path.
 *
 * This shipped too, and it is the other half of the empty-body failure. A save that switched
 * `\Drupal::currentUser()` to uid 1 and never switched back rendered the front page as an admin:
 * 12,296 bytes became **90,038**, and that admin HTML was written to the ANONYMOUS page cache and
 * served to the next anonymous visitor. An information-disclosure bug from one unrestored global,
 * and its only outward symptom was the byte count.
 */
export function renderSizeAnomaly(obs: Observation): Finding | null {
	const bytes = obs.bytes ?? 0;
	const median = obs.medianBytes ?? 0;
	if (obs.status !== 200 || median <= 0 || bytes <= 0) return null;
	const ratio = bytes / median;
	if (ratio <= SIZE_ANOMALY_FACTOR && ratio >= 1 / SIZE_ANOMALY_FACTOR) return null;
	return {
		code: 'render.size_anomaly',
		severity: 'error',
		scope: obs.path ?? '?',
		context: `${bytes} bytes against a median of ${median} (${ratio.toFixed(2)}x)`
	};
}

/**
 * The Asyncify stub was reached.
 *
 * The glue calls `Asyncify.handleAsync(...)` from the http/https stream wrapper and from
 * `vrzno_await`, and declares `Asyncify` nowhere, so it was a free identifier that `ASYNCIFY=0`
 * compiled out. Reaching it threw `ReferenceError` out of a wasm import, which **PHP cannot catch
 * at all** -- measured from two unrelated routes -- and killed the invocation. `stream_get_wrappers()`
 * advertises http and https, so ordinary contrib code reaches for them.
 *
 * A PHP-side handler cannot see this: no PHP fatal, no printErr, Drupal's logger never runs. The
 * counter on `globalThis` is the ONLY place it is observable, which is exactly why this tripwire
 * is in the host and not in PHP.
 */
export function bridgeAsyncifyCalled(obs: Observation): Finding | null {
	const calls = obs.asyncifyCalls ?? 0;
	if (calls <= 0) return null;
	return {
		code: 'bridge.asyncify_called',
		severity: 'error',
		scope: 'glue',
		context: `${calls} call(s) reached the Asyncify stub; a stream open failed`
	};
}

/**
 * The interrupt mask was still held when the request ended.
 *
 * The mask is refcounted around every host call that enters JS. A leaked depth means a later
 * suspension point is masked forever, so slicing silently stops happening -- and a dev assertion
 * that fires on suspension above depth 0 would never run, because the suspension never comes.
 */
export function bridgeMaskLeaked(obs: Observation): Finding | null {
	const depth = obs.maskDepth ?? 0;
	if (depth === 0) return null;
	return {
		code: 'bridge.mask_leaked',
		severity: 'error',
		scope: 'mask',
		context: `mask depth ${depth} at request end`
	};
}

/**
 * Rows left in `semaphore` after a request.
 *
 * `DatabaseLockBackend` relies on `releaseAll()` at process shutdown and this interpreter never
 * shuts down. A held lock is worse than a stale cache, because `Lock::wait()` calls `usleep()`
 * inside a synchronous wasm call that nothing can interrupt -- it stalls rather than failing. The
 * table was measured empty on every site exercised, so this is the tripwire that turns an
 * unobserved hazard into a test rather than a stall.
 */
export function dbSemaphoreDirty(obs: Observation): Finding | null {
	const rows = obs.semaphoreRows ?? 0;
	if (rows <= 0) return null;
	return {
		code: 'db.semaphore_dirty',
		severity: 'warn',
		scope: 'semaphore',
		context: `${rows} row(s) left after the request`
	};
}

/**
 * Serving while the migration cursor is incomplete.
 *
 * Chunked replay made "partway" a real state lasting ~99 alarm firings. **Drupal does not fail
 * cleanly against a quarter of its own database -- it renders**, with truncated caches, and that
 * render is then written to the page cache AND to the edge. Three serve-chain assertions failed
 * exactly that way. A site with no cursor at all is a different state (every deploy predating the
 * engine) and must NOT be flagged.
 */
export function migrateIncomplete(obs: Observation): Finding | null {
	const { migrateChunk, migrateChunks } = obs;
	if (migrateChunk === undefined || migrateChunks === undefined) return null;
	if (migrateChunks <= 0 || migrateChunk >= migrateChunks) return null;
	return {
		code: 'migrate.incomplete',
		severity: 'critical',
		scope: 'migration',
		context: `chunk ${migrateChunk} of ${migrateChunks}`
	};
}

/**
 * A database update run sitting in a terminal-but-blocking phase.
 *
 * `UPDB_PHASES` is planning, running, complete, halted, rolled_back, abandoned. `halted` holds the
 * chain and does not clear itself, by design, so that a second cursor can never open
 * over the same schema -- which means nothing else notices unless something looks.
 */
export function updbHalted(obs: Observation): Finding | null {
	if (obs.updbPhase !== 'halted') return null;
	return {
		code: 'updb.halted',
		severity: 'error',
		scope: 'updb',
		context: 'a halted run is holding the alarm chain'
	};
}

/**
 * The packed assets and the database disagree about which generation they are.
 *
 * Becomes reachable the moment modules live in a mutable second pack tier: install writes a new
 * object and bumps a counter, and a Durable Object that restarted against the old pack would serve
 * a tree whose database has already moved.
 */
export function packGenerationMismatch(obs: Observation): Finding | null {
	const { packGeneration, dbGeneration } = obs;
	if (!packGeneration || !dbGeneration || packGeneration === dbGeneration) return null;
	return {
		code: 'pack.generation_mismatch',
		severity: 'critical',
		scope: 'pack',
		context: `pack ${packGeneration} against database ${dbGeneration}`
	};
}

/**
 * Mounted-filesystem bytes rising monotonically across warm requests.
 *
 * Trend, not threshold, and the distinction matters: neither quantity ever shrinks, so an absolute
 * reading says nothing, while a monotonic rise across N warm requests is a leak. The lazy FS is
 * what this watches -- it converges on the union of every route ever served (up to ~52 MB against
 * the streaming mount's 39 MB) unless its LRU is holding.
 *
 * THE SAMPLE IS MEMFS RESIDENT BYTES. It used to be `HEAPU8.length`, which moves only on a
 * `memory.grow`: from 96 MiB at the shipping step two rungs reach workerd's cap, so four
 * strictly-increasing readings of it were unreachable and this never fired. `site-do.ts` falls back
 * to the heap only on the streaming mount, which has no LRU to leak through.
 *
 * Acts at the next quiet moment rather than the next request, because recycling the interpreter
 * mid-traffic trades a leak for a 4,019 ms boot.
 */
export function memoryHighwaterRising(obs: Observation): Finding | null {
	const s = obs.memorySamples;
	if (!s || s.length < MEMORY_RISE_SAMPLES) return null;
	const tail = s.slice(-MEMORY_RISE_SAMPLES);
	for (let i = 1; i < tail.length; i++) {
		const prev = tail[i - 1];
		const cur = tail[i];
		if (prev === undefined || cur === undefined || cur <= prev) return null;
	}
	const first = tail[0] ?? 0;
	const last = tail[tail.length - 1] ?? 0;
	return {
		code: 'memory.highwater_rising',
		severity: 'warn',
		scope: 'linear-memory',
		context: `rose ${last - first} bytes over ${MEMORY_RISE_SAMPLES} samples`
	};
}

/**
 * A daily free-plan meter projected past its allowance.
 *
 * Rows written at 100,000/day is the meter that actually binds fills, and `setAlarm()` is itself
 * one row written. The watchdog lesson is the reason this exists: an unbounded log table became
 * **46% of the database** before anybody looked.
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
 * A fixed-size ring of readings for one signal.
 *
 * One per signal, held by the caller in `src/site-do.ts` alongside the interpreter, because this
 * module is not allowed to own state -- a tripwire that kept its own history would keep a poisoned
 * observation alive across a recycle, which is the failure the whole layer exists to survive.
 *
 * `samples()` returns oldest-first, matching the order every check in this file already expects.
 */
export class RingBuffer {
	readonly capacity: number;
	private buf: number[] = [];

	constructor(capacity = TREND_RING_SAMPLES) {
		// a zero-capacity ring would silently swallow every push, so it is refused rather than eaten
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
		}
		this.capacity = capacity;
	}

	get length(): number {
		return this.buf.length;
	}

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
	/** the rise points up AND dominates the noise */
	rising: boolean;
}

/**
 * Least-squares slope over a ring, with a signal-to-noise gate.
 *
 * WHY A GATE AND NOT JUST `slope > 0`. Any real series wobbles, so a bare positive slope fires on
 * noise, and a trend check that fires on noise is worse than none -- it trains the operator to
 * ignore the ledger, which is the only place the host's findings are visible at all. So the fitted
 * rise across the window has to be at least `TREND_MIN_SNR` times the mean absolute residual.
 *
 * A perfectly straight line has zero residual, and `rise >= 2 * 0` holds, so the ideal case passes
 * rather than dividing by zero. The x-variance denominator cannot be zero either: x is 0..n-1 with
 * n >= TREND_MIN_SAMPLES.
 */
export function fitTrend(samples: number[] | undefined): Trend | null {
	if (!samples || samples.length < TREND_MIN_SAMPLES) return null;
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
 * A daily meter whose TREND crosses its allowance, while the reading itself still looks fine.
 *
 * This is the predictive half of `budgetPressure`, and it exists because a threshold at 80% is
 * information that arrives too late to be acted on: rows-written at 100,000/day is the meter that
 * binds, `setAlarm()` is itself one row, and the only cheap repair -- serving from a colder tier --
 * has to be chosen before the allowance is gone, not after.
 *
 * Deliberately silent once the meter has actually crossed its limit: at that point `budgetPressure`
 * reports the fact, and a projection about a limit already passed is noise. So the two never both
 * fire for the same meter.
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
 * Linear memory trending up across warm requests without rising every single time.
 *
 * The complement of `memoryHighwaterRising`, not a replacement for it. That check demands a
 * strictly monotonic rise over the last four samples, which emscripten's geometric growth makes a
 * reasonable shape to demand -- but it also means one plateau or one dip inside the window hides a
 * real leak completely, and the lazy FS converges on the union of every route ever served, which
 * climbs in steps rather than smoothly.
 *
 * So this one fits the whole ring and asks whether the rise beats the wobble, and it returns null
 * whenever the strict check already fired: two findings for one leak would escalate the breaker
 * twice as fast for no extra information.
 *
 * **Acts at the next quiet moment, never the next request.** Recycling the interpreter mid-traffic
 * trades a leak nobody has noticed for a 4,019 ms boot every waiting request pays for, so the
 * severity is `warn`: `initialRung('warn')` is `observe`, which schedules rather than
 * resets.
 */
export function memoryTrendRising(obs: Observation): Finding | null {
	// the monotonic case belongs to the check that already covers it
	if (memoryHighwaterRising(obs) !== null) return null;
	const samples = obs.memorySamples;
	const trend = fitTrend(samples);
	if (!trend || !trend.rising) return null;
	return {
		code: 'memory.trend_rising',
		severity: 'warn',
		scope: 'linear-memory',
		context:
			`trending up ~${Math.round(trend.rise)} bytes over ${samples?.length ?? 0} samples ` +
			`(${trend.slope.toFixed(1)}/request); recycle at the next quiet moment`
	};
}

/**
 * The ledger policing its own size.
 *
 * Listed as a tripwire rather than left to the GC pass because the failure it guards against is
 * the health layer becoming the thing that exhausts the budget it was built to watch.
 */
export function ledgerOversized(obs: Observation): Finding | null {
	const rows = obs.ledgerRows ?? 0;
	if (rows <= LEDGER_MAX_ROWS) return null;
	return {
		code: 'health.ledger_oversized',
		severity: 'warn',
		scope: 'cfw_health',
		context: `${rows} rows against a cap of ${LEDGER_MAX_ROWS}`
	};
}

/**
 * The image-transformation cap, projected from the site's own configuration.
 *
 * THE THIRD METER, and neither ceiling in the cost model can see it. Serving is bound by Worker
 * requests and regeneration by rows written; this one is bound by CONTENT -- 5,000 unique
 * transformations per MONTH on free, and it fails as a hard cap rather than as a bill. Ten image
 * styles over 2,000 images is 20,000, four times over, and images simply stop being transformed
 * partway through the month with nothing reporting it.
 *
 * Monthly, so unlike every other meter here it does NOT clear at midnight -- which is why it warns
 * on the projection rather than on a reading. By the time a count crossed the line the month would
 * already be spent, and the only remedies (drop a style, cut the image count) take effect next month.
 *
 * `warn` rather than `error` even when it is over: this quarantines nothing and repairs nothing,
 * because the fix is a configuration decision a human makes. It has to be SAID, not acted on.
 */
export function imageCapProjected(obs: Observation): Finding | null {
	const { imageTransforms: used, imageTransformsLimit: limit } = obs;
	if (used === undefined || !limit || limit <= 0) return null;
	const fraction = used / limit;
	if (fraction < BUDGET_WARN_FRACTION) return null;
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

/**
 * Runs every host tripwire over one observation.
 *
 * O(1) in the size of the database by construction: every input is either a scalar the caller
 * already had or a ring capped at `TREND_RING_SAMPLES`, so nothing here can become a full-table
 * scan on the request path.
 */
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

/** the repair ladder, lowest rung first */
export const LADDER = [
	'observe',
	'reset',
	'reconstruct',
	'reconfigure',
	'quarantine',
	'rollback'
] as const;

export type Rung = (typeof LADDER)[number];

/** what a finding's severity starts at on the ladder */
export function initialRung(severity: Severity): Rung {
	if (severity === 'critical') return 'quarantine';
	if (severity === 'error') return 'reset';
	if (severity === 'warn') return 'observe';
	return 'observe';
}

export interface BreakerState {
	/** failures seen inside the window, per code */
	hits: number[];
	rung: Rung;
	/** consecutive clean intervals, which is what decays the rung */
	clean: number;
}

/**
 * Circuit breaker with decay.
 *
 * Escalates one rung when the same code fires N times inside a window, and decays one rung after a
 * clean interval. **Never a fixed retry loop**: the alarm chain already learned that the hard way,
 * where a failing step that re-armed at +1 ms spun the object forever and starved every gated
 * request, and the fix was `min(30 s, 1 s x failures)`.
 */
export class CircuitBreaker {
	windowMs: number;
	threshold: number;
	states: Map<string, BreakerState>;

	constructor(windowMs = 60_000, threshold = 3) {
		this.windowMs = windowMs;
		this.threshold = threshold;
		this.states = new Map();
	}

	/** records a firing and returns the rung the repair should act at */
	record(code: string, severity: Severity, nowMs: number): Rung {
		const state = this.states.get(code) ?? {
			hits: [],
			rung: initialRung(severity),
			clean: 0
		};
		state.hits = state.hits.filter((t) => nowMs - t < this.windowMs);
		state.hits.push(nowMs);
		state.clean = 0;
		if (state.hits.length >= this.threshold) {
			state.rung = this.escalate(state.rung);
			// the window restarts, so N more failures are needed for the next rung
			state.hits = [];
		}
		this.states.set(code, state);
		return state.rung;
	}

	/** a clean interval decays every code one rung */
	decay(): void {
		for (const [code, state] of this.states) {
			state.clean++;
			const at = LADDER.indexOf(state.rung);
			if (at <= 0) {
				this.states.delete(code);
				continue;
			}
			const next = LADDER[at - 1];
			if (next) state.rung = next;
		}
	}

	rungOf(code: string): Rung | null {
		return this.states.get(code)?.rung ?? null;
	}

	private escalate(rung: Rung): Rung {
		const at = LADDER.indexOf(rung);
		const next = LADDER[Math.min(at + 1, LADDER.length - 1)];
		return next ?? rung;
	}
}

/**
 * Whether the object should stop serving rather than serve something wrong.
 *
 * **Quarantine beats wrong output.** A 503 with `Retry-After` is a better answer than a 0-byte
 * 200, and this project has shipped the 0-byte 200 -- and then cached it, and then served it from
 * the edge.
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

/** the ledger, in DO SQLite. One table, two writers -- this module and PHP */
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

export function ensureHealthTable(sql: HealthSql): void {
	for (const ddl of HEALTH_DDL) sql.exec(ddl);
}

/** context is truncated rather than trusted; an unbounded column is how a log table wins */
export const MAX_CONTEXT_BYTES = 400;

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

/**
 * Trims the ledger to its cap, newest kept.
 *
 * Counts and returns what it deleted so the caller can bill it against the rows-written budget
 * explicitly. A GC pass that does not report its own cost is how the watchdog table got to 46% of
 * the database while every figure looked fine.
 */
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
