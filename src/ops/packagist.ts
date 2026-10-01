/**
 * Decides whether a module can be installed from one cacheable metadata fetch, and refuses with
 * the named conflict when it cannot.
 *
 * This is the check, not the install: a refusal is cheap, and `composer require` on the edge needs
 * a solver and minutes of CPU. Only direct requirements are checked, against the shipped lock;
 * transitive resolution is unbounded subrequests and still would not match Composer. Anything not
 * satisfied is `blocked` or `unverifiable`, and `unverifiable` is not a yes.
 *
 * @module
 */
import { errorMessage } from '../util/errors';
import { satisfies, type Satisfaction } from './composer-constraint';
import { asksForBranch, devMetadataUrl, pickVersion } from './package-install';
import { SHIPPED_PROVIDES } from './shipped-lock';

/**
 * The v2 metadata endpoint for a package; one GET, and the response is immutable per version.
 *
 * Routed by vendor: Drupal contrib is not on Packagist, only on drupal.org's own Composer
 * repository, so the whole `drupal/` vendor (core included) goes there.
 */
export const DRUPAL_METADATA_URL = 'https://packages.drupal.org/files/packages/8/p2/%package%.json';

/** the metadata URL for a package, routed by vendor */
export function packagistUrl(name: string): string {
	const vendor = String(name ?? '').split('/')[0];
	return vendor === 'drupal'
		? DRUPAL_METADATA_URL.replace('%package%', name)
		: `https://repo.packagist.org/p2/${name}.json`;
}

/**
 * A package name Packagist would accept, so a hostile value cannot be smuggled into the URL.
 *
 * Refuses rather than encodes: a name that needs escaping is not a package name.
 */
export function isValidPackageName(name: string): boolean {
	return /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/.test(
		String(name ?? '')
	);
}

export { lockProvides, lockVersions } from './lock-map';

/** whether any version a virtual package is provided at meets a constraint */
export function providedSatisfies(provided: string, constraint: string): Satisfaction {
	let unknown = false;
	for (const version of provided.split('|')) {
		const result = satisfies(version, constraint);
		if (result === 'yes') return 'yes';
		if (result === 'unknown') unknown = true;
	}
	return unknown ? 'unknown' : 'no';
}

/**
 * Requirements satisfied by the platform rather than by a package.
 *
 * Listed rather than pattern-matched on `ext-`, so a missing extension is a real conflict (this
 * build has no `pdo_sqlite`).
 */
export type PlatformVersions = Record<string, string>;

/**
 * The interpreter version this map reports (what `/php` reports on a deployed site).
 *
 * Extension entries carry the same version: a bundled extension is part of the interpreter.
 */
export const PLATFORM_PHP_VERSION = '8.5.2';

/**
 * Extensions the interpreter loads, measured rather than inferred.
 *
 * `tests/integration/loaded-extensions.spec.ts` asserts this map both ways against
 * `get_loaded_extensions()` on the shipping binary; no name in {@link POLYFILLED_PLATFORM} is
 * loaded. Function names in the binary are not evidence (opcache's `func_info` table names
 * functions of extensions the build lacks).
 */
export const NATIVE_PLATFORM: PlatformVersions = {
	php: PLATFORM_PHP_VERSION,
	'ext-json': PLATFORM_PHP_VERSION,
	'ext-pcre': PLATFORM_PHP_VERSION,
	'ext-spl': PLATFORM_PHP_VERSION,
	'ext-tokenizer': PLATFORM_PHP_VERSION,
	'ext-xml': PLATFORM_PHP_VERSION,
	'ext-dom': PLATFORM_PHP_VERSION,
	'ext-simplexml': PLATFORM_PHP_VERSION,
	'ext-zlib': PLATFORM_PHP_VERSION,
	// real extension (`--disable-mbregex`; `mb_ereg*` is absent and core calls none of it)
	'ext-mbstring': PLATFORM_PHP_VERSION,
	'ext-core': PLATFORM_PHP_VERSION,
	'ext-standard': PLATFORM_PHP_VERSION,
	'ext-ctype': PLATFORM_PHP_VERSION,
	'ext-date': PLATFORM_PHP_VERSION,
	'ext-filter': PLATFORM_PHP_VERSION,
	'ext-hash': PLATFORM_PHP_VERSION,
	'ext-libxml': PLATFORM_PHP_VERSION,
	'ext-pdo': PLATFORM_PHP_VERSION,
	'ext-random': PLATFORM_PHP_VERSION,
	'ext-reflection': PLATFORM_PHP_VERSION,
	'ext-session': PLATFORM_PHP_VERSION,
	'ext-uri': PLATFORM_PHP_VERSION,
	'ext-yaml': PLATFORM_PHP_VERSION,
	// vendor/composer/InstalledVersions.php ships in the pack, which is what the runtime API is
	'composer-runtime-api': '2.2.2'
};

/**
 * Extensions supplied by PHP code rather than by the build.
 *
 * A polyfill is not the extension, so a module requiring one gets `unverifiable`, never
 * `installable` (see {@link checkRequirements}). An entry leaves only when a measurement shows the
 * build supplies the extension, not when a parity run finds fewer divergences.
 */
export const POLYFILLED_PLATFORM: PlatformVersions = {
	'ext-iconv': PLATFORM_PHP_VERSION
};

/**
 * Extensions a module can require and get, served by a stand-in the driver installs at boot.
 *
 * Unlike a polyfill these count as satisfied: each is parity-tested against the real extension
 * (`curl-fix.spec.ts`, `host-bridges.spec.ts`, drupflare's health suite). What a stand-in does not
 * implement is refused at the call and recorded as a degradation, never answered wrongly.
 */
export const STANDIN_PLATFORM: PlatformVersions = {
	'ext-curl': PLATFORM_PHP_VERSION,
	'ext-openssl': PLATFORM_PHP_VERSION,
	'ext-zip': PLATFORM_PHP_VERSION,
	'ext-exif': PLATFORM_PHP_VERSION,
	'ext-fileinfo': PLATFORM_PHP_VERSION,
	'ext-xmlwriter': PLATFORM_PHP_VERSION
};

/** everything a requirement can resolve against; the split is what the verdict reports */
export const DEFAULT_PLATFORM: PlatformVersions = {
	...NATIVE_PLATFORM,
	...POLYFILLED_PLATFORM,
	...STANDIN_PLATFORM
};

/** one requirement the site cannot meet, or cannot be judged against */
export type Conflict = {
	requires: string;
	constraint: string;
	/** the version this site has, or null when the requirement is absent entirely */
	installed: string | null;
	reason: 'missing' | 'version' | 'unverifiable' | 'polyfilled';
	detail: string;
};

/** the answer to "can this module be installed here", with the evidence behind it */
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
	name: string,
	constraint?: string,
	stability?: string
): { version: string; require: Record<string, string> } | null {
	if (constraint) {
		// the version an install of `name:constraint` would take, not the newest release
		const entry = pickVersion(meta, name, constraint, undefined, stability);
		if (!entry) return null;
		const cleaned: Record<string, string> = {};
		for (const [k, v] of Object.entries((entry['require'] ?? {}) as Record<string, unknown>)) {
			if (typeof v === 'string') cleaned[k] = v;
		}
		return { version: String(entry['version']), require: cleaned };
	}
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
 * An `unknown` from the constraint checker becomes an `unverifiable` conflict, so the verdict
 * degrades instead of reading as installable. A requirement met only by
 * {@link POLYFILLED_PLATFORM} degrades the same way; `installed` wins over both maps.
 */
export function checkRequirements(
	require: Record<string, string>,
	installed: Record<string, string>,
	platform: PlatformVersions = DEFAULT_PLATFORM,
	provides: Record<string, string> = SHIPPED_PROVIDES
): { conflicts: Conflict[]; satisfied: string[] } {
	const conflicts: Conflict[] = [];
	const satisfied: string[] = [];

	for (const [dep, constraint] of Object.entries(require)) {
		const provided = installed[dep] === undefined ? provides[dep] : undefined;
		if (provided !== undefined && platform[dep] === undefined) {
			const verdict = providedSatisfies(provided, constraint);
			if (verdict === 'yes') {
				satisfied.push(`${dep} is provided at ${provided}, which satisfies ${constraint}`);
			} else {
				conflicts.push({
					requires: dep,
					constraint,
					installed: provided,
					reason: verdict === 'no' ? 'version' : 'unverifiable',
					detail: `${dep} is provided at ${provided} and ${constraint} is required`
				});
			}
			continue;
		}
		const have = installed[dep] ?? platform[dep] ?? null;
		const polyfilled = installed[dep] === undefined && POLYFILLED_PLATFORM[dep] !== undefined;
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
			if (polyfilled) {
				conflicts.push({
					requires: dep,
					constraint,
					installed: have,
					reason: 'polyfilled',
					detail: `${dep} is supplied by a PHP polyfill rather than by the build, so ${constraint} cannot be verified`
				});
				continue;
			}
			const standin =
				installed[dep] === undefined &&
				NATIVE_PLATFORM[dep] === undefined &&
				STANDIN_PLATFORM[dep] !== undefined;
			satisfied.push(
				`${dep} ${have} satisfies ${constraint}${standin ? ' (host stand-in)' : ''}`
			);
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

/**
 * Turns a set of conflicts into the single verdict word.
 *
 * `polyfilled` and `unverifiable` both land on `unverifiable` (the operator vocabulary has three
 * states); the `detail` on each conflict carries the difference.
 */
export function verdictFor(conflicts: Conflict[]): 'installable' | 'blocked' | 'unverifiable' {
	if (conflicts.some((c) => c.reason === 'missing' || c.reason === 'version')) return 'blocked';
	if (conflicts.length > 0) return 'unverifiable';
	return 'installable';
}

/**
 * The whole check: one fetch, then arithmetic.
 *
 * @param fetcher injected so a test runs without network and a caller can pass a cache-wrapped
 *   fetch (p2 payloads are immutable per version)
 */
export async function checkInstallable(
	fetcher: (url: string) => Promise<Response>,
	name: string,
	installed: Record<string, string>,
	platform: PlatformVersions = DEFAULT_PLATFORM,
	constraint?: string,
	stability?: string
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
	let metaUrl = packagistUrl(name);
	try {
		let res = await fetcher(metaUrl);
		// a drupal/* JavaScript library is published on Packagist, not drupal.org
		if (res.status === 404 && name.startsWith('drupal/'))
			res = await fetcher((metaUrl = `https://repo.packagist.org/p2/${name}.json`));
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
		// a network failure is unverifiable, never installable (no installing on a guess)
		return {
			name,
			version: null,
			verdict: 'unverifiable',
			conflicts: [],
			satisfied: [],
			note: `packagist unreachable: ${errorMessage(e).slice(0, 120)}`
		};
	}

	let newest = newestVersion(meta, name, constraint, stability);
	// a branch constraint is answered from the `~dev` file; see devMetadataUrl
	if (!newest && (asksForBranch(constraint) || stability === 'dev')) {
		try {
			const branches = await fetcher(devMetadataUrl(metaUrl));
			if (branches.ok)
				newest = newestVersion(await branches.json(), name, constraint, stability);
		} catch {
			// the release file already answered; a missing branch file leaves it not-found
		}
	}
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
