import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { freshSite } from '../helpers/serve-do';

/**
 * Whether `ctx.storage.kv` escapes the rows-written meter that binds regeneration.
 *
 * A page cache is `key -> blob`, and this project stores it as relational SQLite rows. The proposal
 * is that the sync KV API on a SQLite-backed object is the cheaper representation of the same thing,
 * because rows -- not bytes -- are what bind regeneration at 10,869/day.
 *
 * **THE LOCAL ROW COUNTER CANNOT ANSWER THIS AND WOULD ANSWER IT WRONG.** `rowsToday` comes from
 * `countingSql()` wrapping the storage handle, so it sees statements. A `kv.put()` does not go
 * through a statement, so a spec that read that counter would see zero and report KV as free. The
 * question is whether the platform's meter sees it, and the only local evidence that bears on that
 * is whether the data lands in the same SQLite database -- which `databaseSize` and `sqlite_master`
 * can both answer.
 */

const TIMEOUT = 120_000;

type Ctx = {
	storage: {
		kv?: {
			put(key: string, value: unknown): void;
			get(key: string): unknown;
			delete(key: string): void;
		};
		sql: {
			exec(
				text: string,
				...params: unknown[]
			): { toArray(): Record<string, unknown>[]; rowsWritten: number };
			databaseSize: number;
		};
	};
};

const VALUE = 'x'.repeat(4096);

describe('does the sync KV API dodge the rows-written meter', () => {
	it(
		'reports whether KV writes land in the same SQLite database as SQL writes',
		async () => {
			const out = await runInDurableObject(freshSite(), (_instance, state) => {
				const ctx = state as unknown as Ctx;
				const kv = ctx.storage.kv;
				if (!kv) return { available: false as const };

				const tablesBefore = ctx.storage.sql
					.exec("SELECT name FROM sqlite_master WHERE type='table'")
					.toArray()
					.map((r) => String(r.name));

				const sizeBefore = ctx.storage.sql.databaseSize;
				for (let i = 0; i < 100; i++) kv.put(`probe:${i}`, VALUE);
				const sizeAfterKv = ctx.storage.sql.databaseSize;

				const tablesAfter = ctx.storage.sql
					.exec("SELECT name FROM sqlite_master WHERE type='table'")
					.toArray()
					.map((r) => String(r.name));

				// the control: the same 100 logical writes as SQL, into the shape the serve tables
				// already use, so the comparison is against what ships rather than a rowid table
				ctx.storage.sql.exec(
					'CREATE TABLE IF NOT EXISTS kv_control (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID'
				);
				const sizeBeforeSql = ctx.storage.sql.databaseSize;
				let sqlRows = 0;
				for (let i = 0; i < 100; i++) {
					sqlRows += ctx.storage.sql.exec(
						'INSERT OR REPLACE INTO kv_control (k, v) VALUES (?, ?)',
						`probe:${i}`,
						VALUE
					).rowsWritten;
				}
				const sizeAfterSql = ctx.storage.sql.databaseSize;

				return {
					available: true as const,
					kvBytes: sizeAfterKv - sizeBefore,
					sqlBytes: sizeAfterSql - sizeBeforeSql,
					sqlRows,
					// a table that appeared BECAUSE of the KV writes is the whole finding: it means
					// the KV store is the same database and therefore the same meter
					newTables: tablesAfter.filter((t) => !tablesBefore.includes(t)),
					tablesAfter,
					// the store is a real table in this database and STILL not auditable: workerd
					// answers SQLITE_AUTH on it, so a KV-backed page cache could not be measured
					// the way cfw_page is measured
					kvReadable: (() => {
						try {
							ctx.storage.sql.exec('SELECT count(*) FROM _cf_KV');
							return true;
						} catch {
							return false;
						}
					})(),
					readBack: kv.get('probe:7') === VALUE
				};
			});

			console.log(`[kv-charge] ${JSON.stringify(out)}`);
			// NOT skipped when absent: a runtime that lost the API would otherwise read as a pass,
			// and this spec's whole job is to keep the refutation measured rather than remembered
			expect(out.available, 'ctx.storage.kv is not present on this runtime').toBe(true);
			if (!out.available) return;

			expect(out.readBack, 'the KV round trip did not return what was written').toBe(true);
			// THE FINDING. The KV store is a table in the object's own SQLite database, so it is
			// billed by the same rows-written meter as every other table here
			expect(out.newTables).toContain('_cf_KV');
			expect(out.kvReadable, 'workerd answers SQLITE_AUTH on the internal table').toBe(false);
			// and it is not cheaper in bytes either: measured 475,136 against 471,040 for the same
			// 100 logical writes into the WITHOUT ROWID shape the serve tables already use
			expect(out.kvBytes).toBeGreaterThanOrEqual(out.sqlBytes);
		},
		TIMEOUT
	);
});
