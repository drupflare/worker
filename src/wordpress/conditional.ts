import { cmsOf } from '../util/cms';

/** the `Cache-Control` a stored page answers with; a response saying anything else is not one */
const STORED_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/** the answers that replay a stored page; `AGED` and a previous generation are left out on purpose */
const STORED_TIERS = new Set(['HIT', 'EDGE', 'MEM', 'RENDER']);

/** the validator of a stored WordPress page answer, or undefined when it has none */
export function pageEtag(res: Response): string | undefined {
	if (res.status !== 200) return undefined;
	if (res.headers.has('set-cookie') || res.headers.has('etag')) return undefined;
	if (res.headers.get('cache-control') !== STORED_CACHE_CONTROL) return undefined;
	if (!STORED_TIERS.has(res.headers.get('x-cfw-cache') ?? '')) return undefined;
	if (res.headers.get('x-cfw-edge') === 'STALE') return undefined;
	const renderedAt = res.headers.get('x-cfw-rendered-at');
	return renderedAt !== null && /^[0-9]{1,16}$/.test(renderedAt)
		? `"wp-${renderedAt}"`
		: undefined;
}

/**
 * Gives a stored WordPress page a strong validator, the time its row was rendered.
 *
 * It runs inside the spool wrapper. Spool weakens a strong `ETag` when it changes the body, so the
 * decorated form of a page carries `W/"wp-..."` and the plain form `"wp-..."`. A refill changes the
 * render time, and a stale answer carries none, so a client holding a superseded copy always fetches.
 */
export function withValidator(env: unknown, res: Response): Response {
	if (cmsOf(env) !== 'wordpress') return res;
	const etag = pageEtag(res);
	if (etag === undefined) return res;
	const headers = new Headers(res.headers);
	headers.set('etag', etag);
	return new Response(res.body, { status: res.status, headers });
}

/** the tags in an `If-None-Match` value, exactly as the client sent them */
function listed(header: string): string[] {
	return header
		.split(',')
		.map((v) => v.trim())
		.filter((v) => v !== '');
}

/**
 * Answers a conditional request for a stored WordPress page with 304 when the client names the
 * validator the response carries.
 *
 * It runs outside the spool wrapper, where the form of the body is known, and compares tags
 * exactly, weak prefix included. A copy held in one form never validates the other: a browser that
 * kept a decorated page and meets the plain one, or the reverse, fetches the page again.
 */
export function answerConditional(request: Request, env: unknown, res: Response): Response {
	if (cmsOf(env) !== 'wordpress') return res;
	if (request.method !== 'GET' && request.method !== 'HEAD') return res;
	const etag = res.headers.get('etag');
	const asked = request.headers.get('if-none-match');
	if (res.status !== 200 || etag === null || !/^(W\/)?"wp-[0-9]{1,16}"$/.test(etag)) return res;
	if (asked === null || !listed(asked).some((v) => v === etag || v === '*')) return res;
	const headers = new Headers(res.headers);
	for (const name of [
		'content-length',
		'content-encoding',
		'transfer-encoding',
		'content-type'
	]) {
		headers.delete(name);
	}
	return new Response(null, { status: 304, headers });
}
