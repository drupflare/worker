/**
 * What PHP is allowed to make this Worker fetch on its behalf.
 *
 * `cfwFetch` and `cfwQueueFetch` take a URL from PHP and the drain fetches it later, so any module
 * that can build a string can choose the destination. That is server-side request forgery with the
 * Worker as the confused deputy, and the interesting target is not a private RFC1918 host the edge
 * cannot route to anyway -- it is `169.254.169.254` and the other metadata endpoints, `localhost`
 * under `wrangler dev`, and anything reachable inside a Cloudflare network the Worker sits in.
 *
 * A DENY-LIST is correct here and an allow-list is not: the legitimate destination set is
 * open-ended, because it is every update server, OIDC provider, webhook endpoint and CAPTCHA
 * verifier a site might use. An allow-list would have to be edited to install a module.
 */

/** why an outbound request was refused, or null when it may proceed */
export type OutboundRefusal = { reason: string; url: string } | null;

const ALLOWED_SCHEMES = new Set(['https:', 'http:']);

/**
 * Hostnames that name this machine or a control plane, matched exactly or as a suffix.
 *
 * `.local` and `.internal` are here because both resolve inside private networks and neither is a
 * public suffix a site would legitimately fetch from.
 */
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa'] as const;
const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata']);

/** the v4 literals that are not routable off this host, as [first octet, test] pairs */
function blockedIpv4(host: string): string | null {
	const parts = host.split('.');
	if (parts.length !== 4) return null;
	const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
	if (n.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return null;
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
	return null;
}

function blockedIpv6(host: string): string | null {
	// a URL parser leaves the brackets on an IPv6 literal
	const inner = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
	if (!inner.includes(':')) return null;
	const lower = inner.toLowerCase();
	if (lower === '::1' || lower === '::') return 'loopback';
	// fc00::/7 unique-local, fe80::/10 link-local
	if (/^f[cd][0-9a-f]{2}:/.test(lower)) return 'unique-local (fc00::/7)';
	if (/^fe[89ab][0-9a-f]:/.test(lower)) return 'link-local (fe80::/10)';
	// an IPv4-mapped address smuggles a v4 literal past a v6 check, and `new URL()` NORMALISES the
	// dotted form to hex -- `::ffff:169.254.169.254` arrives as `::ffff:a9fe:a9fe`, so matching only
	// the dotted spelling let the metadata address straight through
	const dotted = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (dotted) return blockedIpv4(dotted[1]!);
	const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (hex) {
		const high = parseInt(hex[1]!, 16);
		const low = parseInt(hex[2]!, 16);
		const v4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
		return blockedIpv4(v4);
	}
	return null;
}

/**
 * Whether PHP may have this URL fetched.
 *
 * Checked at the QUEUE and again at the DRAIN. Queueing is where a caller gets a useful error, and
 * the drain is what actually opens the connection -- a row can reach the table by another path, and
 * the check that matters is the one next to the `fetch()`.
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
	if (v4 !== null) return { reason: `${host} is ${v4}`, url };
	const v6 = blockedIpv6(host);
	if (v6 !== null) return { reason: `${host} is ${v6}`, url };

	return null;
}

/**
 * Whether the guard is enforced. ON unless explicitly `0`.
 *
 * The opt-out exists for the e2e rig, which points a site at containers on the host, and for an
 * operator running an internal mirror. It is a var rather than an allow-list because a
 * per-host list is the thing that has to be edited to install a module.
 */
export function outboundGuardEnabled(env?: { OUTBOUND_GUARD?: string | null }): boolean {
	return String(env?.OUTBOUND_GUARD ?? '1') !== '0';
}
