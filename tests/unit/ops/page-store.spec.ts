import { describe, expect, it } from 'vitest';
import {
	DEFAULT_PAGE_KV_TTL_SECONDS,
	KV_MIN_TTL_SECONDS,
	pageKvEnabled,
	pageKvKey,
	pageKvTtlSeconds,
	readPage,
	writePage,
	type PageKv,
	type PageStoreEnv
} from '../../../src/ops/page-store';
import { isFree, isPaid, planFlag } from '../../../src/ops/plan';

/**
 * The KV page tier, and the plan predicate it shares with the other two per-plan decisions.
 *
 * The tier is paid-only for a reason about METERS, not about generosity: the Durable Object's own
 * `cfw_page` table spends row writes, a budget measured here at 100,000/day, and the whole free-tier
 * design is engineered against it. KV spends a much smaller daily write allowance on free, so caching
 * every page there would trade a known-good limit for a tighter unmeasured one.
 *
 * Most of what follows asserts that the tier DECLINES: absent binding, free plan, non-200, empty body.
 * A cache that stores when it should not is worse than one that never stores, because a stored 503
 * "warming" placeholder is served globally for a day.
 */

/** an in-memory KV with the three methods the tier uses, plus a record of what it was asked to do */
function fakeKv(): PageKv & { store: Map<string, string>; puts: number; failNext?: boolean } {
	const store = new Map<string, string>();
	return {
		store,
		puts: 0,
		async get(key: string) {
			return store.get(key) ?? null;
		},
		async put(key: string, value: string) {
			if (this.failNext) throw new Error('KV unavailable');
			this.puts++;
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
		}
	};
}

const PAGE = { status: 200, contentType: 'text/html; charset=utf-8', html: '<html>hi</html>' };

describe('the plan predicate, extracted at its third use', () => {
	it('defaults to FREE for absent, empty and unrecognised values', () => {
		// free is the safe default because every limit in this project is a free limit: a typo in PLAN
		// must not hand a 10 ms budget the 30 s contract
		for (const plan of [undefined, null, '', 'Free', 'gibberish', 'PAID_TIER']) {
			expect(isPaid({ PLAN: plan as never }), String(plan)).toBe(false);
		}
	});

	it('recognises paid case-insensitively', () => {
		for (const plan of ['paid', 'PAID', 'Paid']) {
			expect(isPaid({ PLAN: plan }), plan).toBe(true);
		}
	});

	it('isFree is exactly the complement', () => {
		for (const plan of ['paid', 'free', '', undefined]) {
			expect(isFree({ PLAN: plan as never })).toBe(!isPaid({ PLAN: plan as never }));
		}
	});

	it('treats a present-but-EMPTY override as deferring, not as off', () => {
		// `?flag=` gives '' from searchParams, and reading that as an explicit "off" would let a stray
		// ampersand silently change behaviour
		expect(planFlag('', undefined, true, { PLAN: 'paid' })).toBe(true);
		expect(planFlag(undefined, '', true, { PLAN: 'paid' })).toBe(true);
	});

	it('honours the most specific signal first', () => {
		expect(planFlag('0', '1', true, { PLAN: 'paid' })).toBe(false);
		expect(planFlag(undefined, '0', true, { PLAN: 'paid' })).toBe(false);
		expect(planFlag(undefined, undefined, true, { PLAN: 'paid' })).toBe(true);
		expect(planFlag(undefined, undefined, true, { PLAN: 'free' })).toBe(false);
	});
});

describe('the tier is OFF unless the plan and the binding both say yes', () => {
	it('is off with no binding, whatever the plan says', () => {
		expect(pageKvEnabled({ PLAN: 'paid' })).toBe(false);
		expect(pageKvEnabled({ PLAN: 'paid', PAGE_KV: null })).toBe(false);
	});

	it('is off on free even with a binding', () => {
		expect(pageKvEnabled({ PLAN: 'free', PAGE_KV: fakeKv() })).toBe(false);
	});

	it('is on for paid with a binding', () => {
		expect(pageKvEnabled({ PLAN: 'paid', PAGE_KV: fakeKv() })).toBe(true);
	});

	it('lets an explicit flag override the plan in both directions', () => {
		const kv = fakeKv();
		expect(pageKvEnabled({ PLAN: 'free', PAGE_KV: kv, PAGE_KV_ENABLED: '1' })).toBe(true);
		expect(pageKvEnabled({ PLAN: 'paid', PAGE_KV: kv, PAGE_KV_ENABLED: '0' })).toBe(false);
	});

	it('a missing binding beats an explicit ON, because that is a config error not a request', () => {
		expect(pageKvEnabled({ PLAN: 'free', PAGE_KV_ENABLED: '1' })).toBe(false);
	});
});

describe('the key carries the generation, which is what makes invalidation free', () => {
	it('changes wholesale when the generation changes', () => {
		// KV has no bulk delete, so a scheme needing enumeration would be uninvalidatable in practice
		expect(pageKvKey('s', 1, '/')).not.toBe(pageKvKey('s', 2, '/'));
	});

	it('separates sites and paths', () => {
		expect(pageKvKey('a', 1, '/')).not.toBe(pageKvKey('b', 1, '/'));
		expect(pageKvKey('a', 1, '/x')).not.toBe(pageKvKey('a', 1, '/y'));
	});
});

describe('the TTL is floored at what KV will accept', () => {
	it('defaults to a day', () => {
		expect(pageKvTtlSeconds({})).toBe(DEFAULT_PAGE_KV_TTL_SECONDS);
	});

	it('floors a too-small value instead of letting the write be rejected', () => {
		// KV rejects a sub-minimum TTL rather than clamping it, so an unclamped 5 would fail every put
		expect(pageKvTtlSeconds({ PAGE_KV_TTL: 5 })).toBe(KV_MIN_TTL_SECONDS);
	});

	it('treats junk and non-positive values as unset', () => {
		for (const ttl of ['abc', 0, -1, '']) {
			expect(pageKvTtlSeconds({ PAGE_KV_TTL: ttl as never }), String(ttl)).toBe(
				DEFAULT_PAGE_KV_TTL_SECONDS
			);
		}
	});
});

describe('reads and writes, including everything it refuses to store', () => {
	const paid = (kv: PageKv): PageStoreEnv => ({ PLAN: 'paid', PAGE_KV: kv });

	it('round-trips a page', async () => {
		const kv = fakeKv();
		expect(await writePage(paid(kv), 's', 7, '/', PAGE)).toBe(true);
		expect(await readPage(paid(kv), 's', 7, '/')).toEqual(PAGE);
	});

	it('misses on a different generation rather than serving a stale page', async () => {
		const kv = fakeKv();
		await writePage(paid(kv), 's', 7, '/', PAGE);
		expect(await readPage(paid(kv), 's', 8, '/')).toBeNull();
	});

	it('REFUSES a non-200, so a 503 warming placeholder is never cached globally', async () => {
		const kv = fakeKv();
		const placeholder = { status: 503, contentType: 'text/html', html: 'warming' };
		expect(await writePage(paid(kv), 's', 7, '/', placeholder)).toBe(false);
		expect(kv.puts).toBe(0);
	});

	it('refuses an empty body', async () => {
		const kv = fakeKv();
		expect(await writePage(paid(kv), 's', 7, '/', { ...PAGE, html: '' })).toBe(false);
		expect(kv.puts).toBe(0);
	});

	it('writes nothing at all on free', async () => {
		const kv = fakeKv();
		expect(await writePage({ PLAN: 'free', PAGE_KV: kv }, 's', 7, '/', PAGE)).toBe(false);
		expect(kv.puts).toBe(0);
	});

	it('treats a KV failure as a miss on read and a false on write, never a throw', async () => {
		// the serving path has a working fallback one tier down; a 500 there would be self-inflicted
		const kv = fakeKv();
		kv.failNext = true;
		await expect(writePage(paid(kv), 's', 7, '/', PAGE)).resolves.toBe(false);

		const broken: PageKv = {
			async get() {
				throw new Error('KV unavailable');
			},
			async put() {},
			async delete() {}
		};
		await expect(readPage(paid(broken), 's', 7, '/')).resolves.toBeNull();
	});

	it('treats an unparseable stored value as a miss', async () => {
		const kv = fakeKv();
		kv.store.set(pageKvKey('s', 7, '/'), 'not json');
		expect(await readPage(paid(kv), 's', 7, '/')).toBeNull();
	});

	it('treats a stored value without html as a miss rather than serving undefined', async () => {
		const kv = fakeKv();
		kv.store.set(pageKvKey('s', 7, '/'), JSON.stringify({ status: 200 }));
		expect(await readPage(paid(kv), 's', 7, '/')).toBeNull();
	});

	it('defaults a stored page missing its status and type rather than refusing it', async () => {
		const kv = fakeKv();
		kv.store.set(pageKvKey('s', 7, '/'), JSON.stringify({ html: '<p>x</p>' }));
		expect(await readPage(paid(kv), 's', 7, '/')).toEqual({
			status: 200,
			contentType: 'text/html; charset=utf-8',
			html: '<p>x</p>'
		});
	});
});
