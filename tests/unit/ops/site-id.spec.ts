import { beforeEach, describe, expect, it } from 'vitest';
import { KV_OVERRIDABLE } from '../../../src/ops/plan';
import {
	FALLBACK_SITE,
	HOST_MEMO_MS,
	locationHint,
	resetHostMemo,
	resolveSite,
	siteFromHost,
	siteKvKey,
	siteStubOptions,
	type SiteIdEnv
} from '../../../src/ops/site-id';

// the host mapping is memoised per isolate, so a spec that did not reset it would read the
// previous spec's mapping for the same host
beforeEach(resetHostMemo);

/**
 * Which site a request belongs to, when the caller did not say.
 *
 * A wrong answer here is not an error: one object per site, the object's NAME is the identity, so a
 * mis-resolved request is served from a DIFFERENT SITE'S DATABASE and looks entirely normal. That is
 * why the layer that decided is part of the return value and is asserted on every case below.
 */

const kvWith = (entries: Record<string, string>): SiteIdEnv['CONFIG_KV'] => ({
	get: async (key: string) => entries[key] ?? null
});

describe('deriving a site from the request host', () => {
	it('takes a plain domain', () => {
		expect(siteFromHost('example.com')).toBe('example.com');
		expect(siteFromHost('blog.example.co.uk')).toBe('blog.example.co.uk');
	});

	it('is case-insensitive, because a host is', () => {
		expect(siteFromHost('EXAMPLE.com')).toBe(siteFromHost('example.com'));
	});

	it('names no site for a local host', () => {
		// a site called `localhost` is a real object holding real data whose name means nothing, and
		// every developer on every machine would share it
		for (const host of ['localhost', 'localhost:8787', '127.0.0.1:8787', '[::1]:8787']) {
			expect(siteFromHost(host), host).toBeNull();
		}
	});

	it('ignores a default port, so a proxy rewriting the URL cannot split a site in two', () => {
		expect(siteFromHost('example.com:443', 'https:')).toBe('example.com');
		expect(siteFromHost('example.com:80', 'http:')).toBe('example.com');
	});

	it('keeps a non-default port, because two dev servers on one box are two sites', () => {
		expect(siteFromHost('example.com:8080', 'https:')).toBe('example.com_3a8080');
		expect(siteFromHost('example.com:443', 'http:')).toBe('example.com_3a443');
	});

	it('produces an id usable as a Durable Object name', () => {
		expect(siteFromHost('xn--bcher-kva.example.com')).toMatch(/^[a-z0-9._-]+$/);
		expect(siteFromHost('under_score.example.com')).toMatch(/^[a-z0-9._-]+$/);
	});

	/**
	 * ONE HOST, ONE ID, AND NO TWO HOSTS SHARING ONE.
	 *
	 * `[^a-z0-9]+` collapsing to a dash made every pair below the same id, and a site id IS the
	 * Durable Object's name -- so two unrelated hostnames pointed at one deployment shared one
	 * database and served each other's pages.
	 */
	it.each([
		['a.b.example.com', 'a-b.example.com'],
		['a.b.example.com', 'a_b.example.com'],
		['a-b.example.com', 'a_b.example.com'],
		['x.example.com', 'x..example.com'],
		['example.com', 'example.com:8080']
	])('gives %s and %s different ids', (left, right) => {
		expect(siteFromHost(left)).not.toBe(siteFromHost(right));
	});

	/**
	 * `_` is the escape, so it cannot also be a literal, or the escaping is not a bijection: an
	 * `_3a` a visitor put in a hostname would decode as the `:` this produces for a port.
	 */
	it('escapes rather than passes through anything outside the kept set', () => {
		expect(siteFromHost('under_score.example.com')).toBe('under_5fscore.example.com');
		expect(siteFromHost('a_5f.example.com')).not.toBe(siteFromHost('a_.example.com'));
	});

	it('keeps the two characters a hostname is actually made of', () => {
		expect(siteFromHost('a-b.c-d.example.com')).toBe('a-b.c-d.example.com');
	});

	it('answers null rather than an empty name for a host that is not one', () => {
		expect(siteFromHost('')).toBeNull();
		expect(siteFromHost('   ')).toBeNull();
	});
});

describe('the resolution order, which follows from which layers can be absent', () => {
	const at = (href: string) => new URL(href);

	it('takes an explicit ?site= over everything', async () => {
		const env: SiteIdEnv = { CONFIG_KV: kvWith({}), SITE_ID: 'from-var' };
		expect(await resolveSite(at('https://example.com/serve?site=asked'), env)).toEqual({
			site: 'asked',
			from: 'param'
		});
	});

	it("refuses ?site= when the query string is the visitor's, not ours", async () => {
		// CROSS-SITE SERVING. The catch-all resolves the URL a visitor typed, so a link to
		// `https://customer-a.example/about?site=customer-b` would otherwise pick customer B's
		// object and serve their database from customer A's hostname. The rewrite is built from the
		// origin, which keeps the parameter out of /serve's own arguments and does nothing at all
		// about which object answers -- this is the half that does
		const env: SiteIdEnv = { CONFIG_KV: kvWith({}) };
		expect(
			await resolveSite(at('https://customer-a.example/about?site=customer-b'), env, {
				allowParam: false
			})
		).toEqual({ site: 'customer-a.example', from: 'host' });
	});

	it('still refuses it when every other layer is absent, rather than falling back to it', async () => {
		expect(
			await resolveSite(
				at('http://localhost:8787/about?site=elsewhere'),
				{},
				{ allowParam: false }
			)
		).toEqual({ site: FALLBACK_SITE, from: 'fallback' });
	});

	it('honours the parameter by default, which is what /serve means by it', async () => {
		// the option is opt-OUT: a caller that built the URL itself keeps the layer
		expect(await resolveSite(at('https://example.com/serve?site=asked'), {}, {})).toEqual({
			site: 'asked',
			from: 'param'
		});
	});

	it('takes KV first, so a site can be re-pointed without a redeploy', async () => {
		const env: SiteIdEnv = {
			CONFIG_KV: kvWith({ [siteKvKey('example.com')]: 'mapped' }),
			SITE_ID: 'from-var'
		};
		expect(await resolveSite(at('https://example.com/about'), env)).toEqual({
			site: 'mapped',
			from: 'kv'
		});
	});

	it('takes the var next, over the host it could have derived', async () => {
		const env: SiteIdEnv = { CONFIG_KV: kvWith({}), SITE_ID: 'from-var' };
		expect(await resolveSite(at('https://example.com/about'), env)).toEqual({
			site: 'from-var',
			from: 'var'
		});
	});

	it('derives from the host when neither optional layer answers', async () => {
		expect(
			await resolveSite(at('https://example.com/about'), { CONFIG_KV: kvWith({}) })
		).toEqual({ site: 'example.com', from: 'host' });
	});

	it('falls back to the literal on a host that names no site', async () => {
		// this is every local `wrangler dev`, and it must land on the object a bare /serve uses
		expect(await resolveSite(at('http://localhost:8787/'), {})).toEqual({
			site: FALLBACK_SITE,
			from: 'fallback'
		});
	});

	it('keeps the derived layer reachable, so the optional ones stay optional', async () => {
		// the ordering trap: derivation answers for every real host, so putting it above KV or the
		// var makes both unreachable on exactly the hosts they exist to configure
		const derived = await resolveSite(at('https://example.com/'), undefined);
		expect(derived.from).toBe('host');
		expect(derived.site).toBe('example.com');
	});
});

describe('a KV miss or outage must not take the site down', () => {
	it('falls through when the host is not mapped', async () => {
		const env: SiteIdEnv = { CONFIG_KV: kvWith({ [siteKvKey('other.com')]: 'other' }) };
		expect(await resolveSite(new URL('https://example.com/'), env)).toMatchObject({
			from: 'host'
		});
	});

	it('falls through when KV throws, rather than propagating', async () => {
		const env: SiteIdEnv = {
			CONFIG_KV: {
				get: async () => {
					throw new Error('KV is having a day');
				}
			},
			SITE_ID: 'from-var'
		};
		expect(await resolveSite(new URL('https://example.com/'), env)).toEqual({
			site: 'from-var',
			from: 'var'
		});
	});

	it('ignores a blank mapping, which is a deleted key rather than a site named ""', async () => {
		const env: SiteIdEnv = { CONFIG_KV: kvWith({ [siteKvKey('example.com')]: '   ' }) };
		expect(await resolveSite(new URL('https://example.com/'), env)).toMatchObject({
			from: 'host'
		});
	});

	it('resolves with no bindings at all', async () => {
		expect(await resolveSite(new URL('https://example.com/'), undefined)).toMatchObject({
			site: 'example.com'
		});
	});
});

/**
 * The host mapping is read from KV at most once per host per minute.
 *
 * MEASURED, and the number is why this exists: one `CONFIG_KV.get()` costs 4 ms at the median on a
 * deployed worker, and a production page request made TWO for the same host -- once in the catch-all
 * rewrite, again in `siteFor()` -- for 8.5 ms before any other tier was consulted. `param` and
 * `nokv` both read 0, which is the shape every measurement deploy in this repo used, so no arm had
 * ever priced the one that ships.
 */
describe('the host mapping is read once, not once per call site', () => {
	/** counts reads so a memo hit is distinguishable from a second read returning the same answer */
	const counting = (entries: Record<string, string>) => {
		const state = { reads: 0 };
		return {
			state,
			kv: {
				get: async (key: string) => {
					state.reads++;
					return entries[key] ?? null;
				}
			}
		};
	};

	it('reads KV once for two resolutions of the same host', async () => {
		const { state, kv } = counting({ [siteKvKey('example.com')]: 'mapped' });
		const env: SiteIdEnv = { CONFIG_KV: kv };
		const a = await resolveSite(new URL('https://example.com/about'), env, {
			allowParam: false
		});
		const b = await resolveSite(new URL('https://example.com/serve'), env, {
			allowParam: false
		});
		expect(a).toEqual({ site: 'mapped', from: 'kv' });
		expect(b).toEqual({ site: 'mapped', from: 'kv' });
		expect(state.reads).toBe(1);
	});

	// the unmapped host is the common case AND the expensive one; a memo that only held hits
	// would leave every default deployment paying both reads
	it('memoises the absence of a mapping too', async () => {
		const { state, kv } = counting({});
		const env: SiteIdEnv = { CONFIG_KV: kv };
		expect(await resolveSite(new URL('https://example.com/a'), env)).toMatchObject({
			from: 'host'
		});
		expect(await resolveSite(new URL('https://example.com/b'), env)).toMatchObject({
			from: 'host'
		});
		expect(state.reads).toBe(1);
	});

	it("keeps one host out of another host's answer", async () => {
		const { state, kv } = counting({
			[siteKvKey('a.example')]: 'site-a',
			[siteKvKey('b.example')]: 'site-b'
		});
		const env: SiteIdEnv = { CONFIG_KV: kv };
		expect((await resolveSite(new URL('https://a.example/'), env)).site).toBe('site-a');
		expect((await resolveSite(new URL('https://b.example/'), env)).site).toBe('site-b');
		expect(state.reads).toBe(2);
	});

	it('re-reads once the entry is older than the memo window', async () => {
		const entries: Record<string, string> = { [siteKvKey('example.com')]: 'first' };
		const { state, kv } = counting(entries);
		const env: SiteIdEnv = { CONFIG_KV: kv };
		expect((await resolveSite(new URL('https://example.com/'), env, {}, 1_000)).site).toBe(
			'first'
		);
		entries[siteKvKey('example.com')] = 'second';
		expect((await resolveSite(new URL('https://example.com/'), env, {}, 1_500)).site).toBe(
			'first'
		);
		expect(
			(await resolveSite(new URL('https://example.com/'), env, {}, 1_000 + HOST_MEMO_MS)).site
		).toBe('second');
		expect(state.reads).toBe(2);
	});

	// a blip must cost the next request a retry, not pin derivation for a minute
	it('does not memoise a read that threw', async () => {
		let reads = 0;
		let failing = true;
		const env: SiteIdEnv = {
			CONFIG_KV: {
				get: async () => {
					reads++;
					if (failing) throw new Error('KV is having a day');
					return 'recovered';
				}
			}
		};
		expect((await resolveSite(new URL('https://example.com/'), env)).from).toBe('host');
		failing = false;
		expect(await resolveSite(new URL('https://example.com/'), env)).toEqual({
			site: 'recovered',
			from: 'kv'
		});
		expect(reads).toBe(2);
	});

	// `?site=` is answered above the memo, so a diagnostic call still costs no read at all
	it('reads nothing when the parameter names the site', async () => {
		const { state, kv } = counting({ [siteKvKey('example.com')]: 'mapped' });
		const env: SiteIdEnv = { CONFIG_KV: kv };
		expect(await resolveSite(new URL('https://example.com/serve?site=asked'), env)).toEqual({
			site: 'asked',
			from: 'param'
		});
		expect(state.reads).toBe(0);
	});
});

/**
 * Where a site's Durable Object is created.
 *
 * **UNSET IS THE DEFAULT AND IT IS THE PRODUCT DECISION**, taken 2026-08-18: placement follows the
 * first request, because guessing a region trades latency for one audience against latency for
 * every other and a one-click product has no way to ask. An owner who knows their audience pins it.
 *
 * The value is on `KV_OVERRIDABLE`, which is the convention rather than a special case: **anything
 * offered as a var is offered as KV first**, so it can be changed without a redeploy. What is
 * asserted here is the half that would silently break a site - an unrecognised value must be
 * IGNORED rather than passed through, because this reaches `SITE.get()` on the serving path.
 */
describe('the durable object location hint', () => {
	it('is undefined when unset, which is the shipped default', () => {
		expect(locationHint()).toBeUndefined();
		expect(locationHint({})).toBeUndefined();
		expect(locationHint({ SITE_LOCATION_HINT: '' })).toBeUndefined();
		expect(locationHint({ SITE_LOCATION_HINT: null })).toBeUndefined();
	});

	it('accepts every region Cloudflare names', () => {
		for (const hint of ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me']) {
			expect(locationHint({ SITE_LOCATION_HINT: hint })).toBe(hint);
		}
	});

	it('is case- and whitespace-insensitive, because a KV value is typed by hand', () => {
		expect(locationHint({ SITE_LOCATION_HINT: '  WEUR ' })).toBe('weur');
	});

	// the failure that matters: this reaches SITE.get() on every request, so a typo the platform
	// rejects would take the site down for the sake of a latency preference
	it('IGNORES an unrecognised value rather than passing it through', () => {
		expect(locationHint({ SITE_LOCATION_HINT: 'europe' })).toBeUndefined();
		expect(locationHint({ SITE_LOCATION_HINT: 'us-east-1' })).toBeUndefined();
		expect(locationHint({ SITE_LOCATION_HINT: 'wnam,weur' })).toBeUndefined();
	});

	/**
	 * `{ locationHint: undefined }` is not the same as passing nothing to a runtime that checks for
	 * the key rather than its value, which is why the options bag is built rather than inlined.
	 */
	it('passes no options bag at all when there is no hint', () => {
		expect(siteStubOptions()).toBeUndefined();
		expect(siteStubOptions({ SITE_LOCATION_HINT: 'nonsense' })).toBeUndefined();
		expect(siteStubOptions({ SITE_LOCATION_HINT: 'apac' })).toEqual({ locationHint: 'apac' });
	});
});

describe('the KV-over-var convention', () => {
	// stated as a test because it is a convention, and a convention with no check is a preference:
	// anything offered as a lever is offered through KV first, so it changes without a redeploy
	it('lists the location hint as KV-overridable', () => {
		expect(KV_OVERRIDABLE).toContain('SITE_LOCATION_HINT');
	});

	// the allow-list is a privilege boundary: nothing on it may change what is REACHABLE
	it('still admits nothing that changes what is reachable', () => {
		expect(KV_OVERRIDABLE).not.toContain('PW_DIAGNOSTICS');
		expect(KV_OVERRIDABLE).not.toContain('SITE_ID');
		expect(KV_OVERRIDABLE).not.toContain('PLAN');
	});
});
