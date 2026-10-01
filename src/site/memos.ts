import { type AuthSpend, utcDayKey } from '../ops/auth-budget';
import { ABSORBED_REPORT_MAX } from '../ops/cold-encounter';
import {
	believedLanes,
	formatLanesPointer,
	lanesKvKey,
	parseLanesPointer,
	rememberLanes
} from '../ops/replica-routing';
import { cacheKey } from './edge-cache';

/**
 * Page requests this isolate answered per site (plan, memo, `caches.default` and KV hits never
 * reach the object), waiting for the next hop to carry the count in.
 * A dying isolate loses its count, which biases the reported cold rate up, the safe direction.
 */
const absorbedSinceHop = new Map<string, number>();

/** the key is a resolved hostname, so the map is bounded the way `adminSessionBudget()`'s is */
const ABSORBED_SITES_MAX = 1024;

/** counts one request this isolate answered without the object, capped at `ABSORBED_REPORT_MAX` */
export function noteAbsorbed(site: string): void {
	if (absorbedSinceHop.size >= ABSORBED_SITES_MAX && !absorbedSinceHop.has(site)) return;
	absorbedSinceHop.set(
		site,
		Math.min(ABSORBED_REPORT_MAX, (absorbedSinceHop.get(site) ?? 0) + 1)
	);
}

/** what to report on a hop, excluding the hopping request itself (the object counts that one) */
export function drainAbsorbed(site: string, self: boolean): number {
	const held = absorbedSinceHop.get(site) ?? 0;
	absorbedSinceHop.delete(site);
	return Math.max(0, held - (self ? 1 : 0));
}

/**
 * The edge cache key for the lane-count pointer.
 * `believedLanes()` only learns from a response, so a cold isolate routes its first request to the
 * primary (measured: a 904-request drive on a 32-lane site was all primary).
 */
function laneKey(origin: string, site: string): string {
	return `${origin}/__cfw/lanes/${encodeURIComponent(site)}`;
}

/**
 * How long the edge pointer lives, far longer than {@link LANES_TRUST_MS}.
 * Stale-high costs one retried hop; stale-absent sends everything to the primary, so it must not
 * expire under load (a shed answer refreshes nothing unless it carries `x-cfw-lanes`).
 */
const LANE_POINTER_TTL_S = 900;

/** how long a colo remembers that `CONFIG_KV` had no pool, so poolless sites rarely read KV */
const LANE_ABSENT_TTL_S = 300;

/**
 * Seeds this isolate's belief from the edge so the first request routes on it: `caches.default`
 * (per colo) first, then `CONFIG_KV` (global); either answer, pool or absence, is cached per colo.
 *
 * @internal exported for `replica-failover.spec.ts` (the primary memoises `lanesProvisioned()`,
 * so a fixture cannot reach it through a request)
 */
export async function primeLanes(
	cache: Cache,
	origin: string,
	site: string,
	kv?: { get(key: string): Promise<string | null> }
): Promise<void> {
	if (believedLanes(site, Date.now()) > 0) return;
	try {
		const hit = await cache.match(laneKey(origin, site));
		if (hit) {
			const held = parseLanesPointer(await hit.text());
			if (held && held.lanes > 0) rememberLanes(site, held.lanes, Date.now(), held.epoch);
			return;
		}
		if (!kv) return;
		const stored = parseLanesPointer(await kv.get(lanesKvKey(site)));
		if (stored && stored.lanes > 0) {
			rememberLanes(site, stored.lanes, Date.now(), stored.epoch);
			await writeLanes(cache, origin, site, stored.lanes, stored.epoch);
		} else {
			await writeLanes(cache, origin, site, 0, 0, LANE_ABSENT_TTL_S);
		}
	} catch {
		// no pointer just means this isolate learns from the response the way it always did
	}
}

/** publishes what the primary reported so the next cold isolate need not ask; @internal */
export async function writeLanes(
	cache: Cache,
	origin: string,
	site: string,
	lanes: number,
	epoch = 0,
	ttlS = LANE_POINTER_TTL_S
): Promise<void> {
	try {
		await cache.put(
			laneKey(origin, site),
			new Response(formatLanesPointer(lanes, epoch), {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'cache-control': `public, max-age=${ttlS}`
				}
			})
		);
	} catch {
		// the pointer is an optimisation; routing still works off the header
	}
}

// #region the authenticated allowance, memoised so degrading costs no DO request
// the object reports the spend on a hop already happening; once spent, auth degrades at the edge

/** isolate-local, keyed by site and UTC day, so a re-read costs nothing */
const authMemo = new Map<string, AuthSpend>();

const authKey = (origin: string, site: string, day: string) =>
	cacheKey(origin, ['authbudget', site, day]);

/** how long a spend record may sit at the edge; only has to outlive the UTC day it names */
const AUTH_SPEND_TTL_S = 3600;

/** reads today's authenticated spend from the memo, then the edge; undefined if unknown */
export async function readAuthSpend(
	cache: Cache,
	origin: string,
	site: string,
	now: number
): Promise<AuthSpend | undefined> {
	const day = utcDayKey(now);
	const memo = authMemo.get(`${site}#${day}`);
	if (memo !== undefined) return memo;
	try {
		const hit = await cache.match(authKey(origin, site, day));
		if (!hit) return undefined;
		const parsed = JSON.parse(await hit.text()) as AuthSpend;
		// a record naming another day is not this day's budget
		if (!parsed || parsed.day !== day || !Number.isFinite(parsed.renders)) return undefined;
		authMemo.set(`${site}#${day}`, parsed);
		return parsed;
	} catch {
		// unreadable means not known yet, which renders rather than refusing
		return undefined;
	}
}

/** records the object's reported spend in the isolate memo and at the edge */
export async function writeAuthSpend(
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
