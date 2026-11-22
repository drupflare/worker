import { describe, expect, it, vi } from 'vitest';
import { dbconsole } from '../../src/do/routes/lifecycle';
import { blankLiterals, cellOf, readConsole, readOnlyRefusal } from '../../src/ops/db-console';
import type { SitePhpDurableObject } from '../../src/site-do';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

type Json = Record<string, any>;

const call = async (site: ServeDo, body: unknown, method = 'POST') => {
	const res = await dbconsole(
		site as unknown as SitePhpDurableObject,
		new Request('https://cfw.local/db-console', {
			method,
			body: method === 'POST' ? JSON.stringify(body) : undefined
		}),
		new URL('https://cfw.local/db-console')
	);
	return { status: res.status, body: (await res.json()) as Json };
};

const ask = (sql: string, extra: Json = {}) => ({
	v: 1,
	sql,
	params: [],
	limit: 1000,
	timeoutMs: 5000,
	...extra
});

describe('the statement check', () => {
	it('accepts a read and ignores a keyword inside a literal or a comment', () => {
		expect(readOnlyRefusal('SELECT 1')).toBeUndefined();
		expect(readOnlyRefusal('select * from t where name = ?;')).toBeUndefined();
		expect(readOnlyRefusal("SELECT 'drop table t' AS note")).toBeUndefined();
		expect(readOnlyRefusal('SELECT 1 -- delete from t')).toBeUndefined();
		expect(readOnlyRefusal('/* update */ SELECT "update" FROM t')).toBeUndefined();
		expect(readOnlyRefusal('WITH x AS (SELECT 1 AS n) SELECT n FROM x')).toBeUndefined();
	});

	it.each([
		['delete from t', 'only SELECT'],
		['  insert into t values (1)', 'only SELECT'],
		['SELECT 1; DELETE FROM t', 'one statement'],
		['WITH x AS (SELECT 1) DELETE FROM t', 'DELETE'],
		['SELECT 1 /* x */; DROP TABLE t', 'one statement'],
		['PRAGMA writable_schema = 1', 'only SELECT'],
		['SELECT 1 UNION SELECT 2; ATTACH DATABASE x AS y', 'one statement'],
		['REPLACE INTO t VALUES (1)', 'only SELECT'],
		['', 'empty']
	])('refuses %j', (sql, why) => {
		expect(readOnlyRefusal(sql)).toContain(why);
	});

	it('blanks literals, comments and quoted names', () => {
		expect(blankLiterals('SELECT \'a;b\' /* ; */ -- ;\n, [x;y], "p;q", `r;s`')).not.toContain(
			';'
		);
		expect(blankLiterals("SELECT 'it''s; here'")).not.toContain(';');
	});

	it('carries every SQLite value type as a contract cell', () => {
		expect(cellOf(null)).toBeNull();
		expect(cellOf(7)).toBe(7);
		expect(cellOf(2n ** 60n)).toBe((2n ** 60n).toString());
		expect(cellOf(5n)).toBe(5);
		expect(cellOf(new Uint8Array([1, 171]).buffer)).toBe("x'01ab'");
		expect(cellOf(Number.POSITIVE_INFINITY)).toBe('Infinity');
	});
});

describe('the request check', () => {
	it.each([
		[{ ...ask('SELECT 1'), v: 2 }, 400],
		[ask('x'.repeat(10_001)), 413],
		[ask('SELECT 1', { params: new Array(101).fill(1) }), 413],
		[ask('SELECT 1', { params: [{ a: 1 }] }), 400],
		[ask('SELECT 1', { limit: 1001 }), 413],
		[ask('SELECT 1', { limit: 0 }), 400],
		[ask('SELECT 1', { timeoutMs: 30_001 }), 413],
		[ask('DELETE FROM t'), 422]
	])('answers the status the contract implies for %j', (body, status) => {
		const read = readConsole(body);
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.status).toBe(status);
	});
});

describe('POST /db-console', () => {
	it('refuses a GET and a body that is not JSON', async () => {
		await inObject(freshSite(), async (site) => {
			expect((await call(site, undefined, 'GET')).status).toBe(405);
			const bad = await dbconsole(
				site as unknown as SitePhpDurableObject,
				new Request('https://cfw.local/db-console', { method: 'POST', body: 'nope' }),
				new URL('https://cfw.local/db-console')
			);
			expect(bad.status).toBe(400);
		});
	});

	it('answers columns, rows and a truncation flag, and binds params', async () => {
		await inObject(freshSite(), async (site) => {
			site.sql.exec(
				'CREATE TABLE console_probe (id INTEGER PRIMARY KEY, name TEXT, blob BLOB)'
			);
			for (let i = 1; i <= 5; i++) {
				site.sql.exec(
					'INSERT INTO console_probe VALUES (?, ?, ?)',
					i,
					`row ${i}`,
					new Uint8Array([i])
				);
			}
			const all = await call(
				site,
				ask('SELECT id, name, blob FROM console_probe ORDER BY id')
			);
			expect(all.status).toBe(200);
			expect(all.body['columns']).toEqual(['id', 'name', 'blob']);
			expect(all.body['rows']).toHaveLength(5);
			expect(all.body['rows'][0]).toEqual([1, 'row 1', "x'01'"]);
			expect(all.body['truncated']).toBe(false);
			expect(typeof all.body['elapsedMs']).toBe('number');

			const cut = await call(
				site,
				ask('SELECT id FROM console_probe ORDER BY id', { limit: 2 })
			);
			expect(cut.body['rows']).toEqual([[1], [2]]);
			expect(cut.body['truncated']).toBe(true);

			const bound = await call(
				site,
				ask('SELECT name FROM console_probe WHERE id = ?', { params: [3] })
			);
			expect(bound.body['rows']).toEqual([['row 3']]);
		});
	});

	it('answers a statement that ran past timeoutMs with its rows and the time taken', async () => {
		await inObject(freshSite(), async (site) => {
			let clock = 1_000;
			const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 400));
			try {
				const slow = await call(site, ask('SELECT 1 AS n', { timeoutMs: 1 }));
				expect(slow.status).toBe(200);
				expect(slow.body['rows']).toEqual([[1]]);
				expect(slow.body['elapsedMs']).toBeGreaterThan(1);
			} finally {
				now.mockRestore();
			}
		});
	});

	it('leaves the database as it was when a statement the check misses writes', async () => {
		await inObject(freshSite(), async (site) => {
			site.sql.exec('CREATE TABLE console_probe (id INTEGER PRIMARY KEY, name TEXT)');
			site.sql.exec("INSERT INTO console_probe VALUES (1, 'kept')");
			const refused = await call(site, ask('DELETE FROM console_probe'));
			expect(refused.status).toBe(422);
			expect(refused.body['code']).toBe('not_read_only');
			// the second guard: stand in for a statement the check lets through that writes
			const raw = site.ctx.storage.sql as unknown as {
				exec: (text: string, ...params: unknown[]) => unknown;
			};
			const original = raw.exec;
			raw.exec = function (this: unknown, text: string, ...params: unknown[]) {
				return original.call(
					this,
					text === 'SELECT 1' ? 'DELETE FROM console_probe' : text,
					...params
				);
			};
			const sneaky = await call(site, ask('SELECT 1'));
			raw.exec = original;
			expect(sneaky.status).toBe(422);
			expect(sneaky.body['message']).toContain('rolled back');
			const rows = site.sql.exec('SELECT name FROM console_probe').toArray();
			expect(rows).toEqual([{ name: 'kept' }]);
		});
	});

	it('answers a failed statement as a refusal, and refuses while a transaction is open', async () => {
		await inObject(freshSite(), async (site) => {
			const missing = await call(site, ask('SELECT * FROM no_such_table'));
			expect(missing.status).toBe(400);
			expect(missing.body['code']).toBe('statement_failed');
			expect(String(missing.body['message'])).toContain('no_such_table');
			const typo = await call(site, ask('SELECT FROM WHERE'));
			expect(typo.body['code']).toBe('statement_failed');
			(site as unknown as SitePhpDurableObject).speculating = true;
			const open = await call(site, ask('SELECT 1'));
			expect(open.status).toBe(503);
			expect(open.body['code']).toBe('unavailable');
		});
	});
});
