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
