import { describe, expect, it } from 'vitest';
import { discoveryUrl, readOidcSetup } from '../../../src/ops/oidc.js';

describe('reading what an operator typed into the OIDC form', () => {
	it('accepts an https issuer and a client id', () => {
		expect(readOidcSetup({ issuer: 'https://accounts.example.com', clientId: 'abc' })).toEqual({
			issuer: 'https://accounts.example.com',
			clientId: 'abc'
		});
	});

	it('keeps a path, because a provider may live under one', () => {
		const out = readOidcSetup({ issuer: 'https://example.com/realms/main', clientId: 'x' });
		expect(out).toEqual({ issuer: 'https://example.com/realms/main', clientId: 'x' });
	});

	it('normalises the trailing slash, so discovery and the iss check agree', () => {
		const out = readOidcSetup({ issuer: 'https://example.com/realms/main/', clientId: 'x' });
		expect(out).toEqual({ issuer: 'https://example.com/realms/main', clientId: 'x' });
		expect(discoveryUrl((out as { issuer: string }).issuer)).toBe(
			'https://example.com/realms/main/.well-known/openid-configuration'
		);
	});

	it('refuses http, because the jwks the login trusts is named by that document', () => {
		expect(readOidcSetup({ issuer: 'http://accounts.example.com', clientId: 'x' })).toEqual({
			refusal: 'the OIDC issuer must be https'
		});
	});

	it.each([
		['a query', 'https://example.com/?a=1'],
		['a fragment', 'https://example.com/#f']
	])('refuses an issuer carrying %s', (_label, issuer) => {
		expect(readOidcSetup({ issuer, clientId: 'x' })).toMatchObject({
			refusal: expect.stringContaining('bare URL')
		});
	});

	it('refuses something that is not a URL at all', () => {
		expect(readOidcSetup({ issuer: 'accounts.example.com', clientId: 'x' })).toMatchObject({
			refusal: expect.stringContaining('not a URL')
		});
	});

	it('requires both fields', () => {
		expect(readOidcSetup({ issuer: 'https://e.com', clientId: '' })).toEqual({
			refusal: 'the client id is required'
		});
		expect(readOidcSetup({ issuer: '', clientId: 'x' })).toEqual({
			refusal: 'the issuer is required'
		});
		expect(readOidcSetup({})).toEqual({ refusal: 'the client id is required' });
	});

	it('trims, because a pasted value carries whitespace', () => {
		expect(readOidcSetup({ issuer: '  https://e.com  ', clientId: '  id  ' })).toEqual({
			issuer: 'https://e.com',
			clientId: 'id'
		});
	});
});
