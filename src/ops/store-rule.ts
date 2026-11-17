import type { Cms } from '../util/cms';
import { WORDPRESS_SERVING } from '../wordpress/store-rule';

/** what a response is judged on before an anonymous store keeps or replays it */
export type StoreInput = {
	method: string;
	status: number;
	/** the request carries a cookie of any kind */
	hasCookie: boolean;
	/** the request carries an `Authorization` header */
	hasAuthorization: boolean;
	/** the response sets a cookie */
	setsCookie: boolean;
	/** the response's `Cache-Control`, if any */
	cacheControl: string | null;
	/** the body, when the caller holds it as text; a caller without it cannot scan the page */
	html?: string;
	/** the visitor's path and query as the store keys it; a CMS that judges the key reads it */
	path?: string;
	/** the response's `Content-Type`, when the caller holds it */
	contentType?: string | null;
	/** the response's `Vary`, when the caller holds it */
	vary?: string | null;
	/** the lowercase names of the request headers that reach the CMS */
	headerNames?: string[];
};

/** how one CMS answers the questions the shared stores ask */
export type ServingRow = {
	/** whether the front worker may compile a plan out of an authenticated render */
	compiledPlans: boolean;
	/** whether a render with no cache tag is refused, because a scoped purge could never reach it */
	needsTags: boolean;
	/** whether a stored row may be replayed at all in this environment */
	readable(env: unknown): boolean;
	/** why this response may not be stored beyond the generic checks, or undefined when it may */
	refuse(input: StoreInput, env: unknown): string | undefined;
	/** why a visitor's path may never be stored or replayed, or undefined; absent means any path */
	pathRefusal?(path: string): string | undefined;
	/** the path a stored page is keyed and rendered under; absent means the path as sent */
	key?(path: string): string;
};

/**
 * One row per CMS. Drupal's own checks stay where they are (`fillOne()` and the front worker), so
 * its row adds nothing; a name the table lacks stores and replays nothing.
 */
const SERVING_BY_CMS: Record<Cms, ServingRow> = {
	drupal: { compiledPlans: true, needsTags: true, readable: () => true, refuse: () => undefined },
	wordpress: WORDPRESS_SERVING,
	joomla: {
		compiledPlans: false,
		needsTags: true,
		readable: () => false,
		refuse: () => 'joomla-store-off'
	}
};

const NOTHING: ServingRow = {
	compiledPlans: false,
	needsTags: true,
	readable: () => false,
	refuse: () => 'unknown-cms'
};

/** the serving row for a CMS; an unknown name is the row that stores and replays nothing */
export function servingFor(cms: string): ServingRow {
	return SERVING_BY_CMS[cms as Cms] ?? NOTHING;
}

/** whether a CMS may read a stored copy of this path at all in this environment */
export function storesPath(cms: string, env: unknown, path: string): boolean {
	const row = servingFor(cms);
	return row.readable(env) && row.pathRefusal?.(path) === undefined;
}

/** the key a CMS stores a visitor's path under; Drupal's is the path as sent */
export function storeKeyFor(cms: string, path: string): string {
	return servingFor(cms).key?.(path) ?? path;
}
