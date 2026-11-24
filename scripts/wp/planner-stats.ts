import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';

import { executeMysql, type SqlRun } from '../../src/db/sql/exec';
import { createDatabaseState, createState } from '../../src/db/sql/translate';
import { sqliteRun } from '../measure/sql-translate-run';
import { generate, POST_MIX, SEED, SHAPE, type Existing, type Shape } from './loaded-data';

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, '../..');

/** where the distinct read statements WordPress sends are kept */
export const TEMPLATES_FILE = join(ROOT, 'tests/fixtures/wordpress/read-templates.json');

/** one `sqlite_stat1` row */
export interface StatRow {
	tbl: string;
	idx: string | null;
	stat: string;
}

/** one distinct read statement, with the scenarios that sent it */
export interface Template {
	id: string;
	scenarios: string[];
	count: number;
	sql: string;
}

/** the MySQL text with literals and list lengths removed, so statements of one shape compare equal */
export function templateKey(sql: string): string {
	return sql
		.replace(/\s+/g, ' ')
		.replace(/'(?:[^'\\]|\\.|'')*'/g, '?')
		.replace(/\b\d+\b/g, 'N')
		.replace(/(\?,? ?)+/g, '?')
		.replace(/\(N(, ?N)*\)/g, '(N..)')
		.trim();
}

/** whether a statement is a read the planner picks an index for */
export function isRead(sql: string): boolean {
	return /^\s*\(?\s*(SELECT|WITH)\b/i.test(sql) && !/^\s*SELECT\s+FOUND_ROWS\(\)/i.test(sql);
}

/** the templates the fixture holds */
export function readTemplates(): Template[] {
	return JSON.parse(readFileSync(TEMPLATES_FILE, 'utf8')) as Template[];
}

// #region the database

/** statements that create the install tables, from the capture the front page test replays */
export function installDdl(): string[] {
	const capture = JSON.parse(
		readFileSync(join(ROOT, 'tests/fixtures/wp-capture.json'), 'utf8')
	) as { setup: string[] };
	return capture.setup.filter((s) => /^\s*CREATE\s+TABLE/i.test(s));
}

/** the packed chunks of an install: its DDL through the translator, then the pack the bake cuts */
export function packInstall(out: string, statistics?: StatRow[]): string {
	const work = mkdtempSync(join(tmpdir(), 'cfw-planner-'));
	try {
		const file = join(work, 'site.sqlite');
		const db = new DatabaseSync(file);
		const run = sqliteRun(db);
		const state = createState({ db: createDatabaseState() });
		for (const ddl of installDdl()) {
			const reply = executeMysql(ddl, run, state);
			if (!reply.ok) throw new Error(`install DDL refused: ${reply.error}`);
		}
		if (statistics !== undefined) installStatistics(db, statistics);
		db.close();
		const pack = spawnSync(
			'node',
			[join(ROOT, 'scripts/pack/sql.ts'), file, out, '--cms=wordpress'],
			{
				encoding: 'utf8'
			}
		);
		if (pack.status !== 0) throw new Error(`pack-sql failed: ${pack.stderr.slice(0, 400)}`);
		return out;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** replays a chunk directory into an in-memory database, the way the migration does */
export function replayChunks(dir: string): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
		chunks: { file: string }[];
	};
	for (const meta of manifest.chunks) {
		const chunk = JSON.parse(readFileSync(join(dir, meta.file), 'utf8')) as {
			statements: { s: string; p?: unknown[] }[];
		};
		for (const st of chunk.statements) db.prepare(st.s).run(...((st.p ?? []) as never[]));
	}
	return db;
}

/** how many options exist and how many load on every request, which sets how many to add */
export function existingOptions(db: DatabaseSync): Existing {
	const count = (where: string): number =>
		Number(
			(db.prepare(`SELECT count(*) AS n FROM wp_options ${where}`).get() as { n: number }).n
		);
	return {
		options: count(''),
		autoloaded: count("WHERE autoload IN ('yes','on','auto-on','auto')")
	};
}

/** loads the generated rows into `db`; `tables` limits the load to the named tables */
export function loadInto(
	db: DatabaseSync,
	options: {
		shape?: Shape;
		seed?: number;
		scale?: number;
		tables?: string[];
		postMix?: typeof POST_MIX;
	} = {}
): Record<string, number> {
	const counts: Record<string, number> = {};
	const existing = existingOptions(db);
	db.exec('BEGIN');
	try {
		for (const batch of generate(
			options.shape ?? SHAPE,
			options.seed ?? SEED,
			options.scale ?? 1,
			existing,
			options.postMix
		)) {
			if (options.tables !== undefined && !options.tables.includes(batch.table)) continue;
			const marks = batch.columns.map(() => '?').join(',');
			const stmt = db.prepare(
				`INSERT INTO ${batch.table} (${batch.columns.join(',')}) VALUES (${marks})`
			);
			for (const row of batch.rows) stmt.run(...row);
			counts[batch.table] = (counts[batch.table] ?? 0) + batch.rows.length;
		}
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
	return counts;
}

// #endregion

// #region statistics

/** the table prefix of every WordPress table the statistics describe */
const PREFIX = 'wp_';

/**
 * Indexes whose row is left out of the seeded statistics, so the planner keeps its default for them.
 *
 * `wp_options__autoload` holds three values and 95% of the rows carry `off`, so the average of 1,500
 * rows per key describes no key a query binds. The request that loads every autoloaded option asks
 * for the rare values, and with the row the planner scans all 3,000 options where the index reads
 * 155 (measured on a Durable Object under `wrangler dev`, n=1 per arm).
 */
export const UNREPRESENTATIVE: ReadonlySet<string> = new Set(['wp_options__autoload']);

/** the `sqlite_stat1` rows of the WordPress tables, in a fixed order */
export function readStatistics(db: DatabaseSync): StatRow[] {
	const rows = db
		.prepare(
			`SELECT tbl, idx, stat FROM sqlite_stat1 WHERE tbl LIKE '${PREFIX}%' ORDER BY tbl, idx`
		)
		.all() as unknown as StatRow[];
	return rows.map((r) => ({ tbl: r.tbl, idx: r.idx, stat: r.stat }));
}

/**
 * The statistics of the model site: the schema of `schema` loaded to the shape in `loaded-data.ts`
 * with the fixed seed, then `ANALYZE`. Nothing else feeds a number into the result.
 */
export function modelStatistics(schema: DatabaseSync): StatRow[] {
	const model = new DatabaseSync(':memory:');
	const objects = schema
		.prepare(
			`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
			 ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`
		)
		.all() as { sql: string }[];
	for (const o of objects) model.exec(o.sql);
	loadInto(model);
	model.exec('ANALYZE');
	const rows = readStatistics(model).filter((r) => !UNREPRESENTATIVE.has(r.idx ?? ''));
	model.close();
	return rows;
}

/**
 * Writes the rows into `db` and reloads them into the planner. `ANALYZE sqlite_master` is the only
 * way to create `sqlite_stat1` (the name is reserved) and the only reload that costs no scan.
 */
export function installStatistics(db: DatabaseSync, rows: StatRow[]): void {
	db.exec('ANALYZE sqlite_master');
	db.exec('DELETE FROM sqlite_stat1');
	const insert = db.prepare('INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)');
	for (const r of rows) insert.run(r.tbl, r.idx, r.stat);
	db.exec('ANALYZE sqlite_master');
}

/**
 * Drops the `sqlite_stat4` table `ANALYZE` makes on a build that has it, and reloads so the samples
 * leave the planner too. The object's engine has none, so a node reading is only comparable without.
 */
export function dropStat4(db: DatabaseSync): void {
	try {
		db.exec('DROP TABLE sqlite_stat4');
		db.exec('ANALYZE sqlite_master');
	} catch {
		// an engine without stat4 never made it
	}
}

// #endregion

// #region plans

/** what one MySQL statement became in SQLite, and the plan of each read among those statements */
export interface Planned {
	sqlite: { sql: string; params: unknown[]; plan: string[] }[];
}

/** runs one MySQL statement through the translator on `db` and reads the plan of every SQLite read it sent */
export function planOf(
	db: DatabaseSync,
	mysqlSql: string,
	state = createState({ db: createDatabaseState() })
): Planned {
	const base = sqliteRun(db);
	const seen: { sql: string; params: unknown[] }[] = [];
	const run: SqlRun = (sql, ...params) => {
		if (!sql.includes('cfw_mysql_schema')) seen.push({ sql, params });
		return base(sql, ...params);
	};
	const reply = executeMysql(mysqlSql, run, state);
	if (!reply.ok) throw new Error(`refused: ${reply.error}`);
	return {
		sqlite: seen.map((s) => ({
			...s,
			plan: /^\s*(SELECT|WITH)/i.test(s.sql)
				? (
						db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...(s.params as never[])) as {
							detail: string;
						}[]
					).map((r) => r.detail)
				: []
		}))
	};
}

/** the plan lines of a template, as one string per SQLite read */
export function planLines(
	db: DatabaseSync,
	template: Template,
	state?: Parameters<typeof planOf>[2]
): string[] {
	return planOf(db, template.sql, state)
		.sqlite.filter((s) => s.plan.length > 0)
		.map((s) => s.plan.join(' | '));
}

/** the indexes a plan line names */
export function indexesIn(line: string): string[] {
	return [...line.matchAll(/USING (?:COVERING )?INDEX (\S+)/g)].map((m) => m[1]!);
}

// #endregion

// #region capture

/** the sites the sensitivity run loads, each far from the model in one direction */
const VARIANTS: { name: string; scale: number; postMix?: typeof POST_MIX }[] = [
	{ name: 'model', scale: 1 },
	{ name: 'tiny', scale: 0.01 },
	{ name: 'small', scale: 0.1 },
	{ name: 'large', scale: 5 },
	{
		name: 'revision heavy',
		scale: 1,
		postMix: [
			['revision', 'inherit', 14_000],
			['post', 'draft', 700],
			['page', 'publish', 350],
			['attachment', 'inherit', 1_000]
		]
	},
	{
		name: 'attachment heavy',
		scale: 1,
		postMix: [
			['attachment', 'inherit', 14_000],
			['revision', 'inherit', 1_000],
			['page', 'publish', 350]
		]
	},
	{
		name: 'draft heavy',
		scale: 1,
		postMix: [
			['post', 'draft', 9_000],
			['revision', 'inherit', 1_000],
			['page', 'publish', 350]
		]
	}
];

/** the scenarios the PHP supplement runs, one process each */
const SCENARIOS = ['rest-posts', 'rest-users', 'admin-posts', 'login', 'single', 'widgets'];

/** keeps one entry per template shape, in first-seen order */
function distinct(items: { scenario: string; sql: string }[]): Template[] {
	const byKey = new Map<string, Template>();
	for (const it of items) {
		if (!isRead(it.sql)) continue;
		const key = templateKey(it.sql);
		const hit = byKey.get(key);
		if (hit === undefined) {
			byKey.set(key, { id: '', scenarios: [it.scenario], count: 1, sql: it.sql });
		} else {
			hit.count++;
			if (!hit.scenarios.includes(it.scenario)) hit.scenarios.push(it.scenario);
		}
	}
	return [...byKey.values()].map((t, i) => ({ ...t, id: `r${String(i + 1).padStart(2, '0')}` }));
}

/**
 * Collects the read templates: the page routes the oracle capture fetched, then the reads of the
 * scenarios the routes do not reach, each sent by WordPress itself through the translator host.
 */
export async function captureTemplates(work: string): Promise<Template[]> {
	const { dropInMissing, prepareSite, runPhp } = await import('./harness');
	const { startHost } = await import('./host');
	const missing = dropInMissing();
	if (missing !== undefined) throw new Error(missing);
	const record = JSON.parse(
		new TextDecoder().decode(
			gunzipSync(readFileSync(join(ROOT, 'tests/fixtures/oracles/record.json.gz')))
		)
	) as { statements: { scenario: string; sql: string }[] };
	const items = record.statements
		.filter((s) => s.scenario.startsWith('GET '))
		.map((s) => ({ scenario: s.scenario, sql: s.sql }));

	mkdirSync(work, { recursive: true });
	const site = await prepareSite(join(work, 'site'), { title: 'WordPress Site' });
	site.email = 'admin@wordpress.invalid';
	const host = await startHost({ dbFile: site.db, socketPath: site.socket, keepText: true });
	try {
		const env = { CFW_LABEL: 'bake', WP_STAMP_EPOCH: '1767225600' };
		for (const script of ['bake.php', 'bake-rules.php']) {
			const run = await runPhp(site, [join(HERE, script)], env);
			if (run.code !== 0)
				throw new Error(`${script} exited ${run.code}: ${run.stderr.slice(0, 300)}`);
		}
		for (const scenario of ['setup', ...SCENARIOS]) {
			const run = await runPhp(site, [join(HERE, 'planner-capture.php')], {
				CFW_LABEL: `planner-${scenario}`,
				SCENARIO: scenario
			});
			if (run.code !== 0) {
				throw new Error(
					`planner-capture ${scenario} exited ${run.code}: ${run.stdout.slice(0, 300)}`
				);
			}
		}
	} finally {
		await host.stop();
	}
	for (const req of host.requests) {
		if (!req.label.startsWith('planner-') || req.label === 'planner-setup') continue;
		for (const s of req.statements) {
			if (s.sql !== undefined)
				items.push({ scenario: req.label.slice('planner-'.length), sql: s.sql });
		}
	}
	return distinct(items);
}

// #endregion

if (import.meta.main) {
	const arg = (name: string): string | undefined =>
		process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
	const command = process.argv[2];
	if (command === 'capture') {
		const work = resolve(arg('work') ?? mkdtempSync(join(tmpdir(), 'cfw-planner-capture-')));
		const templates = await captureTemplates(work);
		mkdirSync(resolve(TEMPLATES_FILE, '..'), { recursive: true });
		writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, '\t') + '\n');
		console.log(`${templates.length} templates written to ${TEMPLATES_FILE}`);
	} else if (command === 'stats') {
		const dir = mkdtempSync(join(tmpdir(), 'cfw-planner-stats-'));
		const db = replayChunks(packInstall(join(dir, 'sql')));
		const rows = modelStatistics(db);
		console.log(rows.map((r) => `${r.tbl}\t${r.idx ?? ''}\t${r.stat}`).join('\n'));
		rmSync(dir, { recursive: true, force: true });
	} else if (command === 'plans') {
		const dir = mkdtempSync(join(tmpdir(), 'cfw-planner-plans-'));
		const sql = join(dir, 'sql');
		const db = replayChunks(packInstall(sql));
		loadInto(db);
		const templates = readTemplates();
		const plans = (): string[][] => templates.map((t) => planLines(db, t));
		const none = plans();
		const seeded = modelStatistics(db);
		db.exec('ANALYZE');
		dropStat4(db);
		const analyzed = plans();
		installStatistics(db, seeded);
		const shipped = plans();
		const out = templates.map((t, i) => ({
			id: t.id,
			scenarios: t.scenarios.length,
			sql: t.sql.replace(/\s+/g, ' ').slice(0, 160),
			none: none[i],
			analyzed: analyzed[i],
			seeded: shipped[i]
		}));
		const file = arg('out');
		if (file !== undefined) writeFileSync(file, JSON.stringify(out, null, '\t') + '\n');
		const changed = out.filter((o) => JSON.stringify(o.none) !== JSON.stringify(o.analyzed));
		console.log(`${out.length} templates; ${changed.length} change plan with statistics`);
		rmSync(dir, { recursive: true, force: true });
	} else if (command === 'sensitivity') {
		const dir = mkdtempSync(join(tmpdir(), 'cfw-planner-sens-'));
		const sql = packInstall(join(dir, 'sql'));
		const seeded = modelStatistics(replayChunks(sql));
		const templates = readTemplates();
		const out = [];
		for (const variant of VARIANTS) {
			const db = replayChunks(sql);
			const counts = loadInto(db, { scale: variant.scale, postMix: variant.postMix });
			installStatistics(db, seeded);
			const shipped = templates.map((t) => planLines(db, t));
			db.exec('DELETE FROM sqlite_stat1');
			db.exec('ANALYZE');
			dropStat4(db);
			const own = templates.map((t) => planLines(db, t));
			const differ = templates
				.map((t, i) => ({ id: t.id, seeded: shipped[i], own: own[i] }))
				.filter((x) => JSON.stringify(x.seeded) !== JSON.stringify(x.own));
			out.push({ variant: variant.name, posts: counts['wp_posts'], differ });
			console.log(
				`${variant.name}: ${counts['wp_posts']} posts, ${differ.length} of ${templates.length} plans differ from the site's own ANALYZE`
			);
		}
		const file = arg('out');
		if (file !== undefined) writeFileSync(file, JSON.stringify(out, null, '\t') + '\n');
		rmSync(dir, { recursive: true, force: true });
	} else {
		console.error(
			'usage: planner-stats.ts capture [--work=dir] | stats | plans | sensitivity [--out=file]'
		);
		process.exit(1);
	}
}
