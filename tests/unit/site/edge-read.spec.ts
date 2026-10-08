import { beforeEach, describe, expect, it } from 'vitest';
import {
	lookupPageMemo,
	PAGE_MEMO_BYTES,
	pageMemoStats,
	resetPageMemo
} from '../../../src/ops/page-memo';
import { pageKvKey, type PageKv } from '../../../src/ops/page-store';
import { pageKeyUrl, writeGeneration } from '../../../src/site/edge-cache';
import { readEdgeTiers, readKvTier } from '../../../src/site/edge-read';
import type { AuthState, FrontContext } from '../../../src/site/types';

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
