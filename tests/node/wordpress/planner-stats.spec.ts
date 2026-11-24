import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	dropStat4,
	indexesIn,
	installStatistics,
	loadInto,
	modelStatistics,
	packInstall,
	planLines,
	readStatistics,
	readTemplates,
	replayChunks,
	UNREPRESENTATIVE,
	type StatRow,
	type Template
} from '../../../scripts/wp/planner-stats';
import { SqlMigrator, type SqlLike } from '../../../src/db/dump/migrate';

/**
 * A baked WordPress database ships no `sqlite_stat1`, so on a loaded site the planner guesses. These
 * specs load the model site (20,000 posts and the rest of `loaded-data.ts`) into the pack the bake
 * cuts and read what the planner does with and without the statistics the bake seeds.
 *
 * Rows read come from a Durable Object's own meter and are in the planner-stats results; node has
 * no such meter, so the bound asserted here is derived from the plan: an index search on a key reads
 * the entries of that key and their rows.
 */

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SHIPPED = resolve(import.meta.dirname, '../../../assets/wordpress/sql');

const PERMALINK =
	"SELECT ID FROM wp_posts WHERE post_name = 'post-5000' AND post_type = 'post' AND post_status = 'publish'";

const named = (templates: Template[], id: string): Template => {
	const t = templates.find((x) => x.id === id);
	if (t === undefined) throw new Error(`no template ${id}`);
	return t;
};

/** a `SqlLike` over node:sqlite with the transaction the migration needs */
function migrationTarget(db: DatabaseSync): {
	sql: SqlLike;
	storage: { transactionSync<T>(cb: () => T): T };
} {
	return {
		sql: {
			exec(text, ...params) {
				const st = db.prepare(text);
				if (st.columns().length > 0) {
					const rows = st.all(...(params as never[])) as Record<string, unknown>[];
					return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
				}
				const r = st.run(...(params as never[]));
				return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) };
			}
		},
		storage: {
			transactionSync<T>(cb: () => T): T {
				db.exec('BEGIN');
				try {
					const out = cb();
					db.exec('COMMIT');
					return out;
				} catch (e) {
					db.exec('ROLLBACK');
					throw e;
				}
			}
		}
	};
}

describe('the planner on a 20,000 post site', () => {
	let dir: string;
	let bare: DatabaseSync;
	let seeded: DatabaseSync;
	let rows: StatRow[];
	const templates = readTemplates();

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'wp-planner-'));
		dirs.push(dir);
		const chunks = packInstall(join(dir, 'sql'));
		bare = replayChunks(chunks);
		loadInto(bare);
		rows = modelStatistics(replayChunks(chunks));
		seeded = replayChunks(chunks);
		loadInto(seeded);
		installStatistics(seeded, rows);
	}, 60_000);

	it('control: with no statistics the permalink lookup scans the published posts by type', () => {
		const [line] = planLines(bare, { id: 'p', scenarios: [], count: 1, sql: PERMALINK });
		expect(indexesIn(line!)).toEqual(['wp_posts__type_status_date']);
	});

	it('plans the permalink lookup on post_name and reads only the rows of that name', () => {
		const [line] = planLines(seeded, { id: 'p', scenarios: [], count: 1, sql: PERMALINK });
		expect(indexesIn(line!)).toEqual(['wp_posts__post_name']);
		const matches = Number(
			(
				seeded
					.prepare("SELECT count(*) AS n FROM wp_posts WHERE post_name = 'post-5000'")
					.get() as { n: number }
			).n
		);
		// an index entry and a table row per match
		expect(matches * 2).toBeLessThanOrEqual(4);
	});

	it('plans the date and name permalink and the category archive without reading every post', () => {
		const date = planLines(seeded, named(templates, 'r68'));
		expect(indexesIn(date.join(' '))).toContain('wp_posts__post_name');
		const category = planLines(seeded, named(templates, 'r30'));
		expect(category.join(' ')).toMatch(/SEARCH wp_term_relationships USING INDEX/);
		expect(category.join(' ')).not.toMatch(/SEARCH wp_posts USING (COVERING )?INDEX/);
	});

	it('keeps every template that searched an index without statistics off a full scan', () => {
		const scans = (db: DatabaseSync, t: Template): number =>
			planLines(db, t).filter((l) => /SCAN wp_(posts|options|comments|postmeta)\b/.test(l))
				.length;
		const worse = templates.filter((t) => scans(seeded, t) > scans(bare, t)).map((t) => t.id);
		expect(worse).toEqual([]);
	});

	it('keeps the autoloaded options read on its index, which a full ANALYZE would scan', () => {
		const r01 = named(templates, 'r01');
		expect(planLines(seeded, r01).join(' ')).toContain('wp_options__autoload');
		const analyzed = replayChunks(join(dir, 'sql'));
		loadInto(analyzed, { tables: ['wp_options'] });
		analyzed.exec('ANALYZE');
		dropStat4(analyzed);
		expect(planLines(analyzed, r01).join(' ')).toMatch(/SCAN wp_options/);
	});
});

describe('the seeded statistics', () => {
	let dir: string;
	let chunks: string;
	let rows: StatRow[];

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'wp-planner-rows-'));
		dirs.push(dir);
		chunks = packInstall(join(dir, 'sql'));
		rows = modelStatistics(replayChunks(chunks));
	}, 60_000);

	it('come from the script and are the same on every run', () => {
		expect(modelStatistics(replayChunks(chunks))).toEqual(rows);
		expect(rows).toContainEqual({
			tbl: 'wp_posts',
			idx: 'wp_posts__post_name',
			stat: '20000 1'
		});
	});

	it.skipIf(!existsSync(join(SHIPPED, 'manifest.json')))(
		'are the rows the shipped pack carries',
		() => {
			expect(readStatistics(replayChunks(SHIPPED))).toEqual(rows);
		}
	);

	it('name only tables and indexes the install creates, and leave out the unrepresentative ones', () => {
		const schema = replayChunks(chunks);
		const indexes = new Set(
			(
				schema.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
					name: string;
				}[]
			).map((r) => r.name)
		);
		for (const r of rows) {
			expect(r.idx === null || indexes.has(r.idx), `${r.tbl} ${r.idx}`).toBe(true);
			expect(UNREPRESENTATIVE.has(r.idx ?? '')).toBe(false);
		}
		expect(rows.length).toBeGreaterThan(20);
	});

	it('travel in the pack and arrive in sqlite_stat1 through the migration replay', async () => {
		const out = join(dir, 'with-stats');
		packInstall(out, rows);
		const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
			notes: { statisticRows?: number };
			chunks: { file: string }[];
		};
		expect(manifest.notes.statisticRows).toBe(rows.length);
		const db = new DatabaseSync(':memory:');
		const target = migrationTarget(db);
		const migrator = new SqlMigrator({
			...target,
			loadManifest: async () => JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')),
			loadChunk: async (file) => JSON.parse(readFileSync(join(out, file), 'utf8'))
		});
		const done = await migrator.runAll();
		expect(done.done).toBe(true);
		expect(readStatistics(db)).toEqual(rows);
		loadInto(db, { tables: ['wp_posts'] });
		const [line] = planLines(db, { id: 'p', scenarios: [], count: 1, sql: PERMALINK });
		expect(indexesIn(line!)).toEqual(['wp_posts__post_name']);
	});

	it('are not in a pack of any other CMS', () => {
		const plain = new DatabaseSync(join(dir, 'drupalish.sqlite'));
		plain.exec(
			'CREATE TABLE config (collection TEXT, name TEXT, data BLOB); CREATE TABLE t (a INTEGER, b TEXT); CREATE INDEX t_b ON t (b)'
		);
		plain.exec("INSERT INTO t VALUES (1, 'x'), (2, 'y')");
		plain.exec('ANALYZE');
		plain.close();
		const out = join(dir, 'drupalish');
		const run = spawnSync(
			'node',
			[
				resolve(import.meta.dirname, '../../../scripts/pack/sql.ts'),
				join(dir, 'drupalish.sqlite'),
				out
			],
			{
				encoding: 'utf8'
			}
		);
		expect(run.status, run.stderr).toBe(0);
		const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
			notes: Record<string, unknown>;
		};
		expect(manifest.notes).not.toHaveProperty('statisticRows');
		expect(existsSync(join(out, '0000.json'))).toBe(true);
		expect(readFileSync(join(out, '0000.json'), 'utf8')).not.toContain('sqlite_stat1');
	});
});
