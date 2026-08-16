/**
 * Which site a request belongs to, when the caller did not say.
 *
 * `/serve?site=X` names the site explicitly and always wins. Everything else -- a visitor asking for
 * `/about` on a real domain -- has to be resolved, and this is the only place that decides it. One
 * object per site, and the object's NAME is the site identity, so a wrong answer here is a request
 * served from a different site's database rather than an error.
 *
 * The `site` parameter is layer 0 and is REFUSED unless the caller opts in, because the catch-all
 * resolves a URL whose query string belongs to the visitor. See {@link ResolveSiteOptions}.
 *
 * Four layers, and the ORDER follows from which of them can be absent:
 *
 * 1. **KV**, keyed by host. Operator-writable at runtime, so two hostnames can share one site and a
 *    site can be renamed without a redeploy. First because it is the only layer that can be changed
 *    without shipping anything.
 * 2. **`SITE_ID`**, a var. The per-deployment answer, set at deploy time.
 * 3. **The hostname**, derived. No configuration at all: a deploy serves the host it was pointed at.
 * 4. **`site`**, the literal `src/site.ts` has always defaulted the `site` param to.
 *
 * THE OPTIONAL LAYERS COME FIRST BECAUSE THE GUARANTEED ONE WOULD SHADOW THEM. Derivation answers
 * for every real host, so anything below it is unreachable on exactly the hosts it exists to
 * configure -- a KV mapping consulted after derivation could never apply to a deployed site, which
 * is the whole point of having one. Ordering the two explicit layers above the inferred one is the
 * same rule `resolveSiblings()` follows for the sibling checkouts.
 *
 * Layer 3 is also what makes layers 1 and 2 genuinely optional rather than nominally so: a deploy
 * that sets neither still resolves, and `localhost` -- which names no site -- falls past derivation
 * to the literal.
 */

/**
 * Hosts that identify no site.
 *
 * A derived id from `localhost` would be a site called `localhost`, which is a real object holding
 * real data whose name means nothing -- and every developer on every machine would share it. Falling
 * through to `SITE_ID` instead is what lets a local `drangler dev` and a deployed site use the same
 * code path with different answers.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/** the last-resort site id, which `src/site.ts` has always used for a bare `/serve` */
export const FALLBACK_SITE = 'site';

/** the KV key an operator writes to point a hostname at a site */
export function siteKvKey(host: string): string {
	return `site:host:${host.toLowerCase()}`;
}

/**
 * A site id derived from a request host, or null when the host names no site.
 *
 * The PORT is part of the identity only when it is not the default for the scheme. Two dev servers
 * on one box are two sites; `example.com` and `example.com:443` are one, and treating them as two
 * would split a site's data the first time a proxy rewrote the URL.
 *
 * @param host - `url.host`, so a port is already present when there is one
 * @returns a lowercase id safe as a Durable Object name, or null for a local host
 */
export function siteFromHost(host: string, protocol = 'https:'): string | null {
	const trimmed = host.trim().toLowerCase();
	if (trimmed === '') return null;

	// IPv6 literals arrive bracketed, and the brackets carry no identity
	const portAt = trimmed.startsWith('[') ? trimmed.indexOf(']:') + 1 : trimmed.lastIndexOf(':');
	const hostname = portAt > 0 ? trimmed.slice(0, portAt) : trimmed;
	const port = portAt > 0 ? trimmed.slice(portAt + 1) : '';
	if (LOCAL_HOSTS.has(hostname.replace(/^\[|\]$/g, '')) || LOCAL_HOSTS.has(hostname)) return null;

	const isDefaultPort = port === '' || (protocol === 'https:' ? port === '443' : port === '80');
	const identity = isDefaultPort ? hostname : `${hostname}:${port}`;
	// anything outside [a-z0-9-] becomes a dash, so the id is readable in a log and in a DO name
	const id = identity.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return id === '' ? null : id;
}

/** what a site resolution decided, and which layer decided it */
export interface ResolvedSite {
	site: string;
	from: 'param' | 'kv' | 'var' | 'host' | 'fallback';
}

export interface ResolveSiteOptions {
	/**
	 * Whether `?site=` on the URL may name the site.
	 *
	 * TRUE ONLY WHERE THE QUERY STRING IS OURS. On `/serve` the caller built the URL and the
	 * parameter is an instruction; on a path the catch-all rewrote, the query belongs to Drupal and
	 * came from the visitor -- so honouring it means `https://customer-a.example/about?site=customer-b`
	 * serves customer B's database from customer A's hostname. Rewriting from the ORIGIN keeps the
	 * visitor's parameters out of `/serve`'s own, and this keeps them out of the resolution that
	 * chooses which object answers; both halves are needed.
	 */
	allowParam?: boolean;
}

/** the parts of the environment a resolution reads */
export interface SiteIdEnv {
	// nullable to match the binding's own optionality: an unbound namespace leaves derivation in
	// force rather than breaking, the same way it does for the plan
	CONFIG_KV?: { get(key: string): Promise<string | null> } | null;
	SITE_ID?: string | null;
}

/**
 * Resolves the site for a request.
 *
 * @param url - the request URL; `?site=` on it wins outright, unless `allowParam` says otherwise
 * @param opts - see {@link ResolveSiteOptions}; a visitor-owned URL must pass `allowParam: false`
 * @returns the id and the layer that produced it, so a caller can report WHY rather than just what
 */
export async function resolveSite(
	url: URL,
	env: SiteIdEnv | undefined,
	opts: ResolveSiteOptions = {}
): Promise<ResolvedSite> {
	if (opts.allowParam !== false) {
		const explicit = url.searchParams.get('site');
		if (explicit !== null && explicit !== '') return { site: explicit, from: 'param' };
	}

	const host = url.host;
	if (env?.CONFIG_KV && host !== '') {
		// a KV miss is the normal case and must never be an error: an unmapped host is not a fault,
		// and a KV outage must degrade to derivation rather than take the site down
		try {
			const mapped = await env.CONFIG_KV.get(siteKvKey(host));
			if (mapped !== null && mapped.trim() !== '') {
				return { site: mapped.trim(), from: 'kv' };
			}
		} catch {
			// fall through to derivation
		}
	}

	const configured = env?.SITE_ID?.trim();
	if (configured) return { site: configured, from: 'var' };

	const derived = siteFromHost(host, url.protocol);
	if (derived !== null) return { site: derived, from: 'host' };

	return { site: FALLBACK_SITE, from: 'fallback' };
}
