/**
 * Which site a deployment serves when a request names none: one deployment is one site, so an
 * unmapped host resolves to the primary recorded in the deployment document (objects record
 * themselves; a pre-existing site records as claimed, never primary).
 *
 * The primary is, in order: the one an owner chose with `PUT /deployment`; the only claimed site;
 * with several, the one holding the most content (nodes plus accounts beyond uid 1), ties to the
 * oldest claim. A choice is recorded at once, so later content cannot move a hostname. Nothing is
 * merged or deleted: a non-primary site stays reachable through `site:host:<host>` or `/export`.
 * @module
 */

/** the CONFIG_KV key holding the deployment document */
export const DEPLOYMENT_KEY = 'site:deployment';

/** the deployment document: the primary site and every claimed one */
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

/** what a site counts as when its object cannot answer */
export function emptyCensus(site: string): SiteCensus {
	return { site, nodes: 0, accounts: 0, claimedAt: null, lastWrite: null };
}

/** the KV surface this reads; `put` is absent on a read-only binding */
export type DeploymentKv = {
	get(key: string): Promise<string | null>;
	put?(key: string, value: string): Promise<void>;
};

const EMPTY: DeploymentSites = { primary: null, claimed: [] };

/** how long an isolate reuses the document; the same trade-off as the host memo */
export const DEPLOYMENT_MEMO_MS = 60_000;

let memo: { at: number; value: DeploymentSites } | undefined;

/** drops the isolate's copy, for tests and after this isolate writes one */
export function resetDeploymentMemo(): void {
	memo = undefined;
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
	kv: DeploymentKv | undefined,
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
 * {@link settlePrimary} over them. `undefined` means nothing is claimed, so the host's derived id
 * stands, which is how the first site of a deployment is made.
 */
export function unmappedSite(
	doc: DeploymentSites
): { site: string; from: 'primary' } | { from: 'choose'; candidates: string[] } | undefined {
	if (doc.primary !== null) return { site: doc.primary, from: 'primary' };
	if (doc.claimed.length === 1) return { site: doc.claimed[0] as string, from: 'primary' };
	if (doc.claimed.length > 1) return { from: 'choose', candidates: [...doc.claimed] };
	return undefined;
}

/**
 * The site with the most content, ties to the oldest claim, then to the first listed.
 */
export function chooseByContent(census: readonly SiteCensus[]): string | undefined {
	let best: SiteCensus | undefined;
	for (const one of census) {
		if (best === undefined) {
			best = one;
			continue;
		}
		const a = one.nodes + one.accounts;
		const b = best.nodes + best.accounts;
		const older = (one.claimedAt ?? Infinity) < (best.claimedAt ?? Infinity);
		if (a > b || (a === b && older)) best = one;
	}
	return best?.site;
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
): Promise<string | undefined> {
	const census = await Promise.all(
		candidates.map((site) => count(site).catch(() => emptyCensus(site)))
	);
	const pick = chooseByContent(census);
	if (pick === undefined) return undefined;
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
 * `asPrimary` is set by a first claim only, so an existing two-site deployment does not get a
 * primary chosen by whichever ran first. Read-modify-write on one key: a concurrent loser records
 * itself again on its next run.
 *
 * @returns the document as written, or undefined when the binding cannot be written
 */
export async function recordClaimed(
	kv: DeploymentKv | undefined,
	site: string,
	asPrimary: boolean
): Promise<DeploymentSites | undefined> {
	if (!kv || typeof kv.put !== 'function' || site === '') return undefined;
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
