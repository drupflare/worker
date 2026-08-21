/**
 * Cloudflare OAuth 2.0, so an operator can grant drupflare access without pasting a long-lived token.
 *
 * Self-managed OAuth clients shipped 2026-06-03. Before that the only option was an API token, which
 * is why {@link https://developers.cloudflare.com/fundamentals/oauth/ | the paste path} exists and
 * stays: this is an ADDITIONAL way in, never a replacement.
 *
 * ## The flow, and why it is the only one available
 *
 * Cloudflare supports **Authorization Code only** for third-party clients -- no Client Credentials,
 * Implicit, Device Authorization or ROPC. Of the two variants, drupflare must use **PKCE with S256**
 * rather than a client secret: the bundle is open source and self-hosted, so a secret compiled into
 * it is a secret published to everyone who deploys it. PKCE needs no secret, which is exactly the
 * property a distributed application needs.
 *
 * ## Why the operator registers their own client
 *
 * A redirect URI is registered against the client, and every drupflare deployment answers on a
 * different origin -- `<name>.<subdomain>.workers.dev`, or a custom domain. One shared client cannot
 * enumerate them in advance. Cloudflare's docs do not state whether redirect matching permits a
 * wildcard, and the OAuth 2.0 Security BCP says it must not, so this is built to not depend on the
 * answer: the operator creates a PRIVATE client on their own account, registers their own
 * deployment's callback, and pastes the `client_id`. Private visibility is enough because they are a
 * member of the account they are authorising -- the DNS-verified `public` visibility that a shared
 * client would need is permanent and irreversible, and buys nothing here.
 *
 * ## Why the client id is NOT on the KV allow-list
 *
 * It looks like it belongs there -- it is not a credential, and an operator should be able to set it
 * without a redeploy. It fails the allow-list's actual test, which is that every entry's worst case
 * is a slow site. KV is operator-writable, and a writer who could set the client id could point the
 * consent screen at an application they control: the operator would then read that app's name and
 * logo on Cloudflare's own consent page and approve it. That is a phishing surface, not a slow site.
 *
 * So it is stored in the object's own `cfw_meta` and set through the owner-authenticated setup
 * route, which gives the same no-redeploy property behind a credential the operator holds.
 * `tests/unit/ops/cf-oauth.spec.ts` asserts it stays off `KV_OVERRIDABLE`.
 */

/** the authorization endpoint; read out of wrangler's own source rather than a blog post */
export const CF_AUTH_URL = 'https://dash.cloudflare.com/oauth2/auth';
/** the token endpoint */
export const CF_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
/** the revocation endpoint, so a disconnect is a real revocation and not a local forget */
export const CF_REVOKE_URL = 'https://dash.cloudflare.com/oauth2/revoke';

/** the settings key holding the operator's registered client id */
export const CF_OAUTH_CLIENT_ID = 'CF_OAUTH_CLIENT_ID';

/**
 * The scopes drupflare asks for, and nothing beyond them.
 *
 * Scope names are the API-token permission names in `<name>:<read|write>` form. This list is the
 * least that makes the mail path work: `user:read` identifies the account so the operator does not
 * have to paste an account id alongside, and the two email scopes are what
 * `POST /accounts/:id/email/sending/send` requires.
 *
 * `workers-platform:write` is deliberately ABSENT. drupflare is already deployed by the time a
 * human sees the setup page, so a token that could rewrite the Worker buys nothing and would make a
 * stolen token a remote-code-execution rather than a mail problem.
 */
export const CF_SCOPES = ['user:read', 'account:read', 'email:read', 'email:write'] as const;

/** base64url without padding, which is what PKCE and OAuth state both want */
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

export type Pkce = { verifier: string; challenge: string; method: 'S256' };

/**
 * A PKCE verifier and its S256 challenge.
 *
 * `plain` is not offered. Cloudflare requires S256 for public clients, and a `plain` challenge is
 * equivalent to sending the verifier in the clear -- an interceptor of the redirect could complete
 * the exchange.
 */
export async function createPkce(verifier: string = randomToken(32)): Promise<Pkce> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)), method: 'S256' };
}

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
 *
 * The verifier NEVER goes in a cookie or a query parameter: it is the proof that the party
 * redeeming the code is the party that started the flow, so putting it anywhere the user agent can
 * read makes PKCE decorative.
 */
export type PendingAuth = {
	state: string;
	verifier: string;
	redirectUri: string;
	createdAt: number;
};

/** how long a started flow stays redeemable; a consent screen the operator abandons must expire */
export const PENDING_TTL_MS = 10 * 60_000;

/**
 * Whether a callback matches the flow that was started.
 *
 * Constant-time on the state comparison. A timing oracle on `state` would let an attacker recover a
 * valid value character by character and mount the CSRF this parameter exists to stop.
 */
export function pendingMatches(
	pending: PendingAuth | null,
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

export type TokenSet = {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
	scopes: string[];
};

export type TokenError = { error: string };

/** whether the exchange failed, so callers narrow rather than inspecting shapes */
export function isTokenError(v: TokenSet | TokenError): v is TokenError {
	return 'error' in v;
}

/**
 * Exchanges an authorization code for tokens.
 *
 * `client_secret` is absent and must stay absent: this is a public client, and the token endpoint
 * authenticates it with the PKCE verifier instead. Sending a secret here would mean there was a
 * secret in the bundle.
 */
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

/** trades a refresh token for a fresh access token, so a long-lived grant needs no re-consent */
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
		// the OAuth error shape is `error` + `error_description`; report both when present so an
		// operator sees "invalid_grant: PKCE verification failed" rather than a status code
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

/** a minute of slack, so a token is not presented in the instant it expires */
export const REFRESH_SKEW_MS = 60_000;

/** whether a token set should be refreshed before use */
export function needsRefresh(set: TokenSet, nowMs: number): boolean {
	if (set.expiresAt === undefined) return false;
	return nowMs >= set.expiresAt - REFRESH_SKEW_MS;
}

/**
 * Revokes a token at Cloudflare.
 *
 * Disconnecting has to revoke rather than forget. A token dropped from storage still works until it
 * expires, so a "disconnect" that only deletes locally leaves a live grant an operator believes they
 * cancelled.
 */
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
): Promise<string | null> {
	try {
		const res = await fetcher('https://api.cloudflare.com/client/v4/accounts?per_page=2', {
			headers: { authorization: `Bearer ${accessToken}` }
		});
		const body = (await res.json()) as { result?: { id?: string }[] };
		const first = body?.result?.[0]?.id;
		return typeof first === 'string' ? first : null;
	} catch {
		return null;
	}
}
