import { EDGE_PAGE_TTL_S } from './edge-cache';
import {
	BodyLimitExceeded,
	bodyLimitFor,
	bodyTooLarge,
	phpEntryRedirect,
	readBounded
} from './guards';
import type { FrontContext } from './types';

function tooLarge(reason: string, limit: number): Response {
	return new Response(`${reason}\n`, {
		status: 413,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			'x-cfw-deny': 'body-too-large',
			'x-cfw-body-limit': String(limit)
		}
	});
}

/**
 * Refuses an oversized body before it reaches the object.
 *
 * Refused before the object (no DO request, no interpreter): `parse_str()` of a nested-array bomb
 * (`foo[][][]=bar`) costs far more heap than wire bytes. A declared length is checked first; a body
 * that declares none (chunked) is read here under the same ceiling, so the hop buffers what was
 * already counted.
 */
export async function refuseOversized(f: FrontContext): Promise<Response | undefined> {
	const { request, env } = f;
	const oversized = bodyTooLarge(request, env);
	if (oversized !== undefined) return tooLarge(oversized.reason, oversized.limit);

	const method = request.method.toUpperCase();
	if (method === 'GET' || method === 'HEAD' || request.body === null) return undefined;
	if (request.headers.get('content-length') !== null) return undefined;
	const limit = bodyLimitFor(request, env);
	if (limit === 0) return undefined;
	try {
		const body = await readBounded(request, limit);
		f.request = new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body
		});
	} catch (e) {
		if (e instanceof BodyLimitExceeded) return tooLarge(e.message, limit);
		throw e;
	}
	return undefined;
}

/** Answers a probe for a path Drupal can never serve, or redirects a core entry point. */
export function denyProbe(f: FrontContext, neverDrupal: boolean): Response | undefined {
	const { serving, path } = f;
	// a core entry point is a link a visitor followed, so it is answered before the deny below
	// (core links `/update.php` from the Extend page)
	const entryRedirect =
		serving && neverDrupal ? phpEntryRedirect(path.split(/[?#]/)[0] ?? '') : undefined;
	if (entryRedirect) {
		return new Response(null, {
			status: 302,
			headers: {
				location: entryRedirect,
				'x-cfw-cache': 'DENY',
				'x-cfw-deny': 'php-entry-point',
				'cache-control': `public, max-age=${EDGE_PAGE_TTL_S}`
			}
		});
	}

	// the cheapest request in the system
	if (serving && neverDrupal) {
		return new Response('not found\n', {
			status: 404,
			headers: {
				'x-cfw-cache': 'DENY',
				'x-cfw-deny': 'never-drupal',
				'cache-control': `public, max-age=${EDGE_PAGE_TTL_S}`
			}
		});
	}
	return undefined;
}
