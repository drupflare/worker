/**
 * Where a built payload is published on the CDN, and what gets published beside it.
 *
 * THE BUCKET ALREADY HAD A PUBLISHING PATH AND THIS IS DELIBERATELY NOT IT. `scripts/backup-cdn.ts`
 * backs up what nothing can regenerate -- `vendor/` and `assets/drupal/site.sqlite` -- and its own
 * docblock says backing up OUTPUT is what produced three divergent copies of the one file that
 * mattered. A payload is output: CI rebuilds it from a commit every time. So payloads live under
 * their own prefix, are never named in `cdn-manifest.json`, and nothing here verifies against it.
 *
 * WHY THE CDN AT ALL, when a GitHub release already hosts the same bytes: Cloudflare Workers Builds
 * hung for the whole job timeout pulling a release asset, having already restored the interpreter
 * from this CDN in 0.6 s from the same container. The release stays the canonical artifact; the CDN
 * is the copy the deploy button can actually reach.
 *
 * Two lines, following composer's spelling so the layout reads without explanation:
 *
 * ```txt
 * payloads/v1.0.0/      a release, immutable, one per version
 * payloads/dev-master/  the tip of a branch, overwritten on every push
 * ```
 */

/** everything payload lives under this, so the prefix alone separates output from the backup set */
export const PAYLOAD_PREFIX = 'payloads';

/** an immutable cut version, or a branch tip that the next push replaces */
export type PayloadKind = 'release' | 'dev';

/**
 * A branch name as it appears in a key.
 *
 * `/` is legal in an R2 key and would nest `feat/x` into its own prefix, which makes a listing read
 * as a hierarchy that is not one. Flattened to a dash, so `feat/x` is `dev-feat-x`.
 */
export function devLabel(branch: string): string {
	const clean = branch
		.trim()
		.replace(/^refs\/heads\//, '')
		.replace(/[^A-Za-z0-9._/-]/g, '-')
		.replace(/\//g, '-')
		.replace(/^-+|-+$/g, '');
	return `dev-${clean === '' ? 'unknown' : clean}`;
}

/** the key prefix a released payload is published under; `tag` carries its leading `v` */
export function releaseKeyBase(tag: string): string {
	return `${PAYLOAD_PREFIX}/${tag.startsWith('v') ? tag : `v${tag}`}`;
}

/** the key prefix a branch's rolling payload is published under */
export function devKeyBase(branch: string): string {
	return `${PAYLOAD_PREFIX}/${devLabel(branch)}`;
}

/** the URL a key prefix is served from, for a given CDN origin */
export function payloadBaseUrl(origin: string, keyBase: string): string {
	return `${origin.replace(/\/+$/, '')}/${keyBase}`;
}

/**
 * What a publish uploads out of `dist/`, beyond the tarball itself.
 *
 * `SHA256SUMS` is load-bearing rather than a convenience: it names the tarball, so a consumer reads
 * the filename out of it instead of deriving one from a version it has to guess. The other two are
 * inspectable metadata -- `manifest.json` answers "what is in this payload" without pulling 23 MB,
 * and `metrics.json` is the Class A snapshot when the lane that writes it has run.
 *
 * Absent entries are skipped rather than failing a publish: `metrics.json` comes from the metrics
 * lane and is legitimately missing from a release job's `dist/`.
 */
export const PUBLISHED_SIDECARS = ['SHA256SUMS', 'manifest.json', 'metrics.json'] as const;

/**
 * The tarball a `SHA256SUMS` names, and its digest.
 *
 * Reading the name back rather than deriving it is what lets the dev line work at all: a rolling
 * payload is built from whatever `package.json` said at that commit, and a checkout resolving it
 * has no way to know which version that was.
 */
export function readSums(text: string): { sha256: string; name: string } {
	const line = text
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l !== '');
	if (line === undefined) throw new Error('SHA256SUMS is empty');
	const [sha256, name] = line.split(/\s+/);
	if (sha256 === undefined || !/^[0-9a-f]{64}$/.test(sha256)) {
		throw new Error(`SHA256SUMS does not open with a sha256: ${line.slice(0, 40)}`);
	}
	if (name === undefined || !/^[A-Za-z0-9._-]+\.tar\.gz$/.test(name)) {
		throw new Error(`SHA256SUMS names no tarball: ${line.slice(0, 80)}`);
	}
	return { sha256, name };
}
