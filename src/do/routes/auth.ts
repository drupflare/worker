import {
	beginLogin,
	callbackUri,
	completeLogin,
	mintTicket,
	OIDC_COMPLETE_PATH,
	// aliased: `cf-oauth.ts` exports the same two names for Cloudflare's own dashboard flow
	authorizeUrl as oidcAuthorizeUrl,
	pendingMatches as oidcPendingMatches,
	readOidcSetup,
	type PendingLogin
} from '../../ops/oidc';
import {
	isNonce,
	judgeProof,
	recoverKey,
	spendProof,
	type RecoverKv
} from '../../ops/owner-recovery';
import { bearerToken, OWNER_TOKEN_KEY, tokenMatches } from '../../ops/site-secrets';
import type { SitePhpDurableObject } from '../../site-do';
import { jsonError } from '../../util/reply';
import { OIDC_CLIENT_ID_KEY, OIDC_ISSUER_KEY, OIDC_PENDING_KEY, OIDC_TICKET_KEY } from '../keys';

/**
 * Tier B: the OIDC login the host completes before PHP is entered (the interpreter cannot verify
 * an `id_token` signature). The browser carries a single-use ticket, not claims, which PHP redeems
 * through `cfwOidcClaims`.
 */
export async function oidc(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const action = url.searchParams.get('action') ?? 'start';
	const config = site.oidcConfig(url.origin);
	if ('refusal' in config) {
		return jsonError(config.refusal, 400);
	}

	const discovered = await site.oidcProvider(config.config.issuer);
	if ('refusal' in discovered) {
		return jsonError(discovered.refusal, 502);
	}

	if (action === 'start') {
		const pending = await beginLogin(url.searchParams.get('return') ?? '/', site.nowMs());
		const { pkce, ...stored } = pending;
		site.metaSet(OIDC_PENDING_KEY, JSON.stringify(stored));
		return Response.redirect(
			oidcAuthorizeUrl(discovered.provider, config.config, stored, pkce.challenge),
			302
		);
	}

	// every refusal below is a login that must not complete
	let pending: PendingLogin | null = null;
	try {
		pending = JSON.parse(site.metaGet(OIDC_PENDING_KEY) ?? 'null') as PendingLogin | null;
	} catch {
		pending = null;
	}
	// consumed whatever happens, so a failed attempt cannot be retried against a stale state
	site.metaSet(OIDC_PENDING_KEY, '');

	const matched = oidcPendingMatches(pending, url.searchParams.get('state') ?? '', site.nowMs());
	if ('refusal' in matched) {
		return jsonError(matched.refusal, 400);
	}

	const code = url.searchParams.get('code') ?? '';
	if (code === '') {
		return jsonError('no authorization code', 400);
	}

	const completed = await completeLogin(
		code,
		pending!,
		config.config,
		discovered.provider,
		site.nowMs(),
		{ fetch: (u, init) => fetch(u, init as RequestInit) }
	);
	if ('refusal' in completed) {
		return jsonError(completed.refusal, 401);
	}

	const ticket = mintTicket(completed.claims, discovered.provider, site.nowMs());
	site.metaSet(OIDC_TICKET_KEY, JSON.stringify(ticket));
	// redeem at `OIDC_COMPLETE_PATH`; `returnTo` would leave the ticket in the visitor's URL and
	// proxy logs
	const back = new URL(OIDC_COMPLETE_PATH, site.canonicalOrigin(url.origin));
	back.searchParams.set('cfw_oidc', ticket.ticket);
	// drupal's redirect subscriber honours `destination`
	back.searchParams.set('destination', pending!.returnTo);
	return Response.redirect(back.toString(), 302);
}

/**
 * Reads and writes the OIDC provider (owner route). The issuer picks the provider every login
 * trusts, so it stays off `KV_OVERRIDABLE`; the secret stays a binding and is never read back.
 */
export async function oidcsetup(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const redirectUri = callbackUri(site.canonicalOrigin(url.origin));
	const state = () => ({
		ok: true,
		issuer: site.metaGet(OIDC_ISSUER_KEY) ?? '',
		clientId: site.metaGet(OIDC_CLIENT_ID_KEY) ?? '',
		// presence only (a secret read back ends up in a screenshot)
		secretPresent: String(site.env?.OIDC_CLIENT_SECRET ?? '') !== '',
		redirectUri
	});

	const action = url.searchParams.get('action') ?? 'status';
	if (action === 'status') return Response.json(state());

	if (action === 'clear') {
		site.metaSet(OIDC_ISSUER_KEY, '');
		site.metaSet(OIDC_CLIENT_ID_KEY, '');
		return Response.json({ ...state(), cleared: true });
	}

	if (action !== 'save') {
		return jsonError(`unknown action ${action}`, 400, { known: ['status', 'save', 'clear'] });
	}

	const form =
		request.method === 'POST' ? new URLSearchParams(await request.text()) : url.searchParams;
	const verdict = readOidcSetup({
		issuer: form.get('issuer'),
		clientId: form.get('clientId')
	});
	if ('refusal' in verdict) {
		return jsonError(verdict.refusal, 400);
	}
	site.metaSet(OIDC_ISSUER_KEY, verdict.issuer);
	site.metaSet(OIDC_CLIENT_ID_KEY, verdict.clientId);

	// proves the issuer is real now rather than at a login
	const discovered = await site.oidcProvider(verdict.issuer);
	return Response.json({
		...state(),
		saved: true,
		discovery:
			'refusal' in discovered
				? { ok: false, error: discovered.refusal }
				: {
						ok: true,
						authorization: discovered.provider.authorizationEndpoint,
						token: discovered.provider.tokenEndpoint,
						jwks: discovered.provider.jwksUri
					}
	});
}

/**
 * Spends a recovery proof and returns the owner token (inner route; the front worker applies the
 * failure budget around it).
 *
 * Every refusal names a `reason` the client branches on. Only `unknown` is retryable, because a
 * record written seconds ago may not have reached this colo yet.
 */
export async function recoverToken(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const refuse = (status: number, reason: string, error: string) =>
		Response.json(
			{ ok: false, reason, error },
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	let nonce: unknown;
	try {
		nonce = ((await request.json()) as { nonce?: unknown }).nonce;
	} catch {
		nonce = undefined;
	}
	if (!isNonce(nonce))
		return refuse(400, 'malformed', 'the nonce is not 43 base64url characters');
	const kv = (site.env as { CONFIG_KV?: RecoverKv } | undefined)?.CONFIG_KV;
	if (!kv)
		return refuse(501, 'no-kv', 'this deployment has no CONFIG_KV binding to verify against');

	const key = await recoverKey(url.host, nonce);
	const raw = await kv.get(key);
	if (raw === null) return refuse(404, 'unknown', 'no such proof');
	let record: unknown;
	try {
		record = JSON.parse(raw);
	} catch {
		record = undefined;
	}
	const now = site.nowMs();
	const judged = judgeProof(record, url.host, now);
	const forget = async () => {
		// best effort: the spent table, not this delete, is what makes a proof single-use
		try {
			await kv.delete?.(key);
		} catch {
			// the TTL removes it
		}
	};
	if (judged.verdict !== 'ok') {
		await forget();
		const refusals = {
			malformed: [400, 'the stored proof is malformed'],
			'wrong-host': [403, 'the proof was written for another host'],
			spent: [410, 'the proof has expired']
		} as const;
		const [status, error] = refusals[judged.verdict];
		return refuse(status, judged.verdict, error);
	}
	// no await between the check inside and the write: that is what makes two racers spend it once
	if (!spendProof(site.secretStore(), key, judged.exp, now)) {
		return refuse(410, 'spent', 'the proof was already used');
	}
	await forget();
	// read, never minted: `ensureOwnerToken()` here would let a recovery claim an unclaimed site
	const token = site.metaGet(OWNER_TOKEN_KEY);
	if (!token) return refuse(409, 'unclaimed', 'this site has no owner token yet');
	return Response.json(
		{ ok: true, ownerToken: token },
		{ headers: { 'cache-control': 'no-store' } }
	);
}

/** answers 200 when the presented bearer token is the owner token, else 401 */
export async function ownercheck(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const presented = bearerToken(request.headers.get('authorization'));
	const stored = site.metaGet(OWNER_TOKEN_KEY);
	return new Response(null, {
		status: tokenMatches(presented, stored) ? 200 : 401
	});
}
