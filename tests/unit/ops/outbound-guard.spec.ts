import { describe, expect, it } from 'vitest';
import { outboundGuardEnabled, refuseOutbound } from '../../../src/ops/outbound-guard';

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
		'https://223.255.255.255/'
	])('allows %s', (url) => {
		expect(refuseOutbound(url)).toBe(null);
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
		expect(refusal, `${url} was allowed`).not.toBe(null);
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
