import { reconcileClockPhp, reconcileConfigPhp } from '../drupal/reconcile-php.js';
import { DRIVER_DIGEST } from './driver-digest.js';

/**
 * Reconciling an ALREADY-PROVISIONED site with the pack that ships today.
 *
 * The pack is the delivery mechanism and it delivers only at provisioning. Every fix that lands
 * inside it reaches new sites and no existing one, so a host that cannot deliver an update is worse
 * than a VPS at the one thing this project's pitch names. This is the delivery path for the fixes
 * the pack cannot carry backwards.
 *
 * ## Each step is an OBSERVATION, not a script
 *
 * A step's {@link ReconcileStep.verdict} is a cheap SQL question about the site's END STATE, and it
 * is asked twice: once to decide whether to run, and again afterwards to decide whether running
 * worked. So "the reconciliation ran" is never the success condition; two of this project's
 * Outstanding Bugs closed on exactly that assertion and neither site converged. A site provisioned
 * after a fix answers `satisfied` the first time and is marked done without doing any work.
 *
 * ## A config write goes through Drupal, and that is a correctness requirement
 *
 * `system.performance:cache.page.max_age` was fixed correctly in the `config` table and stayed inert
 * because `cache_config` held its own serialized copy of the same object, and Drupal reads the bin
 * first. Any step that changes configuration or state therefore runs {@link ReconcileStep.php}
 * rather than SQL: `ConfigFactory::getEditable()->save()` already names every cached copy it
 * invalidates, and a host re-implementing that list would be re-deriving it wrongly.
 *
 * ## Every applied step drops the heap image
 *
 * Unconditionally, rather than per step. A restored kernel predates whatever the step just changed,
 * which is the shape of BUG 1, and the alternative is a flag each new step's author has to get
 * right. One re-image is cheaper than that class of defect.
 */

/** the reads and writes this module needs, narrowed so it stays drivable over a fake */
export interface ReconcileSql {
	exec(sql: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** what a step may ask the host for beyond plain SQL */
export interface ReconcileHost {
	/** the ms timestamp the site was claimed, or null when it never has been */
	claimedAtMs(): number | null;
	/** reads a `cfw_meta` value */
	meta(key: string): string | null;
	/**
	 * writes a `cfw_meta` value.
	 *
	 * A step whose end state IS a recorded marker has to write it inside its own apply, because the
	 * verdict runs immediately afterwards and would otherwise read the old value and call the step
	 * failed on the run that succeeded.
	 */
	setMeta(key: string, value: string): void;
	/**
	 * the site's canonical `scheme://host[:port]`.
	 *
	 * A PHP step boots a kernel, and `Request::create()` builds its own server bag rather than reading
	 * `$_SERVER`, so the URI it is handed is the only thing that sets the host. Booted against
	 * localhost, anything Drupal builds an absolute URL for during the write points at the wrong site.
	 */
	origin(): string;
}

export type StepVerdict =
	/** the site's end state already matches; nothing to do */
	| { state: 'satisfied' }
	/** the site owes this step */
	| { state: 'owed'; detail: string }
	/** cannot be decided yet, and waiting is correct rather than a failure */
	| { state: 'deferred'; detail: string };

export interface ReconcileStep {
	/** stable forever; it is what a site records as done */
	id: string;
	/** the pack version this step was introduced at */
	since: number;
	describe: string;
	/** the end-state observation, asked before and after the apply */
	verdict(sql: ReconcileSql, host: ReconcileHost): StepVerdict;
	/** a SQL-only fix; use only where no cached copy of the value can exist */
	sql?(sql: ReconcileSql, host: ReconcileHost): void;
	/** a PHP fragment printing a JSON object, for anything Drupal owns a cache of */
	php?(host: ReconcileHost): string;
}

/**
 * A row of `watchdog` that predates the site itself came out of the bake.
 *
 * The comparison is against the CLAIM rather than a fixed date, so the step cannot delete a real log
 * entry: every row this site produced is newer than the moment it became a site. An unclaimed site
 * has no such moment, which is why the step defers rather than guessing.
 */
const BAKE_WATCHDOG = `SELECT COUNT(*) AS n FROM watchdog WHERE timestamp < ?`;

function count(sql: ReconcileSql, query: string, ...bindings: unknown[]): number | null {
	try {
		const row = sql.exec(query, ...bindings).toArray()[0];
		return row === undefined ? 0 : Number(Object.values(row)[0] ?? 0);
	} catch {
		// a table the pack does not carry is not a failure; the step is simply not owed
		return null;
	}
}

/** a `serialize()`d integer, and null for anything else including a numeric string */
export function serialisedInt(value: string): number | null {
	const m = /^i:(-?\d+);$/.exec(value.trim());
	return m ? Number(m[1]) : null;
}

/**
 * A column value as text.
 *
 * `config.data` is declared BLOB, so the platform hands it back as bytes; a reader that accepted only
 * `string` answered null on every real pack and the step deferred forever while looking correct on a
 * fixture that had written the column as TEXT.
 */
function columnText(value: unknown): string | null {
	if (typeof value === 'string') return value;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
	return null;
}

/** unserialises just enough of a PHP `a:N:{...}` blob to read one integer at a known path */
function phpInt(blob: string, path: readonly string[]): number | null {
	let rest = blob;
	for (const key of path) {
		const at = rest.indexOf(`s:${key.length}:"${key}";`);
		if (at < 0) return null;
		rest = rest.slice(at + `s:${key.length}:"${key}";`.length);
	}
	const m = /^i:(-?\d+);/.exec(rest);
	return m ? Number(m[1]) : null;
}

/** the two copies of one config object: the row Drupal writes and the bin it reads first */
export function configMaxAge(sql: ReconcileSql): { config: number | null; cached: number | null } {
	const read = (query: string, name: string): number | null => {
		try {
			const data = columnText(sql.exec(query, name).toArray()[0]?.data);
			return data === null ? null : phpInt(data, ['cache', 'page', 'max_age']);
		} catch {
			return null;
		}
	};
	return {
		config: read('SELECT data FROM config WHERE name = ?', 'system.performance'),
		cached: read('SELECT data FROM cache_config WHERE cid = ?', 'system.performance')
	};
}

/** what the pack ships, and therefore what a reconciled site must converge on */
export const SHIPPED_PAGE_MAX_AGE = 300;

/**
 * The declarative list. Order is the order they run in; `since` is what makes the version monotonic.
 *
 * Adding a step is the whole delivery mechanism, so the bar for one is a fix that a site provisioned
 * yesterday cannot otherwise receive. Removing one is safe: a site records ids it has applied and an
 * id nobody declares any more is simply never asked for again.
 */
export const RECONCILE_STEPS: readonly ReconcileStep[] = [
	{
		id: 'page-max-age',
		since: 1,
		describe:
			'page cache max_age, without which every render is no-store and cfw_page stays empty',
		verdict(sql) {
			const { config, cached } = configMaxAge(sql);
			if (config === null) return { state: 'deferred', detail: 'no system.performance row' };
			if (config > 0 && (cached === null || cached === config)) return { state: 'satisfied' };
			return {
				state: 'owed',
				detail: `config ${config}, cache_config ${cached === null ? 'absent' : cached}`
			};
		},
		php: (host) => reconcileConfigPhp(SHIPPED_PAGE_MAX_AGE, host.origin())
	},
	{
		id: 'bake-clock',
		since: 1,
		describe:
			"the bake's install_time and cron_last, which the status report reads as this site's",
		verdict(sql, host) {
			const claimed = host.claimedAtMs();
			if (claimed === null) {
				return {
					state: 'deferred',
					detail: 'never claimed, so there is no real birthday yet'
				};
			}
			const seconds = Math.floor(claimed / 1000);
			let rows: Record<string, unknown>[];
			try {
				rows = sql
					.exec(
						`SELECT name, value FROM key_value
						 WHERE collection = 'state' AND name IN ('install_time', 'system.cron_last')`
					)
					.toArray();
			} catch {
				return { state: 'deferred', detail: 'no key_value table' };
			}
			// the value is a serialize()d int, so it is parsed here rather than cast in SQL: a
			// REPLACE-based cast reads `s:4:"1234"` as a number too and would call a string satisfied
			const stale = rows.filter(
				(r) => (serialisedInt(columnText(r.value) ?? '') ?? 0) < seconds
			);
			return stale.length === 0
				? { state: 'satisfied' }
				: {
						state: 'owed',
						detail: `${stale.map((r) => String(r.name)).join(', ')} predate the claim`
					};
		},
		php: (host) =>
			reconcileClockPhp(Math.floor((host.claimedAtMs() ?? 0) / 1000), host.origin())
	},
	{
		id: 'bake-watchdog',
		since: 1,
		describe:
			"the bake's own log rows, which open a new site with weeks of somebody else's history",
		verdict(sql, host) {
			const claimed = host.claimedAtMs();
			if (claimed === null) {
				return {
					state: 'deferred',
					detail: 'never claimed, so no row can be shown to be foreign'
				};
			}
			const stale = count(sql, BAKE_WATCHDOG, Math.floor(claimed / 1000));
			if (stale === null) return { state: 'satisfied' };
			return stale === 0
				? { state: 'satisfied' }
				: { state: 'owed', detail: `${stale} log rows predate the claim` };
		},
		// SQL rather than PHP: `watchdog` is a plain table with no cached copy anywhere, and the
		// alternative is booting the interpreter to run one DELETE
		sql(sql, host) {
			sql.exec(
				'DELETE FROM watchdog WHERE timestamp < ?',
				Math.floor((host.claimedAtMs() ?? 0) / 1000)
			);
		}
	},
	{
		id: 'container-driver-digest',
		since: 2,
		describe:
			'a compiled container that predates the driver pack, so a newer hook class is invisible',
		/**
		 * The general close for the baked-hook problem.
		 *
		 * `DrupalKernel::getContainerCacheKey()` is built from composer's `VERSIONS_HASH`, the PHP
		 * version and the OS. None of those moves when `assets/driver.json` changes, so a `#[Hook]`
		 * class added to a sibling module after the bake compiles into nothing: `hasImplementations()`
		 * answers false while the class loads fine, which is why `DeferredCron` has never run
		 * anywhere. Dropping the row makes the next boot rebuild and discover.
		 */
		verdict(sql, host) {
			if (host.meta('driver_digest') === DRIVER_DIGEST) return { state: 'satisfied' };
			const rows = count(sql, 'SELECT COUNT(*) AS n FROM cache_container');
			if (rows === null) return { state: 'deferred', detail: 'no cache_container table' };
			return { state: 'owed', detail: `driver digest moved; ${rows} container rows to drop` };
		},
		sql(sql, host) {
			sql.exec('DELETE FROM cache_container');
			host.setMeta('driver_digest', DRIVER_DIGEST);
		}
	}
];

/** the pack version this build reconciles to; monotonic because it is the max of every step's */
export const PACK_VERSION = RECONCILE_STEPS.reduce((max, s) => Math.max(max, s.since), 0);

/** a step that ran and did not converge, with how many times it has been tried */
export interface StepFailure {
	attempts: number;
	reason: string;
}

export interface ReconcileState {
	/** the highest version this site has fully reached */
	version: number;
	/** ids applied or found already satisfied */
	applied: string[];
	/** ids whose apply ran and left the site still owing them */
	failed: Record<string, StepFailure>;
}

export const CLEAN_RECONCILE: ReconcileState = { version: 0, applied: [], failed: {} };

/** defaults to clean on anything unexpected, so a corrupt row re-reconciles rather than skipping */
export function parseReconcileState(raw: string | null | undefined): ReconcileState {
	if (!raw) return { ...CLEAN_RECONCILE, applied: [], failed: {} };
	try {
		const parsed = JSON.parse(raw) as Partial<ReconcileState>;
		const failed: Record<string, StepFailure> = {};
		if (parsed.failed && typeof parsed.failed === 'object') {
			for (const [id, raw] of Object.entries(parsed.failed)) {
				const f = raw as Partial<StepFailure> | undefined;
				failed[String(id)] = {
					attempts: Number.isFinite(f?.attempts) ? Number(f?.attempts) : 1,
					reason: String(f?.reason ?? '')
				};
			}
		}
		return {
			version: Number.isFinite(parsed.version) ? Number(parsed.version) : 0,
			applied: Array.isArray(parsed.applied) ? parsed.applied.map(String) : [],
			failed
		};
	} catch {
		return { ...CLEAN_RECONCILE, applied: [], failed: {} };
	}
}

export function serialiseReconcileState(state: ReconcileState): string {
	return JSON.stringify(state);
}

/**
 * Whether this site is already at the shipping version, answered without touching the site.
 *
 * The steady-state cost of reconciliation is this comparison and the one `cfw_meta` read that feeds
 * it. A site at the current version asks no SQL question of any step.
 */
export function reconciled(state: ReconcileState): boolean {
	return state.version >= PACK_VERSION && Object.keys(state.failed).length === 0;
}

/** how many attempts a step gets before it stops being retried on every firing */
export const STEP_ATTEMPT_LIMIT = 3;

export type PlannedStep =
	| { action: 'run'; step: ReconcileStep; detail: string }
	| { action: 'mark'; step: ReconcileStep; reason: 'satisfied' }
	| { action: 'wait'; step: ReconcileStep; reason: string }
	| { action: 'done'; version: number };

/**
 * The next thing to do, one step at a time so the chain is sliceable and resumable.
 *
 * `mark` is separated from `run` because it costs nothing: a site provisioned after a fix converges
 * through a series of marks with no interpreter boot and no writes beyond the one state row.
 */
export function planReconcile(
	state: ReconcileState,
	sql: ReconcileSql,
	host: ReconcileHost,
	steps: readonly ReconcileStep[] = RECONCILE_STEPS
): PlannedStep {
	const applied = new Set(state.applied);
	// A DEFERRED STEP MUST NOT BLOCK THE ONES AFTER IT. `bake-clock` defers until the site is claimed,
	// which on a site nobody claims is forever, so returning on the first deferral would leave every
	// later step permanently unreached. The first deferral is remembered and reported only when
	// nothing else has work
	let waiting: { step: ReconcileStep; reason: string } | null = null;
	for (const step of steps) {
		if (applied.has(step.id)) continue;
		// a step that has spent its attempts stops owning the chain; it stays visible as `failed` on
		// the status report rather than being retried on every firing forever
		if ((state.failed[step.id]?.attempts ?? 0) >= STEP_ATTEMPT_LIMIT) continue;
		const verdict = step.verdict(sql, host);
		if (verdict.state === 'satisfied') return { action: 'mark', step, reason: 'satisfied' };
		if (verdict.state === 'deferred') {
			waiting ??= { step, reason: verdict.detail };
			continue;
		}
		return { action: 'run', step, detail: verdict.detail };
	}
	if (waiting) return { action: 'wait', step: waiting.step, reason: waiting.reason };
	// THE VERSION IS WHAT WAS REACHED, NOT WHAT SHIPS. There is nothing left to try once a failed step
	// has spent its attempts, and reporting `PACK_VERSION` there would tell a rollout the site is
	// patched while the fix it is waiting on never landed
	return { action: 'done', version: versionReached(state.applied, steps) };
}

/**
 * Folds an applied step into the state.
 *
 * A step that ran and left the site still owing it is recorded as failed rather than applied, with
 * its attempt count, so a permanently broken step cannot own the alarm chain and cannot silently
 * report success either.
 */
export function recordStep(
	state: ReconcileState,
	step: ReconcileStep,
	after: StepVerdict,
	steps: readonly ReconcileStep[] = RECONCILE_STEPS
): ReconcileState {
	if (after.state !== 'satisfied') {
		const previous = state.failed[step.id]?.attempts ?? 0;
		return {
			...state,
			failed: {
				...state.failed,
				[step.id]: { attempts: previous + 1, reason: after.detail }
			}
		};
	}
	const applied = state.applied.includes(step.id) ? state.applied : [...state.applied, step.id];
	const failed = { ...state.failed };
	delete failed[step.id];
	return { version: versionReached(applied, steps), applied, failed };
}

/**
 * The highest version every step of which this site has applied.
 *
 * Monotonic by construction: it is the largest `since` such that no step at or below it is still
 * outstanding, so a version can never be claimed while one of its steps is owed. A step deleted from
 * the list stops being asked for, which is what makes removing one safe.
 */
export function versionReached(
	applied: readonly string[],
	steps: readonly ReconcileStep[] = RECONCILE_STEPS
): number {
	const done = new Set(applied);
	let reached = 0;
	for (const version of [...new Set(steps.map((s) => s.since))].sort((a, b) => a - b)) {
		if (!steps.filter((s) => s.since === version).every((s) => done.has(s.id))) break;
		reached = version;
	}
	return reached;
}

/** every step's current standing, for the Runtime Status page */
export function reconcileReport(
	state: ReconcileState,
	sql: ReconcileSql,
	host: ReconcileHost,
	steps: readonly ReconcileStep[] = RECONCILE_STEPS
): {
	version: number;
	packVersion: number;
	steps: { id: string; since: number; describe: string; state: string; detail: string }[];
} {
	const applied = new Set(state.applied);
	return {
		version: state.version,
		packVersion: PACK_VERSION,
		steps: steps.map((step) => {
			const failure = state.failed[step.id];
			if (failure) {
				return {
					...pick(step),
					state: 'failed',
					detail: `attempt ${failure.attempts}: ${failure.reason}`
				};
			}
			if (applied.has(step.id)) return { ...pick(step), state: 'applied', detail: '' };
			const verdict = step.verdict(sql, host);
			return {
				...pick(step),
				state: verdict.state,
				detail: verdict.state === 'satisfied' ? '' : verdict.detail
			};
		})
	};
}

function pick(step: ReconcileStep): { id: string; since: number; describe: string } {
	return { id: step.id, since: step.since, describe: step.describe };
}
