import { refusalFor, scoreModule, vectorFor } from './capability-contract';
import { satisfies } from './composer-constraint';

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
	 * Request-time capabilities, which `core` and `php` cannot express; `cron` runs from the alarm
	 * (`automated_cron.interval = 0`), so a cron module is unwired, not impossible.
	 */
	needs?: readonly ModuleCapability[];
	/** other catalog modules this one needs, by composer name */
	requires?: string[];
	/** uncompressed bytes, so a caller can refuse before reading */
	bytes?: number;
};

import { MODULE_TIER_NOTES, allKnownCapabilities } from './module-tiers';

/**
 * What a module needs beyond a version constraint; `deferrable-outbound` is not a refusal. Blocking
 * kinds are separate: the park serves sockets directly but not `fopen('https://...')`.
 */
export type ModuleCapability =
	'deferrable-outbound' | 'blocking-outbound' | 'blocking-socket' | 'cron';

/**
 * What this runtime can do, so the planner refuses on capability as well as on version.
 * The two blocking flags are separate transports; see {@link ModuleCapability}.
 */
export type RuntimeCapabilities = {
	/** the queue/drain/cache tier exists, so an outbound call split across invocations works */
	deferredOutbound: boolean;
	/** an outbound HTTP call that must answer inside one `php._run()`; no park can serve this */
	blockingOutbound: boolean;
	/** a socket exchange that must answer inside one `php._run()`; the Zend park serves this */
	blockingSocket: boolean;
	cron: boolean;
};

/**
 * True because the alarm exists and drives Drupal's cron; kept a literal because `async.cron` in
 * `capability-contract.ts` measures whether the runtime declares cron to PHP, which it does not.
 */
const SHIPPED_CRON = true;

/**
 * A socket exchange parks in one invocation and resumes in a later one; a literal because
 * `socket.park.inline` only measures the same-invocation case.
 */
const SHIPPED_BLOCKING_SOCKET = true;

/**
 * An outbound HTTP call answered inside its render via `ParkFetchHandler`; `park_flatten()` in
 * `ext/cfwpark` splices out the namespaced `call_user_func_array` frame, `array_map` still refuses.
 */
const SHIPPED_BLOCKING_HTTP = true;

function vectorSatisfied(id: string): boolean {
	return vectorFor(id)?.expected ?? false;
}

/**
 * The shipping runtime; `deferredOutbound` comes from the capability contract. HTTP replaces its
 * transport because a park under the internal `fopen` frame is still refused.
 */
export const SHIPPED_CAPABILITIES: RuntimeCapabilities = {
	deferredOutbound: vectorSatisfied('http.outbound.deferred'),
	blockingOutbound: SHIPPED_BLOCKING_HTTP,
	blockingSocket: SHIPPED_BLOCKING_SOCKET,
	cron: SHIPPED_CRON
};

/** the parsed R2 catalog */
export type Catalog = {
	builtAt: string;
	entries: CatalogEntry[];
};

/** what the mount wants for one layer */
export type LayerSpec = { name: string; r2: string };

/** the result of {@link planInstall} */
export type InstallPlan = {
	requested: string;
	/** every layer to mount, dependencies first so a later layer can override an earlier one */
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
		// reject before a field read (`null` is typeof 'object' and throws on read)
		if (typeof item !== 'object' || item === null) continue;
		const e = item as Partial<CatalogEntry>;
		if (typeof e.name !== 'string' || typeof e.r2 !== 'string') continue;
		if (typeof e.version !== 'string' || typeof e.core !== 'string') continue;
		entries.push({
			name: e.name,
			version: e.version,
			r2: e.r2,
			core: e.core,
			php: typeof e.php === 'string' ? e.php : undefined,
			// drop unknown capabilities, or a newer catalog would fail the planner closed
			needs: Array.isArray(e.needs)
				? (e.needs.filter(
						(n: unknown) =>
							n === 'deferrable-outbound' ||
							n === 'blocking-outbound' ||
							n === 'blocking-socket' ||
							n === 'cron'
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

/** the catalog entry for a composer name, if any */
export function findEntry(catalog: Catalog, name: string): CatalogEntry | undefined {
	return catalog.entries.find((e) => e.name === name);
}

/**
 * Plans a module plus its dependencies in mount order (dependencies first: a later `lazy-fs` layer
 * overrides an earlier one); refuses on any mismatch, and `unknown` is not a yes.
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

	// a module capping PHP below the interpreter would install, then fatal at the point of use
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

	// refusals name the mechanism, not the module, so nobody tries the next captcha
	for (const need of entry.needs ?? []) {
		if (need === 'deferrable-outbound' && !capabilities.deferredOutbound) {
			problems.push(`${name} needs the deferred outbound tier, and this site has none`);
		}
		if (need === 'blocking-outbound' && !capabilities.blockingOutbound) {
			problems.push(
				`${name} needs an outbound HTTP call to answer INSIDE one render, and this ` +
					`interpreter cannot park a Zend continuation (ext/cfwpark is absent, or predates ` +
					`park_flatten and so is refused under Drupal's own dispatch). An outbound call ` +
					`that can be split across invocations is supported`
			);
		}
		if (need === 'blocking-socket' && !capabilities.blockingSocket) {
			problems.push(
				`${name} needs a socket exchange to answer INSIDE one render, and this interpreter ` +
					`cannot park a Zend continuation (ext/cfwpark is absent, or predates the ` +
					`cfw_park_resume re-arm and so cannot complete a multi-trip exchange)`
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

	// the requested module goes last so no dependency shadows its files
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

/** reads the catalog out of R2, or undefined when there is none */
export async function loadCatalog(
	bucket: { get(key: string): Promise<{ text(): Promise<string> } | null> } | undefined,
	key = 'catalog.json'
): Promise<Catalog | undefined> {
	if (!bucket) return undefined;
	try {
		const obj = await bucket.get(key);
		if (!obj) return undefined;
		return parseCatalog(JSON.parse(await obj.text()));
	} catch {
		// an unreadable catalog is "no catalog", not an outage
		return undefined;
	}
}

/**
 * What a module's capability needs mean here; separate from `installable`, which only says
 * composer can resolve it.
 */
export type RuntimeTier = 'works-today' | 'needs-deferred-tier' | 'refused' | 'unknown';

/**
 * Hand-maintained capability needs by composer name; an absent entry means not classified, never
 * safe.
 */
export const KNOWN_MODULE_CAPABILITIES: Readonly<Record<string, readonly ModuleCapability[]>> = {
	// verification is a POST to Google inside form validation; it does not have to happen inside
	// the render, so it is deferrable rather than impossible
	'drupal/recaptcha': ['deferrable-outbound'],
	'drupal/captcha': ['deferrable-outbound'],
	// fetches a missing file from an upstream site: a cache fill, the easiest deferred case
	'drupal/stage_file_proxy': ['deferrable-outbound'],
	// solarium 6.4.2 is interceptable above the adapter (`SolariumTransport`)
	'drupal/search_api_solr': ['deferrable-outbound'],
	// the code exchange must answer inside the login response; there is no partial answer to render
	'drupal/openid_connect': ['blocking-outbound'],
	'drupal/scheduler': ['cron'],
	'drupal/simple_sitemap': ['cron'],
	'drupal/xmlsitemap': ['cron'],
	'drupal/search_api': ['cron'],
	// classified and needing nothing (distinct from unknown)
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
 * Which tier a module lands in; an unclassified one is `unknown`, never `works-today`.
 */
export function tierFor(
	name: string,
	capabilities: RuntimeCapabilities = SHIPPED_CAPABILITIES
): { tier: RuntimeTier; reason?: string } {
	// merge `module-tiers.ts` in, or a module classified in only one table reads as unknown
	const needs = allKnownCapabilities(KNOWN_MODULE_CAPABILITIES)[name];
	if (needs === undefined) {
		return {
			tier: 'unknown',
			reason: `${name} has not been classified against this runtime; it may still need outbound HTTP or cron`
		};
	}

	// contract first: the coarse needs below cannot express most refusals (`simple_sitemap` is
	// `cron` yet fails its own `hook_requirements()` over a missing `xmlwriter`)
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
			reason: `${name} needs an outbound HTTP call to answer INSIDE one render, and this interpreter cannot park a Zend continuation; a call that can be split across invocations is supported`
		};
	}
	if (needs.includes('blocking-socket') && !capabilities.blockingSocket) {
		return {
			tier: 'refused',
			reason: `${name} needs a socket exchange to answer INSIDE one render, and this interpreter cannot park a Zend continuation`
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
			reason: `${name} does its work on cron, which runs from the Durable Object alarm and is ON by default; with DRUPAL_CRON=0 it installs and silently does nothing`
		};
	}
	return { tier: 'works-today' };
}
