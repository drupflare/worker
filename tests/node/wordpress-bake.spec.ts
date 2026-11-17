import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
	bake,
	findHits,
	PLACEHOLDER_ORIGIN,
	scrubStatements,
	STAMP,
	UNUSABLE_PASSWORD
} from '../../scripts/bake-wordpress';
import { dropInMissing, WORDPRESS_SRC } from '../../scripts/wp/harness';

/**
 * What the bake does to a database WordPress's installer produced: it stamps one time into every
 * row that carries the install clock, makes the administrator's password unusable, and refuses to
 * ship a secret. Two bakes then cut the same chunks.
 *
 * The pure half runs on an in-memory database and is part of the gate. The reproducibility half
 * runs the installer twice and needs the fetched tree, the drop-in and a PHP CLI; it skips by name
 * when one is absent.
 */

const temps: string[] = [];
afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const SCHEMA = `
CREATE TABLE wp_posts (ID INTEGER PRIMARY KEY, post_date TEXT, post_date_gmt TEXT, post_modified TEXT, post_modified_gmt TEXT, post_content TEXT, guid TEXT);
CREATE TABLE wp_comments (comment_ID INTEGER PRIMARY KEY, comment_date TEXT, comment_date_gmt TEXT);
CREATE TABLE wp_users (ID INTEGER PRIMARY KEY, user_registered TEXT, user_pass TEXT, user_activation_key TEXT);
CREATE TABLE wp_options (option_id INTEGER PRIMARY KEY, option_name TEXT, option_value TEXT);
CREATE TABLE cfw_mysql_schema (name TEXT, ddl TEXT);`;

function installed(): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	db.exec(SCHEMA);
	db.exec(
		`INSERT INTO wp_posts VALUES (1, '2026-11-17 09:01:02', '2026-11-17 09:01:02', '2026-11-17 09:05:00', '2026-11-17 09:05:00', 'see ${PLACEHOLDER_ORIGIN}/about', '${PLACEHOLDER_ORIGIN}/?p=1')`
	);
	db.exec(`INSERT INTO wp_comments VALUES (1, '2026-11-17 09:01:03', '2026-11-17 09:01:03')`);
	db.exec(
		`INSERT INTO wp_users VALUES (1, '2026-11-17 09:01:00', '$wp$2y$10$secretsecretsecret', 'key')`
	);
	db.exec(
		`INSERT INTO wp_options VALUES (1, 'admin_email_lifespan', '1810444291'), (2, 'blogname', 'x'), (3, 'siteurl', '${PLACEHOLDER_ORIGIN}')`
	);
	db.exec(`INSERT INTO cfw_mysql_schema VALUES ('wp_options', 'mentions ${PLACEHOLDER_ORIGIN}')`);
	return db;
}

describe('the scrub the bake applies', () => {
	it('stamps every install-clock column to one time and leaves the rest alone', () => {
		const db = installed();
		for (const sql of scrubStatements()) db.exec(sql);
		const post = db.prepare('SELECT * FROM wp_posts').get() as Record<string, string>;
		for (const column of ['post_date', 'post_date_gmt', 'post_modified', 'post_modified_gmt']) {
			expect(post[column]).toBe(STAMP.text);
		}
		expect(post['post_content']).toContain('/about');
		const comment = db.prepare('SELECT * FROM wp_comments').get() as Record<string, string>;
		expect([comment['comment_date'], comment['comment_date_gmt']]).toEqual([
			STAMP.text,
			STAMP.text
		]);
		const lifespan = db
			.prepare(
				"SELECT option_value FROM wp_options WHERE option_name = 'admin_email_lifespan'"
			)
			.get() as { option_value: string };
		expect(Number(lifespan.option_value)).toBeGreaterThan(STAMP.epoch);
		expect(lifespan.option_value).toBe(String(STAMP.epoch + 6 * 30 * 86_400));
		expect(
			(
				db
					.prepare("SELECT option_value FROM wp_options WHERE option_name = 'blogname'")
					.get() as {
					option_value: string;
				}
			).option_value
		).toBe('x');
	});

	it('makes the administrator password unusable and clears the activation key', () => {
		const db = installed();
		for (const sql of scrubStatements()) db.exec(sql);
		const user = db.prepare('SELECT * FROM wp_users').get() as Record<string, string>;
		expect(user['user_pass']).toBe(UNUSABLE_PASSWORD);
		expect(user['user_activation_key']).toBe('');
		expect(user['user_pass']).not.toMatch(/^\$/);
	});

	it('drops transients, which hold the time and a path hash of the bake', () => {
		const db = installed();
		db.exec(
			`INSERT INTO wp_options VALUES (4, '_site_transient_timeout_wp_theme_files_patterns-ab12', '1794906855'), (5, '_transient_wp_core_block_css_files', 'a:0:{}'), (6, 'my_transient_flag', '1')`
		);
		for (const sql of scrubStatements()) db.exec(sql);
		const names = (
			db.prepare('SELECT option_name FROM wp_options ORDER BY option_id').all() as {
				option_name: string;
			}[]
		).map((r) => r.option_name);
		expect(names).toEqual(['admin_email_lifespan', 'blogname', 'siteurl', 'my_transient_flag']);
	});

	it('honours a table prefix', () => {
		const db = new DatabaseSync(':memory:');
		db.exec(SCHEMA.replace(/wp_/g, 'site_'));
		db.exec("INSERT INTO site_users VALUES (1, 'x', 'hash', 'k')");
		for (const sql of scrubStatements('site_')) db.exec(sql);
		expect(
			(db.prepare('SELECT user_pass FROM site_users').get() as { user_pass: string })
				.user_pass
		).toBe(UNUSABLE_PASSWORD);
	});

	it('is a control: without the statements the install clock and the hash survive', () => {
		const db = installed();
		expect(
			(db.prepare('SELECT user_pass FROM wp_users').get() as { user_pass: string }).user_pass
		).toMatch(/^\$wp/);
		expect(
			(db.prepare('SELECT post_date FROM wp_posts').get() as { post_date: string }).post_date
		).not.toBe(STAMP.text);
	});
});

describe('the scan for a string in the baked database', () => {
	it('names every table and column that holds it, with a row count', () => {
		const db = installed();
		expect(findHits(db, PLACEHOLDER_ORIGIN)).toEqual([
			{ table: 'wp_posts', column: 'post_content', rows: 1 },
			{ table: 'wp_posts', column: 'guid', rows: 1 },
			{ table: 'wp_options', column: 'option_value', rows: 1 }
		]);
	});

	it('skips the translator catalogue, whose text is DDL and never content', () => {
		const db = installed();
		expect(findHits(db, PLACEHOLDER_ORIGIN).some((h) => h.table === 'cfw_mysql_schema')).toBe(
			false
		);
	});

	it('finds a secret planted in any text column, which is what fails a bake', () => {
		const db = installed();
		db.exec(
			"UPDATE wp_options SET option_value = 'abc-planted-secret-xyz' WHERE option_id = 2"
		);
		expect(findHits(db, 'planted-secret')).toEqual([
			{ table: 'wp_options', column: 'option_value', rows: 1 }
		]);
		expect(findHits(db, 'a string nothing holds')).toEqual([]);
	});
});

const reason = ((): string | undefined => {
	if (!existsSync(join(WORDPRESS_SRC, 'wp-load.php'))) {
		return `${WORDPRESS_SRC} is not fetched (bun run fetch:wordpress)`;
	}
	return dropInMissing();
})();

if (reason !== undefined) {
	it.skip(`two bakes cut the same chunks (skipped: ${reason})`, () => {});
}

describe.skipIf(reason !== undefined)('two bakes of the installer', () => {
	const readChunks = (dir: string): Record<string, string> =>
		Object.fromEntries(
			readdirSync(dir)
				.filter((f) => f !== 'manifest.json')
				.sort()
				.map((f) => [f, readFileSync(join(dir, f), 'utf8')])
		);

	it('cut identical chunks and the same generation, and ship no origin-free secret', async () => {
		const first = mkdtempSync(join(tmpdir(), 'wp-bake-a-'));
		const second = mkdtempSync(join(tmpdir(), 'wp-bake-b-'));
		temps.push(first, second);
		const a = await bake(first, join(first, 'sql'));
		const b = await bake(second, join(second, 'sql'));
		const chunksA = readChunks(a.sql!);
		expect(Object.keys(chunksA).length).toBeGreaterThan(0);
		expect(chunksA).toEqual(readChunks(b.sql!));
		const generation = (dir: string): string =>
			(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { generation: string })
				.generation;
		expect(generation(a.sql!)).toBe(generation(b.sql!));
		const names = (
			JSON.parse(readFileSync(join(a.sql!, 'manifest.json'), 'utf8')) as {
				creates: string[];
			}
		).creates;
		expect(names).toContain('cfw_mysql_schema');
		expect(names.filter((n) => n.startsWith('wp_')).length).toBe(12);
		// the origin is the one declared placeholder, in the rows the provisioning step does not own
		expect(a.hits.map((h) => `${h.table}.${h.column}`).sort()).toEqual([
			'wp_options.option_value',
			'wp_posts.guid',
			'wp_posts.post_content',
			'wp_users.user_url'
		]);
	}, 60_000);

	it('stores the rewrite rules of the category, tag and post format archives', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wp-bake-r-'));
		temps.push(dir);
		const baked = await bake(dir, undefined);
		const db = new DatabaseSync(baked.db);
		const option = (name: string): string =>
			(
				db
					.prepare('SELECT option_value FROM wp_options WHERE option_name = ?')
					.get(name) as { option_value: string }
			).option_value;
		const rules = option('rewrite_rules');
		const cron = option('cron');
		db.close();
		for (const query of ['category_name=', 'tag=', 'post_format=', 'author_name=']) {
			expect(rules).toContain(`index.php?${query}`);
		}
		expect(cron.match(/i:\d{10};a:/g)).toEqual([`i:${STAMP.epoch};a:`]);
	}, 60_000);

	it('is a control: two installs that were not stamped would differ in a chunk', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wp-bake-c-'));
		temps.push(dir);
		const baked = await bake(dir, join(dir, 'sql'));
		const db = new DatabaseSync(baked.db);
		const date = (
			db.prepare('SELECT post_date FROM wp_posts LIMIT 1').get() as { post_date: string }
		).post_date;
		expect(date).toBe(STAMP.text);
		expect(date).not.toBe(new Date().toISOString().slice(0, 19).replace('T', ' '));
		db.close();
	}, 60_000);
});
