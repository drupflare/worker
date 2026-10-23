import { memoryImageCache, tinyimgEncoder } from '@drupflare/spool/media';
import type { VectorDiff } from '@drupflare/spool/protocol';
import { spoolProxy, type SpoolProxy } from '@drupflare/spool/proxy';
import type { VersionStore } from '@drupflare/spool/stores';
import { AsyncLocalStorage } from 'node:async_hooks';
import { tinyimgBinding } from '../ops/image-runtime';
import { spoolEnabled, spoolFeature } from '../ops/plan';
import { siteStubOptions } from '../ops/site-id';
import { isSpoolPath, SPOOL_OBJECT_PATH, spoolAllowed, spoolCursorFloor } from '../ops/spool';
import { ROUTES } from './routes';
import type { SiteWorkerEnv } from './types';

/** the page pipeline: the front worker's own handler, which spool fronts */
export type Next = (request: Request) => Promise<Response>;

/** what one request tells the shared proxy: how to reach the pipeline and the site's object */
type Call = {
	next: Next;
	env: SiteWorkerEnv;
	site: string;
	/** the generation the pipeline's response carried, which bounds the cursor from below */
	generation?: number;
	/** a failure of the pipeline, kept so the front worker's own error handling still sees it */
	failure?: unknown;
};

const calls = new AsyncLocalStorage<Call>();
const current = (): Call => {
	const call = calls.getStore();
	if (call === undefined) throw new Error('spool ran outside a request');
	return call;
};

const GENERATION_HEADER = 'x-cfw-generation';

/** converted images, shared by every site in the isolate: a key is the hash of the bytes */
const converted = memoryImageCache(24 * 1024 * 1024);

/** the proxy for one site and feature set; built once, because its counters live in it */
const proxies = new Map<string, SpoolProxy>();
const MAX_PROXIES = 32;

/** a diff taken for a (site, cursor), reused for a moment so a piggybacked sync costs one object request, not one per page */
const diffs = new Map<string, { diff: VectorDiff; at: number }>();
const MAX_DIFFS = 256;
const DIFF_TTL_MS = 2_000;

/** drops every remembered diff and proxy; for the specs */
export function resetSpoolMemo(): void {
	diffs.clear();
	proxies.clear();
}

/**
 * The version vector, read from the site's object.
 *
 * A page carries the generation it was rendered at, and the cursor for that generation's floor is
 * never above the object's own, so decorating a page asks the object nothing. A sync asks for the
 * diff, and the answer is kept for two seconds: a change inside that window reaches a device on
 * its next sync, because the cursor it takes away is the older one. `bump` records nothing: the
 * object's own purge is the only writer, so a page whose body changed with no tag moving is not
 * announced.
 */
function objectVersionStore(): VersionStore {
	const ask = async (query: string): Promise<Record<string, unknown>> => {
		const { env, site } = current();
		const inner = new URL('https://spool.internal');
		inner.pathname = SPOOL_OBJECT_PATH;
		inner.search = query;
		const res = await env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env)).fetch(
			new Request(inner)
		);
		if (!res.ok) throw new Error(`spool vector answered ${res.status}`);
		return (await res.json()) as Record<string, unknown>;
	};
	const cursor = async (): Promise<number> => {
		const { generation } = current();
		return generation !== undefined
			? spoolCursorFloor(generation)
			: Number((await ask('op=cursor'))['cursor']);
	};
	return {
		cursor,
		bump: cursor,
		diff: async (from) => {
			const key = `${current().site}:${from}`;
			const held = diffs.get(key);
			if (held !== undefined && Date.now() - held.at < DIFF_TTL_MS) return held.diff;
			const diff = (await ask(`op=diff&from=${from}`)) as unknown as VectorDiff;
			if (diffs.size >= MAX_DIFFS) diffs.clear();
			diffs.set(key, { diff, at: Date.now() });
			return diff;
		}
	};
}

/**
 * The width of a PNG or JPEG, read from its header, or undefined for anything else. A JPEG's
 * start-of-frame marker holds it; a PNG's IHDR does.
 */
export function intrinsicWidth(bytes: Uint8Array): number | undefined {
	if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
		return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
	}
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
	let at = 2;
	while (at + 9 < bytes.length) {
		if (bytes[at] !== 0xff) {
			at++;
			continue;
		}
		const marker = bytes[at + 1]!;
		if (marker === 0xff) {
			at++;
			continue;
		}
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			at += 2;
			continue;
		}
		if (
			marker >= 0xc0 &&
			marker <= 0xcf &&
			marker !== 0xc4 &&
			marker !== 0xc8 &&
			marker !== 0xcc
		) {
			return (bytes[at + 7]! << 8) | bytes[at + 8]!;
		}
		at += 2 + ((bytes[at + 2]! << 8) | bytes[at + 3]!);
	}
	return undefined;
}

/**
 * The encoder's options with a width the image already meets taken out. tinyimg 1.1.1 enlarges an
 * image to the width it is given even with `fit: 'scale-down'`, so a 900 px photo asked for 2,560
 * came back larger than it went in and was left as a JPEG.
 */
export function withoutUpscale<T extends { width?: number }>(input: Uint8Array, options: T): T {
	const own = intrinsicWidth(input);
	if (options.width === undefined || own === undefined || options.width < own) return options;
	const { width: _width, ...rest } = options;
	return rest as T;
}

const clip = (value: string | undefined, max = 256): string =>
	(value ?? '').replace(/[\r\n\0]/g, ' ').slice(0, max);

const MAX_LOGGED_EVENTS = 50;

function proxyFor(call: Call, origin: string): SpoolProxy {
	const images = spoolFeature(call.env, 'SPOOL_IMAGES');
	const video = spoolFeature(call.env, 'SPOOL_VIDEO');
	const embeds = spoolFeature(call.env, 'SPOOL_EMBEDS');
	const key = `${call.site}|${origin}|${Number(images)}${Number(video)}${Number(embeds)}`;
	const held = proxies.get(key);
	if (held !== undefined) return held;
	if (proxies.size >= MAX_PROXIES) proxies.clear();
	const built = spoolProxy({
		origin,
		fetch: async (request) => {
			const active = current();
			try {
				const res = await active.next(request);
				const generation = Number(res.headers.get(GENERATION_HEADER));
				if (Number.isSafeInteger(generation) && generation > 0)
					active.generation = generation;
				return res;
			} catch (e) {
				active.failure = e;
				throw e;
			}
		},
		spool: {
			store: objectVersionStore(),
			sink: {
				write: (events) => {
					// the body is the visitor's, so what reaches a log line is bounded and has no breaks
					for (const event of events.slice(0, MAX_LOGGED_EVENTS)) {
						console.log(
							'cfw-spool',
							JSON.stringify({
								path: clip(event.path),
								search: clip(event.search),
								at: event.at,
								body: clip(event.body, 1024)
							})
						);
					}
				}
			}
		},
		...(images
			? {
					images: {
						encoder: (
							input: Uint8Array,
							options: Parameters<ReturnType<typeof tinyimgEncoder>>[1]
						) =>
							tinyimgEncoder(tinyimgBinding())(input, withoutUpscale(input, options)),
						cache: converted
					}
				}
			: {}),
		...(video ? { video: { preload: 'none' as const } } : {}),
		...(embeds ? { embeds: {} } : {})
	});
	proxies.set(key, built);
	return built;
}

/**
 * Whether a request goes through spool at all. Owner and diagnostic routes, the object's own `__`
 * paths and every request that carries a credential skip it: spool keeps public pages and rewrites
 * public responses, and a signed-in visitor gets the site as it was.
 */
function eligible(request: Request, url: URL): boolean {
	if (isSpoolPath(url.pathname)) return true;
	if (request.method !== 'GET' && request.method !== 'HEAD') return false;
	if (url.pathname.startsWith('/__') || ROUTES.has(url.pathname)) return false;
	return !request.headers.has('cookie') && !request.headers.has('authorization');
}

/**
 * Answers a request through spool when it applies, and through the page pipeline alone otherwise.
 *
 * Spool answers `/spool-sw.js` and `/.spool/*` itself, decorates an eligible page so a device can
 * keep it, converts an image the browser can take as WebP, and rewrites a page's video tags and
 * embeds. The pipeline runs underneath unchanged, so every cache tier is the one a visitor met
 * before spool existed and no stored page is a decorated one.
 */
export async function throughSpool(
	request: Request,
	env: SiteWorkerEnv,
	site: string,
	next: Next
): Promise<Response> {
	const url = new URL(request.url);
	if (!spoolEnabled(env) || !eligible(request, url)) return next(request);
	// public and unauthenticated, and each call is a Worker request, so a budget comes first
	if (
		isSpoolPath(url.pathname) &&
		!spoolAllowed(request.headers.get('cf-connecting-ip') ?? 'unknown', Date.now())
	) {
		return new Response(null, {
			status: 429,
			headers: { 'retry-after': '60', 'cache-control': 'no-store' }
		});
	}
	const call: Call = { next, env, site };
	const res = await calls.run(call, () => proxyFor(call, url.origin)(request)); // the proxy turns a pipeline failure into a 502; the front worker reports the real one
	if (call.failure !== undefined) throw call.failure;
	return res;
}
