import { ATTEMPT_HEADER } from '../ops/attempt';
import { AUTH_REQUEST_HEADER } from '../ops/auth-budget';
import { ABSORBED_HEADER } from '../ops/cold-encounter';
import { shouldFailover } from '../ops/replica-routing';
import { siteStubOptions } from '../ops/site-id';
import { objectResetPage, resetRecovery } from './guards';
import { drainAbsorbed } from './memos';
import { DO_ROUTE } from './routes';
import type { AuthState, FrontContext, Hop } from './types';

/** the request the object receives, with its buffered body and attempt id */
export interface HopRequest {
	innerRequest: Request;
	buffered?: ArrayBuffer;
	attempt?: string;
}

/** builds the object request: the inner route, a buffered body and the front worker's headers */
export async function buildHop(f: FrontContext, auth: AuthState): Promise<HopRequest> {
	const { request, url, site, serving, laneOf } = f;
	const { personalised, authenticated } = auth;
	// the object's routes are double-underscored so they cannot collide with a Drupal path
	const inner = new URL(request.url);
	// every route has a DO_ROUTE entry except `/fillwindow`, which returned above
	inner.pathname = DO_ROUTE[url.pathname] as string;
	// the resolved name overwrites the caller's: the object keys its identity and R2 mirror on it
	inner.searchParams.set('site', site);
	// Cloudflare builds the consent redirect URL, so it cannot carry `?action=`
	if (url.pathname === '/setup/cf/callback') inner.searchParams.set('action', 'callback');

	// awaited, never raced against a timer (a render is one synchronous `php._run()`; a 1 ms
	// timer lost to a 119 ms `stub.fetch()`); buffered, since workerd throws if a POST goes unread
	const buffered =
		request.method === 'GET' || request.method === 'HEAD'
			? undefined
			: await request.arrayBuffer();
	// `redirect: 'manual'` (a followed post-submit 3xx hit the object's 404 after the write);
	// wrapped, not spread (a `Request`'s members live on the prototype, so a spread drops cookies)
	const innerRequest = new Request(
		buffered === undefined
			? new Request(inner, request)
			: new Request(inner, {
					method: request.method,
					headers: request.headers,
					body: buffered
				}),
		{ redirect: 'manual' }
	);
	// cleared first: inbound headers are copied, so a client could forge this worker's decisions
	innerRequest.headers.delete(AUTH_REQUEST_HEADER);
	innerRequest.headers.delete(ABSORBED_HEADER);
	innerRequest.headers.delete(ATTEMPT_HEADER);
	// a lane forwards its writes elsewhere, so only the primary's serve route may be repeated
	const attempt =
		buffered !== undefined && inner.pathname === '/__serve' && laneOf().role !== 'replica'
			? crypto.randomUUID()
			: undefined;
	if (attempt !== undefined) innerRequest.headers.set(ATTEMPT_HEADER, attempt);
	// the count rides on a hop already paid for
	const absorbed = drainAbsorbed(site, serving);
	if (absorbed > 0) innerRequest.headers.set(ABSORBED_HEADER, String(absorbed));
	if (personalised) {
		// the object charges the allowance and reports the counter on this same response
		innerRequest.headers.set(AUTH_REQUEST_HEADER, '1');
	} else if (authenticated) {
		// stale mode: strip the session so the object answers the anonymous page (a cookie would
		// spend the very budget that has run out)
		innerRequest.headers.delete('cookie');
	}
	return { innerRequest, buffered, attempt };
}

/** sends the request to the object, retrying a reset once and handing a refusing lane to primary */
export async function sendHop(f: FrontContext, hop: HopRequest): Promise<Response | Hop> {
	const { env, site, laneOf, stubOf } = f;
	const { innerRequest, buffered, attempt } = hop;
	// built before the send (a refusing replica consumes the request); a body is rebuilt from
	// `buffered`, never cloned: an unread tee never releases and a forwarded POST hung forever
	const retryOnPrimary =
		laneOf().role !== 'replica'
			? undefined
			: buffered === undefined
				? innerRequest.clone()
				: new Request(innerRequest.url, {
						method: innerRequest.method,
						headers: innerRequest.headers,
						body: buffered,
						redirect: 'manual'
					});
	let res: Response;
	let retriedReset = false;
	const rebuilt = () =>
		buffered === undefined
			? new Request(innerRequest)
			: new Request(innerRequest.url, {
					method: innerRequest.method,
					headers: innerRequest.headers,
					body: buffered,
					redirect: 'manual'
				});
	try {
		res = await stubOf().fetch(innerRequest);
	} catch (e) {
		// a reset object throws out of the hop, and uncaught that is the visitor's 1101
		if (resetRecovery(e, innerRequest.method, attempt !== undefined) !== 'retry')
			return objectResetPage(innerRequest.method);
		f.forgetStub();
		retriedReset = true;
		try {
			res = await stubOf().fetch(rebuilt());
		} catch {
			return objectResetPage(innerRequest.method);
		}
	}
	// the repeat found its first try had started, so it may have been saved
	if (res.headers.get(ATTEMPT_HEADER) === 'started') return objectResetPage(innerRequest.method);
	if (retriedReset) {
		res = new Response(res.body, res);
		res.headers.set('x-cfw-retried', 'reset');
	}
	// the lane that handed back, so the header names the object that answered, not the routed one
	let failedOverFrom: number | undefined;
	// why it handed back (the retry discards the lane's response; only this names the refusal)
	let failoverReason: string | undefined;
	if (retryOnPrimary !== undefined && shouldFailover(res)) {
		failedOverFrom = laneOf().lane;
		failoverReason = res.headers.get('x-cfw-requires-primary') ?? undefined;
		// safety is the replica's `x-cfw-retry-safe` (`didMutate()`), never the status alone
		const primary = () => env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env));
		try {
			res = await primary().fetch(retryOnPrimary);
		} catch (e) {
			// the primary can reset for memory too; this hop gets its own one retry
			if (resetRecovery(e, innerRequest.method, attempt !== undefined) !== 'retry')
				return objectResetPage(innerRequest.method);
			try {
				res = await primary().fetch(rebuilt());
			} catch {
				return objectResetPage(innerRequest.method);
			}
			if (res.headers.get(ATTEMPT_HEADER) === 'started')
				return objectResetPage(innerRequest.method);
			res = new Response(res.body, res);
			res.headers.set('x-cfw-retried', 'reset');
		}
	}
	return { res, failedOverFrom, failoverReason };
}
