import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPlanMemo, resetSettingsMemo } from '../../src/ops/plan';
import { pathTagFor, resetSpoolBudget, SPOOL_IP_LIMIT, spoolAllowed } from '../../src/ops/spool';
import worker from '../../src/site';
import { resetSpoolMemo } from '../../src/site/spool';
import {
	freshSite,
	inObject,
	invalidateTag,
	markProvisioned,
	seedTaggedPage
} from '../helpers/serve-do';

/**
 * The spool shadow trial, from the version vector in the object to the front worker's routes.
 *
 * Shadow mode serves nothing from a device. These specs pin the three things it changes on the
 * wire: a decorated page, the paths it owns, and the object request a sync costs.
 */

const PAGE = '<html><head><title>t</title></head><body>rendered</body></html>';

/** a namespace whose object answers pages as the spy in `lever-behaviour.spec.ts` does, plus `/__spool` */
function objectSpy(vector: { cursor: number; changed: Record<string, number>; reset: boolean }) {
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
					return new Response(PAGE, {
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
	overrides: Record<string, unknown>,
	init: RequestInit = {},
	vector = { cursor: 7, changed: {}, reset: false }
) {
	const spy = objectSpy(vector);
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`https://cfw.local${path}`, init),
		{ ...env, SITE: spy.namespace, ...overrides } as unknown as typeof env,
		ctx
	);
	const body = await res.text();
	await waitOnExecutionContext(ctx);
	return { res, body, asked: spy.asked };
}

describe('the version vector the object keeps', () => {
	it('names the tags and the pages a scoped purge changed, at the generation it reached', async () => {
		const out = await inObject(freshSite(), async (site) => {
			markProvisioned(site);
			seedTaggedPage(site, '/node/1', PAGE, ['node:1', 'node_list']);
			seedTaggedPage(site, '/about', PAGE, ['node:9']);
			const before = site.generation();
			site.spoolVector();
			invalidateTag(site, 'node:1');
			const purged = site.purgeForTags(['node:1'], 'cachetags');
			return {
				before,
				after: site.generation(),
				purged: purged['purged'],
				diff: site.spoolVector().diff(before, site.generation())
			};
		});
		expect(out.after).toBeGreaterThan(out.before);
		expect(out.purged).toBe(1);
		expect(out.diff.reset).toBe(false);
		expect(out.diff.changed).toEqual({
			'node:1': out.after,
			[pathTagFor('/node/1')]: out.after
		});
	});

	it('resets every holder behind a wholesale bump', async () => {
		const out = await inObject(freshSite(), async (site) => {
			markProvisioned(site);
			const before = site.generation();
			site.spoolVector();
			site.bumpGeneration('manual');
			return { before, diff: site.spoolVector().diff(before, site.generation()) };
		});
		expect(out.diff.reset).toBe(true);
	});

	it('answers a diff and a cursor on the internal route, and refuses anything else', async () => {
		const out = await inObject(freshSite(), async (site) => {
			markProvisioned(site);
			const generation = site.generation();
			const get = async (query: string, method = 'GET') =>
				(site as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
					new Request(`https://x/__spool${query}`, { method })
				);
			const cursor = await get('?op=cursor');
			const diff = await get(`?op=diff&from=${generation}`);
			const junk = await get('?op=diff&from=abc');
			const unknown = await get('?op=wipe');
			const post = await get('?op=cursor', 'POST');
			return {
				generation,
				cursor: await cursor.json(),
				diff: await diff.json(),
				junk: await junk.json(),
				statuses: [unknown.status, post.status]
			};
		});
		expect(out.cursor).toEqual({ cursor: out.generation });
		expect(out.diff).toEqual({ cursor: out.generation, changed: {}, reset: false });
		expect(out.junk).toMatchObject({ reset: true });
		expect(out.statuses).toEqual([400, 405]);
	});
});

describe('SPOOL_MODE at the front worker', () => {
	beforeEach(() => {
		resetPlanMemo();
		resetSettingsMemo();
		resetSpoolBudget();
	});
	afterEach(() => {
		resetPlanMemo();
		resetSettingsMemo();
	});

	it('leaves a page and its paths alone while the mode is off, and on a free site', async () => {
		for (const [label, overrides] of [
			['default', {}],
			['free asked for shadow', { SPOOL_MODE: 'shadow' }],
			['paid, off', { PLAN: 'paid', SPOOL_MODE: 'off' }]
		] as const) {
			resetPlanMemo();
			const page = await through(`/off-${label.replaceAll(' ', '-')}`, overrides);
			expect(page.body, label).not.toContain('data-spool-client');
			resetPlanMemo();
			const sw = await through('/spool-sw.js', overrides);
			// not answered by spool: it fell through to the page pipeline, so it is a page
			// (an earlier arm may have left it in the edge cache, which is why the object count
			// is not asserted)
			expect(sw.res.headers.get('content-type') ?? '', label).toMatch(/text\/html/);
			expect(sw.body, label).toContain('rendered');
		}
	});

	it('adds the client tag to an anonymous page and nothing else about its body', async () => {
		const { res, body, asked } = await through('/shadow-page', {
			PLAN: 'paid',
			SPOOL_MODE: 'shadow'
		});
		expect(res.status).toBe(200);
		expect(body).toContain('data-spool-client');
		expect(body).toContain('rendered');
		// the generation rode in on the page response, so decorating cost no object request
		expect(asked.filter((entry) => entry.startsWith('/__spool'))).toEqual([]);
	});

	it('does not decorate a request that carries a cookie, or a response that is not a page', async () => {
		const withCookie = await through(
			'/shadow-cookie',
			{ PLAN: 'paid', SPOOL_MODE: 'shadow' },
			{ headers: { cookie: 'SESS0123=abc' } }
		);
		expect(withCookie.body).not.toContain('data-spool-client');
		resetPlanMemo();
		const post = await through(
			'/shadow-post',
			{ PLAN: 'paid', SPOOL_MODE: 'shadow' },
			{
				method: 'POST',
				body: 'a=1',
				headers: { 'content-type': 'application/x-www-form-urlencoded' }
			}
		);
		expect(post.body).not.toContain('data-spool-client');
	});

	it('answers the worker script itself, with no object request', async () => {
		const { res, body, asked } = await through('/spool-sw.js', {
			PLAN: 'paid',
			SPOOL_MODE: 'shadow'
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/javascript/);
		expect(body.length).toBeGreaterThan(1_000);
		expect(asked).toEqual([]);
	});

	it('asks the object for the diff on a sync, and only then', async () => {
		const vector = { cursor: 9, changed: { 'node:1': 9 }, reset: false };
		const { res, body, asked } = await through(
			'/.spool/sync?from=5',
			{ PLAN: 'paid', SPOOL_MODE: 'shadow' },
			{},
			vector
		);
		expect(res.status).toBe(200);
		expect(asked).toEqual(['/__spool?op=diff&from=5']);
		expect(body).toContain('node:1');
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
			const { res, asked } = await through(
				'/.spool/beacon',
				{ PLAN: 'paid', SPOOL_MODE: 'shadow' },
				{ method: 'POST', body: JSON.stringify(batch) }
			);
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
		const shadow = { PLAN: 'paid', SPOOL_MODE: 'shadow' };
		const from = (address: string) => ({ headers: { 'cf-connecting-ip': address } });
		for (let i = 0; i < SPOOL_IP_LIMIT; i++) spoolAllowed('203.0.113.9', Date.now());
		const refused = await through('/.spool/sync?from=0', shadow, from('203.0.113.9'));
		expect(refused.res.status).toBe(429);
		expect(refused.res.headers.get('retry-after')).toBe('60');
		expect(refused.asked).toEqual([]);
		resetPlanMemo();
		const other = await through('/.spool/sync?from=0', shadow, from('203.0.113.10'));
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
			await through(
				'/.spool/beacon',
				{ PLAN: 'paid', SPOOL_MODE: 'shadow' },
				{ method: 'POST', body: JSON.stringify(batch) }
			);
			const line = String(lines.find((args) => args[0] === 'cfw-spool')?.[1]);
			expect(line).not.toMatch(/[\r\n]/);
			expect(JSON.parse(line).body.length).toBeLessThanOrEqual(1024);
		} finally {
			log.mockRestore();
		}
	});

	it('loads an artifact through the same pipeline a visitor takes', async () => {
		const batch = { protocol: 1, events: [], want: ['/shadow-artifact'] };
		const { res, body, asked } = await through(
			'/.spool/beacon',
			{ PLAN: 'paid', SPOOL_MODE: 'shadow' },
			{ method: 'POST', body: JSON.stringify(batch) }
		);
		expect(res.status).toBe(200);
		// the page came from the object, and the cursor for its envelope came with it
		expect(asked.some((entry) => !entry.startsWith('/__spool'))).toBe(true);
		expect(body).toContain('/shadow-artifact');
	});

	it('answers a device that piggybacks a sync on a navigation, once per cursor and generation', async () => {
		resetSpoolMemo();
		const shadow = { PLAN: 'paid', SPOOL_MODE: 'shadow' };
		const device = { headers: { 'spool-vector-seen': '3' } };
		const vector = { cursor: 7, changed: { 'node:2': 7 }, reset: false };
		const first = await through('/piggyback-a', shadow, device, vector);
		resetPlanMemo();
		const second = await through('/piggyback-b', shadow, device, vector);
		expect(first.asked.filter((entry) => entry.startsWith('/__spool'))).toEqual([
			'/__spool?op=diff&from=3'
		]);
		// the same cursor at the same generation was answered from the isolate
		expect(second.asked.filter((entry) => entry.startsWith('/__spool'))).toEqual([]);
		expect(
			first.res.headers.get('spool-invalidate') ?? first.res.headers.get('spool-vector')
		).not.toBeNull();
	});

	it('keeps every spool path out of a redirect rule', async () => {
		const rules = JSON.stringify([{ from: '/.spool/*', to: '/elsewhere' }]);
		const { res } = await through('/.spool/sync?from=0', {
			PLAN: 'paid',
			SPOOL_MODE: 'shadow',
			REDIRECTS: rules
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('x-cfw-redirect')).toBeNull();
	});
});
