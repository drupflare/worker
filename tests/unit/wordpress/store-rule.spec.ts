import { describe, expect, it } from 'vitest';
import { servingFor, storeKeyFor, storesPath, type StoreInput } from '../../../src/ops/store-rule';
import { storeEdge } from '../../../src/site/edge-store';
import { pageRewrite } from '../../../src/site/entry';
import type { FrontContext, FrontEntry } from '../../../src/site/types';
import {
	carriesNonce,
	classifyPath,
	judge,
	PAGE_CACHE_SETTING,
	pageCacheOn,
	PATH_RULE_NAMES,
	RULE_NAMES,
	wordpressRefusal
} from '../../../src/wordpress/store-rule';

const ON = { [PAGE_CACHE_SETTING]: '1' };

const PAGE = '<!DOCTYPE html><html><head><title>x</title></head><body>hello</body></html>\n';
const FEED =
	'<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>x</title></channel></rss>\n';
const HTML = 'text/html; charset=UTF-8';
const RSS = 'application/rss+xml; charset=UTF-8';

const anonymous: StoreInput = {
	method: 'GET',
	status: 200,
	hasCookie: false,
	hasAuthorization: false,
	setsCookie: false,
	cacheControl: null,
	html: PAGE,
	path: '/',
	contentType: HTML,
	vary: null,
	headerNames: []
};

describe('the serving table', () => {
	it('keeps the Drupal row as it was: no extra refusal, tags required, plans on, any path', () => {
		const row = servingFor('drupal');
		expect(row.compiledPlans).toBe(true);
		expect(row.needsTags).toBe(true);
		expect(row.readable({})).toBe(true);
		expect(row.refuse({ ...anonymous, hasCookie: true, setsCookie: true }, {})).toBeUndefined();
		expect(row.pathRefusal).toBeUndefined();
		expect(row.key).toBeUndefined();
		for (const path of ['/?s=x', '/Node/1?utm_source=a', '/wp-login.php', '/a//b']) {
			expect(storesPath('drupal', {}, path), path).toBe(true);
			expect(storeKeyFor('drupal', path), path).toBe(path);
		}
	});

	it('gives WordPress no compiled plans and requires a tagged render', () => {
		const row = servingFor('wordpress');
		expect(row.compiledPlans).toBe(false);
		expect(row.needsTags).toBe(true);
	});

	it('stores and replays nothing for a CMS the table lacks, and for Joomla', () => {
		for (const cms of ['plone', 'joomla']) {
			const row = servingFor(cms);
			expect(row.readable(ON), cms).toBe(false);
			expect(row.refuse(anonymous, ON), cms).toBeDefined();
			expect(row.compiledPlans, cms).toBe(false);
		}
	});
});

describe('the WordPress page cache setting', () => {
	it('is off unless the value is exactly 1', () => {
		for (const env of [
			{},
			undefined,
			{ [PAGE_CACHE_SETTING]: '0' },
			{ [PAGE_CACHE_SETTING]: 'true' }
		]) {
			expect(pageCacheOn(env), JSON.stringify(env)).toBe(false);
			expect(wordpressRefusal(anonymous, env), JSON.stringify(env)).toBe('page-cache-off');
			expect(servingFor('wordpress').readable(env)).toBe(false);
			expect(storesPath('wordpress', env, '/')).toBe(false);
		}
		expect(pageCacheOn(ON)).toBe(true);
	});

	it('does not reach the Drupal row', () => {
		expect(servingFor('drupal').readable({ [PAGE_CACHE_SETTING]: '0' })).toBe(true);
		expect(servingFor('drupal').readable({})).toBe(true);
	});
});

describe('what the WordPress rule stores', () => {
	const storable: [string, Partial<StoreInput>][] = [
		['the front page', { path: '/' }],
		['a post', { path: '/2026/01/01/hello-world/' }],
		['a page', { path: '/sample-page/' }],
		['a category archive', { path: '/category/uncategorized/' }],
		['a tag archive', { path: '/tag/news/' }],
		['a paged archive', { path: '/category/uncategorized/page/2/' }],
		['a paged front page', { path: '/page/2/' }],
		['an author archive', { path: '/author/owner/' }],
		['a date archive', { path: '/2026/01/' }],
		['a page by id, keeping the id', { path: '/?page_id=2' }],
		[
			'a request behind a proxy that sets X-Forwarded-Host, which the pinned origin makes harmless',
			{ headerNames: ['x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto'] }
		],
		['a post on page two of its comments', { path: '/hello-world/?cpage=2' }],
		['a percent-encoded slug', { path: '/caf%c3%a9/' }],
		['the feed', { path: '/feed/', contentType: RSS, html: FEED }],
		[
			'a comments feed',
			{ path: '/comments/feed/', contentType: 'application/rss+xml', html: FEED }
		],
		[
			'an atom feed',
			{
				path: '/feed/atom/',
				contentType: 'application/atom+xml; charset=UTF-8',
				html: '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'
			}
		],
		['a feed named in the query', { path: '/?feed=rss2', contentType: RSS, html: FEED }],
		[
			'a response with the headers a theme sets',
			{ cacheControl: 'public, max-age=0, must-revalidate', vary: 'Accept-Encoding' }
		]
	];
	for (const [name, change] of storable) {
		it(`stores ${name} once the setting is on`, () => {
			expect(wordpressRefusal({ ...anonymous, ...change }, ON)).toBeUndefined();
		});
	}
});

type Case = { name: string; change: Partial<StoreInput>; reason: string; rules: string[] };

const cases: Case[] = [
	{ name: 'a POST', change: { method: 'POST' }, reason: 'method', rules: ['method'] },
	{ name: 'a HEAD', change: { method: 'HEAD' }, reason: 'method', rules: ['method'] },
	{ name: 'a 404', change: { status: 404 }, reason: 'status', rules: ['status'] },
	{ name: 'a 301', change: { status: 301 }, reason: 'status', rules: ['status'] },
	{ name: 'a login cookie', change: { hasCookie: true }, reason: 'cookie', rules: ['cookie'] },
	{
		name: 'an Authorization header',
		change: { hasAuthorization: true },
		reason: 'authorization',
		rules: ['authorization']
	},
	{
		name: 'X-Forwarded-Server',
		change: { headerNames: ['x-forwarded-server'] },
		reason: 'header-override',
		rules: ['header-override']
	},
	{
		name: 'X-HTTP-Method-Override',
		change: { headerNames: ['X-HTTP-Method-Override'] },
		reason: 'header-override',
		rules: ['header-override']
	},
	{
		name: 'a response that sets a cookie',
		change: { setsCookie: true },
		reason: 'set-cookie',
		rules: ['set-cookie']
	},
	{
		name: 'Cache-Control: private',
		change: { cacheControl: 'private' },
		reason: 'cache-control',
		rules: ['cache-control']
	},
	{
		name: 'Cache-Control: no-store',
		change: { cacheControl: 'no-store' },
		reason: 'cache-control',
		rules: ['cache-control']
	},
	{
		name: 'Cache-Control: no-cache',
		change: { cacheControl: 'no-cache' },
		reason: 'cache-control',
		rules: ['cache-control']
	},
	{
		name: 'the headers nocache_headers() sends',
		change: { cacheControl: 'no-cache, must-revalidate, max-age=0, no-store' },
		reason: 'cache-control',
		rules: ['cache-control']
	},
	{
		name: 'a private directive after max-age',
		change: { cacheControl: 'max-age=0, private' },
		reason: 'cache-control',
		rules: ['cache-control']
	},
	{
		name: 'Vary: Cookie',
		change: { vary: 'Cookie' },
		reason: 'vary-cookie',
		rules: ['vary-cookie', 'vary']
	},
	{
		name: 'Vary: Accept-Encoding, Cookie',
		change: { vary: 'Accept-Encoding, Cookie' },
		reason: 'vary-cookie',
		rules: ['vary-cookie', 'vary']
	},
	{
		name: 'the untaggable marker',
		change: { vary: 'X-Cfw-Untaggable' },
		reason: 'untaggable',
		rules: ['untaggable', 'vary']
	},
	{ name: 'Vary: User-Agent', change: { vary: 'User-Agent' }, reason: 'vary', rules: ['vary'] },
	{
		name: 'JSON where HTML belongs',
		change: { contentType: 'application/json' },
		reason: 'content-type',
		rules: ['content-type']
	},
	{
		name: 'HTML where a feed belongs',
		change: { path: '/feed/', contentType: HTML, html: FEED },
		reason: 'content-type',
		rules: ['content-type']
	},
	{
		name: 'an empty body',
		change: { html: '' },
		reason: 'empty-body',
		rules: ['empty-body', 'incomplete']
	},
	{
		name: 'a whitespace body',
		change: { html: ' \n\t' },
		reason: 'empty-body',
		rules: ['empty-body', 'incomplete']
	},
	{
		name: 'an empty feed, which is what the output buffer bug sent',
		change: { path: '/feed/', contentType: RSS, html: '' },
		reason: 'empty-body',
		rules: ['empty-body', 'incomplete']
	},
	{
		name: 'a page cut off before the closing tag',
		change: { html: '<!DOCTYPE html><html><body><p>half' },
		reason: 'incomplete',
		rules: ['incomplete']
	},
	{
		name: 'a feed cut off before the closing tag',
		change: { path: '/feed/', contentType: RSS, html: '<?xml version="1.0"?><rss><channel>' },
		reason: 'incomplete',
		rules: ['incomplete']
	},
	{
		name: 'a feed that is not XML',
		change: { path: '/feed/', contentType: RSS, html: '<html></html>' },
		reason: 'incomplete',
		rules: ['incomplete']
	},
	{
		name: 'a nonce field',
		change: {
			html: '<html><form><input type="hidden" name="_wpnonce" value="1a2b3c4d5e"></form></html>'
		},
		reason: 'nonce',
		rules: ['nonce']
	},
	{
		name: 'a search results page under a renamed search base',
		change: {
			html: '<!DOCTYPE html><html><body class="search search-results wp-theme-x">r</body></html>'
		},
		reason: 'search-body',
		rules: ['search-body']
	},
	{
		name: 'a not found page served with a 200',
		change: { html: '<!DOCTYPE html><html><body class="error404 wp-theme-x">n</body></html>' },
		reason: 'search-body',
		rules: ['search-body']
	},
	{
		name: 'wp-admin',
		change: { path: '/wp-admin/' },
		reason: 'wp-internal',
		rules: ['wp-internal']
	},
	{
		name: 'wp-login.php',
		change: { path: '/wp-login.php' },
		reason: 'wp-internal',
		rules: ['wp-internal', 'file-extension']
	},
	{
		name: 'wp-cron.php',
		change: { path: '/wp-cron.php?doing_wp_cron=1' },
		reason: 'wp-internal',
		rules: ['wp-internal', 'file-extension', 'query-param']
	},
	{
		name: 'xmlrpc.php',
		change: { path: '/xmlrpc.php' },
		reason: 'file-extension',
		rules: ['file-extension']
	},
	{
		name: 'wp-comments-post.php',
		change: { path: '/wp-comments-post.php' },
		reason: 'wp-internal',
		rules: ['wp-internal', 'file-extension']
	},
	{
		name: 'the REST index',
		change: { path: '/wp-json/' },
		reason: 'wp-internal',
		rules: ['wp-internal']
	},
	{
		name: 'a REST collection',
		change: { path: '/wp-json/wp/v2/posts' },
		reason: 'wp-internal',
		rules: ['wp-internal']
	},
	{
		name: 'REST through the query',
		change: { path: '/?rest_route=%2Fwp%2Fv2%2Fposts' },
		reason: 'query-param',
		rules: ['query-param', 'key-form']
	},
	{
		name: 'a search',
		change: { path: '/?s=hello' },
		reason: 'query-param',
		rules: ['query-param']
	},
	{
		name: 'a pretty search',
		change: { path: '/search/hello/' },
		reason: 'search-path',
		rules: ['search-path']
	},
	{
		name: 'a preview',
		change: { path: '/?p=1&preview=true' },
		reason: 'query-param',
		rules: ['query-param']
	},
	{
		name: 'a reply link',
		change: { path: '/hello-world/?replytocom=3' },
		reason: 'query-param',
		rules: ['query-param']
	},
	{
		name: 'the held-comment notice',
		change: { path: '/hello-world/?unapproved=3&moderation-hash=abc' },
		reason: 'query-param',
		rules: ['query-param', 'key-form']
	},
	{
		name: 'a variable nobody uses, which would mint a row per value',
		change: { path: '/hello-world/?x=1' },
		reason: 'query-param',
		rules: ['query-param']
	},
	{
		name: 'an array variable',
		change: { path: '/?cat[]=1' },
		reason: 'query-param',
		rules: ['query-param']
	},
	{
		name: 'a tracking parameter that the front worker would have dropped',
		change: { path: '/hello-world/?utm_source=a&fbclid=b' },
		reason: 'key-form',
		rules: ['key-form']
	},
	{
		name: 'variables in an order the front worker would have sorted',
		change: { path: '/?paged=2&cat=1' },
		reason: 'key-form',
		rules: ['key-form']
	},
	{
		name: 'capital letters in a percent escape',
		change: { path: '/caf%C3%A9/' },
		reason: 'key-form',
		rules: ['key-form']
	},
	{
		name: 'a variable named like an object property',
		change: { path: '/?constructor=1&__proto__=2' },
		reason: 'query-param',
		rules: ['query-param', 'key-form']
	},
	{
		name: 'a value that is not a number',
		change: { path: '/?p=abc' },
		reason: 'query-value',
		rules: ['query-value']
	},
	{
		name: 'a page number of zero',
		change: { path: '/?paged=0' },
		reason: 'query-value',
		rules: ['query-value']
	},
	{
		name: 'a variable given twice',
		change: { path: '/?p=1&p=2' },
		reason: 'query-duplicate',
		rules: ['query-duplicate']
	},
	{
		name: 'a query that does not decode',
		change: { path: '/?p=1%' },
		reason: 'query-encoding',
		rules: ['query-encoding', 'key-form']
	},
	{
		name: 'a capital in the path',
		change: { path: '/Hello-World/' },
		reason: 'path-case',
		rules: ['path-case', 'path-chars']
	},
	{
		name: 'a doubled slash',
		change: { path: '/hello-world//' },
		reason: 'path-shape',
		rules: ['path-shape']
	},
	{
		name: 'a dot segment',
		change: { path: '/a/../b/' },
		reason: 'path-shape',
		rules: ['path-shape', 'file-extension']
	},
	{
		name: 'an encoded slash',
		change: { path: '/hello%2fworld/' },
		reason: 'path-encoding',
		rules: ['path-encoding']
	},
	{
		name: 'a double-encoded dot',
		change: { path: '/%252e/' },
		reason: 'path-encoding',
		rules: ['path-encoding']
	},
	{
		name: 'a character a slug cannot hold',
		change: { path: '/hello world/' },
		reason: 'path-shape',
		rules: ['path-shape', 'path-chars']
	},
	{
		name: 'a path past 200 characters',
		change: { path: `/${'a'.repeat(250)}/` },
		reason: 'path-length',
		rules: ['path-length']
	},
	{
		name: 'robots.txt',
		change: { path: '/robots.txt' },
		reason: 'file-extension',
		rules: ['file-extension']
	},
	{
		name: 'a sitemap',
		change: { path: '/wp-sitemap.xml' },
		reason: 'wp-internal',
		rules: ['wp-internal', 'file-extension']
	},
	{
		name: 'no path at all, which a caller must supply',
		change: { path: undefined },
		reason: 'path-unknown',
		rules: ['path']
	}
];

describe('the WordPress rule, case by case, each with the rule removed', () => {
	for (const c of cases) {
		it(`refuses ${c.name} as ${c.reason}`, () => {
			const input: StoreInput = { ...anonymous, ...c.change };
			const reason = judge(input, ON);
			expect(reason?.split(':')[0], JSON.stringify(c.change)).toBe(c.reason);
			// the control: with the named rules out, nothing else stops it
			expect(
				judge(input, ON, new Set(c.rules)),
				`without ${c.rules.join(', ')}`
			).toBeUndefined();
		});
	}

	it('has a case for every rule', () => {
		const covered = new Set(cases.flatMap((c) => c.rules.concat(c.reason)));
		covered.add('page-cache-off');
		expect(RULE_NAMES.filter((r) => !covered.has(r))).toEqual([]);
	});

	it('ships the whole rule set: an emptied or shortened table fails here', () => {
		expect(PATH_RULE_NAMES.length).toBeGreaterThanOrEqual(13);
		expect(RULE_NAMES.length).toBeGreaterThanOrEqual(29);
		for (const path of ['/?s=x', '/wp-admin/', '/wp-login.php', '/wp-json/']) {
			expect(classifyPath(path).refusal, path).toBeDefined();
		}
	});

	it('names each path rule once and keeps them in the rule list', () => {
		expect(new Set(PATH_RULE_NAMES).size).toBe(PATH_RULE_NAMES.length);
		for (const name of PATH_RULE_NAMES) expect(RULE_NAMES).toContain(name);
	});

	it('refuses with the setting off before it reads anything else', () => {
		expect(judge({ ...anonymous, method: 'POST' }, {})).toBe('page-cache-off');
		expect(judge(anonymous, {}, new Set(['page-cache-off']))).toBeUndefined();
	});
});

describe('the key a page is stored and rendered under', () => {
	const keys: [string, string][] = [
		['/', '/'],
		['/?', '/'],
		['/?utm_source=a&utm_medium=b&utm_campaign=c', '/'],
		['/hello-world/?fbclid=abc', '/hello-world/'],
		['/hello-world/?gclid=abc&utm_term=x&paged=2', '/hello-world/?paged=2'],
		['/?msclkid=1&mc_cid=2&mc_eid=3&_ga=4&_gl=5', '/'],
		['/?paged=2&cat=1', '/?cat=1&paged=2'],
		['/?cat=1&paged=2', '/?cat=1&paged=2'],
		['/category/news/?UTM_SOURCE=a', '/category/news/'],
		['/caf%C3%A9/', '/caf%c3%a9/'],
		['/caf%c3%a9/', '/caf%c3%a9/'],
		['/?feed=rss2', '/?feed=rss2'],
		['/hello-world', '/hello-world'],
		['/hello-world/', '/hello-world/'],
		['/?s=hello&utm_source=a', '/?s=hello&utm_source=a'],
		['/Hello-World/?utm_source=a', '/Hello-World/?utm_source=a'],
		['/wp-login.php?utm_source=a', '/wp-login.php?utm_source=a']
	];
	for (const [asked, key] of keys) {
		it(`keys ${asked} as ${key}`, () => {
			expect(classifyPath(asked).key).toBe(key);
			expect(storeKeyFor('wordpress', asked)).toBe(key);
		});
	}

	it('gives two orders of the same variables, and a tracked and an untracked visit, one key', () => {
		const a = classifyPath('/?cat=1&paged=2&utm_source=x').key;
		const b = classifyPath('/?paged=2&cat=1').key;
		expect(a).toBe(b);
	});

	it('keeps a refused path as it came, so the render sees what was asked', () => {
		for (const asked of ['/?s=a&utm_source=b', '/wp-admin/?utm_source=a', '/a//b/?fbclid=1']) {
			expect(classifyPath(asked).refusal, asked).toBeDefined();
			expect(classifyPath(asked).key, asked).toBe(asked);
		}
	});

	it('is a fixed point: keying a key changes nothing', () => {
		for (const [asked] of keys) {
			const once = classifyPath(asked).key;
			expect(classifyPath(once).key, asked).toBe(once);
		}
	});
});

describe('the page rewrite applies the key', () => {
	const rewrite = (cms: string, method: string, path: string): string | null => {
		const url = new URL(`https://x.test${path}`);
		const f = {
			request: new Request(url, { method }),
			url,
			env: { CMS: cms },
			internal: false,
			resolvedSite: 's',
			pageRequest: false
		} as unknown as FrontEntry;
		pageRewrite(f);
		return f.url.searchParams.get('path');
	};

	it('drops tracking for a WordPress GET and HEAD and leaves a submission as sent', () => {
		expect(rewrite('wordpress', 'GET', '/hello-world/?utm_source=a')).toBe('/hello-world/');
		expect(rewrite('wordpress', 'HEAD', '/?fbclid=1&paged=2&cat=1')).toBe('/?cat=1&paged=2');
		expect(rewrite('wordpress', 'POST', '/hello-world/?utm_source=a')).toBe(
			'/hello-world/?utm_source=a'
		);
	});

	it('leaves Drupal exactly as the visitor sent it', () => {
		for (const path of ['/node/1?utm_source=a', '/?paged=2&cat=1', '/Foo//bar?x=1']) {
			expect(rewrite('drupal', 'GET', path), path).toBe(path);
			expect(rewrite(undefined as unknown as string, 'GET', path), path).toBe(path);
		}
	});
});

describe('what the rule does with a body it was not given', () => {
	it('does not read the word nonce in prose as a nonce', () => {
		for (const html of [
			'<p>A nonce is a number used once.</p>',
			'<input type="text" name="search" value="nonce">',
			'<script>var nonceless = true;</script>'
		]) {
			expect(carriesNonce(html), html).toBe(false);
		}
	});

	it('reads a nonce in a field, a link or a script', () => {
		const pages = [
			'<form><input type="hidden" id="_wpnonce" name="_wpnonce" value="1a2b3c4d5e" /></form>',
			"<input type='hidden' name='_wpnonce' value='abcdef0123'>",
			'<input name="_wp_http_referer" value="/wp-admin/">',
			'<input type="hidden" name="comment_nonce" value="abcdef0123">',
			'<input name=_wpnonce value=abc>',
			'<a href="/wp-login.php?action=logout&amp;_wpnonce=abcdef0123">Log out</a>',
			'<script>var wpApiSettings = {"root":"/wp-json/","nonce":"abcdef0123"};</script>',
			'<script>var userProfileL10n = {nonce: "0123456789"};</script>'
		];
		for (const html of pages) {
			expect(carriesNonce(html), html).toBe(true);
			const whole = `<!DOCTYPE html><html><body>${html}</body></html>`;
			expect(wordpressRefusal({ ...anonymous, html: whole }, ON), html).toBe('nonce');
		}
	});

	it('cannot scan a body it was not given, and says nothing about one', () => {
		const { html: _html, ...bodyless } = anonymous;
		expect(wordpressRefusal(bodyless, ON)).toBeUndefined();
	});
});

describe('the front worker store', () => {
	const stored = (
		env: Record<string, string>,
		headers: Record<string, string>,
		answer: Record<string, string> = { 'cache-control': 'public, max-age=0, must-revalidate' },
		path = '/'
	) => {
		const puts: string[] = [];
		const cache = { put: async (key: Request) => void puts.push(key.url) } as unknown as Cache;
		const f = {
			env,
			site: 's',
			path,
			serving: true,
			cache,
			origin: 'https://x.test',
			request: new Request('https://x.test/serve?path=%2F', { headers }),
			defer: () => undefined
		} as unknown as FrontContext;
		const auth = {
			authenticated: false,
			mode: 'render' as const,
			reason: '',
			personalised: false,
			enforcedOf: () => false
		};
		const learned = { armedFill: 'n/a', doCache: 'RENDER', generation: 3 };
		const res = new Response('<html>x</html>', {
			status: 200,
			headers: { 'x-cfw-cache': 'RENDER', 'content-type': HTML, ...answer }
		});
		return { out: storeEdge(f, auth, res, learned), puts };
	};

	it('puts nothing in the edge cache or KV for WordPress while the setting is off', () => {
		const { out, puts } = stored({ CMS: 'wordpress' }, {});
		expect(out).toEqual({
			put: 'skipped:page-cache-off',
			kvPut: 'skipped:page-cache-off'
		});
		expect(puts).toEqual([]);
	});

	it('stores an anonymous page once the setting is on', () => {
		const { out, puts } = stored({ CMS: 'wordpress', ...ON }, {});
		expect(out.put).toBe('deferred');
		expect(puts).toHaveLength(1);
	});

	const refused: [string, Record<string, string>, Record<string, string>, string, string][] = [
		[
			'an uncacheable render, which is what stored the broken feed',
			{},
			{ 'cache-control': 'private, no-store' },
			'/',
			'cache-control'
		],
		['a no-cache response', {}, { 'cache-control': 'no-cache' }, '/', 'cache-control'],
		['a cookie', { cookie: 'wordpress_test_cookie=1' }, {}, '/', 'cookie'],
		[
			'a login cookie',
			{ cookie: `wordpress_logged_in_${'a'.repeat(32)}=x` },
			{},
			'/',
			'cookie'
		],
		['an Authorization header', { authorization: 'Basic YTpi' }, {}, '/', 'authorization'],
		[
			'a response that sets a cookie',
			{},
			{ 'cache-control': 'public', 'set-cookie': 'a=b' },
			'/',
			'set-cookie'
		],
		['a search', {}, {}, '/?s=hello', 'query-param:s'],
		['the login page', {}, {}, '/wp-login.php', 'wp-internal'],
		['a REST route', {}, { 'content-type': 'application/json' }, '/wp-json/', 'wp-internal'],
		[
			'a forwarded host',
			{ 'x-forwarded-server': 'evil.example' },
			{},
			'/',
			'header-override:x-forwarded-server'
		],
		['JSON on a page path', {}, { 'content-type': 'application/json' }, '/', 'content-type']
	];
	for (const [name, headers, answer, path, reason] of refused) {
		it(`refuses ${name} with the setting on`, () => {
			const { out, puts } = stored({ CMS: 'wordpress', ...ON }, headers, answer, path);
			expect(out.put).toBe(`skipped:${reason}`);
			expect(out.kvPut).toBe(`skipped:${reason}`);
			expect(puts).toEqual([]);
		});
	}

	it('leaves Drupal as it was: a stored page, and a cookie that is no session does not stop it', () => {
		expect(stored({}, {}).out.put).toBe('deferred');
		expect(stored({ CMS: 'drupal' }, { cookie: 'foo=1' }).out.put).toBe('deferred');
		expect(stored({}, {}, { 'cache-control': 'public', 'set-cookie': 'a=b' }).out.put).toBe(
			'skipped:set-cookie'
		);
		expect(stored({}, {}, undefined, '/search/node?keys=a&utm_source=b').out.put).toBe(
			'deferred'
		);
	});
});
