import { describe, expect, it } from 'vitest';
import {
	fetchGuarded,
	outboundGuardEnabled,
	RedirectRefused,
	refuseOutbound
} from '../../../src/ops/outbound-guard';

describe('what PHP may make the Worker fetch', () => {
	it.each([
		'https://updates.drupal.org/release-history/drupal/11.x',
		'https://accounts.google.com/.well-known/openid-configuration',
		'https://www.google.com/recaptcha/api/siteverify',
		'http://example.com/webhook',
		'https://example.com:8443/hook',
		'https://8.8.8.8/',
		// PUBLIC v6, which nothing asserted: without it every v6 case in the table below could
		// pass on a guard that refused the whole family
		'https://[2001:4860:4860::8888]/',
		'https://[2606:4700:4700::1111]/dns-query',
		// a v4-mapped PUBLIC address, so the unmapping is proved to be reading the address rather
		// than refusing the form
		'https://[::ffff:8.8.8.8]/',
		// 172 outside 16-31 is public, which is the pair of bounds most likely to be written as
		// a whole-/8 refusal by mistake
		'https://172.15.0.1/',
		'https://172.32.0.1/',
		// 100 outside 64-127 is public too
		'https://100.63.0.1/',
		'https://100.128.0.1/',
		// 223 is the last unicast /8; 224 begins multicast
		'https://223.255.255.255/',
		// a trailing dot on a public name, and a v6 prefix next to the refused ones
		'https://example.com./',
		'https://[64:ff9a::1]/',
		'https://[fe00::1]/'
	])('allows %s', (url) => {
		expect(refuseOutbound(url)).toBeUndefined();
	});

	it.each([
		['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
		['the whole link-local block', 'https://169.254.1.1/'],
		['loopback', 'http://127.0.0.1:8080/admin'],
		['loopback by name', 'http://localhost/admin'],
		['a 10/8 host', 'http://10.0.0.5/'],
		['a 172.16/12 host', 'http://172.20.1.1/'],
		['a 192.168/16 host', 'http://192.168.1.1/'],
		['carrier-grade NAT', 'http://100.100.0.1/'],
		['0/8', 'http://0.0.0.0/'],
		['IPv6 loopback', 'http://[::1]/'],
		['IPv6 unique-local', 'http://[fd00::1]/'],
		['IPv6 link-local', 'http://[fe80::1]/'],
		['a v4 literal smuggled through v6', 'http://[::ffff:169.254.169.254]/'],
		['google metadata by name', 'http://metadata.google.internal/'],
		// a trailing dot is a fully qualified name that resolves like the bare one
		['a trailing-dot localhost', 'http://localhost./admin'],
		['a trailing-dot metadata name', 'http://metadata.google.internal./computeMetadata/v1/'],
		['a trailing-dot suffix', 'https://vault.internal./v1/secret'],
		// the URL parser rewrites these to 127.0.0.1 before the guard sees them
		['a decimal v4 loopback', 'http://2130706433/'],
		['an octal v4 loopback', 'http://0177.0.0.1/'],
		['a hex v4 loopback', 'http://0x7f.1/'],
		['a dotted loopback with a trailing dot', 'http://127.0.0.1./'],
		['a decimal metadata address', 'http://2852039166/latest/meta-data/'],
		// NAT64 carries the v4 address inside the v6 one
		['NAT64 holding the metadata address', 'http://[64:ff9b::a9fe:a9fe]/'],
		['NAT64 holding loopback', 'http://[64:ff9b::7f00:1]/'],
		['NAT64 local-use', 'http://[64:ff9b:1::1]/'],
		['IPv6 site-local', 'http://[fec0::1]/'],
		['IPv6 multicast', 'http://[ff02::1]/'],
		// userinfo: the guard refuses credentials before it reads the host
		['userinfo hiding the real host', 'http://169.254.169.254@example.com/'],
		['userinfo in front of loopback', 'http://user@127.0.0.1/'],
		['an .internal suffix', 'https://vault.internal/v1/secret'],
		['an .local suffix', 'https://printer.local/'],
		['a file url', 'file:///etc/passwd'],
		['a gopher url', 'gopher://example.com/'],
		['credentials in the url', 'https://user:pass@example.com/'],
		['a password with no username', 'https://:pass@example.com/'],
		['nothing', ''],
		['whitespace only', '   '],
		// multicast and the reserved block above it; 255.255.255.255 is broadcast
		['multicast', 'http://224.0.0.1/'],
		['reserved space', 'http://240.0.0.1/'],
		['broadcast', 'http://255.255.255.255/'],
		// the unspecified v6 address, which resolves to the host on most stacks
		['the unspecified IPv6 address', 'http://[::]/'],
		// fd is the half of fc00::/7 in actual use, and fc is the other half
		['IPv6 fc00 half of unique-local', 'http://[fc00::1]/'],
		// fe80::/10 is fe8, fe9, fea and feb; only the first was in the table
		['IPv6 fe9 link-local', 'http://[fe9f::1]/'],
		['IPv6 feb link-local', 'http://[febf::1]/'],
		// `new URL()` NORMALISES a v4-mapped dotted form to hex, so the hex spelling is the one
		// that actually arrives and the dotted branch would never fire on a real request
		['a v4 literal mapped to hex', 'http://[::ffff:a9fe:a9fe]/'],
		['loopback mapped to hex', 'http://[::ffff:7f00:1]/'],
		// the schemes an SSRF reaches for when http is closed
		['a data url', 'data:text/plain,hello'],
		['a javascript url', 'javascript:fetch("/")'],
		['an ftp url', 'ftp://example.com/'],
		['a blob url', 'blob:https://example.com/x']
	])('refuses %s', (_label, url) => {
		const refusal = refuseOutbound(url);
		expect(refusal, `${url} was allowed`).toBeDefined();
		expect(refusal!.reason).not.toBe('');
	});

	it('refuses a string that is not a url at all', () => {
		expect(refuseOutbound('not a url')?.reason).toBe('not a url');
	});

	// the refusal carries the url back, so a drain report names what was refused rather than only
	// that something was
	it('names the url it refused, not just the reason', () => {
		expect(refuseOutbound('http://169.254.169.254/')?.url).toBe('http://169.254.169.254/');
		// trimmed, so a value that arrived with whitespace is reported as it was parsed
		expect(refuseOutbound('  http://127.0.0.1/  ')?.url).toBe('http://127.0.0.1/');
	});

	it('takes a null or undefined without throwing', () => {
		expect(refuseOutbound(null as unknown as string)?.reason).toBe('no url');
		expect(refuseOutbound(undefined as unknown as string)?.reason).toBe('no url');
	});

	it('is on unless explicitly 0', () => {
		expect(outboundGuardEnabled(undefined)).toBe(true);
		expect(outboundGuardEnabled({})).toBe(true);
		expect(outboundGuardEnabled({ OUTBOUND_GUARD: '1' })).toBe(true);
		expect(outboundGuardEnabled({ OUTBOUND_GUARD: '0' })).toBe(false);
	});
});

type Hop = { status: number; location?: string };

/** a fetch that answers each call from a script and records what it was asked */
function scripted(hops: Hop[]) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const doFetch = (async (url: string, init: RequestInit = {}) => {
		calls.push({ url, init });
		const hop = hops[calls.length - 1] ?? { status: 200 };
		return new Response(hop.status === 200 ? 'done' : null, {
			status: hop.status,
			headers: hop.location ? { location: hop.location } : {}
		});
	}) as unknown as typeof fetch;
	return { calls, doFetch };
}

describe('redirect targets are checked too', () => {
	it('answers a plain response with one call and no redirect following', async () => {
		const { calls, doFetch } = scripted([{ status: 200 }]);
		const res = await fetchGuarded(doFetch, 'https://a.test/', { method: 'GET' });
		expect(await res.text()).toBe('done');
		expect(calls).toHaveLength(1);
		expect(calls[0]!.init.redirect).toBe('manual');
	});

	it('follows an allowed hop, and a relative one against the current url', async () => {
		const { calls, doFetch } = scripted([
			{ status: 302, location: 'https://b.test/x' },
			{ status: 301, location: '/y?q=1' },
			{ status: 200 }
		]);
		const res = await fetchGuarded(doFetch, 'https://a.test/', {});
		expect(res.status).toBe(200);
		expect(calls.map((c) => c.url)).toEqual([
			'https://a.test/',
			'https://b.test/x',
			'https://b.test/y?q=1'
		]);
	});

	it.each([
		['the metadata address', 'http://169.254.169.254/latest/meta-data/'],
		['loopback', 'http://127.0.0.1:8080/admin'],
		['an internal name', 'http://db.internal/'],
		['a url with credentials', 'https://user:pass@c.test/']
	])('refuses a redirect to %s without fetching it', async (_label, to) => {
		const { calls, doFetch } = scripted([{ status: 302, location: to }]);
		await expect(fetchGuarded(doFetch, 'https://a.test/', {})).rejects.toBeInstanceOf(
			RedirectRefused
		);
		expect(calls).toHaveLength(1);
	});

	it('refuses the fourth hop when only the fourth is blocked', async () => {
		const { calls, doFetch } = scripted([
			{ status: 302, location: 'https://b.test/' },
			{ status: 302, location: 'https://c.test/' },
			{ status: 302, location: 'http://10.0.0.5/' }
		]);
		await expect(fetchGuarded(doFetch, 'https://a.test/', {})).rejects.toThrow(/10\.0\.0\.5/);
		expect(calls.map((c) => c.url)).toEqual([
			'https://a.test/',
			'https://b.test/',
			'https://c.test/'
		]);
	});

	it('stops a loop after 20 hops', async () => {
		const loop = Array.from({ length: 30 }, () => ({
			status: 302,
			location: 'https://a.test/'
		}));
		const { calls, doFetch } = scripted(loop);
		await expect(fetchGuarded(doFetch, 'https://a.test/', {})).rejects.toThrow(/too many/);
		expect(calls).toHaveLength(21);
	});

	it('drops credentials across an origin and keeps them within one', async () => {
		const headers = { authorization: 'Bearer t', cookie: 'a=b', 'x-keep': '1' };
		const cross = scripted([{ status: 302, location: 'https://b.test/' }, { status: 200 }]);
		await fetchGuarded(cross.doFetch, 'https://a.test/', { headers });
		const sent = new Headers(cross.calls[1]!.init.headers);
		expect([sent.get('authorization'), sent.get('cookie'), sent.get('x-keep')]).toEqual([
			null,
			null,
			'1'
		]);
		const same = scripted([{ status: 302, location: '/next' }, { status: 200 }]);
		await fetchGuarded(same.doFetch, 'https://a.test/', { headers });
		expect(new Headers(same.calls[1]!.init.headers).get('authorization')).toBe('Bearer t');
	});

	it.each([
		['POST', 302, 'GET', false],
		['POST', 301, 'GET', false],
		['PUT', 303, 'GET', false],
		['POST', 307, 'POST', true],
		['PUT', 308, 'PUT', true]
	])('sends %s through a %i as %s, body kept %s', async (method, status, expected, kept) => {
		const { calls, doFetch } = scripted([{ status, location: '/n' }, { status: 200 }]);
		await fetchGuarded(doFetch, 'https://a.test/', {
			method,
			body: 'payload',
			headers: { 'content-type': 'text/plain', 'x-keep': '1' }
		});
		const hop = calls[1]!.init;
		expect(hop.method).toBe(expected);
		expect(hop.body === 'payload').toBe(kept);
		const h = new Headers(hop.headers);
		expect(h.has('content-type')).toBe(kept);
		expect(h.get('x-keep')).toBe('1');
	});

	it('leaves a caller that asked for manual redirects alone', async () => {
		const { calls, doFetch } = scripted([{ status: 302, location: 'http://127.0.0.1/' }]);
		const res = await fetchGuarded(doFetch, 'https://a.test/', { redirect: 'manual' });
		expect(res.status).toBe(302);
		expect(calls).toHaveLength(1);
	});

	it('lets a disabled guard follow anything, which is the rig opt-out', async () => {
		const { calls, doFetch } = scripted([
			{ status: 302, location: 'http://127.0.0.1/' },
			{ status: 200 }
		]);
		const res = await fetchGuarded(doFetch, 'https://a.test/', {}, () => undefined);
		expect(res.status).toBe(200);
		expect(calls).toHaveLength(2);
	});

	it('ends a non-redirect status carrying a location as the answer', async () => {
		const { calls, doFetch } = scripted([{ status: 201, location: 'http://127.0.0.1/' }]);
		expect((await fetchGuarded(doFetch, 'https://a.test/', {})).status).toBe(201);
		expect(calls).toHaveLength(1);
	});
});
