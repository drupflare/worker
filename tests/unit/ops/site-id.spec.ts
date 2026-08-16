import { describe, expect, it } from 'vitest';
import {
	FALLBACK_SITE,
	resolveSite,
	siteFromHost,
	siteKvKey,
	type SiteIdEnv
} from '../../../src/ops/site-id';

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
		expect(siteFromHost('example.com')).toBe('example-com');
		expect(siteFromHost('blog.example.co.uk')).toBe('blog-example-co-uk');
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
		expect(siteFromHost('example.com:443', 'https:')).toBe('example-com');
		expect(siteFromHost('example.com:80', 'http:')).toBe('example-com');
	});

	it('keeps a non-default port, because two dev servers on one box are two sites', () => {
		expect(siteFromHost('example.com:8080', 'https:')).toBe('example-com-8080');
		expect(siteFromHost('example.com:443', 'http:')).toBe('example-com-443');
	});

	it('produces an id usable as a Durable Object name', () => {
		expect(siteFromHost('xn--bcher-kva.example.com')).toMatch(/^[a-z0-9-]+$/);
		expect(siteFromHost('under_score.example.com')).toMatch(/^[a-z0-9-]+$/);
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
		).toEqual({ site: 'customer-a-example', from: 'host' });
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
		).toEqual({ site: 'example-com', from: 'host' });
	});

	it('falls back to the literal on a host that names no site', async () => {
		// this is every local `wrangler dev`, and it must land on the object a bare /serve uses
		expect(await resolveSite(at('http://localhost:8787/'), {})).toEqual({
			site: FALLBACK_SITE,
			from: 'fallback'
		});
	});

	it('keeps the derived layer reachable, so the optional ones are genuinely optional', async () => {
		// the ordering trap: derivation answers for every real host, so putting it above KV or the
		// var makes both unreachable on exactly the hosts they exist to configure
		const derived = await resolveSite(at('https://example.com/'), undefined);
		expect(derived.from).toBe('host');
		expect(derived.site).toBe('example-com');
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
			site: 'example-com'
		});
	});
});
