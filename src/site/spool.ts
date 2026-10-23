import { ProtocolError, type VectorDiff } from '@drupflare/spool/protocol';
import { createSpool, defineRoute, type Spool } from '@drupflare/spool/server';
import type { VersionStore } from '@drupflare/spool/stores';
import { spoolMode } from '../ops/plan';
import { siteStubOptions } from '../ops/site-id';
import {
	isSpoolPath,
	pathTagFor,
	SPOOL_OBJECT_PATH,
	SPOOL_SW_PATH,
	spoolAllowed
} from '../ops/spool';
import type { FrontEntry, SiteWorkerEnv } from './types';

/** reaches the page pipeline for an artifact load, with a request that carries no visitor */
export type Next = (request: Request) => Promise<Response>;

const GENERATION_HEADER = 'x-cfw-generation';
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_LOGGED_EVENTS = 50;

const clip = (value: string | undefined, max = 256): string =>
	(value ?? '').replace(/[\r\n\0]/g, ' ').slice(0, max);

/** the answers an isolate may reuse: a diff is fixed for a (site, cursor) until the generation moves */
const diffs = new Map<string, VectorDiff>();
const MAX_DIFFS = 256;

/** drops every remembered diff; for the specs */
export const resetSpoolMemo = (): void => diffs.clear();

/**
 * The version vector, read from the site's object.
 *
 * `known` is the generation a page response already carries, so a request with no sync to answer
 * costs no object request. A diff is remembered while the generation it was taken at is still the
 * one a response carries, so a device that piggybacks a sync on every navigation costs one object
 * request per cursor and generation rather than one per page. `bump` records nothing: the object's
 * own purge is the only writer.
 */
function objectVersionStore(env: SiteWorkerEnv, site: string, known?: number): VersionStore {
	const ask = async (query: string): Promise<Record<string, unknown>> => {
		const inner = new URL('https://spool.internal');
		inner.pathname = SPOOL_OBJECT_PATH;
		inner.search = query;
		const res = await env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env)).fetch(
			new Request(inner)
		);
		if (!res.ok) throw new Error(`spool vector answered ${res.status}`);
		return (await res.json()) as Record<string, unknown>;
	};
	const cursor = async (): Promise<number> => known ?? Number((await ask('op=cursor'))['cursor']);
	return {
		cursor,
		bump: cursor,
		diff: async (from) => {
			const key = `${site}:${from}`;
			const held = diffs.get(key);
			if (held !== undefined && known !== undefined && held.cursor === known) return held;
			const diff = (await ask(`op=diff&from=${from}`)) as unknown as VectorDiff;
			if (diffs.size >= MAX_DIFFS) diffs.clear();
			diffs.set(key, diff);
			return diff;
		}
	};
}

/**
 * The first reason a response may not be answered from a device, or undefined.
 *
 * Mirrors `decline` in `@drupflare/spool/proxy` for the cases a Drupal page can hit (that module is
 * not imported: it carries the image, video and stylesheet rewriters, which add about 20 KiB
 * gzipped to the Worker for nothing this uses).
 */
export function declined(request: Request, res: Response): string | undefined {
	if (request.method !== 'GET') return 'method';
	if (new URL(request.url).search !== '') return 'query';
	if (request.headers.has('authorization') || request.headers.has('cookie')) return 'visitor';
	if (res.status !== 200) return 'status';
	const type = (res.headers.get('content-type') ?? '').toLowerCase();
	if (!type.includes('text/html')) return 'type';
	const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1];
	if (charset !== undefined && !['utf-8', 'utf8'].includes(charset)) return 'charset';
	if (res.headers.has('set-cookie') || res.headers.has('content-encoding')) return 'header';
	const control = (res.headers.get('cache-control') ?? '')
		.split(',')
		.map((part) => (part.split('=')[0] ?? '').trim().toLowerCase());
	if (control.includes('private') || control.includes('no-store')) return 'cache-control';
	const vary = (res.headers.get('vary') ?? '')
		.split(',')
		.map((name) => name.trim().toLowerCase())
		.filter((name) => name !== '');
	if (vary.some((name) => name !== 'accept-encoding' && name !== 'cookie')) return 'vary';
	const length = Number(res.headers.get('content-length'));
	if (Number.isFinite(length) && length > MAX_PAGE_BYTES) return 'size';
	return undefined;
}

/** a spool for one request: shadow mode, one public catch-all route, a console sink */
function spoolFor(env: SiteWorkerEnv, site: string, next: Next, known?: number): Spool {
	return createSpool({
		routes: [
			defineRoute('/**', {
				strategy: 'assembly',
				scope: 'public',
				depends: (ctx) => [pathTagFor(ctx.url.pathname)],
				load: async (ctx) => {
					const res = await next(
						new Request(new URL(ctx.url.pathname, ctx.url.origin), {
							headers: { accept: 'text/html' }
						})
					);
					const why = declined(new Request(ctx.url), res);
					if (why !== undefined) {
						throw new ProtocolError(
							'bad-artifact',
							`${ctx.url.pathname} is not kept (${why})`
						);
					}
					return { shell: await res.text() };
				}
			})
		],
		store: objectVersionStore(env, site, known),
		mode: 'shadow',
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
	});
}

/**
 * `/.spool/*` and `/spool-sw.js` while the mode is `shadow`: the library answers them and an
 * artifact it loads goes through the same pipeline a visitor's request takes.
 *
 * With the mode `off` this declines, and the path falls through to the page pipeline as any other.
 */
export async function spoolRoute(f: FrontEntry, next: Next): Promise<Response | undefined> {
	const { request, url, env, resolvedSite } = f;
	if (f.internal || !isSpoolPath(url.pathname) || spoolMode(env) === 'off') return undefined;
	// public and unauthenticated, and each call is a Worker request, so a budget comes first
	if (!spoolAllowed(request.headers.get('cf-connecting-ip') ?? 'unknown', Date.now())) {
		return new Response(null, {
			status: 429,
			headers: { 'retry-after': '60', 'cache-control': 'no-store' }
		});
	}
	const spool = spoolFor(env, resolvedSite, next);
	const answered = await spool.respond(request);
	if (answered !== undefined) return answered;
	if (url.pathname === SPOOL_SW_PATH && request.method === 'GET') return spool.stub();
	return new Response('not found\n', { status: 404 });
}

/**
 * Adds the envelope and the client tag to an eligible page, or returns the response unchanged.
 *
 * It runs after the cache tiers, so a stored page is never the decorated one.
 */
export async function spoolDecorate(
	request: Request,
	env: SiteWorkerEnv,
	site: string,
	res: Response
): Promise<Response> {
	if (spoolMode(env) === 'off' || declined(request, res) !== undefined) return res;
	const generation = Number(res.headers.get(GENERATION_HEADER));
	const known = Number.isSafeInteger(generation) && generation > 0 ? generation : undefined;
	const spool = spoolFor(
		env,
		site,
		() => Promise.reject(new Error('no artifact load here')),
		known
	);
	return spool.decorate(request, res, known === undefined ? {} : { vector: known });
}
