import { fetchGuarded, outboundGuardEnabled, refuseOutbound } from '../ops/outbound-guard';
import type { SitePhpDurableObject } from '../site-do';
import { errorMessage } from '../util/errors';
import { bytesToHex } from '../util/hex';
import {
	commitDelivery,
	overlayKey,
	readOverlay,
	retireDelivery,
	rollbackDelivery,
	type WpReceipt
} from './overlay';
import { phpSatisfies, readHeader, type Registry, resolvePinned, type WpKind } from './registry';
import { readZipPackage, ZIP_LIMITS, ZipRefused, type ZipRule } from './zip';

/** what an operation answers: the receipt it left, or the reason nothing changed */
export type PackageOutcome =
	| { ok: true; receipt: WpReceipt; skipped: number }
	| { ok: true; unchanged: true; version: string }
	| { ok: false; error: string; rule?: ZipRule | 'digest' | 'header' | 'php' | 'fetch' };

/** the seams a spec replaces */
export interface PackageDeps {
	fetcher?: typeof fetch;
	registry?: Registry;
}

const refuse = (
	error: string,
	rule?: Extract<PackageOutcome, { ok: false }>['rule']
): PackageOutcome => ({ ok: false, error, ...(rule === undefined ? {} : { rule }) });

const decoder = new TextDecoder();

/** the main file's header text: the plugin file at the top of the folder, or a theme's style.css */
function mainHeader(
	kind: WpKind,
	files: readonly { path: string; bytes: Uint8Array }[]
): { name: string; source: string } | undefined {
	const label = kind === 'plugin' ? 'Plugin Name' : 'Theme Name';
	const candidates = files.filter((f) =>
		kind === 'plugin' ? /^[^/]+\.php$/.test(f.path) : f.path === 'style.css'
	);
	for (const file of candidates) {
		const source = decoder.decode(file.bytes.subarray(0, 8192));
		if (readHeader(source, label) !== undefined) return { name: file.path, source };
	}
	return undefined;
}

/**
 * Downloads, verifies, hardens and stores one pinned package, then makes it the version the tree
 * mounts on the next boot.
 *
 * Every step before the commit is read-only on the site, so a failure in the download, the digest,
 * the archive rules or the header check leaves what is mounted untouched. The commit is one
 * transaction. The archive is fetched through the outbound guard (redirects included) and its
 * SHA-256 must equal the registry's pin; nothing the caller passes can waive either.
 */
export async function deliverPackage(
	site: SitePhpDurableObject,
	slug: string,
	version: string | undefined,
	deps: PackageDeps = {}
): Promise<PackageOutcome> {
	const pinned = resolvePinned(slug, version, deps.registry);
	if ('error' in pinned) return refuse(pinned.error);
	if (!phpSatisfies(pinned.php)) {
		return refuse(`${slug} ${pinned.version} needs PHP ${pinned.php} or newer`, 'php');
	}
	const held = readOverlay(site).packages[overlayKey(pinned.kind, slug)]?.active;
	if (held?.version === pinned.version && held.digest === pinned.digest) {
		return { ok: true, unchanged: true, version: held.version };
	}

	let archive: Uint8Array;
	try {
		const guard = outboundGuardEnabled(site.env) ? refuseOutbound : () => undefined;
		const refusal = guard(pinned.url);
		if (refusal !== undefined) return refuse(refusal.reason, 'fetch');
		const res = await fetchGuarded(
			deps.fetcher ?? site.parkFetchDep ?? fetch,
			pinned.url,
			{ headers: { 'user-agent': 'drupflare' } },
			guard
		);
		if (!res.ok) return refuse(`${pinned.url} answered ${res.status}`, 'fetch');
		const declared = Number(res.headers.get('content-length') ?? 0);
		if (declared > ZIP_LIMITS.archiveBytes) {
			return refuse(`${declared} bytes is over the archive cap`, 'archive-too-large');
		}
		archive = new Uint8Array(await res.arrayBuffer());
	} catch (e) {
		return refuse(`download failed: ${errorMessage(e)}`, 'fetch');
	}

	const actual = `sha256:${bytesToHex(await crypto.subtle.digest('SHA-256', archive as Uint8Array<ArrayBuffer>))}`;
	if (actual !== pinned.digest) {
		return refuse(
			`${slug} ${pinned.version} does not match its pinned digest (expected ${pinned.digest}, got ${actual})`,
			'digest'
		);
	}

	let files;
	let skipped;
	try {
		const pkg = readZipPackage(archive, slug);
		files = pkg.files;
		skipped = pkg.skipped.length;
	} catch (e) {
		if (e instanceof ZipRefused) return refuse(e.message, e.rule);
		throw e;
	}

	const main = mainHeader(pinned.kind, files);
	if (main === undefined) {
		return refuse(
			`${slug} has no ${pinned.kind === 'plugin' ? 'plugin' : 'theme'} header`,
			'header'
		);
	}
	const declaredVersion = readHeader(main.source, 'Version');
	if (declaredVersion !== pinned.version) {
		return refuse(
			`${main.name} says version ${declaredVersion ?? 'none'}, the pin is ${pinned.version}`,
			'header'
		);
	}
	const declaredPhp = readHeader(main.source, 'Requires PHP');
	if (declaredPhp !== undefined && declaredPhp !== pinned.php) {
		return refuse(
			`${main.name} requires PHP ${declaredPhp}, the pin says ${pinned.php}`,
			'header'
		);
	}

	try {
		const receipt = commitDelivery(site, {
			kind: pinned.kind,
			slug,
			version: pinned.version,
			digest: pinned.digest,
			files,
			now: site.nowMs()
		});
		afterChange(site);
		return { ok: true, receipt, skipped };
	} catch (e) {
		return refuse(`the store refused the package: ${errorMessage(e)}`);
	}
}

/** a changed tree needs a fresh interpreter and no page rendered from the old code */
function afterChange(site: SitePhpDurableObject): void {
	site.php = undefined;
	site.bumpGeneration('wordpress-package');
}

/** the kind a delivered slug has, or undefined when the host never delivered it */
function deliveredKind(site: SitePhpDurableObject, slug: string): WpKind | undefined {
	const packages = readOverlay(site).packages;
	for (const kind of ['plugin', 'theme'] as const) {
		if (packages[overlayKey(kind, slug)] !== undefined) return kind;
	}
	return undefined;
}

/** whether WordPress has the package switched on, read from its options table */
export function wordpressHolds(site: SitePhpDurableObject, kind: WpKind, slug: string): boolean {
	try {
		const names = kind === 'plugin' ? ['active_plugins'] : ['stylesheet', 'template'];
		const rows = site.sql
			.exec<{ option_value: string }>(
				`SELECT option_value FROM wp_options WHERE option_name IN (${names.map(() => '?').join(',')})`,
				...names
			)
			.toArray();
		return rows.some((row) =>
			kind === 'plugin'
				? String(row.option_value).includes(`"${slug}/`)
				: String(row.option_value) === slug
		);
	} catch (e) {
		// a site WordPress has not installed on holds nothing
		if (/no such table/i.test(errorMessage(e))) return false;
		throw e;
	}
}

/** puts the earlier version back, or the deleted one; a second call undoes the first */
export function rollbackPackage(site: SitePhpDurableObject, slug: string): PackageOutcome {
	const kind = deliveredKind(site, slug);
	if (kind === undefined) return refuse(`${slug} was not delivered by the host`);
	const out = rollbackDelivery(site, kind, slug, site.nowMs());
	if ('error' in out) return refuse(out.error);
	afterChange(site);
	return { ok: true, receipt: out, skipped: 0 };
}

/**
 * Takes a delivered package out of the tree and keeps it as the previous version.
 *
 * Refused while WordPress has it switched on, since the next request would fatal on a missing
 * file; deactivate it in the dashboard first. The package's own uninstall hook is not run: it is
 * code the package chooses, with write access to every WordPress table, and WordPress itself only
 * runs it when it deletes the files, which this site never lets it do. The receipt says so, and the
 * data the package keeps in WordPress tables stays where a rollback can use it.
 */
export function deletePackage(site: SitePhpDurableObject, slug: string): PackageOutcome {
	const kind = deliveredKind(site, slug);
	if (kind === undefined) return refuse(`${slug} was not delivered by the host`);
	if (wordpressHolds(site, kind, slug)) {
		return refuse(`${slug} is active in WordPress; deactivate it first`);
	}
	const out = retireDelivery(
		site,
		kind,
		slug,
		site.nowMs(),
		'uninstall hook not run: the host removes files and leaves the package data in place'
	);
	if ('error' in out) return refuse(out.error);
	afterChange(site);
	return { ok: true, receipt: out, skipped: 0 };
}
