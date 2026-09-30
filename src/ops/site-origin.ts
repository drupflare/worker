/**
 * The origin Drupal renders against, and why it is not simply the `Host` header.
 *
 * Every absolute URL Drupal emits -- the canonical tag, a form action, a `Location:`, the link in a
 * password-reset mail -- is built from the request's scheme and host. The render fragments hardcoded
 * `localhost`, so a deployed site told every visitor and every crawler that it lived on
 * `http://localhost`, and a reset link mailed to a user pointed at their own machine.
 *
 * The inbound host is not automatically safe to use. An attacker who can set it can move a
 * password-reset link onto a host they control and can poison a cache keyed by path alone. The
 * defence here is that the origin is a property of the SITE rather than of the request:
 *
 * 1. `SITE_ORIGIN` -- set at deploy time, wins outright, and is the answer for anyone who wants no
 *    inference at all.
 * 2. The PIN, held in `cfw_meta`. Trust on first use, the same shape `/firstrun` already uses for
 *    the owner token: the first request a site answers fixes its origin, and every later request is
 *    measured against that rather than believed. A forged `Host` after the pin changes nothing.
 * 3. The observed origin, when there is no pin yet -- which is the request that sets the pin.
 * 4. `http://localhost`, only when nothing above produced a usable value.
 *
 * The window TOFU leaves open is the first request after a deploy, and it is closed from the other
 * end: `/firstrun` re-pins, so claiming a site also fixes its origin.
 */

/** what a site renders against when nothing else answered */
export const FALLBACK_ORIGIN = 'http://localhost';

/** the `cfw_meta` key the pin lives under */
export const ORIGIN_KEY = 'site_origin';

/** which layer produced the origin, so a caller can report WHY rather than only what */
export type OriginSource = 'var' | 'pinned' | 'observed' | 'fallback';

export interface OriginChoice {
	origin: string;
	from: OriginSource;
}

/**
 * A bare `scheme://host[:port]`, or null when the input names no host.
 *
 * Accepts a full URL and discards everything after the authority, because an operator setting
 * `SITE_ORIGIN` to `https://example.com/` should not get a double slash in every canonical tag. A
 * bare hostname is accepted and assumed `https`, since that is the only thing a deployed site can
 * mean. Anything that is not http or https is refused outright -- `javascript:` reaching a form
 * action is the reason this is an allowlist rather than a blocklist.
 */
export function normaliseOrigin(raw: string | null | undefined): string | null {
	const text = String(raw ?? '').trim();
	if (text === '') return null;
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (url.hostname === '') return null;
	// `URL.origin` is already `scheme://host[:port]` with the default port elided
	return url.origin;
}

/**
 * Picks the origin, in the order documented on this module.
 *
 * @param input - each layer as it was read; an unusable value at any layer falls through rather
 *   than failing, because a typo in a var must not take a site down
 */
export function chooseOrigin(input: {
	configured?: string | null;
	pinned?: string | null;
	observed?: string | null;
}): OriginChoice {
	const configured = normaliseOrigin(input.configured);
	if (configured !== null) return { origin: configured, from: 'var' };

	const pinned = normaliseOrigin(input.pinned);
	if (pinned !== null) return { origin: pinned, from: 'pinned' };

	const observed = normaliseOrigin(input.observed);
	if (observed !== null) return { origin: observed, from: 'observed' };

	return { origin: FALLBACK_ORIGIN, from: 'fallback' };
}

/**
 * Whether an observed origin is worth pinning.
 *
 * A local origin is not: `wrangler dev`, a CI run and an integration spec all reach an object over
 * some form of localhost, and pinning one would fix a real site's canonical URL to a developer's
 * laptop the first time anybody ran the suite against a persisted object.
 */
export function pinnable(origin: string | null | undefined): boolean {
	const normalised = normaliseOrigin(origin);
	if (normalised === null) return false;
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
 * The page store keys on path alone and every render uses the pinned origin, so one stored copy
 * serves every host a site answers on. An alias visitor needs three things moved to its own host:
 * the absolute URLs in the body (plain and JSON-escaped, since drupalSettings and AJAX carry the
 * second), a `Location` that would send it to the canonical host, and the cookie `Domain` Drupal
 * derives from the render host, which a browser refuses from any other host -- so a login on an
 * alias never held. The session cookie NAME stays the canonical one, which is what the next render
 * looks for, so one session works on every alias.
 *
 * The body is rewritten as a stream, so a BigPipe response still arrives progressively.
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
			let pair: [string, string] | null = null;
			for (const p of pairs) {
				const j = text.indexOf(p[0], i);
				if (j !== -1 && (at === -1 || j < at)) [at, pair] = [j, p];
			}
			if (pair === null || at >= safe) break;
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
