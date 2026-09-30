/**
 * Which site a deployment serves when a request names none.
 *
 * One deployment is one site. A host with no `site:host:` mapping and no `SITE_ID` used to address
 * the object its own name derives, so pointing a second domain at a worker opened a claim page for a
 * brand-new site. The deployment document records the sites that have been claimed here and which
 * one is primary, and an unmapped host resolves to the primary instead.
 *
 * The document is written by the objects themselves: a site records itself as primary when it is
 * the first claim on the deployment, and a site claimed before this document existed records itself
 * as claimed (never as primary) the first time it runs. The primary is then, in order:
 *
 * 1. the one an owner chose with `PUT /deployment`, which nothing automatic overrides;
 * 2. the only claimed site, which is every ordinary deployment;
 * 3. with several claimed sites, the one holding the most content (nodes plus accounts beyond uid 1),
 *    ties to the oldest claim. The accidental second claim a new domain used to open is an empty
 *    site, so content keeps the real one whichever was claimed first.
 *
 * A choice is recorded as the primary the moment it is made, so content added to the other site
 * later cannot move a hostname. No site's database is merged or deleted: a site that is not primary
 * stays reachable through a `site:host:<host>` mapping or `/export`.
 */

/** the CONFIG_KV key holding the deployment document */
export const DEPLOYMENT_KEY = 'site:deployment';

export type DeploymentSites = {
	/** the site every unmapped host resolves to, or null when none has been chosen */
	primary: string | null;
	/** every site claimed on this deployment, in the order they recorded themselves */
	claimed: string[];
	/** how the primary was decided, when there is one */
	chosen?: 'explicit' | 'first-claim' | 'content';
};

/** what one claimed site holds, as its object reports it */
export type SiteCensus = {
	site: string;
	nodes: number;
	accounts: number;
	/** the claim time in ms, or null when the object does not know it */
	claimedAt: number | null;
	/** the newest `changed` among nodes and accounts, in seconds, or null */
	lastWrite: number | null;
};

export type DeploymentKv = {
	get(key: string): Promise<string | null>;
	put?(key: string, value: string): Promise<void>;
};

const EMPTY: DeploymentSites = { primary: null, claimed: [] };

/** how long an isolate reuses the document; the same trade-off as the host memo */
export const DEPLOYMENT_MEMO_MS = 60_000;

let memo: { at: number; value: DeploymentSites } | null = null;

/** drops the isolate's copy, for tests and after this isolate writes one */
export function resetDeploymentMemo(): void {
	memo = null;
}

/** a stored document, with anything malformed read as empty rather than trusted */
export function parseDeployment(raw: string | null): DeploymentSites {
	if (raw === null || raw.trim() === '') return { ...EMPTY, claimed: [] };
	try {
		const doc = JSON.parse(raw) as Partial<DeploymentSites>;
		const claimed = Array.isArray(doc.claimed)
			? [
					...new Set(
						doc.claimed.filter((s): s is string => typeof s === 'string' && s !== '')
					)
				]
			: [];
		const primary = typeof doc.primary === 'string' && doc.primary !== '' ? doc.primary : null;
		const chosen =
			doc.chosen === 'explicit' || doc.chosen === 'first-claim' || doc.chosen === 'content'
				? doc.chosen
				: undefined;
		return { primary, claimed, ...(primary !== null && chosen ? { chosen } : {}) };
	} catch {
		return { ...EMPTY, claimed: [] };
	}
}

/**
 * The document, read at most once per isolate per {@link DEPLOYMENT_MEMO_MS}.
 *
 * A failed read is not memoised and answers empty, which is the behaviour before this document
 * existed: a KV blip degrades to host derivation rather than taking the site down.
 */
export async function readDeployment(
	kv: DeploymentKv | null | undefined,
	nowMs: number = Date.now()
): Promise<DeploymentSites> {
	if (!kv) return { ...EMPTY, claimed: [] };
	if (memo && nowMs - memo.at < DEPLOYMENT_MEMO_MS) return memo.value;
	let raw: string | null;
	try {
		raw = await kv.get(DEPLOYMENT_KEY);
	} catch {
		return { ...EMPTY, claimed: [] };
	}
	const value = parseDeployment(raw);
	memo = { at: nowMs, value };
	return value;
}

/**
 * What the deployment document says an unmapped host resolves to.
 *
 * `choose` means several sites are claimed and none is primary yet; the caller runs
 * {@link settlePrimary} over them. `null` means nothing is claimed, so the host's derived id stands,
 * which is how the first site of a deployment is made.
 */
export function unmappedSite(
	doc: DeploymentSites
): { site: string; from: 'primary' } | { from: 'choose'; candidates: string[] } | null {
	if (doc.primary !== null) return { site: doc.primary, from: 'primary' };
	if (doc.claimed.length === 1) return { site: doc.claimed[0] as string, from: 'primary' };
	if (doc.claimed.length > 1) return { from: 'choose', candidates: [...doc.claimed] };
	return null;
}

/**
 * The site with the most content, ties to the oldest claim, then to the first listed.
 */
export function chooseByContent(census: readonly SiteCensus[]): string | null {
	let best: SiteCensus | null = null;
	for (const one of census) {
		if (best === null) {
			best = one;
			continue;
		}
		const a = one.nodes + one.accounts;
		const b = best.nodes + best.accounts;
		const older = (one.claimedAt ?? Infinity) < (best.claimedAt ?? Infinity);
		if (a > b || (a === b && older)) best = one;
	}
	return best?.site ?? null;
}

/**
 * Chooses and records the primary among several claimed sites, unless one was recorded meanwhile.
 *
 * @param count - asks one site's object what it holds
 * @returns the primary now in force
 */
export async function settlePrimary(
	kv: DeploymentKv,
	candidates: readonly string[],
	count: (site: string) => Promise<SiteCensus>
): Promise<string | null> {
	const census = await Promise.all(
		candidates.map((site) =>
			count(site).catch((): SiteCensus => ({
				site,
				nodes: 0,
				accounts: 0,
				claimedAt: null,
				lastWrite: null
			}))
		)
	);
	const pick = chooseByContent(census);
	if (pick === null) return null;
	const doc = parseDeployment(await kv.get(DEPLOYMENT_KEY));
	// sticky: an explicit choice, or one another isolate made first, stands
	if (doc.primary !== null) return doc.primary;
	if (typeof kv.put === 'function') {
		const next: DeploymentSites = { primary: pick, claimed: doc.claimed, chosen: 'content' };
		await kv.put(DEPLOYMENT_KEY, JSON.stringify(next));
		memo = { at: Date.now(), value: next };
	}
	return pick;
}

/**
 * Records a claimed site, and makes it primary when asked and no site is primary or claimed yet.
 *
 * `asPrimary` is set by a first claim and never by a site adopting itself afterwards, so a
 * deployment that already held two claimed sites does not get a primary chosen by whichever one
 * happened to run first. Read-modify-write on one key: two objects recording at once can lose one
 * entry, and the loser records itself again the next time it runs.
 *
 * @returns the document as written, or null when the binding cannot be written
 */
export async function recordClaimed(
	kv: DeploymentKv | null | undefined,
	site: string,
	asPrimary: boolean
): Promise<DeploymentSites | null> {
	if (!kv || typeof kv.put !== 'function' || site === '') return null;
	const doc = parseDeployment(await kv.get(DEPLOYMENT_KEY));
	const firstOfAll = doc.primary === null && doc.claimed.length === 0;
	const known = doc.claimed.includes(site);
	if (known && !(asPrimary && firstOfAll)) return doc;
	const next: DeploymentSites = {
		primary: asPrimary && firstOfAll ? site : doc.primary,
		claimed: known ? doc.claimed : [...doc.claimed, site],
		...(asPrimary && firstOfAll
			? { chosen: 'first-claim' as const }
			: doc.chosen
				? { chosen: doc.chosen }
				: {})
	};
	await kv.put(DEPLOYMENT_KEY, JSON.stringify(next));
	resetDeploymentMemo();
	return next;
}

/**
 * Chooses the primary among the claimed sites.
 *
 * @returns the new document, or an error naming why the choice was refused
 */
export async function choosePrimary(
	kv: DeploymentKv,
	site: string
): Promise<{ ok: true; deployment: DeploymentSites } | { ok: false; error: string }> {
	if (typeof kv.put !== 'function')
		return { ok: false, error: 'this CONFIG_KV binding is read-only' };
	const doc = parseDeployment(await kv.get(DEPLOYMENT_KEY));
	if (!doc.claimed.includes(site)) {
		return {
			ok: false,
			error: `${site} is not a claimed site on this deployment; claimed: ${doc.claimed.join(', ') || 'none'}`
		};
	}
	const next: DeploymentSites = { primary: site, claimed: doc.claimed, chosen: 'explicit' };
	await kv.put(DEPLOYMENT_KEY, JSON.stringify(next));
	resetDeploymentMemo();
	return { ok: true, deployment: next };
}

/** asks one site's object what it holds */
export async function censusOf(ns: DurableObjectNamespace, site: string): Promise<SiteCensus> {
	const res = await ns.get(ns.idFromName(site)).fetch('https://do.local/__deployment');
	const body = (await res.json()) as Partial<SiteCensus>;
	return {
		site,
		nodes: Number(body.nodes ?? 0),
		accounts: Number(body.accounts ?? 0),
		claimedAt: typeof body.claimedAt === 'number' ? body.claimedAt : null,
		lastWrite: typeof body.lastWrite === 'number' ? body.lastWrite : null
	};
}
