import {
	SqlMigrator,
	assetChunkLoader,
	ensureMigrateTable,
	readMigrateCursor,
	type MigrateCursor
} from '../db/dump/migrate';
import type { MigrationHost } from './host';
import { sqlChunkPrefix } from './levers';

/**
 * The JS-side migrator, built lazily (the manifest is an asset fetch) and cached (re-reading
 * per chunk costs 15 subrequests of the 50 cap).
 */
export function migrator(host: MigrationHost): SqlMigrator {
	if (!host._migrator) {
		host._migrator = new SqlMigrator({
			sql: host.sql,
			storage: host.storage,
			now: () => host.nowMs(),
			...assetChunkLoader(host.env, sqlChunkPrefix(host.env))
		});
	}
	return host._migrator;
}

/**
 * The cursor when a migration is started but unfinished, else undefined (never started must
 * keep serving; deploys predate the chunked engine).
 */
export function migratePartial(host: MigrationHost): MigrateCursor | undefined {
	const cursor = migrateCursorOrNull(host);
	if (!cursor || cursor.state === 'done') return undefined;
	return cursor;
}

/**
 * Whether a page request asked this site to provision itself; durable (one `cfw_meta` row),
 * since an eviction sits between ask and alarm.
 */
export function provisionRequested(host: MigrationHost): boolean {
	try {
		const rows = host.sql
			.exec(`SELECT v FROM cfw_meta WHERE k = 'provision_requested'`)
			.toArray();
		return rows.length > 0;
	} catch {
		// the table is created by the write path, so its absence means nobody has asked
		return false;
	}
}

/** records that a visitor wants this site, and wakes the alarm chain to build it */
export async function requestProvision(host: MigrationHost): Promise<void> {
	host.sql.exec(`CREATE TABLE IF NOT EXISTS cfw_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
	host.sql.exec(
		`INSERT INTO cfw_meta (k, v) VALUES ('provision_requested', '1')
		 ON CONFLICT(k) DO NOTHING`
	);
	await host.setAlarmAt(host.nowMs() + 1, true);
}

/**
 * Whether this deployment ships migration chunks; a quiet false, since an alarm that throws
 * stops re-arming.
 */
export async function hasMigrationManifest(host: MigrationHost): Promise<boolean> {
	try {
		await assetChunkLoader(host.env, sqlChunkPrefix(host.env)).loadManifest();
		return true;
	} catch (e) {
		host.noteError('hasMigrationManifest', e);
		return false;
	}
}

/**
 * Whether this site was never provisioned (no cursor at all, unlike a half-finished one);
 * `migrateStepIfPending()` needs a cursor, so this starts the chain.
 */
export function neverMigrated(host: MigrationHost): boolean {
	ensureMigrateTable(host.sql);
	return migrateCursorOrNull(host) === null && host.migrated !== true;
}

/** the migration cursor for diagnostics, or null on a site that never started one */
export function migrateCursorOrNull(host: MigrationHost): MigrateCursor | null {
	try {
		return readMigrateCursor(host.sql) ?? null;
	} catch {
		// the table is absent on a pre-existing deploy; that is a state, not an error
		return null;
	}
}
