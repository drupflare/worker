import { portFibers } from '../ops/composer/package-install';
import {
	digestBytes,
	digestSource,
	emptyIntegrityStats,
	isAdopted,
	markAdopted,
	noteRefusal,
	readAllRecords,
	readPackageRecords,
	recordMatches,
	writePackageRecords
} from '../ops/module/integrity';
import { proxyStub } from '../ops/proxy-stub';
import {
	addReturnTypes,
	emptyReport,
	type ModuleSource,
	type ReturnTypeReport,
	returnTypesOff
} from '../ops/return-types';
import { OWNER_HASH_KEY } from '../ops/site/secrets';
import type { SitePhpDurableObject } from '../site-do';
import { firstRow } from '../util/sql';
import { trustsModuleFiles } from './replica/role';

/** one file a delivery stores */
export type ModuleFilePut = { path: string; source: string; version: string };

/** what one delivery does to a package's rows */
export type ModuleFileChange = {
	put?: readonly ModuleFilePut[];
	/** paths of this package to delete */
	remove?: readonly string[];
	/** delete every row of the package first */
	clear?: boolean;
	installedAt: number;
	/** receives what the return type rewrite did to this delivery */
	returnTypes?: ReturnTypeReport;
};

/**
 * The only function that writes `cfw_module_file`: the integrity records go to sealed storage
 * first and the rows second, so a crash leaves a record without a row and never the reverse.
 *
 * Nothing here awaits, so a Durable Object commits the records and the rows as one write. Answers
 * the key-value rows it wrote, which the caller adds to its row meter.
 */
export function changeModuleFiles(
	site: SitePhpDurableObject,
	pkg: string,
	change: ModuleFileChange
): number {
	const store = site.secretStore().sealed;
	// a generated proxy is replaced by a stub, and an extension's untyped overrides gain the return
	// types core now declares, so the record and the row hold the bytes that run
	const stubbed = (change.put ?? []).map((file) => ({
		...file,
		source: proxyStub(file.path, file.source)
	}));
	const put = returnTypesOff(site.env)
		? stubbed
		: addReturnTypes(
				stubbed,
				change.returnTypes ?? emptyReport(),
				change.clear ? undefined : () => storedSources(site, pkg)
			);
	const records = change.clear ? new Map<string, string>() : readPackageRecords(store, pkg);
	for (const path of change.remove ?? []) records.delete(path);
	// a path another package owned changes hands, so the old owner's record goes with it
	const taken = new Map<string, string[]>();
	for (const file of put) {
		records.set(file.path, digestSource(file.source));
		const prior = firstRow(
			site.sql.exec<{ package: string }>(
				'SELECT package FROM cfw_module_file WHERE path = ?',
				file.path
			)
		);
		if (prior !== undefined && String(prior.package) !== pkg) {
			const owner = String(prior.package);
			taken.set(owner, [...(taken.get(owner) ?? []), file.path]);
		}
	}
	let written = writePackageRecords(store, pkg, records);
	for (const [owner, paths] of taken) {
		const held = readPackageRecords(store, owner);
		for (const path of paths) held.delete(path);
		written += writePackageRecords(store, owner, held);
	}
	if (change.clear) site.sql.exec('DELETE FROM cfw_module_file WHERE package = ?', pkg);
	for (const path of change.remove ?? []) {
		site.sql.exec('DELETE FROM cfw_module_file WHERE path = ? AND package = ?', path, pkg);
	}
	for (const file of put) {
		site.sql.exec(
			`INSERT INTO cfw_module_file (path, package, version, source, installed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             package = excluded.package,
             version = excluded.version,
             source = excluded.source,
             installed_at = excluded.installed_at`,
			file.path,
			pkg,
			file.version,
			file.source,
			change.installedAt
		);
	}
	return written;
}

/**
 * The files as they will be stored: the Fiber port, the generated-proxy stub and the return types.
 *
 * A plan compares these with the stored rows, so a file the pipeline changes reads unchanged on a
 * second identical delivery. `stored` is what the caller already holds for the package, so the
 * return type pass resolves a parent in an untouched file without another read. What the pass did
 * goes to `report` by path.
 */
export function executedFiles<T extends ModuleSource>(
	env: { ANACHRON_RETURN_TYPES?: string } | undefined,
	stored: ReadonlyMap<string, string>,
	files: readonly T[],
	report: ReturnTypeReport
): T[] {
	const prepared = files.map((file) => ({
		...file,
		source: proxyStub(file.path, portFibers(file.path, file.source))
	}));
	if (returnTypesOff(env)) return prepared;
	return addReturnTypes(prepared, report, () =>
		[...stored].map(([path, source]) => ({ path, source }))
	);
}

/** the files a package holds, which a smaller delivery needs to resolve its parent classes */
function storedSources(site: SitePhpDurableObject, pkg: string): ModuleSource[] {
	return site.sql
		.exec<{ path: string; source: string }>(
			'SELECT path, source FROM cfw_module_file WHERE package = ?',
			pkg
		)
		.toArray()
		.map((row) => ({ path: String(row.path), source: String(row.source) }));
}

/** moves a package's rows and records to another name, as a git branch switch does */
export function renameModulePackage(site: SitePhpDurableObject, from: string, to: string): number {
	const store = site.secretStore().sealed;
	const records = readPackageRecords(store, to);
	for (const [path, hash] of readPackageRecords(store, from)) records.set(path, hash);
	let written = writePackageRecords(store, to, records);
	written += writePackageRecords(store, from, new Map());
	site.sql.exec('UPDATE cfw_module_file SET package = ? WHERE package = ?', to, from);
	return written;
}

/** whether the site is claimed, which is when its rows start to be held to their records */
function claimed(site: SitePhpDurableObject): boolean {
	return (site.secretStore().sealed.get(OWNER_HASH_KEY) ?? '') !== '';
}

/**
 * The entries a rollback may put back: the ones whose bytes still match their record. A row
 * planted through SQL is not restored, so a failed delivery cannot bless it.
 */
export function trustedEntries(
	site: SitePhpDurableObject,
	entries: readonly (readonly [string, string])[]
): [string, string][] {
	const store = site.secretStore().sealed;
	if (trustsModuleFiles(site) || !claimed(site) || !isAdopted(store)) {
		return entries.map(([path, source]) => [path, source]);
	}
	const records = readAllRecords(store);
	return entries
		.filter(([path, source]) => recordMatches(records.get(path), digestSource(source)))
		.map(([path, source]) => [path, source]);
}

/** checks a file's bytes the first time it is opened, and says whether it may be served */
export type ModuleVerifier = (path: string, bytes: Uint8Array, at: SitePhpDurableObject) => boolean;

/**
 * Readies the check a mount runs on every first open.
 *
 * An unclaimed site and a replica are not checked: the first has no owner to hold anything to,
 * and a lane receives rows without records. On a claimed site that has not adopted yet, every row
 * without a record is trusted as it stands and recorded, once; after that a row with no record is
 * refused.
 */
export function prepareIntegrity(
	site: SitePhpDurableObject,
	rows: readonly { path: string; package: string }[]
): ModuleVerifier {
	const stats = (site.moduleIntegrity ??= emptyIntegrityStats());
	const store = site.secretStore().sealed;
	stats.adopted = 0;
	if (trustsModuleFiles(site)) {
		stats.mode = 'replica';
		return () => true;
	}
	if (!claimed(site)) {
		stats.mode = 'unclaimed';
		return () => true;
	}
	stats.mode = 'enforcing';
	const records = readAllRecords(store);
	if (!isAdopted(store)) {
		const added = new Map<string, Map<string, string>>();
		for (const row of rows) {
			if (records.has(row.path)) continue;
			const held = firstRow(
				site.sql.exec<{ source: string }>(
					'SELECT source FROM cfw_module_file WHERE path = ?',
					row.path
				)
			);
			const digest = digestSource(String(held?.source ?? ''));
			records.set(row.path, digest);
			const group = added.get(row.package) ?? new Map<string, string>();
			group.set(row.path, digest);
			added.set(row.package, group);
			stats.adopted++;
		}
		for (const [pkg, group] of added) {
			const merged = readPackageRecords(store, pkg);
			for (const [path, hash] of group) merged.set(path, hash);
			writePackageRecords(store, pkg, merged);
		}
		markAdopted(store);
	}
	stats.records = records.size;
	return (path, bytes, at) => {
		const seen = (at.moduleIntegrity ??= emptyIntegrityStats());
		seen.checked++;
		if (recordMatches(records.get(path), digestBytes(bytes))) return true;
		noteRefusal(seen, path, records.has(path) ? 'bytes differ from the record' : 'no record');
		return false;
	};
}
