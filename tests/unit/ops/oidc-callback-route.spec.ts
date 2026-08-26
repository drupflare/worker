import { describe, expect, it } from 'vitest';
import { CALLBACK_PATH, callbackUri, endpointUsable, readOidcSetup } from '../../../src/ops/oidc';
import { routeTable } from '../../../src/site';

/** a `__` path is refused from outside, so a `redirect_uri` naming one answers 404 */

describe('the OIDC callback is reachable from outside', () => {
	it('is not a Durable Object path', () => {
		expect(CALLBACK_PATH.startsWith('/__')).toBe(false);
		expect(callbackUri('https://site.example')).toBe(
			'https://site.example/oidc?action=callback'
		);
	});

	it('names a path the front worker forwards to the object', () => {
		const path = CALLBACK_PATH.split('?')[0] as string;
		expect(routeTable().doRoute[path], `${path} has no DO_ROUTE entry, so it is a 404`).toBe(
			'/__oidc'
		);
	});

	it('is public, because a provider redirect carries no credential this worker controls', () => {
		const path = CALLBACK_PATH.split('?')[0] as string;
		expect(routeTable().public.has(path)).toBe(true);
		// and reachable at all: a path absent from the union is rewritten to /serve and rendered
		expect(routeTable().all.has(path)).toBe(true);
	});

	it('does not double a slash on an origin that carries one', () => {
		expect(callbackUri('https://site.example/')).toBe(
			'https://site.example/oidc?action=callback'
		);
	});
});

describe('which endpoints a login may be reached over', () => {
	it.each(['https://accounts.example.com', 'https://id.example.com/realms/x'])(
		'accepts %s',
		(url) => {
			expect(endpointUsable(url)).toBe(true);
		}
	);

	it.each([
		['plain http on a real host', 'http://accounts.example.com'],
		['an internal DO hostname', 'http://do.local'],
		['a private address that is not loopback', 'http://10.0.0.1:8081'],
		['a host merely containing the word', 'http://localhost.evil.example'],
		['not a URL at all', 'accounts.example.com']
	])('refuses %s', (_label, url) => {
		expect(endpointUsable(url)).toBe(false);
	});

	it.each([
		'http://127.0.0.1:8081/realms/drupflare',
		'http://localhost:8081',
		'http://[::1]:8081'
	])('exempts loopback at %s, which a deployed worker cannot reach anyway', (url) => {
		expect(endpointUsable(url)).toBe(true);
	});

	it('lets the setup form accept a loopback issuer and still refuse a plain-http one', () => {
		expect(readOidcSetup({ issuer: 'http://127.0.0.1:8081/realms/x', clientId: 'c' })).toEqual({
			issuer: 'http://127.0.0.1:8081/realms/x',
			clientId: 'c'
		});
		expect(readOidcSetup({ issuer: 'http://id.example.com', clientId: 'c' })).toMatchObject({
			refusal: expect.stringContaining('https')
		});
	});
});
