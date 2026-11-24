import type { ServingRow, StoreInput } from '../ops/store-rule';

/** the env var that turns the WordPress page cache off when it is `0`; any other value, or none, is on */
export const PAGE_CACHE_SETTING = 'WORDPRESS_PAGE_CACHE';

/** `Cache-Control` directives that say a response is for one visitor or must not be kept */
const PRIVATE_DIRECTIVE = /(^|,)\s*(no-store|no-cache|private)\s*(,|$)/i;

/**
 * A nonce on the page: a form field `wp_nonce_field()` prints, a nonce in a link's query, or a nonce
 * in a script's localised data. It is tied to a user and a twelve hour window, so the page goes
 * wrong inside a stored copy.
 */
const NONCE =
	/<input\b[^>]*\bname\s*=\s*["']?(?:_wpnonce|_wp_http_referer|[\w-]*_nonce|nonce)\b|[?&;]_wpnonce=|["']?\bnonce["']?\s*:\s*["'][0-9a-f]{6,}/i;

/** whether the body carries a WordPress nonce */
export function carriesNonce(html: string): boolean {
	return NONCE.test(html);
}

/** whether the page cache is on in this environment */
export function pageCacheOn(env: unknown): boolean {
	return (env as Record<string, unknown> | undefined)?.[PAGE_CACHE_SETTING] !== '0';
}

// #region the key
/** campaign and click identifiers: they never change a page, so they are not part of its key */
const TRACKING =
	/^(utm_[a-z0-9_]+|fbclid|gclid|gclsrc|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|yclid|igshid|twclid|ttclid|li_fat_id)$/i;

const SLUG = /^[a-z0-9_-]{1,100}$/;
const NUMBER = /^[0-9]{1,10}$/;
const PAGE = /^[1-9][0-9]{0,3}$/;

/** the query variables WordPress reads to choose a page, each with the one shape it may take */
const QUERY_VARS: Record<string, RegExp> = Object.assign(Object.create(null), {
	p: NUMBER,
	page_id: NUMBER,
	attachment_id: NUMBER,
	cat: NUMBER,
	author: NUMBER,
	m: /^[0-9]{4,14}$/,
	year: /^[0-9]{4}$/,
	monthnum: /^(0?[1-9]|1[0-2])$/,
	day: /^(0?[1-9]|[12][0-9]|3[01])$/,
	paged: PAGE,
	page: PAGE,
	cpage: PAGE,
	tag: SLUG,
	category_name: SLUG,
	name: SLUG,
	pagename: SLUG,
	author_name: SLUG,
	post_type: SLUG,
	feed: /^(rss2?|rdf|atom|feed|comments-rss2|comments-atom)$/
});

type Parsed = { pathname: string; pairs: [string, string][]; badEncoding: boolean };

function parsePath(path: string): Parsed {
	const at = path.indexOf('?');
	const pathname = at === -1 ? path : path.slice(0, at);
	const query = at === -1 ? '' : path.slice(at + 1);
	const pairs: [string, string][] = [];
	let badEncoding = false;
	for (const part of query.split('&')) {
		if (part === '') continue;
		const eq = part.indexOf('=');
		const raw: [string, string] =
			eq === -1 ? [part, ''] : [part.slice(0, eq), part.slice(eq + 1)];
		try {
			pairs.push([
				decodeURIComponent(raw[0].replace(/\+/g, ' ')),
				decodeURIComponent(raw[1].replace(/\+/g, ' '))
			]);
		} catch {
			badEncoding = true;
		}
	}
	return { pathname, pairs, badEncoding };
}

const lowerEscapes = (s: string): string => s.replace(/%[0-9a-f]{2}/gi, (m) => m.toLowerCase());

/** one named check on a parsed path; the name is what a control removes */
type PathRule = { name: string; check(path: string, p: Parsed): string | undefined };

const first = (name: string, ok: boolean, detail = ''): string | undefined =>
	ok ? undefined : detail === '' ? name : `${name}:${detail}`;

/** the path rules in the order they apply; the first that refuses names the reason */
const PATH_RULES: readonly PathRule[] = [
	{
		name: 'path-shape',
		check: (_, p) =>
			first(
				'path-shape',
				p.pathname.startsWith('/') &&
					!/\/\/|\\|\/\.{1,2}(\/|$)/.test(p.pathname) &&
					!/[\u0000- \u007f]/.test(p.pathname)
			)
	},
	{
		name: 'path-encoding',
		check: (_, p) => first('path-encoding', !/%(2f|5c|00|25|2e)/i.test(p.pathname))
	},
	{
		name: 'path-case',
		check: (_, p) => first('path-case', !/[A-Z]/.test(lowerEscapes(p.pathname)))
	},
	{
		name: 'path-chars',
		check: (_, p) =>
			first('path-chars', /^[a-z0-9\-._~!$&'()*+,;=:@%/]*$/.test(lowerEscapes(p.pathname)))
	},
	{ name: 'path-length', check: (path) => first('path-length', path.length <= 200) },
	{
		name: 'wp-internal',
		check: (_, p) => first('wp-internal', !/^\/wp-/.test(p.pathname))
	},
	{
		name: 'file-extension',
		check: (_, p) =>
			first('file-extension', !p.pathname.split('/').some((s) => s.includes('.')))
	},
	{
		name: 'search-path',
		check: (_, p) => first('search-path', !/^\/search(\/|$)/.test(p.pathname))
	},
	{ name: 'query-encoding', check: (_, p) => first('query-encoding', !p.badEncoding) },
	{
		name: 'query-param',
		check: (_, p) => {
			for (const [name] of p.pairs) {
				if (TRACKING.test(name)) continue;
				if (!(name in QUERY_VARS)) return `query-param:${name.slice(0, 24)}`;
			}
			return undefined;
		}
	},
	{
		name: 'query-value',
		check: (_, p) => {
			for (const [name, value] of p.pairs) {
				const shape = QUERY_VARS[name];
				if (shape !== undefined && !shape.test(value)) {
					return `query-value:${name.slice(0, 24)}`;
				}
			}
			return undefined;
		}
	},
	{
		name: 'query-duplicate',
		check: (_, p) => {
			const seen = new Set<string>();
			for (const [name] of p.pairs) {
				if (TRACKING.test(name)) continue;
				if (seen.has(name)) return `query-duplicate:${name.slice(0, 24)}`;
				seen.add(name);
			}
			return undefined;
		}
	}
];

/** names of the path rules, so a test can walk every one */
export const PATH_RULE_NAMES: readonly string[] = [...PATH_RULES.map((r) => r.name), 'key-form'];

const NO_SKIP: ReadonlySet<string> = new Set();

/**
 * Classifies a visitor's path: the key it is stored under and rendered as, and the reason it may
 * not be stored, if any.
 *
 * A path no rule refuses is rebuilt: percent escapes in lowercase, tracking parameters dropped, the
 * rest sorted. A refused path keeps the form it arrived in, so what PHP renders is what was asked.
 *
 * @param skip names of rules to leave out; an `@internal` seam for tests, never passed by a caller
 */
export function classifyPath(
	path: string,
	skip: ReadonlySet<string> = NO_SKIP
): { key: string; refusal?: string } {
	const parsed = parsePath(path);
	for (const rule of PATH_RULES) {
		if (skip.has(rule.name)) continue;
		const reason = rule.check(path, parsed);
		if (reason !== undefined) return { key: path, refusal: reason };
	}
	const pairs = parsed.pairs
		.filter(([name]) => !TRACKING.test(name))
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const query = pairs.map(([n, v]) => `${n}=${v}`).join('&');
	const key = lowerEscapes(parsed.pathname) + (query === '' ? '' : `?${query}`);
	// only the canonical form is stored, so a caller that skipped the front worker cannot mint a row
	// per spelling
	if (key !== path && !skip.has('key-form')) return { key, refusal: 'key-form' };
	return { key };
}
// #endregion

// #region the response
/** request headers that can shape a body or the method WordPress sees, so a render under one is not stored */
const BODY_SHAPING_HEADERS = [
	'x-forwarded-server',
	'x-forwarded-port',
	'forwarded',
	'x-original-url',
	'x-rewrite-url',
	'x-host',
	'x-http-host-override',
	'x-http-method-override',
	'x-wp-nonce'
];

const FEED_PATH = /(^|\/)feed(\/(rss2?|rdf|atom))?\/?$/;
const FEED_TYPE = /^(application|text)\/(rss\+xml|atom\+xml|rdf\+xml|xml)\b/i;
const FEED_END = /<\/(rss|feed|rdf:RDF)>\s*$/;
const HTML_END = /<\/html>\s*(<!--[\s\S]*?-->\s*)*$/i;
const BODY_CLASS =
	/<body\b[^>]*\bclass\s*=\s*["'][^"']*\b(search|search-results|search-no-results|error404)\b/i;

function isFeed(path: string): boolean {
	const p = parsePath(path);
	return FEED_PATH.test(p.pathname) || p.pairs.some(([n]) => n === 'feed');
}

type Rule = {
	name: string;
	refuse(i: StoreInput, env: unknown, skip: ReadonlySet<string>): string | undefined;
};

/** the rules in the order they apply; the first that refuses names the reason */
const RULES: readonly Rule[] = [
	{
		name: 'page-cache-off',
		refuse: (_, env) => (pageCacheOn(env) ? undefined : 'page-cache-off')
	},
	{
		name: 'method',
		refuse: (i) => (i.method.toUpperCase() === 'GET' ? undefined : 'method')
	},
	{
		name: 'path',
		refuse: (i, _, skip) =>
			i.path === undefined ? 'path-unknown' : classifyPath(i.path, skip).refusal
	},
	{ name: 'status', refuse: (i) => (i.status === 200 ? undefined : 'status') },
	{ name: 'cookie', refuse: (i) => (i.hasCookie ? 'cookie' : undefined) },
	{ name: 'authorization', refuse: (i) => (i.hasAuthorization ? 'authorization' : undefined) },
	{
		name: 'header-override',
		refuse: (i) => {
			const hit = (i.headerNames ?? []).find((n) =>
				BODY_SHAPING_HEADERS.includes(n.toLowerCase())
			);
			return hit === undefined ? undefined : `header-override:${hit.toLowerCase()}`;
		}
	},
	{ name: 'set-cookie', refuse: (i) => (i.setsCookie ? 'set-cookie' : undefined) },
	{
		name: 'cache-control',
		refuse: (i) => (PRIVATE_DIRECTIVE.test(i.cacheControl ?? '') ? 'cache-control' : undefined)
	},
	{
		name: 'vary-cookie',
		refuse: (i) => (/(^|,)\s*cookie\s*(,|$)/i.test(i.vary ?? '') ? 'vary-cookie' : undefined)
	},
	{
		name: 'untaggable',
		refuse: (i) => (/x-cfw-untaggable/i.test(i.vary ?? '') ? 'untaggable' : undefined)
	},
	{
		name: 'vary',
		refuse: (i) =>
			(i.vary ?? '')
				.split(',')
				.map((n) => n.trim().toLowerCase())
				.some((n) => n !== '' && n !== 'accept-encoding')
				? 'vary'
				: undefined
	},
	{
		name: 'content-type',
		refuse: (i) => {
			if (i.contentType === undefined || i.contentType === null || i.path === undefined) {
				return undefined;
			}
			return (isFeed(i.path) ? FEED_TYPE : /^text\/html\b/i).test(i.contentType)
				? undefined
				: 'content-type';
		}
	},
	{
		name: 'empty-body',
		refuse: (i) => (i.html !== undefined && i.html.trim() === '' ? 'empty-body' : undefined)
	},
	{
		name: 'incomplete',
		refuse: (i) => {
			if (i.html === undefined || i.path === undefined) return undefined;
			if (isFeed(i.path)) {
				const body = i.html.trim();
				return body.startsWith('<?xml') && FEED_END.test(body) ? undefined : 'incomplete';
			}
			return HTML_END.test(i.html) ? undefined : 'incomplete';
		}
	},
	{
		name: 'nonce',
		refuse: (i) => (i.html !== undefined && carriesNonce(i.html) ? 'nonce' : undefined)
	},
	{
		name: 'search-body',
		refuse: (i) => (i.html !== undefined && BODY_CLASS.test(i.html) ? 'search-body' : undefined)
	}
];

/** names of every rule, response and path, so a test can walk them and remove one at a time */
export const RULE_NAMES: readonly string[] = [
	...RULES.filter((r) => r.name !== 'path').map((r) => r.name),
	...PATH_RULE_NAMES
];

/**
 * The reason a response may not enter the page cache, or undefined when it may.
 *
 * @param skip names of rules to leave out; an `@internal` seam for tests, never passed by a caller
 */
export function judge(
	input: StoreInput,
	env: unknown,
	skip: ReadonlySet<string> = NO_SKIP
): string | undefined {
	for (const rule of RULES) {
		if (skip.has(rule.name)) continue;
		const reason = rule.refuse(input, env, skip);
		if (reason !== undefined) return reason;
	}
	return undefined;
}

/**
 * The reason a WordPress response may not enter an anonymous store, or undefined when it may.
 *
 * Nothing is stored when `WORDPRESS_PAGE_CACHE` is `0`. With it on, only an anonymous, cookie-free
 * GET of a path the key rules accept, answering 200 with a complete body of the right type, no
 * Set-Cookie, no private directive, no `Vary` that matters and no nonce is stored.
 */
export function wordpressRefusal(input: StoreInput, env: unknown): string | undefined {
	return judge(input, env);
}
// #endregion

/** WordPress's row of the serving table */
export const WORDPRESS_SERVING: ServingRow = {
	compiledPlans: false,
	needsTags: true,
	readable: (env) => pageCacheOn(env),
	refuse: wordpressRefusal,
	pathRefusal: (path) => classifyPath(path).refusal,
	key: (path) => classifyPath(path).key,
	// a trashed or unpublished page renders a 404 that is never stored, so nothing replaces its old copy
	staleGenerations: false
};
