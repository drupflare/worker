import { type LazyFS, mkdirp } from '@drupflare/cartridge/fs';
import { withMask } from '@drupflare/cartridge/mask';
import { type OracleResult, resolveInstallable } from '../ops/oracle';
import {
	asksForBranch,
	classmapOf,
	devMetadataUrl,
	distOf,
	fallbackMetadataUrl,
	isMetapackage,
	metadataUrl,
	type PackageAutoload,
	packageRequirements,
	pickVersion,
	portFibers,
	type Registry,
	unpackZip
} from '../ops/package-install';
import { SHIPPED_CORE_VERSION, SHIPPED_LOCK_VERSIONS, SHIPPED_PROVIDES } from '../ops/shipped-lock';
import type { SitePhpDurableObject } from '../site-do';
import { errorMessage, isMissingTable } from '../util/errors';
import { firstRow } from '../util/sql';
import { INSTALLED_FS_BUDGET_BYTES, type LazyInstalledNode } from './lazy-mount';
import type { SiteBinary } from './types';

export { applyRevision, handleModify } from './modify';

/**
 * The installability verdict, callable without going through the router.
 *
 * A route that needs another route's answer calls the method, never `this.fetch()`: the gate is
 * not reentrant, so the inner call waits on the outer forever (`/install` hung 300 s).
 */
export async function installableVerdict(
	site: SitePhpDurableObject,
	name: string,
	constraint?: string,
	stability?: string
): Promise<OracleResult> {
	const cache = caches.default;
	return await resolveInstallable(
		site.env as never,
		async (target: string) => {
			const key = new Request(target, { method: 'GET' });
			const hit = await cache.match(key);
			if (hit) return hit;
			const res = await fetch(key);
			if (res.ok) {
				// clone before the body is read; the ttl covers a new version under the same url
				const copy = new Response(res.clone().body, {
					status: res.status,
					headers: { 'cache-control': 'public, max-age=3600' }
				});
				await cache.put(key, copy);
			}
			return res;
		},
		name,
		SHIPPED_LOCK_VERSIONS,
		SHIPPED_CORE_VERSION,
		constraint,
		stability
	);
}

/** what every delivered library asked composer to register */
export function packageAutoloads(site: SitePhpDurableObject): PackageAutoload[] {
	try {
		return site.sql
			.exec<{
				package: string;
				version: string;
				mount: string;
				autoload: string;
				classmap: string;
			}>(
				'SELECT package, version, mount, autoload, classmap FROM cfw_package_autoload ORDER BY package'
			)
			.toArray()
			.map((row) => ({
				name: String(row.package),
				version: String(row.version),
				mount: String(row.mount),
				autoload: JSON.parse(String(row.autoload)),
				classmap: JSON.parse(String(row.classmap))
			}));
	} catch (e) {
		if (!isMissingTable(e)) site.noteError('packageAutoloads', e);
		return [];
	}
}

/**
 * Installs a package and everything it requires that this site does not already hold, bounded
 * so a runaway graph ends with a refusal.
 *
 * Breadth first, so a package that `replace`s another is installed before a deeper level asks
 * for the replaced name (depth first fetched a Drupal 9 distro under Open Y's sub-projects).
 */
export async function installTree(
	site: SitePhpDurableObject,
	registry: Registry,
	name: string,
	constraint?: string,
	budget = { left: 40 },
	stability?: string
): Promise<Record<string, unknown>[]> {
	const installed = new Set(
		[
			...site.sql
				.exec<{ package: string }>('SELECT DISTINCT package FROM cfw_module_file')
				.toArray(),
			...site.sql
				.exec<{ package: string }>('SELECT package FROM cfw_package_autoload')
				.toArray()
		].map((r) => String(r.package))
	);
	// names an earlier install's package replaces, so a resumed install does not fetch them
	const replacedBefore = JSON.parse(site.metaGet('package_replaces', '[]') ?? '[]') as string[];
	for (const name of replacedBefore) installed.add(name);
	const results: Record<string, unknown>[] = [];
	// ponytail: a replacer that sits deeper than the name it replaces still loses the race
	const queue: [string, string | undefined][] = [[name, constraint]];
	for (let next = queue.shift(); next; next = queue.shift()) {
		const [pkg, wanted] = next;
		// the package asked for by name is reinstalled over a version an earlier walk pulled in
		const asked = pkg === name && !!constraint && installed.has(pkg);
		if (
			(installed.has(pkg) && !asked) ||
			pkg in SHIPPED_LOCK_VERSIONS ||
			pkg in SHIPPED_PROVIDES ||
			pkg.startsWith('drupal/core')
		)
			continue;
		if (budget.left-- <= 0) {
			results.push({
				ok: false,
				name: pkg,
				// lets a caller resume from here
				constraint: wanted ?? null,
				error: 'the dependency graph is larger than one install may take'
			});
			continue;
		}
		installed.add(pkg);
		const out = await site.installPackage(registry, pkg, wanted, stability);
		results.push(out);
		if (out['ok'] !== true) continue;
		const replaces = (out['replaces'] ?? []) as string[];
		for (const replaced of replaces) installed.add(replaced);
		if (replaces.length > 0) {
			replacedBefore.push(...replaces);
			site.metaSet('package_replaces', JSON.stringify([...new Set(replacedBefore)]));
		}
		queue.push(...Object.entries((out['requires'] ?? {}) as Record<string, string>));
	}
	return results;
}

/**
 * Resolves one package and writes its files into `cfw_module_file`.
 *
 * The host half of `composer require` and of a git-delivered module (PHP cannot block on a
 * socket). Every file is its own row because a Durable Object record caps at 2,199,995 bytes.
 *
 * Reports what it dropped: `unpackZip()` keeps only mountable files.
 */
export async function installPackage(
	site: SitePhpDurableObject,
	registry: Registry,
	name: string,
	constraint?: string,
	stability?: string
): Promise<Record<string, unknown>> {
	site.ensureServeTables();
	try {
		let url = metadataUrl(registry, name);
		let meta = await fetch(url);
		const elsewhere = meta.status === 404 ? fallbackMetadataUrl(registry, name) : undefined;
		if (elsewhere !== undefined) meta = await fetch((url = elsewhere));
		if (!meta.ok) {
			return { ok: false, name, error: `metadata ${meta.status} for ${name}` };
		}
		let entry = pickVersion(await meta.json(), name, constraint, undefined, stability);
		if (!entry && registry !== 'npm' && (asksForBranch(constraint) || stability === 'dev')) {
			const branches = await fetch(devMetadataUrl(url));
			if (branches.ok)
				entry = pickVersion(await branches.json(), name, constraint, undefined, stability);
		}
		if (!entry) {
			return {
				ok: false,
				name,
				error: constraint
					? `no version of ${name} matches ${constraint}`
					: `${name} publishes no version this can read`
			};
		}
		// a drupal.org submodule: its parent's archive carries the files, so only its requirements
		// are walked
		if (isMetapackage(entry)) {
			return {
				ok: true,
				name,
				version: String(entry['version'] ?? ''),
				metapackage: true,
				mount: null,
				requires: packageRequirements(entry),
				replaces: Object.keys((entry['replace'] ?? {}) as object),
				files: 0
			};
		}
		// a composer plugin runs inside composer at build time and nothing on the edge loads it
		if (entry['type'] === 'composer-plugin') {
			return {
				ok: true,
				name,
				version: String(entry['version'] ?? ''),
				skipped: 'a composer plugin, which runs at build time only',
				mount: null,
				requires: {},
				replaces: [],
				files: 0
			};
		}
		const dist = distOf(entry, name);
		if (!dist) return { ok: false, name, error: `${name} has no downloadable archive` };
		if (dist.type !== 'zip') {
			// only npm serves tarballs and none is mountable as PHP, so refuse
			return {
				ok: false,
				name,
				error: `${name} ships a ${dist.type}, which is not read here`
			};
		}

		const archive = await fetch(dist.url, { headers: { 'user-agent': 'drupflare' } });
		if (!archive.ok) {
			return { ok: false, name, error: `archive ${archive.status} from ${dist.url}` };
		}
		const unpacked = unpackZip(new Uint8Array(await archive.arrayBuffer()), dist.mount);

		const decoder = new TextDecoder();
		for (const file of unpacked.files) {
			site.sql.exec(
				`INSERT INTO cfw_module_file (path, package, version, source, installed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             package = excluded.package,
             version = excluded.version,
             source = excluded.source,
             installed_at = excluded.installed_at`,
				file.path,
				name,
				dist.version,
				portFibers(file.path, decoder.decode(file.bytes)),
				site.nowMs()
			);
		}
		if (/^(modules|themes|profiles)\//.test(dist.mount)) site.dropCompiledContainer();
		const autoload = (entry['autoload'] ?? {}) as PackageAutoload['autoload'];
		// an extension's own classes are registered by Drupal's discovery, not a vendor autoload
		if (!/^(modules|themes|profiles)\//.test(dist.mount)) {
			const classmap = classmapOf(
				dist.mount,
				autoload,
				unpacked.files.map((f) => ({ path: f.path, source: decoder.decode(f.bytes) }))
			);
			site.sql.exec(
				`INSERT INTO cfw_package_autoload (package, version, mount, autoload, classmap)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(package) DO UPDATE SET version = excluded.version, mount = excluded.mount,
             autoload = excluded.autoload, classmap = excluded.classmap`,
				name,
				dist.version,
				dist.mount,
				JSON.stringify(autoload),
				JSON.stringify(classmap)
			);
		}
		return {
			ok: true,
			name,
			version: dist.version,
			mount: dist.mount,
			requires: packageRequirements(entry),
			replaces: Object.keys((entry['replace'] ?? {}) as object),
			files: unpacked.files.length,
			bytes: unpacked.totalBytes,
			skipped: unpacked.skipped.length,
			// dropped so the next boot mounts the files (a warm object would fatal on a module
			// PHP cannot see)
			note: 'installed; the interpreter is dropped so the next request mounts it'
		};
	} catch (e) {
		return { ok: false, name, error: errorMessage(e) };
	} finally {
		site.php = undefined;
	}
}

/**
 * Mounts every site-installed module file (from `cfw_module_file`) into the interpreter's
 * filesystem, read on first open; the counterpart to `mountDriver()` for packed modules.
 *
 * Only paths and sizes are read at boot: loading every source held each twice in JavaScript
 * (1,040 files, 6.1 MB for one site) and reset the isolate. A clean node is dropped again past
 * {@link INSTALLED_FS_BUDGET_BYTES}. Unconditional, since `core.extension` names these modules.
 */
export function mountInstalledModules(site: SitePhpDurableObject, binary: SiteBinary): number {
	site.ensureServeTables();
	const FS = binary.FS as unknown as LazyFS;
	// byte length via BLOB (length() on TEXT counts characters and stops at a NUL)
	const rows = site.sql
		.exec<{ path: string; bytes: number; installed_at: number }>(
			'SELECT path, length(CAST(source AS BLOB)) AS bytes, installed_at FROM cfw_module_file'
		)
		.toArray();
	if (rows.length === 0) return 0;
	// read through the current owner (the instance that mounted may be evicted, storage gone)
	const owner = site.phpOwner ?? { current: site };
	const resident = new Map<LazyInstalledNode, number>();
	let residentBytes = 0;
	const load = (node: LazyInstalledNode): void => {
		if (node.cfwLoaded) return;
		withMask(() => {
			const row = firstRow(
				owner.current.sql.exec<{ source: string }>(
					'SELECT source FROM cfw_module_file WHERE path = ?',
					node.cfwRow
				)
			);
			node.contents = new TextEncoder().encode(String(row?.source ?? ''));
			node.usedBytes = node.contents.length;
			node.cfwLoaded = true;
			resident.delete(node);
			resident.set(node, node.usedBytes);
			residentBytes += node.usedBytes;
			for (const [other, bytes] of resident) {
				if (residentBytes <= INSTALLED_FS_BUDGET_BYTES) break;
				if (other === node || other.cfwDirty) continue;
				resident.delete(other);
				other.contents = null;
				other.cfwLoaded = false;
				residentBytes -= bytes;
			}
		});
	};
	mkdirp(binary.FS, '/drupal');
	FS.writeFile('/drupal/.cfw-installed-probe', new Uint8Array(1));
	const probe = FS.lookupPath('/drupal/.cfw-installed-probe')
		.node as unknown as LazyInstalledNode;
	const base = probe.stream_ops;
	const nodeOps = probe.node_ops;
	FS.unlink('/drupal/.cfw-installed-probe');
	const ops = {
		...base,
		llseek(stream: { node: LazyInstalledNode }, ...rest: unknown[]) {
			load(stream.node);
			return (base.llseek as (...a: unknown[]) => number)(stream, ...rest);
		},
		read(stream: { node: LazyInstalledNode }, ...rest: unknown[]) {
			load(stream.node);
			return (base.read as (...a: unknown[]) => number)(stream, ...rest);
		},
		write(stream: { node: LazyInstalledNode }, ...rest: unknown[]) {
			load(stream.node);
			// a written node is not reproducible from its row, so it is never dropped
			stream.node.cfwDirty = true;
			return (base.write as (...a: unknown[]) => number)(stream, ...rest);
		},
		mmap(stream: { node: LazyInstalledNode }, ...rest: unknown[]) {
			load(stream.node);
			return (base.mmap as (...a: unknown[]) => unknown)(stream, ...rest);
		}
	};
	let written = 0;
	for (const row of rows) {
		const rel = String(row.path).replace(/^\/+/, '');
		const path = `/drupal/${rel}`;
		try {
			mkdirp(binary.FS, path.slice(0, path.lastIndexOf('/')));
			try {
				FS.unlink(path);
			} catch {
				// nothing there yet (usual)
			}
			const node = FS.create(path, 0o100000 | 0o666) as unknown as LazyInstalledNode;
			node.node_ops = nodeOps;
			node.stream_ops = ops;
			node.cfwRow = String(row.path);
			node.cfwLoaded = false;
			// stat() answers with the real size before anything opens the file
			node.usedBytes = Number(row.bytes ?? 0);
			node.contents = null;
			// the install time, not the boot: update module re-fetches any project whose
			// .info.yml ctime is newer than its last fetch
			node.timestamp = Number(row.installed_at);
			written++;
		} catch {
			// one unmountable file must not take the boot down (Drupal names it as a missing class)
		}
	}
	return written;
}
