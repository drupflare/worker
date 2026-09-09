import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { transformPath, type Transform } from '../../src/ops/image-transform';
import worker from '../../src/site';
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
function fileSpy(status = 200, body: Uint8Array | string = druplicon()) {
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
						headers: { 'content-type': 'image/png' }
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
