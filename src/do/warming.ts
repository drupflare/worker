import {
	HIBERNATION_IDLE_MS,
	idleBounds,
	idleRearmMs,
	warmCeilingMs,
	warmForced,
	warmIntervalConfigured
} from '../ops/cron';
import { isPaid } from '../ops/plan';
import { resolvePlanNumber } from '../ops/plan-profile';
import { parseState } from '../ops/repair';
import {
	RATE_WINDOW_MS,
	WARM_INTERVAL_VERIFIED_MS,
	clampWarmInterval,
	foldRenderWindow,
	idleRearm,
	readRenderWindow,
	warmDecision,
	writeRenderWindow,
	type RenderWindow
} from '../ops/thermal';
import type { WarmingHost } from './host';
import { retainInterpreterEnabled } from './isolate';
import { RENDER_WINDOW_KEY } from './keys';
import { updbActive } from './reconcile';

/**
 * Wall-clock budget a miss may spend rendering before the path goes to the alarm chain.
 *
 * 2 s covers the measured first-render range (195 to 1,636 ms) and excludes the 3,754 ms cold
 * boot; it bounds the visitor's patience, not a billed resource. `budget` on the query string
 * overrides (0 disables inline rendering). A cold object refuses on `!this.php` before this is
 * consulted.
 */
export function inlineBudgetMs(site: WarmingHost, url: URL): number {
	const explicit = url.searchParams.get('budget');
	const n = Number(explicit);
	if (explicit !== null && explicit !== '' && Number.isFinite(n) && n >= 0) return n;
	return resolvePlanNumber(site.env?.RENDER_BUDGET_MS, 'inlineBudgetMs', 60_000, site.env);
}

/**
 * What the next render on this instance is expected to cost, in ms.
 *
 * A prediction, because `php._run()` is one synchronous wasm call that no timer or
 * `AbortSignal` can preempt. The last render is the best predictor; pessimistic with no
 * evidence (a cold instance is the common case and must not gamble on a multi-second boot).
 */
export function estimateRenderMs(site: WarmingHost): number {
	if (!site.php) return 4000;
	// first render pays one-off opcache and container work (195 to 1,636 ms); on the edge
	// every post-boot render lands here (no clock across sync work), so 1800 = unknown
	if (site.lastRenderMs === undefined) return 1800;
	return site.lastRenderMs;
}

/**
 * The idle re-arm this site's own traffic justifies.
 *
 * Falls back to the configured interval when the predictor has nothing to say. The warm branch
 * is solved (climbing toward the ceiling on windows the object survived); an explicit
 * `WARM_INTERVAL_MS` wins.
 */
export function thermalRearmMs(site: WarmingHost, queued = false): number {
	const headroom = site.degradation().cron;
	const configured = idleRearmMs(site.env, headroom, isPaid(site.env), site.nowMs());
	if (!headroom) return noteRearm(site, configured, 'degraded');
	const forced = warmForced(site.env, isPaid(site.env), site.nowMs());
	const stored = storedRenderWindow(site);
	const decision = warmDecision(site.arrivals ?? [], site.nowMs(), {
		thresholdMs: HIBERNATION_IDLE_MS,
		forced,
		lastAuthenticatedAt: site.lastAuthenticatedAt,
		stored
	});
	site.lastWarmDecision = decision;
	if (!decision.warm) {
		const { floorMs, ceilingMs } = idleBounds(site.env);
		const idleFor = idleForMs(site, stored);
		// reads are skipped while the re-arm is fixed, so the default path costs nothing new
		const floored = ceilingMs > floorMs ? idleFloorReason(site, queued) : undefined;
		const next = idleRearm(idleFor, floorMs, ceilingMs, floored);
		site.lastRearm = { ms: next.ms, reason: next.reason, idleForMs: idleFor ?? null };
		return next.ms;
	}
	return noteRearm(
		site,
		warmIntervalConfigured(site.env) ??
			clampWarmInterval(stored?.intervalMs ?? WARM_INTERVAL_VERIFIED_MS, warmCeiling(site)),
		'warm'
	);
}

/** records the re-arm in force for `/serve-stats` and returns it */
function noteRearm(site: WarmingHost, ms: number, reason: string): number {
	site.lastRearm = { ms, reason, idleForMs: null };
	return ms;
}

/**
 * Ms since this site last rendered, or undefined when nothing says.
 *
 * The in-memory stamp is exact for this incarnation. Past a hibernation the stored window's
 * stamp is at most one window old, so a window is taken off it and the fade starts late rather
 * than early; a window with no stamp reads as its start.
 */
function idleForMs(site: WarmingHost, stored: RenderWindow | undefined): number | undefined {
	const now = site.nowMs();
	if (site.lastRenderAtMs !== undefined) return Math.max(0, now - site.lastRenderAtMs);
	if (stored === undefined || stored.renders <= 0) return undefined;
	return Math.max(0, now - (stored.lastAt ?? stored.startedAt) - RATE_WINDOW_MS);
}

/**
 * Work that holds the idle re-arm at the floor: a queue (fill, mail or HTTP), an active pool, a
 * migration, a stepped job or update run, or a site mid-repair. Claim steps run as migration and
 * reconcile firings, so they hold it through the migration cursor.
 */
function idleFloorReason(site: WarmingHost, queued: boolean): string | undefined {
	if (queued) return 'queue';
	if (site.isPoolLane() || site.lanesProvisioned() > 0) return 'lanes';
	if (site.migratePartial() !== undefined) return 'migration';
	if (site.opsJobActive() || updbActive(site)) return 'job';
	if (parseState(site.metaGet('repair_state')).rung !== 'observe') return 'repair';
	return undefined;
}

/** the render window as it survived the last hibernation, or undefined if none is stored */
export function storedRenderWindow(site: WarmingHost): RenderWindow | undefined {
	return readRenderWindow(site.metaGet(RENDER_WINDOW_KEY), warmCeiling(site));
}

/** the ceiling the warm solver may climb to; 9,500 unless `WARM_CEILING_MS` raises it */
export function warmCeiling(site: WarmingHost): number {
	return warmCeilingMs(site.env, retainInterpreterEnabled(site.env));
}

/**
 * Folds pending renders into the persisted window, at most once per 15-minute window (96
 * rows/day against 1,440 at the 60 s meter interval; the rate only separates ~505 renders/day
 * from ~8,640).
 *
 * The roll is also where the warm interval is solved: `lastRenderWindowFlushMs` is in memory,
 * so it is set only if this incarnation did the previous roll.
 */
export function flushRenderWindow(
	site: WarmingHost,
	nowMs = site.nowMs()
): RenderWindow | undefined {
	const pending = site.rendersSinceFlush ?? 0;
	const stored = storedRenderWindow(site);
	if (pending === 0) return stored;
	// held until the bucket rolls, so a busy site pays once per window, not once per flush
	if (stored && nowMs - stored.startedAt < RATE_WINDOW_MS) {
		const held = site.lastRenderWindowFlushMs ?? 0;
		if (nowMs - held < RATE_WINDOW_MS) return stored;
	}
	const survived = incarnationSpanned(site, stored, nowMs);
	const colds = site.coldsSinceFlush ?? 0;
	site.rendersSinceFlush = 0;
	site.coldsSinceFlush = 0;
	site.lastRenderWindowFlushMs = nowMs;
	// an older build reads only five fields, so the stamp is written only while the fade needs it
	const { floorMs, ceilingMs } = idleBounds(site.env);
	const fade = ceilingMs > floorMs;
	const folded = foldRenderWindow(
		stored,
		pending,
		nowMs,
		RATE_WINDOW_MS,
		survived,
		colds,
		warmCeiling(site),
		fade ? site.lastRenderAtMs : undefined
	);
	if (!fade) delete folded.lastAt;
	site.metaSet(RENDER_WINDOW_KEY, writeRenderWindow(folded));
	return folded;
}

/**
 * Whether one incarnation covered the window that is closing.
 *
 * `lastRenderWindowFlushMs` must be set (this incarnation opened a window) and no later than
 * the window's start (it is that window, not one inherited after a re-creation).
 */
function incarnationSpanned(
	site: WarmingHost,
	stored: RenderWindow | undefined,
	nowMs: number
): boolean {
	if (!stored) return false;
	const opened = site.lastRenderWindowFlushMs;
	if (opened === undefined) return false;
	return opened <= stored.startedAt && nowMs - stored.startedAt >= RATE_WINDOW_MS;
}
