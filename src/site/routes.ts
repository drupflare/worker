import { IMAGE_ROUTE_PREFIX } from '../ops/image-runtime';
import { ADMIN_PAGES, LOGIN_PATH, LOGOUT_PATH, SURFACE_PREFIX } from '../ui/admin';

/**
 * Routes reachable without diagnostics and without a credential.
 *
 * `/firstrun` is trust-on-first-use: it mints the owner token that `/export` takes, so gating it on
 * diagnostics would force exposing `/sql`, `/restore` and `/php` just to obtain the token. The
 * claim window is the unprovisioned state only; once `first_run_at` is set the object answers 409
 * and `?force=1` needs the owner token or diagnostics (enforced in the object).
 *
 * `/setup/cf/callback` and `/oidc` arrive as provider redirects carrying no header drupflare
 * controls; `state` authenticates them (constant-time match against the pending record).
 */
export const PUBLIC_ROUTES = new Set([
	'/serve',
	'/firstrun',
	'/setup/cf/callback',
	'/githook',
	'/oidc',
	// sign-in cannot require the credential it collects (nor sign-out the cookie it removes)
	LOGIN_PATH,
	LOGOUT_PATH
]);

/**
 * Routes that must never be reachable without PW_DIAGNOSTICS.
 *
 * A threat model, not a menu: `/sql` runs arbitrary SQL, `/export` dumps the database, `/restore`
 * overwrites it from a body, `/savenode` writes content, `/migrate` and `/bump` can wipe the page
 * cache or re-run migration, `/nativefetch` reaches outbound. `/php` runs one fixed statement.
 *
 * `/migrate`, `/bump`, `/invalidate` and `/armfill` are owner routes too; the owner token is per
 * site where this flag is per deployment.
 */
const DIAGNOSTIC_ROUTES = new Set([
	'/php',
	'/opcache',
	// opens a connection to the external database the HYPERDRIVE binding names
	'/backend',
	'/probe',
	'/mb',
	'/migrate',
	'/driver',
	'/drupal',
	'/stats',
	'/sql',
	'/txnprobe',
	'/armfill',
	'/keepwarm',
	'/fill',
	'/assemble',
	'/plan',
	'/serve-stats',
	'/bump',
	'/export',
	'/restore',
	'/pitr',
	'/queue',
	'/savenode',
	'/writeworkload',
	'/capability',
	'/tcp',
	'/ai',
	'/git',
	'/httpdrain',
	'/nativefetch',
	'/invalidate',
	'/fillwindow',
	'/heap',
	'/bootphase',
	'/ops',
	'/installable',
	'/install',
	'/writes',
	'/replica',
	'/files',
	'/enable',
	'/fleet',
	'/health',
	'/setup/oidc'
]);

/**
 * Routes an OWNER reaches with a per-site token, without turning on diagnostics.
 *
 * A per-site token reaches these without `PW_DIAGNOSTICS=1`, which also exposes arbitrary SQL, a
 * whole-database overwrite and `/php`; taking your own data out (`/export`) must not need that.
 *
 * Most also stay in `DIAGNOSTIC_ROUTES`. `/updb` and `/modify` are owner-only: both change what the
 * site runs.
 */
export const OWNER_ROUTES = new Set([
	'/export',
	'/health',
	// cached paths, queue depth, recycles and the day's spend; owners read their own meters
	'/serve-stats',
	'/setup/cf',
	'/setup/mail',
	'/setup/oidc',
	'/git',
	// install and enable execute code the site did not ship with, so both take the owner token
	'/installable',
	'/install',
	'/enable',
	// site maintenance (cache purge, migration, fill); the owner token is per site, the flag is not
	'/armfill',
	'/invalidate',
	'/bump',
	'/migrate',
	// the update chain the alarm already runs; `site-do.ts` names "/updb" as its driver
	'/updb',
	// the operation registry, so `drangler` can list what a site can run without the flag
	'/ops',
	// recovery, only the half without a payload: `/restore` stays diagnostic-only because a body
	// names a state the caller invents, where a `/pitr` bookmark names one the platform holds
	'/pitr',
	// fleet reconciliation: reports what a site still owes and drives one step of it
	'/reconcile',
	// the addressable sweep; bounds what an indexer can make a site spend
	'/sweep',
	// recovery: a queue deeper than a batch resets the isolate inside the alarm (103 entries, every
	// render 500) where `recycleIfOversized()` cannot reach; draining is the lever
	'/queue',
	// uploaded module revisions, the delivery path with history
	'/modify',
	// runtime levers (the `plan` and `settings` KV keys)
	'/settings',
	// which site this deployment serves on an unmapped host; answered in the Worker (CONFIG_KV)
	'/deployment',
	// the product surfaces; `PW_DIAGNOSTICS` does not reach them (they install code)
	...ADMIN_PAGES.map((p) => p.path)
]);

/** an owner route that a browser reaches as a page, so a refusal is a redirect rather than a 401 */
export const SURFACE_ROUTES = new Set<string>(ADMIN_PAGES.map((p) => p.path));

/**
 * Every path this Worker answers.
 *
 * A route absent from here is rewritten to `/serve` and rendered as a Drupal page, so its query
 * (`?client_id=`) reaches the fill queue, the page cache and the edge key.
 */
export const ROUTES = new Set([...PUBLIC_ROUTES, ...DIAGNOSTIC_ROUTES, ...OWNER_ROUTES]);

/** a function, because workerd refuses a main-module export that is not a function or a class */
export function routeTable(): {
	doRoute: Readonly<Record<string, string>>;
	public: ReadonlySet<string>;
	diagnostic: ReadonlySet<string>;
	owner: ReadonlySet<string>;
	all: ReadonlySet<string>;
} {
	return {
		doRoute: DO_ROUTE,
		public: PUBLIC_ROUTES,
		diagnostic: DIAGNOSTIC_ROUTES,
		owner: OWNER_ROUTES,
		all: ROUTES
	};
}

/** the object-internal path each Worker route is forwarded to */
export const DO_ROUTE: Record<string, string> = {
	'/heap': '/__heap',
	'/bootphase': '/__bootphase',
	'/ops': '/__ops',
	'/installable': '/__installable',
	'/install': '/__install',
	'/writes': '/__writes',
	'/replica': '/__replica',
	'/files': '/__files',
	'/enable': '/__enable',
	'/php': '/__php',
	'/opcache': '/__opcache',
	'/backend': '/__backend',
	'/probe': '/__probe',
	'/mb': '/__mb',
	'/migrate': '/__migrate',
	'/driver': '/__driver',
	'/drupal': '/__drupal',
	'/stats': '/__stats',
	'/sql': '/__sql',
	'/txnprobe': '/__txnprobe',
	'/armfill': '/__armfill',
	'/keepwarm': '/__keepwarm',
	'/serve': '/__serve',
	'/setup/cf': '/__cfoauth',
	'/setup/mail': '/__mailonboard',
	'/setup/oidc': '/__oidcsetup',
	'/oidc': '/__oidc',
	'/setup/cf/callback': '/__cfoauth',
	'/fill': '/__fill',
	'/assemble': '/__assemble',
	'/plan': '/__plan',
	'/serve-stats': '/__serve-stats',
	'/bump': '/__bump',
	'/export': '/__export',
	'/restore': '/__restore',
	'/pitr': '/__pitr',
	'/queue': '/__queue',
	'/firstrun': '/__firstrun',
	'/savenode': '/__savenode',
	'/writeworkload': '/__writeworkload',
	'/capability': '/__capability',
	'/tcp': '/__tcp',
	'/ai': '/__ai',
	'/git': '/__git',
	'/githook': '/__githook',
	'/httpdrain': '/__httpdrain',
	'/nativefetch': '/__nativefetch',
	'/invalidate': '/__invalidate',
	'/health': '/__health',
	'/updb': '/__updb',
	'/reconcile': '/__reconcile',
	'/sweep': '/__sweep',
	'/modify': '/__modify'
};

/** paths a redirect must never capture (worker and object routes, the surface, derivatives) */
export const isReservedPath = (pathname: string): boolean =>
	pathname.startsWith('/__') ||
	ROUTES.has(pathname) ||
	pathname.startsWith(SURFACE_PREFIX) ||
	pathname.startsWith(`${IMAGE_ROUTE_PREFIX}/`);
