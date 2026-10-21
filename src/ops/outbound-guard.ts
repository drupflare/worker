/**
 * What PHP is allowed to make this Worker fetch on its behalf.
 *
 * `cfwFetch` and `cfwQueueFetch` take a URL from PHP, so any module can choose the destination
 * (SSRF with the Worker as confused deputy: metadata endpoints, `localhost` under `wrangler dev`).
 * A deny-list, not an allow-list: the legitimate set is open-ended (update servers, OIDC
 * providers, webhooks) and an allow-list would need editing to install a module.
 * @module
 */

/** why an outbound request was refused, or undefined when it may proceed */
export type OutboundRefusal = { reason: string; url: string } | undefined;

const ALLOWED_SCHEMES = new Set(['https:', 'http:']);

/**
 * Hostnames that name this machine or a control plane, matched exactly or as a suffix (`.local`
 * and `.internal` resolve inside private networks).
 */
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa'] as const;
const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata']);

/** the v4 literals that are not routable off this host, as [first octet, test] pairs */
function blockedIpv4(host: string): string | undefined {
	const parts = host.split('.');
	if (parts.length !== 4) return undefined;
	const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
	if (n.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return undefined;
	const [a, b] = n as [number, number, number, number];
	if (a === 127) return 'loopback';
	if (a === 10) return 'private (10/8)';
	if (a === 0) return 'this network (0/8)';
	if (a === 172 && b >= 16 && b <= 31) return 'private (172.16/12)';
	if (a === 192 && b === 168) return 'private (192.168/16)';
	// 169.254.169.254 is the cloud metadata address; the whole link-local block goes
	if (a === 169 && b === 254) return 'link-local, which is where cloud metadata lives';
	if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT (100.64/10)';
	if (a >= 224) return 'multicast or reserved';
	return undefined;
}

function blockedIpv6(host: string): string | undefined {
	// a URL parser leaves the brackets on an IPv6 literal
	const inner = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
	if (!inner.includes(':')) return undefined;
	const lower = inner.toLowerCase();
	if (lower === '::1' || lower === '::') return 'loopback';
	// fc00::/7 unique-local, fe80::/10 link-local
	if (/^f[cd][0-9a-f]{2}:/.test(lower)) return 'unique-local (fc00::/7)';
	if (/^fe[89ab][0-9a-f]:/.test(lower)) return 'link-local (fe80::/10)';
	// v4-mapped addresses: `new URL()` rewrites the dotted form to hex (`::ffff:a9fe:a9fe`), so
	// both spellings must be matched or the metadata address passes
	const dotted = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (dotted) return blockedIpv4(dotted[1]!);
	const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (hex) {
		const high = parseInt(hex[1]!, 16);
		const low = parseInt(hex[2]!, 16);
		const v4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
		return blockedIpv4(v4);
	}
	return undefined;
}

/**
 * Whether PHP may have this URL fetched.
 *
 * Checked at queue time (a useful error) and again at drain time, next to the `fetch()` (a row can
 * reach the table by another path).
 */
export function refuseOutbound(rawUrl: string): OutboundRefusal {
	const url = String(rawUrl ?? '').trim();
	if (url === '') return { reason: 'no url', url };

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { reason: 'not a url', url };
	}

	if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
		return { reason: `${parsed.protocol} is not an allowed scheme`, url };
	}
	// credentials in the URL are how an open redirect becomes an authenticated one
	if (parsed.username !== '' || parsed.password !== '') {
		return { reason: 'the url carries credentials', url };
	}

	const host = parsed.hostname.toLowerCase();
	if (host === '') return { reason: 'the url names no host', url };
	if (BLOCKED_HOSTS.has(host)) return { reason: `${host} names this machine`, url };
	for (const suffix of BLOCKED_SUFFIXES) {
		if (host.endsWith(suffix)) return { reason: `${suffix} is not a public suffix`, url };
	}

	const v4 = blockedIpv4(host);
	if (v4 !== undefined) return { reason: `${host} is ${v4}`, url };
	const v6 = blockedIpv6(host);
	if (v6 !== undefined) return { reason: `${host} is ${v6}`, url };

	return undefined;
}

/**
 * Whether the guard is enforced (on unless `0`). The opt-out is for the e2e rig, which points a
 * site at containers on the host, and for an operator running an internal mirror.
 */
export function outboundGuardEnabled(env?: { OUTBOUND_GUARD?: string }): boolean {
	return String(env?.OUTBOUND_GUARD ?? '1') !== '0';
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** the hops `fetch()` itself follows before it gives up */
const MAX_REDIRECTS = 20;

/** sent only to the origin they were meant for; `fetch()` drops the first two the same way */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/** describe the body, so they go when the body does */
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language'];

/** a redirect whose target the guard refuses, or one that never ends */
export class RedirectRefused extends Error {}

/**
 * `fetch()` that checks every redirect target against the guard.
 *
 * A plain `redirect: 'follow'` checks only the URL it was handed, so an allowed host could answer
 * 302 to a refused one. Hops follow the fetch spec: 301 and 302 turn a POST into a GET, 303 turns
 * anything but GET and HEAD into a GET, and credentials do not cross an origin.
 */
export async function fetchGuarded(
	doFetch: typeof fetch,
	url: string,
	init: RequestInit,
	guard: (url: string) => OutboundRefusal = refuseOutbound
): Promise<Response> {
	if (init.redirect === 'manual' || init.redirect === 'error') return doFetch(url, init);
	let target = url;
	let method = String(init.method ?? 'GET').toUpperCase();
	let body = init.body;
	let headers = new Headers(init.headers);
	for (let hop = 0; ; hop++) {
		const res = await doFetch(target, { ...init, method, headers, body, redirect: 'manual' });
		const location = res.headers.get('location');
		if (!REDIRECT_STATUSES.has(res.status) || location === null) return res;
		if (hop >= MAX_REDIRECTS) throw new RedirectRefused('too many redirects');
		await res.body?.cancel();
		const next = new URL(location, target).toString();
		const refusal = guard(next);
		if (refusal !== undefined) {
			throw new RedirectRefused(`redirect to ${next} refused: ${refusal.reason}`);
		}
		if (new URL(next).origin !== new URL(target).origin) {
			headers = new Headers(headers);
			for (const name of CREDENTIAL_HEADERS) headers.delete(name);
		}
		const toGet =
			((res.status === 301 || res.status === 302) && method === 'POST') ||
			(res.status === 303 && method !== 'GET' && method !== 'HEAD');
		if (toGet) {
			method = 'GET';
			body = undefined;
			headers = new Headers(headers);
			for (const name of BODY_HEADERS) headers.delete(name);
		}
		target = next;
	}
}
