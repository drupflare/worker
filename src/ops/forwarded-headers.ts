import { bearerToken, tokenMatches } from './site-secrets';

/**
 * The request headers Drupal sees besides the ones the serve path already carries by name.
 *
 * A headless site reads `Authorization`, `X-Api-Key`, `Origin` and `User-Agent` off the request, and
 * the serve path used to hand Drupal only the cookie, the accept header, the content type and the
 * client address, so every bearer-token route answered as if no token had been sent.
 *
 * @module
 */

/** carried by name elsewhere, or meaningless once the request has crossed the Worker */
const NOT_FORWARDED = new Set([
	'accept',
	'connection',
	'content-length',
	'content-type',
	'cookie',
	'expect',
	'host',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
]);

/** this deployment's own plumbing, which customer PHP must not read or forge */
const PLUMBING = /^(cf-|x-cfw-|sec-websocket-)/;

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const MAX_HEADERS = 64;
const MAX_BYTES = 16 * 1024;

/**
 * The headers to hand Drupal, lowercase by name.
 *
 * An `Authorization` that is the owner token is dropped: it is this deployment's own credential
 * for the Worker's routes and customer PHP must never see it. Anything past the count or byte
 * ceiling is dropped, not truncated, so a value is never cut in the middle.
 *
 * @param headers the inbound request's headers
 * @param ownerToken the stored owner token, or null when the site is unclaimed
 */
export function forwardedHeaders(
	headers: Headers,
	ownerToken: string | null
): Record<string, string> {
	const out: Record<string, string> = {};
	let bytes = 0;
	let count = 0;
	for (const [rawName, rawValue] of headers) {
		const name = rawName.toLowerCase();
		const value = rawValue.trim();
		if (NOT_FORWARDED.has(name) || PLUMBING.test(name) || !NAME.test(name) || value === '') {
			continue;
		}
		if (name === 'authorization' && tokenMatches(bearerToken(value), ownerToken)) continue;
		const size = name.length + value.length;
		if (count >= MAX_HEADERS || bytes + size > MAX_BYTES) continue;
		out[name] = value;
		count += 1;
		bytes += size;
	}
	return out;
}
