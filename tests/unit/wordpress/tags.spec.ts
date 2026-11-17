import { describe, expect, it } from 'vitest';
import {
	CONTENT_TABLES,
	TABLE_FAMILIES,
	familyOf,
	isTag,
	parseAnnouncement,
	safeReason,
	uncoveredWrites,
	writtenTables
} from '../../../src/wordpress/tags';

describe('the tag grammar', () => {
	it('takes the names the emitter makes and nothing else', () => {
		for (const tag of [
			'post:12',
			'posts:post',
			'posts',
			'term:3',
			'terms:category',
			'comments:7',
			'user:1',
			'option:blogname',
			'option:_transient_wp_core_block_css_files'
		]) {
			expect(isTag(tag), tag).toBe(true);
		}
		for (const tag of [
			'',
			'Post:1',
			'post:',
			'post:1 2',
			'post:1\n2',
			'post:a:b',
			`post:${'a'.repeat(65)}`,
			'*',
			'post:../x',
			42,
			null
		]) {
			expect(isTag(tag), String(tag)).toBe(false);
		}
	});

	it('reads the family before the colon, or the whole tag', () => {
		expect(familyOf('post:12')).toBe('post');
		expect(familyOf('posts')).toBe('posts');
		expect(familyOf('option:x')).toBe('option');
	});

	it('cuts a reason to a short log-safe string', () => {
		expect(safeReason('direct-write:evil.php')).toBe('direct-write:evil.php');
		expect(safeReason('a b\nc<d>')).toBe('a_b_c_d_');
		expect(safeReason('x'.repeat(200))).toHaveLength(48);
		expect(safeReason(undefined)).toBe('');
	});
});

describe('parseAnnouncement', () => {
	it('accepts the four operations', () => {
		expect(
			parseAnnouncement({ op: 'announce', tags: ['post:1', 'posts:post', 'post:1'] })
		).toEqual({
			op: 'announce',
			tags: ['post:1', 'posts:post']
		});
		expect(parseAnnouncement({ op: 'wholesale', reason: 'menu' })).toEqual({
			op: 'wholesale',
			reason: 'menu'
		});
		expect(parseAnnouncement({ op: 'quiet', table: 'usermeta' })).toEqual({
			op: 'quiet',
			table: 'usermeta'
		});
		expect(parseAnnouncement({ op: 'settle' })).toEqual({ op: 'settle' });
	});

	it('refuses what it cannot read, so the emitter falls back to a wholesale purge', () => {
		for (const bad of [
			null,
			'announce',
			{},
			{ op: 'purge' },
			{ op: 'announce' },
			{ op: 'announce', tags: [] },
			{ op: 'announce', tags: ['post:1', 'Bad Tag'] },
			{ op: 'announce', tags: Array.from({ length: 257 }, (_, i) => `post:${i}`) },
			{ op: 'quiet', table: 'cfw_page' }
		]) {
			expect(parseAnnouncement(bad), JSON.stringify(bad)).toBeUndefined();
		}
	});
});

describe('writtenTables', () => {
	it('names the content table each kind of write touches', () => {
		const cases: [string, string[]][] = [
			["INSERT INTO `wp_posts` (post_title) VALUES ('x')", ['posts']],
			["UPDATE wp_postmeta SET meta_value = 'x' WHERE post_id = 1", ['postmeta']],
			['DELETE FROM wp_term_relationships WHERE object_id = 1', ['term_relationships']],
			["REPLACE INTO wp_options (option_name) VALUES ('a')", ['options']],
			['INSERT IGNORE INTO wp_usermeta (user_id) VALUES (1)', ['usermeta']],
			[
				'DELETE a FROM wp_postmeta a JOIN wp_posts p ON a.post_id = p.ID',
				['posts', 'postmeta']
			]
		];
		for (const [sql, tables] of cases) {
			expect(writtenTables(sql).sort(), sql).toEqual([...tables].sort());
		}
	});

	it('reads a schema change as ddl, and a read or a plugin table as nothing', () => {
		expect(writtenTables('ALTER TABLE wp_posts ADD COLUMN x int')).toEqual(['ddl:posts']);
		expect(writtenTables('DROP TABLE wp_comments')).toEqual(['ddl:comments']);
		expect(writtenTables('SELECT * FROM wp_posts')).toEqual([]);
		expect(writtenTables('SHOW TABLES')).toEqual([]);
		expect(writtenTables('INSERT INTO wp_myplugin_log (a) VALUES (1)')).toEqual([]);
		expect(writtenTables('CREATE TABLE wp_myplugin_log (a int)')).toEqual([]);
	});

	it('does not read a table named inside a string or a comment', () => {
		expect(writtenTables("INSERT INTO wp_myplugin_log (a) VALUES ('UPDATE wp_posts')")).toEqual(
			[]
		);
		expect(writtenTables('INSERT INTO wp_myplugin_log (a) /* wp_posts */ VALUES (1)')).toEqual(
			[]
		);
	});

	it('does not read a longer table name that starts with a content table', () => {
		expect(writtenTables('INSERT INTO wp_posts_archive (a) VALUES (1)')).toEqual([]);
		expect(writtenTables('INSERT INTO wp_postmeta_x (a) VALUES (1)')).toEqual([]);
	});
});

describe('uncoveredWrites', () => {
	const none = new Set<string>();

	it('covers a write with a tag of a family its table feeds, and no other', () => {
		for (const table of CONTENT_TABLES) {
			const families = TABLE_FAMILIES[table];
			const writes = new Set([table]);
			if (families.length === 0) {
				expect(uncoveredWrites(writes, new Set(['post:1']), none, false), table).toEqual([
					table
				]);
				continue;
			}
			expect(
				uncoveredWrites(writes, new Set([`${families[0]}:1`]), none, false),
				table
			).toEqual([]);
			// a tag of a family the table does not feed covers nothing: the control
			const other = ['post', 'term', 'comments', 'user', 'option'].find(
				(f) => !families.includes(f) && !families.includes(`${f}s`)
			) as string;
			expect(uncoveredWrites(writes, new Set([`${other}:1`]), none, false), table).toEqual([
				table
			]);
		}
	});

	it('covers every write when the run went wholesale, and none when nothing was said', () => {
		const writes = new Set(['posts', 'options', 'ddl:posts', 'links']);
		expect(uncoveredWrites(writes, none, none, true)).toEqual([]);
		expect(uncoveredWrites(writes, none, none, false).sort()).toEqual(
			['ddl:posts', 'links', 'options', 'posts'].sort()
		);
	});

	it('lets a quiet mark cover its own table only, and never a schema change', () => {
		const writes = new Set(['usermeta', 'posts', 'ddl:usermeta']);
		expect(uncoveredWrites(writes, none, new Set(['usermeta']), false).sort()).toEqual([
			'ddl:usermeta',
			'posts'
		]);
	});
});
