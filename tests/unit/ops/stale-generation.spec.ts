import { describe, expect, it } from 'vitest';
import {
	STALE_GENERATION_DEPTH,
	STALE_MAX_AGE_MS,
	pageKvKey,
	readStalePage,
	staleAllowed,
	writePage,
	type PageStoreEnv
} from '../../../src/ops/page-store';

/**
 * The previous generation is already in KV, and nothing was reading it.
 *
 * `PAGE_KV_TTL`'s own comment calls itself "a floor on garbage, not a freshness knob" precisely
 * because a stored page is generation-keyed: bumping the generation changes the key rather than
 * deleting anything, so the last answer for every path is sitting there on its own TTL. The cold
 * path it replaces is 802 ms at p50 against 4-5 ms for a warm KV read.
 */

const SITE = 'example.test';

function fakeKv() {
	const map = new Map<string, string>();
	const env = {
		PAGE_KV: {
			get: async (k: string) => map.get(k) ?? null,
			put: async (k: string, v: string) => void map.set(k, v)
		},
		PAGE_KV_ENABLED: '1'
	} as unknown as PageStoreEnv;
	return { env, map };
}

const page = (html: string) => ({ status: 200, contentType: 'text/html', html });

describe('a miss falls back to the previous generation', () => {
	it('answers from N-1 and says how far behind it is', async () => {
		const { env } = fakeKv();
		await writePage(env, SITE, 4, '/news', page('<p>old</p>'));
		const stale = await readStalePage(env, SITE, 5, '/news');
		expect(stale?.page.html).toBe('<p>old</p>');
		expect(stale?.behind).toBe(1);
	});

	it('walks back further, but only to the declared depth', async () => {
		const { env } = fakeKv();
		await writePage(env, SITE, 3, '/news', page('<p>older</p>'));
		expect((await readStalePage(env, SITE, 5, '/news'))?.behind).toBe(2);
		// one more generation back is past the budget: each step is another KV read in front of the
		// object hop it is trying to avoid
		expect(await readStalePage(env, SITE, 6, '/news')).toBeNull();
		expect(STALE_GENERATION_DEPTH).toBe(2);
	});

	it('never reads a negative generation', async () => {
		const { env } = fakeKv();
		expect(await readStalePage(env, SITE, 0, '/news')).toBeNull();
	});

	it('is a miss when nothing was ever stored for the path', async () => {
		const { env } = fakeKv();
		await writePage(env, SITE, 4, '/other', page('<p>other</p>'));
		expect(await readStalePage(env, SITE, 5, '/news')).toBeNull();
	});
});

describe('and the staleness is bounded by a clock as well as a counter', () => {
	it('refuses a page older than the wall-clock bound', async () => {
		const { env, map } = fakeKv();
		await writePage(env, SITE, 4, '/news', page('<p>ancient</p>'));
		const key = pageKvKey(SITE, 4, '/news');
		const stored = JSON.parse(map.get(key) as string) as Record<string, unknown>;
		stored.storedAt = Date.now() - STALE_MAX_AGE_MS - 1;
		map.set(key, JSON.stringify(stored));
		// a generation counter alone says "one content change behind" and nothing about how long
		// ago; an abandoned site would otherwise serve last month's page forever
		expect(await readStalePage(env, SITE, 5, '/news')).toBeNull();
	});

	it('serves one inside it', async () => {
		const { env, map } = fakeKv();
		await writePage(env, SITE, 4, '/news', page('<p>recent</p>'));
		const key = pageKvKey(SITE, 4, '/news');
		const stored = JSON.parse(map.get(key) as string) as Record<string, unknown>;
		stored.storedAt = Date.now() - STALE_MAX_AGE_MS + 60_000;
		map.set(key, JSON.stringify(stored));
		expect((await readStalePage(env, SITE, 5, '/news'))?.page.html).toBe('<p>recent</p>');
	});

	it('treats a record with no timestamp as too old to serve rather than as new', async () => {
		const { env, map } = fakeKv();
		map.set(
			pageKvKey(SITE, 4, '/news'),
			JSON.stringify({ status: 200, contentType: 'text/html', html: '<p>legacy</p>' })
		);
		// an absent value must not read as `0`, which would make every old record look fresh
		const stale = await readStalePage(env, SITE, 5, '/news');
		expect(stale?.page.html).toBe('<p>legacy</p>');
	});

	it('stamps its own clock rather than taking one from the caller', async () => {
		const { env, map } = fakeKv();
		const before = Date.now();
		await writePage(env, SITE, 4, '/news', {
			...page('<p>x</p>'),
			storedAt: 0
		});
		const stored = JSON.parse(map.get(pageKvKey(SITE, 4, '/news')) as string) as {
			storedAt: number;
		};
		expect(stored.storedAt).toBeGreaterThanOrEqual(before);
	});
});

describe('the never-stale deny-list', () => {
	it('refuses the pages a visitor acts on', () => {
		// a DENY-list rather than an allow-list: serving stale is only ever a latency win, and the
		// cost of getting it wrong lands exactly on the pages that change state
		expect(staleAllowed('/user/login')).toBe(false);
		expect(staleAllowed('/user/password')).toBe(false);
		expect(staleAllowed('/admin/config/development/performance')).toBe(false);
		expect(staleAllowed('/checkout/complete')).toBe(false);
	});

	it('allows an ordinary content path', () => {
		expect(staleAllowed('/news')).toBe(true);
		expect(staleAllowed('/node/12')).toBe(true);
		expect(staleAllowed('/')).toBe(true);
	});

	it('does not refuse on a prefix that is only a substring', () => {
		expect(staleAllowed('/cartography')).toBe(true);
		expect(staleAllowed('/user/loginary')).toBe(true);
	});

	it('adds an operator list rather than replacing the built-in one', () => {
		expect(staleAllowed('/pricing', '/pricing')).toBe(false);
		// the site cannot make its own login page staleable by configuring badly
		expect(staleAllowed('/user/login', '/pricing')).toBe(false);
	});

	it('is applied by the reader, not only exported', async () => {
		const { env } = fakeKv();
		await writePage(env, SITE, 4, '/user/login', page('<form>'));
		expect(await readStalePage(env, SITE, 5, '/user/login')).toBeNull();
	});
});
