import { describe, expect, it } from 'vitest';
import { pageTagList } from '../../../src/do/helpers';
import { installMysqlBridge } from '../../../src/do/mysql-bridge';
import { installTagBridge, type TagBridge, type TagStats } from '../../../src/wordpress/tag-bridge';
import { CONTENT_TABLES, TABLE_FAMILIES } from '../../../src/wordpress/tags';
import { freshSite, inObject, type ServeDo } from '../../helpers/serve-do';

/**
 * `cfwWpTags` and the write observer on a real object: the host half of WordPress invalidation.
 * The PHP half is `tests/wp/tags-suite.php` in the drupflare repository.
 */

type Binary = Record<string, unknown>;
type Reply = Record<string, any>;

type Rig = {
	site: ServeDo & {
		pathsForTags(tags: string[]): string[] | undefined;
		pendingTags(): string[];
		drainPendingTags(): { tags: number; purged: number } | undefined;
		wordpressTags?: TagStats;
		lastScopedPurge?: { scoped: boolean; tags: number; purged: number };
		invalidatedTags: Set<string>;
		isReplica(): boolean;
	};
	bridge: TagBridge;
	sql(text: string): Reply;
	tags(payload: unknown): Reply;
	store(path: string, tags: string[] | null | string): void;
	pages(): { path: string; stale: boolean }[];
};

const SCHEMA = [
	'CREATE TABLE wp_posts (ID bigint(20) unsigned NOT NULL auto_increment, ' +
		"post_title text NOT NULL, post_status varchar(20) NOT NULL default 'publish', " +
		'PRIMARY KEY  (ID))',
	'CREATE TABLE wp_options (option_id bigint(20) unsigned NOT NULL auto_increment, ' +
		"option_name varchar(191) NOT NULL default '', option_value longtext NOT NULL, " +
		'PRIMARY KEY  (option_id), UNIQUE KEY option_name (option_name))',
	'CREATE TABLE wp_usermeta (umeta_id bigint(20) unsigned NOT NULL auto_increment, ' +
		"user_id bigint(20) unsigned NOT NULL default '0', meta_key varchar(255) default NULL, " +
		'meta_value longtext, PRIMARY KEY  (umeta_id))',
	'CREATE TABLE wp_links (link_id bigint(20) unsigned NOT NULL auto_increment, ' +
		"link_name varchar(255) NOT NULL default '', PRIMARY KEY  (link_id))",
	'CREATE TABLE wp_myplugin_log (id int NOT NULL auto_increment, note text, PRIMARY KEY (id))'
];

/** a WordPress (or other) object with the bridges installed and the schema made, run not begun */
async function withRig<T>(
	fn: (rig: Rig) => T | Promise<T>,
	options: { cms?: string; replica?: boolean } = {}
): Promise<T> {
	return inObject(freshSite(), async (raw) => {
		const site = raw as Rig['site'];
		site.env['CMS'] = options.cms ?? 'wordpress';
		const binary: Binary = {};
		const bridge = installTagBridge(
			site as never,
			binary as never,
			installMysqlBridge(site as never, binary as never)
		);
		const exec = (json: string) =>
			JSON.parse((binary['cfwMysqlExec'] as (j: string) => string)(json));
		const sql = (text: string): Reply => exec(JSON.stringify({ sql: text }));
		for (const ddl of SCHEMA) expect(sql(ddl).ok).toBe(true);
		site.ensureServeTables();
		if (options.replica) site.isReplica = () => true;
		const rig: Rig = {
			site,
			bridge,
			sql,
			tags: (payload) =>
				JSON.parse((binary['cfwWpTags'] as (j: string) => string)(JSON.stringify(payload))),
			store(path, tags) {
				site.sql.exec(
					'INSERT INTO cfw_page (path, status, content_type, html, rendered_at, render_ms, tags) VALUES (?, 200, ?, ?, ?, 1, ?)',
					path,
					'text/html',
					`<html>${path}</html>`,
					Date.now(),
					tags === null ? null : Array.isArray(tags) ? pageTagList(tags) : tags
				);
			},
			pages: () =>
				site.sql
					.exec('SELECT path, stale_at FROM cfw_page ORDER BY path')
					.toArray()
					.map((r) => ({ path: String(r['path']), stale: r['stale_at'] != null }))
		};
		// the schema above was a run of its own; judge it, then forget it
		bridge.endRun();
		site.wordpressTags = undefined;
		bridge.beginRun();
		return fn(rig);
	});
}

describe('an announcement purges the pages that carry its tags', () => {
	it('deletes the dependent page and keeps an unrelated one', async () => {
		const out = await withRig((rig) => {
			rig.store('/a', ['post:1', 'posts:post']);
			rig.store('/b', ['post:2']);
			rig.store('/c', ['option:blogdescription']);
			const before = rig.site.generation();
			const reply = rig.tags({ op: 'announce', tags: ['post:1'] });
			const held = rig.pages().map((p) => p.path);
			rig.tags({ op: 'settle' });
			return {
				reply,
				held,
				after: rig.pages(),
				generation: rig.site.generation() - before,
				stats: rig.site.wordpressTags,
				pending: rig.site.pendingTags(),
				scoped: rig.site.lastScopedPurge
			};
		});
		expect(out.reply).toEqual({ ok: true });
		// still stored until the run ends: the tag set is not whole before then
		expect(out.held).toEqual(['/a', '/b', '/c']);
		expect(out.after.map((p) => p.path)).toEqual(['/b', '/c']);
		expect(out.generation).toBe(1);
		expect(out.stats).toMatchObject({ announced: 1, settles: 1, floorPurges: 0 });
		expect(out.pending).toEqual([]);
		expect(out.scoped).toMatchObject({ scoped: true, tags: 1, purged: 1 });
	});

	it('moves the generation once for a run that announces many times', async () => {
		const out = await withRig((rig) => {
			const before = rig.site.generation();
			rig.tags({ op: 'announce', tags: ['post:1'] });
			rig.tags({ op: 'announce', tags: ['post:2', 'posts:post'] });
			rig.tags({ op: 'settle' });
			return rig.site.generation() - before;
		});
		expect(out).toBe(1);
	});

	it('records the tags durably at the announcement, so a run that dies still owes the purge', async () => {
		const out = await withRig((rig) => {
			rig.store('/a', ['post:1']);
			rig.store('/b', ['post:2']);
			rig.tags({ op: 'announce', tags: ['post:1'] });
			// the invocation dies here: no settle, and only the durable record survives
			const owed = rig.site.pendingTags();
			const stored = rig.pages().map((p) => p.path);
			const drained = rig.site.drainPendingTags();
			return { owed, stored, drained, after: rig.pages().map((p) => p.path) };
		});
		expect(out.owed).toEqual(['post:1']);
		expect(out.stored).toEqual(['/a', '/b']);
		expect(out.drained).toMatchObject({ tags: 1, purged: 1 });
		expect(out.after).toEqual(['/b']);
	});

	it('settles a run the interpreter never ended when the next run begins', async () => {
		const out = await withRig((rig) => {
			rig.store('/a', ['post:1']);
			rig.tags({ op: 'announce', tags: ['post:1'] });
			rig.bridge.beginRun();
			return rig.pages().map((p) => p.path);
		});
		expect(out).toEqual([]);
	});

	it('never matches a page that declared no tags, and falls to a wholesale purge instead', async () => {
		expect(pageTagList([])).toBe('[]');
		const out = await withRig((rig) => {
			rig.store('/untagged', '[]');
			rig.store('/a', ['post:1']);
			rig.store('/b', ['post:2']);
			const none = rig.site.pathsForTags(['post:1']);
			rig.tags({ op: 'announce', tags: ['post:1'] });
			rig.tags({ op: 'settle' });
			return { none, after: rig.pages(), scoped: rig.site.lastScopedPurge };
		});
		expect(out.none).toBeUndefined();
		expect(out.after).toEqual([]);
		expect(out.scoped).toMatchObject({ scoped: false });
	});

	it('refuses a request it cannot read, which makes the emitter go wholesale', async () => {
		const out = await withRig((rig) => ({
			bad: rig.tags({ op: 'announce', tags: ['Bad Tag'] }),
			empty: rig.tags({ op: 'announce', tags: [] }),
			unknown: rig.tags({ op: 'delete-everything' }),
			stats: rig.site.wordpressTags
		}));
		for (const reply of [out.bad, out.empty, out.unknown]) expect(reply.ok).toBe(false);
		expect(out.stats).toMatchObject({ refused: 3, announced: 0 });
	});
});

describe('a wholesale mark', () => {
	it('marks every stored page stale and moves the generation once per run', async () => {
		const out = await withRig((rig) => {
			rig.store('/a', ['post:1']);
			rig.store('/b', ['post:2']);
			const before = rig.site.generation();
			rig.tags({ op: 'wholesale', reason: 'menu' });
			rig.tags({ op: 'wholesale', reason: 'option:widget_meta' });
			rig.tags({ op: 'wholesale', reason: 'option:widget_pages' });
			return {
				moved: rig.site.generation() - before,
				pages: rig.pages(),
				stats: rig.site.wordpressTags
			};
		});
		expect(out.moved).toBe(1);
		expect(out.pages).toEqual([
			{ path: '/a', stale: true },
			{ path: '/b', stale: true }
		]);
		expect(out.stats).toMatchObject({
			wholesale: 3,
			lastWholesale: { reason: 'option:widget_pages' }
		});
	});
});

describe('the floor: a write nobody announced', () => {
	const post = "INSERT INTO wp_posts (post_title) VALUES ('naive')";

	it('purges wholesale and counts it', async () => {
		const out = await withRig((rig) => {
			rig.store('/a', ['post:1']);
			rig.store('/b', ['option:blogdescription']);
			const before = rig.site.generation();
			expect(rig.sql(post).ok).toBe(true);
			rig.tags({ op: 'settle' });
			return {
				moved: rig.site.generation() - before,
				pages: rig.pages(),
				stats: rig.site.wordpressTags
			};
		});
		expect(out.moved).toBe(1);
		expect(out.pages.every((p) => p.stale)).toBe(true);
		expect(out.stats).toMatchObject({ floorPurges: 1, lastFloor: { tables: ['posts'] } });
	});

	it('does not fire when a tag of the table family was announced', async () => {
		const out = await withRig((rig) => {
			rig.store('/a', ['post:1']);
			rig.store('/b', ['post:2']);
			expect(rig.sql(post).ok).toBe(true);
			rig.tags({ op: 'announce', tags: ['post:1'] });
			rig.tags({ op: 'settle' });
			return { pages: rig.pages().map((p) => p.path), stats: rig.site.wordpressTags };
		});
		expect(out.pages).toEqual(['/b']);
		expect(out.stats?.floorPurges).toBe(0);
	});

	it('fires when the tag announced is for another post than the one the write named', async () => {
		const out = await withRig((rig) => {
			rig.sql("INSERT INTO wp_posts (post_title) VALUES ('one')");
			rig.sql("INSERT INTO wp_posts (post_title) VALUES ('two')");
			rig.tags({ op: 'announce', tags: ['post:1', 'post:2'] });
			rig.tags({ op: 'settle' });
			rig.bridge.beginRun();
			expect(rig.sql("UPDATE wp_posts SET post_title = 'x' WHERE ID = 2").ok).toBe(true);
			rig.tags({ op: 'announce', tags: ['post:1'] });
			rig.tags({ op: 'settle' });
			return rig.site.wordpressTags;
		});
		expect(out?.floorPurges).toBe(1);
		expect(out?.lastFloor?.tables).toEqual(['posts']);
	});

	it('does not fire when the tag announced is the post the write named', async () => {
		const out = await withRig((rig) => {
			rig.sql("INSERT INTO wp_posts (post_title) VALUES ('one')");
			rig.sql("INSERT INTO wp_posts (post_title) VALUES ('two')");
			rig.tags({ op: 'announce', tags: ['post:1', 'post:2'] });
			rig.tags({ op: 'settle' });
			rig.bridge.beginRun();
			expect(rig.sql("UPDATE wp_posts SET post_title = 'x' WHERE ID = 2").ok).toBe(true);
			rig.tags({ op: 'announce', tags: ['post:2'] });
			rig.tags({ op: 'settle' });
			return rig.site.wordpressTags;
		});
		expect(out?.floorPurges).toBe(0);
	});

	it('keeps the family check for a write that names no post', async () => {
		const out = await withRig((rig) => {
			rig.sql("INSERT INTO wp_posts (post_title) VALUES ('one')");
			rig.tags({ op: 'announce', tags: ['post:1'] });
			rig.tags({ op: 'settle' });
			rig.bridge.beginRun();
			expect(
				rig.sql("UPDATE wp_posts SET post_title = 'x' WHERE post_title = 'one'").ok
			).toBe(true);
			rig.tags({ op: 'announce', tags: ['post:9'] });
			rig.tags({ op: 'settle' });
			return rig.site.wordpressTags;
		});
		expect(out?.floorPurges).toBe(0);
	});

	it('fires when the announced family is not the one the write feeds', async () => {
		const out = await withRig((rig) => {
			rig.store('/a', ['post:1']);
			expect(rig.sql(post).ok).toBe(true);
			rig.tags({ op: 'announce', tags: ['option:blogdescription'] });
			rig.tags({ op: 'settle' });
			return rig.site.wordpressTags;
		});
		expect(out?.floorPurges).toBe(1);
	});

	it('does not fire for a statement that failed, a read, or a plugin table', async () => {
		const out = await withRig((rig) => {
			rig.store('/a', ['post:1']);
			const failed = rig.sql('INSERT INTO wp_posts (no_such_column) VALUES (1)');
			rig.sql('SELECT * FROM wp_posts');
			rig.sql("INSERT INTO wp_myplugin_log (note) VALUES ('hit')");
			rig.tags({ op: 'settle' });
			return { failed, pages: rig.pages(), stats: rig.site.wordpressTags };
		});
		expect(out.failed.ok).toBe(false);
		expect(out.pages).toEqual([{ path: '/a', stale: false }]);
		expect(out.stats?.floorPurges).toBe(0);
	});

	it('does not fire for an update that changed no row, which MySQL reports as affecting none', async () => {
		const out = await withRig((rig) => {
			const missed = rig.sql("UPDATE wp_posts SET post_title = 'x' WHERE ID = 99");
			rig.sql("INSERT INTO wp_posts (post_title) VALUES ('kept')");
			rig.tags({ op: 'announce', tags: ['post:1'] });
			const same = rig.sql("UPDATE wp_posts SET post_title = 'kept' WHERE ID = 1");
			rig.tags({ op: 'settle' });
			return { missed, same, stats: rig.site.wordpressTags };
		});
		expect(out.missed).toMatchObject({ ok: true, kind: 'write', affected: 0 });
		expect(out.same).toMatchObject({ ok: true, kind: 'write', affected: 0 });
		expect(out.stats?.floorPurges).toBe(0);
	});

	it('fires for a schema change to a content table, even when tags were announced', async () => {
		const out = await withRig((rig) => {
			rig.tags({ op: 'announce', tags: ['post:1'] });
			expect(rig.sql('DROP TABLE wp_links').ok).toBe(true);
			rig.tags({ op: 'settle' });
			return rig.site.wordpressTags;
		});
		expect(out).toMatchObject({ floorPurges: 1, lastFloor: { tables: ['ddl:links'] } });
	});

	it('lets a quiet mark cover its table, and only its table', async () => {
		const out = await withRig((rig) => {
			rig.tags({ op: 'quiet', table: 'usermeta' });
			rig.sql("INSERT INTO wp_usermeta (user_id, meta_key) VALUES (1, 'session_tokens')");
			rig.tags({ op: 'settle' });
			const quiet = rig.site.wordpressTags?.floorPurges;
			rig.bridge.beginRun();
			rig.tags({ op: 'quiet', table: 'usermeta' });
			rig.sql(post);
			rig.tags({ op: 'settle' });
			return { quiet, after: rig.site.wordpressTags };
		});
		expect(out.quiet).toBe(0);
		expect(out.after).toMatchObject({ floorPurges: 1, lastFloor: { tables: ['posts'] } });
	});

	it('is judged once per run, and a new run starts clean', async () => {
		const out = await withRig((rig) => {
			rig.sql(post);
			rig.tags({ op: 'settle' });
			rig.tags({ op: 'settle' });
			const first = rig.site.wordpressTags?.floorPurges;
			rig.bridge.beginRun();
			rig.tags({ op: 'settle' });
			return { first, second: rig.site.wordpressTags?.floorPurges };
		});
		expect(out).toEqual({ first: 1, second: 1 });
	});

	it('judges a run the interpreter never ended when the next run begins', async () => {
		const out = await withRig((rig) => {
			rig.store('/a', ['post:1']);
			rig.sql(post);
			rig.bridge.beginRun();
			return { pages: rig.pages(), stats: rig.site.wordpressTags };
		});
		expect(out.pages).toEqual([{ path: '/a', stale: true }]);
		expect(out.stats?.floorPurges).toBe(1);
	});

	// a mutation control per mapping row: the family that covers a table is what covers it
	for (const table of CONTENT_TABLES) {
		const families = TABLE_FAMILIES[table];
		it(`${table}: ${families.length === 0 ? 'only a wholesale purge covers it' : `${families[0]} covers it`}`, async () => {
			const statement: Record<string, string> = {
				posts: post,
				options: "INSERT INTO wp_options (option_name, option_value) VALUES ('naive', '1')",
				usermeta: "INSERT INTO wp_usermeta (user_id, meta_key) VALUES (1, 'naive')",
				links: "INSERT INTO wp_links (link_name) VALUES ('naive')"
			};
			const sql = statement[table];
			// only the tables the rig made can be written; the rest are covered at unit level above
			if (sql === undefined) return;
			const covered = await withRig((rig) => {
				rig.sql(sql);
				if (families[0] !== undefined) {
					rig.tags({ op: 'announce', tags: [`${families[0]}:1`] });
				}
				rig.tags({ op: 'settle' });
				return rig.site.wordpressTags?.floorPurges;
			});
			const bare = await withRig((rig) => {
				rig.sql(sql);
				rig.tags({ op: 'settle' });
				return rig.site.wordpressTags?.floorPurges;
			});
			expect(covered).toBe(families.length === 0 ? 1 : 0);
			expect(bare).toBe(1);
		});
	}
});

describe('what the bridge leaves alone', () => {
	it('answers a Drupal object with a refusal and watches none of its writes', async () => {
		const out = await withRig(
			(rig) => {
				rig.store('/a', ['post:1']);
				const reply = rig.tags({ op: 'announce', tags: ['post:1'] });
				rig.sql("INSERT INTO wp_posts (post_title) VALUES ('x')");
				rig.tags({ op: 'settle' });
				return { reply, pages: rig.pages(), stats: rig.site.wordpressTags };
			},
			{ cms: 'drupal' }
		);
		expect(out.reply.ok).toBe(false);
		expect(out.pages).toEqual([{ path: '/a', stale: false }]);
		expect(out.stats?.floorPurges ?? 0).toBe(0);
	});

	it('lets a replica settle and refuses its announcements', async () => {
		const out = await withRig(
			(rig) => ({
				announce: rig.tags({ op: 'announce', tags: ['post:1'] }),
				wholesale: rig.tags({ op: 'wholesale', reason: 'menu' }),
				settle: rig.tags({ op: 'settle' })
			}),
			{ replica: true }
		);
		expect(out.announce.ok).toBe(false);
		expect(out.wholesale.ok).toBe(false);
		expect(out.settle.ok).toBe(true);
	});

	it('does not change a statement reply', async () => {
		const out = await withRig((rig) => ({
			insert: rig.sql("INSERT INTO wp_posts (post_title) VALUES ('x')"),
			read: rig.sql('SELECT ID, post_title FROM wp_posts')
		}));
		expect(out.insert).toMatchObject({ ok: true, kind: 'write', affected: 1, insertId: 1 });
		expect(out.read).toMatchObject({ ok: true, kind: 'rows', rows: [[1, 'x']] });
	});
});
