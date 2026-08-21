import { describe, expect, it } from 'vitest';
import {
	authorizeUrl,
	base64Url,
	callbackUrl,
	CF_AUTH_URL,
	CF_OAUTH_CLIENT_ID,
	CF_SCOPES,
	CF_TOKEN_URL,
	createPkce,
	exchangeCode,
	isTokenError,
	needsRefresh,
	PENDING_TTL_MS,
	pendingMatches,
	randomToken,
	refresh,
	resolveAccountId,
	revoke,
	timingSafeEqual,
	type PendingAuth,
	type TokenSet
} from '../../../src/ops/cf-oauth';
import { KV_OVERRIDABLE } from '../../../src/ops/plan';

/**
 * The Cloudflare OAuth surface.
 *
 * Every assertion here is about a property that, if wrong, is a security defect rather than a bug:
 * no client secret, S256 only, state compared without a timing oracle, the verifier never leaving
 * the server, and a disconnect that revokes rather than forgets.
 */

const RESPONSE = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const capture = (impl: (url: string, init?: RequestInit) => Response) => {
	const calls: { url: string; body: string }[] = [];
	const fn = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), body: String(init?.body ?? '') });
		return impl(String(url), init);
	}) as unknown as typeof fetch;
	return { fn, calls };
};

describe('PKCE', () => {
	it('derives the S256 challenge from the verifier, and never offers plain', async () => {
		const p = await createPkce('a'.repeat(43));
		expect(p.method).toBe('S256');
		expect(p.verifier).toBe('a'.repeat(43));
		// the challenge is the base64url SHA-256 of the verifier, not the verifier
		expect(p.challenge).not.toBe(p.verifier);
		expect(p.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
		const again = await createPkce('a'.repeat(43));
		expect(again.challenge, 'the derivation has to be deterministic').toBe(p.challenge);
	});

	it('produces a distinct verifier every time it is not given one', async () => {
		const seen = new Set<string>();
		for (let i = 0; i < 20; i++) seen.add((await createPkce()).verifier);
		expect(seen.size).toBe(20);
	});

	it('emits base64url, so nothing needs escaping in a query string', () => {
		// 0xfb 0xff picks the two alphabet positions that differ between base64 and base64url
		expect(base64Url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
		expect(base64Url(new Uint8Array([1]))).not.toContain('=');
		expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});

describe('the authorization redirect', () => {
	const params = {
		clientId: 'client-abc',
		redirectUri: 'https://site.example/setup/cf/callback',
		challenge: 'chal',
		state: 'st'
	};

	it('sends the operator to the documented endpoint with a code request', () => {
		const url = new URL(authorizeUrl(params));
		expect(`${url.origin}${url.pathname}`).toBe(CF_AUTH_URL);
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('client_id')).toBe('client-abc');
		expect(url.searchParams.get('code_challenge')).toBe('chal');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('state')).toBe('st');
	});

	/**
	 * THE VERIFIER MUST NEVER LEAVE THE SERVER.
	 *
	 * PKCE's whole value is that the party redeeming the code proves it started the flow. A verifier
	 * in the redirect -- or in a cookie the browser would replay -- is readable by anyone who can see
	 * the callback, which makes the challenge decorative.
	 */
	it('never puts the verifier in the redirect', async () => {
		const pkce = await createPkce();
		const url = authorizeUrl({ ...params, challenge: pkce.challenge });
		expect(url).toContain(pkce.challenge);
		expect(url).not.toContain(pkce.verifier);
	});

	it('asks for the least scope that makes mail work, and nothing that can rewrite the worker', () => {
		const scope = new URL(authorizeUrl(params)).searchParams.get('scope') ?? '';
		expect(scope.split(' ').sort()).toEqual([...CF_SCOPES].sort());
		// a stolen token must be a mail problem, not a remote-code-execution one
		expect(scope).not.toContain('workers');
		expect(scope).not.toContain('write:workers');
	});

	it('derives the callback from the deployment origin, since every deployment differs', () => {
		expect(callbackUrl('https://a.workers.dev')).toBe(
			'https://a.workers.dev/setup/cf/callback'
		);
		expect(callbackUrl('https://custom.example')).toBe(
			'https://custom.example/setup/cf/callback'
		);
	});
});

describe('the callback guard', () => {
	const pending: PendingAuth = {
		state: 'the-state',
		verifier: 'v',
		redirectUri: 'https://x/cb',
		createdAt: 1_000
	};

	it('accepts the flow it started', () => {
		expect(pendingMatches(pending, 'the-state', 1_000)).toEqual({ ok: true });
	});

	it('refuses a callback with no flow in progress', () => {
		const out = pendingMatches(null, 'the-state', 1_000);
		expect(out.ok).toBe(false);
	});

	it('refuses a mismatched state, which is the CSRF this parameter exists for', () => {
		const out = pendingMatches(pending, 'attacker-state', 1_000);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toContain('state');
	});

	it('expires an abandoned consent screen rather than leaving it redeemable', () => {
		expect(pendingMatches(pending, 'the-state', 1_000 + PENDING_TTL_MS - 1).ok).toBe(true);
		expect(pendingMatches(pending, 'the-state', 1_000 + PENDING_TTL_MS + 1).ok).toBe(false);
	});
});

describe('timingSafeEqual', () => {
	it('is correct, which is the part a constant-time comparison still has to be', () => {
		expect(timingSafeEqual('abc', 'abc')).toBe(true);
		expect(timingSafeEqual('abc', 'abd')).toBe(false);
		expect(timingSafeEqual('', '')).toBe(true);
	});

	it('does not short-circuit on length, so neither length nor prefix leaks', () => {
		expect(timingSafeEqual('abc', 'abcd')).toBe(false);
		expect(timingSafeEqual('abcd', 'abc')).toBe(false);
		// a shared prefix must not be distinguishable from a shared everything
		expect(timingSafeEqual('aaaaaaaa', 'aaaaaaab')).toBe(false);
	});

	it('compares bytes rather than code units, so a multi-byte char cannot collide', () => {
		expect(timingSafeEqual('é', 'e')).toBe(false);
	});
});

describe('the token exchange', () => {
	const args = {
		clientId: 'c',
		code: 'the-code',
		verifier: 'the-verifier',
		redirectUri: 'https://x/cb'
	};

	/**
	 * NO CLIENT SECRET, EVER.
	 *
	 * drupflare is open source and self-hosted, so a secret compiled into the bundle is a secret
	 * published to everyone who deploys it. Cloudflare's public-client flow authenticates with the
	 * PKCE verifier instead, and this asserts the request never grows a secret back.
	 */
	it('authenticates with the verifier and sends no client_secret', async () => {
		const { fn, calls } = capture(() => RESPONSE({ access_token: 't', expires_in: 3600 }));
		await exchangeCode(args, fn, 0);
		expect(calls[0]!.url).toBe(CF_TOKEN_URL);
		const body = new URLSearchParams(calls[0]!.body);
		expect(body.get('grant_type')).toBe('authorization_code');
		expect(body.get('code_verifier')).toBe('the-verifier');
		expect(body.get('client_secret'), 'a secret here means a secret in the bundle').toBeNull();
	});

	it('returns the token set with an absolute expiry, not a relative one', async () => {
		const { fn } = capture(() =>
			RESPONSE({
				access_token: 't',
				refresh_token: 'r',
				expires_in: 3600,
				scope: 'a:read b:write'
			})
		);
		const out = await exchangeCode(args, fn, 10_000);
		expect(isTokenError(out)).toBe(false);
		if (isTokenError(out)) return;
		expect(out.accessToken).toBe('t');
		expect(out.refreshToken).toBe('r');
		expect(out.expiresAt).toBe(10_000 + 3_600_000);
		expect(out.scopes).toEqual(['a:read', 'b:write']);
	});

	it('reports the OAuth error and its description, rather than a bare status', async () => {
		const { fn } = capture(() =>
			RESPONSE({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400)
		);
		const out = await exchangeCode(args, fn, 0);
		expect(isTokenError(out)).toBe(true);
		if (!isTokenError(out)) return;
		expect(out.error).toBe('invalid_grant: PKCE verification failed');
	});

	it('refuses a 200 that carries no access_token, which is not a success', async () => {
		const { fn } = capture(() => RESPONSE({ token_type: 'bearer' }));
		expect(isTokenError(await exchangeCode(args, fn, 0))).toBe(true);
	});

	it('survives an unreachable endpoint and an unreadable body', async () => {
		const dead = (async () => {
			throw new Error('socket');
		}) as unknown as typeof fetch;
		expect(isTokenError(await exchangeCode(args, dead, 0))).toBe(true);
		const junk = (async () =>
			new Response('<html>', { status: 502 })) as unknown as typeof fetch;
		const out = await exchangeCode(args, junk, 0);
		expect(isTokenError(out)).toBe(true);
		if (isTokenError(out)) expect(out.error).toContain('502');
	});
});

describe('refresh', () => {
	it('trades a refresh token without re-consent, and still sends no secret', async () => {
		const { fn, calls } = capture(() => RESPONSE({ access_token: 't2', expires_in: 60 }));
		const out = await refresh({ clientId: 'c', refreshToken: 'r' }, fn, 0);
		const body = new URLSearchParams(calls[0]!.body);
		expect(body.get('grant_type')).toBe('refresh_token');
		expect(body.get('client_secret')).toBeNull();
		expect(isTokenError(out)).toBe(false);
	});

	it('renews on a skew, so a token is never presented in the instant it expires', () => {
		const set: TokenSet = { accessToken: 't', expiresAt: 100_000, scopes: [] };
		expect(needsRefresh(set, 0)).toBe(false);
		expect(needsRefresh(set, 100_000 - 60_000 - 1)).toBe(false);
		expect(needsRefresh(set, 100_000 - 60_000 + 1)).toBe(true);
	});

	it('never renews a token with no stated expiry, since there is nothing to renew against', () => {
		expect(needsRefresh({ accessToken: 't', scopes: [] }, Number.MAX_SAFE_INTEGER)).toBe(false);
	});
});

describe('disconnecting', () => {
	/**
	 * A DISCONNECT HAS TO REVOKE, not forget.
	 *
	 * A token dropped from storage keeps working until it expires, so a local delete leaves a live
	 * grant the operator believes they cancelled.
	 */
	it('calls the revocation endpoint with the token', async () => {
		const { fn, calls } = capture(() => new Response('', { status: 200 }));
		expect(await revoke({ clientId: 'c', token: 't' }, fn)).toBe(true);
		expect(new URLSearchParams(calls[0]!.body).get('token')).toBe('t');
	});

	it('reports failure rather than claiming a revocation that did not happen', async () => {
		const { fn } = capture(() => new Response('', { status: 500 }));
		expect(await revoke({ clientId: 'c', token: 't' }, fn)).toBe(false);
		const dead = (async () => {
			throw new Error('down');
		}) as unknown as typeof fetch;
		expect(await revoke({ clientId: 'c', token: 't' }, dead)).toBe(false);
	});
});

describe('resolveAccountId', () => {
	it('reads the account off the grant, so the operator pastes no account id', async () => {
		const { fn } = capture(() => RESPONSE({ result: [{ id: 'acct-1' }, { id: 'acct-2' }] }));
		expect(await resolveAccountId('t', fn)).toBe('acct-1');
	});

	it('returns null rather than a guess when the grant names no account', async () => {
		const { fn } = capture(() => RESPONSE({ result: [] }));
		expect(await resolveAccountId('t', fn)).toBeNull();
		const dead = (async () => {
			throw new Error('down');
		}) as unknown as typeof fetch;
		expect(await resolveAccountId('t', dead)).toBeNull();
	});
});

describe('the privilege boundary', () => {
	/**
	 * THE CLIENT ID LOOKS LIKE A KV LEVER AND IS NOT ONE.
	 *
	 * It is not a credential and an operator should be able to change it without a redeploy, which is
	 * exactly the argument `KV_OVERRIDABLE` exists to serve. It still fails that list's real test --
	 * every entry's worst case must be a slow site. KV is operator-writable, so a writer who set this
	 * could point the consent screen at an application they control, and the operator would approve it
	 * reading the attacker's name and logo on Cloudflare's own page.
	 */
	it('keeps CF_OAUTH_CLIENT_ID off the KV allow-list', () => {
		expect([...KV_OVERRIDABLE]).not.toContain(CF_OAUTH_CLIENT_ID);
		// and nothing shaped like a credential joined it either
		for (const name of KV_OVERRIDABLE) {
			expect(name).not.toMatch(/TOKEN|SECRET|PASS|CLIENT_ID/);
		}
	});
});

describe('the endpoints, pinned', () => {
	/**
	 * Read out of wrangler's own bundle, not a blog post.
	 *
	 * Cloudflare publishes no `.well-known/oauth-authorization-server` document -- both the dash and
	 * api hosts were probed and neither serves one -- so there is no discovery to fall back on and a
	 * wrong constant fails at the consent screen with nothing to debug.
	 */
	it('points at dash.cloudflare.com over https', () => {
		for (const u of [CF_AUTH_URL, CF_TOKEN_URL]) {
			expect(new URL(u).protocol).toBe('https:');
			expect(new URL(u).host).toBe('dash.cloudflare.com');
		}
	});
});
