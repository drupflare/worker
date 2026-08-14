import { satisfies } from './composer-constraint.js';

/** one catalog entry: a pre-packed module and what it needs */
export type CatalogEntry = {
	/** composer name, e.g. `drupal/pathauto` */
	name: string;
	version: string;
	/** the R2 key prefix; the mount appends `.pf.json` and `.pf.bin` */
	r2: string;
	/** the Drupal core constraint this pack was built against */
	core: string;
	/** other catalog modules this one needs, by composer name */
	requires?: string[];
	/** uncompressed bytes, so a caller can refuse before reading */
	bytes?: number;
};

export type Catalog = {
	builtAt: string;
	entries: CatalogEntry[];
};

/** what the mount wants for one layer */
export type LayerSpec = { name: string; r2: string };

export type InstallPlan = {
	requested: string;
	/** every layer to mount, dependencies FIRST so a later layer can override an earlier one */
	layers: LayerSpec[];
	/** catalog entries in the same order as `layers` */
	entries: CatalogEntry[];
	totalBytes: number;
	ok: boolean;
	/** why it cannot be planned; empty when ok */
	problems: string[];
};

/** parses a catalog, tolerating junk rather than throwing on a bad object read */
export function parseCatalog(raw: unknown): Catalog {
	const builtAt =
		typeof (raw as { builtAt?: unknown })?.builtAt === 'string'
			? (raw as { builtAt: string }).builtAt
			: 'unknown';
	const list = (raw as { entries?: unknown })?.entries;
	if (!Array.isArray(list)) return { builtAt, entries: [] };
	const entries: CatalogEntry[] = [];
	for (const item of list) {
		// a non-object entry has to be rejected BEFORE any field read: `null` is typeof 'object' and
		// reading a property off it throws, which would take down a function whose whole contract is
		// tolerating a bad object read
		if (typeof item !== 'object' || item === null) continue;
		const e = item as Partial<CatalogEntry>;
		if (typeof e.name !== 'string' || typeof e.r2 !== 'string') continue;
		if (typeof e.version !== 'string' || typeof e.core !== 'string') continue;
		entries.push({
			name: e.name,
			version: e.version,
			r2: e.r2,
			core: e.core,
			requires: Array.isArray(e.requires)
				? e.requires.filter((r) => typeof r === 'string')
				: [],
			bytes: typeof e.bytes === 'number' ? e.bytes : undefined
		});
	}
	return { builtAt, entries };
}

export function findEntry(catalog: Catalog, name: string): CatalogEntry | null {
	return catalog.entries.find((e) => e.name === name) ?? null;
}

/**
 * Builds the install plan for one module: itself plus its catalog dependencies, in mount order.
 *
 * DEPENDENCIES FIRST, and that ordering is load-bearing rather than tidy. `lazy-fs` merges layers BEFORE
 * node creation and a LATER layer overrides an earlier one on the same path, so the requested module has
 * to come last or a dependency could shadow it.
 *
 * Refuses rather than guesses in three cases, because each would otherwise produce a site that mounts and
 * then breaks: a module absent from the catalog, a dependency absent from the catalog, and a pack built
 * against a core version this site does not run. The core check uses E3's constraint checker, so an
 * unjudgeable constraint is a refusal too -- `unknown` is not a yes.
 */
export function planInstall(
	catalog: Catalog,
	name: string,
	shippedCore: string,
	seen: Set<string> = new Set()
): InstallPlan {
	const problems: string[] = [];
	const layers: LayerSpec[] = [];
	const entries: CatalogEntry[] = [];

	const entry = findEntry(catalog, name);
	if (!entry) {
		return {
			requested: name,
			layers: [],
			entries: [],
			totalBytes: 0,
			ok: false,
			problems: [`${name} is not in the catalog`]
		};
	}

	// a cycle would otherwise recurse forever; a catalog is data and may be wrong
	if (seen.has(name)) {
		return { requested: name, layers: [], entries: [], totalBytes: 0, ok: true, problems: [] };
	}
	seen.add(name);

	const fits = satisfies(shippedCore, entry.core);
	if (fits === 'no') {
		problems.push(
			`${name} ${entry.version} needs core ${entry.core} but this site is ${shippedCore}`
		);
	} else if (fits === 'unknown') {
		problems.push(
			`cannot decide whether core ${shippedCore} satisfies ${entry.core} for ${name}`
		);
	}

	for (const dep of entry.requires ?? []) {
		const sub = planInstall(catalog, dep, shippedCore, seen);
		problems.push(...sub.problems);
		for (const [i, layer] of sub.layers.entries()) {
			if (!layers.some((l) => l.r2 === layer.r2)) {
				layers.push(layer);
				entries.push(sub.entries[i] as CatalogEntry);
			}
		}
	}

	// the requested module goes LAST so nothing it depends on can shadow its files
	if (!layers.some((l) => l.r2 === entry.r2)) {
		layers.push({ name: entry.name, r2: entry.r2 });
		entries.push(entry);
	}

	return {
		requested: name,
		layers,
		entries,
		totalBytes: entries.reduce((n, e) => n + (e.bytes ?? 0), 0),
		ok: problems.length === 0,
		problems
	};
}

/** reads the catalog out of R2, or null when there is none */
export async function loadCatalog(
	bucket: { get(key: string): Promise<{ text(): Promise<string> } | null> } | null | undefined,
	key = 'catalog.json'
): Promise<Catalog | null> {
	if (!bucket) return null;
	try {
		const obj = await bucket.get(key);
		if (!obj) return null;
		return parseCatalog(JSON.parse(await obj.text()));
	} catch {
		// an unreadable catalog is "no catalog", not an outage: the install feature is simply absent
		return null;
	}
}
