import { edgeRules } from './ops/edge-rules';
import { chunkStack, isLengthError } from './ops/error-probe';
import { ensureFleetTable, listSites, warmTargets, type FleetRow } from './ops/fleet';
import { resolvePlan, resolveSettings, withPlan, withSettings } from './ops/plan';
import { resolveSite } from './ops/site-id';
import { aliasRewrite } from './ops/site-origin';
import { SitePhpDurableObject } from './site-do';
import { decideAllowance } from './site/allowance';
import { decorateReply } from './site/decorate';
import { canonicalOriginOf } from './site/deployment';
import { readEdgeTiers, readKvTier } from './site/edge-read';
import { storeEdge } from './site/edge-store';
import { fileRoute, ownerRoute, pageRewrite } from './site/entry';
import { runFillWindow } from './site/fill-window';
import { isNeverDrupal } from './site/guards';
import { buildHop, sendHop } from './site/hop';
import { learnFromReply } from './site/learn';
import { noteAbsorbed } from './site/memos';
import { claimPhases, healthRoute } from './site/object-routes';
import { compilePlan, readPlanTier } from './site/plan-tier';
import { recoverRoute } from './site/recover';
import { isReservedPath } from './site/routes';
import { denyProbe, refuseOversized } from './site/screen';
import { fillWindowRoute, surfaceRoute } from './site/surfaces';
import { openContext } from './site/target';
import type { Defer, FrontEntry, SiteWorkerEnv } from './site/types';

export { RenderLane } from './ops/render-lane';
export { moduleAssetPath, publicFileUri } from './site/files';
export { runFillWindow } from './site/fill-window';
export type {
	FillWindowEnv,
	FillWindowFailure,
	FillWindowReply,
	FillWindowResult
} from './site/fill-window';
export {
	bodyTooLarge,
	isNeverDrupal,
	objectResetPage,
	phpEntryRedirect,
	resetRecovery
} from './site/guards';
export type { BodyTooLarge } from './site/guards';
export { primeLanes, writeLanes } from './site/memos';
export { routeTable } from './site/routes';
export type { SiteWorkerEnv } from './site/types';
export { SitePhpDurableObject };

/**
 * Thin front end for the site Durable Object, plus the edge cache in front of it.
 *
 * It runs no PHP: `ctx.storage.sql` is synchronous only inside the object and PDO blocks. A
 * `caches.default` hit costs no Durable Object request or wall-clock and is the only layer that
 * scales across colos. Public routes are never gated; diagnostic routes fail closed without
 * `PW_DIAGNOSTICS`, since a profiling route can permanently degrade its isolate.
 */
export default {
	async fetch(request: Request, env: SiteWorkerEnv, ctx?: ExecutionContext): Promise<Response> {
		let url = new URL(request.url);
		// before site resolution and KV, so `x-worker-ms` includes a cold isolate's 8-12 ms
		const t0 = Date.now();
		// the tenant for the two KV documents; not `siteFor()`, which honours `?site=` off
		// `PUBLIC_ROUTES` (a privilege boundary: a visitor's `?site=` would pick the tenant)
		const { site: resolvedSite, from: resolvedFrom } = await resolveSite(url, env, {
			allowParam: false
		});
		// issued together (a warm `CONFIG_KV.get()` is 4-6 ms; ten in series 54.5 ms, together 15)
		const [plan, settings] = await Promise.all([
			// resolved once and overlaid, so the many `isPaid(env)` call sites cannot disagree
			resolvePlan(env, env.CONFIG_KV, Date.now(), resolvedSite),
			// behind an allow-list: KV is operator-writable, and a blanket merge would let it set
			// `PW_DIAGNOSTICS` and reach `/sql` and `/restore`
			resolveSettings(env.CONFIG_KV, Date.now(), resolvedSite)
		]);
		env = withSettings(withPlan(env, plan), settings);
		// captured first: the page rewrite inside `frontFetch` moves the path into `?path=`
		const visited = url.pathname;
		const edge = edgeRules(env, isReservedPath);
		const moved = edge.redirect(url);
		if (moved !== undefined) return moved;
		try {
			const res = edge.decorate(
				visited,
				await frontFetch(request, env, ctx, url, t0, resolvedSite)
			);
			// only a KV-mapped host: an operator wrote it, so a forged Host cannot reach this
			if (resolvedFrom !== 'kv') return res;
			const canonical = await canonicalOriginOf(env, resolvedSite);
			return canonical === undefined || canonical === url.origin
				? res
				: aliasRewrite(res, canonical, url.origin);
		} catch (e) {
			if (isLengthError(e)) {
				const stack = chunkStack(String((e as Error)?.stack ?? ''));
				console.error('cfw-range-error', {
					where: 'front',
					method: request.method,
					path: visited,
					message: String((e as Error)?.message),
					...Object.fromEntries(stack.map((piece, i) => [`stack${i}`, piece]))
				});
			}
			throw e;
		}
	},

	/**
	 * Cron entry point for the warm window (it amortises one boot across a queue drain).
	 * The site set comes from `cfw_fleet`, since a cron has no hostname; see {@link warmTargets}.
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
		let fleet: FleetRow[] | undefined;
		if (env.FLEET_DB) {
			// written by the object, so a bound-but-empty database is "no sites yet"
			await ensureFleetTable(env.FLEET_DB);
			fleet = await listSites(env.FLEET_DB);
		}
		const targets = warmTargets(fleet, configured, Date.now());
		// warn: `idFromName()` creates whatever it is handed, so an unknown site warmed silently
		if (targets.unknown.length > 0) {
			console.warn(`warm window: no such site, not creating: ${targets.unknown.join(', ')}`);
		}
		if (targets.stale.length > 0) {
			console.warn(`warm window: past the heartbeat, skipped: ${targets.stale.join(', ')}`);
		}
		if (targets.sites.length === 0) {
			const why =
				fleet === undefined
					? 'no FLEET_DB and no WINDOW_SITES'
					: `${fleet.length} reported`;
			console.warn(`warm window: nothing to warm (${why})`);
			return;
		}
		for (const site of targets.sites) {
			ctx.waitUntil(runFillWindow(env, site));
		}
	}
};

/** builds the request state the entry stages rewrite, before any site is chosen */
function openEntry(
	request: Request,
	env: SiteWorkerEnv,
	ctx: ExecutionContext | undefined,
	url: URL,
	t0: number,
	resolvedSite: string
): FrontEntry {
	// writes nothing downstream reads go through `waitUntil` (an awaited `caches.default.put` is
	// 9 ms small, 12.5 ms at 97 KB; deferred it is 0 to the response, billed wall time unchanged)
	const defer: Defer = (p) => {
		if (p === undefined) return;
		if (ctx) ctx.waitUntil(p);
		else void p;
	};
	return {
		request,
		url,
		env,
		ctx,
		t0,
		resolvedSite,
		// `__` paths are the object's own routes and must stay a 404 from outside (a render would
		// read as "the route exists and failed")
		internal: url.pathname.startsWith('/__'),
		// set by the catch-all rewrite, whose `?site=` is the site resolved above
		pageRequest: false,
		defer
	};
}

/** everything the front worker does once the site and its levers are resolved */
async function frontFetch(
	request: Request,
	env: SiteWorkerEnv,
	ctx: ExecutionContext | undefined,
	url: URL,
	t0: number,
	resolvedSite: string
): Promise<Response> {
	const entry = openEntry(request, env, ctx, url, t0, resolvedSite);
	const filed = await fileRoute(entry);
	if (filed !== undefined) return filed;
	const unrouted = pageRewrite(entry);
	if (unrouted !== undefined) return unrouted;
	const gated = await ownerRoute(entry);
	if (gated !== undefined) return gated;
	const recovered = await recoverRoute(entry);
	if (recovered !== undefined) return recovered;

	const f = await openContext(entry);
	const windowed = await fillWindowRoute(f);
	if (windowed !== undefined) return windowed;
	const surface = await surfaceRoute(f);
	if (surface !== undefined) return surface;
	const oversized = refuseOversized(f);
	if (oversized !== undefined) return oversized;

	// one scan (a split plus up to six regex tests), shared with the authenticated check below
	const neverDrupal = isNeverDrupal(f.path);
	const denied = denyProbe(f, neverDrupal);
	if (denied !== undefined) return denied;

	// counted once here so a later tier is counted too; the hop subtracts its own request back out
	if (f.serving) noteAbsorbed(f.site);

	const auth = await decideAllowance(f, neverDrupal);
	if (auth instanceof Response) return auth;
	const plan = await readPlanTier(f, auth);
	if (plan instanceof Response) return plan;
	const edge = await readEdgeTiers(f, auth);
	if (edge instanceof Response) return edge;
	const kv = await readKvTier(f, edge);
	if (kv !== undefined) return kv;
	const health = await healthRoute(f);
	if (health !== undefined) return health;
	await claimPhases(f);

	const hop = await sendHop(f, await buildHop(f, auth));
	if (hop instanceof Response) return hop;
	const learned = await learnFromReply(f, auth, edge, hop.res);
	const planTier = compilePlan(f, auth, plan, hop.res, learned);
	const stored = storeEdge(f, auth, hop.res, learned);
	return decorateReply(f, { auth, hop, learned, stored, planTier });
}
