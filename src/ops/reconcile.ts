import {
	reconcileClockPhp,
	reconcileConfigPhp,
	reconcileDiscoveryPhp,
	reconcileOwnerPhp,
	reconcileRouterPhp
} from '../drupal/reconcile-php.js';
import { DRIVER_DIGEST, DRIVER_ROUTE_PERMISSIONS, DRIVER_ROUTES } from './driver-digest.js';
import { UNREAD_NODE_INDEXES } from './node-indexes.js';
import { base64Bytes, packedContainerFor, type PackedContainer } from './packed-container.js';

/**
 * The `cfw_meta` key recording which driver pack a site's compiled container was built against.
 *
 * Named here rather than written as a literal at each use, because provisioning stamps it too, with
 * the digest the packed container was BAKED with (`container-digest.ts`). A fresh site whose pack
 * was baked against the shipping driver is current and must not be made to prove it by throwing
 * the row away; one baked earlier reads as owed, which is what makes a newer hook visible.
 */
export const DRIVER_DIGEST_KEY = 'driver_digest';

/** set by the digest step on an update, and read once by its `php()` to warm discovery */
export const DISCOVERY_WARM_KEY = 'discovery_warm_owed';

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
	/** the pack's compiled container, when the host has loaded it */
	packedContainer?(): PackedContainer | null;
	/** {@link extensionFingerprint} of the site's own `core.extension` */
	modules?(): string;
}

export type StepVerdict =
	/** the site's end state already matches; nothing to do */
	| { state: 'satisfied' }
	/** the site owes this step */
	| { state: 'owed'; detail: string }
	/** cannot be decided yet, and waiting is correct rather than a failure */
	| { state: 'deferred'; detail: string };

export interface ReconcileStep {
	/**
	 * Whether this step's answer can change after it has once been satisfied.
	 *
	 * Most steps fix a defect the pack could not carry backwards: once applied they are done, and
	 * re-asking costs a query per firing forever. A step keyed on something that MOVES -- the driver
	 * digest, the routes a pack declares -- is the opposite, and retiring one silently strands every
	 * site that reconciled against an older pack.
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
	/** a PHP fragment printing a JSON object, for anything Drupal owns a cache of; null boots nothing */
	php?(host: ReconcileHost): string | null;
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

/** the drupflare permission names the three tiers replaced, and the tier each one became */
export const RETIRED_PERMISSIONS: Readonly<Record<string, string>> = {
	'administer drupflare': 'view drupflare status',
	'administer drupflare settings': 'administer drupflare site',
	'administer drupflare operations': 'administer drupflare site',
	'administer drupflare code': 'administer drupflare owner'
};

/** the roles whose stored config still names a retired permission, or null when unreadable */
export function rolesHoldingRetired(sql: ReconcileSql): string[] | null {
	let rows: Record<string, unknown>[];
	try {
		rows = sql.exec("SELECT name, data FROM config WHERE name LIKE 'user.role.%'").toArray();
	} catch {
		return null;
	}
	// the serialized form carries the length, so `administer drupflare` cannot match a longer name
	const needles = Object.keys(RETIRED_PERMISSIONS).map((p) => `s:${p.length}:"${p}";`);
	return rows
		.filter((r) => needles.some((n) => (columnText(r.data) ?? '').includes(n)))
		.map((r) => String(r.name).slice('user.role.'.length));
}

/**
 * The packed routes whose stored row does not require the permission the pack declares.
 *
 * `router.route` is a serialized `Route`, so the requirement is matched in its serialized form.
 */
export function staleRoutePermissions(sql: ReconcileSql): string[] {
	const stale: string[] = [];
	for (const [name, permission] of Object.entries(DRIVER_ROUTE_PERMISSIONS)) {
		let text: string | null = null;
		try {
			text = columnText(
				sql.exec('SELECT route FROM router WHERE name = ?', name).toArray()[0]?.route
			);
		} catch {
			text = null;
		}
		const wanted = `s:11:"_permission";s:${permission.length}:"${permission}";`;
		if (text !== null && !text.includes(wanted)) stale.push(name);
	}
	return stale;
}

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
		// the digest moves with every pack, so this question has a new answer on every release
		recurring: true,
		describe:
			'a compiled container and discovery cache that predate the driver pack, so a newer hook class or tab is invisible',
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
			if (host.meta(DRIVER_DIGEST_KEY) === DRIVER_DIGEST) return { state: 'satisfied' };
			const rows = count(sql, 'SELECT COUNT(*) AS n FROM cache_container');
			if (rows === null) return { state: 'deferred', detail: 'no cache_container table' };
			return { state: 'owed', detail: `driver digest moved; ${rows} container rows to drop` };
		},
		sql(sql, host) {
			sql.exec('DELETE FROM cache_container');
			// the pack's row when it was baked against this driver and for this site's modules, so
			// the next boot reads a container instead of compiling one inside a render; a site with
			// another module set, or a stale bake, still rebuilds its own
			const rows = packedContainerFor(
				host.packedContainer?.() ?? null,
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
			// AND THE DISCOVERY CACHE, which is where a LOCAL TASK lives. A tab declared in a
			// links.task.yml file is a discovery-cached plugin definition, so a pack can deliver the
			// route, the route can resolve, and the tab leading to it stays absent -- which is what
			// the modules page showed after the Code Delivery route landed.
			//
			// It belongs HERE rather than in the router step, and putting it there first was the
			// mistake. That step's verdict counts ROUTES; once the routes land it reads satisfied and
			// never runs again, so a site whose routes arrived before the tabs is stuck forever. This
			// step is keyed on the driver digest, so it fires whenever the packed modules change at
			// all, which is exactly the condition under which discovery has to run again.
			sql.exec('DELETE FROM cache_discovery');
			// an UPDATE rather than a fresh site: only a site that recorded an older digest warms
			host.setMeta(DISCOVERY_WARM_KEY, host.meta(DRIVER_DIGEST_KEY) ? '1' : '');
			host.setMeta(DRIVER_DIGEST_KEY, DRIVER_DIGEST);
		},
		/**
		 * Rebuilds discovery in this invocation, on an update only, so no render has to.
		 *
		 * A render that rebuilt the emptied discovery bin inside the first cold alarm after an update
		 * was reset for the isolate's memory with a visitor waiting (2 of 2 deployed updates,
		 * 2026-09-25), and a simulation that moved only the digest did not reproduce it. Splitting the
		 * rebuild into this invocation, which drops its interpreter at the end, keeps any single
		 * invocation to one of the two. A fresh site reads null and boots nothing: a `php()` on this
		 * step that booted on every fresh site was tried once and broke the boot-free migration chain.
		 */
		php(host) {
			if (host.meta(DISCOVERY_WARM_KEY) !== '1') return null;
			host.setMeta(DISCOVERY_WARM_KEY, '');
			return reconcileDiscoveryPhp(host.origin());
		}
	},
	{
		id: 'router-driver-routes',
		since: 3,
		// `DRIVER_ROUTES` grows whenever a sibling module declares a route, so this must stay askable
		recurring: true,
		describe: "a route table that predates the driver pack, so a module's own paths are 404",
		/**
		 * The other half of the baked-container problem, and it was live on every site.
		 *
		 * Measured 2026-09-09 by rebuilding the pack database with `install-site-db.php` and diffing
		 * it against the shipped one: the rebuild carries four `drupflare.*` routes and three menu
		 * links, and the shipped pack carries NONE of the seven while listing `drupflare` in
		 * `core.extension`. So the Drupflare admin section, Runtime Status and the Operations
		 * Terminal have answered 404 everywhere.
		 *
		 * The step above cannot reach it. `cache_container` is a cache and dropping it makes the next
		 * boot rediscover hooks; `router` is a TABLE that only `RouteBuilder` writes.
		 *
		 * A REAL END-STATE QUESTION rather than a recorded marker, and the ordering is why. `sql()`
		 * runs before `php()`, so a step that stamped a meta key in `sql()` would stamp it even when
		 * the rebuild threw, and the verdict afterwards would read the marker and file the failure as
		 * a success. Asking the router which of the pack's own routes it holds cannot lie that way.
		 *
		 * `DRIVER_ROUTES` is generated from the pack's own `*.routing.yml` files by
		 * `bun run assets:driver`, so it cannot drift from what shipped beside it.
		 */
		verdict(sql) {
			if (DRIVER_ROUTES.length === 0) return { state: 'satisfied' };
			const rows = count(sql, 'SELECT COUNT(*) AS n FROM router');
			if (rows === null) return { state: 'deferred', detail: 'no router table' };
			const placeholders = DRIVER_ROUTES.map(() => '?').join(', ');
			const have = count(
				sql,
				`SELECT COUNT(*) AS n FROM router WHERE name IN (${placeholders})`,
				...DRIVER_ROUTES
			);
			if (have === null) return { state: 'deferred', detail: 'router not readable' };
			if (have < DRIVER_ROUTES.length) {
				return {
					state: 'owed',
					detail: `${have} of ${DRIVER_ROUTES.length} driver routes present in ${rows} rows`
				};
			}
			// a row keeps the requirement it was built with, so a renamed permission is invisible
			// to the name count above and every existing site would demand the old one
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
			if (host.claimedAtMs() === null) {
				return { state: 'deferred', detail: 'never claimed, so there is no owner yet' };
			}
			const retired = rolesHoldingRetired(sql);
			if (retired === null) return { state: 'deferred', detail: 'no config table' };
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
			if (present === null)
				return { state: 'deferred', detail: 'sqlite_master not readable' };
			return present === 0
				? { state: 'satisfied' }
				: { state: 'owed', detail: `${present} unread node indexes present` };
		},
		// SQL rather than PHP: an index has no cached copy anywhere, and Drupal's own
		// `Schema::dropIndex()` checks for one before dropping, so a later schema update is unharmed
		sql(sql) {
			for (const index of UNREAD_NODE_INDEXES) sql.exec(`DROP INDEX IF EXISTS ${index}`);
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
export function reconciled(state: ReconcileState, recordedDriverDigest?: string | null): boolean {
	// THE DRIVER PACK MOVES WITHOUT `PACK_VERSION` MOVING, and that is what made every fix above
	// this line unreachable. `PACK_VERSION` is bumped by hand when a STEP is added; the packed
	// modules change on every sibling release. A site stamped at the current version short-circuited
	// here and no step's verdict was ever asked again -- so a route a newer pack declares stayed 404
	// on it forever, and the reconciliation designed to deliver exactly that never looked.
	//
	// One string compare against a value the caller already holds, so the steady state still asks no
	// SQL question of any step; it is the same `cfw_meta` read that feeds `state`.
	if (recordedDriverDigest !== undefined && recordedDriverDigest !== DRIVER_DIGEST) return false;
	return state.version >= PACK_VERSION && Object.keys(state.failed).length === 0;
}

/**
 * Whether any RECURRING step still owes this site work, whatever the version says.
 *
 * `reconciled()` is a two-integer comparison and deliberately asks no step anything, which is right
 * for a chain of one-shot migrations. It is wrong for the recurring pair, and a fresh site is the
 * case that proves it: provisioning stamps the driver digest because the packed modules and the
 * packed container come from one build, so both the version and the digest say "current" -- while
 * the ROUTER inside the packed database was baked from whatever module set existed when that
 * database was built. The two disagree and nothing was allowed to notice.
 *
 * Only recurring steps are asked, so the steady-state cost is their verdicts alone: one `SELECT
 * COUNT` over `router` and one meta compare. A one-shot step that has been applied stays untouched.
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
		// A RECURRING STEP IS NEVER RETIRED, and treating one as a one-shot migration is what made
		// a pack change unreachable on every already-reconciled site. Most steps here fix a defect
		// once and are done; `container-driver-digest` and `router-driver-routes` answer a question
		// whose ANSWER MOVES -- the packed modules change on every release, and their verdicts are
		// written to compare against the digest that ships today. Marking them applied short-circuits
		// the verdict before it can ever notice, so a site that reconciled against an older pack
		// skipped both forever: the routes a new pack adds were 404 on it and nothing said why.
		const settled = applied.has(step.id);
		if (settled && !step.recurring) continue;
		// a step that has spent its attempts stops owning the chain; it stays visible as `failed` on
		// the status report rather than being retried on every firing forever
		if ((state.failed[step.id]?.attempts ?? 0) >= STEP_ATTEMPT_LIMIT) continue;
		const verdict = step.verdict(sql, host);
		if (verdict.state === 'satisfied') {
			// already recorded, so there is nothing to write and the chain must move on rather than
			// re-marking it on every pass and never reporting `done`
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
