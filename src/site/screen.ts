import { EDGE_PAGE_TTL_S } from './edge-cache';
import { bodyTooLarge, phpEntryRedirect } from './guards';
import type { FrontContext } from './types';

/** Refuses an oversized body before it reaches the interpreter. */
export function refuseOversized(f: FrontContext): Response | undefined {
	const { request, env } = f;
	// refused before the object (no DO request, no interpreter): `parse_str()` of a nested-array
	// bomb (`foo[][][]=bar`) costs far more heap than wire bytes; multipart is exempt
	const oversized = bodyTooLarge(request, env);
	if (oversized !== undefined) {
		return new Response(`${oversized.reason}\n`, {
			status: 413,
			headers: {
				'content-type': 'text/plain; charset=utf-8',
				'cache-control': 'no-store',
				'x-cfw-deny': 'body-too-large',
				'x-cfw-body-limit': String(oversized.limit)
			}
		});
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
