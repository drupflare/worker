import { decode, encode } from '@drupflare/durabledb/codec';
import spoolPackage from '@drupflare/spool/package.json';
import { staticHeaders } from '@drupflare/spool/server';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ignoreFile from '../../assets/.assetsignore?raw';
import headersFile from '../../assets/_headers?raw';
import stubFile from '../../assets/spool-sw.js?raw';
import type { MysqlBridge } from '../../src/do/mysql-bridge';
import type { SiteBinary } from '../../src/do/types';
import { resetPlanMemo, resetSettingsMemo } from '../../src/ops/plan';
import {
	pathTagFor,
	resetSpoolBudget,
	SPOOL_IP_LIMIT,
	spoolAllowed,
	spoolCursorFloor,
	SpoolStamps
} from '../../src/ops/spool';
import worker from '../../src/site';
import { resetSpoolMemo } from '../../src/site/spool';
import { installTagBridge } from '../../src/wordpress/tag-bridge';
import wranglerConfig from '../../wrangler.jsonc?raw';
import { druplicon } from '../fixtures/png';
import {
	freshSite,
	inObject,
	invalidateTag,
	markProvisioned,
	seedPage,
	seedTaggedPage,
	type ServeDo
} from '../helpers/serve-do';

const pageScripts = import.meta.glob('../../assets/.spool/*/*.js', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

/**
 * Spool, from the version vector in the object to what the front worker sends a device.
 *
 * Spool runs on a paid site unless `SPOOL` is `0`, so these specs pin what it changes on the wire:
 * a decorated page, the paths it owns, the object request a sync costs, and each media rewrite with
 * its own lever.
 */

const PAGE = '<html><head><title>t</title></head><body>rendered</body></html>';

/** the attribute of the inline tag spool puts in a page it decorates */
const GATE = 'data-spool-gate';
const MEDIA_PAGE =
	'<html><head><title>m</title></head><body>' +
	'<video src="/files/clip.mp4" controls></video>' +
	'<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe>' +
	'</body></html>';

const withBody = (body: string) => `<html><head><title>t</title></head><body>${body}</body></html>`;

/** a WordPress page with a nonce in a form, which the store rule never keeps */
const NONCE_PAGE = withBody(
	'<form method="post"><input type="hidden" name="_wpnonce" value="0a1b2c3d4e"></form>'
);

/** WordPress's form for a password-protected post */
const PROTECTED_PAGE = withBody(
	'<form action="/wp-login.php?action=postpass" class="post-password-form" method="post"></form>'
);

/** a search results page, which the store rule refuses by its body class */
const SEARCH_PAGE =
	'<html><head><title>s</title></head><body class="search search-results">found</body></html>';

/** what the object answers for a path; the prefix picks the page */
function bodyFor(path: string): string {
	if (path.startsWith('/media')) return MEDIA_PAGE;
	if (path.startsWith('/nonce')) return NONCE_PAGE;
	if (path.startsWith('/protected')) return PROTECTED_PAGE;
	if (path.startsWith('/results')) return SEARCH_PAGE;
	return PAGE;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** the real PNG with a text chunk before IEND, so it passes the proxy's 4 KiB floor and still decodes */
function pngOver(minBytes: number): Uint8Array {
	const png = druplicon();
	const body = png.subarray(0, png.length - 12);
	const end = png.subarray(png.length - 12);
	const text = new TextEncoder().encode(`pad\0${'x'.repeat(minBytes - png.length)}`);
	const chunk = new Uint8Array(12 + text.length);
	const view = new DataView(chunk.buffer);
	view.setUint32(0, text.length);
	chunk.set(new TextEncoder().encode('tEXt'), 4);
	chunk.set(text, 8);
	view.setUint32(8 + text.length, crc32(chunk.subarray(4, 8 + text.length)));
	const out = new Uint8Array(body.length + chunk.length + end.length);
	out.set(body, 0);
	out.set(chunk, body.length);
	out.set(end, body.length + chunk.length);
	return out;
}

const IMAGE = pngOver(6_000);

type Vector = { cursor: number; changed: Record<string, number>; reset: boolean };

/** an object that answers pages, one image and `/__spool`, and records what the front worker asked */
function objectSpy(vector: Vector) {
	const asked: string[] = [];
	return {
		asked,
		namespace: {
			idFromName: (name: string) => ({ name, toString: () => name }),
			newUniqueId: () => ({ toString: () => 'unique' }),
			get: () => ({
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					asked.push(url.pathname + url.search);
					if (url.pathname === '/__spool') return Response.json(vector);
					const path = url.searchParams.get('path') ?? url.pathname;
					if (path.endsWith('.png')) {
						return new Response(IMAGE, {
							status: 200,
							headers: { 'content-type': 'image/png', 'x-cfw-generation': '7' }
						});
					}
					if (path.startsWith('/boom')) throw new Error('the object is down');
					return new Response(bodyFor(path), {
						status: 200,
						headers: {
							'content-type': 'text/html; charset=UTF-8',
							'x-cfw-cache': 'RENDER',
							'x-cfw-generation': '7',
							...(/^\/(nonce|protected|results)/.test(path)
								? { 'cache-control': 'public, max-age=300' }
								: {})
						}
					});
				}
			})
		}
	};
}

async function through(
	path: string,
	overrides: Record<string, unknown> = {},
	init: RequestInit = {},
	vector: Vector = { cursor: spoolCursorFloor(7), changed: {}, reset: false }
) {
	const spy = objectSpy(vector);
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`https://cfw.local${path}`, init),
		{ ...env, SITE: spy.namespace, ...overrides } as unknown as typeof env,
		ctx
	);
	const bytes = new Uint8Array(await res.arrayBuffer());
	await waitOnExecutionContext(ctx);
	return { res, bytes, body: new TextDecoder().decode(bytes), asked: spy.asked };
}

const PAID = { PLAN: 'paid' };

describe('the version vector the object keeps', () => {
	it('names the tags and the pages a scoped purge changed, at cursors above the one before it', async () => {
		const out = await inObject(freshSite(), async (site) => {
			markProvisioned(site);
			seedTaggedPage(site, '/node/1', PAGE, ['node:1', 'node_list']);
			seedTaggedPage(site, '/about', PAGE, ['node:9']);
			const before = site.spoolVector().cursor(site.generation());
			invalidateTag(site, 'node:1');
			const purged = site.purgeForTags(['node:1'], 'cachetags');
			return {
				before,
				purged: purged['purged'],
				diff: site.spoolVector().diff(before, site.generation())
			};
		});
		expect(out.purged).toBe(1);
		expect(out.diff.reset).toBe(false);
		expect(Object.keys(out.diff.changed).sort()).toEqual(
			['node:1', pathTagFor('/node/1')].sort()
		);
		for (const at of Object.values(out.diff.changed)) expect(at).toBeGreaterThan(out.before);
		expect(out.diff.cursor).toBeGreaterThanOrEqual(
			Math.max(...Object.values(out.diff.changed))
		);
	});

	it('resets every holder behind a wholesale bump', async () => {
		const out = await inObject(freshSite(), async (site) => {
			markProvisioned(site);
			const before = site.spoolVector().cursor(site.generation());
			site.bumpGeneration('manual');
			return { before, diff: site.spoolVector().diff(before, site.generation()) };
		});
		expect(out.diff.reset).toBe(true);
	});

	it('resets a device that was owed a change across an object restart, and writes no row for it', async () => {
		const out = await inObject(freshSite(), async (site) => {
			markProvisioned(site);
			seedTaggedPage(site, '/node/1', PAGE, ['node:1']);
			const before = site.spoolVector().cursor(site.generation());
			site.purgeForTags(['node:1'], 'cachetags');
			const told = site.spoolVector().diff(before, site.generation());
			// a new instance knows nothing before its own start
			(site as unknown as { spoolStamps?: SpoolStamps }).spoolStamps = undefined;
			return {
				told,
				after: site.spoolVector().diff(before, site.generation()),
				spoolRows: site.sql
					.exec("SELECT COUNT(*) AS c FROM cfw_meta WHERE k LIKE 'spool%'")
					.toArray()[0]?.['c']
			};
		});
		expect(out.told.reset).toBe(false);
		expect(Object.keys(out.told.changed)).toContain('node:1');
		expect(out.after.reset).toBe(true);
		expect(out.spoolRows).toBe(0);
	});

	it('answers a diff and a cursor on the internal route, and refuses anything else', async () => {
		const out = await inObject(freshSite(), async (site) => {
			markProvisioned(site);
			const cursor = site.spoolVector().cursor(site.generation());
			const get = async (query: string, method = 'GET') =>
				(site as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
					new Request(`https://x/__spool${query}`, { method })
				);
			const asked = await get('?op=cursor');
			const diff = await get(`?op=diff&from=${cursor}`);
			const junk = await get('?op=diff&from=abc');
			const unknown = await get('?op=wipe');
			const post = await get('?op=cursor', 'POST');
			return {
				cursor,
				asked: await asked.json(),
				diff: await diff.json(),
				junk: await junk.json(),
				statuses: [unknown.status, post.status]
			};
		});
		expect(out.asked).toEqual({ cursor: out.cursor });
		expect(out.diff).toEqual({ cursor: out.cursor, changed: {}, reset: false });
		expect(out.junk).toMatchObject({ reset: true });
		expect(out.statuses).toEqual([400, 405]);
	});
});

describe('spool at the front worker', () => {
	beforeEach(() => {
		resetPlanMemo();
		resetSettingsMemo();
		resetSpoolBudget();
		resetSpoolMemo();
	});
	afterEach(() => {
		resetPlanMemo();
		resetSettingsMemo();
	});

	it('decorates an anonymous page on a paid site with no lever set, and serves from devices', async () => {
		const { res, body, asked } = await through('/page-paid', PAID);
		expect(res.status).toBe(200);
		expect(body).toContain(GATE);
		expect(body).toContain('rendered');
		expect(res.headers.get('x-spool-mode')).toBe('serve');
		expect(res.headers.get('spool-vector')).toBe(String(spoolCursorFloor(7)));
		// the generation rode in on the page response, so decorating cost no object request
		expect(asked.filter((entry) => entry.startsWith('/__spool'))).toEqual([]);
	});

	it('is on for a free site and a paid one, and off on either when SPOOL is 0', async () => {
		const free = await through('/page-free', { PLAN: 'free' });
		expect(free.body).toContain(GATE);
		resetPlanMemo();
		const freeOff = await through('/page-free-off', { PLAN: 'free', SPOOL: '0' });
		expect(freeOff.body).not.toContain(GATE);
		resetPlanMemo();
		const off = await through('/page-paid-off', { ...PAID, SPOOL: '0' });
		expect(off.body).not.toContain(GATE);
	});

	it('keeps a listed path prefix out of spool and decorates every other page', async () => {
		const control = await afresh('/members/open-control', PAID);
		expect(control.body).toContain(GATE);
		const empty = await afresh('/members/open-empty', { ...PAID, SPOOL_EXCLUDE: '' });
		expect(empty.body).toContain(GATE);
		const listed = { ...PAID, SPOOL_EXCLUDE: '/members, /account/' };
		for (const path of ['/members', '/members/open-listed', '/account/settings']) {
			const out = await afresh(path, listed);
			expect(out.res.status, path).toBe(200);
			expect(out.body, path).toContain('rendered');
			expect(out.body, path).not.toContain(GATE);
			expect(out.res.headers.get('spool-vector'), path).toBeNull();
		}
		for (const path of ['/memberships', '/about/members']) {
			const out = await afresh(path, listed);
			expect(out.body, path).toContain(GATE);
		}
	});

	it('answers the worker script whatever the exclusion names', async () => {
		const sw = await afresh('/spool-sw.js', { ...PAID, SPOOL_EXCLUDE: '/members' });
		expect(sw.res.headers.get('content-type')).toMatch(/javascript/);
	});

	it('leaves a request with a cookie, a write and an owner route alone', async () => {
		const cookie = await through('/page-cookie', PAID, { headers: { cookie: 'SESS0123=abc' } });
		expect(cookie.body).not.toContain(GATE);
		resetPlanMemo();
		const post = await through('/page-post', PAID, {
			method: 'POST',
			body: 'a=1',
			headers: { 'content-type': 'application/x-www-form-urlencoded' }
		});
		expect(post.body).not.toContain(GATE);
	});

	it('answers the worker script itself, with no object request, and only while spool runs', async () => {
		const on = await through('/spool-sw.js', PAID);
		expect(on.res.status).toBe(200);
		expect(on.res.headers.get('content-type')).toMatch(/javascript/);
		expect(on.body.length).toBeGreaterThan(1_000);
		expect(on.asked).toEqual([]);
		resetPlanMemo();
		const off = await through('/spool-sw.js', { ...PAID, SPOOL: '0' });
		expect(off.res.headers.get('content-type') ?? '').toMatch(/text\/html/);
	});

	it('asks the object for the diff on a sync, and only then', async () => {
		const vector = { cursor: spoolCursorFloor(7) + 2, changed: { 'node:1': 9 }, reset: false };
		const { res, body, asked } = await through('/.spool/sync?from=5', PAID, {}, vector);
		expect(res.status).toBe(200);
		expect(asked).toEqual(['/__spool?op=diff&from=5']);
		expect(body).toContain('node:1');
	});

	it('answers a device that piggybacks a sync on a navigation, once for a moment', async () => {
		const shadowless = { ...PAID };
		const device = { headers: { 'spool-vector-seen': '3' } };
		const vector = { cursor: spoolCursorFloor(7) + 1, changed: { 'node:2': 9 }, reset: false };
		const first = await through('/piggyback-a', shadowless, device, vector);
		resetPlanMemo();
		const second = await through('/piggyback-b', shadowless, device, vector);
		expect(first.asked.filter((entry) => entry.startsWith('/__spool'))).toEqual([
			'/__spool?op=diff&from=3'
		]);
		expect(second.asked.filter((entry) => entry.startsWith('/__spool'))).toEqual([]);
		expect(first.res.headers.get('spool-invalidate')).toContain('node');
	});

	it('writes a beacon to observability and no row, with no object request', async () => {
		const lines: unknown[][] = [];
		const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
			lines.push(args);
		});
		try {
			const batch = {
				protocol: 1,
				events: [
					{
						path: '/.spool/view',
						body: '{"route":"/"}',
						contentType: 'application/json',
						at: 1
					}
				]
			};
			const { res, asked } = await through('/.spool/beacon', PAID, {
				method: 'POST',
				body: JSON.stringify(batch)
			});
			expect(res.status).toBe(204);
			expect(asked).toEqual([]);
			const written = lines.filter((args) => args[0] === 'cfw-spool');
			expect(written).toHaveLength(1);
			expect(String(written[0]?.[1])).toContain('/.spool/view');
		} finally {
			log.mockRestore();
		}
	});

	it('refuses an address past its budget with a 429 and answers another one', async () => {
		const from = (address: string) => ({ headers: { 'cf-connecting-ip': address } });
		for (let i = 0; i < SPOOL_IP_LIMIT; i++) spoolAllowed('203.0.113.9', Date.now());
		const refused = await through('/.spool/sync?from=0', PAID, from('203.0.113.9'));
		expect(refused.res.status).toBe(429);
		expect(refused.res.headers.get('retry-after')).toBe('60');
		expect(refused.asked).toEqual([]);
		resetPlanMemo();
		const other = await through('/.spool/sync?from=0', PAID, from('203.0.113.10'));
		expect(other.res.status).toBe(200);
	});

	it('bounds what a visitor writes to a log line', async () => {
		const lines: unknown[][] = [];
		const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
			lines.push(args);
		});
		try {
			const batch = {
				protocol: 1,
				events: [
					{
						path: '/.spool/view',
						body: `{"note":"${'x'.repeat(5_000)}\\n"}\nforged`,
						contentType: 'application/json',
						at: 1
					}
				]
			};
			await through('/.spool/beacon', PAID, { method: 'POST', body: JSON.stringify(batch) });
			const line = String(lines.find((args) => args[0] === 'cfw-spool')?.[1]);
			expect(line).not.toMatch(/[\r\n]/);
			expect(JSON.parse(line).body.length).toBeLessThanOrEqual(1024);
		} finally {
			log.mockRestore();
		}
	});

	it('loads an artifact through the same pipeline a visitor takes', async () => {
		const batch = { protocol: 1, events: [], want: ['/artifact-page'] };
		const { res, body, asked } = await through('/.spool/beacon', PAID, {
			method: 'POST',
			body: JSON.stringify(batch)
		});
		expect(res.status).toBe(200);
		expect(asked.some((entry) => !entry.startsWith('/__spool'))).toBe(true);
		expect(body).toContain('/artifact-page');
	});

	it('keeps every spool path out of a redirect rule', async () => {
		const rules = JSON.stringify([{ from: '/.spool/*', to: '/elsewhere' }]);
		const { res } = await through('/.spool/sync?from=0', { ...PAID, REDIRECTS: rules });
		expect(res.status).toBe(200);
		expect(res.headers.get('x-cfw-redirect')).toBeNull();
	});

	it('answers a failure of the pipeline as it would without spool, and not with a 502 of its own', async () => {
		const without = await through('/boom-a', { ...PAID, SPOOL: '0' });
		resetPlanMemo();
		const withSpool = await through('/boom-b', PAID);
		expect(withSpool.res.status).toBe(without.res.status);
		expect(withSpool.res.status).not.toBe(502);
	});
});

describe('the media features', () => {
	beforeEach(() => {
		resetPlanMemo();
		resetSettingsMemo();
		resetSpoolBudget();
		resetSpoolMemo();
	});

	const webp = { headers: { accept: 'image/webp,image/*' } };

	it('converts an image to WebP for a browser that accepts it, and leaves it alone otherwise', async () => {
		const converted = await through('/pictures/photo.png', PAID, webp);
		expect(converted.res.headers.get('content-type')).toBe('image/webp');
		expect(converted.res.headers.get('x-spool-image')).not.toBeNull();
		expect(converted.res.headers.get('vary') ?? '').toMatch(/accept/i);
		expect(converted.bytes.length).toBeLessThan(IMAGE.length);
		resetPlanMemo();
		const plain = await through('/pictures/photo.png', PAID, {
			headers: { accept: 'image/png' }
		});
		expect(plain.res.headers.get('content-type')).toBe('image/png');
		expect(plain.bytes.length).toBe(IMAGE.length);
	});

	it('leaves an image alone when SPOOL_IMAGES is 0, and tells the browser nothing about widths', async () => {
		const off = await through('/pictures/photo.png', { ...PAID, SPOOL_IMAGES: '0' }, webp);
		expect(off.res.headers.get('content-type')).toBe('image/png');
		expect(off.bytes.length).toBe(IMAGE.length);
		resetPlanMemo();
		const page = await through('/media-hints', { ...PAID, SPOOL_IMAGES: '0' });
		expect(page.res.headers.get('accept-ch')).toBeNull();
		resetPlanMemo();
		const hinted = await through('/media-hints-on', PAID);
		expect(hinted.res.headers.get('accept-ch')).toMatch(/sec-ch-width/i);
	});

	it('stops a video from preloading, and stops doing it when SPOOL_VIDEO is 0', async () => {
		const on = await through('/media-video', PAID);
		expect(on.body).toMatch(/<video[^>]*preload="none"/);
		resetPlanMemo();
		const off = await through('/media-video-off', { ...PAID, SPOOL_VIDEO: '0' });
		expect(off.body).not.toMatch(/preload=/);
	});

	it('swaps a YouTube iframe for a facade, and stops doing it when SPOOL_EMBEDS is 0', async () => {
		const on = await through('/media-embed', PAID);
		expect(on.body).toContain('srcdoc=');
		resetPlanMemo();
		const off = await through('/media-embed-off', { ...PAID, SPOOL_EMBEDS: '0' });
		expect(off.body).not.toContain('srcdoc=');
		expect(off.body).toContain('youtube.com/embed/dQw4w9WgXcQ');
	});

	it('does none of it while spool is off', async () => {
		const off = await through('/media-all-off', { ...PAID, SPOOL: '0' });
		expect(off.body).not.toMatch(/preload=/);
		expect(off.body).not.toContain('srcdoc=');
		resetPlanMemo();
		const image = await through('/pictures/photo.png', { ...PAID, SPOOL: '0' }, webp);
		expect(image.res.headers.get('content-type')).toBe('image/png');
	});
});

const WP = { PLAN: 'paid', CMS: 'wordpress', WORDPRESS_PAGE_CACHE: '1' };

/** runs a request with the plan memo cleared, so each call reads the overrides it was given */
async function afresh(...args: Parameters<typeof through>) {
	resetPlanMemo();
	return through(...args);
}

describe('what spool replicates, by CMS', () => {
	beforeEach(() => {
		resetPlanMemo();
		resetSettingsMemo();
		resetSpoolBudget();
		resetSpoolMemo();
	});

	const credentials: Record<string, [string, RequestInit][]> = {
		drupal: [
			[
				'a session cookie',
				{ headers: { cookie: 'SESS0123456789abcdef0123456789abcdef=abc' } }
			],
			['a bearer token', { headers: { authorization: 'Bearer abc' } }]
		],
		wordpress: [
			['a login cookie', { headers: { cookie: 'wordpress_logged_in_0a1b=ada%7C1%7Cx' } }],
			[
				'the test cookie',
				{ headers: { cookie: 'wordpress_test_cookie=WP%20Cookie%20check' } }
			],
			['a comment author cookie', { headers: { cookie: 'comment_author_0a1b=Ada' } }],
			['a post password cookie', { headers: { cookie: 'wp-postpass_0a1b=x' } }],
			['basic credentials', { headers: { authorization: 'Basic YWRhOnB3' } }]
		]
	};

	for (const [cms, overrides] of [
		['drupal', PAID],
		['wordpress', WP]
	] as const) {
		it(`decorates an anonymous ${cms} page and leaves every credentialed request to the CMS`, async () => {
			const control = await afresh(`/hello-${cms}/`, overrides);
			expect(control.res.status).toBe(200);
			expect(control.body).toContain(GATE);
			for (const [what, init] of credentials[cms]!) {
				const out = await afresh(
					`/hello-${cms}-${what.replaceAll(' ', '-')}/`,
					overrides,
					init
				);
				expect(out.res.status, what).toBe(200);
				expect(out.body, what).toContain('rendered');
				expect(out.body, what).not.toContain(GATE);
				expect(out.res.headers.get('spool-vector'), what).toBeNull();
			}
		});
	}

	it('keeps WordPress admin, login, API, cron, feeds and previews out, and Drupal does not inherit the list', async () => {
		const control = await afresh('/hello-world/', WP);
		expect(control.body).toContain(GATE);
		for (const path of [
			'/wp-admin/',
			'/wp-admin/admin-ajax.php',
			'/wp-login.php',
			'/wp-json/wp/v2/posts',
			'/wp-cron.php',
			'/xmlrpc.php',
			'/feed/',
			'/category/news/feed/',
			'/?feed=rss2',
			'/?p=5&preview=true',
			'/hello-world/?preview_id=5',
			'/search/term/'
		]) {
			const out = await afresh(path, WP);
			expect(out.body, path).not.toContain(GATE);
			expect(out.res.headers.get('spool-vector'), path).toBeNull();
		}
		const drupal = await afresh('/feed/', PAID);
		expect(drupal.body).toContain(GATE);
	});

	it('refuses a WordPress page the store rule refuses, and hands the visitor the page the CMS sent', async () => {
		const control = await afresh('/hello-world/', WP);
		expect(control.body).toContain(GATE);
		for (const path of ['/nonce-form/', '/protected-post/', '/results-page/']) {
			const held = await afresh(path, WP);
			// another path of the same prefix, because the edge cache keeps the first answer by path
			const bare = await afresh(`${path}bare/`, { ...WP, SPOOL: '0' });
			expect(held.body, path).not.toContain(GATE);
			expect(held.body, path).toBe(bare.body);
			expect(bare.res.headers.get('cache-control'), path).toBe('public, max-age=300');
			expect(held.res.headers.get('cache-control'), path).toBe('public, max-age=300');
			expect(held.res.headers.get('spool-vector'), path).toBeNull();
		}
		const drupal = await afresh('/nonce-form/', PAID);
		expect(drupal.body).toContain(GATE);
	});

	it('replicates no WordPress page while the page store is off, and still answers its own paths', async () => {
		const off = await afresh('/hello-world/', { ...WP, WORDPRESS_PAGE_CACHE: '0' });
		expect(off.body).not.toContain(GATE);
		const sw = await afresh('/spool-sw.js', { ...WP, WORDPRESS_PAGE_CACHE: '0' });
		expect(sw.res.status).toBe(200);
		expect(sw.res.headers.get('content-type')).toMatch(/javascript/);
	});
});

describe('the static tier', () => {
	beforeEach(() => {
		resetPlanMemo();
		resetSettingsMemo();
		resetSpoolBudget();
		resetSpoolMemo();
	});

	const version = spoolPackage.version;

	it('holds the files of the installed library and no other version', () => {
		expect(Object.keys(pageScripts).sort()).toEqual([
			`../../assets/.spool/${version}/client.js`,
			`../../assets/.spool/${version}/navigate.js`
		]);
	});

	it('is byte for byte what the worker answers for the same paths', async () => {
		const sw = await through('/spool-sw.js', PAID);
		expect(sw.body).toBe(stubFile);
		for (const name of ['client', 'navigate']) {
			const served = await afresh(`/.spool/${version}/${name}.js`, PAID);
			expect(served.body, name).toBe(
				pageScripts[`../../assets/.spool/${version}/${name}.js`]
			);
		}
	});

	it('names the library version and a runtime the device compares, and never asks the object', async () => {
		const ahead = { cursor: spoolCursorFloor(7) + 9, changed: {}, reset: false };
		const first = await through('/spool-sw.js', PAID);
		const second = await afresh('/spool-sw.js', PAID, {}, ahead);
		expect(first.asked).toEqual([]);
		expect(second.asked).toEqual([]);
		expect(second.body).toBe(first.body);
		const config = JSON.parse(/^self\.__SPOOL_CONFIG__=(.*);\n/.exec(stubFile)?.[1] ?? 'null');
		expect(config.version).toBe(version);
		expect(typeof config.runtime).toBe('string');
		expect(config.lease).toBe(86_400);
		expect(config.views).toBe(false);
	});

	it('carries the library headers for both files and the lease its own stub names', async () => {
		for (const block of staticHeaders(86_400).trim().split('\n\n')) {
			expect(headersFile).toContain(block);
		}
		const sw = await afresh('/spool-sw.js', PAID);
		expect(sw.res.headers.get('cache-control')).toBe('max-age=86400');
		expect(sw.res.headers.get('service-worker-allowed')).toBe('/');
		const script = await afresh(`/.spool/${version}/client.js`, PAID);
		expect(script.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
	});

	it('publishes the files and nothing else of spool, and leaves the asset tier first', () => {
		const lines = ignoreFile.split('\n').map((line) => line.trim());
		expect(lines).toContain('!/spool-sw.js');
		expect(lines).toContain('!/.spool/');
		for (const line of lines.filter((l) => l.includes('spool'))) {
			expect(line).toMatch(/^!\/(spool-sw\.js|\.spool\/)$|^#/);
		}
		expect(wranglerConfig).not.toContain('run_worker_first');
	});

	it('leaves the data paths to the worker', async () => {
		const sync = await afresh('/.spool/sync?from=0', PAID);
		expect(sync.res.status).toBe(200);
		expect(sync.asked).toEqual(['/__spool?op=diff&from=0']);
	});
});

describe('a device that holds an earlier library version', () => {
	beforeEach(() => {
		resetPlanMemo();
		resetSettingsMemo();
		resetSpoolBudget();
		resetSpoolMemo();
	});

	/** what the 0.3.0 worker script named: a version and no runtime hash */
	const EARLIER = { version: '0.3.0', runtime: undefined as string | undefined };

	it('is told to wipe by a script that names another code version', () => {
		const config = JSON.parse(/^self\.__SPOOL_CONFIG__=(.*);\n/.exec(stubFile)?.[1] ?? 'null');
		const now = config.runtime ?? config.version;
		expect(now).not.toBe(EARLIER.runtime ?? EARLIER.version);
		expect(now).not.toBe(config.version);
	});

	it('finds no page script at the old version, so an old page loads as a plain document', async () => {
		const gone = await afresh(`/.spool/${EARLIER.version}/client.js`, PAID);
		expect(gone.res.status).toBe(404);
		expect(gone.body).not.toContain('data-spool');
	});

	it('reinstalls from a script that is not the old one, over the same path', async () => {
		const sw = await afresh('/spool-sw.js', PAID);
		expect(sw.body).not.toContain(`"version":"${EARLIER.version}"`);
		expect(sw.body).toContain(`"version":"${spoolPackage.version}"`);
	});
});

describe('a change reaching a device', () => {
	type Run = { tags: string[]; ops?: Record<string, unknown>[]; write?: string };

	/** the host's own entry points on a real object: the emitter's op, the statement wrapper and the end of a run */
	function wordpress(site: ServeDo) {
		Object.assign(site.env, { CMS: 'wordpress', WORDPRESS_PAGE_CACHE: '1' });
		type Host = {
			cfwMysqlExec: (json: string) => string;
			cfwWpTags: (json: string) => string;
		};
		const host = {
			cfwMysqlExec: () => JSON.stringify(encode({ ok: true, kind: 'write', affected: 1 }))
		} as unknown as Host;
		const binary = host as unknown as SiteBinary;
		const mysql = { beginRun() {}, session: () => undefined } as unknown as MysqlBridge;
		const bridge = installTagBridge(site as never, binary, mysql);
		const send = (body: Record<string, unknown>) =>
			decode(JSON.parse(host.cfwWpTags(JSON.stringify(encode(body)))));
		return {
			run({ tags, ops = [], write }: Run) {
				bridge.beginRun();
				if (write !== undefined) {
					host.cfwMysqlExec(JSON.stringify(encode({ sql: write })));
				}
				if (tags.length > 0) send({ op: 'announce', tags });
				for (const op of ops) send(op);
				send({ op: 'settle' });
			}
		};
	}

	const HELLO = '/2026/01/01/hello-world/';
	const OTHER = '/2026/01/02/other/';

	/** pages the way the store holds them: by path, with the tags their render read */
	function seed(site: ServeDo) {
		markProvisioned(site);
		seedTaggedPage(site, HELLO, PAGE, ['post:5', 'posts', 'option:blogname']);
		seedTaggedPage(site, OTHER, PAGE, ['post:9']);
		seedTaggedPage(site, '/', PAGE, ['posts']);
		seedTaggedPage(site, '/category/news/', PAGE, ['term:3', 'terms:category']);
	}

	/** the diff a device that synced before `before` is told next, as the paths it names */
	function told(site: ServeDo, before: number) {
		const diff = site.spoolVector().diff(before, site.generation());
		const paths = Object.keys(diff.changed)
			.filter((tag) => tag.startsWith('proxy:path:'))
			.map((tag) => tag.slice('proxy:path:'.length))
			.sort();
		return { reset: diff.reset, paths };
	}

	const edits: [string, Run, string[]][] = [
		['edits a post', { tags: ['post:5'] }, [HELLO]],
		['publishes a post', { tags: ['post:6', 'posts'] }, ['/', HELLO]],
		['changes an option', { tags: ['option:blogname'] }, [HELLO]],
		['deletes a term', { tags: ['term:3', 'terms:category', 'terms'] }, ['/category/news/']]
	];

	for (const [name, run, paths] of edits) {
		it(`names the pages a WordPress site that ${name} changed, and no other`, async () => {
			const out = await inObject(freshSite(), (site) => {
				seed(site);
				const room = wordpress(site);
				const before = site.spoolVector().cursor(site.generation());
				room.run(run);
				return told(site, before);
			});
			expect(out.reset).toBe(false);
			expect(out.paths).toEqual([...paths].sort());
		});
	}

	it('resets every device behind a wholesale purge the emitter asks for', async () => {
		const out = await inObject(freshSite(), (site) => {
			seed(site);
			const room = wordpress(site);
			const before = site.spoolVector().cursor(site.generation());
			room.run({ tags: [], ops: [{ op: 'wholesale', reason: 'menu' }] });
			return told(site, before);
		});
		expect(out.reset).toBe(true);
	});

	it('resets every device behind the floor purge for a write nobody announced', async () => {
		const out = await inObject(freshSite(), (site) => {
			seed(site);
			const room = wordpress(site);
			const before = site.spoolVector().cursor(site.generation());
			room.run({
				tags: [],
				write: "UPDATE wp_options SET option_value = 'x' WHERE option_id = 1"
			});
			return {
				...told(site, before),
				floor: (site as unknown as { wordpressTags?: { floorPurges: number } })
					.wordpressTags?.floorPurges
			};
		});
		expect(out.floor).toBe(1);
		expect(out.reset).toBe(true);
	});

	it('names a Drupal page by the tag purge, and resets on a purge that cannot tell which pages', async () => {
		const out = await inObject(freshSite(), (site) => {
			markProvisioned(site);
			seedTaggedPage(site, '/node/1', PAGE, ['node:1']);
			seedTaggedPage(site, '/node/2', PAGE, ['node:2']);
			const before = site.spoolVector().cursor(site.generation());
			invalidateTag(site, 'node:1');
			site.purgeForTags(['node:1'], 'cachetags');
			const scoped = told(site, before);
			// a stored page with no recorded tags makes the index unable to answer
			seedPage(site, '/untagged', PAGE);
			const mark = site.spoolVector().cursor(site.generation());
			invalidateTag(site, 'node:2');
			site.purgeForTags(['node:2'], 'cachetags');
			return { scoped, wide: told(site, mark) };
		});
		expect(out.scoped).toEqual({ reset: false, paths: ['/node/1'] });
		expect(out.wide.reset).toBe(true);
	});

	it('cannot name a page the store does not hold, which is the limit the docs state', async () => {
		const out = await inObject(freshSite(), (site) => {
			markProvisioned(site);
			seedTaggedPage(site, '/node/1', PAGE, ['node:1']);
			const before = site.spoolVector().cursor(site.generation());
			invalidateTag(site, 'node:7');
			site.purgeForTags(['node:7'], 'cachetags');
			return told(site, before);
		});
		expect(out).toEqual({ reset: false, paths: [] });
	});
});
