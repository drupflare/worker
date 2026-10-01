/**
 * Which object answers a request, once a site has more than one.
 *
 * The primary is lane 0, so `replicas = 0` is a modulus of 1 rather than a branch in the caller.
 * Lanes are chosen by affinity: a shared counter measured a flat scaling curve on the rig,
 * per-client pinning 1.00 / 1.80 / 2.14.
 * @module
 */
import { fnv1a32 } from '../util/hash';
import { ID_PARTITION_LANES } from './write-forwarding';

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

/** the site a replica name belongs to, or undefined when the name is not one */
export function replicaOf(name: string): { site: string; lane: number } | undefined {
	const at = name.lastIndexOf('#r');
	if (at <= 0) return undefined;
	const lane = Number(name.slice(at + 2));
	if (!Number.isInteger(lane) || lane < 1) return undefined;
	return { site: name.slice(0, at), lane };
}

/**
 * How many replica lanes a site has, beyond the primary; unset, unparseable and negative are 0.
 *
 * The ceiling is {@link ID_PARTITION_LANES}: a lane mints forwarded ids from its residue class
 * modulo `ID_PARTITION_LANES + 1`, so lane 257 would wrap onto the primary's class and two writers
 * would mint the same id. `replica-demand.ts` has a smaller `REPLICA_MAX_LANES` for autoscaling.
 *
 * It sets how many buckets the router hashes over; above the provisioned count that routes to
 * objects that do not exist (a wasted hop and a primary retry). `chooseTarget()` takes
 * `max(this, believedLanes)`.
 */
export function replicaCount(env?: { REPLICA_COUNT?: string }): number {
	const raw = Number(String(env?.REPLICA_COUNT ?? '').trim());
	if (!Number.isFinite(raw) || raw < 1) return 0;
	return Math.min(Math.floor(raw), ID_PARTITION_LANES);
}

/** the header a primary reports its provisioned lane count on */
export const LANES_HEADER = 'x-cfw-lanes';

/**
 * The header naming which object answered: `primary` or `r<lane>`.
 *
 * `x-cfw-lane` is a different question; it names the serving tier (storage, php-gate, plan).
 */
export const REPLICA_HEADER = 'x-cfw-replica';

/** how long an isolate routes to a lane count it learned, in ms */
export const LANES_TRUST_MS = 60_000;

/**
 * The pool's topology epoch, beside {@link LANES_HEADER}.
 *
 * The primary bumps it whenever the pool changes, so two readings can be ordered without assuming
 * the pool only grows: a pointer carrying an older epoch is known to be stale, not merely old.
 */
export const LANES_EPOCH_HEADER = 'x-cfw-lanes-epoch';

/** the durable copy in `CONFIG_KV`, one per site, written by the primary once per epoch */
export function lanesKvKey(site: string): string {
	return `lanes:${site}`;
}

/** `lanes@epoch`, the form every pointer copy is stored in */
export function formatLanesPointer(lanes: number, epoch: number): string {
	return `${Math.max(0, Math.floor(lanes))}@${Math.max(0, Math.floor(epoch))}`;
}

/** the inverse; a bare count from before the epoch reads as epoch 0, garbage as undefined */
export function parseLanesPointer(
	raw: string | null
): { lanes: number; epoch: number } | undefined {
	const m = /^(\d+)(?:@(\d+))?$/.exec((raw ?? '').trim());
	if (!m) return undefined;
	return { lanes: Number(m[1]), epoch: Number(m[2] ?? 0) };
}

/** what this isolate last heard a primary say about its pool, and when */
const lanesSeen = new Map<string, { lanes: number; at: number; epoch: number }>();

/**
 * Records the lane count a primary reported.
 *
 * Without it autoscaling builds lanes nothing routes to: `autoScaleStep()` writes
 * `lanes_provisioned` into the object's meta while {@link replicaCount} reads only `REPLICA_COUNT`.
 *
 * Read off the primary's own response, never the request, since a client cannot present a lane
 * count. Routing to a lane that has not yet promoted is safe: it refuses until SERVING and hands
 * the request back, so the router needs no readiness cache.
 */
export function rememberLanes(site: string, lanes: number, nowMs: number, epoch = 0): void {
	if (!Number.isFinite(lanes) || lanes < 1) return;
	const held = lanesSeen.get(site);
	// an older topology never replaces a newer one this isolate still trusts
	if (held && nowMs - held.at < LANES_TRUST_MS && epoch < held.epoch) return;
	if (lanesSeen.size > 64) lanesSeen.clear();
	// the same ceiling `replicaCount` applies; a separate literal hid part of a larger pool
	lanesSeen.set(site, {
		lanes: Math.min(Math.floor(lanes), ID_PARTITION_LANES),
		at: nowMs,
		epoch
	});
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
 * Anonymous requests spread by client address, then by path when they carry no address. A
 * session-carrying request is keyed on the path so a page's readers share a lane (the plan tier
 * compiled on 6/8 paths keyed on the path against 5/8 and 4/8 keyed on the session).
 *
 * An anonymous one-machine client presents one address, so it cannot spread across a pool (one rig
 * drive read `{r3: 662}`); `scripts/measure/v101-arms.ts --clients=N` gives a rig the spread.
 */
export function affinityKey(input: {
	session?: string;
	address?: string;
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
 * The fence refuses only a caller that states a freshness requirement and a visitor states none;
 * without this the lane re-arms at `KEEP_WARM_MS` (240,000 against 30,000). Each round costs two DO
 * requests against the primary.
 */
export const DEFAULT_REPLICA_LAG_MS = 30_000;

/** the lane pull interval from `REPLICA_LAG_MS`, clamped to 1-300 s */
export function replicaLagMs(env?: { REPLICA_LAG_MS?: string }): number {
	const raw = Number(String(env?.REPLICA_LAG_MS ?? '').trim());
	if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_REPLICA_LAG_MS;
	// under a second a lane spends more on asking than on serving
	return Math.min(Math.max(Math.floor(raw), 1_000), 300_000);
}

/** FNV-1a; only a stable spread is needed and the hash is not a secret */
function hash(value: string): number {
	return fnv1a32(value);
}

/**
 * The only route a lane may answer.
 *
 * An allow-list, not a deny-list: a route wrongly spread answers from a replica's copy (`/export`
 * would hand out one lane's database, `GET /migrate` would re-run migration on a non-site object).
 * Every visitor path is rewritten to `/serve` before this is asked.
 */
const SPREAD_ROUTES: ReadonlySet<string> = new Set(['/serve']);

/**
 * Visitor paths whose writes a lane always refuses, so they go to the primary without the detour.
 *
 * A module install creates tables the state inventory does not know, and the settings form writes
 * account KV through `cfwSettings`, which no lane may call. Matched as prefixes.
 */
const ORIGINATION_PREFIXES = ['/admin/modules', '/admin/config/drupflare/settings'] as const;

/** why a write originates on every path through it, or undefined when forwarding might succeed */
export function originationRoute(
	visitorPath: string,
	contentType: string | undefined
): string | undefined {
	// an upload writes the file store through `cfwFileWrite` (not replica-safe)
	if (/^multipart\/form-data\b/i.test(contentType ?? ''))
		return 'an upload writes the file store';
	const path = visitorPath.split('?')[0] ?? '';
	const hit = ORIGINATION_PREFIXES.find((p) => path === p || path.startsWith(`${p}/`));
	return hit ? `${hit} writes what only the primary may originate` : undefined;
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
	 * whether a lane may execute a write and forward it; off pins every POST to the primary
	 */
	writeForward?: boolean;
	/**
	 * Whether the request already carries a session.
	 *
	 * A write with no session may establish one, and a lane cannot: its `Set-Cookie` is minted in
	 * the speculative run, so the client holds a session id the primary lacks (login looks like a
	 * rejected password). Pinning on this covers login, registration and reset without route names.
	 */
	hasSession?: boolean;
	/** the visitor's own path (`pathname` is `/serve` after the rewrite) */
	visitorPath?: string;
	contentType?: string;
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

	// after the route check, so an unspreadable route reports that reason
	if (write && input.hasSession !== true) {
		return { ...primary, reason: 'a write carrying no session may establish one' };
	}

	const originates = write
		? originationRoute(input.visitorPath ?? '', input.contentType)
		: undefined;
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
