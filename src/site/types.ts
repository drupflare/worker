import type { SiteEnv } from '../env';
import type { PlanTier } from '../ops/edge-plan';
import type { FleetDb } from '../ops/fleet';
import type { PageKv } from '../ops/page-store';
import type { PlanKv } from '../ops/plan';
import type { RoutingDecision } from '../ops/replica-routing';

/** What the front end requires: the namespace is not optional for a Worker that only proxies. */
export interface SiteWorkerEnv extends SiteEnv {
	SITE: DurableObjectNamespace;
	/** the cross-colo page tier; optional, the tier is absent rather than broken when unbound */
	PAGE_KV?: PageKv;
	PAGE_KV_ENABLED?: string;
	PAGE_KV_TTL?: string | number;
	/**
	 * The runtime-configurable settings namespace, holding the plan override.
	 *
	 * Optional: unbound leaves the deployed `PLAN` var in force, so a KV outage cannot take a paid
	 * site to free.
	 */
	CONFIG_KV?: PlanKv;
	/** the cross-site inventory; optional, a single site does not need one */
	FLEET_DB?: FleetDb;
	/**
	 * The site every request on this deployment resolves to, unless KV maps the host to another.
	 * Second in the chain: KV, then this, then the hostname, then `site`.
	 */
	SITE_ID?: string;
}

/** Hands a write to the runtime after the response leaves; a missing promise is ignored. */
export type Defer = (p: Promise<unknown> | undefined) => void;

/** The request as the entry stages see it, before a target site is chosen. */
export interface FrontEntry {
	request: Request;
	url: URL;
	env: SiteWorkerEnv;
	ctx?: ExecutionContext;
	/** when the front worker started the request, in ms */
	t0: number;
	/** the site resolved before the levers were read */
	resolvedSite: string;
	/** the path began with `/__`, which belongs to the object and is never a page */
	internal: boolean;
	/** set by the catch-all rewrite, which moves a page path into `/serve` */
	pageRequest: boolean;
	/** the owner token a request proved, for the routes that need one */
	ownerToken?: string;
	defer: Defer;
}

/** Everything a serving stage reads once the target site is known. */
export interface FrontContext extends FrontEntry {
	site: string;
	/** the visitor's own path without its query (`url.pathname` is `/serve` after the rewrite) */
	visitorPath: string;
	cache: Cache;
	origin: string;
	/** the generation pointer window this request falls in */
	bucket: number;
	/** a safe method on `/serve`, the only request the edge tiers may answer */
	serving: boolean;
	/** the `path` parameter a page request carries */
	path: string;
	/** the routing decision, made on first read */
	laneOf(): RoutingDecision;
	/** the stub for the chosen lane, built on first read */
	stubOf(): DurableObjectStub;
	/** drops the memoised stub so the next read builds a fresh one after a reset */
	forgetStub(): void;
}

/** What the authenticated allowance decided for a request. */
export interface AuthState {
	authenticated: boolean;
	mode: 'render' | 'stale' | 'read-only';
	reason: string;
	/** authenticated and rendered per user, so no shared tier may answer or store it */
	personalised: boolean;
	/** whether the allowance is enforced on this plan, read once on first use */
	enforcedOf(): boolean;
}

/** The compiled plan tier's verdict for a request. */
export interface PlanRead {
	cookie: string;
	wanted: boolean;
	tier: PlanTier;
}

/** The edge tiers' shared state: whether they apply and the generation they keyed on. */
export interface EdgeRead {
	wanted: boolean;
	generation?: number;
}

/** The object's answer, and which lane handed back when a replica refused. */
export interface Hop {
	res: Response;
	/** the lane that refused, when the primary re-served */
	failedOverFrom?: number;
	/** the `x-cfw-requires-primary` reason the refusing lane gave */
	failoverReason?: string;
}

/** What the front worker learned from the object's answer. */
export interface Learned {
	/** the `/enable` fill arming outcome, or `n/a` */
	armedFill: string;
	/** the object's cache tier for this answer, or `n/a` / `unknown:<tier>` */
	doCache: string;
	/** the generation the object reported */
	generation?: number;
}

/** What the edge stores decided, reported on the response headers. */
export interface StoreOutcome {
	put: string;
	kvPut: string;
}
