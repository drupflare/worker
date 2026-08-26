/**
 * What dropping `AUTOINCREMENT` costs a real entity save, against a control that keeps it.
 *
 * `bun scripts/measure/autoinc-arm.ts --endpoint=<url> --repeat=5`, or `--dry` for the plan.
 * the keyword lives in DDL text, so `/sql` rewrites it live and no rebuilt binary is needed;
 * two arms are two objects, so charged rows are exact and any CPU delta is only a bound
 */

/** the tables whose keyword is stripped in the plain arm; every one is on the content path */
export const STRIPPED = ['node', 'node_revision', 'path_alias', 'file_managed', 'users'] as const;

/** the same CREATE TABLE minus the keyword; null when it never had one, so a no-op is loud */
export function stripAutoincrement(ddl: string): string | null {
	if (!/\bAUTOINCREMENT\b/i.test(ddl)) return null;
	return ddl.replace(/\s+AUTOINCREMENT\b/gi, '');
}

/** the DDL that rebuilds one table under a temporary name, in the order a rebuild has to run */
export function rebuildStatements(
	table: string,
	ddl: string,
	indexes: readonly string[]
): string[] | null {
	const stripped = stripAutoincrement(ddl);
	if (stripped === null) return null;
	const tmp = `${table}__noauto`;
	// the table name is the first quoted position; SQLite carries the rest through RENAME
	const asTmp = stripped.replace(
		new RegExp(`^CREATE\\s+TABLE\\s+["'\`\\[]?${table}["'\`\\]]?`, 'i'),
		`CREATE TABLE "${tmp}"`
	);
	return [
		asTmp,
		`INSERT INTO "${tmp}" SELECT * FROM "${table}"`,
		`DROP TABLE "${table}"`,
		`ALTER TABLE "${tmp}" RENAME TO "${table}"`,
		...indexes
	];
}

/** the rebuild that puts the keyword BACK, so one object can be measured in both states */
export function restoreStatements(
	table: string,
	ddl: string,
	indexes: readonly string[]
): string[] | null {
	if (/\bAUTOINCREMENT\b/i.test(ddl)) return null;
	const withKeyword = ddl.replace(/(INTEGER\s+PRIMARY\s+KEY)/i, '$1 AUTOINCREMENT');
	if (withKeyword === ddl) return null;
	const tmp = `${table}__auto`;
	const asTmp = withKeyword.replace(
		new RegExp(`^CREATE\\s+TABLE\\s+["'\`\\[]?${table}["'\`\\]]?`, 'i'),
		`CREATE TABLE "${tmp}"`
	);
	return [
		asTmp,
		`INSERT INTO "${tmp}" SELECT * FROM "${table}"`,
		`DROP TABLE "${table}"`,
		`ALTER TABLE "${tmp}" RENAME TO "${table}"`,
		...indexes
	];
}

/** one arm's reading of one operation */
export type ArmReading = {
	arm: string;
	op: string;
	rowsWritten: number;
	statements: number;
	overheadShare: number;
	ranked: { table: string; rows: number; statements: number }[];
	driver: { transactions: number; speculative: number; txnStatements: number };
	tag: string;
};

/** charged rows with the keyword over charged rows without it */
export function keywordCost(auto: number, plain: number): number {
	if (plain <= 0) return 0;
	return auto / plain;
}

const arg = (name: string, fallback = '') =>
	process.argv
		.find((a: string) => a.startsWith(`--${name}=`))
		?.split('=')
		.slice(1)
		.join('=') ?? fallback;

/** every op `/writeworkload` accepts; the two `txn-` cases are the synthetic control */
export const OPS = [
	'node-create',
	'node-revision',
	'user-create',
	'file-create',
	'alias-create',
	'txn-autoinc',
	'txn-rowid'
] as const;

if (import.meta.main) {
	const dry = process.argv.includes('--dry');
	const endpoint = arg('endpoint').replace(/\/+$/, '');
	const site = arg('site', 'autoinc');
	const repeat = Number(arg('repeat', '5'));

	if (dry) {
		console.log(`plan: ${OPS.length} ops x ${repeat} repeats x 2 arms, ONE object (${site})`);
		console.log(`  arm A: keyword intact`);
		console.log(`  arm B: keyword stripped from ${STRIPPED.join(', ')}`);
		console.log('\nthe two `txn-` ops are never stripped, so they are the invariant control');
		process.exit(0);
	}
	if (endpoint === '') throw new Error('--endpoint is required (or pass --dry)');

	const json = async (path: string): Promise<any> => {
		const res = await fetch(`${endpoint}${path}`);
		const text = await res.text();
		try {
			return JSON.parse(text);
		} catch {
			return { ok: false, status: res.status, body: text.slice(0, 200) };
		}
	};
	const sql = (q: string) => json(`/sql?site=${site}&q=${encodeURIComponent(q)}`);
	const m = await json(`/migrate?site=${site}&all=1&prefill=1`);
	console.log(`${site}: migrate ok=${m.ok} rows=${m.rowsWritten} bytes=${m.databaseSize}`);
	await json(`/firstrun?site=${site}`);
	// the synthetic pair, created from the host so no DDL lands inside a priced run
	await sql(
		'CREATE TABLE IF NOT EXISTS amp_txn_auto (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)'
	);
	await sql('CREATE TABLE IF NOT EXISTS amp_txn_rowid (id INTEGER PRIMARY KEY, v TEXT)');

	let seq = 1;
	let nid = 0;
	const priced = async (op: string): Promise<any> => {
		seq++;
		await json(`/writes?site=${site}&op=on`);
		const w = await json(`/writeworkload?site=${site}&op=${op}&seq=${seq}&nid=${nid}`);
		const report = await json(`/writes?site=${site}`);
		await json(`/writes?site=${site}&op=off`);
		return { w, report };
	};

	type Row = { arm: string; op: string; rows: number[]; stmts: number[]; spec: number[] };
	const rows: Row[] = [];

	const runArm = async (arm: string) => {
		const from = new Date().toISOString();
		for (const op of OPS) {
			// one unpriced run first: the first of each kind pays for field definitions and DDL
			const warm = await json(`/writeworkload?site=${site}&op=${op}&seq=${++seq}&nid=${nid}`);
			if (op === 'node-create' && Number(warm?.id ?? 0) > 0) nid = Number(warm.id);
			const row: Row = { arm, op, rows: [], stmts: [], spec: [] };
			for (let i = 0; i < repeat; i++) {
				const { w, report } = await priced(op);
				if (w?.ok !== true) {
					console.warn(
						`  ${arm} ${op} -> ${String(w?.error ?? JSON.stringify(w)).slice(0, 90)}`
					);
					break;
				}
				row.rows.push(Number(report?.rowsWritten ?? 0));
				row.stmts.push(Number(report?.statements ?? 0));
				row.spec.push(Number(w?.speculativeReplays ?? -1));
			}
			rows.push(row);
			console.log(`  ${arm} ${op}: rows ${row.rows.join(',')}`);
		}
		const to = new Date().toISOString();
		const bytes = Number((await json(`/migrate?site=${site}`))?.databaseSize ?? 0);
		return { from, to, bytes };
	};

	console.log('\narm A, keyword intact');
	const armA = await runArm('A');

	console.log('\nstripping the keyword from the five content tables on the SAME object');
	for (const table of STRIPPED) {
		const ddl = await sql(
			`SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}'`
		);
		const idx = await sql(
			`SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='${table}' AND sql IS NOT NULL`
		);
		const statements = rebuildStatements(
			table,
			String(ddl?.rows?.[0]?.sql ?? ''),
			(idx?.rows ?? []).map((r: any) => String(r.sql))
		);
		if (statements === null) {
			console.warn(`  ${table}: no AUTOINCREMENT in the shipped DDL, skipped`);
			continue;
		}
		for (const stmt of statements) {
			const out = await sql(stmt);
			if (out?.ok !== true)
				throw new Error(`${table}: ${stmt.slice(0, 60)} -> ${out?.error}`);
		}
		console.log(`  ${table}: rebuilt, ${(idx?.rows ?? []).length} indexes restored`);
	}
	const left = await sql(
		"SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND sql LIKE '%AUTOINCREMENT%'"
	);
	console.log(`  ${left?.rows?.[0]?.n} tables still declare the keyword`);

	console.log('\narm B, keyword stripped');
	const armB = await runArm('B');

	const median = (v: number[]) =>
		v.length === 0 ? 0 : ([...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0);
	const spread = (v: number[]) => (v.length ? `${Math.min(...v)}-${Math.max(...v)}` : '-');

	console.log(
		'\n| op | A rows | A spread | B rows | B spread | keyword cost | A spec | B spec | n |'
	);
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const op of OPS) {
		const a = rows.find((r) => r.arm === 'A' && r.op === op);
		const b = rows.find((r) => r.arm === 'B' && r.op === op);
		if (!a || !b) continue;
		const ma = median(a.rows);
		const mb = median(b.rows);
		console.log(
			`| ${op} | ${ma} | ${spread(a.rows)} | ${mb} | ${spread(b.rows)} | ` +
				`${keywordCost(ma, mb).toFixed(2)}x | ${median(a.spec)} | ${median(b.spec)} | ${a.rows.length} |`
		);
	}
	console.log(`\nbytes: arm A ${armA.bytes}, arm B ${armB.bytes}`);
	console.log(`arm A window ${armA.from} .. ${armA.to}`);
	console.log(`arm B window ${armB.from} .. ${armB.to}`);
	console.log(`object name for durableObjectsPeriodicGroups: ${site}`);
}
