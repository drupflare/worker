import { describe, expect, it } from 'vitest';
import {
	RESTORE_OWNED_TABLES,
	RUNTIME_OWNED_PREFIXES,
	dumpDatabase,
	isRegenerable,
	tableColumns
} from '../../src/db/export-sql';
import { getFile, putFile } from '../../src/db/file-store';
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
