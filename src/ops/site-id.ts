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
 * is the case it exists for. Ordering the two explicit layers above the inferred one is the
 * same rule `resolveSiblings()` follows for the sibling checkouts.
 *
 * Layer 3 is also what makes layers 1 and 2 optional rather than nominally so: a deploy
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
 * The regions Cloudflare accepts as a Durable Object location hint.
 *
 * An allow-list rather than a pass-through, because the value reaches `SITE.get()` on the serving
 * path: a typo that the platform rejects would take the site down for the sake of a latency
 * preference, which is the wrong trade for a hint.
 */
const LOCATION_HINTS = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me']);

/**
 * Where a site's Durable Object should be created, or undefined for "wherever it lands".
 *
 * **UNSET IS THE DEFAULT.** Placement follows the first request, which for a
 * deploy-button site is wherever the deployer was. Guessing a region on their behalf trades latency
 * for one audience against latency for every other, and a one-click product has no way to ask - so
 * an owner who knows their audience pins it, and nobody else pays for a guess.
 *
 * **KV FIRST, THEN THE VAR**, which is the ladder `resolveSettings()` already implements:
 * `SITE_LOCATION_HINT` is on {@link KV_OVERRIDABLE}, so it can be changed without a redeploy. That
 * ordering is the convention for any lever offered here, not a special case for this one.
 *
 * IT ONLY APPLIES TO CREATION. Cloudflare uses the hint when the object is first instantiated and
 * ignores it afterwards, so setting this on a site that already exists moves nothing.
 *
 * @returns a validated hint, or undefined when unset or unrecognised
 */
export function locationHint(env?: { SITE_LOCATION_HINT?: string | null }): string | undefined {
	const raw = String(env?.SITE_LOCATION_HINT ?? '')
		.trim()
		.toLowerCase();
	return LOCATION_HINTS.has(raw) ? raw : undefined;
}

/**
 * The options bag for `SITE.get()`, empty when there is no hint.
 *
 * Separate from {@link locationHint} so a call site cannot accidentally pass
 * `{ locationHint: undefined }`, which is not the same as passing nothing to every runtime that
 * checks for the key rather than its value.
 */
export function siteStubOptions(env?: {
	SITE_LOCATION_HINT?: string | null;
}): DurableObjectNamespaceGetDurableObjectOptions | undefined {
	const hint = locationHint(env);
	return hint === undefined ? undefined : { locationHint: hint as DurableObjectLocationHint };
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
	const id = encodeSiteId(identity);
	return id === '' ? null : id;
}

/**
 * One host, one id, and no two hosts sharing one.
 *
 * `[^a-z0-9]+` collapsing to a dash made `a.b.example.com` and `a-b.example.com` the same id, and a
 * site id IS the Durable Object's name -- so two unrelated hostnames pointed at one deployment
 * shared one database. `.` and `-` are the ordinary furniture of a hostname and are now kept as
 * themselves; anything else becomes `_<hex>`, which cannot be produced any other way because `_` is
 * outside the kept set. That makes the mapping injective rather than merely tidier.
 *
 * Readable in a log, and safe everywhere it is used: a DO name takes any string, and the cache, KV,
 * and R2 keys that carry it percent-encode their parts.
 */
export function encodeSiteId(identity: string): string {
	let out = '';
	for (const ch of identity) {
		out += /[a-z0-9.-]/.test(ch)
			? ch
			: [...new TextEncoder().encode(ch)]
					.map((b) => `_${b.toString(16).padStart(2, '0')}`)
					.join('');
	}
	// a leading or trailing dot is not identity, and a bare one would name nothing
	return out.replace(/^[.-]+|[.-]+$/g, '');
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
 * How long an isolate reuses a host mapping before reading KV again.
 *
 * The same value and the same trade-off as `PLAN_MEMO_MS`, for a fact that changes less often: a
 * hostname is pointed at a site about once in that site's life. A mapping written now applies
 * everywhere within a minute.
 */
export const HOST_MEMO_MS = 60_000;

/** null is a real answer here -- "this host has no mapping" is the common case and the expensive one */
const hostMemo = new Map<string, { at: number; site: string | null }>();

/** drops the isolate's host memo; tests use it, and so does an explicit refresh */
export function resetHostMemo(): void {
	hostMemo.clear();
}

/**
 * The host's KV mapping, or null; read at most once per host per {@link HOST_MEMO_MS}.
 *
 * MEASURED ON A DEPLOYED WORKER, and this is why it exists: one WARM `CONFIG_KV.get()` costs 4 ms
 * at the median (a key the colo has not seen costs 46-140 ms), and a production page request made
 * TWO of them for the same host -- once in the catch-all
 * rewrite and again in `siteFor()` -- for 8.5 ms before any other tier was consulted. Every
 * measurement deploy in this repo sets `PW_DIAGNOSTICS=1` and calls `/serve?site=X`, which takes the
 * `param` branch above and reads 0, so no arm had ever priced the shape that ships.
 *
 * A THROWN READ IS NOT MEMOISED. A KV blip must cost the next request a retry rather than pin
 * derivation for a minute.
 */
async function mappedHost(env: SiteIdEnv, host: string, nowMs: number): Promise<string | null> {
	const memo = hostMemo.get(host);
	if (memo && nowMs - memo.at < HOST_MEMO_MS) return memo.site;
	const kv = env.CONFIG_KV;
	if (!kv) return null;
	let mapped: string | null;
	try {
		mapped = await kv.get(siteKvKey(host));
	} catch {
		return null;
	}
	const site = mapped !== null && mapped.trim() !== '' ? mapped.trim() : null;
	// bounded by the hosts one isolate sees; a clear is cheaper than an LRU here
	if (hostMemo.size > 64) hostMemo.clear();
	hostMemo.set(host, { at: nowMs, site });
	return site;
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
	opts: ResolveSiteOptions = {},
	nowMs: number = Date.now()
): Promise<ResolvedSite> {
	if (opts.allowParam !== false) {
		const explicit = url.searchParams.get('site');
		if (explicit !== null && explicit !== '') return { site: explicit, from: 'param' };
	}

	const host = url.host;
	if (env?.CONFIG_KV && host !== '') {
		// a KV miss is the normal case and must never be an error: an unmapped host is not a fault,
		// and a KV outage must degrade to derivation rather than take the site down
		const mapped = await mappedHost(env, host, nowMs);
		if (mapped !== null) return { site: mapped, from: 'kv' };
	}

	const configured = env?.SITE_ID?.trim();
	if (configured) return { site: configured, from: 'var' };

	const derived = siteFromHost(host, url.protocol);
	if (derived !== null) return { site: derived, from: 'host' };

	return { site: FALLBACK_SITE, from: 'fallback' };
}
