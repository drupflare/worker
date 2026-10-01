/**
 * The KV page tier: a cache that survives a colo, plus the previous generation.
 *
 * It lives in the Worker because `serveFromStorage()` is synchronous and KV reads are async.
 * With no binding every function is a no-op. Compiled plans share the namespace with no write
 * budget, so {@link planKvWritesEnabled} keeps them paid-only.
 * @module
 */
import { leverInt } from '../util/lever';
import { isPaid, type PlanEnv } from './plan';

/** the KV surface this tier uses; narrowed so a test can supply a plain object */
export type PageKv = {
	get(key: string, type: 'text'): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
};

/** the bindings and levers the KV page tier reads */
export type PageStoreEnv = PlanEnv & {
	/** optional: the tier is absent rather than broken when this is not bound */
	PAGE_KV?: PageKv;
	/** force the tier on ('1') or off ('0'), overriding the per-plan default */
	PAGE_KV_ENABLED?: string;
	/** seconds; pages are generation-keyed, so this is a floor on garbage, not a freshness knob */
	PAGE_KV_TTL?: string | number;
	/** extra comma-separated path prefixes never answered from a previous generation */
	NEVER_STALE?: string;
};

/** what a stored page carries (a missing status or content type reads as 200 and html) */
export type StoredPage = {
	status: number;
	contentType: string;
	html: string;
	/** when written, in ms; absent reads as unbounded age to {@link readStalePage}, not zero */
	storedAt?: number;
};

/** the default lifetime of a stored page, one day */
export const DEFAULT_PAGE_KV_TTL_SECONDS = 86_400;

/** KV's own minimum; a smaller value is rejected by the API rather than clamped */
export const KV_MIN_TTL_SECONDS = 60;

/** whether the KV page tier is used; `PAGE_KV_ENABLED` decides, and no binding always means off */
export function pageKvEnabled(env?: PageStoreEnv): boolean {
	if (!env?.PAGE_KV) return false;
	const explicit = env?.PAGE_KV_ENABLED;
	if (explicit !== undefined && String(explicit) !== '') {
		return String(explicit) !== '0';
	}
	return true;
}

/** the object's permission for the front worker to store the page it is answering with */
export const KV_GRANT_HEADER = 'x-cfw-kv-grant';

/**
 * Page writes to `PAGE_KV` one site may make in a UTC day.
 * Free KV allows 1,000 a day per account and `CONFIG_KV` shares it, so free stops at 800.
 */
export function kvWriteBudget(env?: PlanEnv & { KV_WRITES_PER_DAY?: unknown }): number {
	const raw = env?.KV_WRITES_PER_DAY;
	return leverInt(raw) ?? (isPaid(env) ? Number.POSITIVE_INFINITY : 800);
}

/** whether compiled plans may be written to KV (no write budget, so free needs an explicit `1`) */
export function planKvWritesEnabled(env?: PageStoreEnv): boolean {
	if (!pageKvEnabled(env)) return false;
	return isPaid(env) || String(env?.PAGE_KV_ENABLED ?? '') === '1';
}

/** seconds a stored page lives, floored at KV's minimum so a bad value cannot fail writes */
export function pageKvTtlSeconds(env?: PageStoreEnv): number {
	const raw = Number(env?.PAGE_KV_TTL ?? 0);
	if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PAGE_KV_TTL_SECONDS;
	return Math.max(KV_MIN_TTL_SECONDS, Math.floor(raw));
}

/** the key a page is stored under; the generation is in it, so a bump needs no bulk delete */
export function pageKvKey(site: string, generation: string | number, path: string): string {
	return `page:${site}:${generation}:${path}`;
}

/** reads a stored page, or `undefined` for a miss; never throws (a failed read is a miss) */
export async function readPage(
	env: PageStoreEnv | undefined,
	site: string,
	generation: string | number,
	path: string
): Promise<StoredPage | undefined> {
	if (!pageKvEnabled(env) || !env?.PAGE_KV) return undefined;
	try {
		const raw = await env.PAGE_KV.get(pageKvKey(site, generation, path), 'text');
		if (raw === null) return undefined;
		const parsed = JSON.parse(raw) as Partial<StoredPage>;
		if (typeof parsed.html !== 'string') return undefined;
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
		// unparseable or unavailable is a miss (one tier down still answers)
		return undefined;
	}
}

/** how many generations back a miss may look (at three, the reads cost more than the object hop) */
export const STALE_GENERATION_DEPTH = 2;

/** the oldest a stale answer may be, in ms (an abandoned site is never bumped past the depth) */
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
 * A deny-list; an operator list adds to it, so a bad config cannot make login staleable.
 */
export function staleAllowed(path: string, extra?: string): boolean {
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
 * A page from a previous generation plus how far back it was; the answer carries
 * `x-cfw-edge: STALE` (`x-cfw-cache: KV` alone also matches the object's `AGED` answer).
 */
export async function readStalePage(
	env: PageStoreEnv | undefined,
	site: string,
	generation: number,
	path: string,
	opts: { depth?: number; nowMs?: number; neverStale?: string } = {}
): Promise<{ page: StoredPage; behind: number } | undefined> {
	if (!pageKvEnabled(env) || !env?.PAGE_KV) return undefined;
	if (!staleAllowed(path, opts.neverStale)) return undefined;
	const depth = Math.max(1, Math.min(opts.depth ?? STALE_GENERATION_DEPTH, 8));
	const now = opts.nowMs ?? Date.now();
	for (let behind = 1; behind <= depth; behind++) {
		const previous = generation - behind;
		if (previous < 0) return undefined;
		const page = await readPage(env, site, previous, path);
		if (page === undefined) continue;
		// wall-clock bound on top of the generation bound
		if (typeof page.storedAt === 'number' && now - page.storedAt > STALE_MAX_AGE_MS) {
			return undefined;
		}
		return { page, behind };
	}
	return undefined;
}

/** stores a page and returns whether it was written; never throws (the answer is in hand) */
export async function writePage(
	env: PageStoreEnv | undefined,
	site: string,
	generation: string | number,
	path: string,
	page: StoredPage
): Promise<boolean> {
	if (!pageKvEnabled(env) || !env?.PAGE_KV) return false;
	// the cold path's 503 placeholder must not be stored (it would pin "warming" for a day)
	if (page.status !== 200 || page.html.length === 0) return false;
	try {
		await env.PAGE_KV.put(
			pageKvKey(site, generation, path),
			// stamped here, not by the caller (the stale age bound needs the write's own clock)
			JSON.stringify({ ...page, storedAt: Date.now() }),
			{ expirationTtl: pageKvTtlSeconds(env) }
		);
		return true;
	} catch {
		return false;
	}
}
