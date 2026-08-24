import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * P33: reading a SQLite INTEGER wider than 2^53 exactly.
 *
 * ## The platform, re-measured 2026-08-23 rather than quoted
 *
 * | written               | through the cursor    | `CAST(col AS TEXT)`   |
 * | --------------------- | --------------------- | --------------------- |
 * | `9007199254740993`   | `9007199254740992`   | `9007199254740993`   |
 * | `9223372036854775807` | `9223372036854776000` | `9223372036854775807` |
 *
 * `typeof(col)` is `integer` on both, so the storage is exact and only the read is lossy. Unchanged
 * from the first reading, so the mechanism is real and is not an instrument artifact.
 *
 * ## The shapes, which the item asked to be listed rather than promised
 *
 * The repair wraps the ORIGINAL statement as a subquery and casts by OUTPUT COLUMN NAME, so it does
 * not parse SQL and does not care what produced the column. That is asserted here shape by shape,
 * because "covered by construction" is an argument and this file is the measurement.
 */

const WIDE = '9007199254740993';
const MAX64 = '9223372036854775807';

type Row = Record<string, unknown>;

async function withTable<T>(fn: (site: ServeDo) => Promise<T> | T): Promise<T> {
	return inObject(freshSite(), async (site: ServeDo) => {
		site.sql.exec(
			'CREATE TABLE IF NOT EXISTS w (id INTEGER PRIMARY KEY, big INTEGER, small INTEGER, txt TEXT)'
		);
		site.sql.exec('DELETE FROM w');
		site.sql.exec('INSERT INTO w (id, big, small, txt) VALUES (1, ?, 7, ?)', WIDE, 'a');
		site.sql.exec('INSERT INTO w (id, big, small, txt) VALUES (2, ?, 8, ?)', MAX64, 'b');
		site.sql.exec('CREATE TABLE IF NOT EXISTS j (id INTEGER PRIMARY KEY, w_id INTEGER)');
		site.sql.exec('DELETE FROM j');
		site.sql.exec('INSERT INTO j (id, w_id) VALUES (10, 1), (11, 2)');
		return fn(site);
	});
}

const bigs = (rows: Row[], key = 'big') => rows.map((r) => String(r[key]));

describe('P33: the platform loses precision, and the repair gets it back', () => {
	it('reads a bare column exactly, where the raw cursor does not', async () => {
		const seen = await withTable((site) => ({
			raw: site.sql.exec('SELECT big FROM w ORDER BY id').toArray() as Row[],
			repaired: site.execSql('SELECT big FROM w ORDER BY id') as { rows: Row[] }
		}));
		// the control: the platform is still lossy, so the repair is repairing something
		expect(bigs(seen.raw)).toEqual(['9007199254740992', '9223372036854776000']);
		expect(bigs(seen.repaired.rows)).toEqual([WIDE, MAX64]);
	}, 300_000);

	it('leaves a value a double CAN hold alone, and leaves its type alone', async () => {
		const rows = (
			await withTable((site) => site.execSql('SELECT small, txt FROM w ORDER BY id'))
		).rows as Row[];
		// still numbers, not strings: a repair that stringified everything would change what
		// every existing caller receives
		expect(rows.map((r) => r.small)).toEqual([7, 8]);
		expect(typeof rows[0]?.small).toBe('number');
		expect(rows.map((r) => r.txt)).toEqual(['a', 'b']);
	}, 300_000);
});

describe('P33: the shapes it covers', () => {
	const shapes: Array<{ name: string; sql: string; key: string; want: string[] }> = [
		{ name: 'SELECT *', sql: 'SELECT * FROM w ORDER BY id', key: 'big', want: [WIDE, MAX64] },
		{
			name: 'an alias',
			sql: 'SELECT big AS ident FROM w ORDER BY id',
			key: 'ident',
			want: [WIDE, MAX64]
		},
		{
			name: 'a qualified column',
			sql: 'SELECT w.big FROM w ORDER BY w.id',
			key: 'big',
			want: [WIDE, MAX64]
		},
		{
			name: 'a JOIN',
			sql: 'SELECT w.big AS b FROM w JOIN j ON j.w_id = w.id ORDER BY j.id',
			key: 'b',
			want: [WIDE, MAX64]
		},
		{
			name: 'an aggregate',
			sql: 'SELECT MAX(big) AS m FROM w',
			key: 'm',
			want: [MAX64]
		},
		{
			name: 'ORDER BY and LIMIT',
			sql: 'SELECT big FROM w ORDER BY big DESC LIMIT 1',
			key: 'big',
			want: [MAX64]
		},
		{
			name: 'a subquery of its own',
			sql: 'SELECT big FROM (SELECT big FROM w ORDER BY id) LIMIT 1',
			key: 'big',
			want: [WIDE]
		},
		{
			name: 'a UNION',
			sql: 'SELECT big FROM w WHERE id = 1 UNION ALL SELECT big FROM w WHERE id = 2',
			key: 'big',
			want: [WIDE, MAX64]
		},
		{
			name: 'a bound parameter',
			sql: 'SELECT big FROM w WHERE id = ? ORDER BY id',
			key: 'big',
			want: [MAX64]
		}
	];

	for (const shape of shapes) {
		it(`covers ${shape.name}`, async () => {
			const rows = (
				await withTable((site) =>
					site.execSql(shape.sql, shape.sql.includes('?') ? [2] : undefined)
				)
			).rows as Row[];
			expect(bigs(rows, shape.key)).toEqual(shape.want);
		}, 300_000);
	}

	it('REFUSES a shape it cannot wrap, and leaves the lossy value rather than throwing', async () => {
		// a CTE is deliberately outside the wrappable set; the honest outcome is the value the
		// caller would have had anyway, not an exception on the serving path
		const rows = (
			await withTable((site) =>
				site.execSql('WITH x AS (SELECT big FROM w ORDER BY id) SELECT big FROM x')
			)
		).rows as Row[];
		expect(bigs(rows)).toEqual(['9007199254740992', '9223372036854776000']);
	}, 300_000);

	it('does not fire at all when nothing is wide, so an ordinary site pays nothing', async () => {
		const repairs = await withTable((site) => {
			site.wideRepairs = 0;
			site.execSql('SELECT small, txt FROM w ORDER BY id');
			site.execSql('SELECT COUNT(*) AS n FROM w');
			return site.wideRepairs;
		});
		expect(repairs).toBe(0);
	}, 300_000);
});
