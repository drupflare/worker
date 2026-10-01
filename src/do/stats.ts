import { storedBytes } from '../db/file-store';
import { attributeSpend } from '../ops/cost-attribution';
import { deploymentEnv } from '../ops/deployment-env';
import { chunkStack, flatFields, isLengthError, type RangeReport } from '../ops/error-probe';
import { resolveMailTransport } from '../ops/mail';
import { kvWriteBudget, pageKvEnabled } from '../ops/page-store';
import { hitAnyLimit } from '../ops/platform-limits';
import { type DemandWindow, meanWaitMs } from '../ops/replica-demand';
import { replicaOf } from '../ops/replica-routing';
import type { SitePhpDurableObject } from '../site-do';
import { errorMessage } from '../util/errors';
import { laneTimingSummary } from './helpers';
import { isolateAboveBytes, shimGlobals, spareMemoryBytes } from './isolate';
import { DEMAND_WINDOWS_KEY } from './keys';
import { lazyMountBytes, PACK_INDEX_BYTES } from './lazy-mount';
import { LANE_TIMING_RING, RECENT_ERROR_STACK_CHARS, RECENT_ERRORS_MAX } from './limits';
import { updbActive } from './reconcile';
import type { ErrorNote, Payload } from './types';

/**
 * Everything `/serve-stats` reports that is readable without an await, so the synchronous
 * `cfwServeStats` capability can have it; the route adds the stored cron timestamp and pending
 * alarm back (both come from `ctx.storage`, which returns a Promise).
 */
export function serveStatsSync(site: SitePhpDurableObject): Payload {
	site.ensureServeTables();
	return {
		// stored pages that could serve as a shared shell with regions filled at the edge
		shellCandidates: site.shellCandidates(),
		// PHP-to-host crossings for the last render (unbilled today; an RPC call would bill as a DO
		// request); `crossingCapabilities` separates "never called" from "never installed"
		crossings: site.lastRenderCrossings ?? null,
		crossingsTotal: site.crossings?.total ?? 0,
		crossingCapabilities: site.crossingNames ?? [],
		// `absent` (cannot park) differs from `installed` with an empty trap list
		park: site.parkInstall ?? { state: 'absent', armed: [] },
		// whether anything has asked; the probe runs PHP, so a stats read must not force a boot
		parkProbed: site.parkInstall !== undefined,
		// `refused` separates "nothing needed the park" from "asked and could not answer"
		lastPark: site.lastPark ?? null,
		// cumulative: the meter is 1 ms granular, so amortise over a difference of two reads
		parkTotals: site.parkTotals ?? { runs: 0, trips: 0, refused: 0 },
		parkSockets: site.parkSockets?.size ?? 0,
		cached: site.sql
			.exec(
				'SELECT path, status, length(html) AS bytes, render_ms, rendered_at FROM cfw_page ORDER BY path'
			)
			.toArray(),
		queue: site.sql
			.exec(
				'SELECT path, attempts, last_error, priority FROM cfw_fill_queue ORDER BY priority, queued_at'
			)
			.toArray(),
		alarmFirings: site.alarmFirings ?? 0,
		lastAlarmAt: site.lastAlarmAt ?? null,
		// an object recycling on every request pays a boot per page; a fresh site takes one drop
		recycles: site.recycles ?? 0,
		lastRecycle: site.lastRecycle ?? null,
		// boots that instantiated into the memory a drop left, rather than beside it
		heapsReused: site.heapsReused ?? 0,
		lastReuse: site.lastReuse ?? null,
		spareMemoryBytes: spareMemoryBytes(),
		lastOpsJob: site.lastOpsJob ?? null,
		rangeErrors: site.rangeErrors,
		recentErrors: site.recentErrors,
		demand: site.demandLog,
		demandByPath: site.demandByPath,
		growth: (globalThis as { __cfwGrow?: unknown[] }).__cfwGrow ?? [],
		decodeFailures: (globalThis as { __cfwSub?: unknown[] }).__cfwSub ?? [],
		// names only; a value is a secret
		deploymentEnv: (() => {
			const d = deploymentEnv(site.env);
			return {
				vars: Object.keys(d.vars),
				config: d.config !== null,
				problems: d.problems
			};
		})(),
		laneRowsCap: site.laneRowsCap ?? null,
		// conditional writes saved this incarnation (one read spent per charged row avoided)
		elidedWrites: site.elidedWrites ?? 0,
		// a size drop is routine, a trap drop is a defect; non-zero means the interpreter faulted
		trappedRuns: site.trappedRuns ?? 0,
		lastTrap: site.lastTrap ?? null,
		// the whole isolate: the 128 MiB ceiling covers the JS side as well as linear memory
		isolateBytes: {
			linear: site.heapNow(),
			mount: lazyMountBytes(site.mountInfo).blob,
			// the merged index, measured by retention not file size; see PACK_INDEX_BYTES
			index: lazyMountBytes(site.mountInfo).blob > 0 ? PACK_INDEX_BYTES : 0,
			resident: lazyMountBytes(site.mountInfo).resident,
			total: site.isolateNow(),
			ceiling: 134_217_728,
			dropAbove: isolateAboveBytes(site.env)
		},
		// what a replica pool is sized from; `ahead` is the real signal, durations are floors
		lane: laneTimingSummary(site.laneTimings ?? []),
		// what a lane would remove
		laneMeanWaitMs:
			meanWaitMs(JSON.parse(site.metaGet(DEMAND_WINDOWS_KEY) || '[]') as DemandWindow[]) ??
			null,
		// whether a platform ceiling appears in the request path; an empty tally is the answer
		limits: { tally: site.limitTally, hitAny: hitAnyLimit(site.limitTally) },
		// what this object refused as a replica: which work a replica cannot take
		replica: {
			role: site.isReplica() ? 'replica' : 'primary',
			lane: replicaOf(site.ctx.id.name ?? '')?.lane ?? 0,
			stage: site.replicaStage(),
			guarded: site.replicaGuard ? Object.keys(site.replicaGuard.wrapped).length : 0,
			// the total, not the bounded retained window
			refusals: site.replicaRefusalsTotal,
			lastRefusal: site.replicaRefusals.at(-1)?.message ?? null,
			// a lane stuck before serving refuses everything while the primary quietly answers
			lastCatchUp: site.lastCatchUp ?? null,
			// `tried` climbing without `found` means replication is behind, not stale cookies
			sessionCatchUps: site.sessionCatchUps ?? { tried: 0, found: 0 },
			lastWithdrawal: site.lastWithdrawal ?? null
		},
		// quota accounting; guarded like `spend.storage` below (a read must not run DDL)
		storage: site.hasTable('cfw_file') ? storedBytes(site.sql) : { files: 0, bytes: 0 },
		// per-site rollup over those meters; a dimension with no counter reports null and a reason
		spend: attributeSpend(
			{
				rowsToday: site.dailyRows(),
				doRequestsToday: site.dailyDoRequests(),
				...(() => {
					const today = site.activityToday();
					return {
						rendersToday: today.renders,
						alarmsToday: today.alarms,
						fetchesToday: today.fetches
					};
				})(),
				// guarded: `storedBytes()` runs DDL and a status GET reaches it
				storage: site.hasTable('cfw_file') ? storedBytes(site.sql).bytes : null,
				imageStyles: site.countOrNull('config', "name LIKE 'image.style.%'"),
				managedImages: site.countOrNull('file_managed', "filemime LIKE 'image/%'")
			},
			site.env as never
		),
		// what a content save cost; `scoped: false` is the wholesale fallback, not a failure
		lastScopedPurge: site.lastScopedPurge ?? null,
		lastAggregation: site.lastAggregation ?? null,
		warmDecision: site.lastWarmDecision ?? null,
		// a re-driven render costs one extra drain plus one extra render
		lastRedrive: site.lastRedrive ?? null,
		lastPendingDrain: site.lastPendingDrain ?? null,
		// GC and page fills spend the same meter
		lastGc: site.lastGc ?? null,
		lastGcAt: site.lastGcAt ?? null,
		lastSweep: site.lastSweep ?? null,
		lastSweepAt: site.lastSweepAt ?? null,
		// the only place a failed inventory write shows; `GET /fleet` reads "no sites" either way
		lastFleetError: site.lastFleetError ?? null,
		coldEncounters: site.coldEncounterRate(),
		// the only place an Asyncify-boundary failure shows (no PHP fatal, printErr or Drupal log)
		asyncifyCalls: shimGlobals.__cfwAsyncifyCalls ?? 0,
		// `rowsWritten` counts only `execSql()` (Drupal's statements); `rowsToday` comes from
		// `countingSql()` over the storage handle and is complete, so use it for quota decisions
		rowsWritten: site.rowsWritten ?? 0,
		rowsToday: site.dailyRows(),
		// invocations that reached this object; an edge-cache hit never enters the isolate
		doRequestsToday: site.dailyDoRequests(),
		// the image cap follows content (a transformation per style per image); null when absent
		imageStyles: site.countOrNull('config', "name LIKE 'image.style.%'"),
		managedImages: site.countOrNull('file_managed', "filemime LIKE 'image/%'"),
		// null, not 0, when the table does not exist
		semaphoreHeld: site.countOrNull('semaphore'),
		// the deferred outbound-HTTP queue; null before the tables exist
		httpQueue: site.countOrNull('cfw_http_queue'),
		lastHttpDrain: site.lastHttpDrain?.value ?? null,
		lastHttpDrainAt: site.lastHttpDrain?.at ?? null,
		// a send that failed at the relay is only visible here (`cfwMail` had already returned)
		mailQueue: site.countOrNull('cfw_mail_queue'),
		// the relay a send resolves to, or null; tells a broken transport from none
		mailTransport: (() => {
			const plan = resolveMailTransport(site.mailEnv());
			return 'refusal' in plan ? null : plan.transport.kind;
		})(),
		lastMailDrain: site.lastMailDrain?.value ?? null,
		lastMailDrainAt: site.lastMailDrain?.at ?? null,
		// each alarm unit catches its own error, so these are the only trace of a failing poll
		lastGitPoll: site.lastGitPoll?.value ?? null,
		lastGitPollAt: site.lastGitPoll?.at ?? null,
		lastMirrorDrain: site.lastMirrorDrain?.value ?? null,
		lastMirrorDrainAt: site.lastMirrorDrain?.at ?? null,
		lastPageMirrorDrain: site.lastPageMirrorDrain?.value ?? null,
		lastPageMirrorDrainAt: site.lastPageMirrorDrain?.at ?? null,
		r2: site.mirrorBucket() ? site.r2Allowance() : null,
		// what the primary answered to this lane's last forwarded batch
		lastForward: site.lastForward ?? null,
		lastDerive: site.lastDerive ?? null,
		// Infinity is not JSON; an unbounded budget reads null
		pageKv: pageKvEnabled(site.env as never)
			? {
					writesToday: site.dailyKvWrites(),
					budget: Number.isFinite(kvWriteBudget(site.env))
						? kvWriteBudget(site.env)
						: null
				}
			: null,
		// null on a site that never ran an update; a live run holds the alarm chain
		updb: site.lastUpdb?.value ?? null,
		updbActive: updbActive(site),
		// null when migration never started, distinct from finished
		migrate: site.migrateCursorOrNull(),
		lastAlarmOutcome: site.lastAlarmOutcome ?? null,
		phpBooted: !!site.php,
		// whether `/sql` and `/php` are open, so a test can assert the gate both ways
		diagnostics:
			(site.env as unknown as Record<string, string | undefined>).PW_DIAGNOSTICS === '1',
		// which lane answered
		storageLaneServes: site.storageLaneServes ?? 0,
		phpLaneEntries: site.phpLaneEntries ?? 0,
		gate: site.gate.stats(),
		generation: site.generation(),
		bumps: site.bumps ?? 0,
		lastBump: site.metaGet('last_bump'),
		// persisted so eviction cannot reset it; edge-tier specs assert it did not move
		serveRequests: site.serveRequests(),
		// the serving worker version (the rollback unit), from the `CF_VERSION_METADATA` binding
		workerVersion: site.workerVersion()
	};
}

/**
 * Records the queue/service split for one gated request and stamps it on the response.
 *
 * `ahead` is a count taken at arrival (no clock), the quantity a replica pool reduces. The two
 * durations are floors: the clock only advances during I/O, so a synchronous `php._run()` adds zero
 * to a `Date.now()` delta (a cold fill read 117 ms for 1,398 ms of `cpuTime`). Quote them as lower
 * bounds; absolutes come from the client's clock and `cpuTime`.
 */
export function noteLaneTiming(
	site: SitePhpDurableObject,
	response: Response,
	ahead: number,
	arrivedAt: number,
	enteredAt: number
): Response {
	const queueMs = Math.max(0, enteredAt - arrivedAt);
	const serviceMs = Math.max(0, site.nowMs() - enteredAt);
	site.laneTimings = site.laneTimings ?? [];
	site.laneTimings.push({ ahead, queueMs, serviceMs });
	if (site.laneTimings.length > LANE_TIMING_RING) site.laneTimings.shift();
	// a new Response: one from `handle()` may carry immutable headers
	const headers = new Headers(response.headers);
	headers.set('x-cfw-gate-ahead', String(ahead));
	headers.set('x-cfw-queue-ms-floor', String(queueMs));
	headers.set('x-cfw-service-ms-floor', String(serviceMs));
	// how the router learns lanes exist: autoscaling writes `lanes_provisioned` into this object's
	// meta, and the front worker reads only `REPLICA_COUNT` from env
	for (const [k, v] of Object.entries(site.laneHeaders())) headers.set(k, v);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

/** appends to the capped demand log and the per-path high-water table */
function recordDemand(
	site: SitePhpDurableObject,
	entry: Omit<SitePhpDurableObject['demandLog'][number], 'renderBytes'>
): void {
	const { path, after } = entry;
	site.demandLog.push({ ...entry, renderBytes: site.lastRenderBytes });
	if (site.demandLog.length > 60) site.demandLog.shift();
	if (path in site.demandByPath || Object.keys(site.demandByPath).length < 40) {
		site.demandByPath[path] = Math.max(site.demandByPath[path] ?? 0, after);
	}
}

/**
 * Records what one request did to the heap, so the page that drives linear memory up can be named.
 * `before` is 0 with no resident interpreter; the per-path table is capped so a scanner cannot
 * grow it.
 */
export function noteDemand(
	site: SitePhpDurableObject,
	request: Request,
	before: number,
	reusedBefore: number
): void {
	const after = site.heapNow();
	if (after === 0) return;
	const u = new URL(request.url);
	const path = (u.searchParams.get('path') ?? u.pathname).split('?')[0] as string;
	const reused = (site.heapsReused ?? 0) > reusedBefore;
	const bridge = site.crossings?.bytes ? { ...site.crossings.bytes } : undefined;
	recordDemand(site, { path, method: request.method, before, after, reused, bridge });
	if (after > before) {
		console.info('cfw-demand', {
			path,
			method: request.method,
			before,
			after,
			reused,
			...bridge
		});
	}
}

/** what an alarm firing did to linear memory, named by the lane it ran; see {@link noteDemand} */
export function noteAlarmDemand(
	site: SitePhpDurableObject,
	outcome: unknown,
	before: number
): void {
	const after = site.heapNow();
	if (after === 0) return;
	const lane =
		outcome !== null && typeof outcome === 'object'
			? Object.keys(outcome as object)
					.slice(0, 3)
					.join(',')
			: String(outcome);
	const path = `(alarm ${lane})`;
	const bridge = site.crossings?.bytes ? { ...site.crossings.bytes } : undefined;
	recordDemand(site, { path, method: 'ALARM', before, after, reused: false, bridge });
	if (after > before) {
		console.info('cfw-demand', { path, method: 'ALARM', before, after, ...bridge });
	}
}

/**
 * Records a RangeError with its stack and memory state, then lets the caller rethrow (the event
 * log carries the message but no stack).
 */
export function noteRangeError(
	site: SitePhpDurableObject,
	e: unknown,
	where: string,
	request?: Request
): void {
	if (!isLengthError(e)) return;
	let path: string | null = null;
	if (request) {
		const u = new URL(request.url);
		path = u.searchParams.get('path') ?? u.pathname;
	}
	const report: RangeReport = {
		at: Date.now(),
		where,
		method: request?.method ?? null,
		path,
		message: errorMessage(e),
		stack: chunkStack(String((e as Error)?.stack ?? '')),
		linear: site.heapNow(),
		isolate: site.isolateNow(),
		reused: site.heapsReused ?? 0,
		bootMs: site.bootMs ?? null,
		grow: (globalThis as { __cfwGrow?: unknown[] }).__cfwGrow ?? [],
		sub: (globalThis as { __cfwSub?: unknown[] }).__cfwSub ?? []
	};
	site.rangeErrors.push(report);
	if (site.rangeErrors.length > 5) site.rangeErrors.shift();
	console.error('cfw-range-error', flatFields(report));
}

/** records a fault a catch absorbed, so an operator can read it off `/serve-stats` */
export function noteError(site: SitePhpDurableObject, where: string, e: unknown): void {
	const note: ErrorNote = { at: Date.now(), where, message: errorMessage(e) };
	const stack = (e as { stack?: unknown } | null | undefined)?.stack;
	if (typeof stack === 'string') note.stack = stack.slice(0, RECENT_ERROR_STACK_CHARS);
	site.recentErrors.push(note);
	if (site.recentErrors.length > RECENT_ERRORS_MAX) site.recentErrors.shift();
	console.error('cfw-error', { where, message: note.message });
}
