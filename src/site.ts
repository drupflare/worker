import { normaliseUri } from './db/file-store.js';
import type { SiteEnv } from './env.js';
import {
	adminCookieToken,
	adminSessionCookie,
	clearedAdminCookie,
	clearOwnerFailures,
	noteOwnerFailure,
	ownerFailKey,
	ownerRefusedForNow,
	secureOrigin
} from './ops/admin-session.js';
import {
	AUTH_MODE_HEADER,
	AUTH_REASON_HEADER,
	AUTH_REQUEST_HEADER,
	authAllowance,
	decideAuthMode,
	isAuthenticatedRequest,
	parseAuthSpend,
	ROLES_HEADER,
	secondsUntilUtcReset,
	sessionCookieValue,
	utcDayKey,
	type AuthBudgetEnv,
	type AuthSpend
} from './ops/auth-budget.js';
import { DEFAULT_MAX_BODY_BYTES } from './ops/body-limit.js';
import { isCacheTier } from './ops/cache-tiers.js';
import { ABSORBED_HEADER, ABSORBED_REPORT_MAX } from './ops/cold-encounter.js';
import {
	believedCsrf,
	believedGeneration,
	believedRoles,
	edgePlanEnabled,
	edgePlanKey,
	edgePlanRefused,
	forgetWitness,
	hasEdgePlan,
	isRedirectStatus,
	lookupEdgePlan,
	noteEdgeRender,
	planEligibility,
	privatePlanKey,
	readEdgePlan,
	readRedirectPlan,
	redirectPlanBody,
	rememberCsrf,
	rememberEdgeGeneration,
	rememberRoles,
	runEdgePlan,
	shouldCheckKv,
	storeEdgePlan,
	withDeadline,
	writeEdgePlan,
	type PlanTier
} from './ops/edge-plan.js';
import {
	ensureFleetTable,
	fleetSummary,
	listSites,
	rolloutProgress,
	warmTargets,
	type FleetDb,
	type FleetRow
} from './ops/fleet.js';
import { IMAGE_ROUTE_PREFIX, parseTransformPath, runImageTransform } from './ops/image-runtime.js';
import { callbackUri } from './ops/oidc.js';
import { lookupPageMemo, pageMemoHeaders, storePageMemo } from './ops/page-memo.js';
import {
	KV_GRANT_HEADER,
	pageKvEnabled,
	readPage,
	readStalePage,
	writePage,
	type PageKv
} from './ops/page-store.js';
import {
	canWriteKv,
	KV_OVERRIDABLE,
	resolvePlan,
	resolveSettings,
	withPlan,
	withSettings,
	writePlan,
	writeSettings,
	type PlanKv
} from './ops/plan.js';
import { sessionCsrf } from './ops/render-plan.js';
import {
	affinityKey,
	believedLanes,
	chooseTarget,
	LANES_HEADER,
	LANES_TRUST_MS,
	rememberLanes,
	REPLICA_HEADER,
	replicaCount,
	shouldFailover
} from './ops/replica-routing.js';
import { resolveSite, siteStubOptions } from './ops/site-id.js';
import { bearerToken } from './ops/site-secrets.js';
import { writeForwardEnabled } from './ops/write-forwarding.js';
import { SitePhpDurableObject } from './site-do.js';
import {
	ADMIN_PAGES,
	LOGIN_PATH,
	LOGOUT_PATH,
	parseDrush,
	renderAccess,
	renderCommands,
	renderDeploy,
	renderExtend,
	renderGit,
	renderLogin,
	renderOperate,
	renderShell,
	renderThresholds,
	SURFACE_PREFIX,
	type CfAccountStatus,
	type OidcSetupRow,
	type OpsEntry,
	type RemoteRow
} from './ui/admin.js';

export { RenderLane } from './ops/render-lane.js';
export { SitePhpDurableObject };

/**
 * Thin front end for the site Durable Object, plus the edge cache in front of it.
 *
 * The DO owns both the interpreter and the database, so this Worker runs no PHP:
 * anything it did with PHP would be in the wrong isolate, because
 * ctx.storage.sql is synchronous only from inside the DO and PHP's PDO is
 * blocking.
 *
 * What it owns is the tier above the DO. A `caches.default` hit costs no Durable Object request and
 * no Durable Object wall-clock -- two separately billed budgets -- and takes hit traffic off the
 * DO's single-threaded gate. It is also the only layer that scales across colos; DO storage is one
 * location.
 *
 * Routes are split by who may reach them. PUBLIC routes are the ones a visitor legitimately reaches
 * and are never gated; DIAGNOSTIC routes fail closed without PW_DIAGNOSTICS, because a diagnostic
 * that renders or profiles can permanently degrade the isolate it runs in.
 */
/**
 * Routes reachable without diagnostics and without a credential.
 *
 * `/firstrun` is here because provisioning is TRUST-ON-FIRST-USE, and the alternative was worse.
 * The owner token is minted by that run and is the credential `/export` takes, so while `/firstrun`
 * was diagnostic-gated the only way to obtain it was to first expose `/sql`, `/restore` and `/php`
 * to the internet -- which made "a customer can leave" reachable only by opening a remote shell.
 *
 * The claim window is the UNPROVISIONED state and nothing else. Once `first_run_at` is set the
 * object answers 409, and `?force=1` (which resets the admin password) requires the owner token or
 * diagnostics -- enforced in the Durable Object, where the secret actually lives.
 */
/**
 * `/setup/cf/callback` is PUBLIC because it cannot be anything else: it arrives as a redirect from
 * Cloudflare's consent screen carrying no header drupflare controls. The `state` parameter is what
 * authenticates it, matched constant-time against the pending record in the object. `/oidc` is
 * public for the same reason, and a `__`-prefixed path could not have served it.
 */
const PUBLIC_ROUTES = new Set([
	'/serve',
	'/firstrun',
	'/setup/cf/callback',
	'/githook',
	'/oidc',
	// the sign-in page cannot require the credential it exists to collect, and signing out cannot
	// require the cookie it exists to remove
	LOGIN_PATH,
	LOGOUT_PATH
]);

/**
 * Routes that must never be reachable without PW_DIAGNOSTICS.
 *
 * Read the list as a threat model rather than a menu. `/sql` runs arbitrary SQL, `/export` dumps the
 * whole database and `/restore` overwrites it from a body, `/savenode` writes content, `/migrate`
 * and `/bump` can wipe the page cache or re-run migration, and `/nativefetch` reaches outbound.
 * `/php` reports the interpreter version and the mount: one fixed statement, nothing caller-supplied.
 *
 * `/migrate`, `/bump`, `/invalidate` and `/armfill` are owner routes as well, which narrows nothing:
 * an owner token is per site where this flag is per deployment.
 */
const DIAGNOSTIC_ROUTES = new Set([
	'/php',
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
 * `/export` is the "a customer can leave" property, and a token is what makes it reachable without
 * `PW_DIAGNOSTICS=1` -- one boolean that also exposes arbitrary SQL, a whole-database overwrite and
 * `/php`. Taking your own data out should not require opening a remote shell first.
 *
 * Most of these stay in `DIAGNOSTIC_ROUTES` too, so the token is an additional way in rather than a
 * replacement. `/updb` and `/modify` are owner-only, because both change what the site runs.
 */
const OWNER_ROUTES = new Set([
	'/export',
	'/health',
	// what the object is actually doing: cached paths, queue depth, recycles, and the day's row and
	// request spend. Diagnostic-only meant a site owner could not read their own meters without the
	// flag that also opens `/sql`, which is the same trade `/export` was on
	'/serve-stats',
	'/setup/cf',
	'/setup/mail',
	'/setup/oidc',
	'/git',
	// EXTENSIBILITY, and it was half-delivered. `/git` could put a module's files on a site and
	// `/installable` could say whether a package was installable, and there was no route that
	// installed one and no route that turned one on -- `installPackage()` had no caller anywhere and
	// `/enable` was diagnostic-only. Both take the owner token because both execute code the site
	// did not ship with
	'/installable',
	'/install',
	'/enable',
	// SITE MAINTENANCE, which an owner could not perform on their own site. Clearing a cache,
	// re-running a migration and forcing a fill were reachable only with `PW_DIAGNOSTICS=1`, so the
	// supported way to purge your own page cache was to expose `/sql` to the internet first. An owner
	// token is the narrower credential: it is per site, where the flag is per deployment
	'/armfill',
	'/invalidate',
	'/bump',
	'/migrate',
	// the update chain the object already runs on its alarm, which nothing could drive or read.
	// `site-do.ts` refused a sliced `updb` operation by naming "/updb" as its driver while no such
	// route existed anywhere, which is a 501 pointing at a door that is not there
	'/updb',
	// The operation registry itself. It was diagnostic-only, so an owner token answered 404 and the
	// only reader was the Commands page reaching `/__ops` internally -- which meant `drangler`
	// could not list what a site can run without turning on the flag that also opens `/sql`.
	'/ops',
	// RECOVERY, and ONLY the half that does not take a payload. `/pitr` reads the platform's own
	// 30-day bookmark window and schedules a restore from it; its docblock says there is no
	// wrangler command and no dashboard button for that window, so without an owner-reachable
	// route an operator cannot recover a site at all.
	//
	// **`/restore` STAYS DIAGNOSTIC-ONLY and was promoted here for one commit before this comment
	// replaced it.** It replays SQL a caller supplies, which is the same shape as `/sql` rather
	// than the same shape as `/pitr`: a bookmark names a state the platform already holds, a body
	// names one the caller invents. `serve-edge.spec.ts` pins the pair and was right to.
	'/pitr',
	// FLEET RECONCILIATION. The pack delivers only at provisioning, so a fix that lands in it reaches
	// new sites and no existing one. This reports what a site still owes and drives one step of it
	'/reconcile',
	// The addressable sweep. Coverage was demand-driven, so nothing knew how much of a site was
	// covered and nothing bounded what an indexer could make it spend
	'/sweep',
	// The fill queue, and it is a RECOVERY route rather than a diagnostic one. A queue deeper than
	// a batch can survive resets the isolate inside the alarm, which leaves the queue at its old
	// depth and the next alarm attempting the same batch: measured on a deployed free worker at 103
	// entries, every render answering 500 across three redeploys. `recycleIfOversized()` cannot
	// reach it because it runs between invocations and the death is inside one. Draining the queue
	// is the only lever an operator has, and until now there was none
	'/queue',
	// Uploaded module revisions. `/git` delivers a tree from a git host and `/install` delivers one
	// from a registry; there was no way to deliver a tree that is on a developer's disk, and no
	// history behind either -- `gitRestore()` restores within the same call and then the previous
	// state is gone
	'/modify',
	// The runtime levers, which were readable from KV and writable by nobody. `resolvePlan()` and
	// `resolveSettings()` have read the `plan` and `settings` keys since they shipped, and nothing
	// in `src/` ever called `CONFIG_KV.put()` -- so changing a lever meant editing `wrangler.jsonc`
	// and redeploying, which is a deploy to change a fact the deploy does not control. Owner rather
	// than diagnostic for the reason `/serve-stats` is: a site owner tuning their own site should
	// not need the flag that also opens `/sql`
	'/settings',
	// The product surfaces, and they are the one part of this set that `PW_DIAGNOSTICS` does NOT
	// also reach. They used to sit in the diagnostic set alone, so the pages that install code were
	// open to anybody who could reach a worker with the flag on, and each button's
	// `window.prompt('Owner token')` was accepted without being checked against anything
	...ADMIN_PAGES.map((p) => p.path)
]);

/** an owner route that a browser reaches as a page, so a refusal is a redirect rather than a 401 */
const SURFACE_ROUTES = new Set<string>(ADMIN_PAGES.map((p) => p.path));

/**
 * Every path this Worker answers, and the reason `OWNER_ROUTES` is in the union.
 *
 * A route absent from here is rewritten to `/serve` and rendered as a Drupal page, so `/setup/cf`
 * and `/setup/mail` -- owner routes with `DO_ROUTE` entries, documented as live in three places --
 * were unreachable, and the request that tried carried `?client_id=` into the fill queue, the page
 * cache and the edge key as part of the path.
 */
const ROUTES = new Set([...PUBLIC_ROUTES, ...DIAGNOSTIC_ROUTES, ...OWNER_ROUTES]);

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

/**
 * Which object answers, with `?site=` refused on the routes that take no credential.
 *
 * The catch-all rewrite already refused the parameter and said why -- `customer-a.example/about?site=b`
 * must not serve customer B -- but that guard only covers paths this Worker does NOT own, and
 * `/serve` is in `PUBLIC_ROUTES`. So the one route reachable by anybody was the one with no check on
 * it: measured, `GET /serve?site=<a name nobody had used>` provisions an entire Drupal database from
 * one unauthenticated request, and a name belonging to another tenant serves their pages.
 *
 * An OWNER route may still name a site, because the object validates the token itself -- naming
 * somebody else's gets a 401 from them rather than their data. A diagnostic route may too, which is
 * what keeps `?site=` working for dev and for the measurement scripts.
 */
async function siteFor(url: URL, env: SiteWorkerEnv): Promise<string> {
	const uncredentialed = PUBLIC_ROUTES.has(url.pathname) && env?.PW_DIAGNOSTICS !== '1';
	const { site } = await resolveSite(url, env, { allowParam: !uncredentialed });
	return site;
}

/**
 * The owner token this request proved, or null.
 *
 * The token lives in the object's own `cfw_meta`, so the check costs one DO request -- which is why
 * it runs only after the route has been matched and only for a route that needs it. A browser
 * presents it as a cookie because a page cannot set a header on its own navigation; everything else
 * presents it as a bearer.
 */
async function ownerCredential(
	request: Request,
	env: SiteWorkerEnv,
	url: URL
): Promise<string | null> {
	const presented =
		bearerToken(request.headers.get('authorization')) ??
		adminCookieToken(request.headers.get('cookie'));
	if (!presented) return null;

	// Before the object hop, which is the whole point. Every presented token cost one Durable
	// Object request whether or not it was right, so an unauthenticated client could drive the
	// meter the free-plan model is scored against until the site went read-only. Refusing here
	// spends nothing. See `OWNER_FAIL_LIMIT` for why this is not a brute-force defence.
	const failKey = ownerFailKey(request);
	const now = Date.now();
	if (ownerRefusedForNow(failKey, now)) return null;

	const site = await siteFor(url, env);
	const stub = env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env));
	const inner = new URL(url);
	inner.pathname = '/__ownercheck';
	try {
		const res = await stub.fetch(
			new Request(inner, { headers: { authorization: `Bearer ${presented}` } })
		);
		if (res.status === 200) {
			// a correct token clears the budget, so an earlier typo never holds back the operator
			clearOwnerFailures(failKey);
			return presented;
		}
		noteOwnerFailure(failKey, now);
		return null;
	} catch {
		// an object that cannot answer has not said yes, and a migrating or quarantined site must
		// not become a site where the credential check is skipped.
		//
		// NOT counted as a failure: the credential may well be correct and the object merely
		// migrating or quarantined, and counting it would let an unreachable object lock its own
		// owner out of the routes they need to repair it
		return null;
	}
}

/**
 * Restates a cookie-borne token as a header for the object.
 *
 * `/__git` and `/__firstrun?force=1` check the token again where the secret lives, which is correct
 * -- a gate in front is a second place to get it right rather than the place it has to be right.
 * They read a header, so a request that arrived with only a cookie needs one attached.
 */
function withOwnerHeader(request: Request, token: string): Request {
	if (request.headers.has('authorization')) return request;
	// an inbound request's headers are immutable; a constructed one's are not
	const copy = new Request(request);
	copy.headers.set('authorization', `Bearer ${token}`);
	return copy;
}

const DO_ROUTE: Record<string, string> = {
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

/** how long an edge-cached page stays fresh, in seconds */
const EDGE_PAGE_TTL_S = 300;

/**
 * Width of the window the generation pointer is discovered once per, in ms.
 *
 * The Worker needs the generation to build a cache key, and asking the DO for it every request would
 * spend a DO request to save one. So the pointer is itself an edge-cache entry whose key contains the
 * window index: the first request in a window reads the generation off a response it had to fetch
 * anyway, and every later one reads the pointer for free.
 *
 * Bucketed rather than left to `max-age` expiry, because Cloudflare applies its own minimum TTLs and
 * a pointer outliving its window would serve a stale generation indefinitely.
 *
 * Costs at most one extra DO request per window per colo, independent of traffic. A bump reaches
 * other colos within two windows; the bumping colo sees it immediately.
 */
const GEN_BUCKET_MS = 5000;

/** how long the pointer entry itself may live; only has to outlive its window */
const GEN_POINTER_TTL_S = 60;

/**
 * Isolate-local memo of the generation pointer, keyed by site and window.
 *
 * Holds nothing but an integer this isolate already read from the shared pointer,
 * and every entry is window-scoped, so staleness is bounded by GEN_BUCKET_MS
 * rather than by the isolate's lifetime.
 */
const genMemo = new Map<string, number>();

/**
 * Paths Drupal can never legitimately serve, refused in JS before any DO hop.
 *
 * A storage fix rather than a saving. `PageCache` writes one PERMANENT `cache_data` row per distinct
 * URL, about 215 B, and nothing collects it: expire-based GC only deletes rows with a finite expire.
 * So a scanner walking `/.env`, `/wp-login.php`, `/.git/config` writes a permanent row per probe --
 * attacker-influenceable unbounded growth against a 5 GB account-wide limit.
 *
 * A DENY list rather than the router's own path table, because a manifest of real routes cannot be
 * authoritative at the edge: path aliases live in `path_alias` and are created at runtime, so
 * `/about` is valid and appears in no packed table. These patterns match only what Drupal has no
 * route for under any configuration, which is what lets this run before the DO rather than after.
 */
const NEVER_DRUPAL = [
	/\.(?:env|git|sql|bak|old|swp|ini|log|sh|yml~|zip|tar|gz|tgz|rar|7z)$/i,
	/(?:^|\/)\.(?:git|env|aws|ssh|svn|hg|DS_Store)(?:\/|$)/i,
	/(?:^|\/)wp-(?:admin|login|content|includes|config)/i,
	/\.php$/i, // Drupal's own entry point is /index.php, which never reaches here as a route
	/(?:^|\/)(?:phpmyadmin|pma|adminer|vendor\/phpunit|\.well-known\/security\.txt\.bak)/i,
	/(?:^|\/)(?:config|backup|dump|db)\.(?:json|xml|txt)$/i
];

/**
 * The largest non-file request body that may reach the interpreter, in bytes.
 *
 * 2 MiB, and it is a heap guard rather than a bandwidth one: `parse_str()` on a form body allocates
 * inside a 128 MB isolate, and `foo[][][][][]=bar` repeated turns a few hundred kilobytes of wire
 * into orders of magnitude more of it. Drupal's own `post_max_size` default is 8 MB, so this is
 * tighter, because there is no separate process to lose here.
 */

/** what the guard decided, or null when the request may proceed */
export interface BodyTooLarge {
	limit: number;
	declared: number;
	reason: string;
}

/**
 * Whether a request body is too large to hand to PHP.
 *
 * READS `Content-Length` AND NOTHING ELSE, which is the only check available before the body has
 * been consumed -- and consuming it to measure it is the cost the guard exists to avoid. A chunked
 * request declares none and falls through; the object's own limits still apply to it.
 *
 * A `multipart/form-data` body is EXEMPT. That is the file-upload shape, where size is expected,
 * and it is not `parse_str()`d into a nested array -- so the memory-bomb argument does not apply
 * to it and a 2 MiB cap on uploads would be a functional regression rather than a guard.
 *
 * @param env - `MAX_BODY_BYTES` overrides the default; `0` disables the guard entirely
 */
export function bodyTooLarge(
	request: Request,
	env?: { MAX_BODY_BYTES?: string | number | null }
): BodyTooLarge | null {
	const method = request.method.toUpperCase();
	if (method === 'GET' || method === 'HEAD') return null;

	const raw = Number(env?.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES);
	const limit = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_MAX_BODY_BYTES;
	if (limit === 0) return null;

	const type = request.headers.get('content-type') ?? '';
	if (type.toLowerCase().includes('multipart/form-data')) return null;

	const declared = Number(request.headers.get('content-length') ?? '');
	if (!Number.isFinite(declared) || declared <= limit) return null;

	return {
		limit,
		declared,
		reason: `request body of ${declared} bytes exceeds the ${limit} byte limit`
	};
}

/**
 * Where a core PHP entry point should send a visitor instead of a bare 404.
 *
 * `/update.php` and `/install.php` are matched by the `\.php$` deny pattern with every scanner
 * probe, so they answered `not found` in plain text. **Drupal's own admin UI links to
 * `/update.php`** -- the Extend page says "Always run the update script each time you update
 * software" -- so a site administrator following a link core rendered met a bare 404 that did not
 * even look like the site.
 *
 * A redirect rather than a rewrite: neither script exists here and neither can. Installation is
 * provisioning, which has already happened by the time anything can be requested, and the database
 * update chain is host-driven through the operations surface rather than through a web script. So
 * the honest answer is to send the visitor to the page that does the job.
 *
 * Only the paths core actually links are listed. Everything else ending in `.php` is a scanner and
 * keeps the cheap deny, which is what protects the permanent `cache_data` row per distinct URL.
 */
const PHP_ENTRY_REDIRECTS: Record<string, string> = {
	'/update.php': '/admin/config/drupflare/status',
	'/core/update.php': '/admin/config/drupflare/status',
	'/install.php': '/',
	'/core/install.php': '/',
	// cron is driven by the alarm chain on a schedule, so there is nothing for a visitor to trigger
	'/cron.php': '/admin/config/drupflare/status',
	'/core/cron.php': '/admin/config/drupflare/status'
};

/** the redirect target for a core entry point, or null when the path is an ordinary deny */
export function phpEntryRedirect(pathname: string): string | null {
	return PHP_ENTRY_REDIRECTS[pathname.toLowerCase()] ?? null;
}

/**
 * True when the path cannot be a Drupal route under any configuration.
 *
 * The query string is stripped first, and that is a fix rather than a tidy-up. Four of the six
 * patterns are `$`-anchored, and the only caller reads `?path=`, which the catch-all builds as
 * `url.pathname + url.search` -- so `/.env` was refused and `/.env?x=1` walked straight through
 * into a Durable Object hop and the permanent `cache_data` row this deny list exists to prevent.
 * Appending a parameter is the first thing a scanner does.
 */
export function isNeverDrupal(pathname: string): boolean {
	const bare = pathname.split(/[?#]/, 1)[0] ?? pathname;
	return NEVER_DRUPAL.some((re) => re.test(bare));
}

/** the string half of a cache key; `cacheKey()` is the same identity as a `Request` */
const cacheKeyUrl = (origin: string, parts: string[]) =>
	`${origin}/__cfw/${parts.map(encodeURIComponent).join('/')}`;

const cacheKey = (origin: string, parts: string[]) =>
	new Request(cacheKeyUrl(origin, parts), { method: 'GET' });

const genKey = (origin: string, site: string, bucket: number) =>
	cacheKey(origin, ['gen', site, String(bucket)]);

/**
 * The page cache key AS A STRING, which is what the isolate memo is keyed on.
 *
 * Split from {@link pageKey} because the memo is consulted FIRST and a `Request` is a URL parse
 * plus an object the memo never reads -- so a MEM hit, which is the tier answering almost all of
 * this path, was allocating a Request to throw it away. The two cannot drift: `pageKey()` is this
 * string handed to `new Request`.
 */
const pageKeyUrl = (origin: string, site: string, generation: number, path: string) =>
	cacheKeyUrl(origin, ['page', String(generation), site, path]);

const pageKey = (origin: string, site: string, generation: number, path: string) =>
	new Request(pageKeyUrl(origin, site, generation, path), { method: 'GET' });

/**
 * Page requests this isolate has answered, per site, waiting for a hop to carry the count in.
 *
 * The object cannot see a plan hit, an isolate memo hit, a `caches.default` hit or a KV page read,
 * because all four return from here -- and they are most of the traffic, so a cold-boot share taken
 * against what reached the object is a share of the leftovers. This rides on the next inner request,
 * which is a hop already paid for: the same trade as the generation pointer and the auth-spend
 * counter beside it.
 *
 * An isolate that dies before hopping loses its count. That biases the denominator DOWN and the
 * reported cold rate UP, which is the direction a missing reading has to fail in.
 */
const absorbedSinceHop = new Map<string, number>();

/** the key is a resolved hostname, so the map is bounded the way `adminSessionBudget()`'s is */
const ABSORBED_SITES_MAX = 1024;

function noteAbsorbed(site: string): void {
	if (absorbedSinceHop.size >= ABSORBED_SITES_MAX && !absorbedSinceHop.has(site)) return;
	absorbedSinceHop.set(
		site,
		Math.min(ABSORBED_REPORT_MAX, (absorbedSinceHop.get(site) ?? 0) + 1)
	);
}

/** what to report on a hop, excluding the hopping request itself -- the object counts that one */
function drainAbsorbed(site: string, self: boolean): number {
	const held = absorbedSinceHop.get(site) ?? 0;
	absorbedSinceHop.delete(site);
	return Math.max(0, held - (self ? 1 : 0));
}

/**
 * A generation, or null. Never a number that is not one.
 *
 * `Number(null)` is 0, not NaN, so reading a missing header straight into
 * Number() produced a perfectly finite generation 0 -- and one request to a route
 * that does not report a generation was enough to overwrite the pointer with 0 and
 * make every later edge lookup build a key nothing was ever stored under. Caught
 * by the integration test, which watched a HIT refuse to become an EDGE hit
 * whenever a /serve-stats call sat between two serves.
 */
function asGeneration(raw: string | null | undefined): number | null {
	if (raw === null || raw === undefined || raw === '') return null;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function rememberGeneration(site: string, bucket: number, generation: number): void {
	// bounded by traffic within one window; a clear is cheaper than an LRU here
	if (genMemo.size > 64) genMemo.clear();
	genMemo.set(`${site}#${bucket}`, generation);
}

async function readGeneration(
	cache: Cache,
	origin: string,
	site: string,
	bucket: number
): Promise<number | null> {
	const memo = genMemo.get(`${site}#${bucket}`);
	if (memo !== undefined) return memo;
	const hit = await cache.match(genKey(origin, site, bucket));
	if (!hit) return null;
	const n = asGeneration((await hit.text()).trim());
	if (n === null) return null;
	rememberGeneration(site, bucket, n);
	return n;
}

/**
 * The lane-count pointer, at the edge rather than only in this isolate's memory.
 *
 * `believedLanes()` is learned from an `x-cfw-lanes` header on a response the isolate has ALREADY
 * received, so a cold isolate routes its first request to the primary whatever the pool size, and
 * forgets again after `LANES_TRUST_MS`. Workers spawn isolates continuously, so under real spread
 * load most requests arrive at an isolate that has never seen the pool -- and after a deploy, none
 * of them has. Measured on a deployed 32-lane site: the primary's own `serveRequests` counter moved
 * by 904 across a 904-request drive, so the pool served none of it, and an anonymous drive reported
 * `answeredBy` as `{primary: 904}`.
 *
 * Same shape as the generation pointer above and for the same reason: a value every isolate can
 * read before it decides anything, rather than one each isolate has to rediscover.
 */
function laneKey(origin: string, site: string): string {
	return `${origin}/__cfw/lanes/${encodeURIComponent(site)}`;
}

/**
 * How long the EDGE pointer lives, deliberately far longer than {@link LANES_TRUST_MS}.
 *
 * The two answer different questions and tying them together collapsed a pool under exactly the
 * load it exists for. In-isolate belief is short so a SHRUNK pool stops being routed to quickly.
 * The edge pointer is a hint, and the two ways it can be wrong are not symmetric:
 *
 * - **stale-high** (the pool shrank): a request hashes to a lane that no longer serves, the lane
 *   refuses, and the router retries the primary. One wasted hop, on a path that already exists.
 * - **stale-absent** (the pointer expired): every cold isolate believes there is no pool at all and
 *   sends everything to the primary, which is the whole pool lost.
 *
 * Measured 2026-09-19: a 32-lane site answered 294 requests with **zero** served by lanes while all
 * sampled lanes were `SERVING` and a manual request routed to `r30`. Under saturation the primary
 * sheds, a shed answer carried no `x-cfw-lanes`, so nothing refreshed the pointer inside 60 s, and
 * the pool went invisible precisely when it was needed. The shed path now carries the header too,
 * which is the other half of this fix.
 */
const LANE_POINTER_TTL_S = 900;

/**
 * Seeds this isolate's belief from the edge, so the FIRST request routes on it.
 *
 * @internal exported for `replica-failover.spec.ts`, which cannot reach it through a request: the
 * primary memoises `lanesProvisioned()` per incarnation, so a fixture cannot make it report a pool
 * it did not actually provision.
 */
export async function primeLanes(cache: Cache, origin: string, site: string): Promise<void> {
	if (believedLanes(site, Date.now()) > 0) return;
	try {
		const hit = await cache.match(laneKey(origin, site));
		if (!hit) return;
		const n = Number((await hit.text()).trim());
		if (Number.isFinite(n) && n > 0) rememberLanes(site, n, Date.now());
	} catch {
		// no pointer just means this isolate learns from the response the way it always did
	}
}

/** publishes what the primary reported, so the next cold isolate does not have to ask; @internal */
export async function writeLanes(
	cache: Cache,
	origin: string,
	site: string,
	lanes: number
): Promise<void> {
	try {
		await cache.put(
			laneKey(origin, site),
			new Response(String(lanes), {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'cache-control': `public, max-age=${LANE_POINTER_TTL_S}`
				}
			})
		);
	} catch {
		// the pointer is an optimisation; routing still works off the header
	}
}

async function writeGeneration(
	cache: Cache,
	origin: string,
	site: string,
	bucket: number,
	generation: number
): Promise<void> {
	rememberGeneration(site, bucket, generation);
	try {
		await cache.put(
			genKey(origin, site, bucket),
			new Response(String(generation), {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'cache-control': `public, max-age=${GEN_POINTER_TTL_S}`
				}
			})
		);
	} catch {
		// no pointer just means the next request in this window re-learns from the DO
	}
}

// #region the authenticated allowance, memoised so degrading costs no DO request
//
// Same trick as the generation pointer, and for the same reason: the Worker has to know how much of
// the authenticated allowance is gone BEFORE it decides whether to hop to the object, and asking the
// object would spend the DO request the reservation exists to protect. So the object reports the
// counter on the response to a hop that was happening anyway, and this memoises it per UTC day --
// the day the quotas actually reset on.
//
// Once the memo says the allowance is spent, every later authenticated request degrades at the edge
// with ZERO DO cost. That is the only version of this that protects the meter rather than measuring it.

/** isolate-local, keyed by site and UTC day, so a re-read costs nothing */
const authMemo = new Map<string, AuthSpend>();

const authKey = (origin: string, site: string, day: string) =>
	cacheKey(origin, ['authbudget', site, day]);

/** how long a spend record may sit at the edge; only has to outlive the UTC day it names */
const AUTH_SPEND_TTL_S = 3600;

async function readAuthSpend(
	cache: Cache,
	origin: string,
	site: string,
	now: number
): Promise<AuthSpend | null> {
	const day = utcDayKey(now);
	const memo = authMemo.get(`${site}#${day}`);
	if (memo !== undefined) return memo;
	try {
		const hit = await cache.match(authKey(origin, site, day));
		if (!hit) return null;
		const parsed = JSON.parse(await hit.text()) as AuthSpend;
		// a record naming another day is not this day's budget; discard rather than carry it across
		if (!parsed || parsed.day !== day || !Number.isFinite(parsed.renders)) return null;
		authMemo.set(`${site}#${day}`, parsed);
		return parsed;
	} catch {
		// an unreadable record degrades to "not known yet", which renders rather than refusing
		return null;
	}
}

async function writeAuthSpend(
	cache: Cache,
	origin: string,
	site: string,
	spend: AuthSpend
): Promise<void> {
	if (authMemo.size > 64) authMemo.clear();
	authMemo.set(`${site}#${spend.day}`, spend);
	try {
		await cache.put(
			authKey(origin, site, spend.day),
			new Response(JSON.stringify(spend), {
				headers: {
					'content-type': 'application/json',
					'cache-control': `public, max-age=${AUTH_SPEND_TTL_S}`
				}
			})
		);
	} catch {
		// no record just means the next request re-learns it from the object
	}
}
// #endregion

/**
 * Stores a rendered page at the edge, or says why it did not.
 *
 * Only a real page is eligible: the guard is `status !== 200`, so the warming placeholder (a 503
 * with Retry-After) and every other non-200 is refused. Caching a placeholder is how a site serves
 * placeholders forever.
 *
 * `cache.put()` rejects several header combinations (206 responses, `Vary: *`, `Set-Cookie` without
 * a matching `Cache-Control: private=set-cookie`), so the stored copy is built from an explicit
 * allow-list rather than from whatever the DO sent, and a rejection degrades to "no edge cache"
 * instead of failing the request.
 *
 * Every refusal is synchronous and the write is not, so this returns the write rather than awaiting
 * it: an awaited `cache.put` of a 97 KB body costs 12.5 ms before the response leaves, and the same
 * put handed to `waitUntil` costs 0. A stored page reports `deferred`, because "it was handed off"
 * is what this function knows and "it landed" is not.
 *
 * @returns an x-cfw-edge-put value, and the write to defer when there is one
 */
function putPage(
	cache: Cache,
	origin: string,
	site: string,
	path: string,
	res: Response,
	generation: number | null,
	doCache: string,
	isAuthenticated: boolean
): { outcome: string; write?: Promise<unknown> } {
	const refused = (outcome: string) => ({ outcome });
	if (res.status !== 200) return refused(`skipped:${res.status}`);
	if (doCache !== 'HIT' && doCache !== 'RENDER') return refused(`skipped:${doCache}`);
	if (generation === null) return refused('skipped:no-generation');
	// a structural refusal, not a cookie-pattern check. The shared key has no user in it, so a personalised
	// response stored under it is served to the next anonymous visitor -- and this project has
	// shipped exactly that: a render that kept uid 1 landed in the anonymous page cache at 90,038
	// bytes against 12,296. Two independent signals, because either one alone can be wrong: the
	// caller says the REQUEST was authenticated, and Set-Cookie says the RESPONSE is per-user.
	// The header allow-list below would silently drop Set-Cookie, which makes the stored copy look
	// anonymous while carrying somebody's page, so this refuses before that can happen.
	if (isAuthenticated) return refused('skipped:authenticated');
	if (res.headers.has('set-cookie')) return refused('skipped:set-cookie');

	const headers = new Headers({
		'content-type': res.headers.get('content-type') ?? 'text/html; charset=utf-8',
		'cache-control': `public, max-age=${EDGE_PAGE_TTL_S}`,
		'x-cfw-do-cache': doCache,
		'x-cfw-generation': String(generation)
	});
	for (const h of ['x-cfw-render-ms', 'x-cfw-rendered-at']) {
		const v = res.headers.get(h);
		if (v !== null) headers.set(h, v);
	}

	// cloned HERE rather than inside the deferred write: the body below is returned to the caller and
	// a clone taken after the response has been consumed is empty
	const copy = new Response(res.clone().body, { status: 200, headers });
	// **Seeding the isolate memo from here was tried and reverted.** The memo only ever warms from a
	// `caches.default` HIT, so the isolate that just produced a page pays one `cache.match` on its
	// next request for it. Seeding it here removes that read -- ONCE per isolate per page, after
	// which the memo is warm either way -- and in exchange the EDGE tier stops being observable
	// within an isolate at all: `serve-edge.spec.ts` polls for `x-cfw-cache: EDGE` and gets `MEM`
	// forever, because `edge=0` declines the memo and the cache together. A 0.65 ms read taken once
	// is not worth a tier nobody can see; the three tiers being distinguishable is what that spec
	// exists for. Do not re-propose without a lever that separates the two.
	return {
		outcome: 'deferred',
		// a rejection degrades to "no edge cache", the same as the awaited version did
		write: cache.put(pageKey(origin, site, generation, path), copy).catch(() => undefined)
	};
}

export default {
	async fetch(request: Request, env: SiteWorkerEnv, ctx?: ExecutionContext): Promise<Response> {
		let url = new URL(request.url);
		// Started here rather than after the route match, because the two KV reads below and the
		// catch-all's site resolution sat in front of it -- so `x-worker-ms` reported a front worker
		// that had already spent 8-12 ms on a cold isolate and left it out of its own number
		const t0 = Date.now();
		// ISSUED TOGETHER, because they read two keys from one namespace and neither needs the other's
		// answer. Measured on a deployed worker: a WARM `CONFIG_KV.get()` costs 4-6 ms, ten in series
		// cost 54.5 ms and the same ten together cost 15. A key the colo has not seen costs 46-140 ms
		// THE TENANT THIS REQUEST BELONGS TO, for scoping the two KV documents.
		//
		// **NOT `siteFor(url, env)` HERE, and the difference is a privilege boundary.** That helper
		// honours `?site=` on any path outside `PUBLIC_ROUTES`, and it is called further down
		// AFTER the catch-all rewrite has set `url.pathname` to `/serve`, which is public. Called
		// here, before the rewrite, an ordinary page path is not in the set -- so a visitor's own
		// `?site=` would have chosen which tenant's levers this request runs under.
		// `serve-edge.spec.ts` catches exactly that.
		const { site: resolvedSite } = await resolveSite(url, env, { allowParam: false });
		const [plan, settings] = await Promise.all([
			// resolved ONCE and overlaid, so the 16 `isPaid(env)` call sites downstream need no change
			// and cannot disagree with each other about which plan this request is on
			resolvePlan(env, env.CONFIG_KV, Date.now(), resolvedSite),
			// the numeric levers ride the same namespace, behind an allow-list: KV is operator-writable,
			// so a blanket merge would let a KV write set PW_DIAGNOSTICS and reach /sql and /restore
			resolveSettings(env.CONFIG_KV, Date.now(), resolvedSite)
		]);
		env = withSettings(withPlan(env, plan), settings);
		// A write that nothing downstream reads does not belong before the response. Measured on a
		// deployed worker: an awaited `caches.default.put` costs 9 ms for a small body and 12.5 ms for
		// a 97 KB one, and the same put through `waitUntil` costs 0 before the response leaves. It
		// does not reduce the invocation's billed wall time, only the time to answer.
		const defer = (p: Promise<unknown> | undefined) => {
			if (p === undefined) return;
			if (ctx) ctx.waitUntil(p);
			else void p;
		};

		// Drupal owns the URL space, so anything this Worker does not claim is a page request. Before
		// this, `/` answered 404 on a deployed site as well as locally -- the only serving route was
		// `/serve?site=X&path=Y`, so the premise of the product was reachable only by query string.
		//
		// A REWRITE, not a second serving path: the request becomes the `/serve` it would have been,
		// and every tier below -- the edge cache key, the generation counter, the KV page tier, the
		// DO hop -- is reached unchanged. `inner` downstream is built from `request.url` rather than
		// from `url`, which is why the REQUEST is replaced and not just the parsed copy.
		// `__`-prefixed paths are the DURABLE OBJECT's own routes, double-underscored precisely so they
		// cannot collide with a Drupal path once this front end forwards real requests. They must stay
		// a 404 from outside: rewriting them into a page render would answer a probe for `/__export`
		// with a render rather than a refusal, which reads as "the route exists and something went
		// wrong" instead of "there is no such route here"
		const internal = url.pathname.startsWith('/__');
		// set by the catch-all rewrite below, whose `?site=` is the site resolved above
		let pageRequest = false;
		// Image derivatives, answered here. In the front worker rather than in the object for two
		// reasons: the wasm decoder never meets PHP's heap, and a derivative is a static byte range
		// that has no reason to enter a single-threaded object at all. Before the `/serve` rewrite,
		// because this path is its own route rather than a Drupal one
		if (!internal && url.pathname.startsWith(`${IMAGE_ROUTE_PREFIX}/`) && ctx !== undefined) {
			return serveImageTransform(request, url, env, ctx);
		}
		if (
			!internal &&
			ctx !== undefined &&
			publicFileUri(request.method, url.pathname) !== null
		) {
			const served = await servePublicFile(request, url, env, ctx);
			if (served !== null) return served;
		}

		if (!internal && !ROUTES.has(url.pathname)) {
			// `allowParam: false` because THIS query string is the visitor's. Without it,
			// `https://customer-a.example/about?site=customer-b` resolves to customer B and serves
			// their database from customer A's hostname -- the origin rewrite below keeps the
			// parameter out of `/serve`'s own arguments and does nothing about which object answers.
			// The site resolved at the top already is that answer: same URL, same flag
			const rewritten = new URL(url.origin);
			rewritten.pathname = '/serve';
			rewritten.searchParams.set('site', resolvedSite);
			pageRequest = true;
			// built from the ORIGIN, so the visitor's own query cannot land among /serve's parameters
			// -- `/about?site=someone-else` would otherwise choose which site answers. The query is
			// preserved where Drupal wants it, inside `path`
			rewritten.searchParams.set('path', url.pathname + url.search);
			request = new Request(rewritten, request);
			url = rewritten;
		}

		if (!ROUTES.has(url.pathname)) {
			return new Response('not found\n', { status: 404 });
		}
		// The admin surface is not a diagnostic, so the flag is not a way into it. Everywhere else
		// `PW_DIAGNOSTICS=1` still opens what it always opened
		const surface = SURFACE_ROUTES.has(url.pathname);
		let ownerToken: string | null = null;
		if (surface || (!PUBLIC_ROUTES.has(url.pathname) && env?.PW_DIAGNOSTICS !== '1')) {
			// An owner route is not A DIAGNOSTIC. `/export` sat in the diagnostic set beside `/sql`
			// (arbitrary SQL) and `/restore` (a whole-database overwrite), all behind one boolean --
			// so the supported way to get your own data out was to expose a remote shell to the
			// internet first. Export is an owner operation and takes a credential instead of a mode.
			if (OWNER_ROUTES.has(url.pathname)) {
				ownerToken = await ownerCredential(request, env, url);
				if (ownerToken === null) {
					if (surface) {
						// a browser gets the sign-in page, not a 401 body it would render as text
						const to = new URL(LOGIN_PATH, url.origin);
						to.searchParams.set('next', url.pathname + url.search);
						return new Response(null, {
							status: 302,
							headers: { location: to.toString(), 'cache-control': 'no-store' }
						});
					}
					// 401 with a challenge rather than the 404 a diagnostic gets: this route EXISTS
					// and the caller is entitled to it, they just have not proved who they are
					return new Response('owner token required\n', {
						status: 401,
						headers: {
							'www-authenticate': 'Bearer realm="drupflare"',
							'content-type': 'text/plain; charset=utf-8'
						}
					});
				}
				request = withOwnerHeader(request, ownerToken);
			} else {
				return new Response('not found\n', { status: 404 });
			}
		}

		// one object per site; the name is the site identity, and a replica lane is that name plus a
		// suffix. With no replicas configured `chooseTarget()` always answers the site itself
		// a rewritten page request carries the site this handler resolved at the top, so asking again
		// would read back its own parameter; only a route addressed directly resolves here
		const site = pageRequest ? resolvedSite : await siteFor(url, env);
		// The visitor's own path, which `url.pathname` no longer holds: the rewrite above moved it
		// into `?path=` and made every serving request read `/serve`. So the path fallback in
		// `affinityKey()` -- what a request with no session and no `cf-connecting-ip` spreads on --
		// was one constant string, and every such request piled onto whichever lane it hashes to.
		// The query is dropped so a page is one key however a visitor arrived at it
		const visitorPath = (url.searchParams.get('path') ?? url.pathname).split('?')[0] as string;
		// LAZY, because the tier that answers 82% of traffic never reads either of them. Choosing a
		// lane allocates an affinity input, a decision and a copy of it; the stub then costs a
		// native hash to a 256-bit id, a `DurableObjectId` and a stub object -- all of it upstream
		// of an edge or memo hit that returns without touching the object at all. Both are memoised
		// on first read, so every path that does need them sees one construction and the same
		// values, and the routing decision still happens before any request reaches an object.
		let laneMemo: ReturnType<typeof chooseTarget> | null = null;
		// ONCE. It was read twice inside the same object literal -- for the affinity key and for
		// `hasSession` -- and the read is a regex over the whole cookie header, on the path that
		// runs for every request that reaches an object
		const sessionValue = sessionCookieValue(request.headers.get('cookie'));
		const laneOf = (): ReturnType<typeof chooseTarget> =>
			(laneMemo ??= chooseTarget({
				site,
				method: request.method,
				affinity: affinityKey({
					session: sessionValue,
					address: request.headers.get('cf-connecting-ip'),
					pathname: visitorPath
				}),
				// an operator's REPLICA_COUNT is a floor and what the primary has actually built is
				// the other half; autoscaling grew lanes nothing routed to until this read the second
				replicas: Math.max(replicaCount(env), believedLanes(site, t0)),
				// after the rewrite above, so a visitor path reads as `/serve` and a diagnostic or
				// owner route reads as itself; those pin to the primary
				pathname: url.pathname,
				writeForward: writeForwardEnabled(env),
				// a write arriving without one may MINT one, and a lane's mint never reaches the
				// primary; see the docblock on the field
				hasSession: sessionValue !== null,
				visitorPath,
				contentType: request.headers.get('content-type')
			}));
		let stubMemo: DurableObjectStub | null = null;
		const stubOf = (): DurableObjectStub =>
			(stubMemo ??= env.SITE.get(env.SITE.idFromName(laneOf().target), siteStubOptions(env)));

		const cache = caches.default;
		const origin = url.origin;
		const bucket = Math.floor(Date.now() / genBucketMs(env));
		// only the serving path is cacheable, and only for a safe method
		const serving = url.pathname === '/serve' && request.method === 'GET';
		// Worker-side, not a DO route: the window driver has to live outside the object
		// because the CPU budget resets on an INCOMING message and an object cannot send
		// itself one
		if (url.pathname === '/fillwindow') {
			return Response.json(
				await runFillWindow(env, site, {
					maxFills: url.searchParams.get('max')
						? Number(url.searchParams.get('max'))
						: undefined,
					wallBudgetMs: url.searchParams.get('wall')
						? Number(url.searchParams.get('wall'))
						: undefined
				})
			);
		}

		// #region the product surfaces
		//
		// Server-rendered, no client framework and no build step. They live in the Worker rather than
		// behind the object because three of the four need no PHP at all -- Limits is arithmetic,
		// Deploy is a static requirement list, and Extend proxies one route.
		// `/fleet` rides here rather than through DO_ROUTE, because it is answered from D1 without
		// touching an object. It is named explicitly: it has no DO_ROUTE entry, so falling through
		// sent `undefined` as the inner pathname and the inventory answered 404 to every caller,
		// including `scripts/security-update.mjs --fleet=`
		// `/settings` rides here for the same reason `/fleet` does: `CONFIG_KV` is a FRONT WORKER
		// binding, so an object hop would spend a Durable Object request to reach a namespace this
		// isolate already holds. It has no `DO_ROUTE` entry for that reason.
		if (url.pathname === '/settings') {
			return await settingsRoute(request, url, env);
		}

		if (url.pathname.startsWith(SURFACE_PREFIX) || url.pathname === '/fleet') {
			return await renderAdmin(request, url, env, stubOf(), ownerToken);
		}

		const path = url.searchParams.get('path') ?? '/';

		// Refused here rather than in the Durable Object, because reaching the DO is what
		// costs: one DO request, and a PERMANENT cache_data row per distinct URL that
		// nothing garbage-collects. On a public site most traffic is scanners, so this is
		// an oversized body is refused before it reaches wasm, and the interesting case is not a
		// large file. A form body is `parse_str()`d inside a 128 MB isolate, and a nested-array
		// bomb -- `foo[][][][][]=bar` repeated -- costs orders of magnitude more heap than it does
		// bytes on the wire. Refusing at the edge costs no DO request and no interpreter, and a
		// multipart upload is exempt because that is the one shape where size is expected.
		const oversized = bodyTooLarge(request, env);
		if (oversized !== null) {
			return new Response(`${oversized.reason}\n`, {
				status: 413,
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'cache-control': 'no-store',
					'x-cfw-deny': 'body-too-large',
					'x-cfw-body-limit': String(oversized.limit)
				}
			});
		}

		// ONE SCAN, not two. It is a `split(/[?#]/)` plus up to six regex tests, and it ran here and
		// again on the authenticated check below over the same string for the same answer
		const neverDrupal = isNeverDrupal(path);

		// A core entry point is a LINK a visitor followed, not a probe, so it is answered before the
		// deny below. `/update.php` is linked from the Extend page by core itself
		const entryRedirect =
			serving && neverDrupal ? phpEntryRedirect(path.split(/[?#]/)[0] ?? '') : null;
		if (entryRedirect) {
			return new Response(null, {
				status: 302,
				headers: {
					location: entryRedirect,
					'x-cfw-cache': 'DENY',
					'x-cfw-deny': 'php-entry-point',
					'cache-control': `public, max-age=${EDGE_PAGE_TTL_S}`
				}
			});
		}

		// the cheapest request in the system.
		if (serving && neverDrupal) {
			return new Response('not found\n', {
				status: 404,
				headers: {
					'x-cfw-cache': 'DENY',
					'x-cfw-deny': 'never-drupal',
					'cache-control': `public, max-age=${EDGE_PAGE_TTL_S}`
				}
			});
		}

		// Counted once here rather than at each tier's return, so a tier added later is counted
		// without anybody remembering to. Everything below either answers from this isolate or hops,
		// and the hop subtracts its own request back out.
		if (serving) noteAbsorbed(site);

		// #region the authenticated allowance, decided before ANY DO hop
		//
		// An authenticated request can never be answered from a shared cache -- the page is per-user
		// -- so every one is a full render at 13 rows and ~500 ms. It is decided here rather than
		// inside the object because a check made after the hop has already spent the DO request the
		// reservation exists to protect.
		const authenticated = neverDrupal ? false : isAuthenticatedRequest(request);
		let authMode: 'render' | 'stale' | 'read-only' = 'render';
		let authReason = '';
		// the reservation is enforced on FREE only, and `decideAuthMode()` discards the counter when it
		// is not -- so reading it on paid cost one `cache.match` (9.5 ms on the first authenticated
		// request per isolate) for an answer nothing consults
		//
		// LAZY, because `authAllowance()` builds an eight-field object with five `Math.floor` and a
		// clamp, and both of its readers sit behind a check an anonymous request fails. It ran
		// unconditionally, so 82% of traffic paid for a budget it never consults. Memoised rather
		// than moved into one branch: the second reader is the deferred spend write further down,
		// and computing it twice would trade one waste for another
		let enforcedMemo: boolean | null = null;
		const enforcedOf = (): boolean =>
			(enforcedMemo ??= authAllowance(env as AuthBudgetEnv).enforced);
		if (authenticated && url.pathname === '/serve') {
			const spend = enforcedOf() ? await readAuthSpend(cache, origin, site, t0) : null;
			const decision = decideAuthMode(request, spend, env as AuthBudgetEnv, t0);
			authMode = decision.mode;
			authReason = decision.reason;

			// never dark: a spent WRITE is refused by name, a spent READ falls through as
			// anonymous. Going dark because two editors were busy is what the adversarial rule
			// rejects outright
			if (authMode === 'read-only') {
				return new Response(`${authReason}\n`, {
					status: 503,
					headers: {
						'content-type': 'text/plain; charset=utf-8',
						// the quotas refill at midnight UTC, so that is the retry time
						'retry-after': String(secondsUntilUtcReset(t0)),
						'cache-control': 'private, no-store',
						[AUTH_MODE_HEADER]: authMode,
						[AUTH_REASON_HEADER]: authReason,
						'x-worker-ms': String(Date.now() - t0)
					}
				});
			}
		}
		// in stale mode the request is served as ANONYMOUS: the shared tiers answer it, nothing
		// personalised is read or written, and the visitor gets the public page rather than a
		// blank one. A degradation, not a refusal and not a dark site
		const personalised = authenticated && authMode === 'render';
		// #endregion

		// #region compiled plans, answered from THIS isolate with no object hop
		//
		// The only tier that can answer an AUTHENTICATED page without one. `caches.default` and the KV
		// page tier are both keyed without a user, so neither may ever hold one. The key carries the
		// visitor's ROLE SET rather than their cookie; see `src/ops/edge-plan.ts` for what makes the
		// narrower key safe and for the per-session agreement that is the other half of it.
		const planCookie = request.headers.get('cookie') ?? '';
		// what the OBJECT last said this cookie is, which is the only source for it. An isolate that
		// has not learned one yet skips the tier and the hop below teaches it
		const planRoles = planCookie === '' ? null : believedRoles(planCookie, t0);
		// a write is the only thing that queues a Drupal message for the visitor's next page, and a
		// plan compiled from renders that carried none would serve that page without it. Spending
		// the session's agreement costs it one render and the message arrives on it
		if (request.method !== 'GET' && request.method !== 'HEAD') forgetWitness(planCookie);
		const planWanted =
			serving && personalised && request.method === 'GET' && edgePlanEnabled(env);
		let planTier: PlanTier = planWanted ? 'miss' : 'skip:not-wanted';
		if (planWanted) {
			const planGeneration = believedGeneration(site, t0);
			if (planGeneration === null) {
				// this isolate has not learned a generation recently enough to fence a plan against;
				// the object's answer below teaches it one
				planTier = 'skip:generation-unknown';
			} else if (planRoles === null) {
				planTier = 'skip:roles-unknown';
			} else {
				const planKey = edgePlanKey(site, planGeneration, planRoles, path);
				let held = lookupEdgePlan(planKey, Date.now(), planCookie);
				let from: PlanTier = 'mem';
				// the fallback, and it is consulted SECOND on purpose. A shared plan serves the
				// whole role set off one entry and mirrors to KV; answering this session from its
				// own instead would stop the shared key ever seeing a second witness
				if (held === null) {
					const own = privatePlanKey(planKey, planCookie);
					held = lookupEdgePlan(own, Date.now(), planCookie);
					if (held !== null) from = 'private';
				}
				// the tier for an isolate that knows the generation and has never seen this page,
				// consulted at most once per key and never for longer than the hop it replaces --
				// see COLD_READ_DEADLINE_MS, which exists because a key this colo has not seen costs
				// 46-140 ms rather than the 5-6 a warm one does
				if (held === null && shouldCheckKv(planKey)) {
					const read = readEdgePlan(env, site, planGeneration, planRoles, path);
					const arrived = await withDeadline(read);
					if (arrived !== null) {
						storeEdgePlan(planKey, arrived);
						// a plan that arrived from another isolate has NOT been agreed with by this
						// visitor, so it is stored for later and this request still hops. Serving it
						// here would be the one thing the per-session proof exists to prevent
						from = 'kv';
					} else {
						// a read that missed the deadline still warms this isolate for the next request
						const key = planKey;
						defer(read.then((late) => late && storeEdgePlan(key, late)));
					}
				}
				const html = held === null ? null : runEdgePlan(held, believedCsrf(planCookie, t0));
				const jump = html === null ? null : readRedirectPlan(html);
				if (jump !== null) {
					// `/user` is a 302 to `/user/<uid>` and was the only profile the tier could not
					// answer; see `redirectPlanBody()` for why this is safe under the private key
					return new Response(null, {
						status: jump.status,
						headers: {
							location: jump.location,
							'cache-control': 'private, no-store',
							'x-cfw-cache': 'PLAN',
							'x-cfw-plan': from,
							'x-cfw-generation': String(planGeneration),
							[AUTH_MODE_HEADER]: authMode,
							'x-worker-ms': String(Date.now() - t0)
						}
					});
				}
				if (html !== null) {
					return new Response(html, {
						status: 200,
						headers: {
							'content-type': 'text/html; charset=UTF-8',
							// per-user: no shared cache between here and the browser may store it
							'cache-control': 'private, no-store',
							'x-cfw-cache': 'PLAN',
							'x-cfw-plan': from,
							'x-cfw-generation': String(planGeneration),
							[AUTH_MODE_HEADER]: authMode,
							'x-worker-ms': String(Date.now() - t0)
						}
					});
				}
				// the render below reports `sampling` whether it feeds a compile or a key that has
				// given up, so a path that permanently left the tier read identically to one about
				// to join it
				if (
					edgePlanRefused(planKey) ||
					edgePlanRefused(privatePlanKey(planKey, planCookie))
				) {
					planTier = 'refused';
				}
			}
		}
		// #endregion

		const edgeWanted = serving && url.searchParams.get('edge') !== '0' && !personalised;

		// BEFORE the first routing decision, so a cold isolate routes to the pool on request one
		// rather than sending it to the primary and learning afterwards. Alongside the generation read
		// rather than ahead of it: both are edge reads into separate maps, and only a miss routes
		const [, generationRead] = await Promise.all([
			serving ? primeLanes(cache, origin, site) : undefined,
			edgeWanted ? readGeneration(cache, origin, site, bucket) : null
		]);

		let generation = null;
		if (edgeWanted) {
			generation = generationRead;
			if (generation !== null) {
				// The string before the request, because the memo below is the tier that answers
				// almost all of this path and it reads only the string. Building the `Request` first
				// made every MEM hit pay a URL parse and an object allocation it never used
				const memoKey = pageKeyUrl(origin, site, generation, path);
				// the tier above `caches.default`, answered with no I/O at all. `anon-cached` costs
				// 0.70 ms of cpuTime and 7.9-14.0 ms of `x-worker-ms` on a deployed worker, so
				// almost all of it is the read below; see `src/ops/page-memo.ts`
				const held = lookupPageMemo(memoKey, t0);
				if (held) {
					// the header set was assembled at STORE time; this path only stamps the timing
					const headers = pageMemoHeaders(memoKey, t0) ?? new Headers();
					headers.set('x-worker-ms', String(Date.now() - t0));
					return new Response(held.body, { status: held.status, headers });
				}
				const cached = await cache.match(new Request(memoKey, { method: 'GET' }));
				if (cached) {
					// the tier that answered, without having touched the Durable Object;
					// the DO's own verdict is preserved separately so a measurement can
					// tell EDGE from DO HIT from MISS
					const headers = new Headers(cached.headers);
					headers.set('x-cfw-cache', 'EDGE');
					headers.set('x-cfw-edge', 'HIT');
					headers.set('cache-control', 'public, max-age=0, must-revalidate');
					// BUFFERED rather than streamed, which is what makes the memo above possible.
					// The body is a stored page -- 12 KB for the front page with aggregates on --
					// so holding it costs one copy and saves this read on every later request
					const body = new Uint8Array(await cached.arrayBuffer());
					storePageMemo(
						memoKey,
						{
							body,
							status: cached.status,
							contentType:
								cached.headers.get('content-type') ?? 'text/html; charset=utf-8',
							// only the object's own verdict travels; the tier headers are set fresh
							// above so a memo hit never claims to have been an edge hit
							headers: [...cached.headers].filter(
								([name]) =>
									name.startsWith('x-cfw-') &&
									name !== 'x-cfw-cache' &&
									name !== 'x-cfw-edge'
							)
						},
						t0
					);
					headers.set('x-worker-ms', String(Date.now() - t0));
					return new Response(body, {
						status: cached.status,
						headers
					});
				}
			}
		}

		// the KV tier, between the per-colo edge cache and the Durable Object.
		//
		// Paid only, and the reason is which meter each one spends -- see `src/ops/page-store.ts`. The
		// win it buys is specific: a page rendered in one colo answers from every colo WITHOUT a DO
		// request, and a DO request is the paid cost driver. It cannot live inside the object because
		// `serveFromStorage()` is synchronous by construction and every KV read is not.
		if (edgeWanted && generation !== null) {
			const stored = await readPage(env, site, generation, path);
			if (stored) {
				return new Response(stored.html, {
					status: stored.status,
					headers: {
						'content-type': stored.contentType,
						'x-cfw-cache': 'KV',
						'x-cfw-edge': 'MISS',
						'x-cfw-generation': String(generation),
						'cache-control': 'public, max-age=0, must-revalidate',
						'x-worker-ms': String(Date.now() - t0)
					}
				});
			}
			// The previous generation, which is already in KV and was never read. A bump changes the
			// key rather than deleting anything, so the last answer for this path is sitting there
			// on its own TTL -- and the cold path it replaces is 802 ms at p50 against 4-5 ms warm.
			// The regeneration goes to the object's own fill queue, so the visitor waits for
			// neither
			const stale = await readStalePage(env, site, generation, path, {
				neverStale: env.NEVER_STALE ?? null
			});
			if (stale) {
				defer(
					stubOf()
						.fetch(
							new Request(`https://do.local/__fill?path=${encodeURIComponent(path)}`)
						)
						.then(() => undefined)
						.catch(() => undefined)
				);
				return new Response(stale.page.html, {
					status: stale.page.status,
					headers: {
						'content-type': stale.page.contentType,
						'x-cfw-cache': 'KV',
						'x-cfw-edge': 'STALE',
						'x-cfw-stale-behind': String(stale.behind),
						'x-cfw-generation': String(generation),
						// SHORT, and shorter than a fresh answer's: this body is known to be a
						// content change behind, so it must not settle into anything downstream
						'cache-control': 'public, max-age=0, must-revalidate',
						'x-worker-ms': String(Date.now() - t0)
					}
				});
			}
		}

		// the DO's own routes are double-underscored so they cannot collide with a
		// Drupal path once this front end starts forwarding real requests
		const inner = new URL(request.url);
		// every route in ROUTES has a DO_ROUTE entry except `/fillwindow`, which returned above
		inner.pathname = DO_ROUTE[url.pathname] as string;
		// the RESOLVED name, overwriting whatever the caller sent: the object stores this as its own
		// identity and keys its R2 mirror on it, so it has to be the value that chose the object
		inner.searchParams.set('site', site);
		// the consent screen redirects to a PATH; the object switches on ?action=, and a caller
		// cannot be trusted to add it -- Cloudflare builds this URL, not us
		if (url.pathname === '/setup/cf/callback') inner.searchParams.set('action', 'callback');

		// Awaited to completion, never raced against a timer.
		//
		// A Worker-side deadline looks obvious and does not work: a render is one
		// synchronous `php._run()` call into wasm, and while it runs nothing else in
		// that thread does -- measured, a 1 ms `setTimeout` lost to a `stub.fetch()`
		// that rendered for 119 ms, because the timer could not fire until the wasm
		// call returned. Racing it would also mean abandoning the subrequest, which
		// lets the runtime cancel a render mid-flight and leaves the interpreter
		// parked mid-request for the next entrant. So the render budget is enforced
		// inside the DO, BEFORE the render starts: see estimateRenderMs().
		// buffered rather than streamed onward: the object may answer a POST without reading it,
		// and workerd then throws an UNCAUGHT `read from request stream after response has been sent`
		const buffered =
			request.method === 'GET' || request.method === 'HEAD'
				? undefined
				: await request.arrayBuffer();
		// `redirect: 'manual'`, and it is the difference between a working CMS and one that loses
		// every submission. A subrequest FOLLOWS a 3xx by default, so Drupal's post-submit redirect
		// -- `303 -> /user/1?check_logged_in=1` after a login, `/node/N` after a save -- was followed
		// by the runtime against the OBJECT, which has no route by that name and answered its
		// `not found` default. The write had already landed, so the visitor saw a 404 for something
		// that worked. The 3xx belongs to the browser, which re-enters through the catch-all.
		//
		// Wrapped rather than spread: a `Request`'s method, headers and body live on the prototype,
		// so `{ ...request }` is an empty object and would have dropped the cookie.
		const innerRequest = new Request(
			buffered === undefined
				? new Request(inner, request)
				: new Request(inner, {
						method: request.method,
						headers: request.headers,
						body: buffered
					}),
			{ redirect: 'manual' }
		);
		// cleared first, always: every inbound header is copied onto the subrequest, so a client
		// could otherwise send this one and have the object read it as this worker's own decision
		innerRequest.headers.delete(AUTH_REQUEST_HEADER);
		innerRequest.headers.delete(ABSORBED_HEADER);
		// the count rides along on a hop already being paid for, same as the generation below
		const absorbed = drainAbsorbed(site, serving);
		if (absorbed > 0) innerRequest.headers.set(ABSORBED_HEADER, String(absorbed));
		if (personalised) {
			// the object charges the allowance and reports the counter back on this same response, so
			// learning the spend costs no extra hop
			innerRequest.headers.set(AUTH_REQUEST_HEADER, '1');
		} else if (authenticated) {
			// stale mode: the session is stripped so the object answers the ANONYMOUS page. Leaving
			// the cookie on would make the object render per-user anyway and spend the very budget
			// this branch exists because it has run out
			innerRequest.headers.delete('cookie');
		}
		// Built BEFORE the send, because a replica that refuses has already consumed the request.
		//
		// A body is rebuilt from `buffered`, NEVER CLONED. This was `innerRequest.clone()` under a
		// comment asserting only GET and HEAD could arrive, which `chooseTarget()` guaranteed until
		// write forwarding let a POST reach a lane -- and nothing revisited it. `clone()` tees the
		// body, the retry branch is read only on a failover, and an unread tee never releases: the
		// login POST hung forever the first time traffic actually met a lane. The bytes are already
		// in hand a few lines up, so the retry costs a second `Request` and no stream at all
		const retryOnPrimary =
			laneOf().role !== 'replica'
				? null
				: buffered === undefined
					? innerRequest.clone()
					: new Request(innerRequest.url, {
							method: innerRequest.method,
							headers: innerRequest.headers,
							body: buffered,
							redirect: 'manual'
						});
		let res = await stubOf().fetch(innerRequest);
		// which lane handed back, so the header below can name the object that ANSWERED rather than
		// the one routing chose; they differ on exactly the requests a pool measurement cares about
		let failedOverFrom: number | null = null;
		// WHY it handed back, which the retry otherwise discards with the lane's own response. A
		// failover rate says a pool is not carrying traffic; only the reason says which of the
		// several refusals is doing it, and reading that off the lane afterwards is impossible
		let failoverReason: string | null = null;
		if (retryOnPrimary !== null && shouldFailover(res)) {
			failedOverFrom = laneOf().lane;
			failoverReason = res.headers.get('x-cfw-requires-primary');
			// the replica computed `x-cfw-retry-safe` from `didMutate()`; this never infers safety
			// from the status alone
			res = await env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env)).fetch(
				retryOnPrimary
			);
		}

		// an install leaves its object at ~110 MB of a 128 MB cap and wasm memory never shrinks, so
		// the refill is NOT woken here: the next event in that isolate is refused, and a `setAlarm()`
		// from inside the install's own event resets the object and rolls the install back (0/6
		// landed with it, 6/6 without). The queue rows are written and left; the chain wakes on the
		// next visitor MISS, save or explicit `/armfill`, by which point the isolate is clean.
		let armedFill = 'n/a';
		if (url.pathname === '/enable' && res.ok) {
			try {
				const body = (await res.clone().json()) as { armFill?: boolean };
				armedFill = body?.armFill === true ? 'deferred' : 'not-requested';
			} catch {
				armedFill = 'unreadable';
			}
		}

		// an unrecognised tier means this worker and the object disagree about the header
		// contract, which is the drift `CACHE_TIERS` exists to make visible rather than silent
		const rawTier = res.headers.get('x-cfw-cache');
		const doCache =
			rawTier === null ? 'n/a' : isCacheTier(rawTier) ? rawTier : `unknown:${rawTier}`;
		const doGeneration = asGeneration(res.headers.get('x-cfw-generation'));

		// the counter rides along on a response already paid for, same as the generation. The isolate
		// memo is set synchronously inside these two, so only ANOTHER isolate waits on the cache copy
		// -- which is why both are deferred rather than awaited
		if (personalised && enforcedOf()) {
			const reported = parseAuthSpend(res.headers);
			if (reported) defer(writeAuthSpend(cache, origin, site, reported));
		}

		// the generation rides along on a response we already paid for, so learning it costs nothing
		//
		// forward only: the generation is per OBJECT and a lane trails the primary by up to
		// `DEFAULT_REPLICA_LAG_MS`, while this pointer is per SITE and single valued. With `!==` a
		// lane's older value rewrote it backwards, every `cache.match` then asked for a key nothing
		// had been stored under, and the edge tier emptied for as long as the lag lasted.
		//
		// monotonic within the BUCKET rather than forever, so a genuine backwards move (a restore) is
		// picked up at the next boundary instead of being pinned out
		if (doGeneration !== null && (generation === null || doGeneration > generation)) {
			defer(writeGeneration(cache, origin, site, bucket, doGeneration));
		}
		// the plan tier fences on the generation this isolate last learned, which is this one
		if (doGeneration !== null) rememberEdgeGeneration(site, doGeneration, Date.now());
		// and the pool the primary has actually built, so a lane autoscaling created receives
		// traffic. Rides along on a response already paid for, like the two above
		const reportedLanes = Number(res.headers.get(LANES_HEADER) ?? '');
		if (Number.isFinite(reportedLanes) && reportedLanes > 0) {
			rememberLanes(site, reportedLanes, Date.now());
			// and at the edge, so the next COLD isolate routes on it rather than rediscovering it
			defer(writeLanes(cache, origin, site, reportedLanes));
		}

		// #region compiling a plan out of the render that just happened
		//
		// The whole compile runs behind `ctx.waitUntil`: reading the body, diffing two renders and
		// proving the result are CPU this request does not have to wait for.
		const eligible = planEligibility({
			method: request.method,
			status: res.status,
			doCache,
			contentType: res.headers.get('content-type'),
			setCookie: res.headers.getSetCookie(),
			personalised,
			generation: doGeneration,
			cookie: planCookie,
			location: res.headers.get('location')
		});
		// what the object says this cookie is. Recorded before the compile below, because the compile
		// keys on it, and taken from the RESPONSE so a client cannot present a role set of its own
		const reportedRoles = res.headers.get(ROLES_HEADER) ?? '';
		if (planCookie !== '' && reportedRoles !== '') {
			rememberRoles(planCookie, reportedRoles, Date.now());
		}
		if (planWanted && !eligible.ok) planTier = eligible.reason as PlanTier;
		if (planWanted && eligible.ok && doGeneration !== null && reportedRoles !== '') {
			// the key is rebuilt from the generation and the role set the OBJECT reported, which are
			// the ones this render belongs to; the beliefs above may be a window behind them
			const key = edgePlanKey(site, doGeneration, reportedRoles, path);
			// cloned now, read later: the body below is returned to the caller and a clone taken after
			// that has been consumed is empty
			const copy = res.clone();
			const generationForPlan = doGeneration;
			const rolesForPlan = reportedRoles;
			const witness = planCookie;
			planTier = 'sampling';
			// a redirect has no body; its whole content is the status and the target, expressed as a
			// body so the compiler's proofs run on it unchanged
			const jump = res.headers.get('location');
			const asPlanBody =
				isRedirectStatus(res.status) && jump !== null
					? Promise.resolve(redirectPlanBody(res.status, jump))
					: copy.text();
			defer(
				asPlanBody
					.then((html) => {
						// the one slot value the front worker cannot generate, taken from this
						// session's own render so a shared plan can substitute it later
						rememberCsrf(witness, sessionCsrf(html), Date.now());
						// the cookie is the WITNESS rather than the key: the compile needs two
						// different sessions to agree before it may store anything
						const compiled = noteEdgeRender(key, path, html, Date.now(), witness);
						if (compiled === null) {
							// this session may be the only one this page ever sees, so give it a
							// plan of its own. Skipped once a shared plan is serving: that one is
							// cheaper and already covers the whole role set
							if (!hasEdgePlan(key)) {
								noteEdgeRender(
									privatePlanKey(key, witness),
									path,
									html,
									Date.now(),
									witness,
									true
								);
							}
							return undefined;
						}
						return writeEdgePlan(
							env,
							site,
							generationForPlan,
							rolesForPlan,
							path,
							compiled
						);
					})
					.catch(() => undefined)
			);
		}
		// #endregion

		const paged = serving
			? putPage(cache, origin, site, path, res, doGeneration, doCache, personalised)
			: { outcome: 'skipped:not-serving' };
		defer(paged.write);
		const put = paged.outcome;

		// mirror into KV so the next colo does not pay a DO request. `res.clone()` for the same
		// reason putPage() does it -- the body below is returned to the caller and can only be read once.
		let kvPut = 'skipped:not-serving';
		if (serving && personalised) {
			// the KV key has no user in it either, so the same structural refusal applies
			kvPut = 'skipped:authenticated';
		} else if (serving && res.headers.has('set-cookie')) {
			kvPut = 'skipped:set-cookie';
		} else if (serving && pageKvEnabled(env)) {
			if (doGeneration === null) {
				kvPut = 'skipped:no-generation';
			} else if (doCache !== 'HIT' && doCache !== 'RENDER') {
				// a 503 warming placeholder is not a page; storing it would pin "warming" globally
				kvPut = `skipped:${doCache}`;
			} else if (res.headers.get(KV_GRANT_HEADER) !== '1') {
				// the object holds the daily write budget; no grant means it is spent, or a lane answered
				kvPut = 'skipped:no-grant';
			} else {
				// cloned now, read later: the body below is returned to the caller, and a clone taken
				// after that has been consumed is empty
				const copy = res.clone();
				const status = res.status;
				const contentType = res.headers.get('content-type') ?? 'text/html; charset=utf-8';
				const generationForKv = doGeneration;
				defer(
					copy
						.text()
						.then((html) =>
							writePage(env, site, generationForKv, path, {
								status,
								contentType,
								html
							})
						)
						.catch(() => undefined)
				);
				kvPut = 'deferred';
			}
		} else if (serving) {
			kvPut = 'skipped:disabled';
		}

		// every header the DO set is carried through; the x-cfw-* ones ARE the result
		// on the serving path, so rebuilding a fresh header set would discard the
		// measurement
		const headers = new Headers(res.headers);
		if (!headers.has('content-type')) {
			headers.set('content-type', 'application/json');
		}
		headers.set('x-cfw-do-cache', doCache);
		if (serving) {
			headers.set('x-cfw-edge', 'MISS');
			headers.set('x-cfw-edge-put', put);
			// a tier that silently declined to store looks identical to one that stored, so the
			// outcome is reported on the header a measurement reads
			headers.set('x-cfw-kv-put', kvPut);
			headers.set('x-cfw-plan', planTier);
		}
		if (authenticated) {
			headers.set(AUTH_MODE_HEADER, authMode);
			if (authReason !== '') headers.set(AUTH_REASON_HEADER, authReason);
			// a per-user page must not be stored by any shared cache between here and the browser
			headers.set('cache-control', 'private, no-store');
		}
		headers.set('x-worker-ms', String(Date.now() - t0));
		// Which object ANSWERED, because nothing reported it and a whole class of measurement was
		// taken without it. A driven copy left `lanes_provisioned` unwritten, so the router never
		// learned the pool existed and every "with lanes" arm served from the primary while the rig
		// printed the lanes ready. `x-cfw-lane` is taken; it names the serving tier, not the object.
		//
		// IT NAMED THE ROUTING DECISION UNTIL NOW, AND THAT IS NOT THE SAME OBJECT. A lane that
		// refuses hands back and the primary re-serves, and this still reported the lane -- so a
		// pool whose lanes served nothing read as one carrying most of the traffic. The failover is
		// reported beside it rather than hidden, because the RATE of handing back is the number
		// that says whether a pool is working.
		headers.set(
			REPLICA_HEADER,
			laneOf().lane === 0 || failedOverFrom !== null ? 'primary' : `r${laneOf().lane}`
		);
		if (failedOverFrom !== null) {
			headers.set('x-cfw-failover', `r${failedOverFrom}`);
			if (failoverReason !== null) headers.set('x-cfw-failover-reason', failoverReason);
		}
		if (armedFill !== 'n/a') headers.set('x-cfw-arm-fill', armedFill);
		return new Response(res.body, { status: res.status, headers });
	},

	/**
	 * Cron entry point for the warm window.
	 *
	 * A Cron Trigger is the right driver on the free plan: it costs no visitor request, and
	 * the window it opens amortises one boot across an entire queue drain.
	 *
	 * The SET comes from `cfw_fleet` rather than a var: a cron has no request and no hostname, and
	 * site identity here IS the hostname. See {@link warmTargets}.
	 */
	async scheduled(
		event: ScheduledController,
		env: SiteWorkerEnv,
		ctx: ExecutionContext
	): Promise<void> {
		const configured = String(env?.WINDOW_SITES ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		let fleet: FleetRow[] | null = null;
		if (env.FLEET_DB) {
			// written by the object, so a bound-but-empty database is "no sites yet"
			await ensureFleetTable(env.FLEET_DB);
			fleet = await listSites(env.FLEET_DB);
		}
		const targets = warmTargets(fleet, configured, Date.now());
		// loud rather than silent: this warmed an object no visitor reaches and reported success
		// every time, because idFromName() creates whatever it is handed
		if (targets.unknown.length > 0) {
			console.warn(`warm window: no such site, not creating: ${targets.unknown.join(', ')}`);
		}
		if (targets.stale.length > 0) {
			console.warn(`warm window: past the heartbeat, skipped: ${targets.stale.join(', ')}`);
		}
		if (targets.sites.length === 0) {
			const why =
				fleet === null ? 'no FLEET_DB and no WINDOW_SITES' : `${fleet.length} reported`;
			console.warn(`warm window: nothing to warm (${why})`);
			return;
		}
		for (const site of targets.sites) {
			ctx.waitUntil(runFillWindow(env, site));
		}
	}
};

/**
 * A `?next=` that can only send the browser back into this surface.
 *
 * Anything else is discarded rather than sanitised: a sign-in page that forwards to an attacker's
 * origin after a successful login is the classic way to harvest what the operator types next.
 */
function safeNext(value: string | null): string | null {
	if (value === null || !value.startsWith(SURFACE_PREFIX)) return null;
	// `//evil.example` and `/\evil.example` are both origin-relative to a browser
	if (value.startsWith('//') || value.includes('\\')) return null;
	return value;
}

/**
 * Reads and writes the runtime levers, which had a resolver and no writer.
 *
 * GET reports every allow-listed name with the value in force and where it came from. The source is
 * the half that matters: "we think you are on free" is only useful with the reason.
 *
 * PUT merges a JSON object. `PLAN` is accepted only under its own top-level key, because the two are
 * different authorisations: every name on `KV_OVERRIDABLE` has a worst case of a slow site, and
 * `PLAN` selects a limits profile whose quotas are account-wide.
 *
 * A binding with no `put` answers 501 rather than throwing, so local dev reads as "this deployment
 * cannot store an override" rather than as a fault.
 */
async function settingsRoute(request: Request, url: URL, env: SiteWorkerEnv): Promise<Response> {
	// the SAME site the owner credential was checked against, so a token for A cannot read or write
	// B's document. Both documents used to be deployment-wide, which made one tenant's owner an
	// operator for every other tenant
	const site = await siteFor(url, env);
	const kv = env.CONFIG_KV;
	if (!kv) {
		return Response.json(
			{
				ok: false,
				error: 'no CONFIG_KV binding, so there is nowhere to store an override',
				how: 'add the kv_namespaces binding in wrangler.jsonc; the deployed vars stay in force without it'
			},
			{ status: 501 }
		);
	}

	const [plan, settings] = await Promise.all([
		resolvePlan(env, kv, Date.now(), site),
		resolveSettings(kv, Date.now(), site)
	]);
	const view = () => ({
		ok: true,
		plan,
		// every name, including the ones with no override, so a caller can render the whole surface
		// from one response rather than having to know the list
		levers: KV_OVERRIDABLE.map((name) => ({
			name,
			value: settings[name] ?? (env as unknown as Record<string, string>)[name] ?? null,
			source: settings[name] !== undefined ? 'kv' : name in env ? 'var' : 'default'
		}))
	});

	if (request.method === 'GET') return Response.json(view());

	if (request.method !== 'PUT' && request.method !== 'POST') {
		return Response.json(
			{ ok: false, error: 'use GET to read or PUT to write' },
			{ status: 405 }
		);
	}

	if (!canWriteKv(kv)) {
		return Response.json(
			{ ok: false, error: 'this CONFIG_KV binding is read-only' },
			{ status: 501 }
		);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ ok: false, error: 'the body is not JSON' }, { status: 400 });
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return Response.json(
			{ ok: false, error: 'the body must be a JSON object' },
			{ status: 400 }
		);
	}

	const patch = body as Record<string, unknown>;
	const wantedPlan = patch['PLAN'] ?? patch['plan'];
	let planResult = plan;
	if (wantedPlan !== undefined) {
		const asked = String(wantedPlan ?? '').toLowerCase();
		if (asked !== '' && asked !== 'free' && asked !== 'paid') {
			return Response.json(
				{ ok: false, error: `PLAN must be free, paid or empty; got ${asked}` },
				{ status: 400 }
			);
		}
		planResult = await writePlan(kv, asked === '' ? null : (asked as 'free' | 'paid'), site);
	}

	const { PLAN: _plan, plan: _lower, ...levers } = patch;
	const written = await writeSettings(kv, levers, site);
	return Response.json({ ok: true, plan: planResult, ...written });
}

/**
 * Renders one product surface.
 *
 * Kept out of `fetch` because it is the only branch that returns HTML rather than proxying, and
 * because three of the four pages never touch the Durable Object -- so a reader can see at a glance
 * which one does.
 */
async function renderAdmin(
	request: Request,
	url: URL,
	env: SiteWorkerEnv,
	stub: { fetch: (input: RequestInfo | URL) => Promise<Response> },
	ownerToken: string | null
): Promise<Response> {
	const html = (body: string, extra?: Record<string, string>, status = 200) =>
		new Response(body, {
			status,
			headers: {
				...extra,
				'content-type': 'text/html; charset=utf-8',
				// an admin page is per-operator and drives privileged machinery; nothing may store it
				'cache-control': 'private, no-store',
				// `script-src` and `connect-src` are load-bearing: with only `default-src 'none'`
				// every inline handler on these pages was blocked, so Deploy's Connect button and
				// Git's whole form did nothing. Still no third-party origin anywhere
				'content-security-policy':
					"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
					"connect-src 'self'; form-action 'self'"
			}
		});

	// #region sign in and out, the two surface paths that take no credential
	const secure = secureOrigin(url);
	/** the object's `/__ownercheck` is the only judge; nothing here compares a token itself */
	if (url.pathname === LOGIN_PATH) {
		const next = safeNext(url.searchParams.get('next'));
		if (request.method !== 'POST') {
			return html(renderLogin(next, null));
		}
		const form = new URLSearchParams(await request.text());
		const presented = (form.get('token') ?? '').trim();
		const wanted = safeNext(form.get('next')) ?? SURFACE_PREFIX;
		if (presented === '') {
			return html(renderLogin(wanted, 'Enter the owner token.'), {}, 400);
		}
		// THE SAME FAILURE BUDGET `ownerCredential()` USES, and this door had none.
		// `LOGIN_PATH` is public, so the gate above requires no credential and this branch reached
		// `/__ownercheck` once per HTTP request, unbounded -- exactly the amplification the budget
		// was added to remove, through the one route that never consults it. Guessing the token is
		// not the risk; driving the object's request meter for free is
		const failKey = ownerFailKey(request);
		const now = Date.now();
		if (ownerRefusedForNow(failKey, now)) {
			return html(renderLogin(wanted, 'Too many attempts. Wait a minute.'), {}, 429);
		}
		const inner = new URL(url);
		inner.pathname = '/__ownercheck';
		inner.search = '';
		const checked = await stub.fetch(
			new Request(inner, { headers: { authorization: `Bearer ${presented}` } })
		);
		if (checked.status !== 200) {
			noteOwnerFailure(failKey, now);
			return html(renderLogin(wanted, 'That is not the owner token for this site.'), {}, 401);
		}
		clearOwnerFailures(failKey);
		return new Response(null, {
			status: 303,
			headers: {
				location: wanted,
				'set-cookie': adminSessionCookie(presented, secure),
				'cache-control': 'no-store'
			}
		});
	}

	if (url.pathname === LOGOUT_PATH) {
		return new Response(null, {
			status: 303,
			headers: {
				location: LOGIN_PATH,
				'set-cookie': clearedAdminCookie(secure),
				'cache-control': 'no-store'
			}
		});
	}
	// #endregion

	/** where the object should be asked as the owner; every surface page has a token by now */
	const asOwner = (target: URL): Request =>
		new Request(
			target,
			ownerToken === null ? undefined : { headers: { authorization: `Bearer ${ownerToken}` } }
		);

	if (url.pathname === `${SURFACE_PREFIX}/operate`) {
		// every control on this page drives an owner route directly from the browser, so there is
		// nothing to fetch here; the page IS the wiring that was missing
		return html(renderShell('operate', renderOperate(), env));
	}

	if (url.pathname === `${SURFACE_PREFIX}/deploy`) {
		// the page took no arguments and never reached the object, so it rendered identically
		// before and after connecting an account. The status is one read and it is what makes
		// Disconnect reachable at all
		let status: CfAccountStatus | null = null;
		try {
			const inner = new URL(url);
			inner.pathname = '/__cfoauth';
			inner.search = '?action=status';
			const res = await stub.fetch(asOwner(inner));
			const body = (await res.json()) as CfAccountStatus & { ok?: boolean };
			if (body?.ok !== false) status = body;
		} catch {
			// a page that cannot read the status still renders the connect flow; it is the
			// requirement list that matters and an error banner here would be noise
			status = null;
		}
		// the OAuth return leg lands here with the outcome, because a JSON body was a dead end
		const notice = url.searchParams.has('connected')
			? 'Connected.'
			: (url.searchParams.get('error') ?? null);
		return html(renderShell('deploy', renderDeploy(status, notice), env));
	}

	if (url.pathname === `${SURFACE_PREFIX}/git`) {
		// the remotes live in the object, so this is the second page that reaches it
		const inner = new URL(url);
		inner.pathname = '/__git';
		inner.search = '?action=list';
		let remotes: RemoteRow[] = [];
		try {
			const reply = (await (await stub.fetch(asOwner(inner))).json()) as {
				remotes?: RemoteRow[];
			};
			remotes = Array.isArray(reply.remotes) ? reply.remotes : [];
		} catch {
			remotes = [];
		}
		return html(renderShell('git', renderGit(remotes, Date.now()), env));
	}

	if (url.pathname === `${SURFACE_PREFIX}/access`) {
		// read only from here; the write goes to `/setup/oidc`, which takes the owner token
		const inner = new URL(url);
		inner.pathname = '/__oidcsetup';
		inner.search = '?action=status';
		let row: OidcSetupRow = {
			issuer: '',
			clientId: '',
			secretPresent: false,
			redirectUri: callbackUri(url.origin)
		};
		try {
			row = {
				...row,
				...((await (await stub.fetch(asOwner(inner))).json()) as Partial<OidcSetupRow>)
			};
		} catch (e: unknown) {
			row.error = `the object did not answer: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
		}
		return html(renderShell('access', renderAccess(row), env));
	}

	if (url.pathname === `${SURFACE_PREFIX}/extend`) {
		const q = url.searchParams.get('q');
		if (!q) return html(renderShell('extend', renderExtend(null, [], null, env), env));
		// the one page that reaches the object: /__installable is where catalog.ts, packagist.ts and
		// oracle.ts already live, so this proxies rather than re-implementing the check
		const inner = new URL(url);
		inner.pathname = '/__installable';
		// `module`, which is what `/__installable` reads. This said `name` and the route has always
		// read `module`, so every query ran against the empty string and every row came back
		// `not-found`. `InstallVerdict` names the field `version`, not `newest`, for the same reason
		inner.searchParams.set('module', q);
		let entries: Parameters<typeof renderExtend>[1] = [];
		let note: string | null = null;
		try {
			const res = await stub.fetch(asOwner(inner));
			const body = (await res.json()) as {
				name?: string;
				version?: string | null;
				verdict?: string | null;
				reason?: string | null;
				conflicts?: { reason?: string }[];
			};
			entries = [
				{
					name: body.name || q,
					version: body.version ?? null,
					verdict: (body.verdict ?? null) as never,
					reason:
						body.reason ??
						body.conflicts
							?.map((c) => c.reason)
							.filter(Boolean)
							.join('; ') ??
						null
				}
			];
		} catch (e: unknown) {
			// reported, not swallowed: a check that could not run is not a module that cannot install
			note = `the installability check could not run: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
		}
		return html(renderShell('extend', renderExtend(q, entries, note, env), env));
	}

	if (url.pathname === `${SURFACE_PREFIX}/commands`) {
		const op = url.searchParams.get('op');
		const parsed = parseDrush(op);
		let result: string | null = null;
		const entries: OpsEntry[] = [];
		try {
			const inner = new URL(url);
			inner.pathname = '/__ops';
			// the registry always answers, so the table renders even when the typed command goes
			// somewhere else
			const res = await stub.fetch(asOwner(inner));
			// An object, keyed by name, and this read it as an array for the whole life of the
			// surface. `OpsRegistry::operations()` returns a string-keyed PHP array, so `json_encode`
			// emits an object and `for...of` over it throws `is not iterable`. The throw landed in
			// the catch below, so `entries` stayed empty AND the typed command never ran: every visit
			// rendered "0 of 0 have a driver" beside an error card, and no command an operator typed
			// did anything. `site-do.ts` reads the same payload as a Record two lines from where it
			// builds it.
			const body = (await res.json()) as {
				operations?: Record<
					string,
					{ label?: string; driver?: string | null; cost?: string | null }
				>;
			};
			for (const [op, o] of Object.entries(body.operations ?? {})) {
				entries.push({
					op,
					label: o.label ?? '',
					driver: o.driver ?? null,
					cost: o.cost ?? null
				});
			}
			if (parsed?.kind === 'run') {
				const run = new URL(url);
				run.pathname = parsed.route;
				run.searchParams.delete('op');
				for (const [k, v] of Object.entries(parsed.params)) run.searchParams.set(k, v);
				const ran = await stub.fetch(asOwner(run));
				result = (await ran.text()).slice(0, 4000);
			}
		} catch (e: unknown) {
			result = `the operation registry could not be read: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
		}
		return html(
			renderShell(
				'commands',
				renderCommands(
					entries,
					result,
					op,
					parsed?.kind === 'error' ? parsed.message : null
				),
				env
			)
		);
	}

	/**
	 * The fleet inventory, answered from D1 without touching a single object.
	 *
	 * This is the denominator a security rollout needs. `scripts/security-update.mjs` emits which
	 * pack objects a patch moves and its rollout steps begin "for each site"; nothing could
	 * enumerate the sites, so "every site is patched" was a claim about a set nobody could list and
	 * time-to-patch was unmeasurable rather than merely slow.
	 *
	 * `?target=<generation>` scores a rollout in progress against a specific pack.
	 */
	if (url.pathname === '/settings') return await settingsRoute(request, url, env);

	if (url.pathname === '/fleet') {
		if (!env.FLEET_DB) {
			return Response.json(
				{
					ok: false,
					error: 'no FLEET_DB binding, so no inventory exists',
					how: 'provision the d1_databases binding in wrangler.jsonc; a single site does not need one'
				},
				{ status: 501 }
			);
		}
		// the table is created by the WRITE path in the object, so a bound database no site has
		// reported into yet made this throw `no such table: cfw_fleet` -- a 500 on the endpoint whose
		// answer is "how many sites are there", read as "the fleet read failed" rather than "none yet"
		await ensureFleetTable(env.FLEET_DB);
		const sites = await listSites(env.FLEET_DB);
		const target = url.searchParams.get('target');
		return Response.json({
			ok: true,
			...fleetSummary(sites, Date.now()),
			...(target ? { rollout: rolloutProgress(sites, target), target } : {}),
			sitesList: url.searchParams.get('list') === '1' ? sites : undefined
		});
	}

	// /admin: the limits
	const images = Number(url.searchParams.get('images'));
	const styles = Number(url.searchParams.get('styles'));
	const plan =
		Number.isFinite(images) && images > 0 && Number.isFinite(styles) && styles > 0
			? { images, styles, alreadyUsed: Number(url.searchParams.get('used')) || 0 }
			: null;

	// `worker-requests` is blank and that is structural: a request answered by the edge cache never
	// enters an isolate that could count it, so any number derived here would undercount the serving
	// ceiling by exactly the traffic the cache exists to absorb. It comes from Cloudflare's analytics
	// or nowhere.
	//
	// `image-transforms` is a function of CONTENT rather than traffic -- one per style per image -- so
	// it is counted from the database. It is also the only hard cap here: past it images silently stop
	// being transformed until the first of the month.
	const resolvedPlan = await resolvePlan(env, env.CONFIG_KV);

	const used: Record<string, number> = {};
	try {
		const inner = new URL(url);
		inner.pathname = '/__serve-stats';
		const res = await stub.fetch(new Request(inner));
		const body = (await res.json()) as {
			rowsToday?: number;
			doRequestsToday?: number;
			imageStyles?: number | null;
			managedImages?: number | null;
		};
		if (typeof body.rowsToday === 'number') used['rows-written'] = body.rowsToday;
		if (typeof body.doRequestsToday === 'number') used['do-requests'] = body.doRequestsToday;
		if (typeof body.imageStyles === 'number' && typeof body.managedImages === 'number') {
			used['image-transforms'] = body.imageStyles * body.managedImages;
		}
	} catch {
		// a stats read that failed leaves the meter unmeasured, which is what it is; the page
		// distinguishes that from zero
	}
	return html(renderShell('thresholds', renderThresholds(used, plan, env, resolvedPlan), env));
}

/**
 * One image derivative, produced here rather than bought from a delivery product.
 *
 * In the front worker, and that placement is the decision. The decoder is a second wasm module; in
 * the object it would share an isolate with PHP's 96 MiB linear memory against a 128 MiB cap, and a
 * derivative is a static byte range that has no reason to enter a single-threaded object at all.
 * Measured on the published module: 1 MiB initial linear memory, 4 MiB after 56 transforms, and a
 * 64 MiB maximum that is a ceiling rather than a reservation.
 *
 * The source is read through the object because a `private://` file is session-scoped and neither
 * Cloudflare mechanism carries one -- which is the case a wasm arm was always going to be needed
 * for, and the reason this covers every other case from the same module.
 */
const PUBLIC_FILES = '/sites/default/files/';
const INLINE_FILE_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/avif'
]);

/**
 * The `public://` uri a GET for a public file names, or null.
 *
 * Drupal expects the web server to answer these from disk and has no route for them, so without
 * this every public original was Drupal's 404 unless the optional R2 mirror was configured: every
 * document download, every file field, every link to a full-size image. `styles/` stays Drupal's,
 * because its image style controller owns that prefix.
 */
export function publicFileUri(method: string, pathname: string): string | null {
	if (method !== 'GET' && method !== 'HEAD') return null;
	if (!pathname.startsWith(PUBLIC_FILES) || pathname.startsWith(`${PUBLIC_FILES}styles/`)) {
		return null;
	}
	let rest: string;
	try {
		rest = decodeURIComponent(pathname.slice(PUBLIC_FILES.length));
	} catch {
		return null;
	}
	return normaliseUri(`public://${rest}`);
}

/** a stored public file, or null so the request falls through to Drupal */
async function servePublicFile(
	request: Request,
	url: URL,
	env: SiteWorkerEnv,
	ctx: ExecutionContext
): Promise<Response | null> {
	const uri = publicFileUri(request.method, url.pathname);
	if (uri === null) return null;
	const cache = caches.default;
	const key = new Request(url.toString(), { method: 'GET' });
	const cached = await cache.match(key);
	if (cached) return request.method === 'HEAD' ? new Response(null, cached) : cached;

	const { site } = await resolveSite(url, env, { allowParam: false });
	const stub = env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env));
	const source = await stub.fetch(
		new Request(`https://do.local/__filebytes?uri=${encodeURIComponent(uri)}`)
	);
	if (!source.ok) {
		await source.body?.cancel();
		return null;
	}
	const type = source.headers.get('content-type') ?? 'application/octet-stream';
	const headers = new Headers({
		'content-type': type,
		// short, because a file can be replaced under the same uri
		'cache-control': 'public, max-age=300',
		'x-content-type-options': 'nosniff',
		'x-cfw-file': 'STORED'
	});
	// an uploaded file shares the site's origin, so anything that can carry script (svg, html) is
	// downloaded in a sandbox rather than rendered beside the session cookie
	if (!INLINE_FILE_TYPES.has(type.split(';', 1)[0]!.trim().toLowerCase())) {
		headers.set('content-disposition', 'attachment');
		headers.set('content-security-policy', "sandbox; default-src 'none'");
	}
	const response = new Response(source.body, { status: 200, headers });
	ctx.waitUntil(cache.put(key, response.clone()));
	return request.method === 'HEAD' ? new Response(null, response) : response;
}

async function serveImageTransform(
	request: Request,
	url: URL,
	env: SiteWorkerEnv,
	ctx: ExecutionContext
): Promise<Response> {
	const parsed = parseTransformPath(url.pathname, url.search);
	// a re-derived identity that does not match means the query was edited, which is a way to spend
	// the site's CPU on work nobody asked for
	if (parsed === null) return new Response('not found\n', { status: 404 });

	const cache = caches.default;
	const cached = await cache.match(new Request(url.toString(), { method: 'GET' }));
	if (cached) {
		const headers = new Headers(cached.headers);
		headers.set('x-cfw-image', 'HIT');
		return new Response(cached.body, { status: cached.status, headers });
	}

	const { site } = await resolveSite(url, env, { allowParam: false });
	const stub = env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env));
	const source = await stub.fetch(
		new Request(
			`https://do.local/__filebytes?uri=${encodeURIComponent(parsed.uri)}&derivative=${parsed.id}`,
			// the visitor's cookie, because a `private://` file is theirs to read or not
			{ headers: { cookie: request.headers.get('cookie') ?? '' } }
		)
	);
	if (!source.ok) {
		return new Response('not found\n', { status: source.status === 403 ? 403 : 404 });
	}
	// rendered on upload by the rendering lanes, so there is nothing left to do here
	if (source.headers.get('x-cfw-derivative') === 'stored') {
		const response = new Response(source.body, {
			status: 200,
			headers: {
				'content-type': source.headers.get('content-type') ?? 'application/octet-stream',
				'cache-control': 'public, max-age=31536000, immutable',
				'x-cfw-image': 'STORED'
			}
		});
		ctx.waitUntil(cache.put(new Request(url.toString()), response.clone()));
		return response;
	}

	try {
		const bytes = new Uint8Array(await source.arrayBuffer());
		const out = await runImageTransform(bytes, parsed.transform);
		const headers = new Headers({
			'content-type': out.contentType,
			// IMMUTABLE, and the identity is what earns that: a style change mints a new path, so a
			// stored derivative can never become the wrong answer for the URL it is under
			'cache-control': 'public, max-age=31536000, immutable',
			'x-cfw-image': 'RENDER',
			'x-cfw-image-engine': 'tinyimg'
		});
		const response = new Response(out.bytes, { status: 200, headers });
		ctx.waitUntil(cache.put(new Request(url.toString()), response.clone()));
		return response;
	} catch (e: unknown) {
		// a source this decoder cannot read is a 415 rather than a 500: the request was well formed
		// and the file is what it could not handle
		return new Response(`cannot transform: ${String((e as Error)?.message ?? e)}\n`, {
			status: 415,
			headers: { 'content-type': 'text/plain; charset=utf-8' }
		});
	}
}

function genBucketMs(env: SiteEnv): number {
	const n = Number(env?.GEN_BUCKET_MS);
	return Number.isFinite(n) && n > 0 ? n : GEN_BUCKET_MS;
}

/**
 * The bindings a window needs: the namespace, plus its two optional bounds.
 *
 * Narrower than the whole environment, so a caller that only has these can drive one.
 */
export interface FillWindowEnv {
	SITE: DurableObjectNamespace;
	WINDOW_MAX_FILLS?: string | number;
	WINDOW_WALL_MS?: string | number;
	/** carried so the window reaches the SAME object placement the serving path does */
	SITE_LOCATION_HINT?: string;
}

/** What the front end requires: the namespace is not optional for a Worker that only proxies. */
export interface SiteWorkerEnv extends SiteEnv {
	SITE: DurableObjectNamespace;
	/**
	 * The cross-colo page tier. OPTIONAL: the tier is absent rather than broken when it is not
	 * bound, which is what lets this ship before any namespace exists.
	 */
	PAGE_KV?: PageKv | null;
	PAGE_KV_ENABLED?: string | null;
	PAGE_KV_TTL?: string | number | null;
	/**
	 * The runtime-configurable settings namespace, holding the plan override.
	 *
	 * OPTIONAL, like `PAGE_KV`: an unbound namespace leaves the deployed `PLAN` var in force rather
	 * than breaking, which is what lets this ship before any namespace exists and what keeps a KV
	 * outage from taking a paid site to free.
	 */
	CONFIG_KV?: PlanKv | null;
	/** the cross-site inventory; OPTIONAL, because a single site does not need one */
	FLEET_DB?: FleetDb | null;
	/**
	 * The site every request on this deployment resolves to, unless KV maps the host to another.
	 *
	 * OPTIONAL and second in the chain: KV, then this, then the hostname, then `site`. See
	 * `src/ops/site-id.ts` for why the two optional layers sit above the derived one.
	 */
	SITE_ID?: string;
}

/**
 * One reply from the object, per message pumped.
 *
 * Every field but `ok` is conditional: `filled` is
 * the path a fill produced or null when the queue was empty, `booted` rides on fill replies only
 * -- which is what makes "every fill after the first shared one interpreter" observable -- and the
 * trailing drained signal carries neither.
 */
export interface FillWindowReply {
	ok: boolean;
	filled?: string | null;
	fills?: number;
	/** an interpreter is up on the object */
	booted?: boolean;
	/** this particular fill is what paid for the boot; near the opposite of `booted` on a warm fill */
	bootedInFill?: boolean;
	drained?: boolean;
	closed?: boolean;
	remaining?: number;
	error?: string;
}

/** A window that ran. */
export interface FillWindowResult {
	ok: true;
	site: string;
	fills: number;
	drained: boolean;
	stopped: 'wall-budget' | 'error' | null;
	wallMs: number;
	outcomes: FillWindowReply[];
}

/** A window that never opened, so there are no outcomes to report at all. */
export interface FillWindowFailure {
	ok: false;
	error: string;
	fills: number;
}

/**
 * Drives one warm window: connect, pump one message per fill, close.
 *
 * The driver lives OUTSIDE the Durable Object, because the budget resets on an incoming message and
 * an object cannot send itself one. The Worker's own cost is a relay and its wall time is not charged.
 *
 * Bounded three ways, because a window spends three budgets: `maxFills` bounds DO requests and rows
 * written (100k/day each), `wallBudgetMs` bounds billed duration (a held socket is non-hibernatable
 * so it IS billed), and the 15-minute platform maximum on a connection caps the rest.
 *
 * @returns the two cases are discriminated by `ok`, because a window that could not open has no
 *   outcomes rather than an empty list of them
 */
export async function runFillWindow(
	env: FillWindowEnv,
	site: string,
	opts: { maxFills?: number; wallBudgetMs?: number } = {}
): Promise<FillWindowResult | FillWindowFailure> {
	const maxFills = Number(opts.maxFills ?? env?.WINDOW_MAX_FILLS ?? 50);
	const wallBudgetMs = Number(opts.wallBudgetMs ?? env?.WINDOW_WALL_MS ?? 60_000);
	const startedAt = Date.now();

	const stub = env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env));
	const res = await stub.fetch('https://do.local/__fillsocket', {
		headers: { Upgrade: 'websocket' }
	});
	const ws = res.webSocket;
	if (!ws) {
		return { ok: false, error: `no socket: ${res.status}`, fills: 0 };
	}
	ws.accept();

	const outcomes: FillWindowReply[] = [];
	let drained = false;
	let stopped: FillWindowResult['stopped'] = null;

	try {
		for (let i = 0; i < maxFills; i++) {
			if (Date.now() - startedAt >= wallBudgetMs) {
				stopped = 'wall-budget';
				break;
			}
			const reply = await new Promise<FillWindowReply>((resolve, reject) => {
				const onMessage = (e: MessageEvent) => {
					cleanup();
					try {
						resolve(JSON.parse(String(e.data ?? '{}')));
					} catch (err) {
						reject(err);
					}
				};
				const onClose = () => {
					cleanup();
					resolve({ ok: true, drained: true, closed: true });
				};
				// `ws!` because the `if (!ws)` return above is what proves it; a hoisted function
				// declaration does not carry that narrowing in
				function cleanup() {
					ws!.removeEventListener('message', onMessage);
					ws!.removeEventListener('close', onClose);
				}
				ws.addEventListener('message', onMessage);
				ws.addEventListener('close', onClose);
				ws.send(JSON.stringify({ op: 'fill' }));
			});

			outcomes.push(reply);
			if (reply.drained || reply.closed || reply.filled === null) {
				drained = true;
				break;
			}
			if (reply.ok === false) {
				stopped = 'error';
				break;
			}
		}
	} finally {
		try {
			ws.send(JSON.stringify({ op: 'close' }));
			ws.close(1000, 'done');
		} catch {
			// already closed by the object
		}
	}

	return {
		ok: true,
		site,
		fills: outcomes.filter((o) => o.ok && o.filled).length,
		drained,
		stopped,
		wallMs: Date.now() - startedAt,
		outcomes
	};
}
