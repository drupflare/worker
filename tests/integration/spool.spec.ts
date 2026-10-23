import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { druplicon } from '../fixtures/png';
import {
	freshSite,
	inObject,
	invalidateTag,
	markProvisioned,
	seedTaggedPage
} from '../helpers/serve-do';

/**
 * Spool, from the version vector in the object to what the front worker sends a device.
 *
 * Spool runs on a paid site unless `SPOOL` is `0`, so these specs pin what it changes on the wire:
 * a decorated page, the paths it owns, the object request a sync costs, and each media rewrite with
 * its own lever.
 */

const PAGE = '<html><head><title>t</title></head><body>rendered</body></html>';
const MEDIA_PAGE =
	'<html><head><title>m</title></head><body>' +
	'<video src="/files/clip.mp4" controls></video>' +
	'<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe>' +
	'</body></html>';

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
					return new Response(path.startsWith('/media') ? MEDIA_PAGE : PAGE, {
						status: 200,
						headers: {
							'content-type': 'text/html; charset=UTF-8',
							'x-cfw-cache': 'RENDER',
							'x-cfw-generation': '7'
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
		expect(body).toContain('data-spool-client');
		expect(body).toContain('rendered');
		expect(res.headers.get('x-spool-mode')).toBe('serve');
		expect(res.headers.get('spool-vector')).toBe(String(spoolCursorFloor(7)));
		// the generation rode in on the page response, so decorating cost no object request
		expect(asked.filter((entry) => entry.startsWith('/__spool'))).toEqual([]);
	});

	it('is off on a free site until SPOOL turns it on, and off on a paid one when SPOOL is 0', async () => {
		const free = await through('/page-free', {});
		expect(free.body).not.toContain('data-spool-client');
		resetPlanMemo();
		const forced = await through('/page-free-on', { SPOOL: '1' });
		expect(forced.body).toContain('data-spool-client');
		resetPlanMemo();
		const off = await through('/page-paid-off', { ...PAID, SPOOL: '0' });
		expect(off.body).not.toContain('data-spool-client');
	});

	it('leaves a request with a cookie, a write and an owner route alone', async () => {
		const cookie = await through('/page-cookie', PAID, { headers: { cookie: 'SESS0123=abc' } });
		expect(cookie.body).not.toContain('data-spool-client');
		resetPlanMemo();
		const post = await through('/page-post', PAID, {
			method: 'POST',
			body: 'a=1',
			headers: { 'content-type': 'application/x-www-form-urlencoded' }
		});
		expect(post.body).not.toContain('data-spool-client');
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
