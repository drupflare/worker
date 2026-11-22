import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readTemplates } from '../planner-stats';

/**
 * Drives the probe worker: the platform facts about `ANALYZE` and `sqlite_stat1`, and the plan and
 * rows read of every read template on a database loaded to a shape.
 *
 *   bun scripts/wp/stats-probe/run.ts facts --base=<url> --seeded=<dir> --none=<dir> --scale=<n> [--out=file]
 *   bun scripts/wp/stats-probe/run.ts arms  --base=<url> --seeded=<dir> --none=<dir> --scale=<n> [--out=file]
 *
 * `--base` is a `wrangler dev` or a deployed workers.dev origin. Every object name starts with
 * `--run`, so two runs never share a database. `--none` is a chunk directory with no statistics and
 * `--seeded` one with them.
 */

const arg = (name: string): string | undefined =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const base = (arg('base') ?? 'http://localhost:8797').replace(/\/$/, '');
const run = arg('run') ?? String(Date.now());
const scale = Number(arg('scale') ?? 1);
const none = resolve(arg('none') ?? '');
const seeded = resolve(arg('seeded') ?? '');

/** one reply per statement, in order */
type Reply = {
	rows?: unknown[][];
	rowsRead?: number;
	rowsWritten?: number;
	error?: string;
	refused?: string;
	plans?: string[];
};

async function post<T>(object: string, body: object): Promise<T> {
	const res = await fetch(`${base}/${run}-${object}`, {
		method: 'POST',
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`${object}: ${res.status} ${(await res.text()).slice(0, 300)}`);
	return (await res.json()) as T;
}

/** runs raw SQLite statements on one object */
const sql = (object: string, ...statements: string[]): Promise<Reply[]> =>
	post<Reply[]>(object, { op: 'sql', statements: statements.map((s) => ({ s })) });

/** replays a chunk directory through the object's migration */
async function migrate(object: string, dir: string): Promise<Record<string, unknown>> {
	const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
		chunks: { file: string }[];
	};
	const chunks = manifest.chunks.map((c) => JSON.parse(readFileSync(join(dir, c.file), 'utf8')));
	return post(object, { op: 'migrate', manifest, chunks });
}

const PLAN =
	"EXPLAIN QUERY PLAN SELECT ID FROM wp_posts WHERE post_name = 'post-5000' AND post_type = 'post' AND post_status = 'publish'";

/** the plan line of the permalink lookup on an object */
async function permalinkPlan(object: string): Promise<string> {
	const [r] = await sql(object, PLAN);
	return String(r?.rows?.[0]?.[3] ?? r?.error);
}

/** one statement and what the cursor reported for it */
async function step(object: string, statement: string): Promise<Record<string, unknown>> {
	const [r] = await sql(object, statement);
	const rows = r?.rows;
	return {
		sql: statement,
		rowsRead: r?.rowsRead,
		rowsWritten: r?.rowsWritten,
		...(r?.error === undefined ? {} : { error: r.error }),
		...(rows !== undefined && rows.length > 0 && rows.length <= 3 ? { rows } : {})
	};
}

/** how many statistic rows an object holds, or the error that says it has no table */
async function stat1(object: string): Promise<number | string> {
	const [r] = await sql(object, 'SELECT count(*) FROM sqlite_stat1');
	return r?.error ?? Number(r?.rows?.[0]?.[0]);
}

/** every template on one object: rows read and the plan of each read */
async function templates(
	object: string
): Promise<{ id: string; rowsRead?: number; plans?: string[]; error?: string }[]> {
	const list = readTemplates();
	const out: { id: string; rowsRead?: number; plans?: string[]; error?: string }[] = [];
	for (let i = 0; i < list.length; i += 10) {
		const part = list.slice(i, i + 10);
		const replies = await post<Reply[]>(object, { op: 'mysql', mysql: part.map((t) => t.sql) });
		part.forEach((t, k) => {
			const r = replies[k]!;
			out.push({
				id: t.id,
				rowsRead: r.rowsRead,
				plans: r.plans,
				...(r.error ? { error: r.error } : {})
			});
		});
	}
	return out;
}

/** a loaded object with no statistics, which every experiment starts from */
async function unseeded(object: string): Promise<void> {
	await migrate(object, none);
	await post(object, { op: 'load', scale });
}

async function facts(): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = { base, run, scale };

	out.seededMigration = await migrate('seeded', seeded);
	out.seeded = {
		stat1Rows: await stat1('seeded'),
		planBeforeLoad: await permalinkPlan('seeded'),
		load: await post('seeded', { op: 'load', scale }),
		planAfterLoad: await permalinkPlan('seeded')
	};
	out.seededDelete = [
		await step('seeded', "DELETE FROM sqlite_stat1 WHERE tbl = 'wp_posts'"),
		{ plan: await permalinkPlan('seeded') },
		await step('seeded', 'ANALYZE sqlite_master'),
		{ plan: await permalinkPlan('seeded') }
	];

	await unseeded('insert');
	out.directInsert = [
		{ plan: await permalinkPlan('insert'), stat1: await stat1('insert') },
		await step('insert', 'ANALYZE sqlite_master'),
		{ stat1: await stat1('insert') },
		await step(
			'insert',
			"INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('wp_posts', 'wp_posts__post_name', '20000 1')"
		),
		{ planBeforeReload: await permalinkPlan('insert') },
		await step('insert', 'ANALYZE sqlite_master'),
		{ planAfterReload: await permalinkPlan('insert') }
	];

	await unseeded('optimize');
	out.optimize = [
		{ plan: await permalinkPlan('optimize'), stat1: await stat1('optimize') },
		await step('optimize', 'PRAGMA optimize'),
		{ stat1: await stat1('optimize'), plan: await permalinkPlan('optimize') },
		await step('optimize', 'PRAGMA optimize')
	];

	await unseeded('optimize-cold');
	out.optimizeCold = [
		await step('optimize-cold', 'PRAGMA optimize'),
		{ stat1: await stat1('optimize-cold') }
	];

	await unseeded('analyze');
	out.analyze = [
		await step('analyze', 'ANALYZE'),
		{ stat1: await stat1('analyze'), plan: await permalinkPlan('analyze') },
		await step('analyze', 'ANALYZE'),
		await step('analyze', 'ANALYZE wp_posts'),
		await step('analyze', 'PRAGMA analysis_limit'),
		await step('analyze', 'PRAGMA analysis_limit = 1000')
	];
	return out;
}

async function arms(): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = { base, run, scale };
	for (const [name, dir] of [
		['none', none],
		['seeded', seeded],
		['analyzed', none]
	] as const) {
		await migrate(name, dir);
		const load = await post(name, { op: 'load', scale });
		const analyze = name === 'analyzed' ? await step(name, 'ANALYZE') : undefined;
		out[name] = {
			load,
			analyze,
			permalinkPlan: await permalinkPlan(name),
			templates: await templates(name)
		};
	}
	return out;
}

/** drops the statistics and reloads, which returns an object to the plans it had with none */
async function reset(object: string): Promise<Record<string, unknown>[]> {
	return [
		await step(object, 'DELETE FROM sqlite_stat1'),
		await step(object, 'ANALYZE sqlite_master'),
		{ plan: await permalinkPlan(object) }
	];
}

/**
 * Every fact on two objects, so a metered account loads its database twice and no more: one object
 * with no statistics that each experiment starts from and is reset to, and one migrated from the
 * seeded chunks.
 */
async function deployed(): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = { base, run, scale };
	const seededMigration = await migrate('seeded', seeded);
	out.seeded = {
		migration: seededMigration,
		stat1Rows: await stat1('seeded'),
		load: await post('seeded', { op: 'load', scale }),
		permalinkPlan: await permalinkPlan('seeded'),
		templates: await templates('seeded')
	};
	out.noneMigration = await migrate('none', none);
	out.none = {
		load: await post('none', { op: 'load', scale }),
		permalinkPlan: await permalinkPlan('none'),
		stat1Rows: await stat1('none'),
		templates: await templates('none')
	};
	out.directInsert = [
		await step('none', 'ANALYZE sqlite_master'),
		await step(
			'none',
			"INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('wp_posts', 'wp_posts__post_name', '20000 1')"
		),
		{ planBeforeReload: await permalinkPlan('none') },
		await step('none', 'ANALYZE sqlite_master'),
		{ planAfterReload: await permalinkPlan('none') }
	];
	out.reset1 = await reset('none');
	out.optimize = [
		await step('none', 'PRAGMA optimize'),
		{ stat1: await stat1('none'), plan: await permalinkPlan('none') },
		await step('none', 'PRAGMA optimize')
	];
	out.reset2 = await reset('none');
	out.analyze = [
		await step('none', 'ANALYZE'),
		{ stat1: await stat1('none'), plan: await permalinkPlan('none') },
		await step('none', 'PRAGMA analysis_limit')
	];
	out.analyzedTemplates = await templates('none');
	return out;
}

const command = process.argv[2];
const result =
	command === 'facts'
		? await facts()
		: command === 'arms'
			? await arms()
			: command === 'deployed'
				? await deployed()
				: undefined;
if (result === undefined) {
	console.error(
		'usage: run.ts facts|arms|deployed --base=<url> --seeded=<dir> --none=<dir> [--scale=<n>]'
	);
	process.exit(1);
}
const file = arg('out');
if (file !== undefined) writeFileSync(file, JSON.stringify(result, null, '\t') + '\n');
console.log(JSON.stringify(result).slice(0, 800));
