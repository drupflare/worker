/**
 * Which object answers a request, once a site has more than one.
 *
 * The primary is lane 0 rather than a lane apart, so `replicas = 0` is a modulus of 1 rather than a
 * branch in the caller. Lanes are chosen by affinity: a shared counter measured a flat scaling curve
 * on the rig, per-client pinning measured 1.00 / 1.80 / 2.14.
 */
import { ID_PARTITION_LANES } from './write-forwarding.js';

/** what a routing decision was, and why */
export type RoutingDecision = {
	/** the Durable Object name to address */
	target: string;
	role: 'primary' | 'replica';
	/** 0 is the primary; 1..n are replicas */
	lane: number;
	reason: string;
};

/**
 * The object name of one replica lane.
 *
 * `#` is outside the set `encodeSiteId()` keeps and cannot be produced by its escape, so a replica
 * name can never collide with a site id however a hostname is spelled.
 */
export function replicaName(site: string, lane: number): string {
	return `${site}#r${lane}`;
}

/** the site a replica name belongs to, or null when the name is not one */
export function replicaOf(name: string): { site: string; lane: number } | null {
	const at = name.lastIndexOf('#r');
	if (at <= 0) return null;
	const lane = Number(name.slice(at + 2));
	if (!Number.isInteger(lane) || lane < 1) return null;
	return { site: name.slice(0, at), lane };
}

/**
 * How many replica lanes a site has, beyond the primary; unset, unparseable and negative are 0.
 *
 * **The ceiling is {@link ID_PARTITION_LANES}, and it is a mechanism rather than a taste.** This
 * used to clamp at 32 on the reasoning that a larger pool is "past what the measured curve covers",
 * which is a statement about what had been measured rather than a limit of anything. Removing it
 * outright was worse: a lane mints forwarded ids from its residue class modulo
 * `ID_PARTITION_LANES + 1`, so lane 257 wraps onto lane 0's class -- the PRIMARY's -- and two
 * writers mint the same id. `write-forwarding.spec.ts` is what caught that, by comparing the
 * router's reach against the partition rather than trusting either alone.
 *
 * So the number is bounded by the arithmetic that keeps ids disjoint, and the two are linked here
 * rather than restated. `replica-demand.ts` carries a different and smaller ceiling:
 * `REPLICA_MAX_LANES` bounds what AUTOSCALING creates, where the binding cost is per-lane idle
 * storage and catch-up rather than correctness.
 *
 * What this number does is tell the ROUTER how many buckets to hash over, and setting it above the
 * lanes a site has provisioned routes to objects that do not exist -- each one a wasted hop and a
 * retry on the primary. That is an operator error a ceiling cannot prevent; `chooseTarget()` takes
 * `max(this, believedLanes)` so the provisioned count is the floor either way.
 */
export function replicaCount(env?: { REPLICA_COUNT?: string | null }): number {
	const raw = Number(String(env?.REPLICA_COUNT ?? '').trim());
	if (!Number.isFinite(raw) || raw < 1) return 0;
	return Math.min(Math.floor(raw), ID_PARTITION_LANES);
}

/** the header a primary reports its provisioned lane count on */
export const LANES_HEADER = 'x-cfw-lanes';

/**
 * The header the front worker reports which object answered on; `primary` or `r<lane>`.
 *
 * Nothing reported this and a whole class of measurement was taken without it. A driven copy left
 * `lanes_provisioned` unwritten, so the router never learned the pool existed: every arm labelled
 * `3 lanes` served from the primary while the rig printed the lanes ready. `x-cfw-lane` is a
 * different question -- it names the SERVING TIER (storage, php-gate, plan), not the object.
 */
export const REPLICA_HEADER = 'x-cfw-replica';

/** how long an isolate routes to a lane count it learned, in ms */
export const LANES_TRUST_MS = 60_000;

/** what this isolate last heard a primary say about its pool, and when */
const lanesSeen = new Map<string, { lanes: number; at: number }>();

/**
 * Records the lane count a primary reported.
 *
 * WITHOUT THIS, AUTOSCALING BUILT LANES NOTHING ROUTED TO. `autoScaleStep()` writes
 * `lanes_provisioned` into the object's own meta and {@link replicaCount} reads only `REPLICA_COUNT`
 * from env, which the canonical config does not set -- so a contended site paid to copy its database
 * into N objects and kept answering every request from one.
 *
 * Read off the primary's OWN response, never off the request, for the same reason `rememberRoles()`
 * is: a client cannot present a lane count. Routing to a lane that has finished copying but has not
 * yet promoted is safe rather than merely tolerable -- a lane refuses until it is SERVING and hands
 * the request back, which is why the router needs no readiness cache.
 */
export function rememberLanes(site: string, lanes: number, nowMs: number): void {
	if (!Number.isFinite(lanes) || lanes < 1) return;
	if (lanesSeen.size > 64) lanesSeen.clear();
	// the SAME ceiling {@link replicaCount} applies, imported rather than restated. This held a
	// separate literal 32, so a primary that reported a larger pool was believed at 32 and the router
	// hashed over a fraction of the objects the site had paid to build -- the lane count is defined
	// in several places and this is one of the two the router actually reads.
	lanesSeen.set(site, { lanes: Math.min(Math.floor(lanes), ID_PARTITION_LANES), at: nowMs });
}

/** the lane count this isolate may route against, or 0 when it has not learned one recently */
export function believedLanes(site: string, nowMs: number): number {
	const seen = lanesSeen.get(site);
	if (!seen || nowMs - seen.at >= LANES_TRUST_MS) return 0;
	return seen.lanes;
}

/** drops what this isolate believes about every pool; tests use it */
export function resetLaneBeliefs(): void {
	lanesSeen.clear();
}

/**
 * The stable string a lane is chosen from.
 *
 * Anonymous requests spread by client address, then by path when they carry no address, so they
 * still spread rather than piling onto whichever lane the empty string hashes to.
 *
 * A SESSION-CARRYING REQUEST IS KEYED ON THE PATH, so a page's readers share a lane. Measured over
 * eight paths a run, two fresh sessions each, three lanes and the primary: keyed on the session the
 * plan tier compiled on 5/8 and 4/8 paths, keyed on the path 6/8 -- and the trials that failed under
 * the session key are the ones whose two sessions landed on different objects. It is a rate rather
 * than a rule, because a split pair still compiles sometimes: the compile runs in the FRONT WORKER's
 * isolate, so it sees both renders wherever they came from, and what a split costs it is agreement
 * on the generation the two samples were taken at.
 *
 * The trade is per-page concurrency for authenticated readers, and it is the right way round: the
 * anonymous slice is the bulk of the traffic and keeps spreading by address, while a plan HIT
 * answers without rendering at all, which beats sharing a page's renders across lanes.
 *
 * **AN ANONYMOUS ONE-MACHINE CLIENT CANNOT SPREAD ACROSS A POOL.** It presents one address on every
 * request, so the middle branch here returns one key however many paths it rotates through --
 * measured on a local rig, an anonymous drive reported `x-cfw-replica` as `{r3: 662}`, one object
 * for 100% of samples. Real traffic has the spread for free;
 * `scripts/measure/v101-arms.ts --clients=N` is how a rig gets it.
 *
 * It does NOT explain a pool whose lanes answer nothing, and it was wrongly blamed for one. An
 * AUTHENTICATED drive keys on the path, and the eight paths that rig rotates cover 4 of 4 buckets
 * at 3 lanes and 6 of 8 at 7 -- computed against this file's own FNV-1a, offline, in twenty lines.
 * The cause there was admission: a lane is refused until something mints `state:system.private_key`.
 * Count the distinct objects in `x-cfw-replica` AND check the lanes reached `SERVING` before
 * attributing a pool reading to routing.
 */
export function affinityKey(input: {
	session: string | null;
	address: string | null;
	pathname: string;
}): string {
	const session = (input.session ?? '').trim();
	if (session !== '') return `p:${input.pathname}`;
	const address = (input.address ?? '').trim();
	if (address !== '') return `a:${address}`;
	return `p:${input.pathname}`;
}

/**
 * How long a SERVING lane may go without pulling the log; the bound on staleness.
 *
 * Nothing else catches a lane falling behind: the fence refuses only a caller that states a
 * freshness requirement, and a visitor states none. Without this the lane re-arms at `KEEP_WARM_MS`,
 * measured at 240,000 against 30,000 here. Each round costs two DO requests against the primary.
 */
export const DEFAULT_REPLICA_LAG_MS = 30_000;

export function replicaLagMs(env?: { REPLICA_LAG_MS?: string | null }): number {
	const raw = Number(String(env?.REPLICA_LAG_MS ?? '').trim());
	if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_REPLICA_LAG_MS;
	// under a second a lane spends more on asking than on serving
	return Math.min(Math.max(Math.floor(raw), 1_000), 300_000);
}

/** FNV-1a, because the only property needed is a stable spread and a hash here is not a secret */
function hash(value: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/**
 * The only route a lane may answer.
 *
 * An allow-list of one rather than a deny-list, because the cost of the two mistakes is not
 * symmetric: a route wrongly pinned to the primary loses capacity nobody sees, and a route wrongly
 * spread answers from a replica's copy. `/export` would hand a caller one lane's database, and
 * `GET /migrate` re-runs migration on an object that is not the site.
 *
 * Every visitor path is rewritten to `/serve` before this is asked, so the list needs no other entry.
 */
const SPREAD_ROUTES: ReadonlySet<string> = new Set(['/serve']);

/**
 * Visitor paths whose writes a lane always refuses, so they go to the primary without the detour.
 *
 * A module install creates tables the state inventory does not know, and an unknown table is an
 * origination hazard. The drupflare settings form writes account KV through `cfwSettings`, which
 * no lane may call. Matched as prefixes; anything else is still forwarded and refused if it must be.
 */
const ORIGINATION_PREFIXES = ['/admin/modules', '/admin/config/drupflare/settings'] as const;

/** why a write originates on every path through it, or null when forwarding might succeed */
export function originationRoute(visitorPath: string, contentType: string | null): string | null {
	// an upload writes the file store through `cfwFileWrite`, which is not a replica-safe capability
	if (/^multipart\/form-data\b/i.test(contentType ?? ''))
		return 'an upload writes the file store';
	const path = visitorPath.split('?')[0] ?? '';
	const hit = ORIGINATION_PREFIXES.find((p) => path === p || path.startsWith(`${p}/`));
	return hit ? `${hit} writes what only the primary may originate` : null;
}

/**
 * Which lane answers this request.
 *
 * Only reads on the serving path are spread. A write goes straight to the primary rather than
 * spending a hop to be refused; the failover path is for a request that turns out to mutate.
 *
 * @param affinity - hashed, never compared, so passing a credential does not expose one.
 */
export function chooseTarget(input: {
	site: string;
	method: string;
	affinity: string;
	replicas: number;
	/** the front worker's own pathname, already rewritten; absent pins to the primary */
	pathname?: string;
	/**
	 * whether a lane may execute a write and forward it.
	 *
	 * With this off a POST pinned to the primary, which meant the forwarding path had no workload at
	 * all: the only writes reaching a lane were the ones incidental to a GET. The expensive half of a
	 * Drupal write is form processing and the response render, and neither is authoritative.
	 */
	writeForward?: boolean;
	/**
	 * Whether the request already carries a session.
	 *
	 * A WRITE THAT CARRIES NO SESSION MAY ESTABLISH ONE, AND A LANE CANNOT. Forwarding executes the
	 * write on the lane, discards its own effect and sends the statements to the primary -- but the
	 * `Set-Cookie` handed back was minted during the lane's speculative run, so the client leaves
	 * holding a session id the primary does not have. Observed over six consecutive logins on a
	 * 4-lane site: five answered by the primary, one by `r3`, and after that one the PRIMARY itself
	 * read `x-cfw-roles: anonymous` on 125 of 200 samples. It presents as "the site stopped
	 * accepting the password".
	 *
	 * Login, registration and password reset are exactly the writes that arrive without a session,
	 * so pinning on this covers the class without naming any route.
	 */
	hasSession?: boolean;
	/** the visitor's own path, which `pathname` no longer holds after the rewrite to `/serve` */
	visitorPath?: string;
	contentType?: string | null;
}): RoutingDecision {
	const primary: RoutingDecision = {
		target: input.site,
		role: 'primary',
		lane: 0,
		reason: ''
	};

	const lanes = Math.max(0, Math.floor(input.replicas)) + 1;
	if (lanes === 1) return { ...primary, reason: 'no replicas configured' };

	const method = input.method.toUpperCase();
	const write = method !== 'GET' && method !== 'HEAD';
	if (write && input.writeForward !== true) {
		return { ...primary, reason: 'a write goes to the primary without asking a replica first' };
	}

	if (!SPREAD_ROUTES.has(input.pathname ?? '')) {
		return {
			...primary,
			reason: `${input.pathname ?? 'an unnamed route'} is not the serving path`
		};
	}

	// after the route check, so a write to a route that was never spreadable still reports the
	// reason it was never spreadable
	if (write && input.hasSession !== true) {
		return { ...primary, reason: 'a write carrying no session may establish one' };
	}

	const originates = write
		? originationRoute(input.visitorPath ?? '', input.contentType ?? null)
		: null;
	if (originates) return { ...primary, reason: originates };

	const lane = hash(input.affinity) % lanes;
	if (lane === 0) return { ...primary, reason: 'affinity chose the primary lane' };
	return {
		target: replicaName(input.site, lane),
		role: 'replica',
		lane,
		reason: 'affinity'
	};
}

/**
 * Whether a replica's refusal may be retried on the primary.
 *
 * Reads the header the replica computed from `didMutate()`; a retry after a partial mutation
 * double-applies it, so safety is never inferred from the status alone.
 */
export function shouldFailover(res: {
	status: number;
	headers: { get(name: string): string | null };
}): boolean {
	if (res.status !== 421) return false;
	if (res.headers.get('x-cfw-requires-primary') === null) return false;
	return res.headers.get('x-cfw-retry-safe') === '1';
}
