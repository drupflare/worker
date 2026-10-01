import { IMAGE_ROUTE_PREFIX } from '../ops/image-runtime';
import { LOGIN_PATH } from '../ui/admin';
import {
	moduleAssetPath,
	publicFileUri,
	serveImageTransform,
	serveModuleAsset,
	servePublicFile
} from './files';
import { ownerCredential, withOwnerHeader } from './owner';
import { OWNER_ROUTES, PUBLIC_ROUTES, ROUTES, SURFACE_ROUTES } from './routes';
import type { FrontEntry } from './types';

/** Answers an image derivative, a stored public file or a delivered module asset, or nothing. */
export async function fileRoute(f: FrontEntry): Promise<Response | undefined> {
	const { request, url, env, ctx, internal } = f;
	// derivatives are answered here, not in the object (the decoder stays off PHP's heap), and
	// before the `/serve` rewrite because this path is its own route
	if (!internal && url.pathname.startsWith(`${IMAGE_ROUTE_PREFIX}/`) && ctx !== undefined) {
		return serveImageTransform(request, url, env, ctx);
	}
	if (
		!internal &&
		ctx !== undefined &&
		publicFileUri(request.method, url.pathname) !== undefined
	) {
		const served = await servePublicFile(request, url, env, ctx);
		if (served !== undefined) return served;
	}
	if (
		!internal &&
		ctx !== undefined &&
		moduleAssetPath(request.method, url.pathname) !== undefined
	) {
		const served = await serveModuleAsset(request, url, env, ctx);
		if (served !== undefined) return served;
	}
	return undefined;
}

/** Turns a page path into the `/serve` request it stands for; an unknown route answers 404. */
export function pageRewrite(f: FrontEntry): Response | undefined {
	let { request, url } = f;
	const { internal, resolvedSite } = f;
	// anything unclaimed is a page request, rewritten into the `/serve` it stands for so every tier
	// below is reached unchanged (`inner` is built from `request.url`, so replace the request too)
	if (!internal && !ROUTES.has(url.pathname)) {
		// the visitor's query must not choose the site (`?site=customer-b` would serve another
		// tenant's database), so the site resolved at the top is the only answer
		const rewritten = new URL(url.origin);
		rewritten.pathname = '/serve';
		rewritten.searchParams.set('site', resolvedSite);
		f.pageRequest = true;
		// built from the origin so the visitor's query stays inside `path`
		rewritten.searchParams.set('path', url.pathname + url.search);
		request = new Request(rewritten, request);
		url = rewritten;
		f.request = request;
		f.url = url;
	}

	if (!ROUTES.has(url.pathname)) {
		return new Response('not found\n', { status: 404 });
	}
	return undefined;
}

/** Gates an owner or diagnostic route behind its credential; a public route passes through. */
export async function ownerRoute(f: FrontEntry): Promise<Response | undefined> {
	let { request } = f;
	const { url, env } = f;
	// the admin surface is not a diagnostic, so `PW_DIAGNOSTICS` is not a way into it
	const surface = SURFACE_ROUTES.has(url.pathname);
	let ownerToken: string | undefined;
	if (surface || (!PUBLIC_ROUTES.has(url.pathname) && env?.PW_DIAGNOSTICS !== '1')) {
		// an owner route takes a credential, not the diagnostics flag (`/export` must not need
		// the `/sql` and `/restore` mode)
		if (OWNER_ROUTES.has(url.pathname)) {
			ownerToken = await ownerCredential(request, env, url);
			if (ownerToken === undefined) {
				if (surface) {
					// a browser gets the sign-in page, not a 401 body it would render as text
					const to = new URL(LOGIN_PATH, url.origin);
					to.searchParams.set('next', url.pathname + url.search);
					return new Response(null, {
						status: 302,
						headers: { location: to.toString(), 'cache-control': 'no-store' }
					});
				}
				// 401 with a challenge, not the 404 a diagnostic gets (the route exists)
				return new Response('owner token required\n', {
					status: 401,
					headers: {
						'www-authenticate': 'Bearer realm="drupflare"',
						'content-type': 'text/plain; charset=utf-8'
					}
				});
			}
			request = withOwnerHeader(request, ownerToken);
			f.ownerToken = ownerToken;
			f.request = request;
		} else {
			return new Response('not found\n', { status: 404 });
		}
	}
	return undefined;
}
