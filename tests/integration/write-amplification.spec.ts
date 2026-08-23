import { describe, expect, it } from 'vitest';
import type { ChargeSplit } from '../../src/db/write-tally';
import { writeWorkload, type WriteWorkload } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What a WRITE costs on the meter that binds the free-tier regeneration ceiling.
 *
 * P29, reframed. The original item asked whether dropping `AUTOINCREMENT` reduces rows per page
 * FILL; `autoincrement.spec.ts` measured no and the item was closed on it. That answer is correct
 * and it settles one workload out of a dozen. Rows written is charged on every write a site makes,
 * and 14 of the shipped schema's 17 `AUTOINCREMENT` tables are content-entity tables that only a
 * CONTENT write touches -- `node`, `node_revision`, `path_alias`, `file_managed`, `users` among
 * them; the other three are `menu_tree`, `watchdog` and `sequences`. None of the 14 appears in a
 * fill, so none of them had ever been priced. RULE 0c: the measurement closed a MECHANISM and left
 * the RESOURCE open.
 *
 * WHAT IS DELIBERATELY NOT HERE: milliseconds. RULE 0 -- an absolute CPU figure comes only from
 * `cpuTime` on a deployed worker, and every in-isolate clock is frozen out there. Every column below
 * is a COUNT, and a count is the same number locally and on the edge. Two full runs produced
 * byte-identical JSON, which is the determinism a count is supposed to have.
 *
 * THREE MULTIPLIERS STACK, and separating them is the whole point of the per-table split:
 *
 *   1. **index maintenance** -- one charged row per non-partial index per stored row.
 *      `chargeFactorsFromSchema()` reads it off THIS object's schema with `PRAGMA index_list`.
 *   2. **the `sqlite_sequence` rewrite** -- one more charged row on every AUTOINCREMENT insert,
 *      measured in `autoincrement.spec.ts` and folded into the factor above.
 *   3. **speculative replay** -- the one nobody had counted. `Connection::predictBufferedInsertId()`
 *      refuses an AUTOINCREMENT table, because its next id comes from `sqlite_sequence` rather than
 *      from `max(rowid) + 1`, so an entity save inside a transaction replays the buffer through the
 *      host to learn the id it just assigned, and every buffered write is charged AGAIN. The replay
 *      covers the buffer as it stood, so an early statement is re-executed more often than a late
 *      one -- `node` is charged 9 executions in a node create and `node_field_revision` 2.
 *
 * THE READINGS, 2026-08-23, packed site, warm interpreter, n=2 identical:
 *
 * | operation           | charged | stmts | stored | 1st pass | exec  | txn | spec | replayed |
 * | ------------------- | ------- | ----- | ------ | -------- | ----- | --- | ---- | -------- |
 * | node create         |     118 |    30 |      5 |       27 | 4.37x |   7 |    6 |       22 |
 * | node edit, revision |     229 |    73 |      3 |       11 |   n/a |  11 |   10 |       60 |
 * | user create         |      36 |    14 |      2 |       10 | 3.60x |   5 |    4 |       10 |
 * | file record create  |      21 |     5 |      1 |        7 | 3.00x |   3 |    2 |        3 |
 * | url alias create    |      58 |    15 |      3 |       13 | 4.46x |   5 |    4 |       10 |
 * | A/B AUTOINCREMENT   |       4 |     2 |      1 |        2 | 2.00x |   2 |    1 |        1 |
 * | A/B plain rowid     |       1 |     1 |      1 |        1 | 1.00x |   1 |    0 |        0 |
 *
 * So a node create stores 5 rows and is charged 118: **23.6x**, which factors as 5.4x schema times
 * 4.37x re-execution. A node edit costs 229 because it rewrites the default-language data as well as
 * writing the revision, and its `node_revision` insert alone is executed 10 times.
 *
 * THE DIVISOR IS MEASURED, NOT ASSUMED. `executionFactor` divides charged rows by
 * `COUNT(*) delta x charge factor`, and both halves are read off the database either side of the
 * operation. "A subtraction is only as good as its subtrahend" -- assuming a node create stores one
 * `node` row would have been right, and assuming it for `node_field_data` on a REVISION would not.
 * A table the operation only UPDATEs stores nothing, so it reports `null` rather than a ratio, which
 * is why the revision row above has no whole-operation factor.
 *
 * EVERY OPERATION RUNS TWICE AND THE SECOND IS PRICED. The first save of each kind pays for entity
 * field definitions, the schema repair, and the one coalesced `bumpGeneration('cachetags')` the
 * whole fixture gets; charging those to the operation would price a cold cache as a node save.
 *
 * THE ENTITY API RATHER THAN A FORM. A form submission also writes the session, the form cache and
 * flood control, so its total is the operation PLUS the wrapper, and neither number stands in for
 * the other. What is isolated here is the entity write, which is what the per-table split and the
 * AUTOINCREMENT audit are about.
 *
 * WHAT THIS DOES NOT MEASURE, stated rather than implied: how much of a real save's re-execution the
 * KEYWORD owns. `speculate()` has three call sites -- an insert id that cannot be predicted, a row
 * count that is not a single-row insert, and a read that has to see buffered writes -- and only the
 * first is the keyword's. A dirty read replays the whole buffer and memoises every pending id with
 * it, so an entity save that reads back what it wrote would pay some of this anyway. The A/B pair is
 * the controlled experiment that names the mechanism and bounds it from below at one replay per
 * unresolved buffered insert; sizing the win on a real save needs a build with the keyword removed,
 * and that build does not exist. So 4.37x is what the replay machinery COSTS TODAY, not a prediction
 * of what dropping AUTOINCREMENT would return.
 */

type Payload = Record<string, unknown>;
const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Amp-Pass-4419';

/** the `/__writes` report, as far as this spec reads it */
type WritesReport = {
	statements: number;
	rowsWritten: number;
	ranked: { table: string; rows: number; statements: number; share: number }[];
	indexSplit: { rows: ChargeSplit[]; dataRows: number; indexRows: number; indexShare: number };
};

/** one table's share of one operation, with every multiplier separated */
type TableCost = {
	table: string;
	chargedRows: number;
	statements: number;
	/** charged rows one stored row costs on this object's schema */
	chargePerRow: number;
	/** `COUNT(*)` either side of the operation, so the divisor below is measured */
	storedRows: number;
	/** charged rows divided by one execution of what was stored; null when nothing was stored */
	executionFactor: number | null;
};

/** one semantic operation, priced on every meter this spec reads */
type Priced = {
	label: string;
	rowsWritten: number;
	statements: number;
	/** rows the operation actually persisted, summed over the tables it wrote */
	storedRows: number;
	/** charged rows a single execution of those stored rows would have cost */
	firstPassRows: number;
	/** charged rows landing on a table `writeTargetTable()` could not name */
	unattributed: number;
	tables: TableCost[];
	driver: { statements: number; transactions: number; speculative: number; replayed: number };
	id: number;
};

const call = (site: ServeDo, path: string, init?: RequestInit) =>
	site
		.fetch(new Request(`https://do.local${path}`, init))
		.then((r) => r.json() as Promise<Payload>);

/** every user table's row count, so a stored-row delta needs no assumption about the statements */
function countAll(site: ServeDo): Record<string, number> {
	const tables = site.sql
		.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
		.toArray()
		.map((r) => String(r['name']));
	const counts: Record<string, number> = {};
	for (const table of tables) {
		if (!/^[A-Za-z0-9_]+$/.test(table)) continue;
		counts[table] = Number(
			site.sql.exec(`SELECT COUNT(*) AS c FROM "${table}"`).toArray()[0]?.['c'] ?? 0
		);
	}
	return counts;
}

/** arms the tally, runs one thing, and reads back both meters either side of it */
async function priced(site: ServeDo, label: string, run: () => Promise<Payload>): Promise<Priced> {
	const before = countAll(site);
	await call(site, '/__writes?op=on');
	const result = await run();
	const report = (await call(site, '/__writes')) as unknown as WritesReport;
	await call(site, '/__writes?op=off');
	const after = countAll(site);
	if (result['ok'] !== true) {
		throw new Error(`${label} failed: ${String(result['error'] ?? JSON.stringify(result))}`);
	}

	const split = new Map(report.indexSplit.rows.map((r) => [r.table, r]));
	const tables: TableCost[] = report.ranked
		.filter((r) => r.rows > 0 && r.table !== '?unattributed')
		.map((r) => {
			const chargePerRow = split.get(r.table)?.chargePerRow ?? 0;
			const storedRows = (after[r.table] ?? 0) - (before[r.table] ?? 0);
			const firstPass = storedRows * chargePerRow;
			return {
				table: r.table,
				chargedRows: r.rows,
				statements: r.statements,
				chargePerRow,
				storedRows,
				executionFactor: firstPass > 0 ? r.rows / firstPass : null
			};
		})
		.sort((a, b) => b.chargedRows - a.chargedRows);

	const driver = (result['driver'] ?? {}) as Record<string, number>;
	return {
		label,
		rowsWritten: report.rowsWritten,
		statements: report.statements,
		storedRows: tables.reduce((n, t) => n + Math.max(0, t.storedRows), 0),
		firstPassRows: tables.reduce((n, t) => n + Math.max(0, t.storedRows) * t.chargePerRow, 0),
		unattributed: report.ranked.find((r) => r.table === '?unattributed')?.rows ?? 0,
		tables,
		driver: {
			statements: Number(driver['statements'] ?? -1),
			transactions: Number(driver['transactions'] ?? -1),
			speculative: Number(driver['speculative'] ?? -1),
			replayed: Number(driver['replayed'] ?? -1)
		},
		id: Number(result['id'] ?? 0)
	};
}

const workload = (site: ServeDo, op: WriteWorkload, seq: number, nid = 0) =>
	site.runJson(writeWorkload(op, { seq, nid })) as Promise<Payload>;

/** a run for its side effects; a failed warmup would leave the priced run measuring a throw */
async function warm(site: ServeDo, op: WriteWorkload, seq: number, nid = 0): Promise<Payload> {
	const out = await workload(site, op, seq, nid);
	if (out['ok'] !== true) {
		throw new Error(`${op} warmup failed: ${String(out['error'] ?? JSON.stringify(out))}`);
	}
	return out;
}

async function measure(): Promise<Record<string, Priced>> {
	return inObject(freshSite(), async (site: ServeDo) => {
		await call(site, '/__migrate?all=1&prefill=0');
		await call(site, '/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass: PASS, siteName: 'Amplification' }),
			headers: { 'content-type': 'application/json' }
		});

		// the A/B pair, created from the host so no DDL lands inside a priced run
		site.sql.exec(
			'CREATE TABLE IF NOT EXISTS amp_txn_auto (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)'
		);
		site.sql.exec('CREATE TABLE IF NOT EXISTS amp_txn_rowid (id INTEGER PRIMARY KEY, v TEXT)');

		// #region warm: one of each, so a priced run pays for the operation and not for a cold cache
		const first = await warm(site, 'node-create', 1);
		const warmNid = Number(first['id'] ?? 0);
		await warm(site, 'node-revision', 2, warmNid);
		await warm(site, 'user-create', 1);
		await warm(site, 'file-create', 1);
		await warm(site, 'alias-create', 1, warmNid);
		await warm(site, 'txn-autoinc', 1);
		await warm(site, 'txn-rowid', 1);
		// #endregion

		const out: Record<string, Priced> = {};
		out['node-create'] = await priced(site, 'node-create', () =>
			workload(site, 'node-create', 11)
		);
		const nid = out['node-create'].id;
		out['node-revision'] = await priced(site, 'node-revision', () =>
			workload(site, 'node-revision', 12, nid)
		);
		out['user-create'] = await priced(site, 'user-create', () =>
			workload(site, 'user-create', 11)
		);
		out['file-create'] = await priced(site, 'file-create', () =>
			workload(site, 'file-create', 11)
		);
		out['alias-create'] = await priced(site, 'alias-create', () =>
			workload(site, 'alias-create', 11, nid)
		);
		out['txn-autoinc'] = await priced(site, 'txn-autoinc', () =>
			workload(site, 'txn-autoinc', 11)
		);
		out['txn-rowid'] = await priced(site, 'txn-rowid', () => workload(site, 'txn-rowid', 11));
		return out;
	});
}

let cached: Promise<Record<string, Priced>> | null = null;
/** one fixture for the whole file: a migrate plus fourteen writes is not worth repeating per case */
const measured = () => (cached ??= measure());

/** the five real operations; the two `txn-` rows are the controlled A/B behind them */
const ENTITY_OPS = [
	'node-create',
	'node-revision',
	'user-create',
	'file-create',
	'alias-create'
] as const;

const by = (ops: Record<string, Priced>, label: string): Priced => {
	const hit = ops[label];
	if (!hit) throw new Error(`no row for ${label}`);
	return hit;
};

describe('write amplification per semantic operation', () => {
	it(
		'prices every content write, and attributes every charged row to a table',
		async () => {
			const ops = await measured();
			for (const name of ENTITY_OPS) {
				const op = by(ops, name);
				expect(op.id, `${name} wrote no entity`).toBeGreaterThan(0);
				expect(op.rowsWritten, name).toBeGreaterThan(0);
				expect(op.storedRows, `${name} persisted nothing`).toBeGreaterThan(0);
				// an unattributed share means `writeTargetTable()` is missing a form, and every
				// factor below would then be dividing a total the breakdown does not cover
				expect(op.unattributed, `${name} has unattributed rows`).toBe(0);
			}
		},
		REQUEST_TIMEOUT
	);

	it(
		'shows the content path is charged an order of magnitude over what it stores',
		async () => {
			const ops = await measured();
			for (const name of ENTITY_OPS) {
				const op = by(ops, name);
				// measured 18x to 23.6x; the floor is set well under that so a schema change moves
				// the number without failing the gate, and a REGRESSION to no amplification would
				// mean the instrument stopped seeing half the writes
				expect(op.rowsWritten / op.storedRows, name).toBeGreaterThan(10);
			}
		},
		REQUEST_TIMEOUT
	);

	it(
		'separates the two multipliers: index maintenance, then re-execution',
		async () => {
			const ops = await measured();
			for (const name of ENTITY_OPS) {
				const op = by(ops, name);
				// the schema half: one stored row costs several charged rows before anything runs
				// twice, so index maintenance is the majority of even a single pass
				expect(op.firstPassRows / op.storedRows, `${name} schema factor`).toBeGreaterThan(
					2
				);
				// the execution half: what the meter billed exceeds one pass over what was stored
				expect(op.rowsWritten, `${name} re-execution`).toBeGreaterThan(op.firstPassRows);
			}
		},
		REQUEST_TIMEOUT
	);

	it(
		'names the AUTOINCREMENT content tables in the operations that write them',
		async () => {
			const ops = await measured();
			const tablesOf = (label: string) => by(ops, label).tables.map((t) => t.table);
			// the audit's claim is that every AUTOINCREMENT table in the shipped schema is on the
			// content path rather than the fill path; this is that claim measured rather than quoted
			expect(tablesOf('node-create')).toEqual(
				expect.arrayContaining(['node', 'node_revision'])
			);
			expect(tablesOf('node-revision')).toEqual(expect.arrayContaining(['node_revision']));
			expect(tablesOf('user-create')).toEqual(expect.arrayContaining(['users']));
			expect(tablesOf('file-create')).toEqual(expect.arrayContaining(['file_managed']));
			expect(tablesOf('alias-create')).toEqual(
				expect.arrayContaining(['path_alias', 'path_alias_revision'])
			);
		},
		REQUEST_TIMEOUT
	);

	it(
		'shows an EDIT costs more than a CREATE, because it rewrites the default data too',
		async () => {
			const ops = await measured();
			// a new revision inserts into `node_revision` and `node_field_revision` AND updates
			// `node` and `node_field_data`, so a site that edits is charged more than one that only
			// publishes -- which is the opposite of what a "one write per node" model would say
			expect(by(ops, 'node-revision').rowsWritten).toBeGreaterThan(
				by(ops, 'node-create').rowsWritten
			);
		},
		REQUEST_TIMEOUT
	);
});

describe('the A/B: what AUTOINCREMENT costs a buffered insert whose id is read back', () => {
	it(
		'charges the AUTOINCREMENT table more rows for the same single insert',
		async () => {
			const ops = await measured();
			const auto = by(ops, 'txn-autoinc');
			const rowid = by(ops, 'txn-rowid');
			// both tables are `(id INTEGER PRIMARY KEY[ AUTOINCREMENT], v TEXT)` with no other
			// index, both get one insert inside one Drupal transaction, and both read the id back.
			// The keyword is the only difference, so the gap is the keyword
			expect(rowid.storedRows).toBe(1);
			expect(auto.storedRows).toBe(1);
			expect(rowid.rowsWritten).toBe(1);
			expect(auto.rowsWritten).toBeGreaterThan(rowid.rowsWritten);
		},
		REQUEST_TIMEOUT
	);

	it(
		'is the reason the driver cannot predict the id, so it replays the buffer',
		async () => {
			const ops = await measured();
			const auto = by(ops, 'txn-autoinc');
			const rowid = by(ops, 'txn-rowid');
			// THE MECHANISM, measured rather than read off the docblock. `predictBufferedInsertId()`
			// answers `max(rowid) + offset` for an ordinary rowid table and refuses an AUTOINCREMENT
			// one, whose next id lives in `sqlite_sequence`. The refusal is a speculative replay,
			// which is a second host transaction and a second execution of every buffered write
			expect(rowid.driver.speculative).toBe(0);
			expect(rowid.driver.replayed).toBe(0);
			expect(auto.driver.speculative).toBeGreaterThan(0);
			expect(auto.driver.replayed).toBeGreaterThan(0);
			expect(auto.driver.transactions).toBeGreaterThan(rowid.driver.transactions);
		},
		REQUEST_TIMEOUT
	);

	it(
		'runs a replay on every real entity save, which is where the 4x comes from',
		async () => {
			const ops = await measured();
			for (const name of ENTITY_OPS) {
				const op = by(ops, name);
				// every one of these saves into an AUTOINCREMENT table and reads the id back, so
				// every one pays the refusal; a save that did not would report 0 here
				expect(op.driver.speculative, `${name} speculative replays`).toBeGreaterThan(0);
				expect(op.driver.replayed, `${name} replayed statements`).toBeGreaterThan(0);
			}
		},
		REQUEST_TIMEOUT
	);
});

/**
 * When an id can actually come back, which is what every per-table verdict turns on.
 *
 * SQLite gives an ordinary rowid table `max(rowid) + 1`, so dropping the keyword does NOT make ids
 * generally reusable -- it makes them reusable only when the row holding the MAXIMUM id is deleted,
 * or when the table is emptied. `autoincrement.spec.ts` measures the first case on a one-row table,
 * where every row is also the maximum. The second case here is the one the audit needs and nothing
 * measured: deleting from the middle frees nothing.
 */
describe('rowid reuse, which decides the audit table by table', () => {
	it('reuses an id only when the row holding the maximum is deleted', async () => {
		const out = await inObject(freshSite(), (site: ServeDo) => {
			const next = (table: string) => {
				site.sql.exec(`INSERT INTO ${table} (v) VALUES ('x')`);
				return Number(
					site.sql.exec(`SELECT MAX(id) AS id FROM ${table}`).toArray()[0]?.['id'] ?? 0
				);
			};
			site.sql.exec('CREATE TABLE reuse_top (id INTEGER PRIMARY KEY, v TEXT)');
			site.sql.exec('CREATE TABLE reuse_mid (id INTEGER PRIMARY KEY, v TEXT)');
			for (let i = 0; i < 5; i++) {
				next('reuse_top');
				next('reuse_mid');
			}
			site.sql.exec('DELETE FROM reuse_top WHERE id = 5');
			site.sql.exec('DELETE FROM reuse_mid WHERE id = 3');
			return { top: next('reuse_top'), mid: next('reuse_mid') };
		});
		// the highest id was freed and comes straight back
		expect(out.top).toBe(5);
		// the middle one did not: the next id is still max + 1, so a gap stays a gap
		expect(out.mid).toBe(6);
	});

	it('restarts at 1 when the table is emptied, which is the other way an id returns', async () => {
		const out = await inObject(freshSite(), (site: ServeDo) => {
			site.sql.exec('CREATE TABLE reuse_clear (id INTEGER PRIMARY KEY, v TEXT)');
			for (let i = 0; i < 5; i++) site.sql.exec("INSERT INTO reuse_clear (v) VALUES ('x')");
			site.sql.exec('DELETE FROM reuse_clear');
			site.sql.exec("INSERT INTO reuse_clear (v) VALUES ('y')");
			return Number(
				site.sql.exec('SELECT MAX(id) AS id FROM reuse_clear').toArray()[0]?.['id'] ?? 0
			);
		});
		// this is what makes `watchdog` safe and `file_managed` not: dblog's own cron deletes the
		// OLDEST rows and its only truncate empties the table, whereas temporary-file GC deletes
		// the newest
		expect(out).toBe(1);
	});
});
