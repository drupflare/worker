import { base64Url, createPkce, randomToken, timingSafeEqual, type Pkce } from './cf-oauth.js';

/**
 * Tier B of the network capability: an OAuth/OIDC exchange that happens at a route the HOST owns.
 *
 * **THIS IS NOT A CHEAPER JSPI, IT IS THE ONLY ROUTE.** `WITH_OPENSSL=0`, so the shipping
 * interpreter cannot verify an RS256 `id_token` at all -- and an unverified `id_token` is an
 * unauthenticated login, so a JSPI build that let PHP fetch the token endpoint synchronously would
 * hand PHP a token it still could not check. The host has `crypto.subtle`. That is the whole
 * argument for doing this here, and it does not depend on a module count or a millisecond.
 *
 * The shape: the callback is an ordinary HTTP request to the Worker, so the awaiting happens in
 * JavaScript BEFORE PHP is entered, and PHP is handed a decided result rather than a promise. Same
 * move `src/ops/cf-oauth.ts` already makes for Cloudflare's own dashboard OAuth; this is the
 * provider-agnostic version of it.
 *
 * **THE CLAIMS NEVER TRAVEL IN A URL.** The browser carries a single-use ticket and nothing else;
 * the claims sit in the object's own storage and are deleted on first read. A redirect lands in
 * history, in a referrer and in any proxy log on the path, so claims in a query string would be a
 * login token pasted into three places nobody controls.
 */

// #region configuration

/**
 * The provider, assembled from the operator's configuration.
 *
 * `issuer`, `clientId` and `scopes` live in `cfw_meta` because an operator sets them from the setup
 * UI. **The SECRET is an env binding and must never join `KV_OVERRIDABLE`** -- and neither may the
 * issuer, for the reason `CF_OAUTH_CLIENT_ID` is kept off that list: a KV writer who could point the
 * issuer at a provider they control would have every login on the site authenticate against it, and
 * the operator would approve a consent screen showing the attacker's name.
 */
export interface OidcConfig {
	issuer: string;
	clientId: string;
	clientSecret?: string;
	scopes: string[];
	/** the site's own callback, which the provider must have registered */
	redirectUri: string;
}

/** what a provider's discovery document has to give up before anything else can run */
export interface OidcProvider {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	jwksUri: string;
	issuer: string;
}

export const DISCOVERY_PATH = '/.well-known/openid-configuration';

/** `/oidc` rather than the object's `/__oidc`, which the front worker refuses from outside */
export const CALLBACK_PATH = '/oidc?action=callback';

export function callbackUri(origin: string): string {
	return `${origin.replace(/\/+$/, '')}${CALLBACK_PATH}`;
}

/** the scopes a login needs and nothing more; `offline_access` is deliberately absent */
export const DEFAULT_SCOPES = ['openid', 'profile', 'email'];

export function discoveryUrl(issuer: string): string {
	return `${issuer.replace(/\/+$/, '')}${DISCOVERY_PATH}`;
}

/** loopback only; `site-origin.ts` keeps a wider set for a different question and `do.local` is in it */
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/;

/** http is refused; loopback is exempt and a deployed Worker has no loopback to reach */
export function endpointUsable(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol === 'https:') return true;
	return parsed.protocol === 'http:' && LOOPBACK.test(parsed.hostname);
}

/**
 * Validates what an operator typed into the setup form.
 *
 * `https` is a refusal rather than an upgrade: an issuer reached over plain http can be rewritten in
 * flight, and the discovery document is what names the jwks the whole login trusts. A query string
 * or fragment is refused for the same reason `discoveryUrl()` appends a fixed path -- an issuer
 * carrying one produces a discovery URL nobody intended.
 */
export function readOidcSetup(input: {
	issuer?: string | null;
	clientId?: string | null;
}): { issuer: string; clientId: string } | { refusal: string } {
	const clientId = String(input.clientId ?? '').trim();
	if (clientId === '') return { refusal: 'the client id is required' };

	const raw = String(input.issuer ?? '').trim();
	if (raw === '') return { refusal: 'the issuer is required' };
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { refusal: `the issuer is not a URL: ${raw.slice(0, 80)}` };
	}
	if (!endpointUsable(raw)) return { refusal: 'the OIDC issuer must be https' };
	if (url.search !== '' || url.hash !== '') {
		return { refusal: 'the issuer must be a bare URL, with no query or fragment' };
	}
	// stored without it, so `discoveryUrl()` and the `iss` comparison agree on one spelling
	return { issuer: `${url.origin}${url.pathname}`.replace(/\/+$/, ''), clientId };
}

/**
 * Reads a discovery document, refusing one whose `issuer` does not match where it was fetched from.
 *
 * That check is not ceremony: the `iss` claim is verified against this value later, so a document
 * free to name any issuer would let one provider mint tokens accepted as another's.
 */
export function readProvider(
	doc: unknown,
	expectedIssuer: string
): OidcProvider | { refusal: string } {
	if (doc === null || typeof doc !== 'object')
		return { refusal: 'discovery document is not an object' };
	const d = doc as Record<string, unknown>;
	const issuer = String(d.issuer ?? '');
	const authorizationEndpoint = String(d.authorization_endpoint ?? '');
	const tokenEndpoint = String(d.token_endpoint ?? '');
	const jwksUri = String(d.jwks_uri ?? '');

	if (issuer === '' || authorizationEndpoint === '' || tokenEndpoint === '' || jwksUri === '') {
		return { refusal: 'discovery document is missing issuer, authorization, token or jwks' };
	}
	// trailing-slash differences are the one variation the spec tolerates
	if (issuer.replace(/\/+$/, '') !== expectedIssuer.replace(/\/+$/, '')) {
		return { refusal: `discovery issuer ${issuer} does not match ${expectedIssuer}` };
	}
	for (const url of [authorizationEndpoint, tokenEndpoint, jwksUri]) {
		if (!endpointUsable(url)) return { refusal: `${url} is not https` };
	}
	return { issuer, authorizationEndpoint, tokenEndpoint, jwksUri };
}

// #endregion

// #region the pending authorisation

/**
 * What the host remembers between the redirect out and the callback back.
 *
 * The verifier and the nonce NEVER leave the object. The browser carries `state` and nothing else,
 * which is what makes PKCE and the nonce worth having: an attacker who can read the redirect gets
 * the one value that is useless without the two that stayed behind.
 */
export interface PendingLogin {
	state: string;
	verifier: string;
	nonce: string;
	createdAt: number;
	/** where to send the browser once the login lands */
	returnTo: string;
}

export const PENDING_TTL_MS = 10 * 60_000;

export async function beginLogin(
	returnTo = '/',
	nowMs = 0
): Promise<PendingLogin & { pkce: Pkce }> {
	const pkce = await createPkce();
	return {
		state: randomToken(32),
		verifier: pkce.verifier,
		nonce: randomToken(16),
		createdAt: nowMs,
		returnTo: returnTo.startsWith('/') ? returnTo : '/',
		pkce
	};
}

/** the URL the browser is sent to, with the challenge and never the verifier */
export function authorizeUrl(
	provider: OidcProvider,
	config: OidcConfig,
	pending: PendingLogin,
	challenge: string
): string {
	const url = new URL(provider.authorizationEndpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', config.clientId);
	url.searchParams.set('redirect_uri', config.redirectUri);
	url.searchParams.set('scope', config.scopes.join(' '));
	url.searchParams.set('state', pending.state);
	url.searchParams.set('nonce', pending.nonce);
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	return url.toString();
}

/**
 * Whether a callback's `state` matches what was stored, in constant time and within the TTL.
 *
 * A mismatched `state` is CSRF: an attacker completes a login with their own authorization code in
 * the victim's browser, and the victim ends up signed in as the attacker.
 */
export function pendingMatches(
	pending: PendingLogin | null,
	state: string,
	nowMs: number
): { ok: true } | { refusal: string } {
	if (pending === null) return { refusal: 'no login is in progress for this site' };
	if (nowMs - pending.createdAt > PENDING_TTL_MS) return { refusal: 'the login attempt expired' };
	if (!timingSafeEqual(pending.state, state))
		return { refusal: 'state does not match the login that started' };
	return { ok: true };
}

// #endregion

// #region the id_token

/** one JSON Web Key, narrowed to what a signature check needs */
export interface Jwk {
	kty: string;
	kid?: string;
	alg?: string;
	use?: string;
	[key: string]: unknown;
}

/** the algorithms this accepts; `none` and every HMAC family are refused by omission */
const ALGORITHMS: Record<
	string,
	{ importAlgo: SubtleCryptoImportKeyAlgorithm; verifyAlgo: SubtleCryptoSignAlgorithm }
> = {
	RS256: {
		importAlgo: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		verifyAlgo: { name: 'RSASSA-PKCS1-v1_5' }
	},
	ES256: {
		importAlgo: { name: 'ECDSA', namedCurve: 'P-256' },
		verifyAlgo: { name: 'ECDSA', hash: 'SHA-256' }
	}
};

function fromBase64Url(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/');
	const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

export interface IdTokenClaims {
	iss: string;
	sub: string;
	aud: string | string[];
	exp: number;
	iat?: number;
	nonce?: string;
	email?: string;
	name?: string;
	preferred_username?: string;
	[key: string]: unknown;
}

/** how much clock skew between this Worker and the provider is tolerated */
export const CLOCK_SKEW_S = 120;

/**
 * Verifies an `id_token` end to end and returns its claims.
 *
 * **EVERY REFUSAL HERE IS A SILENT FAILURE IF IT IS MISSING**, which is why each is separate and
 * separately tested rather than folded into one "is it valid" call:
 *
 * - a bad SIGNATURE means anyone can mint a login for any account;
 * - a wrong `iss` means another provider's token is accepted as this one's;
 * - a wrong `aud` means a token issued to a DIFFERENT application of the same provider logs in here,
 *   which is the confused-deputy case and the one that looks most valid;
 * - an expired token means a captured one works forever;
 * - a wrong `nonce` means a token replayed from another session is accepted.
 *
 * `alg` comes from the KEY, never from the token header alone: trusting the header is how `none` and
 * the RS256-to-HS256 confusion attack work.
 */
export async function verifyIdToken(
	idToken: string,
	keys: Jwk[],
	config: OidcConfig,
	provider: OidcProvider,
	nonce: string,
	nowS: number
): Promise<{ claims: IdTokenClaims } | { refusal: string }> {
	const parts = idToken.split('.');
	if (parts.length !== 3) return { refusal: 'id_token is not a compact JWS' };
	const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

	let header: Record<string, unknown>;
	let claims: IdTokenClaims;
	try {
		header = JSON.parse(new TextDecoder().decode(fromBase64Url(headerB64)));
		claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
	} catch {
		return { refusal: 'id_token header or payload is not JSON' };
	}

	const alg = String(header.alg ?? '');
	if (!(alg in ALGORITHMS)) return { refusal: `id_token alg ${alg || '(none)'} is not accepted` };
	const { importAlgo, verifyAlgo } = ALGORITHMS[alg]!;

	// a `kid` narrows the search; without one every key of the right type is tried, which is what
	// a provider mid-rotation requires
	const kid = header.kid === undefined ? null : String(header.kid);
	const candidates = keys.filter((k) => {
		if (k.use !== undefined && k.use !== 'sig') return false;
		if (k.alg !== undefined && k.alg !== alg) return false;
		return kid === null || k.kid === undefined || k.kid === kid;
	});
	if (candidates.length === 0) return { refusal: `no JWKS key matches kid ${kid ?? '(none)'}` };

	const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const signature = fromBase64Url(signatureB64);
	let verified = false;
	for (const jwk of candidates) {
		try {
			const key = await crypto.subtle.importKey('jwk', jwk as JsonWebKey, importAlgo, false, [
				'verify'
			]);
			if (await crypto.subtle.verify(verifyAlgo, key, signature, signed)) {
				verified = true;
				break;
			}
		} catch {
			// an unusable key is not a verdict on the token; keep trying the others
		}
	}
	if (!verified) return { refusal: 'id_token signature does not verify against the JWKS' };

	if (claims.iss?.replace(/\/+$/, '') !== provider.issuer.replace(/\/+$/, '')) {
		return { refusal: `id_token iss ${claims.iss} is not ${provider.issuer}` };
	}
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!audiences.includes(config.clientId)) {
		return { refusal: 'id_token aud is another client, so it was not issued to this site' };
	}
	if (!Number.isFinite(claims.exp) || claims.exp + CLOCK_SKEW_S < nowS) {
		return { refusal: 'id_token has expired' };
	}
	if (nonce !== '' && claims.nonce !== nonce) {
		return { refusal: 'id_token nonce does not match the login that started' };
	}
	if (typeof claims.sub !== 'string' || claims.sub === '') {
		return { refusal: 'id_token carries no subject' };
	}
	return { claims };
}

// #endregion

// #region the claims ticket

/**
 * What PHP is handed, and it is handed exactly once.
 *
 * **SINGLE USE IS THE PROPERTY, not the TTL.** A ticket in a redirect URL lands in browser history
 * and in every proxy log on the path, so the guarantee that matters is that a second presentation
 * fails -- a short TTL only narrows the window.
 */
export interface ClaimsTicket {
	ticket: string;
	sub: string;
	issuer: string;
	email: string;
	name: string;
	expiresAt: number;
}

export const TICKET_TTL_MS = 60_000;

export function mintTicket(
	claims: IdTokenClaims,
	provider: OidcProvider,
	nowMs: number
): ClaimsTicket {
	return {
		ticket: randomToken(32),
		sub: claims.sub,
		issuer: provider.issuer,
		email: typeof claims.email === 'string' ? claims.email : '',
		name:
			typeof claims.name === 'string'
				? claims.name
				: typeof claims.preferred_username === 'string'
					? claims.preferred_username
					: '',
		expiresAt: nowMs + TICKET_TTL_MS
	};
}

/** whether a stored ticket may be redeemed; the CALLER must delete it either way */
export function ticketRedeemable(
	stored: ClaimsTicket | null,
	presented: string,
	nowMs: number
): { ok: true } | { refusal: string } {
	if (stored === null) return { refusal: 'that ticket has already been used or never existed' };
	if (stored.expiresAt < nowMs) return { refusal: 'that ticket expired' };
	if (!timingSafeEqual(stored.ticket, presented))
		return { refusal: 'that ticket does not match' };
	return { ok: true };
}

// #endregion

// #region the exchange

export type OidcDeps = {
	fetch: (
		url: string,
		init?: { method: string; headers: Record<string, string>; body: string }
	) => Promise<{
		ok: boolean;
		status: number;
		json(): Promise<unknown>;
		text(): Promise<string>;
	}>;
};

/** the token-endpoint body; the secret is sent only when the provider issued one */
export function tokenRequestBody(code: string, verifier: string, config: OidcConfig): string {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: config.redirectUri,
		client_id: config.clientId,
		code_verifier: verifier
	});
	if (config.clientSecret) body.set('client_secret', config.clientSecret);
	return body.toString();
}

/**
 * Exchanges the code and verifies what comes back.
 *
 * The whole point of Tier B is in the `await`s here: they happen at a route the host owns, before
 * PHP is entered, so PHP never has to suspend.
 */
export async function completeLogin(
	code: string,
	pending: PendingLogin,
	config: OidcConfig,
	provider: OidcProvider,
	nowMs: number,
	deps: OidcDeps
): Promise<{ claims: IdTokenClaims } | { refusal: string }> {
	const res = await deps.fetch(provider.tokenEndpoint, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'application/json'
		},
		body: tokenRequestBody(code, pending.verifier, config)
	});
	if (!res.ok) {
		return { refusal: `the token endpoint answered ${res.status}` };
	}

	let payload: Record<string, unknown>;
	try {
		payload = (await res.json()) as Record<string, unknown>;
	} catch {
		return { refusal: 'the token endpoint did not answer JSON' };
	}
	const idToken = String(payload.id_token ?? '');
	if (idToken === '') return { refusal: 'the token response carries no id_token' };

	const jwksRes = await deps.fetch(provider.jwksUri);
	if (!jwksRes.ok) return { refusal: `the JWKS endpoint answered ${jwksRes.status}` };
	let keys: Jwk[];
	try {
		const doc = (await jwksRes.json()) as { keys?: unknown };
		keys = Array.isArray(doc.keys) ? (doc.keys as Jwk[]) : [];
	} catch {
		return { refusal: 'the JWKS endpoint did not answer JSON' };
	}
	if (keys.length === 0) return { refusal: 'the JWKS carries no keys' };

	return verifyIdToken(idToken, keys, config, provider, pending.nonce, Math.floor(nowMs / 1000));
}

// #endregion

export { base64Url, randomToken };
