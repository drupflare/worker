import { normaliseUri } from '../db/file-store';
import { parseTransformPath, runImageTransform } from '../ops/image-runtime';
import { resolveSite, siteStubOptions } from '../ops/site-id';
import { errorMessage } from '../util/errors';
import type { SiteWorkerEnv } from './types';

// image derivatives are produced in the front worker, not the object: the decoder is a second wasm
// module (1 MiB initial, 4 MiB after 56 transforms) and would share an isolate with PHP's memory
const PUBLIC_FILES = '/sites/default/files/';
const INLINE_FILE_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/avif'
]);

/**
 * The `public://` uri a GET for a public file names, or undefined.
 *
 * Drupal expects the web server to answer these from disk and has no route for them, so without
 * this every public original is a 404 (unless the optional R2 mirror is configured). `styles/`
 * stays Drupal's, because its image style controller owns that prefix.
 */
export function publicFileUri(method: string, pathname: string): string | undefined {
	if (method !== 'GET' && method !== 'HEAD') return undefined;
	if (!pathname.startsWith(PUBLIC_FILES) || pathname.startsWith(`${PUBLIC_FILES}styles/`)) {
		return undefined;
	}
	let rest: string;
	try {
		rest = decodeURIComponent(pathname.slice(PUBLIC_FILES.length));
	} catch {
		return undefined;
	}
	return normaliseUri(`public://${rest}`);
}

const MODULE_ASSET_ROOTS = ['/modules/', '/themes/', '/profiles/', '/libraries/'];
const MODULE_ASSET_TYPES: Record<string, string> = {
	css: 'text/css; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	svg: 'image/svg+xml'
};

/**
 * The stored-source path a GET for a module, theme, profile or library asset names, or undefined.
 *
 * The pack's own files are published by the asset layer and never reach the Worker, so a request
 * that does is a site-delivered asset or a 404. Text types only: `cfw_module_file.source` is TEXT.
 */
export function moduleAssetPath(method: string, pathname: string): string | undefined {
	if (method !== 'GET' && method !== 'HEAD') return undefined;
	if (!MODULE_ASSET_ROOTS.some((root) => pathname.startsWith(root))) return undefined;
	let path: string;
	try {
		path = decodeURIComponent(pathname).slice(1);
	} catch {
		return undefined;
	}
	if (/[\0\\]|\/\/|(^|\/)\.\.?(\/|$)/.test(path)) return undefined;
	const type = MODULE_ASSET_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
	return type === undefined ? undefined : path;
}

/** the edge cache, then the site object, for a file route; undefined falls through to Drupal */
async function serveFromObject(
	request: Request,
	url: URL,
	env: SiteWorkerEnv,
	ctx: ExecutionContext,
	objectPath: string,
	build: (source: Response) => Response
): Promise<Response | undefined> {
	const cache = caches.default;
	const key = new Request(url.toString(), { method: 'GET' });
	const cached = await cache.match(key);
	if (cached) return request.method === 'HEAD' ? new Response(null, cached) : cached;

	const { site } = await resolveSite(url, env, { allowParam: false });
	const stub = env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env));
	const source = await stub.fetch(new Request(`https://do.local/${objectPath}`));
	if (!source.ok) {
		await source.body?.cancel();
		return undefined;
	}
	const response = build(source);
	ctx.waitUntil(cache.put(key, response.clone()));
	return request.method === 'HEAD' ? new Response(null, response) : response;
}

/** a delivered module asset, or undefined so the request falls through to Drupal */
export async function serveModuleAsset(
	request: Request,
	url: URL,
	env: SiteWorkerEnv,
	ctx: ExecutionContext
): Promise<Response | undefined> {
	const path = moduleAssetPath(request.method, url.pathname);
	if (path === undefined) return undefined;
	return serveFromObject(
		request,
		url,
		env,
		ctx,
		`__moduleasset?path=${encodeURIComponent(path)}`,
		(source) =>
			new Response(source.body, {
				status: 200,
				headers: {
					'content-type':
						MODULE_ASSET_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()]!,
					// short, because a module update replaces the file under the same path
					'cache-control': 'public, max-age=300',
					'x-content-type-options': 'nosniff',
					'x-cfw-file': 'MODULE'
				}
			})
	);
}

/** a stored public file, or undefined so the request falls through to Drupal */
export async function servePublicFile(
	request: Request,
	url: URL,
	env: SiteWorkerEnv,
	ctx: ExecutionContext
): Promise<Response | undefined> {
	const uri = publicFileUri(request.method, url.pathname);
	if (uri === undefined) return undefined;
	return serveFromObject(
		request,
		url,
		env,
		ctx,
		`__filebytes?uri=${encodeURIComponent(uri)}`,
		(source) => {
			const type = source.headers.get('content-type') ?? 'application/octet-stream';
			const headers = new Headers({
				'content-type': type,
				// short, because a file can be replaced under the same uri
				'cache-control': 'public, max-age=300',
				'x-content-type-options': 'nosniff',
				'x-cfw-file': 'STORED'
			});
			// an upload shares the site's origin, so script-capable types (svg, html) download in a
			// sandbox rather than render beside the session cookie
			if (!INLINE_FILE_TYPES.has(type.split(';', 1)[0]!.trim().toLowerCase())) {
				headers.set('content-disposition', 'attachment');
				headers.set('content-security-policy', "sandbox; default-src 'none'");
			}
			return new Response(source.body, { status: 200, headers });
		}
	);
}

/** an image derivative; 404 on a doctored identity, 415 on an undecodable source */
export async function serveImageTransform(
	request: Request,
	url: URL,
	env: SiteWorkerEnv,
	ctx: ExecutionContext
): Promise<Response> {
	const parsed = parseTransformPath(url.pathname, url.search);
	// a re-derived identity that does not match means the query was edited, which is a way to spend
	// the site's CPU on work nobody asked for
	if (parsed === null) return new Response('not found\n', { status: 404 });

	const cache = caches.default;
	const cached = await cache.match(new Request(url.toString(), { method: 'GET' }));
	if (cached) {
		const headers = new Headers(cached.headers);
		headers.set('x-cfw-image', 'HIT');
		return new Response(cached.body, { status: cached.status, headers });
	}

	const { site } = await resolveSite(url, env, { allowParam: false });
	const stub = env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env));
	const source = await stub.fetch(
		new Request(
			`https://do.local/__filebytes?uri=${encodeURIComponent(parsed.uri)}&derivative=${parsed.id}`,
			// the visitor's cookie, because a `private://` file is theirs to read or not
			{ headers: { cookie: request.headers.get('cookie') ?? '' } }
		)
	);
	if (!source.ok) {
		return new Response('not found\n', { status: source.status === 403 ? 403 : 404 });
	}
	// rendered on upload by the rendering lanes, so there is nothing left to do here
	if (source.headers.get('x-cfw-derivative') === 'stored') {
		const response = new Response(source.body, {
			status: 200,
			headers: {
				'content-type': source.headers.get('content-type') ?? 'application/octet-stream',
				'cache-control': 'public, max-age=31536000, immutable',
				'x-cfw-image': 'STORED'
			}
		});
		ctx.waitUntil(cache.put(new Request(url.toString()), response.clone()));
		return response;
	}

	try {
		const bytes = new Uint8Array(await source.arrayBuffer());
		const out = await runImageTransform(bytes, parsed.transform);
		const headers = new Headers({
			'content-type': out.contentType,
			// immutable: a style change mints a new path, so a stored derivative never goes stale
			'cache-control': 'public, max-age=31536000, immutable',
			'x-cfw-image': 'RENDER',
			'x-cfw-image-engine': 'tinyimg'
		});
		const response = new Response(out.bytes, { status: 200, headers });
		ctx.waitUntil(cache.put(new Request(url.toString()), response.clone()));
		return response;
	} catch (e: unknown) {
		// a source this decoder cannot read is a 415 rather than a 500: the request was well formed
		// and the file is what it could not handle
		return new Response(`cannot transform: ${errorMessage(e)}\n`, {
			status: 415,
			headers: { 'content-type': 'text/plain; charset=utf-8' }
		});
	}
}
