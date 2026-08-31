import { describe, expect, it } from 'vitest';
import { outboundGuardEnabled, refuseOutbound } from '../../../src/ops/outbound-guard';

describe('what PHP may make the Worker fetch', () => {
	it.each([
		'https://updates.drupal.org/release-history/drupal/11.x',
		'https://accounts.google.com/.well-known/openid-configuration',
		'https://www.google.com/recaptcha/api/siteverify',
		'http://example.com/webhook',
		'https://example.com:8443/hook',
		'https://8.8.8.8/'
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
		['nothing', '']
	])('refuses %s', (_label, url) => {
		const refusal = refuseOutbound(url);
		expect(refusal, `${url} was allowed`).not.toBe(null);
		expect(refusal!.reason).not.toBe('');
	});

	it('refuses a string that is not a url at all', () => {
		expect(refuseOutbound('not a url')?.reason).toBe('not a url');
	});

	it('is on unless explicitly 0', () => {
		expect(outboundGuardEnabled(undefined)).toBe(true);
		expect(outboundGuardEnabled({})).toBe(true);
		expect(outboundGuardEnabled({ OUTBOUND_GUARD: '1' })).toBe(true);
		expect(outboundGuardEnabled({ OUTBOUND_GUARD: '0' })).toBe(false);
	});
});
