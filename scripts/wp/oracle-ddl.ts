import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { executeMysql, translationOf } from '../../src/db/sql/exec';
import { createDatabaseState, createState } from '../../src/db/sql/translate';
import { sqliteRun } from '../measure/sql-translate-run';
import type { Captured } from './oracles';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '../..');
const CONVERT_MODULE = join(ROOT, '../drangler/src/migrate/convert.ts');

/** one column as the three arms must agree on it */
export interface ColumnShape {
	name: string;
	affinity: string;
	notNull: boolean;
	default: string | null;
	collation: string;
}

/** one table as the three arms must agree on it */
export interface TableShape {
	columns: ColumnShape[];
	primaryKey: string[];
	autoIncrement: boolean;
	withoutRowid: boolean;
	/** `U(a,b)` for a unique index and `I(a,b)` for a plain one, sorted, primary key excluded */
	indexes: string[];
}

/** the SQLite type affinity of a declared type, by the rules of the SQLite documentation */
export function affinityOf(declared: string): string {
	const d = declared.toUpperCase();
	if (d.includes('INT')) return 'INTEGER';
	if (/CHAR|CLOB|TEXT/.test(d)) return 'TEXT';
	if (d === '' || d.includes('BLOB')) return 'BLOB';
	if (/REAL|FLOA|DOUB/.test(d)) return 'REAL';
	return 'NUMERIC';
}

const unquote = (v: string | null): string | null => {
	if (v === null || v.toUpperCase() === 'NULL') return null;
	const m = /^'(.*)'$/s.exec(v);
	return m === null ? v : m[1]!.replaceAll("''", "'");
};

/** the shape of every `wp_` table in a database */
export function shapeOf(db: DatabaseSync): Record<string, TableShape> {
	const result: Record<string, TableShape> = {};
	const tables = db
		.prepare(
			"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'wp\\_%' ESCAPE '\\' ORDER BY name"
		)
		.all() as { name: string; sql: string }[];
	for (const t of tables) {
		const info = db.prepare(`PRAGMA table_info("${t.name}")`).all() as {
			name: string;
			type: string;
			notnull: number;
			dflt_value: string | null;
			pk: number;
		}[];
		const columns = info.map((c) => {
			const collate = new RegExp(`[\`"]${c.name}[\`"]\\s+[^,]*?COLLATE\\s+(\\w+)`, 'i').exec(
				t.sql
			);
			return {
				name: c.name,
				affinity: affinityOf(c.type),
				notNull: c.notnull === 1 || c.pk > 0,
				default: unquote(c.dflt_value),
				collation: collate?.[1]?.toUpperCase() ?? 'BINARY'
			};
		});
		const list = db.prepare(`PRAGMA index_list("${t.name}")`).all() as {
			name: string;
			unique: number;
			origin: string;
		}[];
		const indexes = list
			.filter((i) => i.origin !== 'pk')
			.map((i) => {
				const cols = (
					db.prepare(`PRAGMA index_info("${i.name}")`).all() as { name: string }[]
				).map((c) => c.name);
				return `${i.unique === 1 ? 'U' : 'I'}(${cols.join(',')})`;
			})
			.sort();
		result[t.name] = {
			columns,
			primaryKey: info
				.filter((c) => c.pk > 0)
				.sort((a, b) => a.pk - b.pk)
				.map((c) => c.name),
			autoIncrement: /AUTOINCREMENT/i.test(t.sql),
			withoutRowid: /WITHOUT ROWID/i.test(t.sql),
			indexes
		};
	}
	return result;
}

/** what the gate replays: the two outside shapes of the install DDL, as recorded */
export interface DdlFixture {
	meta: Record<string, string>;
	converted: Record<string, TableShape>;
	upstream: Record<string, TableShape>;
	lossy: string[];
	refusals: string[];
}

/** the baked WordPress database: the chunks the pack ships, replayed into an empty database */
export function bakedDatabase(): DatabaseSync {
	const dir = join(ROOT, 'assets/wordpress/sql');
	const db = new DatabaseSync(':memory:');
	const files = readdirSync(dir)
		.filter((f) => /^\d+\.json$/.test(f))
		.sort();
	for (const f of files) {
		const chunk = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
			statements: { s: string; p: unknown[] }[];
		};
		for (const st of chunk.statements) db.prepare(st.s).run(...(st.p as never[]));
	}
	return db;
}

/** what the translator builds from the same statements, run through `executeMysql` */
export function translatedDatabase(creates: string[]): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	const run = sqliteRun(db);
	const state = createState({ db: createDatabaseState(), database: 'wp' });
	for (const sql of creates) {
		const reply = executeMysql(sql, run, state);
		if (!reply.ok) throw new Error(`translator refused ${sql.slice(0, 60)}`);
	}
	return db;
}

/** drangler's `convertDump` over the same statements, loaded into an empty database */
export async function convertedDatabase(creates: string[]): Promise<{
	db: DatabaseSync;
	lossy: string[];
	skipped: string[];
	statements: number;
}> {
	const { convertDump } = await import(CONVERT_MODULE);
	const result = convertDump(creates.map((c) => `${c};`).join('\n'), {
		from: 'mysql',
		to: 'sqlite',
		skipUnsupported: true
	});
	const db = new DatabaseSync(':memory:');
	db.exec(result.sql);
	return {
		db,
		lossy: result.lossy,
		skipped: result.skipped.map((s: { reason: string }) => s.reason),
		statements: result.statements
	};
}

/** the upstream plugin's driver over the same statements, in a SQLite file under `work` */
export function upstreamDatabase(
	upstreamSrc: string,
	creates: string[],
	work: string
): DatabaseSync {
	mkdirSync(work, { recursive: true });
	const capture = join(work, 'ddl-capture.jsonl');
	writeFileSync(
		capture,
		creates
			.map((sql, i) =>
				JSON.stringify({ scenario: 'ddl', i, thread: '0', sql } satisfies Captured)
			)
			.join('\n') + '\n'
	);
	const file = join(work, 'ddl-upstream.sqlite');
	const res = spawnSync(
		process.env.PHP ?? 'php',
		[
			join(HERE, 'oracle-upstream.php'),
			upstreamSrc,
			capture,
			file,
			join(work, 'ddl-upstream.jsonl')
		],
		{ encoding: 'utf8' }
	);
	if (res.status !== 0) throw new Error(`upstream arm exited ${res.status}: ${res.stderr}`);
	return new DatabaseSync(file);
}

/** a difference between arms: table, facet, and what each arm holds */
export interface ShapeDifference {
	table: string;
	facet: string;
	baked: string;
	converted: string;
	upstream: string;
}

/** every facet on which the three shapes disagree, in table order */
export function compareShapes(
	baked: Record<string, TableShape>,
	converted: Record<string, TableShape>,
	upstream: Record<string, TableShape>
): ShapeDifference[] {
	const out: ShapeDifference[] = [];
	const names = [
		...new Set([...Object.keys(baked), ...Object.keys(converted), ...Object.keys(upstream)])
	].sort();
	const show = (v: unknown) => (v === undefined ? 'absent' : JSON.stringify(v));
	for (const table of names) {
		const arms = [baked[table], converted[table], upstream[table]];
		const facet = (name: string, pick: (t: TableShape) => unknown) => {
			const vals = arms.map((t) => (t === undefined ? undefined : pick(t)));
			if (new Set(vals.map(show)).size > 1) {
				out.push({
					table,
					facet: name,
					baked: show(vals[0]),
					converted: show(vals[1]),
					upstream: show(vals[2])
				});
			}
		};
		facet('primary key', (t) => t.primaryKey);
		facet('autoincrement', (t) => t.autoIncrement);
		facet('without rowid', (t) => t.withoutRowid);
		facet('indexes', (t) => t.indexes);
		const cols = new Set(arms.flatMap((t) => t?.columns.map((c) => c.name) ?? []));
		for (const col of [...cols].sort()) {
			const pick = (t: TableShape) => t.columns.find((c) => c.name === col);
			for (const key of ['affinity', 'notNull', 'default', 'collation'] as const) {
				facet(`${col}.${key}`, (t) => pick(t)?.[key]);
			}
		}
	}
	return out;
}

/** the query plan of each read, one line per plan step, against one database */
export function plansOf(db: DatabaseSync, sqls: string[]): string[][] {
	return sqls.map((sql) =>
		(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail)
	);
}

/** the single-post lookup a permalink request sends, for a slug the table holds */
export const SLUG_LOOKUP =
	"SELECT wp_posts.* FROM wp_posts WHERE 1=1 AND wp_posts.post_name = 'slug-N' AND wp_posts.post_type = 'post' AND ((wp_posts.post_status = 'publish')) ORDER BY wp_posts.post_date DESC";

/** fills `wp_posts` with published posts of distinct slugs, for a plan that reads more than it needs */
export function fillPosts(db: DatabaseSync, rows: number): void {
	db.exec(
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows})
		INSERT INTO wp_posts (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, post_parent, guid, menu_order, post_type, post_mime_type, comment_count)
		SELECT 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00', '', 't' || i, '', 'publish', 'open', 'open', '', 'slug-' || i, '', '', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '', 0, 'g' || i, 0, 'post', '', 0 FROM n`
	);
}

/** the median wall time in microseconds of the slug lookup over `runs` runs, on the node:sqlite clock */
export function slugLookupMicros(db: DatabaseSync, rows: number, runs: number): number {
	const stmt = db.prepare(SLUG_LOOKUP.replace('slug-N', `slug-${Math.floor(rows / 2)}`));
	const times: number[] = [];
	for (let i = 0; i < runs; i++) {
		const t0 = performance.now();
		stmt.all();
		times.push((performance.now() - t0) * 1000);
	}
	return [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
}

/** statements `convertDump` refuses by design, which this schema does not contain */
export const REFUSAL_PROBES = [
	'ALTER TABLE wp_posts ADD COLUMN extra int',
	'CREATE TRIGGER wp_t AFTER INSERT ON wp_posts BEGIN SELECT 1; END',
	'CREATE VIEW wp_v AS SELECT ID FROM wp_posts'
];

/** the reason `convertDump` gives for each probe, or `accepted` when it converts the statement */
export async function refusalReasons(): Promise<string[]> {
	const { convertDump } = await import(CONVERT_MODULE);
	return REFUSAL_PROBES.map((sql) => {
		try {
			const r = convertDump(`${sql};`, { from: 'mysql', to: 'sqlite' });
			return r.skipped.length === 0 ? 'accepted' : `skipped: ${r.skipped[0]!.reason}`;
		} catch (e) {
			return `refused: ${(e as Error).message.slice(0, 160)}`;
		}
	});
}

const arg = (name: string, fallback?: string): string | undefined => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
};

if (import.meta.main) {
	const capturePath = arg('capture')!;
	const statements = readFileSync(capturePath, 'utf8')
		.split('\n')
		.filter((l) => l !== '')
		.map((l) => JSON.parse(l) as Captured);
	const creates = statements
		.filter((s) => s.scenario !== 'supplement' && /^\s*CREATE TABLE/i.test(s.sql))
		.map((s) => s.sql);
	const work = arg('out')!;
	const converted = await convertedDatabase(creates);
	const shapes = {
		baked: shapeOf(bakedDatabase()),
		translated: shapeOf(translatedDatabase(creates)),
		converted: shapeOf(converted.db),
		upstream: shapeOf(upstreamDatabase(arg('upstream')!, creates, work))
	};
	const differences = compareShapes(shapes.baked, shapes.converted, shapes.upstream);
	const bakedVsTranslated = compareShapes(shapes.baked, shapes.translated, shapes.translated);

	const front = statements
		.filter((s) => s.scenario === 'GET /' && /^\s*SELECT/i.test(s.sql))
		.map((s) => s.sql);
	const state = createState({ db: createDatabaseState(), database: 'wp' });
	const reads = front.flatMap((sql) => {
		const plan = translationOf(sql, state).plan;
		return plan.kind === 'read' ? [{ mysql: sql, sqlite: plan.step.sql }] : [];
	});
	const planDb = (db: DatabaseSync) =>
		plansOf(
			db,
			reads.map((r) => r.sqlite)
		);
	const bakedPlans = (() => {
		const db = bakedDatabase();
		return planDb(db);
	})();
	const convertedPlans = planDb(converted.db);
	const planDifferences = reads.flatMap((r, i) =>
		JSON.stringify(bakedPlans[i]) === JSON.stringify(convertedPlans[i])
			? []
			: [
					{
						sql: r.mysql.replace(/\s+/g, ' ').slice(0, 200),
						baked: bakedPlans[i],
						converted: convertedPlans[i]
					}
				]
	);
	const translated = translatedDatabase(creates);
	const translatedPlans = planDb(translated);
	const translatedPlanDifferences = reads.filter(
		(_, i) => JSON.stringify(bakedPlans[i]) !== JSON.stringify(translatedPlans[i])
	).length;
	const scale = Number(arg('scale', '0'));
	const scaled: Record<string, number> = {};
	if (scale > 0) {
		const arms: [string, DatabaseSync][] = [
			['baked', bakedDatabase()],
			['translated', translated],
			['converted', converted.db]
		];
		for (const [name, db] of arms) {
			fillPosts(db, scale);
			slugLookupMicros(db, scale, 20);
			scaled[name] = slugLookupMicros(db, scale, 200);
		}
	}
	const report = {
		creates: creates.length,
		translatedPlanDifferences,
		refusals: await refusalReasons(),
		scale: { rows: scale, medianMicros: scaled },
		converted: {
			statements: converted.statements,
			lossy: converted.lossy,
			skipped: converted.skipped
		},
		differences,
		bakedVsTranslated,
		reads: reads.length,
		planDifferences,
		shapes
	};
	writeFileSync(join(work, 'ddl-report.json'), JSON.stringify(report, null, 1));
	const fixturePath = arg('fixture');
	if (fixturePath !== undefined) {
		const recorded: DdlFixture = {
			meta: {
				upstream: arg('upstream-tag', 'unknown')!,
				date: new Date().toISOString().slice(0, 10)
			},
			converted: shapes.converted,
			upstream: shapes.upstream,
			lossy: converted.lossy,
			refusals: await refusalReasons()
		};
		writeFileSync(fixturePath, `${JSON.stringify(recorded, null, '\t')}\n`);
	}
	console.log(
		JSON.stringify(
			{
				creates: creates.length,
				differences: differences.length,
				bakedVsTranslated: bakedVsTranslated.length,
				reads: reads.length,
				planDifferences: planDifferences.length,
				translatedPlanDifferences,
				scaledMedianMicros: scaled,
				convertSkipped: converted.skipped.length
			},
			null,
			1
		)
	);
}
