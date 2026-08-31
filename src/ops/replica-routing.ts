/**
 * Which object answers a request, once a site has more than one.
 *
 * The primary is lane 0 rather than a lane apart, so `replicas = 0` is a modulus of 1 rather than a
 * branch in the caller. Lanes are chosen by affinity: a shared counter measured a flat scaling curve
 * on the rig, per-client pinning measured 1.00 / 1.80 / 2.14.
 */

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

/** how many replica lanes a site has, beyond the primary; unset, unparseable and negative are 0 */
export function replicaCount(env?: { REPLICA_COUNT?: string | null }): number {
	const raw = Number(String(env?.REPLICA_COUNT ?? '').trim());
	if (!Number.isFinite(raw) || raw < 1) return 0;
	// a modest ceiling; a pool this size is already past what the measured curve covers
	return Math.min(Math.floor(raw), 32);
}

/**
 * The stable per-visitor string a lane is chosen from.
 *
 * Session, then client address, then path. The path fallback exists so requests carrying neither
 * still spread rather than piling onto whichever lane the empty string hashes to.
 */
export function affinityKey(input: {
	session: string | null;
	address: string | null;
	pathname: string;
}): string {
	const session = (input.session ?? '').trim();
	if (session !== '') return `s:${session}`;
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
	if (method !== 'GET' && method !== 'HEAD' && input.writeForward !== true) {
		return { ...primary, reason: 'a write goes to the primary without asking a replica first' };
	}

	if (!SPREAD_ROUTES.has(input.pathname ?? '')) {
		return {
			...primary,
			reason: `${input.pathname ?? 'an unnamed route'} is not the serving path`
		};
	}

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
