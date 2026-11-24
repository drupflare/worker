import type { SiteEnv } from '../../env';

/**
 * The route the registry covers when no list is given: the performance page's cache
 * flush. A flush rebuilds the container and the router on top of everything a serving interpreter
 * has compiled, and a Thunder site's grows linear memory past the cap.
 */
export const FRESH_FIRST_DEFAULT: readonly string[] = [
	'POST /admin/config/development/performance'
];

/** how a request on the list is treated: not at all, or the object resets itself before it runs */
export type FreshFirstMode = 'off' | 'abort';

/**
 * Reads `FRESH_FIRST_ROUTES`. Unset means abort mode on the built-in route, and so does the word
 * `abort`. A comma list of `METHOD /path` entries (a bare path means POST) replaces that route, and
 * `abort` beside entries leaves them as the list. `0` or an empty value is off.
 *
 * Abort mode resets the object before anything runs and the front worker repeats the request once
 * on the new isolate, under the fresh-attempt allowance. It costs one cold boot and one repeat for
 * each matching request. Dropping the interpreter inside the request was deleted: a fresh boot and
 * the render after such a drop died on the platform.
 */
export function freshFirstConfig(env?: SiteEnv): {
	mode: FreshFirstMode;
	routes: readonly string[];
} {
	const raw = env?.FRESH_FIRST_ROUTES;
	if (raw === undefined) return { mode: 'abort', routes: FRESH_FIRST_DEFAULT };
	const entries = String(raw)
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '');
	if (entries.length === 0 || entries.every((entry) => entry === '0')) {
		return { mode: 'off', routes: [] };
	}
	const routes = entries.filter((entry) => entry !== 'abort');
	return { mode: 'abort', routes: routes.length > 0 ? routes : FRESH_FIRST_DEFAULT };
}

/** the routes the registry holds; empty when it is off */
export function freshFirstRoutes(env?: SiteEnv): readonly string[] {
	return freshFirstConfig(env).routes;
}

/**
 * The forms one request path can take for the match: the query dropped, percent-escapes decoded,
 * repeated and trailing slashes removed, and the same again without a leading language prefix
 * (`/en`, `/pt-br`), since a multilingual site serves one route under each.
 */
export function pathForms(path: string): string[] {
	let pathname = path.split(/[?#]/, 1)[0] ?? '';
	try {
		pathname = decodeURIComponent(pathname);
	} catch {
		// a malformed escape matches as sent
	}
	const clean = pathname.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
	const unprefixed = clean.replace(/^\/[a-z]{2,3}(-[a-z]{2,4})?(?=\/)/i, '');
	return unprefixed === clean ? [clean] : [clean, unprefixed];
}

/** whether a request for `path` with `method` is on the registry's list */
export function freshFirstMatch(env: SiteEnv | undefined, method: string, path: string): boolean {
	const routes = freshFirstRoutes(env);
	if (routes.length === 0) return false;
	const want = method.toUpperCase();
	const forms = pathForms(path);
	return routes.some((entry) => {
		const [first, ...rest] = entry.split(/\s+/);
		const [m, p] = rest.length > 0 ? [first!.toUpperCase(), rest[0]!] : ['POST', first!];
		return m === want && forms.includes(p);
	});
}

/** the header the front worker sets on its one repeat after the object aborted itself */
export const FRESH_FIRST_RETRY_HEADER = 'x-cfw-retried';

/** the value of {@link FRESH_FIRST_RETRY_HEADER} that tells the object not to abort again */
export const FRESH_FIRST_RETRY_VALUE = 'abort';

/** the reason the object aborts with, which the front worker reads off the failed fetch */
export const FRESH_FIRST_ABORT_REASON = 'cfw-fresh-first-abort';

/** whether a failed `stub.fetch()` is the object's own abort */
export function isFreshFirstAbort(e: unknown): boolean {
	return String((e as { message?: unknown } | null)?.message ?? '').includes(
		FRESH_FIRST_ABORT_REASON
	);
}

/**
 * Whether this request makes the object abort itself.
 *
 * Only in `abort` mode, only for a registered route, only with an interpreter resident, and never
 * for the front worker's repeat, which carries {@link FRESH_FIRST_RETRY_HEADER}: that is what
 * keeps the pair from looping. Nothing has run when this answers true, so a repeat is safe.
 */
export function freshFirstAbortDue(
	env: SiteEnv | undefined,
	method: string,
	path: string,
	retryHeader: string | null,
	resident: boolean
): boolean {
	if (!resident || retryHeader === FRESH_FIRST_RETRY_VALUE) return false;
	return freshFirstMatch(env, method, path);
}
