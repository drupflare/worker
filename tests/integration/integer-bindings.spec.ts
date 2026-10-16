import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * A PHP integer against a TEXT column.
 *
 * `ctx.storage.sql.exec()` binds a JavaScript number as a REAL, so `0` reaches SQLite as `0.0` and
 * a TEXT column compares it as `'0.0'`. earth-app's mantle2 keeps an enum ordinal in a varchar
 * field, and `/v2/events`, `/v2/prompts` and `/v2/users` each listed nothing on a copy with 444,
 * 48 and 63 rows behind them. The control below is the platform; the rest is the driver's entry
 * point, which every PHP statement and every buffered write crosses.
 */

type Row = Record<string, unknown>;

async function withTable<T>(fn: (site: ServeDo) => Promise<T> | T): Promise<T> {
	return inObject(freshSite(), async (site: ServeDo) => {
		site.sql.exec(
			'CREATE TABLE IF NOT EXISTS vis (id INTEGER PRIMARY KEY, v TEXT NOT NULL, n INTEGER)'
		);
		site.sql.exec('CREATE INDEX IF NOT EXISTS vis_v ON vis (v)');
		site.sql.exec('DELETE FROM vis');
		site.sql.exec("INSERT INTO vis (id, v, n) VALUES (1, '0', 0), (2, '1', 1), (3, '0', 2)");
		return fn(site);
	});
}

describe('integers bound against a TEXT column', () => {
	it('the platform control: a bound number is a REAL and matches no text', async () => {
		// the platform's own handle, not `site.sql`, which is the wrapped one that binds integers
		const seen = await withTable((site) => {
			const platform = (site as unknown as { ctx: { storage: { sql: ServeDo['sql'] } } }).ctx
				.storage.sql;
			return {
				asReal: platform
					.exec('SELECT typeof(?) AS t, CAST(? AS TEXT) AS s', 0, 0)
					.toArray() as Row[],
				matches: platform
					.exec('SELECT COUNT(*) AS n FROM vis WHERE v = ?', 0)
					.toArray() as Row[],
				wrapped: site.sql
					.exec('SELECT COUNT(*) AS n FROM vis WHERE v = ?', 0)
					.toArray() as Row[]
			};
		});
		expect(seen.asReal[0]).toEqual({ t: 'real', s: '0.0' });
		expect(seen.matches[0]?.n).toBe(0);
		expect(seen.wrapped[0]?.n).toBe(2);
	}, 300_000);

	it('execSql finds the rows a PHP int names, and the control does not', async () => {
		const rows = await withTable(
			(site) => site.execSql('SELECT id FROM vis WHERE v = ? ORDER BY id', [0]).rows as Row[]
		);
		expect(rows.map((r) => r.id)).toEqual([1, 3]);
	}, 300_000);

	it('binds by name, in an IN list, and still matches an INTEGER column', async () => {
		const seen = await withTable((site) => ({
			named: site.execSql('SELECT id FROM vis WHERE v = :a ORDER BY id', { ':a': 1 })
				.rows as Row[],
			list: site.execSql('SELECT id FROM vis WHERE v IN (?, ?) ORDER BY id', [0, 1])
				.rows as Row[],
			column: site.execSql('SELECT id FROM vis WHERE n = ? ORDER BY id', [2]).rows as Row[]
		}));
		expect(seen.named.map((r) => r.id)).toEqual([2]);
		expect(seen.list.map((r) => r.id)).toEqual([1, 2, 3]);
		expect(seen.column.map((r) => r.id)).toEqual([3]);
	}, 300_000);

	it('stores an integer in a TEXT column as "5", not "5.0", on INSERT and UPDATE', async () => {
		const rows = await withTable((site) => {
			site.execSql('INSERT INTO vis (id, v, n) VALUES (?, ?, ?)', [4, 5, 5]);
			site.execSql('UPDATE vis SET v = ? WHERE id = ?', [9, 2]);
			return site.sql
				.exec('SELECT id, v, typeof(v) AS t FROM vis WHERE id IN (2, 4) ORDER BY id')
				.toArray() as Row[];
		});
		expect(rows).toEqual([
			{ id: 2, v: '9', t: 'text' },
			{ id: 4, v: '5', t: 'text' }
		]);
	}, 300_000);

	it('keeps LIMIT and OFFSET working, and leaves a float and a string alone', async () => {
		const seen = await withTable((site) => ({
			page: site.execSql('SELECT id FROM vis ORDER BY id LIMIT ? OFFSET ?', [1, 1])
				.rows as Row[],
			text: site.execSql('SELECT id FROM vis WHERE v = ? ORDER BY id', ['1']).rows as Row[],
			float: site.execSql('SELECT ? AS f', [1.5]).rows as Row[]
		}));
		expect(seen.page.map((r) => r.id)).toEqual([2]);
		expect(seen.text.map((r) => r.id)).toEqual([2]);
		expect(seen.float[0]?.f).toBe(1.5);
	}, 300_000);
});
