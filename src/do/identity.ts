import { isTokenError, needsRefresh, refresh, type TokenSet } from '../ops/cf-oauth';
import {
	DEFAULT_SCOPES,
	callbackUri,
	discoveryUrl,
	endpointUsable,
	readProvider,
	type OidcConfig,
	type OidcProvider
} from '../ops/oidc';
import { ORIGIN_KEY, chooseOrigin, pinnable } from '../ops/site-origin';
import { errorMessage } from '../util/errors';
import {
	CF_OAUTH_ACCOUNT_KEY,
	CF_OAUTH_CLIENT_ID_KEY,
	CF_OAUTH_TOKEN_KEY,
	OIDC_CLIENT_ID_KEY,
	OIDC_ISSUER_KEY,
	SITE_NAME_KEY
} from './keys';

import type { IdentityHost } from './host';

/**
 * The OIDC provider an operator configured, or why it is not usable.
 *
 * The secret is an env binding; neither it nor the issuer may join `KV_OVERRIDABLE` (a KV
 * writer could point every login at a provider they control).
 */
export function oidcConfig(
	host: IdentityHost,
	origin: string
): { config: OidcConfig } | { refusal: string } {
	const issuer = host.metaGet(OIDC_ISSUER_KEY) ?? '';
	const clientId = host.metaGet(OIDC_CLIENT_ID_KEY) ?? '';
	if (issuer === '' || clientId === '') {
		return { refusal: 'no OIDC provider is configured for this site' };
	}
	if (!endpointUsable(issuer)) return { refusal: 'the OIDC issuer must be https' };
	const secret = String(host.env?.OIDC_CLIENT_SECRET ?? '');
	return {
		config: {
			issuer,
			clientId,
			...(secret ? { clientSecret: secret } : {}),
			scopes: DEFAULT_SCOPES,
			redirectUri: callbackUri(canonicalOrigin(host, origin))
		}
	};
}

/** the discovery document, fetched per callback, not cached; a login is not a hot path */
export async function oidcProvider(
	issuer: string
): Promise<{ provider: OidcProvider } | { refusal: string }> {
	let doc: unknown;
	try {
		const res = await fetch(discoveryUrl(issuer));
		if (!res.ok) return { refusal: `discovery answered ${res.status}` };
		doc = await res.json();
	} catch (e) {
		return { refusal: `discovery failed: ${errorMessage(e).slice(0, 120)}` };
	}
	const provider = readProvider(doc, issuer);
	return 'refusal' in provider ? provider : { provider };
}

/**
 * The Cloudflare API credentials, from the durable grant or from the deployed pair.
 *
 * Every consumer goes through here: the env overlay dies with the incarnation (about ten
 * seconds idle), so the persisted grant is the source. A refreshed set is persisted so the
 * next incarnation starts from it; a refresh failure is not an error (the access token may
 * still be valid).
 */
export async function cfCredentials(
	host: IdentityHost
): Promise<{ token: string; accountId: string }> {
	const stored = storedGrant(host);
	if (stored.set) {
		const clientId = host.metaGet(CF_OAUTH_CLIENT_ID_KEY) ?? '';
		if (clientId && stored.set.refreshToken && needsRefresh(stored.set, host.nowMs())) {
			const next = await refresh({ clientId, refreshToken: stored.set.refreshToken });
			if (!isTokenError(next)) {
				host.writeSecret(CF_OAUTH_TOKEN_KEY, JSON.stringify(next));
				return {
					token: next.accessToken,
					accountId: cfCredentialsSync(host).accountId
				};
			}
		}
	}
	return cfCredentialsSync(host);
}

/** the stored grant, parsed; `set` is undefined when there is none or it is unreadable */
function storedGrant(host: IdentityHost): { set?: TokenSet } {
	const raw = host.readSecret(CF_OAUTH_TOKEN_KEY);
	if (!raw) return {};
	try {
		const set = JSON.parse(raw) as TokenSet;
		return { set: set?.accessToken ? set : undefined };
	} catch {
		return {};
	}
}

/**
 * The same credentials without the refresh, for a caller that cannot await.
 *
 * One rule for which credential a site uses (durable grant first), shared with `mailEnv()`; the
 * drain refreshes before it resolves. An expired token answers 401, which is the better signal.
 */
export function cfCredentialsSync(host: IdentityHost): { token: string; accountId: string } {
	const env = host.env as unknown as Record<string, string | undefined>;
	const accountId = env.CF_EMAIL_ACCOUNT_ID ?? host.metaGet(CF_OAUTH_ACCOUNT_KEY) ?? '';
	const set = storedGrant(host).set;
	return { token: set?.accessToken ?? env.CF_EMAIL_TOKEN ?? '', accountId };
}

/**
 * The `scheme://host[:port]` this site renders absolute URLs against; pinned on first use (one
 * `cfw_meta` row), and a local origin is never pinned.
 *
 * @param observed - `url.origin` of the request being served (the visitor's scheme and host in
 *   production); harness origins like `do.local` are refused by {@link pinnable}
 */
export function canonicalOrigin(host: IdentityHost, observed?: string): string {
	const chosen = chooseOrigin({
		configured: host.env?.SITE_ORIGIN,
		pinned: host.metaGet(ORIGIN_KEY),
		observed
	});
	// a replica inherits the primary's origin with the first restore chunk (the session
	// cookie name derives from the host)
	// `isReplica()`, not `isPoolLane()`: a var-configured replica has the same defect
	if (chosen.from === 'observed' && pinnable(chosen.origin) && !host.isReplica()) {
		host.metaSet(ORIGIN_KEY, chosen.origin);
	}
	return chosen.origin;
}

/**
 * Which site this object is, pinned like the origin (a shared bucket needs per-site mirror
 * keys, not the literal `'site'`).
 */
export function siteName(host: IdentityHost, observed?: string): string {
	const pinned = host.metaGet(SITE_NAME_KEY);
	if (pinned !== null && pinned !== '') return pinned;
	const seen = (observed ?? '').trim();
	if (seen === '') return 'site';
	host.metaSet(SITE_NAME_KEY, seen);
	return seen;
}
