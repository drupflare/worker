import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { transformPath, type Transform } from '../../src/ops/image-transform';
import worker, { publicFileUri } from '../../src/site';
import { druplicon } from '../fixtures/png';

/**
 * The route a browser fetches a derivative from, driven end to end.
 *
 * THE CHAIN WAS COMPLETE AND NOTHING HAD EVER RUN IT. `CfwImageToolkit` calls `cfwImageUrl`, the
 * object builds a path with `transformPath()`, the front worker matches it and `serveImageTransform()`
 * reads the source through `/__filebytes` and hands it to the wasm encoder. `image-transform.spec.ts`
 * covers the pure path helpers; `image-toolkit.spec.ts` verifies derivative creation INSIDE the
 * object and never issues an HTTP request for one. So the last three links -- the route match, the
 * source read and the encode -- had no coverage at any level.
 *
 * That is the profile of the OIDC callback that answered 404 with 25 assertions covering the token
 * exchange, and of the compiled-plan tier that refused every render with 25 assertions covering the
 * compiler. A test that drives the producer is not a test that the consumer can reach it.
 */

const URI = 'public://cat.png';
const TRANSFORM: Transform = { width: 16, height: 16, fit: 'cover', format: 'webp' };

/** an object that answers `/__filebytes` with real image bytes and counts the reads */
function fileSpy(
	status = 200,
	body: Uint8Array | string = druplicon(),
	extra: Record<string, string> = {}
) {
	const seen: URL[] = [];
	const cookies: string[] = [];
	return {
		seen,
		cookies,
		namespace: {
			idFromName: (name: string) => ({ name, toString: () => name }),
			newUniqueId: () => ({ toString: () => 'unique' }),
			get: () => ({
				fetch: async (r: Request) => {
					const url = new URL(r.url);
					seen.push(url);
					cookies.push(r.headers.get('cookie') ?? '');
					if (status !== 200) return new Response('no\n', { status });
					return new Response(body, {
						status: 200,
						headers: { 'content-type': 'image/png', ...extra }
					});
				}
			})
		}
	};
}

async function get(path: string, namespace: unknown, headers: Record<string, string> = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`https://cfw.local${path}`, { headers }),
		{ ...env, SITE: namespace } as unknown as typeof env,
		ctx
	);
	const bytes = new Uint8Array(await res.arrayBuffer());
	await waitOnExecutionContext(ctx);
	return {
		status: res.status,
		bytes,
		tier: res.headers.get('x-cfw-image'),
		file: res.headers.get('x-cfw-file'),
		disposition: res.headers.get('content-disposition'),
		csp: res.headers.get('content-security-policy'),
		nosniff: res.headers.get('x-content-type-options'),
		contentType: res.headers.get('content-type'),
		cacheControl: res.headers.get('cache-control')
	};
}

describe('a derivative is delivered by the front worker', () => {
	it('produces one from the path the object hands out', async () => {
		const spy = fileSpy();
		const out = await get(transformPath(URI, TRANSFORM), spy.namespace);

		expect(out.status, 'the delivery route did not answer 200').toBe(200);
		// the encode happened rather than the source being passed through
		expect(out.contentType).toBe('image/webp');
		expect(out.bytes.byteLength).toBeGreaterThan(0);
		expect(out.bytes).not.toEqual(druplicon());
		// immutable is earned by the identity in the path: a style change mints a new one
		expect(out.cacheControl).toContain('immutable');

		// it read the source through the object, at the uri the path carried
		const asked = spy.seen.find((u) => u.pathname === '/__filebytes');
		expect(asked, 'the route never reached /__filebytes').toBeDefined();
		expect(asked?.searchParams.get('uri')).toBe(URI);
	});

	// the rendering lanes stored it on upload, so the front worker transforms nothing
	it('answers a stored derivative as it is, asking for it on the same read', async () => {
		const stored = new Uint8Array([1, 2, 3, 4]);
		const spy = fileSpy(200, stored, {
			'content-type': 'image/avif',
			'x-cfw-derivative': 'stored'
		});
		const path = transformPath('public://stored.png', TRANSFORM);
		const out = await get(path, spy.namespace);
		expect(out.tier).toBe('STORED');
		expect(out.contentType).toBe('image/avif');
		expect([...out.bytes]).toEqual([...stored]);
		expect(spy.seen[0]?.searchParams.get('derivative')).toBe(path.split('/')[2]);
		expect(spy.seen).toHaveLength(1);
	});

	it('carries the visitor cookie, because a private:// file is theirs to read or not', async () => {
		const spy = fileSpy();
		await get(transformPath('private://secret.png', TRANSFORM), spy.namespace, {
			cookie: 'SSESSabc=xyz'
		});
		expect(spy.cookies[0]).toBe('SSESSabc=xyz');
	});

	it('answers the second request without reading the source again', async () => {
		const spy = fileSpy();
		const path = transformPath('public://twice.png', TRANSFORM);
		const first = await get(path, spy.namespace);
		expect(first.tier).not.toBe('HIT');
		const reads = spy.seen.length;

		const second = await get(path, spy.namespace);
		expect(second.status).toBe(200);
		expect(second.tier).toBe('HIT');
		expect(spy.seen).toHaveLength(reads);
	});

	it('refuses a path whose identity was edited rather than doing the work', async () => {
		// the identity is re-derived and compared; without that, editing the query is a way to spend
		// the site's CPU on transforms nobody asked for
		const spy = fileSpy();
		const path = transformPath(URI, TRANSFORM).replace('w=16', 'w=32');
		const out = await get(path, spy.namespace);
		expect(out.status).toBe(404);
		expect(spy.seen).toHaveLength(0);
	});

	it('passes a refusal from the object through as a refusal', async () => {
		expect(
			(await get(transformPath('private://nope.png', TRANSFORM), fileSpy(403).namespace))
				.status
		).toBe(403);
		expect(
			(await get(transformPath('public://gone.png', TRANSFORM), fileSpy(404).namespace))
				.status
		).toBe(404);
	});

	it('does not answer 200 with something that is not an image', async () => {
		// the failure this project has shipped before is a 200 carrying the wrong bytes, then cached
		const out = await get(
			transformPath('public://broken.png', TRANSFORM),
			fileSpy(200, 'this is not a png').namespace
		);
		expect(out.status).not.toBe(200);
	});
});

// Drupal has no route for a public file, so on a deploy with no R2 mirror every original was its 404
describe('a public file is served by the front worker', () => {
	const fileReads = (seen: URL[]) =>
		seen.filter((u) => u.pathname === '/__filebytes').map((u) => u.searchParams.get('uri'));

	it('answers the stored bytes at the path Drupal links', async () => {
		const spy = fileSpy(200, 'a document', { 'content-type': 'application/pdf' });
		const out = await get('/sites/default/files/2026-09/report%20one.pdf', spy.namespace);
		expect(fileReads(spy.seen)).toEqual(['public://2026-09/report one.pdf']);
		expect(out.status).toBe(200);
		expect(new TextDecoder().decode(out.bytes)).toBe('a document');
		expect(out.file).toBe('STORED');
		expect(out.contentType).toBe('application/pdf');
		expect(out.disposition).toBe('attachment');

		const again = await get('/sites/default/files/2026-09/report%20one.pdf', spy.namespace);
		expect(again.status).toBe(200);
		expect(fileReads(spy.seen), 'the second read reached the object').toHaveLength(1);
	});

	// the file shares the site's origin, so an uploaded svg rendered inline runs script with its cookies
	it('renders a raster image inline and sends anything scriptable as a sandboxed download', async () => {
		const png = await get('/sites/default/files/photo.png', fileSpy().namespace);
		expect(png.disposition).toBeNull();
		expect(png.csp).toBeNull();
		expect(png.nosniff).toBe('nosniff');
		const svg = await get(
			'/sites/default/files/drawing.svg',
			fileSpy(200, '<svg onload="alert(1)"/>', { 'content-type': 'image/svg+xml' }).namespace
		);
		expect(svg.disposition).toBe('attachment');
		expect(svg.csp).toBe("sandbox; default-src 'none'");
		expect(svg.nosniff).toBe('nosniff');
	});

	it('falls through to Drupal for a file the site does not hold', async () => {
		const spy = fileSpy(404);
		await get('/sites/default/files/missing.png', spy.namespace);
		expect(fileReads(spy.seen)).toEqual(['public://missing.png']);
		expect(spy.seen.some((u) => u.pathname !== '/__filebytes')).toBe(true);
	});

	it('leaves image styles to Drupal and refuses a path that climbs out', async () => {
		const spy = fileSpy();
		await get('/sites/default/files/styles/thumbnail/public/a.png', spy.namespace);
		await get('/sites/default/files/..%2F..%2Fsettings.php.txt', spy.namespace);
		expect(fileReads(spy.seen)).toEqual([]);
		expect(publicFileUri('POST', '/sites/default/files/a.png')).toBeNull();
		expect(publicFileUri('GET', '/sites/default/files/a.png')).toBe('public://a.png');
	});
});
