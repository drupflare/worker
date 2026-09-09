import { isPaid, type PlanEnv } from './plan.js';

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
	/** extra path prefixes that may never be answered from a previous generation, comma separated */
	NEVER_STALE?: string | null;
};

/** what a stored page carries; the status and content type travel with the body or a 200 is assumed */
export type StoredPage = {
	status: number;
	contentType: string;
	html: string;
	/**
	 * when this was written, in ms.
	 *
	 * Only the stale reader uses it: the generation bound says how many content changes back a page
	 * is, and this is what says how long ago. Optional because a record written before it existed is
	 * still a valid page; {@link readStalePage} treats an absent value as unbounded age rather than
	 * as zero, which would make every old record look fresh.
	 */
	storedAt?: number;
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
			html: parsed.html,
			...(typeof parsed.storedAt === 'number' ? { storedAt: parsed.storedAt } : {})
		};
	} catch {
		// unparseable or unavailable is a MISS, not an error: one tier down still answers
		return null;
	}
}

/**
 * How many generations back a miss may look before it gives up.
 *
 * A generation counter is monotonic, so `N-1` is exactly one content change behind. Two is the
 * whole budget: each step is another KV read in front of the object, and at three the read cost
 * exceeds the hop it is trying to avoid.
 */
export const STALE_GENERATION_DEPTH = 2;

/**
 * The oldest a stale answer may be, in ms.
 *
 * The generation bound says how many changes behind; this says how long. Without it an abandoned
 * site serves last month's page forever, because nothing ever bumps it past the depth above.
 */
export const STALE_MAX_AGE_MS = 86_400_000;

/** paths that must never be answered from a previous generation, matched as prefixes */
const NEVER_STALE = [
	'/user/login',
	'/user/logout',
	'/user/password',
	'/user/register',
	'/admin/config',
	'/admin/people',
	'/admin/modules',
	'/cart',
	'/checkout'
];

/**
 * Whether a path may be answered from a previous generation.
 *
 * A DENY-LIST rather than an allow-list, and the direction is the decision: serving a stale page is
 * only ever a latency win, and the pages where it is wrong are the ones a visitor acts on. An
 * operator-supplied list is added rather than replacing this one, so a site cannot make its own
 * login page staleable by configuring badly.
 */
export function staleAllowed(path: string, extra: string | null | undefined = null): boolean {
	const denied = [
		...NEVER_STALE,
		...String(extra ?? '')
			.split(',')
			.map((p) => p.trim())
			.filter((p) => p !== '')
	];
	return !denied.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * A page from a PREVIOUS generation, when the current one has none.
 *
 * The bytes are already there. `PAGE_KV_TTL`'s own comment calls itself "a floor on garbage, not a
 * freshness knob" precisely because a stored page is generation-keyed, so bumping the generation
 * does not delete the previous generation's entries -- they expire on their own TTL. The previous
 * answer is sitting in KV on every deployed site, unread. This is a READ change and not a storage
 * design.
 *
 * Returns the page and how many generations back it came from, so the caller can say so in a header
 * and schedule the regeneration rather than rendering inline.
 */
export async function readStalePage(
	env: PageStoreEnv | null | undefined,
	site: string,
	generation: number,
	path: string,
	opts: { depth?: number; nowMs?: number; neverStale?: string | null } = {}
): Promise<{ page: StoredPage; behind: number } | null> {
	if (!pageKvEnabled(env) || !env?.PAGE_KV) return null;
	if (!staleAllowed(path, opts.neverStale)) return null;
	const depth = Math.max(1, Math.min(opts.depth ?? STALE_GENERATION_DEPTH, 8));
	const now = opts.nowMs ?? Date.now();
	for (let behind = 1; behind <= depth; behind++) {
		const previous = generation - behind;
		if (previous < 0) return null;
		const page = await readPage(env, site, previous, path);
		if (page === null) continue;
		// a wall-clock bound on top of the generation bound; see STALE_MAX_AGE_MS
		if (typeof page.storedAt === 'number' && now - page.storedAt > STALE_MAX_AGE_MS) {
			return null;
		}
		return { page, behind };
	}
	return null;
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
		await env.PAGE_KV.put(
			pageKvKey(site, generation, path),
			// stamped on the way in rather than taken from the caller: the age bound on a stale read
			// has to be the write's own clock, not one a caller could set
			JSON.stringify({ ...page, storedAt: Date.now() }),
			{ expirationTtl: pageKvTtlSeconds(env) }
		);
		return true;
	} catch {
		return false;
	}
}
