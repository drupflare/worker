import { describe, expect, it } from 'vitest';
import {
	DEFAULT_BACKEND,
	backendNeedsPark,
	dialectOf,
	selectBackend,
	type BackendSelection
} from '../../../src/db/backend';
import { backendExec, toDollarPlaceholders, type PgClient } from '../../../src/db/pg-exec';
import {
	PARK_SQL_SCHEME,
	classifyParkOp,
	parseParkSql,
	performSql
} from '../../../src/ops/park-drive';

/**
 * Where a site's SQL executes, and the two things that decide it.
 *
 * The roadmap promoted this as GROUNDWORK: an external database is what makes a site portable in
 * the sense the self-hosted tier promises, and it removes the 5 GB account-wide storage cap that is
 * today the only hard limit on fleet size. What it is not is a default -- `ctx.storage.sql` is, and
 * every assertion about the default path here exists so that stays true.
 */

const b64 = (value: unknown) => btoa(JSON.stringify(value));

describe('the backend is selected, and says so when it cannot be', () => {
	it('defaults to the object own storage with nothing configured', () => {
		const s = selectBackend({});
		expect(s.name).toBe(DEFAULT_BACKEND);
		expect(s.available).toBe(true);
		expect(backendNeedsPark(s)).toBe(false);
	});

	it('takes the explicit default the same way', () => {
		expect(selectBackend({ DB_BACKEND: 'do-sqlite' }).available).toBe(true);
		expect(selectBackend({ DB_BACKEND: ' DO-SQLite ' }).name).toBe('do-sqlite');
	});

	/**
	 * A MISCONFIGURED SITE MUST NOT QUIETLY RUN ON THE OTHER DATABASE. Falling back silently is the
	 * decorative-configuration shape: the operator chose Hyperdrive, the deploy bound none, and the
	 * site would serve from its own storage while its owner believed otherwise.
	 */
	it('refuses hyperdrive with no binding rather than falling back quietly', () => {
		const s = selectBackend({ DB_BACKEND: 'hyperdrive' });
		expect(s.name).toBe('hyperdrive');
		expect(s.available).toBe(false);
		expect(s.why).toContain('HYPERDRIVE');
		expect(backendNeedsPark(s)).toBe(false);
	});

	it('names an unknown backend instead of guessing at one', () => {
		const s = selectBackend({ DB_BACKEND: 'mysql' });
		expect(s.available).toBe(false);
		expect(s.why).toContain('mysql');
		// and it still reports the default as the one in force, because that is what will run
		expect(s.name).toBe(DEFAULT_BACKEND);
	});

	it('reads the dialect off the connection string rather than a second knob', () => {
		expect(dialectOf('postgres://u:p@h:5432/d')).toBe('postgres');
		expect(dialectOf('postgresql://u:p@h:5432/d')).toBe('postgres');
		expect(dialectOf('mysql://u:p@h:3306/d')).toBe('mysql');
		// a second knob that can disagree with the string is a knob that will, so there is none
		expect(dialectOf('redis://h:6379')).toBeNull();
		expect(dialectOf('')).toBeNull();
	});

	it('refuses a connection string naming neither database', () => {
		const s = selectBackend({
			DB_BACKEND: 'hyperdrive',
			HYPERDRIVE: { connectionString: 'redis://h:6379' }
		});
		expect(s.available).toBe(false);
		expect(s.why).toContain('mysql://');
	});

	it('carries the mysql dialect through', () => {
		const s = selectBackend({
			DB_BACKEND: 'hyperdrive',
			HYPERDRIVE: { connectionString: 'mysql://u:p@h:3306/d' }
		});
		expect(s.available).toBe(true);
		expect(s.dialect).toBe('mysql');
		expect(backendNeedsPark(s)).toBe(true);
	});

	it('takes hyperdrive when the binding carries a connection string', () => {
		const s = selectBackend({
			DB_BACKEND: 'hyperdrive',
			HYPERDRIVE: { connectionString: 'postgres://u:p@h:5432/d' }
		});
		expect(s.available).toBe(true);
		expect(s.connectionString).toBe('postgres://u:p@h:5432/d');
		// the park arms ONLY here: a class armed and not served routes every render through
		// `cfw_park_run` for a yield that always falls back, which is measured harmful
		expect(backendNeedsPark(s)).toBe(true);
	});

	it('treats an empty connection string as no binding', () => {
		expect(
			selectBackend({ DB_BACKEND: 'hyperdrive', HYPERDRIVE: { connectionString: '' } })
				.available
		).toBe(false);
	});
});

describe('one statement against the external backend', () => {
	const ready: BackendSelection = {
		name: 'hyperdrive',
		available: true,
		why: '',
		connectionString: 'postgres://u:p@h:5432/d'
	};

	const stub = (
		answer: { rows: Record<string, unknown>[]; rowCount: number | null },
		log: string[] = []
	) => ({
		client(): PgClient {
			return {
				async connect() {
					log.push('connect');
				},
				async query(text: string, values?: unknown[]) {
					log.push(`query:${text}:${JSON.stringify(values ?? [])}`);
					return answer;
				},
				async end() {
					log.push('end');
				}
			};
		}
	});

	it('answers in the shape the host own SQL seam uses', async () => {
		const out = await backendExec(
			ready,
			'SELECT nid FROM node WHERE nid = $1',
			[7],
			stub({ rows: [{ nid: 7 }], rowCount: 1 })
		);
		expect(out.rows).toEqual([{ nid: 7 }]);
		// a statement that returned rows READ them; `pg` reports one count for both cases and only
		// the row list tells them apart
		expect(out.rowsRead).toBe(1);
		expect(out.rowsWritten).toBe(0);
	});

	it('counts a write as written rather than read', async () => {
		const out = await backendExec(
			ready,
			'DELETE FROM node',
			[],
			stub({ rows: [], rowCount: 4 })
		);
		expect(out.rowsWritten).toBe(4);
		expect(out.rowsRead).toBe(0);
	});

	/** Hyperdrive pools the origin connection, so a client left open holds one for the object life */
	it('closes the client even when the statement throws', async () => {
		const log: string[] = [];
		const deps = {
			client(): PgClient {
				return {
					async connect() {
						log.push('connect');
					},
					async query() {
						throw new Error('syntax error');
					},
					async end() {
						log.push('end');
					}
				};
			}
		};
		await expect(backendExec(ready, 'NOT SQL', [], deps)).rejects.toThrow('syntax error');
		expect(log).toEqual(['connect', 'end']);
	});

	it('refuses before connecting when no backend is available', async () => {
		const log: string[] = [];
		await expect(
			backendExec(
				{ name: 'hyperdrive', available: false, why: 'no HYPERDRIVE binding' },
				'SELECT 1',
				[],
				stub({ rows: [], rowCount: 0 }, log)
			)
		).rejects.toThrow('no HYPERDRIVE binding');
		expect(log, 'it dialled a database it had already refused').toEqual([]);
	});
});

describe('the parked statement, decoded and performed', () => {
	it('round-trips a descriptor', () => {
		expect(parseParkSql(b64({ sql: 'SELECT 1', params: [2] }))).toEqual({
			sql: 'SELECT 1',
			params: [2]
		});
		// params are optional; a statement with none is not a broken descriptor
		expect(parseParkSql(b64({ sql: 'SELECT 1' }))).toEqual({ sql: 'SELECT 1', params: [] });
	});

	it.each([['not base64'], [b64({ params: [] })], [b64({ sql: '' })], [b64([1, 2])]])(
		'reads %p as unreadable rather than as a partial statement',
		(packed) => {
			expect(parseParkSql(packed as string)).toBeNull();
		}
	);

	/**
	 * A REFUSED SQL PARK CANNOT DEGRADE, which is the one place this differs from the fetch scheme.
	 * A refused fetch falls back to the deferred transport; there is no local copy of an external
	 * database, so the refusal has to travel back as an error the driver reports.
	 */
	it('refuses the scheme on a deployment with no external backend', () => {
		const op = classifyParkOp(
			{
				fn: 'stream_socket_client',
				args: [{ b64: btoa(PARK_SQL_SCHEME + b64({ sql: 'SELECT 1' })) }]
			},
			new Set(),
			{} as never
		);
		expect(op.kind).toBe('refused');
		if (op.kind !== 'refused') return;
		expect(op.why).toContain('no external database backend is selected');
	});

	it('classifies it as sql when one is bound', () => {
		const op = classifyParkOp(
			{
				fn: 'stream_socket_client',
				args: [{ b64: btoa(PARK_SQL_SCHEME + b64({ sql: 'SELECT 1' })) }]
			},
			new Set(),
			{
				DB_BACKEND: 'hyperdrive',
				HYPERDRIVE: { connectionString: 'postgres://u:p@h:5432/d' }
			} as never
		);
		expect(op.kind).toBe('sql');
	});

	it('answers a transport failure in the same shape as a result', async () => {
		const ready: BackendSelection = {
			name: 'hyperdrive',
			available: true,
			why: '',
			connectionString: 'postgres://u:p@h:5432/d'
		};
		const ok = JSON.parse(
			new TextDecoder().decode(
				await performSql({ sql: 'SELECT 1', params: [] }, ready, async () => ({
					rows: [{ a: 1 }],
					rowsWritten: 0,
					rowsRead: 1,
					lastInsertId: '0'
				}))
			)
		);
		expect(ok.error).toBe('');
		expect(ok.result.rows).toEqual([{ a: 1 }]);

		const bad = JSON.parse(
			new TextDecoder().decode(
				await performSql({ sql: 'SELECT 1', params: [] }, ready, async () => {
					throw new Error('connection refused');
				})
			)
		);
		// THE SHAPE IS THE SAME: a throw out of here would unwind the park loop instead, leaving a
		// chain frozen mid-statement that nothing resumes
		expect(bad.error).toContain('connection refused');
		expect(bad.result).toBeNull();
	});
});

/**
 * The two dialects, and the two things that differ between them.
 *
 * Both were MEASURED against the rig rather than assumed: PostgreSQL 17.6 answers a SELECT as
 * `{rows: [{n: 7}], rowCount: 1}` and an INSERT as `{rows: [], rowCount: 1}`; MySQL 9.5 answers a
 * SELECT as an ARRAY and an INSERT as a header object carrying `affectedRows: 1`. Those are the
 * shapes the adapter reduces to one.
 */
describe('placeholders, which the two databases do not share', () => {
	it('rewrites positional placeholders for postgres', () => {
		expect(toDollarPlaceholders('SELECT * FROM n WHERE a = ? AND b = ?')).toBe(
			'SELECT * FROM n WHERE a = $1 AND b = $2'
		);
	});

	it('leaves a statement with none alone', () => {
		expect(toDollarPlaceholders('SELECT 1')).toBe('SELECT 1');
	});

	/**
	 * A `?` INSIDE A LITERAL IS NOT A PLACEHOLDER, and rewriting one corrupts the statement. This
	 * is the case a regex gets wrong on the first row of real content.
	 */
	it('does not touch a question mark inside a string literal', () => {
		expect(toDollarPlaceholders("SELECT * FROM n WHERE note = 'why?' AND a = ?")).toBe(
			"SELECT * FROM n WHERE note = 'why?' AND a = $1"
		);
		expect(toDollarPlaceholders('SELECT "a?b" FROM n WHERE a = ?')).toBe(
			'SELECT "a?b" FROM n WHERE a = $1'
		);
	});

	it('survives a doubled quote inside a literal', () => {
		expect(toDollarPlaceholders("SELECT 'it''s? fine' , ? FROM n")).toBe(
			"SELECT 'it''s? fine' , $1 FROM n"
		);
	});

	it('sends mysql the statement unchanged, because ? is already its form', async () => {
		const seen: string[] = [];
		const deps = {
			client(): PgClient {
				return {
					async connect() {},
					async query(text: string) {
						seen.push(text);
						return { rows: [], rowCount: 1 };
					},
					async end() {}
				};
			}
		};
		await backendExec(
			{
				name: 'hyperdrive',
				available: true,
				why: '',
				connectionString: 'mysql://u:p@h:3306/d',
				dialect: 'mysql'
			},
			'INSERT INTO n (a) VALUES (?)',
			[1],
			deps
		);
		expect(seen).toEqual(['INSERT INTO n (a) VALUES (?)']);

		// THE CONTROL: the same statement on postgres is rewritten
		seen.length = 0;
		await backendExec(
			{
				name: 'hyperdrive',
				available: true,
				why: '',
				connectionString: 'postgres://u:p@h:5432/d',
				dialect: 'postgres'
			},
			'INSERT INTO n (a) VALUES (?)',
			[1],
			deps
		);
		expect(seen).toEqual(['INSERT INTO n (a) VALUES ($1)']);
	});
});
