import { dropAllSnapshots, ensureHeapTables } from '../db/heap-store';
import { cronHookList } from '../drupal/cron-php';
import {
	CORE_VERSION_KEY,
	invalidateVersionPinnedCaches,
	type InvalidationResult
} from '../ops/core-version';
import { type CronHookCache, cronHooksFor, cronHooksFromList } from '../ops/cron';
import { dailyLimit } from '../ops/degrade';
import { pruneHeapRecords } from '../ops/heap-integrity';
import {
	extensionFingerprint,
	PACKED_CONTAINER_PATH,
	type PackedContainer
} from '../ops/packed-container';
import {
	DRIVER_DIGEST_KEY,
	PACK_VERSION,
	parseReconcileState,
	planReconcile,
	reconciled,
	type ReconcileHost,
	reconcileReport,
	type ReconcileState,
	recordStep,
	recurringWork,
	serialiseReconcileState
} from '../ops/reconcile';
import { FIRST_RUN_KEY } from '../ops/setup-page';
import { SHIPPED_CORE_VERSION } from '../ops/shipped-lock';
import {
	readSweepCursor,
	sweepDue,
	sweepEnabled,
	type SweepEnv,
	type SweepReport,
	sweepRowsFraction,
	sweepStep
} from '../ops/sweep';
import {
	ensureUpdbTables,
	readRun as readUpdbRun,
	updbAbandon,
	updbDrain,
	updbOptions,
	type UpdbOptions,
	updbPrepare,
	updbRollback
} from '../ops/updb';
import type { SitePhpDurableObject } from '../site-do';
import { cmsOf } from '../util/cms';
import { errorMessage, isMissingTable } from '../util/errors';
import { columnText, firstRow } from '../util/sql';
import type { ReconcileStateHost } from './host';
import { CRON_HOOKS_KEY, HEAP_IMAGE_KEY, RECONCILE_KEY } from './keys';
import { fillBatchSize } from './levers';
import { refusesReconcile } from './role';
import { phasesFor } from './tree-boot';
import type { Payload } from './types';

/**
 * One reconciliation step per firing, or null when this site is already at the shipping version.
 *
 * Null is the steady state: one `cfw_meta` read and an integer comparison. A step that ran always
 * drops the interpreter and heap image, since a restored kernel predates what the step changed.
 */
export async function reconcileStepOnce(site: SitePhpDurableObject): Promise<Payload | undefined> {
	if (String(site.env?.RECONCILE ?? '1') === '0') return undefined;
	// the steps run Drupal PHP, so another CMS's tree never reaches them
	if (!phasesFor(cmsOf(site.env)).reconcile) return undefined;
	// a lane serves a copy of the primary's database; reconciling it separately would write
	// authoritative rows from two places at once
	if (refusesReconcile(site)) return undefined;
	let state = site.reconcileState();
	const host = site.reconcileHost();
	// the version gate cannot retire the recurring work (`recurringWork()`)
	if (
		reconciled(state, site.metaGet(DRIVER_DIGEST_KEY)) &&
		!recurringWork(state, site.sql, host)
	) {
		return undefined;
	}
	await site.loadPackedContainer();
	// drain marks (site already matches) in a loop; a `run` gets its own firing
	const satisfied: string[] = [];
	for (;;) {
		const planned = planReconcile(state, site.sql, host);
		if (planned.action === 'mark') {
			state = recordStep(state, planned.step, { state: 'satisfied' });
			satisfied.push(planned.step.id);
			continue;
		}
		if (planned.action === 'done') {
			state = { ...state, version: planned.version };
			site.metaSet(RECONCILE_KEY, serialiseReconcileState(state));
			return { reconcile: { done: true, version: planned.version, satisfied } };
		}
		if (planned.action === 'wait') {
			// a deferred step must not own the chain (`bake-clock` may wait forever)
			if (satisfied.length > 0) site.metaSet(RECONCILE_KEY, serialiseReconcileState(state));
			site.lastReconcile = {
				reconcile: {
					waiting: planned.step.id,
					reason: planned.reason,
					version: state.version,
					satisfied
				}
			};
			return undefined;
		}
		// the same young-interpreter hold as the fill batch: a step runs PHP beside a visitor
		const hold = site.backgroundHold();
		if (hold !== undefined) {
			if (satisfied.length > 0) site.metaSet(RECONCILE_KEY, serialiseReconcileState(state));
			return { reconcile: { held: hold, step: planned.step.id, satisfied } };
		}
		return await site.applyReconcileStep(state, planned.step, planned.detail, host, satisfied);
	}
}

/**
 * Drops every heap snapshot and the image key. The generation does not move on a config write, so
 * a restore would otherwise bring back the kernel the write replaces. Returns the snapshots dropped.
 */
export function dropHeapImages(site: SitePhpDurableObject): number {
	ensureHeapTables(site.sql);
	const dropped = dropAllSnapshots(site.sql);
	pruneHeapRecords(site.secretStore().sealed, site.sql);
	site.sql.exec('DELETE FROM cfw_meta WHERE k = ?', HEAP_IMAGE_KEY);
	return dropped;
}

/** the expensive half: one step's apply, its end-state check, and the image drop that follows */
export async function applyReconcileStep(
	site: SitePhpDurableObject,
	before: ReconcileState,
	step: Parameters<typeof recordStep>[1],
	owed: string,
	host: ReconcileHost,
	satisfied: string[]
): Promise<Payload> {
	let state = before;
	const applied: Payload = { id: step.id, owed, satisfied };
	try {
		if (step.sql) step.sql(site.sql, host);
		const code = step.php?.(host);
		if (code !== undefined) applied.php = await site.runJson(code);
	} catch (e) {
		applied.error = errorMessage(e);
	}
	// the success condition is the end state, not that the step ran
	const after = step.verdict(site.sql, host);
	state = recordStep(state, step, after);
	site.metaSet(RECONCILE_KEY, serialiseReconcileState(state));
	if (step.freshKernel) site.dropInterpreter();
	const dropped = dropHeapImages(site);
	return {
		reconcile: {
			...applied,
			after: after.state,
			version: state.version,
			droppedImages: dropped
		}
	};
}

/**
 * The enabled-module set (from `core.extension`) as one short value. An empty string means it
 * could not be read, which {@link cronHooksForSite} treats as "do not re-discover".
 */
export function enabledModulesFingerprint(site: SitePhpDurableObject): string {
	try {
		const row = firstRow(
			site.sql.exec(
				'SELECT data FROM config WHERE collection = ? AND name = ?',
				'',
				'core.extension'
			)
		) as { data?: unknown } | undefined;
		const data = row?.data;
		const text = columnText(data);
		return extensionFingerprint(text);
	} catch (e) {
		if (!isMissingTable(e)) site.noteError('enabledModulesFingerprint', e);
		return '';
	}
}

/**
 * The cron hooks this site implements, discovered by booting the kernel (so that firing schedules
 * nothing else); `KNOWN_CRON_HOOKS` is only the fallback list measured on the shipped install.
 */
export async function cronHooksForSite(
	site: SitePhpDurableObject
): Promise<{ hooks: string[]; discovered: boolean }> {
	const fingerprint = site.enabledModulesFingerprint();
	let cache: CronHookCache | undefined;
	try {
		cache =
			(JSON.parse(site.metaGet(CRON_HOOKS_KEY) || 'null') as CronHookCache | null) ??
			undefined;
	} catch {
		cache = undefined;
	}
	const chosen = cronHooksFor(cache, fingerprint);
	// an unreadable `core.extension` must not re-boot the kernel on every firing
	if (!chosen.stale || fingerprint === '') return { hooks: chosen.hooks, discovered: false };
	try {
		const payload = await site.runJson(cronHookList(site.canonicalOrigin()));
		const found = cronHooksFromList(payload);
		if (found !== undefined) {
			site.metaSet(CRON_HOOKS_KEY, JSON.stringify({ at: fingerprint, hooks: found }));
			return { hooks: found, discovered: true };
		}
	} catch {
		// best effort; the list already in hand still schedules
	}
	return { hooks: chosen.hooks, discovered: true };
}

/**
 * One addressable-sweep step: pure SQL, so it acquires no gate and boots no interpreter.
 *
 * The sweep queues paths and never renders one: a `fillBatchSize` of 25 reset fresh sites by
 * crossing 128 MiB in one invocation, and the existing fill batch drains under its `oversized()`
 * break.
 */
export function sweepBeat(site: SitePhpDurableObject, { force = false } = {}): boolean {
	const env = site.env as SweepEnv | undefined;
	if (!sweepEnabled(env)) return false;
	const nowMs = site.nowMs();
	// its own interval, like cron (an enumeration is six table reads and a warm object fires every
	// 8 s); `force` is the operator path
	if (!force && !sweepDue(readSweepCursor(site.sql, nowMs, site.generation()), nowMs)) {
		return false;
	}
	try {
		site.lastSweep = sweepStep({
			sql: site.sql,
			meters: {
				rowsToday: site.dailyRows(nowMs),
				rowsLimit: dailyLimit('rows-written', site.env),
				doToday: site.dailyDoRequests(nowMs),
				doLimit: dailyLimit('do-requests', site.env)
			},
			hits: site.pageHits,
			isUnstorable: (p) => site.isUnstorable(p),
			batch: fillBatchSize(site.env),
			generation: site.generation(),
			nowMs,
			rowsFraction: sweepRowsFraction(env)
		});
		if ((site.lastSweep as SweepReport).queued > 0) site.lastSweepAt = Date.now();
	} catch (e) {
		// a sweep failure must never take down the alarm that serves the site
		site.lastSweep = { error: errorMessage(e) };
	}
	return true;
}

/**
 * Whether a database-update run is in progress and owes the alarm chain work (one indexed read).
 */
export function updbActive(site: Pick<SitePhpDurableObject, 'hasTable' | 'sql'>): boolean {
	try {
		// no DDL on a read: the status report reaches this, and an absent table means no run
		if (!site.hasTable('cfw_updb_run')) return false;
		ensureUpdbTables(site.sql);
		const run = readUpdbRun(site.sql);
		if (!run) return false;
		// an allowlist of live phases (`phase`, not `state`): a new upstream phase defaults to
		// inactive instead of wedging the chain
		return run.phase === 'planning' || run.phase === 'running';
	} catch {
		// absent tables mean no run was ever started
		return false;
	}
}

/**
 * The four lifecycle calls a beat cannot make: start a run, drain several, and the two decisions
 * only a human may take on a halted one. `reason` is required by `updbAbandon()` and not
 * defaulted here, since a default would forge a human's decision.
 */
export async function updbAction(
	site: SitePhpDurableObject,
	action: string,
	params: URLSearchParams
): Promise<Payload> {
	const deps = site.updbDeps();
	const base = updbOptions(site.env);
	const reason = params.get('reason');
	const exportKey = params.get('exportKey');
	const asked = Number(params.get('maxBeats') ?? '');
	const options: UpdbOptions = {
		...base,
		...(reason !== null ? { reason } : {}),
		...(exportKey !== null ? { exportKey } : {}),
		...(Number.isFinite(asked) && asked > 0 ? { maxBeats: Math.floor(asked) } : {}),
		...(params.get('requireExport') === '1' ? { requireExport: true } : {})
	};
	switch (action) {
		case 'prepare':
			return updbPrepare(deps, options) as Payload;
		case 'rollback':
			return updbRollback(deps, options) as Payload;
		case 'abandon':
			return updbAbandon(deps, options) as Payload;
		case 'drain':
			return (await updbDrain(deps, options)) as unknown as Payload;
		default:
			return { ok: false, reason: 'unknown-action', action };
	}
}

/** what a reconciliation step may ask this object beyond plain SQL */
export function reconcileHost(host: ReconcileStateHost): ReconcileHost {
	return {
		claimedAtMs: () => {
			const raw = host.metaGet(FIRST_RUN_KEY);
			const at = raw === null ? NaN : Number(raw);
			return Number.isFinite(at) && at > 0 ? at : undefined;
		},
		meta: (key: string) => host.metaGet(key),
		setMeta: (key: string, value: string) => host.metaSet(key, value),
		origin: () => host.canonicalOrigin(),
		packedContainer: () => host.packedContainer,
		modules: () => host.enabledModulesFingerprint()
	};
}

/** loads the pack's container row from `ASSETS` once */
export async function loadPackedContainer(host: ReconcileStateHost): Promise<void> {
	if (host.packedContainer) return;
	try {
		const res = await host.env.ASSETS.fetch(
			new URL(`https://a.local/${PACKED_CONTAINER_PATH}`)
		);
		if (res.ok) host.packedContainer = await res.json<PackedContainer>();
	} catch {
		// absent means the step rebuilds, as it always did
	}
}

/** the stored reconciliation state */
export function reconcileState(host: ReconcileStateHost): ReconcileState {
	return parseReconcileState(host.metaGet(RECONCILE_KEY));
}

/** the reconciliation report for this site */
export function reconcileStatus(host: ReconcileStateHost): ReturnType<typeof reconcileReport> {
	return reconcileReport(host.reconcileState(), host.sql, host.reconcileHost());
}

/**
 * Why `reconcileStepOnce()` answered undefined, so a POST that did nothing is not mistaken for
 * a silent failure.
 */
export function reconcileSkipReason(host: ReconcileStateHost): string {
	if (String(host.env?.RECONCILE ?? '1') === '0') return 'RECONCILE is off';
	if (!phasesFor(cmsOf(host.env)).reconcile) return 'this CMS has no reconciliation steps';
	if (refusesReconcile(host)) return 'a replica lane serves a copy and does not reconcile';
	const state = host.reconcileState();
	if (
		reconciled(state, host.metaGet(DRIVER_DIGEST_KEY)) &&
		!recurringWork(state, host.sql, host.reconcileHost())
	) {
		return 'already at the shipping version';
	}
	// a deferred step answers undefined too; without this a site parked at version 0 of 2
	// reads as shipping
	const planned = planReconcile(state, host.sql, host.reconcileHost());
	return planned.action === 'wait'
		? `waiting on ${planned.step.id}: ${planned.reason}`
		: `version ${state.version} of ${PACK_VERSION}, with no step left to try`;
}

/**
 * Drops the caches that embed the Drupal core version, once per lifetime, when that version
 * has moved.
 */
export function invalidateOnCoreUpgrade(host: ReconcileStateHost): InvalidationResult | undefined {
	if (host.reconcileMemo.coreVersionChecked) return undefined;
	host.reconcileMemo.coreVersionChecked = true;
	try {
		return invalidateVersionPinnedCaches(
			host.sql,
			host.metaGet(CORE_VERSION_KEY),
			SHIPPED_CORE_VERSION,
			(version) => host.metaSet(CORE_VERSION_KEY, version)
		);
	} catch {
		// never take the serving path down over a cache-busting nicety
		return undefined;
	}
}
