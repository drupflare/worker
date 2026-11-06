import { describe, expect, it } from 'vitest';
import {
	RESTORE_OWNED_TABLES,
	RUNTIME_OWNED_PREFIXES,
	dumpDatabase,
	isRegenerable,
	tableColumns
} from '../../src/db/export-sql';
import { getFile, putFile } from '../../src/db/file-store';
import { isIdentityMetaStatement, storeImport, storedImportLoader } from '../../src/db/import-sql';
import type { SqlLike, StorageLike } from '../../src/db/migrate-sql';
import { SqlMigrator, readMigrateCursor } from '../../src/db/migrate-sql';
import { pendingMatches as oidcPendingMatches, ticketRedeemable } from '../../src/ops/oidc';
import { spendProof } from '../../src/ops/owner-recovery';
import {
	mintOwnerToken,
	ownerTokenIsSet,
	ownerTokenMatches,
	sealedExportRows
} from '../../src/ops/site-secrets';
import type { SitePhpDurableObject } from '../../src/site-do';
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
 *
 * The object's own storage, narrowed; `ServeDo` declares `sql` but not the transaction seam.
 */
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

/** drives `/export?cursor=` to exhaustion the way a client does, and returns what it collected */
async function drain(site: ServeDo, query = ''): Promise<{ sql: string; calls: number }> {
	let cursor = 'start';
	const parts: string[] = [];
	let calls = 0;
	for (;;) {
		const reply = (await site
			.fetch(
				new Request(
					`https://do.local/__export?body=1&cursor=${encodeURIComponent(cursor)}${query}`
				)
			)
			.then((r) => r.json())) as {
			ok: boolean;
			sql: string;
			nextCursor: string | null;
		};
		calls++;
		expect(reply.ok, 'a chunk refused mid-export').toBe(true);
		if (reply.sql) parts.push(reply.sql);
		if (reply.nextCursor === null) break;
		cursor = reply.nextCursor;
		// the loop is the thing under test, so a runaway is a failure and not a hang
		expect(calls).toBeLessThan(500);
	}
	return { sql: parts.join('\n'), calls };
}

/** replays a dump into a fresh object and hands back that object's own reading of itself */
async function replayInto<T>(dump: string, read: (sql: SqlLike) => T): Promise<T> {
	return inObject(freshSite(), async (site) => {
		const { sql, storage } = seams(site);
		const id = storeImport(sql, dump, {
			storage,
			generation: 'round-trip',
			source: 'test',
			nowMs: 1
		}).id;
		await new SqlMigrator({
			sql,
			storage,
			now: () => Date.now(),
			...storedImportLoader(sql, id)
		}).step({ maxChunks: Infinity });
		return read(sql);
	});
}

function fnv1a(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** the tables a comparison may look at: the site's own, never the runtime's or the restore's */
function comparableTables(sql: SqlLike): string[] {
	return sql
		.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.toArray()
		.map((r) => String(r.name))
		.filter((n) => !RUNTIME_OWNED_PREFIXES.some((p) => n.startsWith(p)))
		.filter((n) => !RESTORE_OWNED_TABLES.includes(n));
}

/**
 * Every table's contents, read WITHOUT the exporter.
 *
 * The chunked export is already compared against the one-shot dump, and both are `dumpChunk` -- so a
 * row dropped at a chunk boundary is dropped identically by both and the equality still holds. This
 * reads the database directly instead, so the two sides of the comparison share no code with the
 * thing under test.
 *
 * `typeof()` and `hex()` for the same reason the exporter uses them: a Durable Object integer read is
 * lossy above 2^53, so a comparison that read the column would agree about a value neither side
 * holds. The per-row digests are SORTED, so this measures contents rather than rowid assignment.
 */
function fingerprint(sql: SqlLike): Record<string, string> {
	const out: Record<string, string> = {};
	for (const table of comparableTables(sql)) {
		const columns = tableColumns(sql, table);
		if (columns.length === 0) {
			out[table] = '0:none';
			continue;
		}
		const select = columns
			.map((c, i) => `typeof(${q(c)}) AS t${i}, hex(${q(c)}) AS h${i}`)
			.join(', ');
		const rows = sql.exec(`SELECT ${select} FROM ${q(table)}`).toArray();
		const digests = rows
			.map((r) => fnv1a(columns.map((_, i) => `${r[`t${i}`]}:${r[`h${i}`]}`).join('')))
			.sort((a, b) => a - b);
		out[table] = `${rows.length}:${fnv1a(digests.join(','))}`;
	}
	return out;
}

/** the schema as the engine stores it, so an index or a view that went missing is visible */
function schemaOf(sql: SqlLike): string[] {
	return sql
		.exec('SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name')
		.toArray()
		.filter((r) => !RUNTIME_OWNED_PREFIXES.some((p) => String(r.name).startsWith(p)))
		.filter((r) => !RESTORE_OWNED_TABLES.includes(String(r.name)))
		.map((r) => `${r.type} ${r.name} ${String(r.sql).replace(/\s+/g, ' ').trim()}`);
}

describe('a site being restored refuses to serve until the restore lands', () => {
	it('answers 503 while a restore is in flight, and 200 again once it finishes', async () => {
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			stubRender(site, ({ path }) => pageFor(path));
			await migrate(site, '?all=1&prefill=0');
			const before = await serveDirect(site, '/', '&lane=gate&inline=1&edge=0');

			const migrator = restore(site, 'CREATE TABLE cfw_restore_probe (a);\nSELECT 1;');
			// one chunk, so the restore is partway through when the request arrives
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

	it('applies a POSTed dump on a migrated site, and /health follows it from pending to applied', async () => {
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, PW_DIAGNOSTICS: '1' };
			await migrate(site, '?all=1&prefill=0');
			const health = async () =>
				(
					(await site
						.fetch(new Request('https://do.local/__health'))
						.then((r) => r.json())) as {
						import: Record<string, unknown> | null;
					}
				).import;
			const before = await health();
			await site.fetch(
				new Request('https://do.local/__restore?label=manual-1', {
					method: 'POST',
					body: 'CREATE TABLE cfw_restore_probe (a);\nINSERT INTO cfw_restore_probe (a) VALUES (7);'
				})
			);
			const pending = await health();
			let applied = await health();
			for (let i = 0; i < 6 && applied?.state !== 'applied'; i++) {
				await site.storage.setAlarm(Date.now() + 1);
				await site.alarm();
				applied = await health();
			}
			const rows = seams(site)
				.sql.exec('SELECT a FROM cfw_restore_probe')
				.toArray()
				.map((r) => Number(r.a));
			return { before, pending, applied, rows };
		});
		expect(out.before).toBeNull();
		expect(out.pending).toMatchObject({ generation: 'manual-1', state: 'pending' });
		expect(out.rows, 'the alarm never replayed the stored dump').toEqual([7]);
		expect(out.applied).toMatchObject({ generation: 'manual-1', state: 'applied' });
	});

	it('reports a dump whose replay fails as failed, and keeps the cause', async () => {
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, PW_DIAGNOSTICS: '1' };
			await migrate(site, '?all=1&prefill=0');
			await site.fetch(
				new Request('https://do.local/__restore?label=bad-1', {
					method: 'POST',
					body: 'INSERT INTO cfw_absent (a) VALUES (1);'
				})
			);
			await site.storage.setAlarm(Date.now() + 1);
			await site.alarm();
			const reply = (await site
				.fetch(new Request('https://do.local/__health'))
				.then((r) => r.json())) as { import: Record<string, unknown> | null };
			return reply.import;
		});
		expect(out).toMatchObject({ generation: 'bad-1', state: 'failed' });
		expect(String(out?.error)).toContain('cfw_absent');
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

describe('the widest value, which is the limit a migration scores against', () => {
	it('reports both Durable Object ceilings and the widest value per table', async () => {
		// neither cap had an instrument. A record may not exceed 2,199,995 bytes and statement
		// text may not exceed 100,000 chars, and until now the only way to find out a dump
		// breached the second was to attempt the restore
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0', PW_DIAGNOSTICS: '1' };
			await migrate(site, '?all=1&prefill=0');
			const res = await site.fetch(new Request('https://do.local/__writes?op=widest'));
			return (await res.json()) as {
				ok: boolean;
				recordCap: number;
				statementCap: number;
				widest: { table: string; column: string; bytes: number }[];
				exportable: boolean;
				note: string;
			};
		});

		expect(out.ok).toBe(true);
		expect(out.recordCap).toBe(2_199_995);
		expect(out.statementCap).toBe(100_000);
		// the shipped pack really does carry a very wide row, so this is a measurement rather
		// than an empty list that would pass either way
		expect(out.widest.length).toBeGreaterThan(0);
		expect(out.widest[0]!.bytes).toBeGreaterThan(0);
		expect(out.note).toContain('widest value is');
		// sorted widest first, so the row that decides the verdict is the one a reader sees
		for (let i = 1; i < out.widest.length; i++) {
			expect(out.widest[i - 1]!.bytes).toBeGreaterThanOrEqual(out.widest[i]!.bytes);
		}
	});

	it('measures BYTES rather than characters, so a multi-byte value is not under-reported', async () => {
		// length() on TEXT counts characters; a multi-byte string would report narrower than it
		// stores, and the error would be in the safe-looking direction
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, PW_DIAGNOSTICS: '1' };
			site.sql.exec('CREATE TABLE cfw_width_probe (v TEXT)');
			// 10 codepoints, 40 bytes in UTF-8
			site.sql.exec('INSERT INTO cfw_width_probe (v) VALUES (?)', '𝔘'.repeat(10));
			const res = await site.fetch(new Request('https://do.local/__writes?op=widest'));
			const body = (await res.json()) as {
				widest: { table: string; column: string; bytes: number }[];
			};
			return body.widest.find((w) => w.table === 'cfw_width_probe');
		});
		expect(out?.bytes).toBe(40);
	});
});

describe('a file too wide for one statement, which is any ordinary photo', () => {
	it('SPLITS the value across appends instead of producing an unreplayable dump', async () => {
		// cfw_file_chunk stores up to 200,000 bytes per row and a literal costs two hex characters
		// per byte -- 400,000 against a 100,000 ceiling. So every upload over ~50 KB made the whole
		// dump unreplayable, on the one path whose job is letting a customer leave with their data
		const out = await inObject(freshSite(), async (site) => {
			const sql = seams(site).sql;
			putFile(sql as never, 'public://big.bin', new Uint8Array(150_000).fill(7), {
				mime: 'application/octet-stream',
				nowMs: 1
			});
			const dump = dumpDatabase(sql);
			return {
				replayable: dump.replayable,
				splitValues: dump.splitValues,
				maxStatementChars: dump.maxStatementChars,
				sql: dump.sql
			};
		});

		expect(out.replayable, 'a 150 KB file must not make the dump unreplayable').toBe(true);
		expect(out.splitValues).toBeGreaterThan(0);
		expect(out.maxStatementChars).toBeLessThanOrEqual(100_000);
		// the mechanism is the one the shipped pack already uses
		expect(out.sql).toContain('|| ');
	});

	it('BUILDS a blob as text and converts once, because `||` coerces its operands', async () => {
		// measured on the platform: `typeof(x'41' || x'42')` is `text`. So appending a hex literal
		// straight onto a blob column silently turns the column into a string -- the restore replays
		// with no error and the file comes back empty, which is exactly what the first version of
		// this did. `unhex()` is available (`typeof(unhex('41'))` is `blob`) so the digits accumulate
		// as an ordinary string and become bytes in one final statement
		const out = await inObject(freshSite(), async (site) => {
			const sql = seams(site).sql;
			putFile(sql as never, 'public://big.bin', new Uint8Array(150_000).fill(7), {
				mime: 'application/octet-stream',
				nowMs: 1
			});
			return dumpDatabase(sql).sql;
		});

		expect(out, 'a split blob must be converted back').toMatch(/SET "?\w+"? = unhex\(/);
		expect(out, 'no append may concatenate a hex literal, which coerces to text').not.toMatch(
			/\|\| x'/
		);
	});

	it('REPLAYS to the identical bytes, which is the only claim that matters', async () => {
		// a split that produces a valid-looking dump and the wrong bytes is worse than a refusal
		const source = new Uint8Array(150_000);
		for (let i = 0; i < source.length; i++) source[i] = (i * 31) % 256;

		const dump = await inObject(freshSite(), async (site) => {
			const sql = seams(site).sql;
			putFile(sql as never, 'public://big.bin', source, {
				mime: 'application/octet-stream',
				nowMs: 1
			});
			return dumpDatabase(sql).sql;
		});

		const restored = await inObject(freshSite(), async (site) => {
			const { sql, storage } = seams(site);
			const id = storeImport(sql, dump, {
				storage,
				generation: 'files-1',
				source: 'test',
				nowMs: 1
			}).id;
			const migrator = new SqlMigrator({
				sql,
				storage,
				now: () => Date.now(),
				...storedImportLoader(sql, id)
			});
			await migrator.step({ maxChunks: Infinity });
			// read the bytes back through the file store rather than through the dump that wrote
			// them, so the comparison does not share a mechanism with the mover
			return getFile(sql as never, 'public://big.bin');
		});

		expect(restored, 'the file did not survive the round trip').not.toBeNull();
		expect(restored!.length).toBe(source.length);
		// every byte, not a sample: a splitter that drops or reorders one interior slice matches at
		// both ends. Counted rather than deep-equalled because a 150,000-element diff is unreadable
		let differing = 0;
		let firstDiff = -1;
		for (let i = 0; i < source.length; i++) {
			if (restored![i] !== source[i]) {
				if (firstDiff < 0) firstDiff = i;
				differing++;
			}
		}
		expect(differing, `bytes differ from ${firstDiff}`).toBe(0);
	});
});

describe('the runtime keeps its own tables in the same database', () => {
	it('DOES NOT read `_cf_METADATA`, which the authorizer refuses outright', async () => {
		// not a tidiness filter. `_cf_METADATA` belongs to the Durable Object storage API and the
		// authorizer refuses to read it, so one `SELECT ... FROM "_cf_METADATA"` fails the WHOLE dump
		// with `not authorized: SQLITE_AUTH`. It appears the first time the storage API is used --
		// which a bare generation bump does -- so every site that had ever been written to was
		// unexportable, on the path whose only job is letting a customer leave
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			await migrate(site, '?all=1&prefill=0');
			// arming the alarm is the whole trigger -- no render, no traffic. Every site arms one on
			// its first generation bump, which is why this affected all of them and not busy ones
			await site.ctx.storage.setAlarm(Date.now() + 60_000);
			const sql = seams(site).sql;
			const present = sql
				.exec("SELECT name FROM sqlite_master WHERE type = 'table'")
				.toArray()
				.map((r) => String(r.name))
				.filter((n) => n.startsWith('_cf_'));
			let error: string | null = null;
			let statements = 0;
			try {
				statements = dumpDatabase(sql).statements;
			} catch (e) {
				error = String((e as Error)?.message ?? e);
			}
			return { present, error, statements };
		});

		// the guard is only a guard if the table it guards against is actually there
		expect(
			out.present.length,
			'the runtime table never appeared, so this proves nothing'
		).toBeGreaterThan(0);
		expect(out.error).toBeNull();
		expect(out.statements).toBeGreaterThan(0);
	});
});

describe('a dump too big for one invocation, which is any site worth backing up', () => {
	it('REASSEMBLES to exactly what the one-shot dump produces', async () => {
		// the one-shot and the chunked path are the same code -- `dumpDatabase` drives `dumpChunk`
		// to exhaustion -- and this is what pins that. Two implementations agreeing today is how the
		// chunked half drifts into producing a dump that no longer restores
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			await migrate(site, '?all=1&prefill=0');
			const oneShot = dumpDatabase(seams(site).sql);
			const drained = await drain(site, '&chunkChars=20000');
			return { oneShot: oneShot.sql, statements: oneShot.statements, ...drained };
		});

		expect(out.calls, 'a 20,000-char budget must take more than one call').toBeGreaterThan(3);
		expect(out.sql.length).toBe(out.oneShot.length);
		expect(out.sql).toBe(out.oneShot);
	});

	it('REPLAYS what it reassembled, which the equality above does not prove on its own', async () => {
		const dump = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			await migrate(site, '?all=1&prefill=0');
			return (await drain(site, '&chunkChars=20000')).sql;
		});

		const rows = await inObject(freshSite(), async (site) => {
			const { sql, storage } = seams(site);
			const id = storeImport(sql, dump, {
				storage,
				generation: 'chunked-1',
				source: 'test',
				nowMs: 1
			}).id;
			const migrator = new SqlMigrator({
				sql,
				storage,
				now: () => Date.now(),
				...storedImportLoader(sql, id)
			});
			await migrator.step({ maxChunks: Infinity });
			return Number(sql.exec('SELECT COUNT(*) AS n FROM router').toArray()[0]?.n ?? 0);
		});

		expect(rows, 'the reassembled dump restored no routes').toBeGreaterThan(0);
	});

	it('REFUSES to splice two different dumps together', async () => {
		// the cursor is position and the options are shape, and they arrive separately on every
		// call. Resuming an `?all=1` export with the default options would produce a file that
		// looks whole and is a mixture of two dumps
		const status = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			await migrate(site, '?all=1&prefill=0');
			const first = (await site
				.fetch(new Request('https://do.local/__export?cursor=start&all=1'))
				.then((r) => r.json())) as { nextCursor: string };
			const resumed = await site.fetch(
				new Request(
					`https://do.local/__export?cursor=${encodeURIComponent(first.nextCursor)}`
				)
			);
			return resumed.status;
		});

		expect(status).toBe(409);
	});
});

/**
 * Does the round trip actually reproduce the database?
 *
 * Everything above proves a PROPERTY of the dump -- that it is replayable, that a split blob comes
 * back, that the chunked path reassembles to the one-shot text. None of it compares the restored
 * database to the one that was exported, and the one comparison that came close (`router` has more
 * than zero rows) passes on a restore that dropped every other table.
 *
 * The instrument is NOT the exporter. `dumpDatabase()` drives `dumpChunk()`, so the
 * chunked/one-shot equality above cannot see a row dropped at a chunk boundary: both halves drop it.
 */
describe('the round trip reproduces the database, measured without the exporter', () => {
	it('carries every non-regenerable table row for row into a fresh object', async () => {
		const { dump, before } = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			await migrate(site, '?all=1&prefill=0');
			const sql = seams(site).sql;
			return {
				dump: dumpDatabase(sql).sql,
				before: { rows: fingerprint(sql), schema: schemaOf(sql) }
			};
		});

		const after = await replayInto(dump, (sql) => ({
			rows: fingerprint(sql),
			schema: schemaOf(sql)
		}));

		// the shipped pack, so this is a real Drupal schema rather than a fixture
		expect(Object.keys(before.rows).length).toBeGreaterThan(50);
		expect(after.schema).toEqual(before.schema);

		const regenerable = Object.keys(before.rows).filter(isRegenerable);
		const carried = Object.keys(before.rows).filter((t) => !isRegenerable(t));
		// the comparison is only worth anything if rows were actually carried
		expect(carried.some((t) => !before.rows[t]!.startsWith('0:'))).toBe(true);
		for (const table of carried) {
			expect(after.rows[table], `${table} did not survive the round trip`).toBe(
				before.rows[table]
			);
		}
		// structure-only: present, and empty, rather than absent
		for (const table of regenerable) {
			expect(after.rows[table], `${table} should be present and empty`).toMatch(/^0:/);
		}
		// nothing invented on the way in either
		expect(Object.keys(after.rows).sort()).toEqual(Object.keys(before.rows).sort());
	});

	it('drops no row at a chunk boundary, which the one-shot comparison cannot show', async () => {
		// a boundary falls between rows and the cursor is a keyset, so a resume that mis-positions by
		// one silently loses a row per chunk. Measured against the LIVE database rather than against
		// the other dump, because both dumps come from `dumpChunk`
		const { dump, before, calls } = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			await migrate(site, '?all=1&prefill=0');
			const drained = await drain(site, '&chunkChars=20000');
			return {
				dump: drained.sql,
				calls: drained.calls,
				before: fingerprint(seams(site).sql)
			};
		});

		// a single-chunk export would make the boundary claim vacuous
		expect(calls, 'the export was not actually chunked').toBeGreaterThan(3);
		const after = await replayInto(dump, fingerprint);
		for (const table of Object.keys(before).filter((t) => !isRegenerable(t))) {
			expect(after[table], `${table} lost rows across ${calls} chunks`).toBe(before[table]);
		}
	});

	it('keeps a wide integer, a NUL and a blob through a read the platform makes LOSSY', async () => {
		// the claim in `export-sql.ts` is that no value crosses a double, so this asserts the premise
		// as well as the conclusion: the same column read directly comes back WRONG on this platform
		const probe = `INSERT INTO round_trip_probe (id, big, txt, blob, amount, empty, missing) VALUES
			(1, 9007199254740993, CAST(x'41000A42' AS TEXT), x'410A0042FF', 2.0, '', NULL)`;
		const { dump, before, direct } = await inObject(freshSite(), async (site) => {
			const sql = seams(site).sql;
			sql.exec(
				`CREATE TABLE round_trip_probe (id INTEGER PRIMARY KEY, big INTEGER, txt TEXT,
				 blob BLOB, amount REAL, empty TEXT, missing TEXT)`
			);
			sql.exec(probe);
			return {
				dump: dumpDatabase(sql).sql,
				before: fingerprint(sql).round_trip_probe,
				direct: String(sql.exec('SELECT big FROM round_trip_probe').toArray()[0]?.big)
			};
		});

		// the premise: a direct read of this value is off by one on the platform, so a dump built
		// from column reads would carry a number the site never held
		expect(direct).toBe('9007199254740992');
		// and the dump carries the digits bare rather than through that read
		expect(dump).toContain('9007199254740993');

		const after = await replayInto(dump, (sql) => ({
			print: fingerprint(sql).round_trip_probe,
			row: sql
				.exec(
					`SELECT typeof(big) AS tb, hex(big) AS hb, typeof(txt) AS tt, hex(txt) AS ht,
					 typeof(blob) AS tbl, hex(blob) AS hbl, typeof(amount) AS ta,
					 typeof(empty) AS te, typeof(missing) AS tm FROM round_trip_probe`
				)
				.toArray()[0] as Record<string, string>
		}));

		expect(after.print).toBe(before);
		// named individually as well, because a matching digest of two wrong values is a pass
		expect(after.row.tb).toBe('integer');
		expect(after.row.hb).toBe(Buffer.from('9007199254740993').toString('hex').toUpperCase());
		expect(after.row.tt).toBe('text');
		expect(after.row.ht).toBe('41000A42');
		expect(after.row.tbl).toBe('blob');
		expect(after.row.hbl).toBe('410A0042FF');
		// `2.0` emitted as `2` comes back an INTEGER, and an empty string is not a NULL
		expect(after.row.ta).toBe('real');
		expect(after.row.te).toBe('text');
		expect(after.row.tm).toBe('null');
	});
});

describe('credentials held outside SQL across an export and a restore', () => {
	const GIT_TOKEN = 'provider-token-for-test';

	/** a claimed site with a git credential, and the dump `?secrets=1` would produce */
	async function claimedDump(): Promise<{ token: string; withSecrets: string; plain: string }> {
		return inObject(freshSite(), async (site) => {
			const token = (await mintOwnerToken(site.secretStore())) as string;
			site.writeSecret('git_token_abc', GIT_TOKEN);
			const sql = site.sql as unknown as SqlLike;
			const sealedRows = sealedExportRows(site.secretStore());
			return {
				token,
				withSecrets: dumpDatabase(sql, { secrets: true, sealedRows }).sql,
				plain: dumpDatabase(sql, { sealedRows }).sql
			};
		});
	}

	/** restores a dump into a site, then lets the object adopt what the import left in SQL */
	async function restoreInto(site: ServeDo, dump: string): Promise<void> {
		const { sql, storage } = seams(site);
		const id = storeImport(sql, dump, {
			storage,
			generation: 'credentials',
			source: 'test',
			nowMs: 1
		}).id;
		await new SqlMigrator({
			sql,
			storage,
			now: () => Date.now(),
			...storedImportLoader(sql, id)
		}).step({ maxChunks: Infinity });
		await site.adoptSecrets();
	}

	const metaKeys = (site: ServeDo) =>
		(site.sql.exec('SELECT k FROM cfw_meta').toArray() as { k: string }[]).map((r) => r.k);

	it('carries them only when asked, and never the plaintext owner token', async () => {
		const { token, withSecrets, plain } = await claimedDump();
		expect(withSecrets).toContain("'owner_token_hash'");
		expect(withSecrets).toContain("'git_token_abc'");
		expect(withSecrets).not.toContain(token);
		expect(plain).not.toContain("'owner_token_hash'");
		expect(plain).not.toContain(GIT_TOKEN);
	});

	it('is what the export route emits, and only with secrets=1', async () => {
		await inObject(freshSite(), async (site) => {
			await mintOwnerToken(site.secretStore());
			site.writeSecret('git_token_abc', GIT_TOKEN);
			const read = async (query: string) =>
				JSON.stringify(
					await (
						await site.fetch(new Request(`https://do.local/__export${query}`))
					).json()
				);
			const withSecrets = await read('?body=1&secrets=1');
			expect(withSecrets).toContain('owner_token_hash');
			expect(withSecrets).toContain(GIT_TOKEN);
			const without = await read('?body=1');
			expect(without).not.toContain('owner_token_hash');
			expect(without).not.toContain(GIT_TOKEN);
		});
	});

	it('restores onto a new site with the same owner and credentials, and leaves none in SQL', async () => {
		const { token, withSecrets } = await claimedDump();
		await inObject(freshSite(), async (site) => {
			await restoreInto(site, withSecrets);
			expect(await ownerTokenMatches(site.secretStore(), token)).toBe(true);
			expect(site.readSecret('git_token_abc')).toBe(GIT_TOKEN);
			expect(metaKeys(site)).not.toContain('owner_token_hash');
			expect(metaKeys(site)).not.toContain('git_token_abc');
		});
	});

	it('keeps the owner and credentials of a site that was already claimed', async () => {
		const { token, withSecrets } = await claimedDump();
		await inObject(freshSite(), async (site) => {
			const own = (await mintOwnerToken(site.secretStore())) as string;
			site.writeSecret('git_token_abc', 'the-target-sites-own-token');
			await restoreInto(site, withSecrets);
			expect(await ownerTokenMatches(site.secretStore(), own)).toBe(true);
			expect(await ownerTokenMatches(site.secretStore(), token)).toBe(false);
			expect(site.readSecret('git_token_abc')).toBe('the-target-sites-own-token');
			expect(metaKeys(site)).not.toContain('owner_token_hash');
		});
	});

	it('adopts a dump written before sealed storage, which carried the plaintext rows', async () => {
		// the shape an older `?secrets=1` dump has: the token and a git credential as ordinary rows
		await inObject(freshSite(), async (site) => {
			const store = site.secretStore();
			store.set('owner_token', 'legacy-owner-token-value');
			store.set('git_hooksecret_old', 'legacy-hook-secret');
			await site.adoptSecrets();
			expect(await ownerTokenMatches(site.secretStore(), 'legacy-owner-token-value')).toBe(
				true
			);
			expect(site.readSecret('git_hooksecret_old')).toBe('legacy-hook-secret');
			expect(metaKeys(site)).not.toContain('owner_token');
			expect(metaKeys(site)).not.toContain('git_hooksecret_old');
		});
	});

	it('drops an owner hash that is not a SHA-256, rather than adopting a value SQL chose', async () => {
		await inObject(freshSite(), async (site) => {
			site.secretStore().set('owner_token_hash', 'nope');
			await site.adoptSecrets();
			expect(await ownerTokenIsSet(site.secretStore())).toBe(false);
			expect(metaKeys(site)).not.toContain('owner_token_hash');
		});
	});
});

describe('authority keys held outside cfw_meta', () => {
	const AUTHORITY: Record<string, string> = {
		git_remotes: '[{"id":"github:o/r@main","provider":"github","repo":"o/r","branch":"main"}]',
		recover_spent: '[{"h":"abc","exp":9999999999999}]',
		first_run_at: '1700000000000',
		first_run_keys: 'adminName,siteName',
		oidc_issuer: 'https://idp.example.com',
		oidc_client_id: 'client-1',
		oidc_pending: '{"state":"s","verifier":"v"}',
		oidc_ticket: '{"ticket":"t"}'
	};
	// the keys a dump with secrets=1 carries; a login in flight is not worth restoring
	const CARRIED = Object.keys(AUTHORITY).filter(
		(k) => !k.startsWith('oidc_p') && k !== 'oidc_ticket'
	);

	const metaKeys = (site: ServeDo) =>
		(site.sql.exec('SELECT k FROM cfw_meta').toArray() as { k: string }[]).map((r) => r.k);
	const plant = (site: ServeDo, key: string, value: string) => {
		site.ensureServeTables();
		site.sql.exec('INSERT INTO cfw_meta (k, v) VALUES (?, ?)', key, value);
	};

	it.each(Object.entries(AUTHORITY))(
		'%s: a write reads back and never reaches SQL',
		async (key, value) => {
			await inObject(freshSite(), async (site) => {
				site.ensureServeTables();
				site.metaSet(key, value);
				expect(site.metaGet(key)).toBe(value);
				expect(metaKeys(site)).not.toContain(key);
				expect(site.secretStore().sealed.get(key)).toBe(value);
			});
		}
	);

	it.each(Object.entries(AUTHORITY))(
		'%s: a row from before the move is adopted on first read',
		async (key, value) => {
			await inObject(freshSite(), async (site) => {
				plant(site, key, value);
				expect(site.metaGet(key)).toBe(value);
				expect(metaKeys(site)).not.toContain(key);
				expect(site.secretStore().sealed.get(key)).toBe(value);
			});
		}
	);

	it.each(Object.entries(AUTHORITY))(
		'%s: a row SQL plants later does not displace the stored value',
		async (key, value) => {
			await inObject(freshSite(), async (site) => {
				site.ensureServeTables();
				site.metaSet(key, value);
				plant(site, key, 'planted-by-sql');
				expect(site.metaGet(key)).toBe(value);
				await site.adoptSecrets();
				expect(metaKeys(site)).not.toContain(key);
				expect(site.metaGet(key)).toBe(value);
			});
		}
	);

	it('moves a whole set of old rows at wake, leaving none for SELECT * to find', async () => {
		await inObject(freshSite(), async (site) => {
			for (const [key, value] of Object.entries(AUTHORITY)) plant(site, key, value);
			await site.adoptSecrets();
			for (const key of Object.keys(AUTHORITY)) expect(metaKeys(site)).not.toContain(key);
			for (const [key, value] of Object.entries(AUTHORITY))
				expect(site.metaGet(key)).toBe(value);
		});
	});

	it('keeps the remote list behind its own accessors', async () => {
		await inObject(freshSite(), async (site) => {
			const remote = {
				id: 'github:o/r@main',
				provider: 'github',
				repo: 'o/r',
				branch: 'main'
			};
			(site as unknown as SitePhpDurableObject).gitSaveRemotes([remote as never]);
			expect(site.gitRemotes()).toEqual([remote]);
			expect(metaKeys(site)).not.toContain('git_remotes');
		});
	});

	it('carries them on a dump with secrets=1 and restores them without leaving SQL rows', async () => {
		const dump = await inObject(freshSite(), async (site) => {
			site.ensureServeTables();
			for (const key of CARRIED) site.metaSet(key, AUTHORITY[key]!);
			site.metaSet('oidc_pending', AUTHORITY.oidc_pending!);
			const sql = site.sql as unknown as SqlLike;
			const sealedRows = sealedExportRows(site.secretStore());
			return {
				withSecrets: dumpDatabase(sql, { secrets: true, sealedRows }).sql,
				plain: dumpDatabase(sql, { sealedRows }).sql
			};
		});
		for (const key of CARRIED) expect(dump.withSecrets, key).toContain(`'${key}'`);
		expect(dump.withSecrets).not.toContain("'oidc_pending'");
		for (const key of CARRIED) expect(dump.plain, key).not.toContain(`'${key}'`);

		await inObject(freshSite(), async (site) => {
			const { sql, storage } = seams(site);
			const id = storeImport(sql, dump.withSecrets, {
				storage,
				generation: 'authority',
				source: 'test',
				nowMs: 1
			}).id;
			await new SqlMigrator({
				sql,
				storage,
				now: () => Date.now(),
				...storedImportLoader(sql, id)
			}).step({ maxChunks: Infinity });
			await site.adoptSecrets();
			for (const key of CARRIED) {
				expect(site.metaGet(key), key).toBe(AUTHORITY[key]);
				expect(metaKeys(site)).not.toContain(key);
			}
		});
	});

	it('is what the export route emits, and only with secrets=1', async () => {
		await inObject(freshSite(), async (site) => {
			site.ensureServeTables();
			site.metaSet('git_remotes', AUTHORITY.git_remotes!);
			const read = async (query: string) =>
				JSON.stringify(
					await (
						await site.fetch(new Request(`https://do.local/__export${query}`))
					).json()
				);
			expect(await read('?body=1&secrets=1')).toContain('o/r@main');
			expect(await read('?body=1')).not.toContain('o/r@main');
		});
	});
});

describe('a site that holds the rows the shipped build wrote', () => {
	const NOW = 1_760_000_000_000;
	// the shapes HEAD writes: `JSON.stringify` of a Remote, a PendingLogin, a ClaimsTicket and the
	// spent list, `String(site.nowMs())` for the claim stamp and the sorted key list for the rest
	const REMOTE = { id: 'github:o/r@main', provider: 'github', repo: 'o/r', branch: 'main' };
	const PENDING = {
		state: 'st',
		verifier: 'vf',
		nonce: 'nn',
		createdAt: NOW,
		returnTo: '/admin'
	};
	const TICKET = {
		ticket: 'tk',
		sub: 'u1',
		issuer: 'https://idp.example.com',
		email: 'a@b.test',
		name: 'A',
		expiresAt: NOW + 60_000
	};
	const LEGACY: Record<string, string> = {
		git_remotes: JSON.stringify([REMOTE]),
		recover_spent: JSON.stringify([{ h: 'proof-1', exp: NOW + 600_000 }]),
		first_run_at: String(NOW - 5_000),
		first_run_keys: 'adminMail,adminName,siteName',
		oidc_issuer: 'https://idp.example.com',
		oidc_client_id: 'client-1',
		oidc_pending: JSON.stringify(PENDING),
		oidc_ticket: JSON.stringify(TICKET)
	};

	const rows = (site: ServeDo) =>
		(site.sql.exec('SELECT k, v FROM cfw_meta').toArray() as { k: string; v: string }[]).filter(
			(r) => r.k in LEGACY
		);
	const legacySite = async (fn: (site: ServeDo) => Promise<void>) =>
		inObject(freshSite(), async (site) => {
			site.ensureServeTables();
			for (const [k, v] of Object.entries(LEGACY)) {
				site.sql.exec('INSERT INTO cfw_meta (k, v) VALUES (?, ?)', k, v);
			}
			await fn(site);
		});

	it('lists the remotes, as the shipped build did, and leaves no row', async () => {
		await legacySite(async (site) => {
			expect(site.gitRemotes()).toEqual([REMOTE]);
			const listed = (await (
				await site.handleGit(new URL('https://do.local/__git?action=list'))
			).json()) as { remotes: { repo: string }[] };
			expect(listed.remotes.map((r) => r.repo)).toEqual(['o/r']);
			expect(rows(site).map((r) => r.k)).not.toContain('git_remotes');
		});
	});

	it('still refuses a proof that was spent before the update', async () => {
		await legacySite(async (site) => {
			expect(spendProof(site.secretStore(), 'proof-1', NOW + 600_000, NOW)).toBe(false);
			expect(spendProof(site.secretStore(), 'proof-2', NOW + 600_000, NOW)).toBe(true);
			expect(rows(site).map((r) => r.k)).not.toContain('recover_spent');
		});
	});

	it('is still claimed, with the same stamp and the same key list', async () => {
		await legacySite(async (site) => {
			expect(site.metaGet('first_run_at')).toBe(LEGACY.first_run_at);
			expect(site.metaGet('first_run_keys')).toBe(LEGACY.first_run_keys);
			const body = (await (
				await site.fetch(new Request('https://do.local/__deployment'))
			).json()) as {
				claimedAt: number | null;
			};
			expect(body.claimedAt).toBe(NOW - 5_000);
			expect(rows(site).map((r) => r.k)).not.toContain('first_run_at');
		});
	});

	it('still has its provider configured and its login in flight', async () => {
		await legacySite(async (site) => {
			const config = (site as unknown as SitePhpDurableObject).oidcConfig(
				'https://site.example'
			);
			expect(config).toMatchObject({
				config: { issuer: 'https://idp.example.com', clientId: 'client-1' }
			});
			const pending = JSON.parse(site.metaGet('oidc_pending') ?? 'null');
			expect(oidcPendingMatches(pending, 'st', NOW + 1000)).not.toHaveProperty('refusal');
			const ticket = JSON.parse(site.metaGet('oidc_ticket') ?? 'null');
			expect(ticketRedeemable(ticket, 'tk', NOW + 1000)).not.toHaveProperty('refusal');
			expect(rows(site).map((r) => r.k)).not.toContain('oidc_issuer');
		});
	});

	it('moves every row at wake and matches the sealed copy to the row it replaced', async () => {
		await legacySite(async (site) => {
			await site.adoptSecrets();
			expect(rows(site)).toEqual([]);
			for (const [k, v] of Object.entries(LEGACY)) {
				expect(site.secretStore().sealed.get(k), k).toBe(v);
			}
		});
	});

	it('repeats a move that was cut off after the copy, with no loss and no second value', async () => {
		await legacySite(async (site) => {
			// the state a crash between the copy and the delete leaves: both exist
			for (const [k, v] of Object.entries(LEGACY)) site.secretStore().sealed.put(k, v);
			expect(rows(site)).toHaveLength(Object.keys(LEGACY).length);
			await site.adoptSecrets();
			await site.adoptSecrets();
			expect(rows(site)).toEqual([]);
			for (const [k, v] of Object.entries(LEGACY)) expect(site.metaGet(k), k).toBe(v);
			const kept = site.secretStore().sealed.list('');
			for (const k of Object.keys(LEGACY)) {
				expect(
					kept.filter(([key]) => key === k),
					k
				).toHaveLength(1);
			}
		});
	});

	it('writes nothing on a site that holds none of them', async () => {
		await inObject(freshSite(), async (site) => {
			site.ensureServeTables();
			const state = () =>
				JSON.stringify([
					site.sql.exec('SELECT k, v FROM cfw_meta ORDER BY k').toArray(),
					site.secretStore().sealed.list('')
				]);
			const before = state();
			await site.adoptSecrets();
			for (const k of Object.keys(LEGACY)) expect(site.metaGet(k), k).toBeNull();
			await site.adoptSecrets();
			expect(state()).toBe(before);
		});
	});
});

describe('a dump never says which site it came from', () => {
	/** a site that has learned its name and pinned an origin, as any served site has */
	async function named(name: string) {
		return inObject(freshSite(), async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			await migrate(site, '?all=1&prefill=0');
			site.siteName(name);
			const sql = seams(site).sql;
			sql.exec(
				"INSERT OR REPLACE INTO cfw_meta (k, v) VALUES ('site_origin', 'https://a.example')"
			);
			sql.exec("INSERT OR REPLACE INTO cfw_meta (k, v) VALUES ('zz_kept_probe', 'kept')");
			return {
				plain: dumpDatabase(sql).sql,
				withSecrets: dumpDatabase(sql, { secrets: true }).sql
			};
		});
	}

	it('omits the pinned name and origin, with or without secrets, and keeps other meta rows', async () => {
		const { plain, withSecrets } = await named('a.example');
		for (const dump of [plain, withSecrets]) {
			expect(dump).not.toContain("'site_name'");
			expect(dump).not.toContain("'site_origin'");
			expect(dump).not.toContain('a.example');
			expect(dump).toContain('zz_kept_probe');
		}
	});

	it('recognises an identity statement in the exporter own shape, and nothing wider', async () => {
		const { plain } = await named('a.example');
		const probe = plain
			.split('\n')
			.find((s) => s.includes('zz_kept_probe') && s.includes('cfw_meta'));
		expect(probe, 'no cfw_meta insert to take the shape from').toBeDefined();
		expect(
			isIdentityMetaStatement((probe as string).replace('zz_kept_probe', 'site_name'))
		).toBe(true);
		expect(
			isIdentityMetaStatement((probe as string).replace('zz_kept_probe', 'site_origin'))
		).toBe(true);
		expect(isIdentityMetaStatement(probe as string)).toBe(false);
		expect(
			isIdentityMetaStatement(
				`INSERT OR REPLACE INTO "cfw_meta" (k, v) VALUES ('site_name', 'a.example');`
			)
		).toBe(true);
		expect(
			isIdentityMetaStatement(`INSERT INTO "cfw_meta" ("k", "v") VALUES ('site_name2', 'x');`)
		).toBe(false);
		expect(
			isIdentityMetaStatement(`INSERT INTO "other" ("k", "v") VALUES ('site_name', 'x');`)
		).toBe(false);
	});

	it('does not rename the target when an OLD dump that carries a name is restored into it', async () => {
		const { plain } = await named('a.example');
		const old = `${plain}\nINSERT OR REPLACE INTO "cfw_meta" ("k", "v") VALUES ('site_name', 'a.example');\nINSERT OR REPLACE INTO "cfw_meta" ("k", "v") VALUES ('site_origin', 'https://a.example');\n`;
		const after = await inObject(freshSite(), async (site) => {
			site.siteName('b.example');
			const { sql, storage } = seams(site);
			const id = storeImport(sql, old, {
				storage,
				generation: 'old-dump',
				source: 'test',
				nowMs: 1,
				skip: isIdentityMetaStatement
			}).id;
			await new SqlMigrator({
				sql,
				storage,
				now: () => Date.now(),
				...storedImportLoader(sql, id)
			}).step({ maxChunks: Infinity });
			const replayed = site.siteName();
			return {
				replayed,
				// the next request names it again, as every request does
				relearned: site.siteName('b.example'),
				origin: sql.exec("SELECT v FROM cfw_meta WHERE k = 'site_origin'").toArray(),
				kept: sql.exec("SELECT v FROM cfw_meta WHERE k = 'zz_kept_probe'").toArray()
			};
		});
		// the restore replaces cfw_meta, so the pin is gone until a request teaches it again
		expect(after.replayed).not.toBe('a.example');
		expect(after.relearned).toBe('b.example');
		expect(after.origin).toEqual([]);
		expect(after.kept).toEqual([{ v: 'kept' }]);
	});

	it('without the filter the same replay renames the target, which is the bug', async () => {
		const { plain } = await named('a.example');
		const old = `${plain}\nINSERT OR REPLACE INTO "cfw_meta" ("k", "v") VALUES ('site_name', 'a.example');\n`;
		const name = await inObject(freshSite(), async (site) => {
			site.siteName('b.example');
			const { sql, storage } = seams(site);
			const id = storeImport(sql, old, {
				storage,
				generation: 'old-dump',
				source: 'test',
				nowMs: 1
			}).id;
			await new SqlMigrator({
				sql,
				storage,
				now: () => Date.now(),
				...storedImportLoader(sql, id)
			}).step({ maxChunks: Infinity });
			return site.siteName();
		});
		expect(name).toBe('a.example');
	});
});
