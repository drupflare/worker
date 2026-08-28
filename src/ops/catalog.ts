import { refusalFor, scoreModule, vectorFor } from './capability-contract.js';
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
	/** the PHP constraint this pack declares, when it declares one */
	php?: string;
	/**
	 * Runtime capabilities this module needs at REQUEST time.
	 *
	 * A DIFFERENT CLASS FROM `core` AND `php`, which are version constraints answerable by comparing
	 * two strings. These are capability constraints, and they are what the oracle could not see: a
	 * module can satisfy every version constraint, install cleanly, and then fail the first time a
	 * visitor uses it because the runtime cannot do the thing it assumes.
	 *
	 * `cron` is softer still: cron runs from the Durable Object alarm with
	 * `automated_cron.interval = 0`, so a cron-driven module is UNWIRED rather than impossible.
	 */
	needs?: readonly ModuleCapability[];
	/** other catalog modules this one needs, by composer name */
	requires?: string[];
	/** uncompressed bytes, so a caller can refuse before reading */
	bytes?: number;
};

/**
 * A runtime capability a module may require, ordered by how hard it is to satisfy.
 *
 * `deferrable-outbound` is deliberately NOT a refusal. Treating every outbound need as a wall
 * classified reCAPTCHA and Stage File Proxy as impossible when both are two-phase problems the
 * queue already solves; only a call whose answer must arrive inside the same render is truly
 * blocked.
 */
import { MODULE_TIER_NOTES, allKnownCapabilities } from './module-tiers.js';

export type ModuleCapability = 'deferrable-outbound' | 'blocking-outbound' | 'cron';

/**
 * What this runtime can do, so the planner refuses on capability as well as on version.
 *
 * `outbound` is false on the shipping binary and stays false until a build can suspend; `cron`
 * is true because the alarm exists, but a module needing it still has to be driven from there.
 */
export type RuntimeCapabilities = {
	/** the queue/drain/cache tier exists, so an outbound call split across invocations works */
	deferredOutbound: boolean;
	/** an outbound call that must answer inside one `php._run()`; needs a suspending build */
	blockingOutbound: boolean;
	cron: boolean;
};

/**
 * The shipping runtime.
 *
 * `deferredOutbound` is TRUE and always has been -- the queue, the alarm drain and the response
 * cache all exist and ship. What is false is `blockingOutbound`, which needs JSPI or Asyncify.
 */
/**
 * DERIVED FROM THE CAPABILITY CONTRACT rather than written twice.
 *
 * These three booleans used to be literals, and a literal is a claim nothing checks. Every vector in
 * `capability-contract.ts` is EXECUTED against the shipping interpreter by
 * `capability-contract.spec.ts`, so reading them here means a capability that moves moves the tier
 * with it -- and a capability that moves without anyone noticing fails the gate first.
 *
 * `cron` stays a literal, and the reason is worth stating: `async.cron` measures whether the
 * RUNTIME declares cron to PHP, which it does not, while this flag means "the alarm exists and drives
 * Drupal's cron", which it does. Two different questions with two different answers; collapsing them
 * would refuse every cron module on a site where cron demonstrably runs.
 */
const SHIPPED_CRON = true;

function vectorSatisfied(id: string): boolean {
	return vectorFor(id)?.expected ?? false;
}

export const SHIPPED_CAPABILITIES: RuntimeCapabilities = {
	deferredOutbound: vectorSatisfied('http.outbound.deferred'),
	blockingOutbound: vectorSatisfied('http.outbound.blocking'),
	cron: SHIPPED_CRON
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
			// a non-string is dropped here rather than reaching the planner, matching `bytes`
			php: typeof e.php === 'string' ? e.php : undefined,
			// an unrecognised capability is DROPPED rather than carried: a planner that refused on a
			// name it does not understand would fail closed on a catalog written by a newer build
			needs: Array.isArray(e.needs)
				? (e.needs.filter(
						(n: unknown) =>
							n === 'deferrable-outbound' || n === 'blocking-outbound' || n === 'cron'
					) as ModuleCapability[])
				: undefined,
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
 * Refuses rather than guesses in four cases, because each would otherwise produce a site that mounts and
 * then breaks: a module absent from the catalog, a dependency absent from the catalog, and a pack built
 * against a core version this site does not run. The core check uses the constraint checker in
 * `composer-constraint.ts`, so an
 * unjudgeable constraint is a refusal too -- `unknown` is not a yes.
 */
export function planInstall(
	catalog: Catalog,
	name: string,
	shippedCore: string,
	runningPhp: string,
	seen: Set<string> = new Set(),
	capabilities: RuntimeCapabilities = SHIPPED_CAPABILITIES
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

	// a module that caps PHP below the running interpreter would otherwise install and then fatal at
	// the point of use. Zero of the 73 packages in the shipped lock cap PHP today, so this closes a
	// gap rather than a live bug -- and it matters more now that the shipping interpreter is 8.5
	if (entry.php) {
		const phpFits = satisfies(runningPhp, entry.php);
		if (phpFits === 'no') {
			problems.push(
				`${name} ${entry.version} needs php ${entry.php} but this site runs ${runningPhp}`
			);
		} else if (phpFits === 'unknown') {
			problems.push(
				`cannot decide whether php ${runningPhp} satisfies ${entry.php} for ${name}`
			);
		}
	}

	// the capability check, which version constraints cannot express. A refusal here names the
	// mechanism rather than the module, because "recaptcha is unsupported" invites someone to try
	// the next captcha module and hit the same wall
	for (const need of entry.needs ?? []) {
		if (need === 'deferrable-outbound' && !capabilities.deferredOutbound) {
			problems.push(`${name} needs the deferred outbound tier, and this site has none`);
		}
		if (need === 'blocking-outbound' && !capabilities.blockingOutbound) {
			problems.push(
				`${name} needs an outbound call to answer INSIDE one render, and this runtime cannot ` +
					`suspend mid-run to wait for a socket (the shipping binary is ASYNCIFY=0). An ` +
					`outbound call that can be split across invocations is supported; this one cannot be`
			);
		}
		if (need === 'cron' && !capabilities.cron) {
			problems.push(`${name} needs cron, and nothing drives it on this site`);
		}
	}

	for (const dep of entry.requires ?? []) {
		const sub = planInstall(catalog, dep, shippedCore, runningPhp, seen, capabilities);
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

/**
 * What a module's capability needs mean for THIS runtime.
 *
 * Separate from the install verdict on purpose: `installable` answers "can composer resolve it",
 * and that is orthogonal to "will it work here". reCAPTCHA resolves perfectly and needs a tier the
 * shipping runtime does not offer; Honeypot resolves the same way and needs nothing.
 */
export type RuntimeTier = 'works-today' | 'needs-deferred-tier' | 'refused' | 'unknown';

/**
 * Capability needs for modules that have been CLASSIFIED, keyed by composer name.
 *
 * Data rather than inference. Nothing can read a module's tarball and work out that it POSTs to
 * Google during form validation, so this is a hand-maintained list of what has actually been looked
 * at -- and an absent entry means "not classified", never "safe".
 */
export const KNOWN_MODULE_CAPABILITIES: Readonly<Record<string, readonly ModuleCapability[]>> = {
	// verification is a POST to Google inside form validation; it does not have to happen inside
	// the render, so it is deferrable rather than impossible
	'drupal/recaptcha': ['deferrable-outbound'],
	'drupal/captcha': ['deferrable-outbound'],
	// fetches a missing file from an upstream site: a cache fill, the easiest deferred case
	'drupal/stage_file_proxy': ['deferrable-outbound'],
	// MEASURED 2026-08-23 against solarium 6.4.2: the transport is interceptable ABOVE the adapter,
	// so this is deferrable rather than refused. `SolariumTransport` in the sibling short-circuits
	// `PreExecuteRequest`, and search_api_solr hands Drupal's own dispatcher to the client
	'drupal/search_api_solr': ['deferrable-outbound'],
	// the authorization-code exchange has to answer inside the login response, and there is no
	// partial answer to render, which is what makes this the refusal the Solr entry used to be
	'drupal/openid_connect': ['blocking-outbound'],
	'drupal/scheduler': ['cron'],
	'drupal/simple_sitemap': ['cron'],
	'drupal/xmlsitemap': ['cron'],
	'drupal/search_api': ['cron'],
	// classified and needing nothing, which is worth recording so it is not confused with unknown
	'drupal/honeypot': [],
	'drupal/token': [],
	'drupal/pathauto': [],
	'drupal/admin_toolbar': [],
	'drupal/metatag': [],
	'drupal/redirect': [],
	'drupal/webform': [],
	'drupal/paragraphs': [],
	'drupal/entity_reference_revisions': [],
	'drupal/twig_tweak': [],
	'drupal/field_group': [],
	'drupal/linkit': [],
	'drupal/coffee': [],
	'drupal/google_analytics': []
};

/**
 * Which tier a module lands in, and why.
 *
 * AN UNCLASSIFIED MODULE IS `unknown`, NEVER `works-today`. Absence of knowledge is not evidence of
 * safety, and defaulting to "works" would make the tier a decoration that always agrees with the
 * install verdict -- which is exactly the failure the blank meters had.
 */
export function tierFor(
	name: string,
	capabilities: RuntimeCapabilities = SHIPPED_CAPABILITIES
): { tier: RuntimeTier; reason?: string } {
	// the working set in `module-tiers.ts` is merged in here rather than consulted separately: a
	// module classified in one table and not the other returned `unknown`, which reads as "nobody
	// has looked at it" when somebody had
	const needs = allKnownCapabilities(KNOWN_MODULE_CAPABILITIES)[name];
	if (needs === undefined) {
		return {
			tier: 'unknown',
			reason: `${name} has not been classified against this runtime; it may still need outbound HTTP or cron`
		};
	}

	// THE CAPABILITY CONTRACT COMES FIRST, because the three coarse values below cannot express most
	// of what refuses a module. `simple_sitemap` is the case that proved it: classified `cron`,
	// scored installable, and then refused by its own `hook_requirements()` over a missing
	// `xmlwriter`. Every vector consulted here is executed against the shipping interpreter
	const vectors = MODULE_TIER_NOTES[name]?.vectors;
	if (vectors && vectors.length > 0) {
		const verdict = scoreModule(vectors);
		if (!verdict.installable) {
			return { tier: 'refused', reason: `${name} needs ${refusalFor(verdict)}` };
		}
	}
	if (needs.includes('blocking-outbound') && !capabilities.blockingOutbound) {
		return {
			tier: 'refused',
			reason: `${name} needs an outbound call to answer INSIDE one render, and this runtime cannot suspend mid-run to wait for a socket`
		};
	}
	if (needs.includes('deferrable-outbound')) {
		return {
			tier: capabilities.deferredOutbound ? 'needs-deferred-tier' : 'refused',
			reason: capabilities.deferredOutbound
				? `${name} calls out during a request; the call is queued, performed on the alarm and read back on a later invocation`
				: `${name} needs outbound HTTP and this site has no deferred tier`
		};
	}
	if (needs.includes('cron') && !capabilities.cron) {
		return {
			tier: 'refused',
			reason: `${name} needs cron, and nothing drives it on this site`
		};
	}
	if (needs.includes('cron')) {
		return {
			tier: 'needs-deferred-tier',
			// cron defaults ON -- `drupalCronEnabled()` returns true for unset, so this used to tell
			// a reader to set a var they already had. The remaining hazard is the opposite one
			reason: `${name} does its work on cron, which runs from the Durable Object alarm and is ON by default; with DRUPAL_CRON=0 it installs and silently does nothing`
		};
	}
	return { tier: 'works-today' };
}
