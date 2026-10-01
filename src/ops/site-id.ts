/**
 * Which site a request belongs to when the caller did not say. The object name is the site, so a
 * wrong answer serves another site's database rather than failing.
 *
 * Layers in order: `?site=` (only when the caller opts in), KV by host, `SITE_ID`, the
 * deployment's primary site, the derived hostname, then `site`. The optional layers come first
 * because derivation answers for every real host and would shadow them.
 *
 * @module
 */
import {
	censusOf,
	readDeployment,
	settlePrimary,
	unmappedSite,
	type DeploymentKv
} from './deployment-site';

// hosts that name no site, so local dev falls through instead of sharing a site called localhost
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/** the last-resort site id, which `src/site.ts` has always used for a bare `/serve` */
export const FALLBACK_SITE = 'site';

/** the KV key an operator writes to point a hostname at a site */
export function siteKvKey(host: string): string {
	return `site:host:${host.toLowerCase()}`;
}

// the documented location hints; a typo reaching `SITE.get()` would take the site down
const LOCATION_HINTS = new Set([
	'wnam',
	'enam',
	'sam',
	'weur',
	'eeur',
	'apac',
	'apac-ne',
	'apac-se',
	'oc',
	'afr',
	'me'
]);

/**
 * Where a site's Durable Object should be created, or undefined (the default: placement follows
 * the first request). Only applies when the object is created.
 *
 * @returns a validated hint, or undefined when unset or unrecognised
 */
export function locationHint(env?: { SITE_LOCATION_HINT?: string }): string | undefined {
	const raw = String(env?.SITE_LOCATION_HINT ?? '')
		.trim()
		.toLowerCase();
	return LOCATION_HINTS.has(raw) ? raw : undefined;
}

/**
 * The options bag for `SITE.get()`, undefined when there is no hint, so no call site passes
 * `{ locationHint: undefined }` to a runtime that checks for the key.
 */
export function siteStubOptions(env?: {
	SITE_LOCATION_HINT?: string;
}): DurableObjectNamespaceGetDurableObjectOptions | undefined {
	const hint = locationHint(env);
	return hint === undefined ? undefined : { locationHint: hint as DurableObjectLocationHint };
}

/**
 * A site id derived from a request host, or undefined when the host names no site. A non-default
 * port is part of the identity; `example.com:443` is `example.com`.
 *
 * @param host - `url.host`, so a port is already present when there is one
 * @returns a lowercase id safe as a Durable Object name, or undefined for a local host
 */
export function siteFromHost(host: string, protocol = 'https:'): string | undefined {
	const trimmed = host.trim().toLowerCase();
	if (trimmed === '') return undefined;

	// IPv6 literals arrive bracketed, and the brackets carry no identity
	const portAt = trimmed.startsWith('[') ? trimmed.indexOf(']:') + 1 : trimmed.lastIndexOf(':');
	const hostname = portAt > 0 ? trimmed.slice(0, portAt) : trimmed;
	const port = portAt > 0 ? trimmed.slice(portAt + 1) : '';
	if (LOCAL_HOSTS.has(hostname.replace(/^\[|\]$/g, '')) || LOCAL_HOSTS.has(hostname)) {
		return undefined;
	}

	const isDefaultPort = port === '' || (protocol === 'https:' ? port === '443' : port === '80');
	const identity = isDefaultPort ? hostname : `${hostname}:${port}`;
	const id = encodeSiteId(identity);
	return id === '' ? undefined : id;
}

/**
 * One host, one id, injectively: `[a-z0-9.-]` stays, anything else becomes `_<hex>`, and `_` is
 * outside the kept set, so two hosts never share a database.
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
	from: 'param' | 'kv' | 'var' | 'primary' | 'host' | 'fallback';
}

/** how {@link resolveSite} may read the URL */
export interface ResolveSiteOptions {
	/**
	 * Whether `?site=` may name the site; true only where the query string is ours, since a
	 * visitor's `?site=customer-b` would otherwise serve another site's database.
	 */
	allowParam?: boolean;
}

/** the parts of the environment a resolution reads */
export interface SiteIdEnv {
	/** optional: unbound leaves derivation in force */
	CONFIG_KV?: DeploymentKv;
	SITE_ID?: string;
	/** the site namespace, asked what each claimed site holds when several compete for primary */
	SITE?: DurableObjectNamespace;
}

/**
 * How long an isolate reuses a host mapping before reading KV again, as `PLAN_MEMO_MS`; a new
 * mapping applies everywhere within a minute.
 */
export const HOST_MEMO_MS = 60_000;

// undefined is memoised too: "no mapping" is the common answer and costs the same read
const hostMemo = new Map<string, { at: number; site: string | undefined }>();

/** drops the isolate's host memo; tests use it, and so does an explicit refresh */
export function resetHostMemo(): void {
	hostMemo.clear();
}

/**
 * The host's KV mapping, read at most once per host per {@link HOST_MEMO_MS} (a warm read is
 * 4 ms median, a cold key 46-140 ms). A thrown read is not memoised, so a blip is retried.
 */
async function mappedHost(
	env: SiteIdEnv,
	host: string,
	nowMs: number
): Promise<string | undefined> {
	const memo = hostMemo.get(host);
	if (memo && nowMs - memo.at < HOST_MEMO_MS) return memo.site;
	const kv = env.CONFIG_KV;
	if (!kv) return undefined;
	let mapped: string | null;
	try {
		mapped = await kv.get(siteKvKey(host));
	} catch {
		return undefined;
	}
	const site = mapped !== null && mapped.trim() !== '' ? mapped.trim() : undefined;
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
 * @returns the id and the layer that produced it
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
		// a miss or a KV outage falls through to derivation
		const mapped = await mappedHost(env, host, nowMs);
		if (mapped !== undefined) return { site: mapped, from: 'kv' };
	}

	const configured = env?.SITE_ID?.trim();
	if (configured) return { site: configured, from: 'var' };

	if (env?.CONFIG_KV) {
		const decided = unmappedSite(await readDeployment(env.CONFIG_KV, nowMs));
		if (decided?.from === 'primary') return { site: decided.site, from: 'primary' };
		if (decided?.from === 'choose' && env.SITE) {
			const ns = env.SITE;
			const chosen = await settlePrimary(env.CONFIG_KV, decided.candidates, (site) =>
				censusOf(ns, site)
			).catch(() => undefined);
			if (chosen !== undefined) return { site: chosen, from: 'primary' };
		}
	}

	const derived = siteFromHost(host, url.protocol);
	if (derived !== undefined) return { site: derived, from: 'host' };

	return { site: FALLBACK_SITE, from: 'fallback' };
}
