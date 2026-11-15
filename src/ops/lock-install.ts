import { composerVersion } from './package-install';
import { isValidPackageName } from './packagist';

/** the most packages one lock may name; the measured template locks hold 142 to 274 */
export const LOCK_PACKAGE_CAP = 400;

/** what the shipped pack carries, as `shipped-lock.ts` reads it from the root lock */
export type ShippedPack = {
	versions: Record<string, string>;
	provides: Record<string, string>;
	core: string;
};

/** one package of a lock, as the route reads it */
export type LockEntry = {
	name: string;
	version: string;
	type: string;
	/** the lock's own digest: `shasum` when published, else the git `reference` */
	digest: string;
	raw: Record<string, unknown>;
};

/** a lock read and checked, or the refusal to answer with */
export type LockRead =
	| { ok: true; core: string; packages: LockEntry[]; profile: string | null; cursor: number }
	| { ok: false; status: number; error: string; extra?: Record<string, unknown> };

/** why a package is not fetched, or undefined when it is */
export function skipReason(entry: LockEntry, shipped: ShippedPack): string | undefined {
	const dist = entry.raw['dist'] as { url?: string; type?: string } | null | undefined;
	if (entry.type === 'composer-plugin') {
		return 'composer-plugin: it runs inside composer, which the worker cannot run';
	}
	if (entry.type === 'metapackage') return 'metapackage: it carries no files';
	if (dist?.type === 'path') {
		return 'path package: the template delivers its own package in its files tar';
	}
	if (entry.name.startsWith('drupal/core')) {
		return `drupal core ships in the pack at ${shipped.core}`;
	}
	const held = shipped.versions[entry.name];
	if (held !== undefined) {
		return composerVersion(held) === composerVersion(entry.version)
			? `shipped: the pack carries ${held}, the locked version`
			: `shipped: the pack carries ${held} and keeps it; the lock names ${entry.version}`;
	}
	if (entry.name in shipped.provides) {
		return 'provided: a package the pack carries provides or replaces it';
	}
	if (typeof dist?.url !== 'string' || dist.url === '') return 'no dist url in the lock';
	return undefined;
}

/** the part of two versions that decides compatibility: `11.4` of `11.4.5` */
export function majorMinor(version: string): string {
	return composerVersion(version).split('.').slice(0, 2).join('.');
}

/**
 * Reads a lock body and refuses what the route cannot answer for.
 *
 * `packages-dev` is ignored unless the body sets `dev: true`. The core is compared at major and
 * minor: a patch release changes no contract a contrib package is built against, and a template
 * lock rarely matches the pack's patch.
 */
export function readLock(body: unknown, shipped: ShippedPack): LockRead {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return { ok: false, status: 400, error: 'the body must be a composer.lock as JSON' };
	}
	const lock = body as Record<string, unknown>;
	const dev = lock['dev'] === true;
	const lists = [lock['packages'], ...(dev ? [lock['packages-dev']] : [])];
	if (!Array.isArray(lists[0])) {
		return { ok: false, status: 400, error: 'the lock has no packages array' };
	}
	const packages: LockEntry[] = [];
	const seen = new Set<string>();
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		for (const raw of list) {
			const entry = raw as Record<string, unknown> | null;
			const name = entry?.['name'];
			const version = entry?.['version'];
			if (
				typeof name !== 'string' ||
				!isValidPackageName(name) ||
				typeof version !== 'string'
			) {
				return {
					ok: false,
					status: 400,
					error: `package ${packages.length} has no valid name and version`
				};
			}
			if (seen.has(name)) {
				return { ok: false, status: 400, error: `${name} appears twice in the lock` };
			}
			seen.add(name);
			const dist = (entry?.['dist'] ?? {}) as { shasum?: unknown; reference?: unknown };
			const digest =
				typeof dist.shasum === 'string' && dist.shasum !== ''
					? dist.shasum.toLowerCase()
					: typeof dist.reference === 'string'
						? dist.reference.toLowerCase()
						: '';
			packages.push({
				name,
				version,
				type: typeof entry?.['type'] === 'string' ? String(entry['type']) : 'library',
				digest,
				raw: entry as Record<string, unknown>
			});
		}
	}
	if (packages.length > LOCK_PACKAGE_CAP) {
		return {
			ok: false,
			status: 422,
			error: `the lock names ${packages.length} packages and one install takes at most ${LOCK_PACKAGE_CAP}`,
			extra: { packages: packages.length, cap: LOCK_PACKAGE_CAP }
		};
	}
	const core = packages.find((p) => p.name === 'drupal/core')?.version;
	if (core === undefined) {
		return {
			ok: false,
			status: 422,
			error: 'the lock names no drupal/core, so its core cannot be compared with the site',
			extra: { siteCore: shipped.core }
		};
	}
	if (majorMinor(core) !== majorMinor(shipped.core)) {
		return {
			ok: false,
			status: 422,
			error: `the lock is built for drupal/core ${core} and the site runs ${shipped.core}`,
			extra: { lockCore: core, siteCore: shipped.core }
		};
	}
	const profile = lock['profile'];
	if (
		profile !== undefined &&
		(typeof profile !== 'string' || !/^[a-z][a-z0-9_]*$/.test(profile))
	) {
		return { ok: false, status: 400, error: 'profile must be a Drupal machine name' };
	}
	const cursor = lock['cursor'] === undefined ? 0 : Number(lock['cursor']);
	if (!Number.isInteger(cursor) || cursor < 0) {
		return { ok: false, status: 400, error: 'cursor must be a whole number from 0' };
	}
	return { ok: true, core, packages, profile: (profile as string | undefined) ?? null, cursor };
}

/** the session a lock maps to: the same packages and digests always give the same id */
export async function sessionId(packages: readonly LockEntry[]): Promise<string> {
	const text = packages.map((p) => `${p.name}@${p.version}#${p.digest}`).join('\n');
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)]
		.slice(0, 8)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/** the commit a GitHub zipball records in its archive comment, or undefined */
export function zipComment(archive: Uint8Array): string | undefined {
	const floor = Math.max(0, archive.length - 22 - 0xffff);
	for (let at = archive.length - 22; at >= floor; at--) {
		if (
			archive[at] === 0x50 &&
			archive[at + 1] === 0x4b &&
			archive[at + 2] === 5 &&
			archive[at + 3] === 6
		) {
			const length = archive[at + 20]! | (archive[at + 21]! << 8);
			if (at + 22 + length !== archive.length) continue;
			return new TextDecoder().decode(archive.subarray(at + 22, at + 22 + length));
		}
	}
	return undefined;
}

/** the tables that hold a session; created on first use, so a site that never installs a lock has none */
export const LOCK_TABLES = ['cfw_lock_session', 'cfw_lock_package', 'cfw_lock_undo'] as const;

/** the statements that create them */
export const LOCK_TABLE_SQL = [
	`CREATE TABLE IF NOT EXISTS cfw_lock_session (
       id TEXT PRIMARY KEY,
       profile TEXT,
       total INTEGER NOT NULL,
       state TEXT NOT NULL,
       cursor INTEGER NOT NULL,
       extensions INTEGER NOT NULL DEFAULT 0,
       cache TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     ) WITHOUT ROWID`,
	`CREATE TABLE IF NOT EXISTS cfw_lock_package (
       session TEXT NOT NULL,
       seq INTEGER NOT NULL,
       package TEXT NOT NULL,
       version TEXT NOT NULL,
       digest TEXT NOT NULL,
       state TEXT NOT NULL,
       detail TEXT NOT NULL,
       files INTEGER NOT NULL DEFAULT 0,
       owned INTEGER NOT NULL DEFAULT 0,
       prior_autoload TEXT,
       PRIMARY KEY (session, seq)
     ) WITHOUT ROWID`,
	`CREATE TABLE IF NOT EXISTS cfw_lock_undo (
       session TEXT NOT NULL,
       path TEXT NOT NULL,
       package TEXT NOT NULL,
       version TEXT NOT NULL,
       source TEXT NOT NULL,
       PRIMARY KEY (session, path)
     ) WITHOUT ROWID`
] as const;
