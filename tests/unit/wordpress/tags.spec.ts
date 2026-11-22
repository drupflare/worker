import { describe, expect, it } from 'vitest';
import {
	CONTENT_TABLES,
	TABLE_FAMILIES,
	familyOf,
	isTag,
	noteWrittenRows,
	parseAnnouncement,
	safeReason,
	uncoveredWrites,
	writtenRows,
	writtenTables,
	type WrittenRows
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

	it('covers a write that named its posts only with a tag for each of them', () => {
		const writes = new Set(['posts', 'postmeta']);
		const rows = new Map<string, Set<number> | null>([
			['posts', new Set([5])],
			['postmeta', new Set([5, 6])]
		]);
		expect(uncoveredWrites(writes, new Set(['post:5', 'post:6']), none, false, rows)).toEqual(
			[]
		);
		// the family check alone would have covered both: the control
		expect(uncoveredWrites(writes, new Set(['post:3']), none, false)).toEqual([]);
		expect(uncoveredWrites(writes, new Set(['post:3']), none, false, rows).sort()).toEqual([
			'postmeta',
			'posts'
		]);
		expect(uncoveredWrites(writes, new Set(['post:5']), none, false, rows)).toEqual([
			'postmeta'
		]);
		// a listing tag is not a post tag
		expect(uncoveredWrites(writes, new Set(['posts']), none, false, rows).sort()).toEqual([
			'postmeta',
			'posts'
		]);
	});

	it('falls back to the family check for a table with a write that named no rows', () => {
		const writes = new Set(['posts']);
		const unnamed = new Map<string, Set<number> | null>([['posts', null]]);
		expect(uncoveredWrites(writes, new Set(['post:3']), none, false, unnamed)).toEqual([]);
		expect(uncoveredWrites(writes, none, none, false, unnamed)).toEqual(['posts']);
		expect(uncoveredWrites(writes, new Set(['post:3']), none, false, new Map())).toEqual([]);
	});

	it('still lets a quiet mark and a wholesale purge cover a write that named its posts', () => {
		const writes = new Set(['posts']);
		const rows = new Map<string, Set<number> | null>([['posts', new Set([5])]]);
		expect(uncoveredWrites(writes, none, new Set(['posts']), false, rows)).toEqual([]);
		expect(uncoveredWrites(writes, none, none, true, rows)).toEqual([]);
	});
});

describe('writtenRows', () => {
	const none = {};
	const named = (sql: string, reply: { insertId?: number; affected?: number } = none) =>
		writtenRows(sql, reply);

	it('names the post an update or a delete is keyed on', () => {
		const cases: [string, { table: string; ids: number[] }][] = [
			[
				"UPDATE `wp_posts` SET `post_title` = 'x' WHERE `ID` = 5",
				{ table: 'posts', ids: [5] }
			],
			['DELETE FROM `wp_posts` WHERE `ID` = 7', { table: 'posts', ids: [7] }],
			[
				"UPDATE wp_posts SET post_status = 'trash' WHERE ID IN (3, 4,5)",
				{ table: 'posts', ids: [3, 4, 5] }
			],
			[
				"UPDATE wp_postmeta SET meta_value = 'x' WHERE post_id = 9 AND meta_key = '_edit_lock'",
				{ table: 'postmeta', ids: [9] }
			],
			[
				'DELETE FROM wp_postmeta WHERE post_id = 9 AND meta_key = x ORDER BY meta_id LIMIT 1',
				{ table: 'postmeta', ids: [9] }
			],
			[
				"UPDATE wp_posts SET menu_order = 2 WHERE post_status = 'publish' AND ID = 8",
				{ table: 'posts', ids: [8] }
			],
			["UPDATE wp_posts SET a = 'b' WHERE wp_posts.ID = 11;", { table: 'posts', ids: [11] }]
		];
		for (const [sql, want] of cases) expect(named(sql), sql).toEqual(want);
	});

	it('takes the id of a single-row insert from the reply', () => {
		expect(
			named("INSERT INTO wp_posts (post_title) VALUES ('x')", { insertId: 12, affected: 1 })
		).toEqual({ table: 'posts', ids: [12] });
		expect(
			named("INSERT INTO wp_posts (post_title) VALUES ('x'), ('y')", {
				insertId: 12,
				affected: 2
			})
		).toBeUndefined();
		expect(
			named("INSERT INTO wp_posts (post_title) VALUES ('x')", { affected: 1 })
		).toBeUndefined();
		expect(
			named("INSERT INTO wp_posts (ID) VALUES (3) ON DUPLICATE KEY UPDATE post_title = 'x'", {
				insertId: 3,
				affected: 1
			})
		).toBeUndefined();
		expect(
			named("INSERT INTO wp_postmeta (post_id, meta_key) VALUES (3, 'a')", {
				insertId: 1,
				affected: 1
			})
		).toBeUndefined();
	});

	it('names nothing it could misread', () => {
		for (const sql of [
			"UPDATE wp_posts SET a = 'b' WHERE ID = 5 OR post_parent = 5",
			"UPDATE wp_posts SET a = 'b' WHERE post_parent = 5",
			"UPDATE wp_posts SET a = 'b' WHERE (ID = 5)",
			"UPDATE wp_posts SET a = 'b' WHERE ID > 5",
			"UPDATE wp_posts SET a = 'b' WHERE ID BETWEEN 5 AND 9",
			"UPDATE wp_posts SET a = 'b' WHERE ID IN (SELECT ID FROM wp_posts)",
			"UPDATE wp_posts SET a = 'b' WHERE ID IN (1, 2) OR ID = 3",
			'UPDATE wp_posts SET a = NOW() WHERE ID = 5',
			"UPDATE wp_posts SET a = 'b'",
			'DELETE FROM wp_posts',
			'DELETE FROM wp_postmeta WHERE meta_id = 4',
			"UPDATE wp_posts p JOIN wp_postmeta m ON m.post_id = p.ID SET p.a = 'b' WHERE p.ID = 5",
			'DELETE a FROM wp_postmeta a JOIN wp_posts p ON a.post_id = p.ID WHERE p.ID = 5',
			'UPDATE wp_posts SET a = 1 WHERE ID = 0',
			"UPDATE wp_options SET option_value = 'x' WHERE option_id = 5",
			"UPDATE wp_comments SET comment_approved = '1' WHERE comment_ID = 5",
			"UPDATE wp_myplugin_log SET note = 'x' WHERE ID = 5",
			"UPDATE wp_posts SET a = '' WHERE ID = 5 AND b = 'WHERE ID = 6' OR c = 1",
			'SELECT * FROM wp_posts WHERE ID = 5'
		]) {
			expect(named(sql), sql).toBeUndefined();
		}
	});

	it('does not read an id out of a string or a comment', () => {
		expect(
			named("UPDATE wp_posts SET a = 'x WHERE ID = 9' WHERE post_parent = 4")
		).toBeUndefined();
		expect(
			named('UPDATE wp_posts SET a = 1 /* WHERE ID = 9 */ WHERE post_parent = 4')
		).toBeUndefined();
	});

	it('refuses more ids than it will list, rather than listing some', () => {
		const many = Array.from({ length: 101 }, (_, i) => i + 1).join(',');
		expect(named(`DELETE FROM wp_posts WHERE ID IN (${many})`)).toBeUndefined();
		expect(
			named(`DELETE FROM wp_posts WHERE ID IN (${many.split(',').slice(0, 100).join(',')})`)
				?.ids
		).toHaveLength(100);
	});
});

describe('noteWrittenRows', () => {
	it('collects ids per table and lets one unnamed write send the table back to the family check', () => {
		const rows: WrittenRows = new Map();
		noteWrittenRows(rows, ['posts'], { table: 'posts', ids: [1] });
		noteWrittenRows(rows, ['posts'], { table: 'posts', ids: [2] });
		expect([...(rows.get('posts') ?? [])]).toEqual([1, 2]);
		noteWrittenRows(rows, ['posts', 'terms'], undefined);
		expect(rows.get('posts')).toBeNull();
		expect(rows.get('terms')).toBeNull();
		// once unnamed, a later named write does not bring the ids back
		noteWrittenRows(rows, ['posts'], { table: 'posts', ids: [3] });
		expect(rows.get('posts')).toBeNull();
	});

	it('marks a table the statement touched but did not name as unnamed', () => {
		const rows: WrittenRows = new Map();
		noteWrittenRows(rows, ['posts', 'postmeta'], { table: 'posts', ids: [1] });
		expect(rows.get('postmeta')).toBeNull();
		expect([...(rows.get('posts') ?? [])]).toEqual([1]);
	});
});
