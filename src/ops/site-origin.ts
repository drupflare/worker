/**
 * The origin Drupal renders against, which is not simply the `Host` header (a forged host could
 * move a password-reset link or poison a path-keyed cache), so it is a property of the site.
 *
 * Order: `SITE_ORIGIN` (deploy time, wins outright), the pin in `cfw_meta` (trust on first use,
 * re-pinned by `/firstrun`), the observed origin, then `http://localhost`.
 * @module
 */

/** what a site renders against when nothing else answered */
export const FALLBACK_ORIGIN = 'http://localhost';

/** the `cfw_meta` key the pin lives under */
export const ORIGIN_KEY = 'site_origin';

/** which layer produced the origin, so a caller can report why */
export type OriginSource = 'var' | 'pinned' | 'observed' | 'fallback';

/** the chosen origin and the layer it came from */
export interface OriginChoice {
	origin: string;
	from: OriginSource;
}

/**
 * A bare `scheme://host[:port]`, or undefined when the input names no host.
 *
 * Drops everything after the authority and assumes `https` for a bare hostname. Only http and
 * https are accepted (an allowlist: `javascript:` must not reach a form action).
 */
export function normaliseOrigin(raw: string | null | undefined): string | undefined {
	const text = String(raw ?? '').trim();
	if (text === '') return undefined;
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
	if (url.hostname === '') return undefined;
	return url.origin;
}

/**
 * Picks the origin, in the order documented on this module.
 *
 * @param input - each layer as read; an unusable value falls through (a var typo must not take a
 *   site down)
 */
export function chooseOrigin(input: {
	configured?: string;
	// metaGet answers null for a missing row
	pinned?: string | null;
	observed?: string;
}): OriginChoice {
	const configured = normaliseOrigin(input.configured);
	if (configured !== undefined) return { origin: configured, from: 'var' };

	const pinned = normaliseOrigin(input.pinned);
	if (pinned !== undefined) return { origin: pinned, from: 'pinned' };

	const observed = normaliseOrigin(input.observed);
	if (observed !== undefined) return { origin: observed, from: 'observed' };

	return { origin: FALLBACK_ORIGIN, from: 'fallback' };
}

/**
 * Whether an observed origin is worth pinning.
 *
 * A local origin is not (pinning one would fix a real site's canonical URL to a laptop when a
 * suite runs against a persisted object).
 */
export function pinnable(origin: string | undefined): boolean {
	const normalised = normaliseOrigin(origin);
	if (normalised === undefined) return false;
	const host = new URL(normalised).hostname.replace(/^\[|\]$/g, '');
	return !LOCAL_HOSTS.has(host);
}

/** the same set `site-id.ts` refuses to derive a site identity from, for the same reason */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'do.local']);

/** response types whose bodies can carry an absolute URL worth rewriting */
const REWRITABLE_TYPE = /^text\/|json|xml|javascript/i;

/**
 * A response rendered against the canonical origin, re-addressed to an alias host.
 *
 * One stored copy serves every host, so the alias visitor's body URLs (plain and JSON-escaped), a
 * `Location` and the cookie `Domain` (a browser refuses it from another host) move to its host.
 * The session cookie name stays canonical so one session works on every alias. The body is
 * rewritten as a stream, so BigPipe still arrives progressively.
 */
export function aliasRewrite(res: Response, canonical: string, visitor: string): Response {
	const from = new URL(canonical);
	const to = new URL(visitor);
	const headers = new Headers(res.headers);
	const location = headers.get('location');
	if (location !== null && location.startsWith(from.origin)) {
		headers.set('location', to.origin + location.slice(from.origin.length));
	}
	const cookies = headers.getSetCookie();
	if (cookies.length > 0) {
		headers.delete('set-cookie');
		const domain = new RegExp(
			`;\\s*domain=\\.?${from.hostname.replace(/\./g, '\\.')}(?=;|$)`,
			'i'
		);
		for (const line of cookies)
			headers.append('set-cookie', line.replace(domain, `; Domain=.${to.hostname}`));
	}
	headers.set('x-cfw-alias', from.host);
	const type = headers.get('content-type') ?? '';
	if (res.body === null || !REWRITABLE_TYPE.test(type)) {
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
	}
	headers.delete('content-length');
	const pairs: [string, string][] = [
		[from.origin, to.origin],
		[from.origin.replace(/\//g, '\\/'), to.origin.replace(/\//g, '\\/')]
	];
	const body = res.body
		.pipeThrough(new TextDecoderStream())
		.pipeThrough(replaceStream(pairs))
		.pipeThrough(new TextEncoderStream());
	return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Replaces every needle across chunk boundaries.
 *
 * A match that starts before the last `longest - 1` characters of the buffered text lies wholly
 * inside it; anything later is held back and scanned again with the next chunk.
 */
export function replaceStream(pairs: [string, string][]): TransformStream<string, string> {
	const keep = Math.max(...pairs.map(([a]) => a.length)) - 1;
	let tail = '';
	const scan = (text: string, safe: number): [string, number] => {
		let out = '';
		let i = 0;
		for (;;) {
			let at = -1;
			let pair: [string, string] | undefined;
			for (const p of pairs) {
				const j = text.indexOf(p[0], i);
				if (j !== -1 && (at === -1 || j < at)) [at, pair] = [j, p];
			}
			if (pair === undefined || at >= safe) break;
			out += text.slice(i, at) + pair[1];
			i = at + pair[0].length;
		}
		const end = Math.max(i, safe);
		return [out + text.slice(i, end), end];
	};
	return new TransformStream({
		transform(chunk, ctl) {
			const text = tail + chunk;
			const [out, end] = scan(text, Math.max(0, text.length - keep));
			tail = text.slice(end);
			if (out !== '') ctl.enqueue(out);
		},
		flush(ctl) {
			const [out] = scan(tail, tail.length);
			if (out !== '') ctl.enqueue(out);
		}
	});
}
