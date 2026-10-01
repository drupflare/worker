/**
 * Reconciles a provisioned site with today's pack (which delivers only at provisioning). A
 * `verdict` asks about the end state before and after the apply; config goes through Drupal
 * (`php()`), never SQL, as `cache_config` keeps a copy. Applied steps drop the heap image.
 * @module
 */
import {
	reconcileClockPhp,
	reconcileConfigPhp,
	reconcileDiscoveryPhp,
	reconcileOwnerPhp,
	reconcileRouterPhp,
	reconcileToolkitPhp,
	reconcileUninstallPhp
} from '../drupal/reconcile-php';
import { firstRow } from '../util/sql';
import { DRIVER_DIGEST, DRIVER_ROUTE_PERMISSIONS, DRIVER_ROUTES } from './driver-digest';
import { UNREAD_NODE_INDEXES } from './node-indexes';
import { base64Bytes, packedContainerFor, type PackedContainer } from './packed-container';

/**
 * The `cfw_meta` key naming the driver pack a site's container was built against; provisioning
 * stamps the digest the container was baked with, so a stale bake reads as owed.
 */
export const DRIVER_DIGEST_KEY = 'driver_digest';

/** set by the digest step on an update, and read once by its `php()` to warm discovery */
export const DISCOVERY_WARM_KEY = 'discovery_warm_owed';

/** the reads and writes this module needs, narrowed so it stays drivable over a fake */
export interface ReconcileSql {
	exec(sql: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** what a step may ask the host for beyond plain SQL */
export interface ReconcileHost {
	/** the ms timestamp the site was claimed, or undefined when it never has been */
	claimedAtMs(): number | undefined;
	/** reads a `cfw_meta` value */
	meta(key: string): string | null;
	/**
	 * Writes a `cfw_meta` value; a marker step writes it inside its apply, or the verdict that
	 * follows reads the old value and files a successful run as failed.
	 */
	setMeta(key: string, value: string): void;
	/**
	 * The site's canonical `scheme://host[:port]`; `Request::create()` ignores `$_SERVER`, so this
	 * URI alone sets the host Drupal builds absolute URLs against in a PHP step.
	 */
	origin(): string;
	/** the pack's compiled container, when the host has loaded it */
	packedContainer?(): PackedContainer | undefined;
	/** {@link extensionFingerprint} of the site's own `core.extension` */
	modules?(): string;
}

/** a step's answer to whether the site's end state matches */
export type StepVerdict =
	/** the site's end state already matches; nothing to do */
	| { state: 'satisfied' }
	/** the site owes this step */
	| { state: 'owed'; detail: string }
	/** cannot be decided yet, and waiting is correct rather than a failure */
	| { state: 'deferred'; detail: string };

/** one declared reconciliation: an end-state observation plus the fix that reaches it */
export interface ReconcileStep {
	/**
	 * Whether the answer can change after the step was satisfied (the driver digest, the pack's
	 * routes). Retiring such a step strands every site reconciled against an older pack.
	 */
	recurring?: boolean;
	/** stable forever; it is what a site records as done */
	id: string;
	/** the pack version this step was introduced at */
	since: number;
	describe: string;
	/** the end-state observation, asked before and after the apply */
	verdict(sql: ReconcileSql, host: ReconcileHost): StepVerdict;
	/** a SQL-only fix; use only where no cached copy of the value can exist */
	sql?(sql: ReconcileSql, host: ReconcileHost): void;
	/** a PHP fragment printing a JSON object, for anything Drupal caches; undefined boots none */
	php?(host: ReconcileHost): string | undefined;
	/**
	 * Whether the interpreter must be replaced once the step lands; only a step that changes what a
	 * kernel boots from needs it (dropping one beside an uncollected heap resets the object).
	 */
	freshKernel?: boolean;
}

/**
 * Counts `watchdog` rows that predate the claim, which came out of the bake. Compared against the
 * claim, not a date, so no real entry is deleted; an unclaimed site defers.
 */
const BAKE_WATCHDOG = `SELECT COUNT(*) AS n FROM watchdog WHERE timestamp < ?`;

/** the first column of the first row as a number, or undefined when the table is missing */
function count(sql: ReconcileSql, query: string, ...bindings: unknown[]): number | undefined {
	try {
		const row = firstRow(sql.exec(query, ...bindings));
		return row === undefined ? 0 : Number(Object.values(row)[0] ?? 0);
	} catch {
		// a table the pack does not carry is not a failure; the step is simply not owed
		return undefined;
	}
}

/** a `serialize()`d integer, and undefined for anything else including a numeric string */
export function serialisedInt(value: string): number | undefined {
	const m = /^i:(-?\d+);$/.exec(value.trim());
	return m ? Number(m[1]) : undefined;
}

/** a column value as text; `config.data` is a BLOB, so the platform returns bytes, not a string */
function columnText(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
	return undefined;
}

/** unserialises just enough of a PHP `a:N:{...}` blob to read one integer at a known path */
function phpInt(blob: string, path: readonly string[]): number | undefined {
	let rest = blob;
	for (const key of path) {
		const at = rest.indexOf(`s:${key.length}:"${key}";`);
		if (at < 0) return undefined;
		rest = rest.slice(at + `s:${key.length}:"${key}";`.length);
	}
	const m = /^i:(-?\d+);/.exec(rest);
	return m ? Number(m[1]) : undefined;
}

/** the two copies of one config object: the row Drupal writes and the bin it reads first */
export function configMaxAge(sql: ReconcileSql): { config?: number; cached?: number } {
	const read = (query: string, name: string): number | undefined => {
		try {
			const data = columnText(firstRow(sql.exec(query, name))?.data);
			return data === undefined ? undefined : phpInt(data, ['cache', 'page', 'max_age']);
		} catch {
			return undefined;
		}
	};
	return {
		config: read('SELECT data FROM config WHERE name = ?', 'system.performance'),
		cached: read('SELECT data FROM cache_config WHERE cid = ?', 'system.performance')
	};
}

/** what the pack ships, and therefore what a reconciled site must converge on */
export const SHIPPED_PAGE_MAX_AGE = 300;

/** the drupflare permission names the three tiers replaced, and the tier each one became */
export const RETIRED_PERMISSIONS: Readonly<Record<string, string>> = {
	'administer drupflare': 'view drupflare status',
	'administer drupflare settings': 'administer drupflare site',
	'administer drupflare operations': 'administer drupflare site',
	'administer drupflare code': 'administer drupflare owner'
};

/** the roles whose stored config still names a retired permission, or undefined when unreadable */
export function rolesHoldingRetired(sql: ReconcileSql): string[] | undefined {
	let rows: Record<string, unknown>[];
	try {
		rows = sql.exec("SELECT name, data FROM config WHERE name LIKE 'user.role.%'").toArray();
	} catch {
		return undefined;
	}
	// the serialized form carries the length, so `administer drupflare` cannot match a longer name
	const needles = Object.keys(RETIRED_PERMISSIONS).map((p) => `s:${p.length}:"${p}";`);
	return rows
		.filter((r) => needles.some((n) => (columnText(r.data) ?? '').includes(n)))
		.map((r) => String(r.name).slice('user.role.'.length));
}

/** the packed routes whose stored row lacks the declared permission (matched in serialized form) */
export function staleRoutePermissions(sql: ReconcileSql): string[] {
	const stale: string[] = [];
	for (const [name, permission] of Object.entries(DRIVER_ROUTE_PERMISSIONS)) {
		let text: string | undefined;
		try {
			text = columnText(
				firstRow(sql.exec('SELECT route FROM router WHERE name = ?', name))?.route
			);
		} catch {
			text = undefined;
		}
		const wanted = `s:11:"_permission";s:${permission.length}:"${permission}";`;
		if (text !== undefined && !text.includes(wanted)) stale.push(name);
	}
	return stale;
}

/** modules uninstalled on arrival because the runtime does their job another way */
export const REPLACED_MODULES = [
	'automatic_updates',
	'project_browser',
	'mongodb_watchdog'
] as const;

/** the enabled module names in `core.extension`, or undefined when the row cannot be read */
export function enabledModules(sql: ReconcileSql): string[] | undefined {
	let data: string | undefined;
	try {
		data = columnText(
			firstRow(sql.exec('SELECT data FROM config WHERE name = ?', 'core.extension'))?.data
		);
	} catch {
		return undefined;
	}
	if (data === undefined) return undefined;
	const start = data.indexOf('s:6:"module";');
	if (start < 0) return undefined;
	const end = data.indexOf('s:5:"theme";', start);
	const list = data.slice(start, end < 0 ? undefined : end);
	return [...list.matchAll(/s:\d+:"([a-z0-9_]+)";i:/g)].map((m) => m[1] as string);
}

/** the toolkit `system.image` names, or undefined when the row cannot be read */
export function imageToolkit(sql: ReconcileSql): string | undefined {
	try {
		const data = columnText(
			firstRow(sql.exec('SELECT data FROM config WHERE name = ?', 'system.image'))?.data
		);
		return data === undefined ? undefined : /s:7:"toolkit";s:\d+:"([^"]*)";/.exec(data)?.[1];
	} catch {
		return undefined;
	}
}

/**
 * The declarative list, in run order; `since` keeps the version monotonic. Add one only for a fix
 * an existing site cannot otherwise receive; removing one is safe (undeclared ids are never asked).
 */
export const RECONCILE_STEPS: readonly ReconcileStep[] = [
	{
		id: 'page-max-age',
		since: 1,
		describe:
			'page cache max_age, without which every render is no-store and cfw_page stays empty',
		verdict(sql) {
			const { config, cached } = configMaxAge(sql);
			if (config === undefined)
				return { state: 'deferred', detail: 'no system.performance row' };
			if (config > 0 && (cached === undefined || cached === config)) {
				return { state: 'satisfied' };
			}
			return {
				state: 'owed',
				detail: `config ${config}, cache_config ${cached === undefined ? 'absent' : cached}`
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
			if (claimed === undefined) {
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
			// parsed here, not cast in SQL: a `REPLACE` cast reads `s:4:"1234"` as a number too
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
			if (claimed === undefined) {
				return {
					state: 'deferred',
					detail: 'never claimed, so no row can be shown to be foreign'
				};
			}
			const stale = count(sql, BAKE_WATCHDOG, Math.floor(claimed / 1000));
			if (stale === undefined) return { state: 'satisfied' };
			return stale === 0
				? { state: 'satisfied' }
				: { state: 'owed', detail: `${stale} log rows predate the claim` };
		},
		// sql, not php: `watchdog` has no cached copy and a boot would run one DELETE
		sql(sql, host) {
			sql.exec(
				'DELETE FROM watchdog WHERE timestamp < ?',
				Math.floor((host.claimedAtMs() ?? 0) / 1000)
			);
		}
	},
	{
		id: 'container-driver-digest',
		freshKernel: true,
		since: 2,
		// the digest moves with every pack, so this question has a new answer on every release
		recurring: true,
		describe:
			'a compiled container and discovery cache that predate the driver pack, so a newer hook class or tab is invisible',
		/**
		 * Closes the hook-added-after-the-bake gap: the container key (`VERSIONS_HASH`, PHP, OS)
		 * does not move with `assets/driver.json`, so a new `#[Hook]` compiles into nothing.
		 */
		verdict(sql, host) {
			if (host.meta(DRIVER_DIGEST_KEY) === DRIVER_DIGEST) return { state: 'satisfied' };
			const rows = count(sql, 'SELECT COUNT(*) AS n FROM cache_container');
			if (rows === undefined)
				return { state: 'deferred', detail: 'no cache_container table' };
			return { state: 'owed', detail: `driver digest moved; ${rows} container rows to drop` };
		},
		sql(sql, host) {
			sql.exec('DELETE FROM cache_container');
			// the pack's row when baked for this driver and module set, else the site rebuilds
			const rows = packedContainerFor(
				host.packedContainer?.(),
				DRIVER_DIGEST,
				host.modules?.() ?? ''
			);
			for (const row of rows ?? []) {
				sql.exec(
					'INSERT INTO cache_container (cid, data, expire, created, serialized, tags, checksum) VALUES (?, ?, ?, ?, ?, ?, ?)',
					row.cid,
					base64Bytes(row.data),
					row.expire,
					row.created,
					row.serialized,
					row.tags,
					row.checksum
				);
			}
			// discovery holds tabs, so a delivered route can lack one (the router step stops once
			// routes land)
			sql.exec('DELETE FROM cache_discovery');
			// only a site that recorded an older digest (an update) warms
			host.setMeta(DISCOVERY_WARM_KEY, host.meta(DRIVER_DIGEST_KEY) ? '1' : '');
			host.setMeta(DRIVER_DIGEST_KEY, DRIVER_DIGEST);
		},
		/**
		 * Rebuilds discovery on an update only, so no render has to (one did and was reset for
		 * memory). A fresh site boots nothing: booting there broke the boot-free migration chain.
		 */
		php(host) {
			if (host.meta(DISCOVERY_WARM_KEY) !== '1') return undefined;
			host.setMeta(DISCOVERY_WARM_KEY, '');
			return reconcileDiscoveryPhp(host.origin());
		}
	},
	{
		id: 'router-driver-routes',
		since: 3,
		// `DRIVER_ROUTES` grows with every sibling route, so this must stay askable
		recurring: true,
		describe: "a route table that predates the driver pack, so a module's own paths are 404",
		/**
		 * Asks `router` (only `RouteBuilder` writes it) which pack routes it holds, not a marker:
		 * `sql()` runs before `php()`, so a marker would stamp even when the rebuild threw.
		 */
		verdict(sql) {
			if (DRIVER_ROUTES.length === 0) return { state: 'satisfied' };
			const rows = count(sql, 'SELECT COUNT(*) AS n FROM router');
			if (rows === undefined) return { state: 'deferred', detail: 'no router table' };
			const placeholders = DRIVER_ROUTES.map(() => '?').join(', ');
			const have = count(
				sql,
				`SELECT COUNT(*) AS n FROM router WHERE name IN (${placeholders})`,
				...DRIVER_ROUTES
			);
			if (have === undefined) return { state: 'deferred', detail: 'router not readable' };
			if (have < DRIVER_ROUTES.length) {
				return {
					state: 'owed',
					detail: `${have} of ${DRIVER_ROUTES.length} driver routes present in ${rows} rows`
				};
			}
			// a row keeps its built requirement, so a renamed permission passes the count
			const stale = staleRoutePermissions(sql);
			return stale.length === 0
				? { state: 'satisfied' }
				: { state: 'owed', detail: `permission changed on ${stale.join(', ')}` };
		},
		php(host) {
			return reconcileRouterPhp(host.origin());
		}
	},
	{
		id: 'owner-tiers',
		since: 4,
		describe:
			'the five drupflare permissions folded into three, and the owner role uid 1 is given at claim',
		verdict(sql, host) {
			if (host.claimedAtMs() === undefined) {
				return { state: 'deferred', detail: 'never claimed, so there is no owner yet' };
			}
			const retired = rolesHoldingRetired(sql);
			if (retired === undefined) return { state: 'deferred', detail: 'no config table' };
			const role = count(
				sql,
				'SELECT COUNT(*) AS n FROM config WHERE name = ?',
				'user.role.drupflare_owner'
			);
			const held = count(
				sql,
				'SELECT COUNT(*) AS n FROM user__roles WHERE entity_id = ? AND roles_target_id = ?',
				1,
				'drupflare_owner'
			);
			const owed = [
				...(retired.length > 0 ? [`retired names on ${retired.join(', ')}`] : []),
				...(role === 0 ? ['no owner role'] : []),
				...(held === 0 ? ['uid 1 lacks the owner role'] : [])
			];
			return owed.length === 0
				? { state: 'satisfied' }
				: { state: 'owed', detail: owed.join('; ') };
		},
		php: (host) => reconcileOwnerPhp(RETIRED_PERMISSIONS, host.origin())
	},
	{
		id: 'node-unread-indexes',
		since: 5,
		describe:
			'three node_field_data indexes no default workload reads, each two charged rows on every node save',
		verdict(sql) {
			const placeholders = UNREAD_NODE_INDEXES.map(() => '?').join(', ');
			const present = count(
				sql,
				`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name IN (${placeholders})`,
				...UNREAD_NODE_INDEXES
			);
			if (present === undefined)
				return { state: 'deferred', detail: 'sqlite_master not readable' };
			return present === 0
				? { state: 'satisfied' }
				: { state: 'owed', detail: `${present} unread node indexes present` };
		},
		// sql, not php: an index has no cached copy and `Schema::dropIndex()` checks first
		sql(sql) {
			for (const index of UNREAD_NODE_INDEXES) sql.exec(`DROP INDEX IF EXISTS ${index}`);
		}
	},
	{
		id: 'image-toolkit',
		since: 6,
		describe:
			'the image toolkit, which a migrated site brings as gd or imagemagick and neither runs here',
		verdict(sql, host) {
			// the claim selects the toolkit on a fresh site, so only a claimed site can owe it
			if (host.claimedAtMs() === undefined) {
				return { state: 'deferred', detail: 'never claimed' };
			}
			const modules = enabledModules(sql);
			const toolkit = imageToolkit(sql);
			if (modules === undefined || toolkit === undefined) {
				return { state: 'deferred', detail: 'no core.extension or system.image row' };
			}
			// the toolkit plugin ships in drupflare, so a site without it has nothing to point at
			if (!modules.includes('drupflare'))
				return { state: 'deferred', detail: 'drupflare not enabled' };
			return toolkit === 'cfw_images'
				? { state: 'satisfied' }
				: { state: 'owed', detail: `toolkit is ${toolkit}` };
		},
		php: (host) => reconcileToolkitPhp(host.origin())
	}
];

/**
 * Uninstalls the modules in {@link REPLACED_MODULES} on a claimed site. Kept out of
 * {@link RECONCILE_STEPS}: removing a module an operator enabled is an undecided product choice.
 */
export const REPLACED_MODULES_STEP: ReconcileStep = {
	id: 'replaced-modules',
	since: 6,
	describe:
		'modules whose job the runtime does another way: composer updaters and the MongoDB logger',
	verdict(sql) {
		const modules = enabledModules(sql);
		if (modules === undefined) return { state: 'deferred', detail: 'no core.extension row' };
		const present = REPLACED_MODULES.filter((m) => modules.includes(m));
		return present.length === 0
			? { state: 'satisfied' }
			: { state: 'owed', detail: `enabled: ${present.join(', ')}` };
	},
	php: (host) => reconcileUninstallPhp(REPLACED_MODULES, host.origin())
};

/** the pack version this build reconciles to; monotonic because it is the max of every step's */
export const PACK_VERSION = RECONCILE_STEPS.reduce((max, s) => Math.max(max, s.since), 0);

/** a step that ran and did not converge, with how many times it has been tried */
export interface StepFailure {
	attempts: number;
	reason: string;
}

/** what a site records: the version reached, applied step ids and failed steps */
export interface ReconcileState {
	/** the highest version this site has fully reached */
	version: number;
	/** ids applied or found already satisfied */
	applied: string[];
	/** ids whose apply ran and left the site still owing them */
	failed: Record<string, StepFailure>;
}

/** the state of a site that has reconciled nothing */
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

/** the JSON stored in `cfw_meta` */
export function serialiseReconcileState(state: ReconcileState): string {
	return JSON.stringify(state);
}

/**
 * Whether this site is already at the shipping version, answered without touching the site; the
 * steady state is this comparison and the one `cfw_meta` read that feeds it.
 */
export function reconciled(state: ReconcileState, recordedDriverDigest?: string | null): boolean {
	// the driver pack moves without `PACK_VERSION` (bumped by hand per step), so compare the digest
	// too or a current-version site never asks a verdict again
	if (recordedDriverDigest !== undefined && recordedDriverDigest !== DRIVER_DIGEST) return false;
	return state.version >= PACK_VERSION && Object.keys(state.failed).length === 0;
}

/**
 * Whether any recurring step still owes work, whatever the version says (a fresh site reads
 * current while its packed `router` predates the module set). Only recurring steps are asked.
 */
export function recurringWork(
	state: ReconcileState,
	sql: ReconcileSql,
	host: ReconcileHost,
	steps: readonly ReconcileStep[] = RECONCILE_STEPS
): boolean {
	for (const step of steps) {
		if (!step.recurring) continue;
		if ((state.failed[step.id]?.attempts ?? 0) >= STEP_ATTEMPT_LIMIT) continue;
		if (step.verdict(sql, host).state === 'owed') return true;
	}
	return false;
}

/** how many attempts a step gets before it stops being retried on every firing */
export const STEP_ATTEMPT_LIMIT = 3;

/** the next action `planReconcile()` chose */
export type PlannedStep =
	| { action: 'run'; step: ReconcileStep; detail: string }
	| { action: 'mark'; step: ReconcileStep; reason: 'satisfied' }
	| { action: 'wait'; step: ReconcileStep; reason: string }
	| { action: 'done'; version: number };

/**
 * The next thing to do, one step at a time so the chain is sliceable and resumable. `mark` is
 * separate from `run` because it costs nothing: a fresh site converges by marks, with no boot.
 */
export function planReconcile(
	state: ReconcileState,
	sql: ReconcileSql,
	host: ReconcileHost,
	steps: readonly ReconcileStep[] = RECONCILE_STEPS
): PlannedStep {
	const applied = new Set(state.applied);
	// a deferred step must not block later ones (`bake-clock` defers forever on an unclaimed site);
	// the first deferral is reported only when nothing else has work
	let waiting: { step: ReconcileStep; reason: string } | undefined;
	for (const step of steps) {
		// a recurring step is never retired: its answer moves with the pack, and marking it applied
		// would skip its verdict on every site reconciled against an older pack
		const settled = applied.has(step.id);
		if (settled && !step.recurring) continue;
		// a step that spent its attempts stops owning the chain; it stays visible as `failed`
		if ((state.failed[step.id]?.attempts ?? 0) >= STEP_ATTEMPT_LIMIT) continue;
		const verdict = step.verdict(sql, host);
		if (verdict.state === 'satisfied') {
			// already recorded: move on, or `done` is never reported
			if (settled) continue;
			return { action: 'mark', step, reason: 'satisfied' };
		}
		if (verdict.state === 'deferred') {
			waiting ??= { step, reason: verdict.detail };
			continue;
		}
		return { action: 'run', step, detail: verdict.detail };
	}
	if (waiting) return { action: 'wait', step: waiting.step, reason: waiting.reason };
	// the version reached, not `PACK_VERSION`: a rollout must not read a site as patched while a
	// failed step's fix never landed
	return { action: 'done', version: versionReached(state.applied, steps) };
}

/**
 * Folds an applied step into the state; one that left the site still owing it is recorded as
 * failed with its attempt count, so it can neither own the alarm chain nor report success.
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
 * The highest version every step of which this site has applied: the largest `since` with no step
 * at or below it outstanding, so a version is never claimed while one of its steps is owed.
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

/** the identifying fields of a step, for the status report */
function pick(step: ReconcileStep): { id: string; since: number; describe: string } {
	return { id: step.id, since: step.since, describe: step.describe };
}
