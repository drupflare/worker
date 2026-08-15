import { isPaid, type PlanEnv } from './plan';

/**
 * The page cache tier that survives a colo, for the paid plan only.
 *
 * It cannot live in the Durable Object. `serveFromStorage()` is synchronous by construction -- an
 * `await` there introduces exactly the suspension the reentrancy contract forbids -- and every KV read
 * is asynchronous. So a KV backend cannot serve the DO's storage lane at any price. It belongs in the
 * Worker, which is already async and already does a `caches.default` lookup before reaching the object.
 *
 * Paid-only because of a meter. The DO's own `cfw_page`
 * table spends **row writes**, and that budget is measured here at 100,000/day, which is what caps
 * fills near 20,000/day. KV spends a different and much smaller daily write allowance on the free
 * plan, so a free site that cached every page to KV would exhaust that allowance long before it
 * exhausted the one it is already engineered against -- trading a known-good limit for a tighter and
 * unmeasured one. Paid has neither constraint and gains what KV is actually for: a page rendered in one
 * colo answers from every colo **without touching the Durable Object at all**, which is the cost driver
 * on paid.
 *
 * Degrades to nothing. No binding, or a free site, and every function here is a no-op that reports
 * why -- so the tier can ship before any namespace exists and a misconfiguration cannot take the site
 * down.
 */

/** the KV surface this tier uses; narrowed so a test can supply a plain object */
export type PageKv = {
	get(key: string, type: 'text'): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
};

export type PageStoreEnv = PlanEnv & {
	/** optional: the tier is absent rather than broken when this is not bound */
	PAGE_KV?: PageKv | null;
	/** force the tier on ('1') or off ('0'), overriding the per-plan default */
	PAGE_KV_ENABLED?: string | null;
	/** seconds; a stored page is also generation-keyed, so this is a floor on garbage not a freshness knob */
	PAGE_KV_TTL?: string | number | null;
};

/** what a stored page carries; the status and content type travel with the body or a 200 is assumed */
export type StoredPage = {
	status: number;
	contentType: string;
	html: string;
};

/** the default lifetime of a stored page, one day */
export const DEFAULT_PAGE_KV_TTL_SECONDS = 86_400;

/** KV's own minimum; a smaller value is rejected by the API rather than clamped */
export const KV_MIN_TTL_SECONDS = 60;

/**
 * Whether the KV page tier should be used at all.
 *
 * Three-way, most specific first, matching every other per-plan decision here: an explicit
 * `PAGE_KV_ENABLED`, then the plan. A missing binding always wins over both -- asking for a tier that
 * is not bound is a configuration error, and answering it with a crash on the serving path would be
 * the wrong trade.
 */
export function pageKvEnabled(env?: PageStoreEnv | null): boolean {
	if (!env?.PAGE_KV) return false;
	const explicit = env?.PAGE_KV_ENABLED;
	if (explicit !== undefined && explicit !== null && String(explicit) !== '') {
		return String(explicit) !== '0';
	}
	return isPaid(env);
}

/** seconds a stored page lives; floored at KV's own minimum so a bad value cannot make writes fail */
export function pageKvTtlSeconds(env?: PageStoreEnv | null): number {
	const raw = Number(env?.PAGE_KV_TTL ?? 0);
	if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PAGE_KV_TTL_SECONDS;
	return Math.max(KV_MIN_TTL_SECONDS, Math.floor(raw));
}

/**
 * The key a page is stored under.
 *
 * The GENERATION is in the key, which is what makes invalidation free: a bump changes every key at
 * once, so nothing has to be enumerated or deleted. That is the same design the `caches.default` tier
 * uses, and it matters more here -- KV has no bulk delete, so a scheme needing one would be
 * uninvalidatable in practice.
 */
export function pageKvKey(site: string, generation: string | number, path: string): string {
	return `page:${site}:${generation}:${path}`;
}

/**
 * Reads a stored page, or `null` for a miss.
 *
 * Never throws. A KV read that fails is a cache miss, because the alternative is a 500 on a path that
 * has a working fallback one tier down.
 */
export async function readPage(
	env: PageStoreEnv | null | undefined,
	site: string,
	generation: string | number,
	path: string
): Promise<StoredPage | null> {
	if (!pageKvEnabled(env) || !env?.PAGE_KV) return null;
	try {
		const raw = await env.PAGE_KV.get(pageKvKey(site, generation, path), 'text');
		if (raw === null) return null;
		const parsed = JSON.parse(raw) as Partial<StoredPage>;
		if (typeof parsed.html !== 'string') return null;
		return {
			status: typeof parsed.status === 'number' ? parsed.status : 200,
			contentType:
				typeof parsed.contentType === 'string'
					? parsed.contentType
					: 'text/html; charset=utf-8',
			html: parsed.html
		};
	} catch {
		// unparseable or unavailable is a MISS, not an error: one tier down still answers
		return null;
	}
}

/**
 * Stores a page. Returns whether it was written, so a caller can report the tier accurately.
 *
 * Never throws, for the same reason as the read: a write failure must not fail a request that already
 * has its answer in hand.
 */
export async function writePage(
	env: PageStoreEnv | null | undefined,
	site: string,
	generation: string | number,
	path: string,
	page: StoredPage
): Promise<boolean> {
	if (!pageKvEnabled(env) || !env?.PAGE_KV) return false;
	// a placeholder is not a page. The cold path answers 503 + Retry-After while the kernel comes up,
	// and storing that would pin "warming" into a global cache for a day
	if (page.status !== 200 || page.html.length === 0) return false;
	try {
		await env.PAGE_KV.put(pageKvKey(site, generation, path), JSON.stringify(page), {
			expirationTtl: pageKvTtlSeconds(env)
		});
		return true;
	} catch {
		return false;
	}
}
