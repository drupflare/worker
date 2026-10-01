import { chunksPerInvocation, ensureMigrateTable, readMigrateCursor } from '../db/migrate-sql';
import { PACKED_CONTAINER_DIGEST } from '../ops/container-digest';
import { ensureFragmentTables } from '../ops/fragment-index';
import { ensureRevTables } from '../ops/module-rev';
import { DRIVER_DIGEST_KEY } from '../ops/reconcile';
import { ensureHealthTable } from '../ops/supervisor';
import type { SitePhpDurableObject } from '../site-do';
import { errorMessage } from '../util/errors';
import { migrationSelfDrives, prefillDefault } from './levers';
import type { Payload, Row } from './types';

/**
 * The served page cache and fill queue, in the object's own SQL (not Drupal's `cache_page`): the
 * hit path must be readable by JS alone, without booting PHP.
 *
 * The tables are `WITHOUT ROWID`: a text key in a rowid table gets its own unique index and an
 * insert charges 2 rows instead of 1 (measured on `ctx.storage.sql`). Nothing consumes a rowid,
 * and `IF NOT EXISTS` leaves an existing site's rowid tables alone (not worth a rebuild).
 */
export function ensureServeTables(site: SitePhpDurableObject): void {
	if (site.serveTablesReady) return;
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_page (
        path TEXT PRIMARY KEY,
        status INTEGER NOT NULL,
        content_type TEXT,
        html TEXT NOT NULL,
        rendered_at INTEGER NOT NULL,
        render_ms REAL
      ) WITHOUT ROWID`
	);
	// page-to-tag index as a column (a table cost 30 extra rows a fill); check `pragma_table_info`
	// first, since a caught failing `ALTER` dirties `sqlite_master` and re-triggers migration
	const pageColumns = site.sql
		.exec<Row<{ name: string }>>("SELECT name FROM pragma_table_info('cfw_page')")
		.toArray()
		.map((r) => String(r.name));
	if (!pageColumns.includes('tags')) site.sql.exec('ALTER TABLE cfw_page ADD COLUMN tags TEXT');
	// when a bump superseded this row, or NULL; written lazily by the serve that meets it stale
	if (!pageColumns.includes('stale_at')) {
		site.sql.exec('ALTER TABLE cfw_page ADD COLUMN stale_at INTEGER');
	}
	// the sum of the page's tag invalidation counters at render (Drupal's own freshness test)
	if (!pageColumns.includes('tag_checksum')) {
		site.sql.exec('ALTER TABLE cfw_page ADD COLUMN tag_checksum INTEGER');
	}
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_plan (
        path TEXT PRIMARY KEY,
        plan TEXT NOT NULL,
        uid INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        stale INTEGER NOT NULL DEFAULT 0,
        compiled_at INTEGER NOT NULL
      ) WITHOUT ROWID`
		// another column needs a real `ALTER`: `IF NOT EXISTS` leaves an existing table short and
		// every INSERT fails with `has no column named`
	);
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_fill_queue (
        path TEXT PRIMARY KEY,
        queued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      ) WITHOUT ROWID`
	);
	// 0 for a path a visitor is waiting on, 1 for background prefill (drained by priority first)
	const queueColumns = site.sql
		.exec<Row<{ name: string }>>("SELECT name FROM pragma_table_info('cfw_fill_queue')")
		.toArray()
		.map((r) => String(r.name));
	if (!queueColumns.includes('priority')) {
		site.sql.exec('ALTER TABLE cfw_fill_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 1');
	}
	// cheap scalars; the generation counter is here, not in `ctx.storage.kv`, because a bump
	// fires inside `execSql()`, which cannot await
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      ) WITHOUT ROWID`
	);
	// module source per file (a record caps at 2,199,995 bytes; a tarball exceeds it)
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_module_file (
        path TEXT PRIMARY KEY,
        package TEXT NOT NULL,
        version TEXT NOT NULL,
        source TEXT NOT NULL,
        installed_at INTEGER NOT NULL
      )`
	);
	// the composer autoload map of each delivered library, which settings.php registers at boot
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_package_autoload (
        package TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        mount TEXT NOT NULL,
        autoload TEXT NOT NULL,
        classmap TEXT NOT NULL
      )`
	);
	// uploaded revisions: content-addressed blobs plus a manifest row
	ensureRevTables(site.sql);
	// shared shells, keyed by (path, permissions_hash): two role sets render different markup
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_shell (
        path TEXT NOT NULL,
        permissions_hash TEXT NOT NULL,
        shell TEXT NOT NULL,
        slots TEXT NOT NULL,
        recipes TEXT NOT NULL,
        harvested_at INTEGER NOT NULL,
        PRIMARY KEY (path, permissions_hash)
      )`
	);
	// visitors a shell is proven correct for, keyed to its harvest so a re-harvest voids them all
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_shell_verified (
        path TEXT NOT NULL,
        permissions_hash TEXT NOT NULL,
        uid TEXT NOT NULL,
        harvested_at INTEGER NOT NULL,
        verified_at INTEGER NOT NULL,
        PRIMARY KEY (path, permissions_hash, uid)
      ) WITHOUT ROWID`
	);
	// the fragment index plus `cfw_shell.tags` (an undated shell dies on every invalidation)
	ensureFragmentTables(site.sql);
	// created here, not lazily, or the first finding is the one that cannot be recorded
	ensureHealthTable(site.sql);
	site.serveTablesReady = true;
}

/**
 * The `/migrate` body for the JS engine. `all=1` (or paid) replays every chunk in this
 * invocation; the default replays `chunksPerInvocation()` and arms an alarm for the rest.
 */
export async function migrateChunks(
	site: SitePhpDurableObject,
	url: URL | undefined
): Promise<Payload> {
	const params = url?.searchParams;
	if (params?.get('reset') === '1') {
		await site.migrator().reset();
	}
	const asked = Number(params?.get('chunks') ?? 0);
	const maxChunks =
		params?.get('all') === '1'
			? Infinity
			: Number.isFinite(asked) && asked > 0
				? asked
				: chunksPerInvocation(site.env);

	let out: Payload;
	try {
		// not gated here: `fetch()` already holds the gate and it is not reentrant, so a nested
		// acquire hangs forever (alarm() is the path that needs one; see `migrateStepIfPending()`)
		out = await site.migrator().step({ maxChunks });
	} catch (e) {
		// `done: null`, not absent: a caller testing `done === false` read undefined as finished
		return { ok: false, done: null, engine: 'sql', error: errorMessage(e) };
	}

	// arm the continuation here so the first `/migrate` call finishes the job unattended
	if (!out.done && migrationSelfDrives(site.env)) {
		await site.setAlarmAt(site.nowMs() + 1);
		out.continuation = 'alarm armed';
	}
	return { ...out, engine: 'sql' };
}

/**
 * Loads the CI-rendered pages into the serving table. On for free, off for paid, overridable
 * both ways; an absent `prefill.json` is normal (the site starts cold). Shared by the `/__migrate`
 * route and the alarm chain, the only path a deployed site takes.
 *
 * @param asked - the `?prefill=` override: '1' on, '0' off, undefined defers to the plan
 */
export async function prefillServingTable(
	site: SitePhpDurableObject,
	asked?: string
): Promise<Payload> {
	const want = asked === '1' ? true : asked === '0' ? false : prefillDefault(site.env);
	if (!want) {
		return {
			prefilled: 0,
			prefillNote: 'prefill disabled; default is on for free, off for paid'
		};
	}
	try {
		site.ensureServeTables();
		const res = await site.env.ASSETS.fetch(new URL('https://a.local/prefill.json'));
		if (!res.ok) {
			return { prefilled: 0, prefillNote: 'no prefill.json; site starts cold' };
		}
		const pages = await res.json<Record<string, Payload>>();
		let loaded = 0;
		for (const [path, page] of Object.entries(pages)) {
			if (!page || typeof page.html !== 'string') continue;
			site.sql.exec(
				`INSERT INTO cfw_page (path, status, content_type, html, rendered_at, render_ms)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             status = excluded.status, content_type = excluded.content_type,
             html = excluded.html, rendered_at = excluded.rendered_at,
             render_ms = excluded.render_ms, stale_at = NULL`,
				path,
				Number(page.status ?? 200),
				String(page.contentType ?? 'text/html; charset=utf-8'),
				page.html,
				site.nowMs(),
				Number(page.renderMs ?? 0)
			);
			loaded++;
		}
		return { prefilled: loaded, prefilledPaths: Object.keys(pages) };
	} catch (e) {
		return { prefilled: 0, prefillError: errorMessage(e).slice(0, 200) };
	}
}

/**
 * Advances the migration by one invocation's chunks, or returns undefined when there is nothing
 * to do: never started, finished, or no manifest at all (an alarm that throws stops re-arming).
 */
export async function migrateStepIfPending(
	site: SitePhpDurableObject
): Promise<Payload | undefined> {
	ensureMigrateTable(site.sql);
	const cursor = readMigrateCursor(site.sql);
	if (cursor?.state === 'done') return undefined;
	// with no cursor, start only when provisioning was requested: starting on any alarm hijacked
	// 37 tests (the object migrated first and never reached the quarantine or drain checks)
	if (!cursor && !(site.provisionRequested() && (await site.hasMigrationManifest()))) {
		return undefined;
	}

	// the pack's cachetags rows are setup, not a content change; no bump (it would purge the edge)
	site.suppressBump = true;
	try {
		// gated here (alarm() is not): a concurrent `/migrate` replays a chunk, a `UNIQUE` failure
		// latches the cursor to `failed` and `/serve` answers 503 forever
		const out = await site.gate.run(
			() => site.migrator().step({ maxChunks: chunksPerInvocation(site.env) }),
			'alarm-migrate'
		);
		site.migrated = out.done;
		// the completion branch a deployed site reaches: prefill in its own `gate.run()`
		// (a sequential acquire is fine, nesting would deadlock)
		if (out.done) {
			// stamp the digest the container was baked with, not the shipping one (they differ till
			// `assets:container` reruns); no stamp reads owed and the first boot rebuilds
			site.metaSet(DRIVER_DIGEST_KEY, PACKED_CONTAINER_DIGEST);
			const prefill = await site.gate.run(() => site.prefillServingTable(), 'alarm-prefill');
			return { migrate: out, ...prefill };
		}
		return { migrate: out };
	} catch (e) {
		// recorded, not rethrown: the cursor holds the error and the object must keep re-arming
		return { migrate: { ok: false, error: errorMessage(e) } };
	} finally {
		site.suppressBump = false;
	}
}
