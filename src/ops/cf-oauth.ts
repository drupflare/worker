/**
 * Cloudflare OAuth 2.0: an operator grants drupflare access without pasting a long-lived token.
 *
 * Authorization Code with PKCE (S256) and no client secret, since a secret in an open-source
 * bundle is published to every deployer. The operator registers a private client for their own
 * callback. The client id lives in `cfw_meta`, never on `KV_OVERRIDABLE` (a KV writer could point
 * the consent screen at their own app); `tests/unit/ops/cf-oauth.spec.ts` asserts that.
 * @module
 */

/** the authorization endpoint (read out of wrangler's own source) */
export const CF_AUTH_URL = 'https://dash.cloudflare.com/oauth2/auth';
/** the token endpoint */
export const CF_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
/** the revocation endpoint (a disconnect must revoke, not only forget locally) */
export const CF_REVOKE_URL = 'https://dash.cloudflare.com/oauth2/revoke';

/** the settings key holding the operator's registered client id */
export const CF_OAUTH_CLIENT_ID = 'CF_OAUTH_CLIENT_ID';

/**
 * The least scopes that make the mail path work: `user:read` and `account:read` identify the
 * account, the email scopes cover `POST /accounts/:id/email/sending/send`.
 * `workers-platform:write` is left out so a stolen token cannot rewrite the Worker.
 */
export const CF_SCOPES = ['user:read', 'account:read', 'email:read', 'email:write'] as const;

/** base64url without padding, as PKCE and OAuth state require */
export function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** a cryptographically random URL-safe string of `bytes` entropy */
export function randomToken(bytes = 32): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return base64Url(buf);
}

/** a PKCE verifier with its challenge and method */
export type Pkce = { verifier: string; challenge: string; method: 'S256' };

/** a PKCE verifier and its S256 challenge (`plain` would send the verifier in the clear) */
export async function createPkce(verifier: string = randomToken(32)): Promise<Pkce> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)), method: 'S256' };
}

/** what `authorizeUrl()` needs to build the consent redirect */
export type AuthorizeParams = {
	clientId: string;
	redirectUri: string;
	challenge: string;
	state: string;
	scopes?: readonly string[];
};

/** the URL to send the operator to */
export function authorizeUrl(p: AuthorizeParams): string {
	const url = new URL(CF_AUTH_URL);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', p.clientId);
	url.searchParams.set('redirect_uri', p.redirectUri);
	url.searchParams.set('scope', (p.scopes ?? CF_SCOPES).join(' '));
	url.searchParams.set('state', p.state);
	url.searchParams.set('code_challenge', p.challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	return url.toString();
}

/** the callback drupflare registers, derived from the deployment's own origin */
export function callbackUrl(origin: string): string {
	return new URL('/setup/cf/callback', origin).toString();
}

/**
 * The pending authorisation, held between the redirect out and the callback back.
 * The verifier never goes in a cookie or query parameter (that would make PKCE decorative).
 */
export type PendingAuth = {
	state: string;
	verifier: string;
	redirectUri: string;
	createdAt: number;
};

/** how long a started flow stays redeemable (an abandoned consent screen must expire) */
export const PENDING_TTL_MS = 10 * 60_000;

/** whether a callback matches the flow that was started (constant-time on `state`) */
export function pendingMatches(
	pending: PendingAuth | undefined,
	state: string,
	nowMs: number
): { ok: true } | { ok: false; reason: string } {
	if (!pending) return { ok: false, reason: 'no authorisation is in progress' };
	if (nowMs - pending.createdAt > PENDING_TTL_MS) {
		return { ok: false, reason: 'the authorisation expired; start it again' };
	}
	if (!timingSafeEqual(pending.state, state)) {
		return { ok: false, reason: 'state did not match the authorisation that was started' };
	}
	return { ok: true };
}

/** length-independent comparison, so neither the length nor a prefix leaks through timing */
export function timingSafeEqual(a: string, b: string): boolean {
	const ab = new TextEncoder().encode(a);
	const bb = new TextEncoder().encode(b);
	// the lengths are compared as data rather than branched on
	let diff = ab.length ^ bb.length;
	const n = Math.max(ab.length, bb.length);
	for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
	return diff === 0;
}

/** the tokens a successful exchange returns; `expiresAt` is absolute ms */
export type TokenSet = {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
	scopes: string[];
};

/** a failed exchange, as `code` or `code: description` */
export type TokenError = { error: string };

/** whether the exchange failed, as a type guard */
export function isTokenError(v: TokenSet | TokenError): v is TokenError {
	return 'error' in v;
}

/** exchanges an authorization code for tokens; `client_secret` stays absent (public client) */
export async function exchangeCode(
	args: {
		clientId: string;
		code: string;
		verifier: string;
		redirectUri: string;
	},
	fetcher: typeof fetch = fetch,
	nowMs: number = Date.now()
): Promise<TokenSet | TokenError> {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		client_id: args.clientId,
		code: args.code,
		code_verifier: args.verifier,
		redirect_uri: args.redirectUri
	});
	return await postToken(body, fetcher, nowMs);
}

/** trades a refresh token for a fresh access token, with no re-consent */
export async function refresh(
	args: { clientId: string; refreshToken: string },
	fetcher: typeof fetch = fetch,
	nowMs: number = Date.now()
): Promise<TokenSet | TokenError> {
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		client_id: args.clientId,
		refresh_token: args.refreshToken
	});
	return await postToken(body, fetcher, nowMs);
}

async function postToken(
	body: URLSearchParams,
	fetcher: typeof fetch,
	nowMs: number
): Promise<TokenSet | TokenError> {
	let res: Response;
	try {
		res = await fetcher(CF_TOKEN_URL, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json'
			},
			body: body.toString()
		});
	} catch (e) {
		return { error: `token endpoint unreachable: ${(e as Error)?.message ?? 'unknown'}` };
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = (await res.json()) as Record<string, unknown>;
	} catch {
		return { error: `token endpoint returned ${res.status} with an unreadable body` };
	}
	if (!res.ok || typeof parsed.access_token !== 'string') {
		// report `error` and `error_description` so the operator sees why, not a status code
		const code = typeof parsed.error === 'string' ? parsed.error : `http_${res.status}`;
		const detail =
			typeof parsed.error_description === 'string' ? `: ${parsed.error_description}` : '';
		return { error: `${code}${detail}` };
	}
	const expiresIn = Number(parsed.expires_in);
	return {
		accessToken: parsed.access_token,
		refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined,
		expiresAt: Number.isFinite(expiresIn) ? nowMs + expiresIn * 1000 : undefined,
		scopes: typeof parsed.scope === 'string' ? parsed.scope.split(/\s+/).filter(Boolean) : []
	};
}

/** a minute of slack, so a token is not presented as it expires */
export const REFRESH_SKEW_MS = 60_000;

/** whether a token set should be refreshed before use */
export function needsRefresh(set: TokenSet, nowMs: number): boolean {
	if (set.expiresAt === undefined) return false;
	return nowMs >= set.expiresAt - REFRESH_SKEW_MS;
}

/** revokes a token at Cloudflare (a token merely dropped from storage still works until expiry) */
export async function revoke(
	args: { clientId: string; token: string },
	fetcher: typeof fetch = fetch
): Promise<boolean> {
	try {
		const res = await fetcher(CF_REVOKE_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ client_id: args.clientId, token: args.token }).toString()
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** the account the grant belongs to, so the operator never pastes an account id */
export async function resolveAccountId(
	accessToken: string,
	fetcher: typeof fetch = fetch
): Promise<string | undefined> {
	try {
		const res = await fetcher('https://api.cloudflare.com/client/v4/accounts?per_page=2', {
			headers: { authorization: `Bearer ${accessToken}` }
		});
		const body = (await res.json()) as { result?: { id?: string }[] };
		const first = body?.result?.[0]?.id;
		return typeof first === 'string' ? first : undefined;
	} catch {
		return undefined;
	}
}
