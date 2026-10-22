import { beforeEach, describe, expect, it } from 'vitest';
import {
	lookupPageMemo,
	PAGE_MEMO_BYTES,
	pageMemoStats,
	resetPageMemo
} from '../../../src/ops/page-memo';
import { pageKvKey, type PageKv } from '../../../src/ops/page-store';
import { pageKeyUrl, putPage, writeGeneration } from '../../../src/site/edge-cache';
import { readEdgeTiers, readKvTier } from '../../../src/site/edge-read';
import { storeEdge } from '../../../src/site/edge-store';
import type { AuthState, FrontContext, Learned } from '../../../src/site/types';

const ORIGIN = 'https://front.test';
const PATH = '/about';
const auth = { personalised: false } as AuthState;

/** a `caches.default` that holds nothing, which is the colo the KV tier exists for */
const emptyCache = { match: async () => undefined, put: async () => undefined } as unknown as Cache;

function fakeKv(pages: Record<string, unknown>) {
	const reads: string[] = [];
	const kv: PageKv = {
		get: async (key) => {
			reads.push(key);
			return key in pages ? JSON.stringify(pages[key]) : null;
		},
		put: async () => undefined,
		delete: async () => undefined
	};
	return { kv, reads };
}

function context(site: string, kv: PageKv): FrontContext {
	return {
		env: { PAGE_KV: kv },
		url: new URL(`${ORIGIN}/serve?path=${PATH}`),
		t0: Date.now(),
		site,
		path: PATH,
		serving: true,
		cache: emptyCache,
		origin: ORIGIN,
		bucket: 1,
		defer: () => undefined,
		stubOf: () => ({ fetch: async () => new Response('') }) as unknown as DurableObjectStub
	} as unknown as FrontContext;
}

let n = 0;
const freshSite = () => `memo-fill-${++n}`;

describe('the KV tier and the isolate memo', () => {
	beforeEach(() => resetPageMemo());

	it('fills the memo on a fresh KV hit so the next view answers MEM with one KV read', async () => {
		const site = freshSite();
		const { kv, reads } = fakeKv({
			[pageKvKey(site, 7, PATH)]: {
				html: '<p>hello</p>',
				status: 200,
				contentType: 'text/html'
			}
		});
		const f = context(site, kv);
		await writeGeneration(emptyCache, ORIGIN, site, 1, 7);

		const first = await readKvTier(f, { wanted: true, generation: 7 });
		expect(first?.headers.get('x-cfw-cache')).toBe('KV');

		const second = await readEdgeTiers(f, auth);
		expect(second).toBeInstanceOf(Response);
		const res = second as Response;
		expect(res.headers.get('x-cfw-cache')).toBe('MEM');
		expect(res.headers.get('x-cfw-generation')).toBe('7');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('<p>hello</p>');
		expect(reads).toHaveLength(1);
	});

	it('does not answer a new generation from the old memo entry', async () => {
		const site = freshSite();
		const { kv, reads } = fakeKv({
			[pageKvKey(site, 7, PATH)]: { html: 'old', status: 200, contentType: 'text/html' },
			[pageKvKey(site, 8, PATH)]: { html: 'new', status: 200, contentType: 'text/html' }
		});
		const f = context(site, kv);
		await readKvTier(f, { wanted: true, generation: 7 });
		expect(lookupPageMemo(pageKeyUrl(ORIGIN, site, 8, PATH))).toBeUndefined();

		const res = await readKvTier(f, { wanted: true, generation: 8 });
		expect(await res?.text()).toBe('new');
		expect(reads).toHaveLength(2);
	});

	it('does not memoise a page served from a previous generation', async () => {
		const site = freshSite();
		const { kv } = fakeKv({
			[pageKvKey(site, 6, PATH)]: { html: 'behind', status: 200, contentType: 'text/html' }
		});
		const res = await readKvTier(context(site, kv), { wanted: true, generation: 7 });
		expect(res?.headers.get('x-cfw-edge')).toBe('STALE');
		expect(lookupPageMemo(pageKeyUrl(ORIGIN, site, 7, PATH))).toBeUndefined();
		expect(pageMemoStats().entries).toBe(0);
	});

	it('answers a body over the memo budget from KV and leaves the memo empty', async () => {
		const site = freshSite();
		const html = 'x'.repeat(PAGE_MEMO_BYTES + 1);
		const { kv } = fakeKv({
			[pageKvKey(site, 7, PATH)]: { html, status: 200, contentType: 'text/html' }
		});
		const res = await readKvTier(context(site, kv), { wanted: true, generation: 7 });
		expect(res?.headers.get('x-cfw-cache')).toBe('KV');
		expect((await res?.text())?.length).toBe(html.length);
		expect(pageMemoStats().entries).toBe(0);
	});
});

const POLICY = {
	'content-security-policy': "frame-ancestors 'none'",
	'x-frame-options': 'DENY'
};

/** a `caches.default` that answers the one page key with a stored response */
function cacheHolding(site: string, generation: number, stored: Response) {
	const key = pageKeyUrl(ORIGIN, site, generation, PATH);
	return {
		match: async (request: Request) => (request.url === key ? stored.clone() : undefined),
		put: async () => undefined
	} as unknown as Cache;
}

describe('the module-set headers ride every stored tier', () => {
	beforeEach(() => resetPageMemo());

	it('replays them from KV, and from the memo that KV fills', async () => {
		const site = freshSite();
		const { kv } = fakeKv({
			[pageKvKey(site, 7, PATH)]: {
				html: '<p>kv</p>',
				status: 200,
				contentType: 'text/html',
				headers: POLICY
			}
		});
		const f = context(site, kv);
		await writeGeneration(emptyCache, ORIGIN, site, 1, 7);

		const first = await readKvTier(f, { wanted: true, generation: 7 });
		expect(first?.headers.get('x-cfw-cache')).toBe('KV');
		expect(Object.fromEntries(first!.headers)).toMatchObject(POLICY);

		const memo = (await readEdgeTiers(f, auth)) as Response;
		expect(memo.headers.get('x-cfw-cache')).toBe('MEM');
		expect(Object.fromEntries(memo.headers)).toMatchObject(POLICY);
	});

	it('replays them on the STALE answer from a previous generation', async () => {
		const site = freshSite();
		const { kv } = fakeKv({
			[pageKvKey(site, 6, PATH)]: {
				html: 'behind',
				status: 200,
				contentType: 'text/html',
				headers: POLICY
			}
		});
		const res = await readKvTier(context(site, kv), { wanted: true, generation: 7 });
		expect(res?.headers.get('x-cfw-edge')).toBe('STALE');
		expect(Object.fromEntries(res!.headers)).toMatchObject(POLICY);
	});

	it('replays them from caches.default, and from the memo that fills', async () => {
		const site = freshSite();
		const f = {
			...context(site, fakeKv({}).kv),
			cache: cacheHolding(
				site,
				7,
				new Response('<p>edge</p>', {
					headers: {
						'content-type': 'text/html',
						'x-cfw-generation': '7',
						...POLICY
					}
				})
			)
		} as FrontContext;
		await writeGeneration(f.cache, ORIGIN, site, 1, 7);

		const edge = (await readEdgeTiers(f, auth)) as Response;
		expect(edge.headers.get('x-cfw-cache')).toBe('EDGE');
		expect(Object.fromEntries(edge.headers)).toMatchObject(POLICY);

		const memo = (await readEdgeTiers(f, auth)) as Response;
		expect(memo.headers.get('x-cfw-cache')).toBe('MEM');
		expect(Object.fromEntries(memo.headers)).toMatchObject(POLICY);
	});

	it('replays none for a page stored before headers existed, and does not throw', async () => {
		const site = freshSite();
		const { kv } = fakeKv({
			[pageKvKey(site, 7, PATH)]: { html: 'old', status: 200, contentType: 'text/html' }
		});
		const res = await readKvTier(context(site, kv), { wanted: true, generation: 7 });
		expect(res?.status).toBe(200);
		for (const name of Object.keys(POLICY)) expect(res?.headers.has(name)).toBe(false);
	});

	it('drops a hostile header from a KV document instead of replaying it', async () => {
		const site = freshSite();
		const { kv } = fakeKv({
			[pageKvKey(site, 7, PATH)]: {
				html: 'x',
				status: 200,
				contentType: 'text/html',
				headers: {
					'set-cookie': 'a=b',
					'content-security-policy': 'a\r\nb',
					'x-frame-options': 'DENY'
				}
			}
		});
		const res = await readKvTier(context(site, kv), { wanted: true, generation: 7 });
		expect(res?.headers.has('set-cookie')).toBe(false);
		expect(res?.headers.has('content-security-policy')).toBe(false);
		expect(res?.headers.get('x-frame-options')).toBe('DENY');
	});
});

describe('the module-set headers are stored with the page', () => {
	const rendered = () =>
		new Response('<p>page</p>', {
			headers: {
				'content-type': 'text/html',
				'x-cfw-kv-grant': '1',
				'x-powered-by': 'something',
				...POLICY
			}
		});

	it('copies them into the caches.default entry and leaves the rest out', async () => {
		const puts: Response[] = [];
		const cache = {
			put: async (_key: Request, value: Response) => {
				puts.push(value);
			}
		} as unknown as Cache;
		const out = putPage(cache, ORIGIN, 'put-site', PATH, rendered(), 7, 'HIT', false);
		await out.write;
		expect(puts).toHaveLength(1);
		expect(Object.fromEntries(puts[0]!.headers)).toMatchObject(POLICY);
		expect(puts[0]!.headers.has('x-powered-by')).toBe(false);
	});

	it('writes them into the KV document', async () => {
		const written: string[] = [];
		const kv: PageKv = {
			get: async () => null,
			put: async (_key, value) => {
				written.push(value);
			},
			delete: async () => undefined
		};
		const deferred: Promise<unknown>[] = [];
		const f = {
			...context('store-site', kv),
			cache: { put: async () => undefined } as unknown as Cache,
			defer: (p?: Promise<unknown>) => {
				if (p) deferred.push(p);
			}
		} as unknown as FrontContext;
		const stored = storeEdge(f, auth, rendered(), { doCache: 'HIT', generation: 7 } as Learned);
		await Promise.all(deferred);
		expect(stored.kvPut).toBe('deferred');
		expect(JSON.parse(written[0]!).headers).toEqual(POLICY);
	});
});
