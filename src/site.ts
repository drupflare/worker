import type { SiteEnv } from './env';
import {
	AUTH_MODE_HEADER,
	AUTH_REASON_HEADER,
	AUTH_REQUEST_HEADER,
	decideAuthMode,
	isAuthenticatedRequest,
	parseAuthSpend,
	secondsUntilUtcReset,
	utcDayKey,
	type AuthBudgetEnv,
	type AuthSpend
} from './ops/auth-budget';
import {
	ensureFleetTable,
	fleetSummary,
	listSites,
	rolloutProgress,
	type FleetDb
} from './ops/fleet';
import { pageKvEnabled, readPage, writePage, type PageKv } from './ops/page-store';
import { resolvePlan, resolveSettings, withPlan, withSettings, type PlanKv } from './ops/plan';
import { bearerToken } from './ops/site-secrets';
import { SitePhpDurableObject } from './site-do';
import {
	renderCommands,
	renderDeploy,
	renderExtend,
	renderShell,
	renderThresholds,
	type OpsEntry
} from './ui/admin';

export { SitePhpDurableObject };

/**
 * Thin front end for the site Durable Object, plus the edge cache in front of it.
 *
 * The DO owns both the interpreter and the database, so this Worker runs no PHP:
 * anything it did with PHP would be in the wrong isolate, because
 * ctx.storage.sql is synchronous only from inside the DO and PHP's PDO is
 * blocking.
 *
 * What it DOES own is the tier above the DO. A `caches.default` hit costs no
 * Durable Object request and no Durable Object wall-clock -- two separately
 * billed budgets this architecture otherwise spends on every page view -- and it
 * takes hit traffic off the DO's FIFO gate, which is single-threaded by
 * construction. It is also the only layer that scales across colos; DO storage is
 * one location.
 *
 * The route set is split. Every route used to be gated behind
 * PW_DIAGNOSTICS, `/serve` included, so a deployed worker had two states and both were
 * wrong: with the flag set, `/php` and `/sql` -- arbitrary PHP and arbitrary SQL against
 * the site database -- answered any request on the internet; without it, the site did not
 * serve at all. The default config shipped the flag ON, so the deployable artifact was the
 * first of those. Found 2026-08-11.
 *
 * So: PUBLIC routes are the ones a visitor legitimately reaches, and they are never gated.
 * DIAGNOSTIC routes still fail closed without PW_DIAGNOSTICS, because a diagnostic that
 * renders or profiles can permanently degrade the isolate it runs in.
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
const PUBLIC_ROUTES = new Set(['/serve', '/firstrun']);

/**
 * Routes that must never be reachable without PW_DIAGNOSTICS.
 *
 * Read the list as a threat model rather than a menu. `/php` reports the interpreter version
 * and the mount -- it runs ONE fixed statement and evaluates nothing a caller supplies, which
 * this comment used to claim it did; the mistake matters because this is the file a reader
 * consults for the threat model, and it overstated one route while the real arbitrary-code
 * surface sits next to it. `/sql` runs arbitrary SQL; `/export` dumps the whole database and
 * `/restore` overwrites it from a body;
 * `/savenode` writes content; `/migrate` and `/bump` can wipe
 * the page cache or re-run migration; `/nativefetch` reaches outbound.
 *
 * `/firstrun` used to be in this set and is now in {@link PUBLIC_ROUTES}; the reasoning is there.
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
	'/serve-stats',
	'/bump',
	'/export',
	'/restore',
	'/savenode',
	'/capability',
	'/httpdrain',
	'/nativefetch',
	'/invalidate',
	'/fillwindow',
	'/heap',
	'/bootphase',
	'/ops',
	'/installable',
	'/writes',
	'/files',
	'/enable',
	'/fleet',
	'/health',
	// the product surfaces, diagnostic-gated: /admin/commands proxies to /__ops, which runs cache
	// rebuilds and module installs, and there is no administrator authentication in this Worker.
	// Unauthenticated, that is a remote shell. They move to PUBLIC_ROUTES when an admin
	// credential exists, not before
	'/admin',
	'/admin/extend',
	'/admin/commands',
	'/admin/deploy'
]);

/**
 * Routes an OWNER reaches with a per-site token, without turning on diagnostics.
 *
 * `/export` is the "a customer can leave" property, and it was reachable only with
 * `PW_DIAGNOSTICS=1` -- one boolean that simultaneously exposes `/sql` (arbitrary SQL against the
 * site database), `/restore` (a whole-database overwrite) and `/php`. So the supported way to take
 * your own data out was to open a remote shell to the internet first, which is not a supported way
 * to do anything.
 *
 * These stay in `DIAGNOSTIC_ROUTES` as well, so `PW_DIAGNOSTICS=1` still reaches them and nothing
 * that worked stops working. The token is an ADDITIONAL way in, not a replacement.
 */
const OWNER_ROUTES = new Set(['/export', '/health']);

const ROUTES = new Set([...PUBLIC_ROUTES, ...DIAGNOSTIC_ROUTES]);

/**
 * Whether the caller proved ownership of this site.
 *
 * The token lives in the object's own `cfw_meta`, so the check costs one DO request -- which is why
 * it runs only after the route has been matched and only for a route that needs it.
 */
async function ownerAuthorised(request: Request, env: SiteWorkerEnv, url: URL): Promise<boolean> {
	const presented = bearerToken(request.headers.get('authorization'));
	if (!presented) return false;
	const site = url.searchParams.get('site') ?? 'site';
	const stub = env.SITE.get(env.SITE.idFromName(site));
	const inner = new URL(url);
	inner.pathname = '/__ownercheck';
	const res = await stub.fetch(
		new Request(inner, { headers: { authorization: `Bearer ${presented}` } })
	);
	return res.status === 200;
}

const DO_ROUTE: Record<string, string> = {
	'/heap': '/__heap',
	'/bootphase': '/__bootphase',
	'/ops': '/__ops',
	'/installable': '/__installable',
	'/writes': '/__writes',
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
	'/fill': '/__fill',
	'/assemble': '/__assemble',
	'/serve-stats': '/__serve-stats',
	'/bump': '/__bump',
	'/export': '/__export',
	'/restore': '/__restore',
	'/firstrun': '/__firstrun',
	'/savenode': '/__savenode',
	'/capability': '/__capability',
	'/httpdrain': '/__httpdrain',
	'/nativefetch': '/__nativefetch',
	'/invalidate': '/__invalidate',
	'/health': '/__health'
};

/** how long an edge-cached page stays fresh, in seconds */
const EDGE_PAGE_TTL_S = 300;

/**
 * Width of the window the generation pointer is discovered once per, in ms.
 *
 * The Worker has to know the generation to build a cache key, and asking the DO
 * for it on every request would spend a DO request to save a DO request. So the
 * pointer is itself an edge-cache entry whose KEY contains the window index: the
 * first request in a window finds no pointer, goes to the DO it was going to have
 * to reach anyway, and reads the generation off that response's header. Every
 * later request in the window reads the pointer for free.
 *
 * The key is bucketed rather than left to `max-age` expiry because
 * Cloudflare's edge applies its own minimum TTLs to cached responses, and a
 * pointer whose freshness silently outlived its window would serve a stale
 * generation indefinitely.
 *
 * Cost: at most one extra DO request per window per colo, independent of traffic.
 * Lag: a bump reaches other colos within two windows. The bumping colo sees it
 * immediately, because the /bump response rewrites the pointer for the current
 * window.
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
 * This is a storage fix, not just a saving. `PageCache` writes one PERMANENT
 * `cache_data` row per distinct URL -- measured, cid
 * `route:[language]=en:[query_parameters]=:<path>`, about 215 B including the views
 * results row. Nothing garbage-collects it, because expire-based GC only deletes rows
 * with a finite expire and a 2xx page is stored `Cache::PERMANENT`. So a scanner
 * walking `/.env`, `/wp-login.php`, `/.git/config` writes a permanent row for every
 * probe: an attacker-influenceable, unbounded growth vector against a 5 GB
 * account-wide free storage limit.
 *
 * A DENY list, not the router's own path table. A
 * manifest of real routes cannot be authoritative at the edge: path ALIASES live in
 * `path_alias` and are created at runtime, so `/about` is a valid URL that appears in
 * no packed route table. An allowlist would 404 it. These patterns instead match only
 * things Drupal has no route for under any configuration, so the false-positive risk
 * is zero, which is what lets this run before the DO rather than after.
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
 * True when the path cannot be a Drupal route under any configuration.
 */
export function isNeverDrupal(pathname: string): boolean {
	return NEVER_DRUPAL.some((re) => re.test(pathname));
}

const cacheKey = (origin: string, parts: string[]) =>
	new Request(`${origin}/__cfw/${parts.map(encodeURIComponent).join('/')}`, {
		method: 'GET'
	});

const genKey = (origin: string, site: string, bucket: number) =>
	cacheKey(origin, ['gen', site, String(bucket)]);

const pageKey = (origin: string, site: string, generation: number, path: string) =>
	cacheKey(origin, ['page', String(generation), site, path]);

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
 * `cache.put()` rejects several header combinations (206 responses, `Vary: *`,
 * `Set-Cookie` without a matching `Cache-Control: private=set-cookie`), so the
 * stored copy is built from an explicit allow-list of headers rather than from
 * whatever the DO sent, and a rejection degrades to "no edge cache" instead of
 * failing the request.
 *
 * @returns an x-cfw-edge-put value
 */
async function putPage(
	cache: Cache,
	origin: string,
	site: string,
	path: string,
	res: Response,
	generation: number | null,
	doCache: string,
	isAuthenticated: boolean
): Promise<string> {
	if (res.status !== 200) return `skipped:${res.status}`;
	if (doCache !== 'HIT' && doCache !== 'RENDER') return `skipped:${doCache}`;
	if (generation === null) return 'skipped:no-generation';
	// a structural refusal, not a cookie-pattern check. The shared key has no user in it, so a personalised
	// response stored under it is served to the next anonymous visitor -- and this project has
	// shipped exactly that: a render that kept uid 1 landed in the anonymous page cache at 90,038
	// bytes against 12,296. Two independent signals, because either one alone can be wrong: the
	// caller says the REQUEST was authenticated, and Set-Cookie says the RESPONSE is per-user.
	// The header allow-list below would silently drop Set-Cookie, which makes the stored copy look
	// anonymous while carrying somebody's page, so this refuses before that can happen.
	if (isAuthenticated) return 'skipped:authenticated';
	if (res.headers.has('set-cookie')) return 'skipped:set-cookie';

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

	try {
		await cache.put(
			pageKey(origin, site, generation, path),
			new Response(res.clone().body, { status: 200, headers })
		);
		return 'stored';
	} catch (e: any) {
		return `refused:${String(e?.message ?? e).slice(0, 120)}`;
	}
}

export default {
	async fetch(request: Request, env: SiteWorkerEnv): Promise<Response> {
		const url = new URL(request.url);
		// resolved ONCE and overlaid, so the 16 `isPaid(env)` call sites downstream need no change
		// and cannot disagree with each other about which plan this request is on
		env = withPlan(env, await resolvePlan(env, env.CONFIG_KV));
		// the numeric levers ride the same namespace, behind an allow-list: KV is operator-writable,
		// so a blanket merge would let a KV write set PW_DIAGNOSTICS and reach /sql and /restore
		env = withSettings(env, await resolveSettings(env.CONFIG_KV));

		if (!ROUTES.has(url.pathname)) {
			return new Response('not found\n', { status: 404 });
		}
		// a diagnostic fails closed; a public route does not, or the site cannot serve
		if (!PUBLIC_ROUTES.has(url.pathname) && env?.PW_DIAGNOSTICS !== '1') {
			// AN OWNER ROUTE IS NOT A DIAGNOSTIC. `/export` sat in the diagnostic set beside `/sql`
			// (arbitrary SQL) and `/restore` (a whole-database overwrite), all behind one boolean --
			// so the supported way to get your own data out was to expose a remote shell to the
			// internet first. Export is an owner operation and takes a credential instead of a mode.
			if (OWNER_ROUTES.has(url.pathname)) {
				const owner = await ownerAuthorised(request, env, url);
				if (!owner) {
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
			} else {
				return new Response('not found\n', { status: 404 });
			}
		}

		const t0 = Date.now();
		// one object per site; the name is the site identity
		const site = url.searchParams.get('site') ?? 'site';
		const stub = env.SITE.get(env.SITE.idFromName(site));

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
		if (url.pathname.startsWith('/admin') || url.pathname === '/fleet') {
			return await renderAdmin(url, env, stub);
		}

		const path = url.searchParams.get('path') ?? '/';

		// Refused here rather than in the Durable Object, because reaching the DO is what
		// costs: one DO request, and a PERMANENT cache_data row per distinct URL that
		// nothing garbage-collects. On a public site most traffic is scanners, so this is
		// the cheapest request in the system.
		if (serving && isNeverDrupal(path)) {
			return new Response('not found\n', {
				status: 404,
				headers: {
					'x-cfw-cache': 'DENY',
					'x-cfw-deny': 'never-drupal',
					'cache-control': `public, max-age=${EDGE_PAGE_TTL_S}`
				}
			});
		}

		// #region the authenticated allowance, decided before ANY DO hop
		//
		// An authenticated request can never be answered from a shared cache -- the page is per-user
		// -- so every one is a full render at 13 rows and ~500 ms. It is decided here rather than
		// inside the object because a check made after the hop has already spent the DO request the
		// reservation exists to protect.
		const authenticated = isNeverDrupal(path) ? false : isAuthenticatedRequest(request);
		let authMode: 'render' | 'stale' | 'read-only' = 'render';
		let authReason = '';
		if (authenticated && url.pathname === '/serve') {
			const spend = await readAuthSpend(cache, origin, site, t0);
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

		const edgeWanted = serving && url.searchParams.get('edge') !== '0' && !personalised;

		let generation = null;
		if (edgeWanted) {
			generation = await readGeneration(cache, origin, site, bucket);
			if (generation !== null) {
				const cached = await cache.match(pageKey(origin, site, generation, path));
				if (cached) {
					// the tier that answered, without having touched the Durable Object;
					// the DO's own verdict is preserved separately so a measurement can
					// tell EDGE from DO HIT from MISS
					const headers = new Headers(cached.headers);
					headers.set('x-cfw-cache', 'EDGE');
					headers.set('x-cfw-edge', 'HIT');
					headers.set('cache-control', 'public, max-age=0, must-revalidate');
					headers.set('x-worker-ms', String(Date.now() - t0));
					return new Response(cached.body, {
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
		}

		// the DO's own routes are double-underscored so they cannot collide with a
		// Drupal path once this front end starts forwarding real requests
		const inner = new URL(request.url);
		// every route in ROUTES has a DO_ROUTE entry except `/fillwindow`, which returned above
		inner.pathname = DO_ROUTE[url.pathname] as string;

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
		const innerRequest = new Request(inner, request);
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
		const res = await stub.fetch(innerRequest);

		// A MODULE INSTALL CANNOT WAKE ITS OWN FILL CHAIN, so this does it in a second event.
		// `setAlarm()` from inside the install's own event resets the object and rolls the whole
		// install back -- measured 0/6 landing with it and 6/6 without. The install answers
		// `armFill: true` when it purged pages it wants re-rendered; poking `/__armfill` is one
		// `setAlarm()` in an event of its own, which is the part that makes it safe.
		// AN INSTALL LEAVES ITS OBJECT UNABLE TO DO ANYTHING ELSE, so the refill is deliberately
		// NOT woken from here. The install ends with the isolate at ~110 MB of a 128 MB cap --
		// wasm linear memory never shrinks -- and the next event in that isolate is refused:
		// poking `/__armfill` immediately returned "Durable Object's isolate exceeded its memory
		// limit and was reset" on 6 of 6 deployed installs. Armed from INSIDE the install's own
		// event it is worse still: that reset rolls the whole install back.
		//
		// So the queue rows are written and left. The chain wakes on the next thing that arms it
		// -- a visitor MISS, a save, or an explicit `/armfill` -- by which point the object has
		// been re-created with a clean isolate. The cost is a cold cache after an install, which
		// is what a cache is for.
		let armedFill = 'n/a';
		if (url.pathname === '/enable' && res.ok) {
			try {
				const body = (await res.clone().json()) as { armFill?: boolean };
				armedFill = body?.armFill === true ? 'deferred' : 'not-requested';
			} catch {
				armedFill = 'unreadable';
			}
		}

		const doCache = res.headers.get('x-cfw-cache') ?? 'n/a';
		const doGeneration = asGeneration(res.headers.get('x-cfw-generation'));

		// the counter rides along on a response already paid for, same as the generation
		if (personalised) {
			const reported = parseAuthSpend(res.headers);
			if (reported) await writeAuthSpend(cache, origin, site, reported);
		}

		// the generation rides along on a response we already paid for, so learning
		// it -- including learning that a bump happened -- costs nothing extra
		if (doGeneration !== null && doGeneration !== generation) {
			await writeGeneration(cache, origin, site, bucket, doGeneration);
		}

		const put = serving
			? await putPage(cache, origin, site, path, res, doGeneration, doCache, personalised)
			: 'skipped:not-serving';

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
			} else {
				const stored = await writePage(env, site, doGeneration, path, {
					status: res.status,
					contentType: res.headers.get('content-type') ?? 'text/html; charset=utf-8',
					html: await res.clone().text()
				});
				kvPut = stored ? 'stored' : 'refused';
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
		}
		if (authenticated) {
			headers.set(AUTH_MODE_HEADER, authMode);
			if (authReason !== '') headers.set(AUTH_REASON_HEADER, authReason);
			// a per-user page must not be stored by any shared cache between here and the browser
			headers.set('cache-control', 'private, no-store');
		}
		headers.set('x-worker-ms', String(Date.now() - t0));
		if (armedFill !== 'n/a') headers.set('x-cfw-arm-fill', armedFill);
		return new Response(res.body, { status: res.status, headers });
	},

	/**
	 * Cron entry point for the warm window.
	 *
	 * A Cron Trigger is the right driver on the free plan: it costs no visitor request, and
	 * the window it opens amortises one boot across an entire queue drain. WINDOW_SITES is
	 * a comma list because one Worker serves many sites and each has its own object.
	 */
	async scheduled(
		event: ScheduledController,
		env: SiteWorkerEnv,
		ctx: ExecutionContext
	): Promise<void> {
		const sites = String(env?.WINDOW_SITES ?? 'default')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		for (const site of sites) {
			ctx.waitUntil(runFillWindow(env, site));
		}
	}
};

/**
 * Renders one product surface.
 *
 * Kept out of `fetch` because it is the only branch that returns HTML rather than proxying, and
 * because three of the four pages never touch the Durable Object -- so a reader can see at a glance
 * which one does.
 */
async function renderAdmin(
	url: URL,
	env: SiteWorkerEnv,
	stub: { fetch: (input: RequestInfo | URL) => Promise<Response> }
): Promise<Response> {
	const html = (body: string) =>
		new Response(body, {
			status: 200,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				// an admin page is per-operator and drives privileged machinery; nothing may store it
				'cache-control': 'private, no-store',
				// it renders no third-party anything, so the policy can be this tight
				'content-security-policy':
					"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"
			}
		});

	if (url.pathname === '/admin/deploy') {
		return html(renderShell('deploy', renderDeploy(), env));
	}

	if (url.pathname === '/admin/extend') {
		const q = url.searchParams.get('q');
		if (!q) return html(renderShell('extend', renderExtend(null, [], null, env), env));
		// the one page that reaches the object: /__installable is where catalog.ts, packagist.ts and
		// oracle.ts already live, so this proxies rather than re-implementing the check
		const inner = new URL(url);
		inner.pathname = '/__installable';
		inner.searchParams.set('name', q);
		let entries: Parameters<typeof renderExtend>[1] = [];
		let note: string | null = null;
		try {
			const res = await stub.fetch(new Request(inner));
			const body = (await res.json()) as {
				name?: string;
				newest?: string | null;
				verdict?: string | null;
				reason?: string | null;
				conflicts?: { reason?: string }[];
			};
			entries = [
				{
					name: body.name ?? q,
					version: body.newest ?? null,
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

	if (url.pathname === '/admin/commands') {
		const op = url.searchParams.get('op');
		let result: string | null = null;
		const entries: OpsEntry[] = [];
		try {
			const inner = new URL(url);
			inner.pathname = '/__ops';
			if (op) inner.searchParams.set('op', op);
			const res = await stub.fetch(new Request(inner));
			const body = (await res.json()) as {
				operations?: {
					op: string;
					label?: string;
					driver?: string | null;
					cost?: string | null;
				}[];
			};
			for (const o of body.operations ?? []) {
				entries.push({
					op: o.op,
					label: o.label ?? '',
					driver: o.driver ?? null,
					cost: o.cost ?? null
				});
			}
			if (op) result = JSON.stringify(body, null, 2).slice(0, 4000);
		} catch (e: unknown) {
			result = `the operation registry could not be read: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
		}
		return html(renderShell('commands', renderCommands(entries, result, op), env));
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

	// THREE of the meters now have real counters behind them; this page used to pass `{}` and report
	// "nothing measures this yet" for every row, which beside a measured row reads as the healthy one.
	//
	// `worker-requests` is STILL blank, and that is structural rather than a gap. A request answered
	// by the edge cache never enters an isolate that could count it, so any number this Worker
	// derived would undercount the serving ceiling by exactly the traffic the cache exists to absorb
	// -- a confident wrong number about the meter that binds at 3M visits/month. It comes from
	// Cloudflare's analytics or nowhere.
	//
	// `image-transforms` is a function of CONTENT rather than traffic -- one transformation per style
	// per image -- so it is counted from the database instead of projected. It is also the only hard
	// cap here: past it images silently stop being transformed until the first of the month.
	// which plan is in force AND where it came from, because "we think you are on free" is only
	// actionable with the reason: a KV override, the deployed var, or nothing set at all
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
 * The driver has to live OUTSIDE the Durable Object, because the budget resets on an
 * INCOMING message and an object cannot send itself one. The Worker's own cost is a
 * relay -- it does no PHP and no rendering -- and its wall time is not charged.
 *
 * Bounded three ways, because a window spends three different budgets: `maxFills` bounds
 * DO requests (100k/day) and rows written (100k/day), `wallBudgetMs` bounds billed
 * duration (13,000 GB-s/day, and a held socket is non-hibernatable so it IS billed), and
 * the 15-minute platform maximum on a connection keeping an object alive caps the rest.
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

	const stub = env.SITE.get(env.SITE.idFromName(site));
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
