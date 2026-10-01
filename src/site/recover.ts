import {
	clearOwnerFailures,
	noteOwnerFailure,
	ownerFailKey,
	ownerRefusedForNow
} from '../ops/admin-session';
import { isNonce, RECOVER_PATH } from '../ops/owner-recovery';
import { siteStubOptions } from '../ops/site-id';
import { siteFor } from './owner';
import type { FrontEntry } from './types';

/** a nonce body is under 60 bytes; anything near this is not a client of ours */
const MAX_BODY_BYTES = 1024;

/** statuses that spend failure budget: the caller did not hold a valid proof */
const COUNTED = new Set([400, 403, 404, 410]);

const headers = { 'cache-control': 'no-store' };

function refuse(status: number, reason: string, error: string, extra: HeadersInit = {}): Response {
	return Response.json(
		{ ok: false, reason, error },
		{ status, headers: { ...headers, ...extra } }
	);
}

/**
 * `POST /recover-token`: the owner token for whoever can prove write access to the account.
 *
 * Public by construction, since the caller has no token. It shares the owner check's failure
 * budget, and the budget is read BEFORE the object hop so a refused address costs no Durable Object
 * request. A miss counts as a failure, which is why the client paces its retries.
 */
export async function recoverRoute(f: FrontEntry): Promise<Response | undefined> {
	const { request, url, env } = f;
	if (f.internal || url.pathname !== RECOVER_PATH) return undefined;
	if (request.method !== 'POST') {
		return refuse(405, 'method', 'POST the nonce as JSON', { allow: 'POST' });
	}

	const failKey = ownerFailKey(request);
	const now = Date.now();
	if (ownerRefusedForNow(failKey, now)) {
		return refuse(429, 'rate', 'too many failed attempts from this address', {
			'retry-after': '60'
		});
	}

	const declared = Number(request.headers.get('content-length') ?? '0');
	const body = declared > MAX_BODY_BYTES ? '' : (await request.text()).slice(0, MAX_BODY_BYTES);
	let nonce: unknown;
	try {
		nonce = (JSON.parse(body) as { nonce?: unknown }).nonce;
	} catch {
		nonce = undefined;
	}
	if (!isNonce(nonce)) {
		noteOwnerFailure(failKey, now);
		return refuse(400, 'malformed', 'the nonce is not 43 base64url characters');
	}

	const site = await siteFor(url, env);
	const stub = env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env));
	const inner = new URL(url);
	inner.pathname = '/__recover-token';
	inner.search = '';
	let res: Response;
	try {
		res = await stub.fetch(
			new Request(inner, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nonce })
			})
		);
	} catch {
		// no answer is not a refusal; an unreachable object must not spend the caller's budget
		return refuse(503, 'unavailable', 'the site did not answer; try again');
	}
	if (res.status === 200) clearOwnerFailures(failKey);
	else if (COUNTED.has(res.status)) noteOwnerFailure(failKey, now);
	return new Response(res.body, {
		status: res.status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}
