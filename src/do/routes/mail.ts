import {
	authorizeUrl,
	callbackUrl,
	createPkce,
	exchangeCode,
	isTokenError,
	type PendingAuth,
	pendingMatches,
	randomToken,
	resolveAccountId,
	revoke,
	type TokenSet
} from '../../ops/cf-oauth';
import {
	applyDnsPlan,
	createSendingSubdomain,
	dnsPlan,
	isVerified,
	listDestinations,
	listSendingSubdomains,
	onboardState,
	type RecordAction,
	requiredDns,
	type TokenGrants,
	zoneRecords
} from '../../ops/mail-onboard';
import type { SitePhpDurableObject } from '../../site-do';
import { jsonError } from '../../util/reply';
import {
	CF_OAUTH_ACCOUNT_KEY,
	CF_OAUTH_CLIENT_ID_KEY,
	CF_OAUTH_PENDING_KEY,
	CF_OAUTH_TOKEN_KEY,
	MAIL_SENDING_DOMAIN_KEY,
	MAIL_ZONE_KEY
} from '../keys';

/**
 * Sending-domain onboarding status, and the apply step behind it. `GET` is read-only; the token
 * is never a query parameter (a URL lands in every log).
 */
export async function mailonboard(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	// through the resolver, which reads the durable grant (`this.env` alone refuses after a
	// connect)
	const { token, accountId } = await site.cfCredentials();
	const zoneId = url.searchParams.get('zone') ?? site.metaGet(MAIL_ZONE_KEY) ?? '';
	if (!token) {
		// the stage rather than a bare error, so one surface reads every step the same way
		return jsonError('no Cloudflare token; connect an account first', 400, {
			...onboardState({
				zoneId: null,
				subdomain: null,
				plan: [],
				destination: undefined,
				hasToken: false
			})
		});
	}
	if (url.searchParams.get('zone')) site.metaSet(MAIL_ZONE_KEY, zoneId);

	const subs = zoneId ? await listSendingSubdomains(token, zoneId) : null;
	if (subs && !subs.ok) return jsonError(subs.error, 400);
	let subdomain = subs?.ok ? (subs.value[0] ?? null) : null;

	if (url.searchParams.get('action') === 'apply' && zoneId) {
		if (!subdomain) {
			const made = await createSendingSubdomain(
				token,
				zoneId,
				url.searchParams.get('name') ?? ''
			);
			if (!made.ok) return jsonError(made.error, 400);
			subdomain = made.value;
		}
	}

	// recorded for the commit path, which compares a message's From against it; a mismatch
	// makes Cloudflare restrict delivery to verified destinations, so the send looks fine
	if (subdomain?.name) site.metaSet(MAIL_SENDING_DOMAIN_KEY, subdomain.name);

	let plan: RecordAction[] = [];
	if (subdomain) {
		const [want, have] = await Promise.all([
			requiredDns(token, zoneId, subdomain.id),
			zoneRecords(token, zoneId)
		]);
		if (want.ok && have.ok) plan = dnsPlan(want.value, have.value);
	}

	let applied = null;
	if (url.searchParams.get('action') === 'apply' && plan.length > 0) {
		applied = await applyDnsPlan(token, zoneId, plan);
	}

	const dests = accountId ? await listDestinations(token, accountId) : null;
	const wanted = url.searchParams.get('destination');
	const destination = dests?.ok
		? dests.value.find((d) => (wanted ? d.email === wanted : isVerified(d)))
		: undefined;

	// probed, not assumed: a failed `dests` read is not the same as an unverified destination
	const grants: TokenGrants = {
		zone: subs === null ? null : subs.ok,
		destinations: dests !== null && dests.ok,
		...(dests && !dests.ok ? { refusal: dests.error } : {})
	};

	// a live send through the resolved transport; `ready` only means the preconditions look
	// satisfied
	const test =
		url.searchParams.get('action') === 'test'
			? await site.sendMailTest(url.searchParams.get('to') ?? '')
			: null;

	return Response.json({
		ok: true,
		...onboardState({
			zoneId: zoneId || null,
			subdomain,
			plan,
			destination,
			grants,
			hasToken: true
		}),
		grants,
		applied,
		...(test ? { test } : {})
	});
}

/**
 * The Cloudflare OAuth flow, held in the object because a KV writer cannot reach it. `start` is
 * owner-authenticated; `callback` is a header-less redirect, so `state` authenticates it.
 */
export async function cfoauth(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const action = url.searchParams.get('action') ?? 'status';
	const clientId = site.metaGet(CF_OAUTH_CLIENT_ID_KEY);

	if (action === 'connect') {
		const given = url.searchParams.get('client_id')?.trim();
		if (given) site.metaSet(CF_OAUTH_CLIENT_ID_KEY, given);
		const id = given || clientId;
		if (!id) {
			return jsonError('register an OAuth client and pass client_id', 400);
		}
		const pkce = await createPkce();
		const state = randomToken(24);
		const redirectUri = callbackUrl(site.canonicalOrigin(url.origin));
		site.metaSet(
			CF_OAUTH_PENDING_KEY,
			JSON.stringify({
				state,
				verifier: pkce.verifier,
				redirectUri,
				createdAt: site.nowMs()
			} satisfies PendingAuth)
		);
		return Response.json({
			ok: true,
			authorizeUrl: authorizeUrl({
				clientId: id,
				redirectUri,
				challenge: pkce.challenge,
				state
			})
		});
	}

	if (action === 'callback') {
		// the return leg is a browser navigation, so send it to the Deploy page with the outcome;
		// anything else still gets JSON for the CLI and the specs
		const wantsHtml = (request.headers.get('accept') ?? '').includes('text/html');
		const backTo = (params: string): Response =>
			new Response(null, {
				status: 303,
				headers: {
					// the literal rather than an import, so the object does not pull the UI module
					// into its bundle
					location: `/_cfw/deploy?${params}`,
					'cache-control': 'no-store'
				}
			});
		const refuse = (error: string): Response =>
			wantsHtml ? backTo(`error=${encodeURIComponent(error)}`) : jsonError(error, 400);
		const raw = site.metaGet(CF_OAUTH_PENDING_KEY);
		let pending: PendingAuth | undefined;
		try {
			pending = raw ? (JSON.parse(raw) as PendingAuth) : undefined;
		} catch {
			pending = undefined;
		}
		const check = pendingMatches(pending, url.searchParams.get('state') ?? '', site.nowMs());
		// consumed only on a match: this route is public, so clearing on every request would let
		// anyone cancel an owner's connect
		if (!check.ok) return refuse(check.reason);
		// still before the exchange, so a code cannot be replayed against it
		site.metaSet(CF_OAUTH_PENDING_KEY, '');
		const code = url.searchParams.get('code') ?? '';
		if (!code || !clientId) return refuse('no code returned');
		const out = await exchangeCode({
			clientId,
			code,
			verifier: (pending as PendingAuth).verifier,
			redirectUri: (pending as PendingAuth).redirectUri
		});
		if (isTokenError(out)) return refuse(out.error);
		const accountId = await resolveAccountId(out.accessToken);
		site.metaSet(CF_OAUTH_TOKEN_KEY, JSON.stringify(out));
		if (accountId) site.metaSet(CF_OAUTH_ACCOUNT_KEY, accountId);
		// the grant replaces the pasted pair, which is why it is offered
		site.env = {
			...site.env,
			CF_EMAIL_TOKEN: out.accessToken,
			...(accountId ? { CF_EMAIL_ACCOUNT_ID: accountId } : {})
		};
		return wantsHtml
			? backTo('connected=1')
			: Response.json({ ok: true, accountId, scopes: out.scopes });
	}

	if (action === 'disconnect') {
		const raw = site.metaGet(CF_OAUTH_TOKEN_KEY);
		let revoked = false;
		if (raw && clientId) {
			try {
				const set = JSON.parse(raw) as TokenSet;
				revoked = await revoke({ clientId, token: set.accessToken });
			} catch {
				revoked = false;
			}
		}
		// cleared either way; `revoked` is reported separately so a failed revocation stays visible
		site.metaSet(CF_OAUTH_TOKEN_KEY, '');
		site.metaSet(CF_OAUTH_ACCOUNT_KEY, '');
		return Response.json({ ok: true, revoked });
	}

	const stored = site.metaGet(CF_OAUTH_TOKEN_KEY);
	return Response.json({
		ok: true,
		clientId: clientId ? `${clientId.slice(0, 6)}...` : null,
		connected: Boolean(stored),
		accountId: site.metaGet(CF_OAUTH_ACCOUNT_KEY) || null
	});
}
