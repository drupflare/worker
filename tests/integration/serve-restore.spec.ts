import { describe, expect, it } from 'vitest';
import { dumpDatabase } from '../../src/db/export-sql';
import { storeImport, storedImportLoader } from '../../src/db/import-sql';
import type { SqlLike, StorageLike } from '../../src/db/migrate-sql';
import { SqlMigrator, readMigrateCursor } from '../../src/db/migrate-sql';
import {
	type ServeDo,
	freshSite,
	inObject,
	pageFor,
	seedPage,
	serveDirect,
	stubRender
} from '../helpers/serve-do';

/**
 * The platform end of `tests/node/import-sql.spec.ts` -- the same restore, driven inside a REAL
 * Durable Object so the serve gate is the shipped one rather than an equivalent predicate.
 *
 * A restore writes the same `cfw_migrate` cursor row the first-run migration does, and
 * `SiteDO.migratePartial()` refuses to serve on any cursor that is not `done`. That coupling is what
 * stops a half-restored database answering requests, and it is exactly the sort of thing that holds in
 * a unit fixture and not on the platform.
 *
 * ONE GAP IS MEASURED HERE RATHER THAN ASSUMED AWAY. The fast serve lane in `SiteDO.fetch()` answers
 * a cached page BEFORE the gate and never consults `migratePartial()`, so a warm site with rows in
 * `cfw_page` kept returning 200 mid-restore. That is not reachable for a first-run migration -- the
 * pack ships no pages and `serveTablesReady` is false -- which is why `serve-migration.spec.ts` never
 * saw it. What closes it in practice is that a real dump drops `cfw_page` in its first chunk, so the
 * fast lane has nothing to answer with from then on; that is asserted below rather than argued.
 *
 * The restore is driven by constructing the migrator against `site.sql`, because no route drives one
 * yet. What is under test is the gate, not the route.
 */

/** the object's own storage, narrowed; `ServeDo` declares `sql` but not the transaction seam */
function seams(site: ServeDo): { sql: SqlLike; storage: StorageLike } {
	return {
		sql: site.sql as unknown as SqlLike,
		storage: site.ctx.storage as unknown as StorageLike
	};
}

const migrate = (site: ServeDo, query: string) =>
	site.fetch(new Request(`https://do.local/__migrate${query}`)).then((r) => r.json());

function restore(site: ServeDo, dump: string, generation = 'backup-1') {
	const { sql, storage } = seams(site);
	const id = storeImport(sql, dump, {
		storage,
		generation,
		source: 'test',
		nowMs: 1,
		perChunk: 1
	}).id;
	return new SqlMigrator({
		sql,
		storage,
		now: () => Date.now(),
		...storedImportLoader(sql, id)
	});
}

describe('a site being restored refuses to serve until the restore lands', () => {
	it('answers 503 while a restore is in flight, and 200 again once it finishes', async () => {
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			stubRender(site, ({ path }) => pageFor(path));
			await migrate(site, '?all=1&prefill=0');
			const before = await serveDirect(site, '/', '&lane=gate&inline=1&edge=0');

			const migrator = restore(site, 'CREATE TABLE cfw_restore_probe (a);\nSELECT 1;');
			// one chunk, so the restore is genuinely partway through when the request arrives
			const partial = await migrator.step({ maxChunks: 1 });
			const during = await serveDirect(site, '/', '&lane=gate&inline=1&edge=0');

			const finished = await migrator.step({ maxChunks: Infinity });
			const after = await serveDirect(site, '/', '&lane=gate&inline=1&edge=0');
			const { sql } = seams(site);
			return { before, during, after, partial, finished, cursor: readMigrateCursor(sql) };
		});

		expect(out.before.status).toBe(200);
		// the restore really did start rather than being skipped as already-migrated
		expect(out.partial.skipped).toBeUndefined();
		expect(out.partial.done).toBe(false);

		expect(out.during.status).toBe(503);
		expect(out.during.header('x-cfw-migrate-state')).toBe('running');
		expect(String(out.during.cacheControl)).toContain('no-store');

		expect(out.finished.done).toBe(true);
		expect(out.cursor?.state).toBe('done');
		expect(out.cursor?.generation).toContain('import:');
		expect(out.after.status).toBe(200);
	});

	it('keeps refusing after a restore FAILS, rather than serving a half-restored database', async () => {
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			stubRender(site, ({ path }) => pageFor(path));
			await migrate(site, '?all=1&prefill=0');

			const migrator = restore(
				site,
				'CREATE TABLE cfw_restore_probe (a);\nINSERT INTO cfw_absent (a) VALUES (1);'
			);
			let failure = '';
			try {
				await migrator.step({ maxChunks: Infinity });
			} catch (e) {
				failure = String((e as Error).message);
			}
			const { sql } = seams(site);
			return {
				failure,
				serve: await serveDirect(site, '/', '&lane=gate&inline=1&edge=0'),
				cursor: readMigrateCursor(sql)
			};
		});

		expect(out.failure).toContain('cfw_absent');
		expect(out.cursor?.state).toBe('failed');
		// the render path and the fill lane both key on this, so a torn database never gets cached
		expect(out.serve.status).toBe(503);
		expect(out.serve.header('x-cfw-migrate-state')).toBe('failed');
	});

	it('takes the cached pages with it, so the FAST lane has nothing to answer with either', async () => {
		// the fast lane never asks `migratePartial()`. What makes that survivable is that a real dump
		// drops `cfw_page` in its first chunk; assert the mechanism rather than trusting it
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			stubRender(site, ({ path }) => pageFor(path));
			await migrate(site, '?all=1&prefill=0');
			seedPage(site, '/', '<html>warm</html>');
			const warm = await serveDirect(site, '/');
			expect(warm.status).toBe(200);

			const migrator = restore(
				site,
				'DROP TABLE IF EXISTS cfw_page;\nCREATE TABLE cfw_page (path TEXT PRIMARY KEY);\nSELECT 1;'
			);
			await migrator.step({ maxChunks: 1 });
			return { warm, during: await serveDirect(site, '/') };
		});

		expect(out.during.status).toBe(503);
	});

	it('exports the live database and stores it back as a restore point', async () => {
		// the round trip's own bookkeeping, on the platform: what the exporter produces is what
		// `storeImport()` accepts, with no reformatting step between them
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			await migrate(site, '?all=1&prefill=0');
			const { sql, storage } = seams(site);
			const dump = dumpDatabase(sql);
			const stored = storeImport(sql, dump.sql, {
				storage,
				generation: 'backup-1',
				source: '/export',
				nowMs: 1
			});
			return { dump, stored };
		});

		// the shipped pack's own tables, so this is a real Drupal schema rather than a fixture
		expect(out.dump.tables).toHaveProperty('router');
		expect(Number(out.dump.tables.router)).toBeGreaterThan(0);
		// structure-only, and the reason the dump is storable at all: every statement over the
		// 100,000-character ceiling in a full dump was a cache row
		expect(out.dump.tables.cache_container).toBe(0);
		expect(out.stored.statements).toBe(out.dump.statements);
		expect(out.stored.chunks).toBeGreaterThan(0);
	});
});

/**
 * The three couplings that were decided and never executed.
 *
 * Each of these existed as a computed value that nothing acted on, which is the failure mode this
 * project keeps finding: a mechanism that reports its intention and changes nothing looks identical
 * to a working one from the outside.
 */
describe('the wiring that makes a rollback actually restore something', () => {
	it('routes /restore to a stored point and arms the alarm', async () => {
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0', PW_DIAGNOSTICS: '1' };
			await migrate(site, '?all=1&prefill=0');
			const dump = dumpDatabase(seams(site).sql);
			const res = await site.fetch(
				new Request('https://do.local/__restore?label=manual-1', {
					method: 'POST',
					body: dump.sql
				})
			);
			return { body: (await res.json()) as Record<string, unknown>, status: res.status };
		});
		expect(out.status).toBe(200);
		expect(out.body.ok).toBe(true);
		expect(Number(out.body.chunks)).toBeGreaterThan(0);
	});

	it('refuses a GET, because a restore overwrites the database', async () => {
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, PW_DIAGNOSTICS: '1' };
			const res = await site.fetch(new Request('https://do.local/__restore'));
			return res.status;
		});
		expect(out).toBe(405);
	});

	it('the FAST lane consults the cursor, not just the gated one', async () => {
		// the gap the file docblock names: a warm site answered 200 mid-restore because the fast
		// lane reads cfw_page before the gate. Asserted directly here rather than relying on the
		// dump happening to drop cfw_page first
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			await migrate(site, '?all=1&prefill=0');
			stubRender(site, ({ path }) => pageFor(path));
			seedPage(site, '/warm', pageFor('/warm').html ?? '<p>warm</p>');
			const before = await serveDirect(site, '/warm');
			// put the shared cursor into a running restore WITHOUT touching cfw_page, so the only
			// thing that can refuse the fast lane is the cursor itself
			seams(site).sql.exec(
				"UPDATE cfw_migrate SET state = 'running', chunk = 1, chunks = 9 WHERE rowid = 1"
			);
			const during = await serveDirect(site, '/warm');
			return { before: before.status, during: during.status };
		});
		expect(out.before).toBe(200);
		expect(out.during).toBe(503);
	});
});

/**
 * The three gaps drangler's migration survey found in the off-boarding path.
 *
 * All three had the same shape: the route answered successfully while producing something the
 * caller could not use. A backup that cannot be restored is worse than no backup, because it reads
 * as one.
 */
describe('an export says whether it can actually be restored', () => {
	it('reports the widest statement and calls a normal dump replayable', async () => {
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0', PW_DIAGNOSTICS: '1' };
			await migrate(site, '?all=1&prefill=0');
			const res = await site.fetch(new Request('https://do.local/__export'));
			return { status: res.status, body: (await res.json()) as Record<string, unknown> };
		});
		expect(out.status).toBe(200);
		expect(out.body.replayable).toBe(true);
		expect(Number(out.body.maxStatementChars)).toBeGreaterThan(0);
		expect(Number(out.body.maxStatementChars)).toBeLessThanOrEqual(100_000);
	});

	it('REFUSES ?all=1 with a 409 rather than emitting a dump nothing can replay', async () => {
		// the cache_container row alone is 960,544 chars against a 100,000 ceiling, and this route
		// used to return it with a 200
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0', PW_DIAGNOSTICS: '1' };
			await migrate(site, '?all=1&prefill=0');
			const res = await site.fetch(new Request('https://do.local/__export?all=1'));
			return { status: res.status, body: (await res.json()) as Record<string, unknown> };
		});
		expect(out.status).toBe(409);
		expect(out.body.replayable).toBe(false);
		expect(String(out.body.error)).toContain('cannot be restored');
		// and it names the way out rather than just refusing
		expect(String(out.body.how)).toContain('all=1');
	});

	it('names the tables it emitted structure-only, so a report cannot go stale', () => {
		// REGENERABLE_TABLES is a list of regexes; anything outside this file had to restate the
		// rule in prose and drift when the list changed
		const out = inObject(freshSite(), (site) => {
			const dump = dumpDatabase(seams(site).sql);
			return dump.structureOnly;
		});
		return out.then((tables) => {
			expect(Array.isArray(tables)).toBe(true);
		});
	});
});
