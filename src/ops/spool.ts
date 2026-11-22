/**
 * Spool, the client-side replica: the paths it owns, the budget on them, and the version vector the
 * object keeps for it.
 *
 * The vector is a map from tag to the cursor of its last change, held in memory: it writes no row,
 * so a save costs the meter nothing for it. A restart loses it, and the answer to a device that
 * asks after one is to reset, which costs the device its copies and never shows it a stale page. A
 * cursor is `generation * 4096 + n`, where `n` counts the changes inside one generation, so every
 * change after a page was decorated has a higher cursor than that page carries.
 * @module
 */

import { servingFor } from './store-rule';

/** the service worker script spool registers, served from the origin's root */
export const SPOOL_SW_PATH = '/spool-sw.js';

/** the prefix spool reserves for its own endpoints and the same-origin client script */
export const SPOOL_PREFIX = '/.spool/';

/** true for a path spool owns */
export const isSpoolPath = (pathname: string): boolean =>
	pathname === SPOOL_SW_PATH || pathname.startsWith(SPOOL_PREFIX);

/** the object-internal route the front worker asks for the vector */
export const SPOOL_OBJECT_PATH = '/__spool';

// #region the per-site path exclusion
/** the path prefixes the `SPOOL_EXCLUDE` lever names, trimmed and without a trailing slash */
export function spoolExcludedPrefixes(env: unknown): string[] {
	const value = (env as { SPOOL_EXCLUDE?: unknown } | undefined)?.SPOOL_EXCLUDE;
	return String(value ?? '')
		.split(',')
		.map((prefix) => prefix.trim().replace(/\/+$/, ''))
		.filter((prefix) => prefix !== '');
}

/** the listed prefix a path is equal to or under, or undefined; spool's own paths are never listed */
export function spoolExcludedBy(env: unknown, pathname: string): string | undefined {
	return spoolExcludedPrefixes(env).find(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
	);
}

/**
 * Why `SPOOL_EXCLUDE` may not hold this value, or undefined. Each entry is an absolute path prefix.
 * The root and spool's own paths are refused: the first is `SPOOL=0` with the worker script still
 * answering, and the second would break the replica for every page.
 */
export function spoolExcludeRefusal(text: string): string | undefined {
	for (const raw of text.split(',')) {
		const entry = raw.trim();
		if (entry === '') continue;
		if (!/^\/[A-Za-z0-9\-._~!$&'()*+;=:@%/]*$/.test(entry)) {
			return `SPOOL_EXCLUDE entries must be absolute path prefixes without a query; got ${entry}`;
		}
		const bare = entry.replace(/\/+$/, '');
		if (bare === '') return 'SPOOL_EXCLUDE cannot name the root; use SPOOL=0 to turn spool off';
		if (isSpoolPath(bare) || isSpoolPath(`${bare}/`) || bare === '/.spool') {
			return `SPOOL_EXCLUDE cannot name a path spool owns; got ${entry}`;
		}
	}
	return undefined;
}
// #endregion

// #region what each CMS keeps out
/** what one CMS keeps out of spool beyond the paths every site shares */
export type SpoolCmsRules = {
	/** a path equal to one of these, or under one, is never replicated */
	readonly prefixes: readonly string[];
	/** a path matching one of these is never replicated, wherever it sits */
	readonly patterns: readonly RegExp[];
};

/**
 * One row per CMS, and the only place a CMS extends the rule. An unknown CMS has no row, so
 * `spoolRefusesPath` answers for it by refusing every path.
 */
export const SPOOL_CMS_RULES: Readonly<Record<string, SpoolCmsRules>> = {
	drupal: { prefixes: [], patterns: [] },
	wordpress: {
		prefixes: [
			'/wp-admin',
			'/wp-login.php',
			'/wp-json',
			'/wp-cron.php',
			'/xmlrpc.php',
			'/wp-comments-post.php',
			'/wp-trackback.php',
			'/wp-signup.php',
			'/wp-activate.php',
			'/wp-includes'
		],
		patterns: [/(^|\/)feed(\/|$)/, /(^|\/)admin-ajax\.php$/]
	},
	joomla: { prefixes: ['/administrator', '/api'], patterns: [] }
};

const underPrefix = (pathname: string, prefix: string): boolean =>
	pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}?`);

/** the page-like path: its last segment has no extension, so it is a page and not a file */
const pageLike = (pathname: string): boolean => !(pathname.split('/').pop() ?? '').includes('.');

/**
 * Whether the object's page store holds this CMS's pages, which is what a purge can name. A device
 * is told a page changed by the path the store keeps for it, so a CMS whose store is off has
 * nothing a purge could announce and replicates no page.
 */
export const spoolStoreHolds = (cms: string, env: unknown): boolean =>
	servingFor(cms).readable(env);

/**
 * Why a request's path may not be replicated, or undefined when it may. A CMS row names what it
 * keeps out. A page is also refused when the CMS's store is off, and when the store's own key rule
 * refuses it, so a page the store would never hold is never held by a device either. A path with
 * an extension is a file, which only the media features touch, and none of those need the store.
 */
export function spoolRefusesPath(
	cms: string,
	env: unknown,
	pathname: string,
	search: string
): string | undefined {
	const rules = SPOOL_CMS_RULES[cms];
	if (rules === undefined) return 'unknown-cms';
	const excluded = spoolExcludedBy(env, pathname);
	if (excluded !== undefined) return `site-path:${excluded}`;
	for (const prefix of rules.prefixes) {
		if (underPrefix(pathname, prefix)) return `cms-path:${prefix}`;
	}
	if (rules.patterns.some((pattern) => pattern.test(pathname))) return 'cms-path:pattern';
	if (/(^|[?&])feed=/.test(search)) return 'cms-path:feed';
	if (!pageLike(pathname)) return undefined;
	if (!spoolStoreHolds(cms, env)) return 'store-off';
	return servingFor(cms).pathRefusal?.(`${pathname}${search}`);
}

/** the environment the WordPress store rule is asked under, so its content rules judge and its on switch does not */
const STORE_ON = { WORDPRESS_PAGE_CACHE: '1' } as const;

/** a body marker of a page that differs per visitor: WordPress's password form */
const PASSWORD_FORM = /\bpost-password-form\b/;

/** what a response says about itself, for the rule below */
export type SpoolResponseView = {
	status: number;
	setsCookie: boolean;
	cacheControl: string | null;
	contentType: string | null;
	vary: string | null;
	/** the page as text */
	html: string;
	/** the path and query the visitor asked for */
	path: string;
};

/**
 * Why a response may not be replicated, or undefined when it may. WordPress is judged by its own
 * store rule as if the page cache were on (a nonce, a search page, an unfinished body and the rest),
 * plus the password form, which the store rule has no reason to name. Drupal's checks are the
 * library's own.
 */
export function spoolRefusesResponse(cms: string, view: SpoolResponseView): string | undefined {
	if (cms !== 'wordpress') return undefined;
	if (PASSWORD_FORM.test(view.html)) return 'password-protected';
	return servingFor(cms).refuse(
		{
			method: 'GET',
			status: view.status,
			hasCookie: false,
			hasAuthorization: false,
			setsCookie: view.setsCookie,
			cacheControl: view.cacheControl,
			html: view.html,
			path: view.path,
			contentType: view.contentType,
			vary: view.vary
		},
		STORE_ON
	);
}
// #endregion

/** the tag spool derives for a page with no tag header; must equal `pathTag` in `@drupflare/spool/proxy` */
export const pathTagFor = (path: string): string => `proxy:path:${path}`;

/** changes one generation may record before the vector gives up and reports a wholesale change */
export const SPOOL_SLOTS = 4096;

/**
 * The cursor a page rendered at `generation` carries. Every change recorded at that generation has
 * a higher one, so a device holding this page is told about changes made after it was rendered, and
 * a vector that started at that generation counts it as its own floor.
 */
export const spoolCursorFloor = (generation: number): number => generation * SPOOL_SLOTS + 1;

/** requests to spool's paths one address may make per window */
export const SPOOL_IP_LIMIT = 120;

/** requests to spool's paths one isolate accepts per window from every address together */
export const SPOOL_GLOBAL_LIMIT = 3_000;

/** the window both limits count over */
export const SPOOL_WINDOW_MS = 60_000;

const perAddress = new Map<string, { count: number; first: number }>();
let overall = { count: 0, first: 0 };

/** drops both budgets; tests use it */
export function resetSpoolBudget(): void {
	perAddress.clear();
	overall = { count: 0, first: 0 };
}

/**
 * Counts one request to a spool path against the address and the isolate, and says whether it may
 * run. In memory and per isolate, because a durable counter would spend a row per request, and
 * bounded because the key is attacker-supplied.
 */
export function spoolAllowed(address: string, nowMs: number): boolean {
	if (nowMs - overall.first >= SPOOL_WINDOW_MS) overall = { count: 0, first: nowMs };
	if (perAddress.size > 4096) perAddress.clear();
	let held = perAddress.get(address);
	if (!held || nowMs - held.first >= SPOOL_WINDOW_MS) {
		held = { count: 0, first: nowMs };
		perAddress.set(address, held);
	}
	held.count += 1;
	overall.count += 1;
	return held.count <= SPOOL_IP_LIMIT && overall.count <= SPOOL_GLOBAL_LIMIT;
}

/** the tags that changed after a cursor, each with the cursor of its last change */
export type SpoolDiff = {
	cursor: number;
	changed: Record<string, number>;
	/** the holder's cursor is ahead of this vector or behind a change it cannot be told about */
	reset: boolean;
};

/** tags a vector holds before it degrades to a wholesale change */
const MAX_TAGS = 2_000;

/**
 * Tag to the cursor of its last change, with a floor under which nothing is known.
 *
 * The floor is where this instance started, or where a wholesale change last landed. A holder whose
 * cursor is below it is told to reset, because the tags that changed in between were either never
 * recorded here or all changed at once. That is the conservative answer: a reset costs a device its
 * copies and never shows it a stale page.
 */
export class SpoolStamps {
	#floor: number;
	#generation: number;
	#count = 0;
	readonly #tags = new Map<string, number>();

	/**
	 * `boot` is the generation when this instance started. Nothing before it is known, so a holder
	 * of an older generation resets. A change recorded earlier at this generation, by an instance
	 * that restarted, is not known either; it falls inside the window between a save's first write
	 * and its flush, when the page cache itself may still hold the old page.
	 */
	constructor(boot: number) {
		this.#generation = boot;
		this.#floor = spoolCursorFloor(boot);
	}

	/** the next cursor inside `generation`; the last slot repeats rather than spill into the next generation */
	#next(generation: number): number {
		if (generation !== this.#generation) {
			this.#generation = generation;
			this.#count = 0;
		}
		this.#count = Math.min(this.#count + 1, SPOOL_SLOTS - 1);
		return spoolCursorFloor(generation) + this.#count;
	}

	/**
	 * Everything changed. With `advance` the change takes a cursor of its own, for a purge that moved
	 * no generation; without it the floor is the generation's own, for a bump that already did.
	 */
	wholesale(generation: number, advance = false): void {
		this.#floor = Math.max(
			this.#floor,
			advance ? this.#next(generation) : spoolCursorFloor(generation)
		);
		this.#tags.clear();
	}

	/** records a change to `tags` inside `generation`; past the cap it degrades to a wholesale change */
	stamp(tags: Iterable<string>, generation: number): void {
		const cursor = this.#next(generation);
		for (const tag of tags) this.#tags.set(tag, cursor);
		if (this.#tags.size > MAX_TAGS) this.wholesale(generation, true);
	}

	/** how many tags are held, for the stats line */
	get size(): number {
		return this.#tags.size;
	}

	/**
	 * The cursor at `generation`: the latest change inside it, or its floor when none was recorded.
	 * Never below the vector's own floor, or a holder told to reset would be told again at its next
	 * sync.
	 */
	cursor(generation: number): number {
		const base =
			generation === this.#generation
				? spoolCursorFloor(generation) + this.#count
				: spoolCursorFloor(generation);
		return Math.max(base, this.#floor);
	}

	/** every tag changed after `from`, as of the object's current generation */
	diff(from: number, generation: number): SpoolDiff {
		const current = this.cursor(generation);
		if (!Number.isSafeInteger(from) || from < 0 || from > current) {
			return { cursor: current, changed: {}, reset: true };
		}
		if (from < this.#floor) return { cursor: current, changed: {}, reset: true };
		const changed: Record<string, number> = {};
		for (const [tag, at] of this.#tags) if (at > from) changed[tag] = at;
		return { cursor: current, changed, reset: false };
	}
}
