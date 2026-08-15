import { satisfies, type Satisfaction } from './composer-constraint';

/**
 * Decides whether a module can be installed, in ONE cacheable subrequest, and refuses with the
 * NAMED conflict when it cannot.
 *
 * This is the check, not the install. The Workflow path does the installing; they are separate so
 * that a refusal is cheap. `composer require` on the edge is not available at any price -- it
 * needs a solver, a network of subrequests and minutes of CPU -- but the *common* answer is decidable
 * from one metadata fetch against a lock file that already ships. A module that requires
 * `drupal/core: ^10` can be refused in one subrequest, before any Workflow, any download and any
 * write.
 *
 * The refusal has to name the conflict. "Cannot install" is unactionable and gets retried. "webform
 * 6.2.0 requires drupal/core ^10 and this site ships 11.4.5" tells the operator the module is simply
 * not compatible, which is a different decision from a transient failure.
 *
 * What it does not do: resolve transitive dependencies. A real solver would
 * have to fetch every requirement's metadata recursively, which is unbounded subrequests, and it would
 * still not match Composer's answer. So a module whose direct requirements are all satisfied by the
 * shipped lock is reported `installable`; anything else is `blocked` or `unverifiable`, and
 * `unverifiable` is not a yes.
 */

/**
 * The v2 metadata endpoint for a package; one GET, and the response is immutable per version.
 *
 * Routed by vendor, and getting this wrong made the whole check answer `not-found` for the entire
 * Drupal ecosystem. Drupal contrib is NOT on Packagist -- it is published to drupal.org's own
 * Composer repository, which core's own `composer.json` adds as a second repository. Measured:
 *
 *   repo.packagist.org/p2/drupal/pathauto.json ................ 404
 *   packages.drupal.org/8/p2/drupal/pathauto.json ............. 302 -> www.drupal.org, then 404
 *   packages.drupal.org/files/packages/8/p2/drupal/pathauto.json  200 (the metadata)
 *   repo.packagist.org/p2/symfony/yaml.json ................... 200
 *
 * So every `/installable?module=drupal/*` returned `not-found` with the plumbing working perfectly.
 * Three roadmap items are priced against this check, which means they were priced against a
 * function that could only ever say no for the packages the product exists to install.
 *
 * `drupal/core*` is the exception inside the exception: core and its subtree packages ARE mirrored
 * to Packagist, but drupal.org serves them too, so routing the whole `drupal/` vendor there is both
 * correct and simpler than special-casing.
 */
export const DRUPAL_METADATA_URL = 'https://packages.drupal.org/files/packages/8/p2/%package%.json';

export function packagistUrl(name: string): string {
	const vendor = String(name ?? '').split('/')[0];
	return vendor === 'drupal'
		? DRUPAL_METADATA_URL.replace('%package%', name)
		: `https://repo.packagist.org/p2/${name}.json`;
}

/**
 * A package name Packagist would accept, so a hostile value cannot be smuggled into the URL.
 *
 * Refusing rather than encoding: a name that needs escaping is not a package name, and building a URL
 * from unvalidated input is how a path traversal reaches a metadata host.
 */
export function isValidPackageName(name: string): boolean {
	return /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/.test(
		String(name ?? '')
	);
}

/** name -> version, from a composer.lock's `packages` array */
export function lockVersions(lock: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	const packages = (lock as { packages?: unknown })?.packages;
	if (!Array.isArray(packages)) return out;
	for (const entry of packages) {
		const name = (entry as { name?: unknown })?.name;
		const version = (entry as { version?: unknown })?.version;
		if (typeof name === 'string' && typeof version === 'string') out[name] = version;
	}
	return out;
}

/**
 * Requirements that are always satisfied by the platform rather than by a package.
 *
 * `php` is the interpreter's own version and the others are extensions the build either has or cannot
 * ever have. They are listed rather than pattern-matched on `ext-` so that a MISSING extension is a
 * real conflict: this build has no `pdo_sqlite`, and a module requiring it must be refused, not waved
 * through by a blanket rule.
 */
export type PlatformVersions = Record<string, string>;

/**
 * The interpreter version this map reports.
 *
 * STALE AT 8.3.0 UNTIL NOW, and the failure was silent in the same direction as the metadata URL
 * above: the shipping binary is 8.5 -- `wrangler.jsonc` aliases `php-binary-85.ts` and a deployed
 * site reports `8.5.2` from `/php` -- so anything requiring `>=8.4` was refused as unsatisfiable by
 * a platform that satisfies it. A refusal reads as a considered answer, which is why nothing looked
 * broken.
 *
 * The extension entries carry the same version because a bundled extension is part of the
 * interpreter; a constraint on `ext-dom` is really a constraint on the build that provides it.
 */
export const PLATFORM_PHP_VERSION = '8.5.2';

export const DEFAULT_PLATFORM: PlatformVersions = {
	php: PLATFORM_PHP_VERSION,
	'ext-json': PLATFORM_PHP_VERSION,
	'ext-mbstring': PLATFORM_PHP_VERSION,
	'ext-pcre': PLATFORM_PHP_VERSION,
	'ext-spl': PLATFORM_PHP_VERSION,
	'ext-tokenizer': PLATFORM_PHP_VERSION,
	'ext-xml': PLATFORM_PHP_VERSION,
	'ext-dom': PLATFORM_PHP_VERSION,
	'ext-simplexml': PLATFORM_PHP_VERSION,
	'ext-zlib': PLATFORM_PHP_VERSION
};

export type Conflict = {
	requires: string;
	constraint: string;
	/** the version this site has, or null when the requirement is absent entirely */
	installed: string | null;
	reason: 'missing' | 'version' | 'unverifiable';
	detail: string;
};

export type InstallVerdict = {
	name: string;
	version: string | null;
	/** `installable` only when every direct requirement is satisfied and none was unjudgeable */
	verdict: 'installable' | 'blocked' | 'unverifiable' | 'not-found';
	conflicts: Conflict[];
	/** requirements that were satisfied, for the audit trail an operator reads on a refusal */
	satisfied: string[];
	note?: string;
};

/** the newest version in a p2 payload, by the order Packagist returns (newest first) */
export function newestVersion(
	meta: unknown,
	name: string
): { version: string; require: Record<string, string> } | null {
	const packages = (meta as { packages?: Record<string, unknown> })?.packages;
	const list = packages?.[name];
	if (!Array.isArray(list) || list.length === 0) return null;
	for (const entry of list) {
		const version = (entry as { version?: unknown })?.version;
		if (typeof version !== 'string') continue;
		// skip dev branches: nothing here can order them, so a dev release is not a candidate
		if (version.startsWith('dev-') || version.endsWith('-dev')) continue;
		const require = (entry as { require?: unknown })?.require;
		const cleaned: Record<string, string> = {};
		if (require && typeof require === 'object') {
			for (const [k, v] of Object.entries(require as Record<string, unknown>)) {
				if (typeof v === 'string') cleaned[k] = v;
			}
		}
		return { version, require: cleaned };
	}
	return null;
}

/**
 * Checks a requirement map against what this site provides.
 *
 * An `unknown` from the constraint checker becomes an `unverifiable` conflict rather than being
 * dropped, so the overall verdict degrades to `unverifiable` instead of quietly reading as installable.
 */
export function checkRequirements(
	require: Record<string, string>,
	installed: Record<string, string>,
	platform: PlatformVersions = DEFAULT_PLATFORM
): { conflicts: Conflict[]; satisfied: string[] } {
	const conflicts: Conflict[] = [];
	const satisfied: string[] = [];

	for (const [dep, constraint] of Object.entries(require)) {
		const have = installed[dep] ?? platform[dep] ?? null;
		if (have === null) {
			conflicts.push({
				requires: dep,
				constraint,
				installed: null,
				reason: 'missing',
				detail: `${dep} is not provided by this site (needs ${constraint})`
			});
			continue;
		}
		const result: Satisfaction = satisfies(have, constraint);
		if (result === 'yes') {
			satisfied.push(`${dep} ${have} satisfies ${constraint}`);
			continue;
		}
		if (result === 'no') {
			conflicts.push({
				requires: dep,
				constraint,
				installed: have,
				reason: 'version',
				detail: `${dep} is ${have} but ${constraint} is required`
			});
			continue;
		}
		conflicts.push({
			requires: dep,
			constraint,
			installed: have,
			reason: 'unverifiable',
			detail: `cannot decide whether ${dep} ${have} satisfies ${constraint}`
		});
	}
	return { conflicts, satisfied };
}

/** turns a set of conflicts into the single verdict word */
export function verdictFor(conflicts: Conflict[]): 'installable' | 'blocked' | 'unverifiable' {
	if (conflicts.some((c) => c.reason === 'missing' || c.reason === 'version')) return 'blocked';
	if (conflicts.length > 0) return 'unverifiable';
	return 'installable';
}

/**
 * The whole check: one fetch, then arithmetic.
 *
 * @param fetcher injected so a test drives it without network, and so a caller can supply a
 *   cache-wrapped fetch. Packagist's p2 payloads are immutable per version, which is what makes one
 *   cached fetch the right shape.
 */
export async function checkInstallable(
	fetcher: (url: string) => Promise<Response>,
	name: string,
	installed: Record<string, string>,
	platform: PlatformVersions = DEFAULT_PLATFORM
): Promise<InstallVerdict> {
	if (!isValidPackageName(name)) {
		return {
			name,
			version: null,
			verdict: 'not-found',
			conflicts: [],
			satisfied: [],
			note: 'not a valid vendor/package name'
		};
	}

	let meta: unknown;
	try {
		const res = await fetcher(packagistUrl(name));
		if (!res.ok) {
			return {
				name,
				version: null,
				verdict: 'not-found',
				conflicts: [],
				satisfied: [],
				note: `packagist returned ${res.status}`
			};
		}
		meta = await res.json();
	} catch (e) {
		// a network failure is UNVERIFIABLE, never installable: the site must not install on a guess
		return {
			name,
			version: null,
			verdict: 'unverifiable',
			conflicts: [],
			satisfied: [],
			note: `packagist unreachable: ${String((e as Error)?.message ?? e).slice(0, 120)}`
		};
	}

	const newest = newestVersion(meta, name);
	if (!newest) {
		return {
			name,
			version: null,
			verdict: 'not-found',
			conflicts: [],
			satisfied: [],
			note: 'no non-dev release in the packagist payload'
		};
	}

	const { conflicts, satisfied } = checkRequirements(newest.require, installed, platform);
	return {
		name,
		version: newest.version,
		verdict: verdictFor(conflicts),
		conflicts,
		satisfied,
		note: 'direct requirements only; transitive dependencies are not resolved'
	};
}
