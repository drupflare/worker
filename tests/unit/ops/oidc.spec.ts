import { describe, expect, it } from 'vitest';
import {
	authorizeUrl,
	beginLogin,
	CLOCK_SKEW_S,
	completeLogin,
	discoveryUrl,
	mintTicket,
	PENDING_TTL_MS,
	pendingMatches,
	readProvider,
	TICKET_TTL_MS,
	ticketRedeemable,
	tokenRequestBody,
	verifyIdToken,
	type IdTokenClaims,
	type Jwk,
	type OidcConfig,
	type OidcProvider,
	type PendingLogin
} from '../../../src/ops/oidc';

/**
 * Tier B, driven with REAL generated keys rather than a stub.
 *
 * Every refusal in `verifyIdToken` is a silent failure if it is missing -- a bad signature mints a
 * login for any account, a foreign `aud` is the confused-deputy case and looks entirely valid -- so
 * a stub that returned "claims" would pass a naive test of all five while proving nothing. These
 * generate a key pair, sign a token with it, and then sign one with a DIFFERENT pair to prove the
 * check fails on the case it exists for.
 */

const ISSUER = 'https://idp.test';
const CLIENT_ID = 'drupflare-site';

const PROVIDER: OidcProvider = {
	issuer: ISSUER,
	authorizationEndpoint: `${ISSUER}/authorize`,
	tokenEndpoint: `${ISSUER}/token`,
	jwksUri: `${ISSUER}/jwks`
};

const CONFIG: OidcConfig = {
	issuer: ISSUER,
	clientId: CLIENT_ID,
	scopes: ['openid', 'profile', 'email'],
	redirectUri: 'https://site.test/__oidc/callback'
};

function b64url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeSegment(value: unknown): string {
	return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function makeKeyPair(): Promise<{ jwk: Jwk; sign: CryptoKey }> {
	const pair = (await crypto.subtle.generateKey(
		{
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256'
		},
		true,
		['sign', 'verify']
	)) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as unknown as Jwk;
	jwk.kid = 'test-key';
	jwk.alg = 'RS256';
	jwk.use = 'sig';
	return { jwk, sign: pair.privateKey };
}

async function signToken(
	sign: CryptoKey,
	claims: Partial<IdTokenClaims>,
	kid = 'test-key'
): Promise<string> {
	const header = encodeSegment({ alg: 'RS256', typ: 'JWT', kid });
	const payload = encodeSegment({
		iss: ISSUER,
		sub: 'user-42',
		aud: CLIENT_ID,
		exp: Math.floor(Date.now() / 1000) + 300,
		nonce: 'the-nonce',
		email: 'someone@example.com',
		name: 'Someone',
		...claims
	});
	const signature = await crypto.subtle.sign(
		{ name: 'RSASSA-PKCS1-v1_5' },
		sign,
		new TextEncoder().encode(`${header}.${payload}`)
	);
	return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

const NOW_S = () => Math.floor(Date.now() / 1000);

describe('discovery', () => {
	it('builds the well-known URL without doubling a slash', () => {
		expect(discoveryUrl('https://idp.test')).toBe(
			'https://idp.test/.well-known/openid-configuration'
		);
		expect(discoveryUrl('https://idp.test/')).toBe(
			'https://idp.test/.well-known/openid-configuration'
		);
	});

	it('reads a complete document', () => {
		const out = readProvider(
			{
				issuer: ISSUER,
				authorization_endpoint: `${ISSUER}/authorize`,
				token_endpoint: `${ISSUER}/token`,
				jwks_uri: `${ISSUER}/jwks`
			},
			ISSUER
		);
		expect('refusal' in out).toBe(false);
	});

	// the `iss` claim is checked against THIS value, so a document free to name any issuer would let
	// one provider mint tokens accepted as another's
	it('refuses a document that names a different issuer than it was fetched from', () => {
		const out = readProvider(
			{
				issuer: 'https://evil.test',
				authorization_endpoint: `${ISSUER}/authorize`,
				token_endpoint: `${ISSUER}/token`,
				jwks_uri: `${ISSUER}/jwks`
			},
			ISSUER
		);
		expect('refusal' in out && out.refusal).toContain('does not match');
	});

	it('refuses a non-https endpoint and an incomplete document', () => {
		const plain = readProvider(
			{
				issuer: ISSUER,
				authorization_endpoint: 'http://idp.test/authorize',
				token_endpoint: `${ISSUER}/token`,
				jwks_uri: `${ISSUER}/jwks`
			},
			ISSUER
		);
		expect('refusal' in plain && plain.refusal).toContain('not https');
		expect('refusal' in readProvider({ issuer: ISSUER }, ISSUER)).toBe(true);
		expect('refusal' in readProvider(null, ISSUER)).toBe(true);
	});
});

describe('the redirect out', () => {
	it('carries the challenge and never the verifier or the nonce', async () => {
		const pending = await beginLogin('/admin', 1000);
		const url = new URL(authorizeUrl(PROVIDER, CONFIG, pending, pending.pkce.challenge));
		expect(url.searchParams.get('code_challenge')).toBe(pending.pkce.challenge);
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('state')).toBe(pending.state);
		// the two values that make the challenge and the nonce worth having stay behind
		expect(url.toString()).not.toContain(pending.verifier);
		expect(url.searchParams.get('nonce')).toBe(pending.nonce);
	});

	it('refuses to send the browser off-site after the login', async () => {
		expect((await beginLogin('https://evil.test/steal', 0)).returnTo).toBe('/');
		expect((await beginLogin('/admin/content', 0)).returnTo).toBe('/admin/content');
	});
});

describe('state: the CSRF check', () => {
	const base: PendingLogin = {
		state: 'the-state',
		verifier: 'v',
		nonce: 'n',
		createdAt: 1000,
		returnTo: '/'
	};

	it('accepts the state it stored', () => {
		expect(pendingMatches(base, 'the-state', 1000)).toEqual({ ok: true });
	});

	// without this an attacker completes a login with THEIR authorization code in the victim's
	// browser, and the victim is signed in as the attacker
	it('refuses a state that does not match', () => {
		const out = pendingMatches(base, 'another-state', 1000);
		expect('refusal' in out && out.refusal).toContain('state does not match');
	});

	it('refuses when no login is in progress, and one that timed out', () => {
		expect('refusal' in pendingMatches(null, 'x', 0)).toBe(true);
		const out = pendingMatches(base, 'the-state', 1000 + PENDING_TTL_MS + 1);
		expect('refusal' in out && out.refusal).toContain('expired');
	});
});

describe('verifyIdToken: five refusals, each a silent failure if it is missing', () => {
	it('accepts a token signed by a key in the JWKS', async () => {
		const { jwk, sign } = await makeKeyPair();
		const token = await signToken(sign, {});
		const out = await verifyIdToken(token, [jwk], CONFIG, PROVIDER, 'the-nonce', NOW_S());
		expect('claims' in out && out.claims.sub).toBe('user-42');
	});

	// 1. anyone could mint a login for any account
	it('refuses a token signed by a key that is NOT in the JWKS', async () => {
		const trusted = await makeKeyPair();
		const attacker = await makeKeyPair();
		const token = await signToken(attacker.sign, {});
		const out = await verifyIdToken(
			token,
			[trusted.jwk],
			CONFIG,
			PROVIDER,
			'the-nonce',
			NOW_S()
		);
		expect('refusal' in out && out.refusal).toContain('signature does not verify');
	});

	// 2. another provider's token accepted as this one's
	it('refuses a foreign issuer', async () => {
		const { jwk, sign } = await makeKeyPair();
		const token = await signToken(sign, { iss: 'https://evil.test' });
		const out = await verifyIdToken(token, [jwk], CONFIG, PROVIDER, 'the-nonce', NOW_S());
		expect('refusal' in out && out.refusal).toContain('is not');
	});

	// 3. the confused deputy, and the one that looks most valid: a real token from the real
	// provider, issued to a DIFFERENT application
	it('refuses a token issued to another client of the same provider', async () => {
		const { jwk, sign } = await makeKeyPair();
		const token = await signToken(sign, { aud: 'somebody-elses-app' });
		const out = await verifyIdToken(token, [jwk], CONFIG, PROVIDER, 'the-nonce', NOW_S());
		expect('refusal' in out && out.refusal).toContain('another client');
	});

	// 4. a captured token would work forever
	it('refuses an expired token, and tolerates only the stated skew', async () => {
		const { jwk, sign } = await makeKeyPair();
		const expired = await signToken(sign, { exp: NOW_S() - CLOCK_SKEW_S - 60 });
		expect(
			'refusal' in
				(await verifyIdToken(expired, [jwk], CONFIG, PROVIDER, 'the-nonce', NOW_S()))
		).toBe(true);

		const justInside = await signToken(sign, { exp: NOW_S() - Math.floor(CLOCK_SKEW_S / 2) });
		const out = await verifyIdToken(justInside, [jwk], CONFIG, PROVIDER, 'the-nonce', NOW_S());
		expect('claims' in out).toBe(true);
	});

	// 5. a token replayed from another session
	it('refuses a nonce from a different login', async () => {
		const { jwk, sign } = await makeKeyPair();
		const token = await signToken(sign, { nonce: 'a-different-login' });
		const out = await verifyIdToken(token, [jwk], CONFIG, PROVIDER, 'the-nonce', NOW_S());
		expect('refusal' in out && out.refusal).toContain('nonce');
	});

	// `alg` from the header alone is how `none` and the RS256->HS256 confusion attack work
	it('refuses an algorithm it does not accept, including none', async () => {
		const { jwk } = await makeKeyPair();
		const header = encodeSegment({ alg: 'none', typ: 'JWT' });
		const payload = encodeSegment({
			iss: ISSUER,
			sub: 'user-42',
			aud: CLIENT_ID,
			exp: NOW_S() + 300
		});
		const out = await verifyIdToken(
			`${header}.${payload}.`,
			[jwk],
			CONFIG,
			PROVIDER,
			'',
			NOW_S()
		);
		expect('refusal' in out && out.refusal).toContain('not accepted');
	});

	it('refuses a token that is not a compact JWS, and one with no subject', async () => {
		const { jwk, sign } = await makeKeyPair();
		expect(
			'refusal' in
				(await verifyIdToken('not.a.jwt.at.all', [jwk], CONFIG, PROVIDER, '', NOW_S()))
		).toBe(true);
		const noSub = await signToken(sign, { sub: '' });
		const out = await verifyIdToken(noSub, [jwk], CONFIG, PROVIDER, 'the-nonce', NOW_S());
		expect('refusal' in out && out.refusal).toContain('no subject');
	});

	it('refuses when no key matches the kid', async () => {
		const { jwk, sign } = await makeKeyPair();
		const token = await signToken(sign, {}, 'some-other-kid');
		const out = await verifyIdToken(
			token,
			[{ ...jwk, kid: 'test-key' }],
			CONFIG,
			PROVIDER,
			'the-nonce',
			NOW_S()
		);
		expect('refusal' in out && out.refusal).toContain('no JWKS key matches');
	});
});

describe('the claims ticket', () => {
	const claims: IdTokenClaims = {
		iss: ISSUER,
		sub: 'user-42',
		aud: CLIENT_ID,
		exp: 0,
		email: 'someone@example.com',
		name: 'Someone'
	};

	it('carries the identity and nothing that could be replayed at the provider', () => {
		const t = mintTicket(claims, PROVIDER, 1000);
		expect(t).toMatchObject({ sub: 'user-42', issuer: ISSUER, email: 'someone@example.com' });
		// no id_token, no access token, no refresh token -- a leaked ticket is useless anywhere else
		expect(JSON.stringify(t)).not.toContain('eyJ');
	});

	// SINGLE USE is the property. A ticket rides in a redirect, so it lands in history and in every
	// proxy log on the path; a TTL only narrows the window, it does not close it
	it('refuses a REPLAYED ticket, which is what the caller deleting it produces', () => {
		const t = mintTicket(claims, PROVIDER, 1000);
		expect(ticketRedeemable(t, t.ticket, 1000)).toEqual({ ok: true });
		// the second presentation finds nothing, because the first redemption deleted the row
		const out = ticketRedeemable(null, t.ticket, 1000);
		expect('refusal' in out && out.refusal).toContain('already been used');
	});

	it('refuses an expired ticket and a mismatched one', () => {
		const t = mintTicket(claims, PROVIDER, 1000);
		expect('refusal' in ticketRedeemable(t, t.ticket, 1000 + TICKET_TTL_MS + 1)).toBe(true);
		expect('refusal' in ticketRedeemable(t, 'some-other-ticket', 1000)).toBe(true);
	});
});

describe('the exchange', () => {
	const pending: PendingLogin = {
		state: 's',
		verifier: 'the-verifier',
		nonce: 'the-nonce',
		createdAt: 0,
		returnTo: '/'
	};

	it('sends the verifier and omits a secret the provider did not issue', () => {
		const body = new URLSearchParams(tokenRequestBody('the-code', 'the-verifier', CONFIG));
		expect(body.get('grant_type')).toBe('authorization_code');
		expect(body.get('code_verifier')).toBe('the-verifier');
		expect(body.get('client_secret')).toBeNull();

		const withSecret = new URLSearchParams(
			tokenRequestBody('the-code', 'the-verifier', { ...CONFIG, clientSecret: 'shh' })
		);
		expect(withSecret.get('client_secret')).toBe('shh');
	});

	it('exchanges a code and verifies what comes back', async () => {
		const { jwk, sign } = await makeKeyPair();
		const idToken = await signToken(sign, {});
		const deps = {
			fetch: async (url: string) => ({
				ok: true,
				status: 200,
				json: async () => (url.endsWith('/jwks') ? { keys: [jwk] } : { id_token: idToken }),
				text: async () => ''
			})
		};
		const out = await completeLogin('the-code', pending, CONFIG, PROVIDER, Date.now(), deps);
		expect('claims' in out && out.claims.email).toBe('someone@example.com');
	});

	it('reports a refusing token endpoint rather than throwing', async () => {
		const deps = {
			fetch: async () => ({
				ok: false,
				status: 400,
				json: async () => ({}),
				text: async () => ''
			})
		};
		const out = await completeLogin('the-code', pending, CONFIG, PROVIDER, Date.now(), deps);
		expect('refusal' in out && out.refusal).toContain('400');
	});

	it('refuses a token response with no id_token, and an empty JWKS', async () => {
		const noToken = {
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => ({ access_token: 'a' }),
				text: async () => ''
			})
		};
		expect(
			'refusal' in (await completeLogin('c', pending, CONFIG, PROVIDER, Date.now(), noToken))
		).toBe(true);

		const { sign } = await makeKeyPair();
		const idToken = await signToken(sign, {});
		const noKeys = {
			fetch: async (url: string) => ({
				ok: true,
				status: 200,
				json: async () => (url.endsWith('/jwks') ? { keys: [] } : { id_token: idToken }),
				text: async () => ''
			})
		};
		const out = await completeLogin('c', pending, CONFIG, PROVIDER, Date.now(), noKeys);
		expect('refusal' in out && out.refusal).toContain('no keys');
	});
});
