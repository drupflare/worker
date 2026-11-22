import { GENERATED_WP_PACKAGES } from './generated/packages';

/** the kinds of package WordPress loads from its content folder */
export type WpKind = 'plugin' | 'theme';

/** one package in `config/wp-plugins.yml`: what it is, its licence, and every version pinned */
export interface WpPackageEntry {
	kind: WpKind;
	licence: string;
	why?: string;
	/** each pinned version with the digest of its archive and the PHP version it declares */
	versions: Record<string, { digest: string; php: string }>;
}

/** a pinned version, resolved to what a download is checked against */
export interface PinnedPackage {
	slug: string;
	kind: WpKind;
	version: string;
	/** `sha256:` and 64 hex digits */
	digest: string;
	/** the minimum PHP version the package declares */
	php: string;
	licence: string;
	url: string;
}

/** the PHP the interpreter runs; a package that declares a higher minimum is refused */
export const RUNNING_PHP = '8.5';

/** the folder under `wp-content` that holds a kind */
export function contentFolder(kind: WpKind): string {
	return kind === 'plugin' ? 'plugins' : 'themes';
}

/** where wordpress.org serves a release archive */
export function archiveUrl(kind: WpKind, slug: string, version: string): string {
	return `https://downloads.wordpress.org/${kind}/${slug}.${version}.zip`;
}

/** compares dotted versions numerically; a non-numeric part counts as 0 */
export function compareVersions(a: string, b: string): number {
	const left = a.split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
	const right = b.split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

/** the registry rows, with the generated set as the default so a spec can pass its own */
export type Registry = Readonly<Record<string, WpPackageEntry>>;

/**
 * Resolves a slug and an optional version to a pinned package. With no version it takes the
 * highest pinned one. A version that is not pinned is a refusal; nothing outside the registry is
 * ever downloaded.
 */
export function resolvePinned(
	slug: string,
	version?: string,
	registry: Registry = GENERATED_WP_PACKAGES
): PinnedPackage | { error: string } {
	const entry = registry[slug];
	if (entry === undefined) return { error: `${slug} is not in the package registry` };
	const pinned = Object.keys(entry.versions).sort(compareVersions);
	const chosen = version ?? pinned[pinned.length - 1];
	const row = chosen === undefined ? undefined : entry.versions[chosen];
	if (chosen === undefined || row === undefined) {
		return { error: `${slug} ${version} is not pinned; pinned: ${pinned.join(', ')}` };
	}
	return {
		slug,
		kind: entry.kind,
		version: chosen,
		digest: row.digest,
		php: row.php,
		licence: entry.licence,
		url: archiveUrl(entry.kind, slug, chosen)
	};
}

/** whether the interpreter satisfies a declared minimum PHP version */
export function phpSatisfies(minimum: string, running: string = RUNNING_PHP): boolean {
	return compareVersions(running, minimum) >= 0;
}

/** one header of a plugin or theme main file, read from its first 8 KiB */
export function readHeader(source: string, name: string): string | undefined {
	const head = source.slice(0, 8192);
	const found = new RegExp(`^[ \\t/*#@]*${name}:[ \\t]*(.+)$`, 'mi').exec(head);
	return found?.[1]?.replace(/\s*(\*\/|\?>).*$/, '').trim();
}
