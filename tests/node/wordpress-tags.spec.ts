import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropInMissing, WORDPRESS_SRC } from '../../scripts/wp/harness';
import {
	MU_DIR,
	PAGE_PATHS,
	purged,
	renderPage,
	rowsFor,
	runScenario,
	startTagSite,
	summarise,
	type PageTags,
	type ScenarioResult,
	type TagSite
} from '../../scripts/wp/tags';

/**
 * Real WordPress on the local harness (PHP from PATH, the translator over node:sqlite) with the
 * host plugin installed: which tags each page carries, which tags each editorial write announces,
 * what a naive plugin does to both, and what the host's floor would judge.
 *
 * It installs WordPress, which takes several seconds, so it is not gate sized. It skips by name
 * when the fetched tree, the drop-in or the host plugin is absent.
 */

const missing = (): string | undefined => {
	if (!existsSync(join(WORDPRESS_SRC, 'wp-load.php'))) return `${WORDPRESS_SRC} is missing`;
	if (!existsSync(join(MU_DIR, 'drupflare-host/tags.php'))) return `${MU_DIR} has no tags.php`;
	return dropInMissing();
};
const skip = missing();
if (skip !== undefined) console.warn(`(skipped: wordpress tags, ${skip})`);

const PLUGIN_PAGE = '/?p=1&plugin_setting=1';
const PATHS = [...PAGE_PATHS, PLUGIN_PAGE];

describe.skipIf(skip !== undefined)('wordpress cache tags on a real site', () => {
	let t: TagSite;
	const pages: Record<string, PageTags> = {};
	const stored: Record<string, string[]> = {};
	const runs: Record<string, ScenarioResult> = {};

	beforeAll(async () => {
		t = await startTagSite();
		// the first render of a fresh site writes its own bookkeeping options; the second is the page
		for (const path of PATHS) {
			await renderPage(t, path);
			pages[path] = await renderPage(t, path);
			if (pages[path]!.untaggable === null) stored[path] = pages[path]!.tags;
		}
	}, 240_000);

	afterAll(async () => {
		await t?.stop();
		if (t !== undefined) rmSync(t.site.dir, { recursive: true, force: true });
	});

	it('names the tags of every page it would store, and leaves none untaggable', () => {
		for (const path of PATHS) {
			expect(
				pages[path]!.untaggable,
				`${path}: ${pages[path]!.reasons.join(', ')}`
			).toBeNull();
			expect(pages[path]!.tags.length, path).toBeGreaterThan(0);
		}
	});

	it('tags a single post with itself, its comments and its author, and a listing with its type', () => {
		const single = pages['/?p=1']!.tags;
		expect(single).toEqual(expect.arrayContaining(['post:1', 'comments:1', 'user:1']));
		expect(pages['/?feed=rss2']!.tags).toEqual(
			expect.arrayContaining(['post:1', 'posts:post'])
		);
		expect(pages['/?s=hello']!.tags).toContain('posts:post');
		expect(pages['/?cat=1']!.tags).toEqual(
			expect.arrayContaining(['term:1', 'terms:category'])
		);
		expect(pages['/?author=1']!.tags).toContain('users');
		expect(pages['/?rest_route=/wp/v2/posts']!.tags).toContain('posts:post');
	});

	it('makes a page for a post that does not exist depend on the listing, so a new post reaches it', () => {
		expect(pages['/?p=999']!.status).toBe(404);
		expect(pages['/?p=999']!.tags).toContain('posts:post');
	});

	it('carries the options a page read, and none that are structural or quiet', () => {
		const tags = pages[PLUGIN_PAGE]!.tags;
		expect(tags).toContain('option:my_plugin_setting');
		for (const path of PATHS) {
			expect(pages[path]!.tags, path).not.toContain('option:cron');
			expect(pages[path]!.tags, path).not.toContain('option:blogname');
			expect(pages[path]!.tags, path).not.toContain('option:siteurl');
		}
	});

	it('marks a page untaggable when a plugin reads a content table or a table of its own', async () => {
		const direct = await renderPage(t, '/?p=1&naive=1');
		expect(direct.untaggable).toBe('direct-read:zz-tags-naive.php');
		expect(direct.tags).toEqual([]);
		const custom = await renderPage(t, '/?p=1&naive_table=1');
		expect(custom.untaggable).toBe('custom-table:wp_naive_votes');
		const clean = await renderPage(t, '/?p=1');
		expect(clean.untaggable).toBeNull();
	});

	it('marks a page that wrote, and says wholesale for a plugin that wrote a content table', async () => {
		const wrote = await renderPage(t, '/?p=1&naive_write=1');
		expect(wrote.untaggable).toBe('request-wrote');
		const ops = wrote.calls.map((c) => `${String(c['op'])}:${String(c['reason'] ?? '')}`);
		expect(ops).toContain('wholesale:direct-write:zz-tags-naive.php');
	});

	it('answers a page request with a settle and nothing else when it wrote nothing', () => {
		expect(pages['/?p=1']!.calls.map((c) => c['op'])).toEqual(['settle']);
	});

	// each editorial write: what it announced, and which of the stored pages it purges
	const sets: {
		scenario: string;
		announces: string[];
		wholesale?: boolean;
		quiet?: string[];
		survives?: string[];
		purges?: string[];
	}[] = [
		{
			scenario: 'publish',
			announces: ['posts:post', 'posts'],
			purges: ['/', '/?feed=rss2', '/?s=hello'],
			survives: ['/?page_id=2']
		},
		{ scenario: 'draft', announces: [], survives: ['/?page_id=2', '/?p=999'] },
		{
			scenario: 'edit',
			announces: ['post:1', 'posts:post'],
			purges: ['/?p=1', '/'],
			survives: ['/?page_id=2']
		},
		{
			scenario: 'postmeta',
			announces: ['post:1'],
			purges: ['/?p=1'],
			survives: ['/?page_id=2', '/?p=999']
		},
		{
			scenario: 'term-create',
			announces: ['terms:category'],
			survives: ['/?page_id=2']
		},
		{
			scenario: 'term-edit',
			announces: ['term:1', 'terms:category'],
			purges: ['/?cat=1'],
			survives: ['/?page_id=2', '/?p=999']
		},
		{ scenario: 'term-assign', announces: ['post:1', 'posts:post'], purges: ['/?p=1'] },
		{
			scenario: 'comment',
			announces: ['comments:1', 'comments', 'post:1'],
			purges: ['/?p=1'],
			survives: ['/?page_id=2']
		},
		{
			scenario: 'spam-comment',
			announces: [],
			quiet: ['comments', 'commentmeta'],
			survives: PATHS
		},
		{
			scenario: 'option-plain',
			announces: ['option:my_plugin_setting'],
			purges: [PLUGIN_PAGE],
			survives: ['/', '/?p=1', '/?page_id=2']
		},
		{ scenario: 'option-structural', announces: [], wholesale: true, purges: PATHS },
		{
			scenario: 'user',
			announces: ['user:1'],
			purges: ['/?author=1', '/?p=1'],
			survives: ['/?p=999']
		},
		{ scenario: 'session', announces: [], quiet: ['usermeta'], survives: PATHS },
		{ scenario: 'cron', announces: [], quiet: ['options'], survives: PATHS },
		{ scenario: 'trash', announces: ['post:1', 'posts:post'], purges: ['/?p=1', '/'] },
		{ scenario: 'naive-write', announces: [], wholesale: true, purges: PATHS }
	];

	for (const set of sets) {
		it(`${set.scenario}: announces what it changed, and nothing the host would call unannounced`, async () => {
			const run = await runScenario(t, set.scenario);
			runs[set.scenario] = run;
			expect(run.failed).toBe(false);
			expect(run.announced).toEqual(expect.arrayContaining(set.announces));
			expect(run.wholesale.length > 0, `wholesale ${run.wholesale.join(',')}`).toBe(
				set.wholesale === true
			);
			expect(run.quiet).toEqual(expect.arrayContaining(set.quiet ?? []));
			expect(
				run.uncovered,
				`the host floor would fire for ${run.uncovered.join(',')}`
			).toEqual([]);
			const outcome = purged(stored, run);
			for (const path of set.purges ?? []) expect(outcome.paths, path).toContain(path);
			for (const path of set.survives ?? []) expect(outcome.paths, path).not.toContain(path);
			void rowsFor;
		}, 60_000);
	}

	it('judges the install itself with no write unannounced', () => {
		const install = summarise(t.install);
		expect(install.uncovered).toEqual([]);
		expect(install.wholesale).toContain('schema');
	});

	// a mutation control per mapping a scenario exercises: take the hook away and its tag is not
	// announced. Where nothing else names the page, the stale page survives a tags-only purge;
	// where another tag still reaches it, the table's write is what goes unaccounted for, which
	// the host's floor turns into a wholesale purge. The floor judges by family, so a post tag
	// announced for any other post in the run satisfies it: `tag` marks the controls only the
	// mapping itself can catch
	const controls: [string, string, string, string, 'survives' | 'floor' | 'tag'][] = [
		['edit', 'clean_post_cache', '/?p=1', 'post:1', 'survives'],
		[
			'publish',
			'clean_post_cache,transition_post_status,added_term_relationship,deleted_term_relationships',
			'/',
			'posts:post',
			'tag'
		],
		['postmeta', 'added_post_meta', '/?p=1', 'post:1', 'survives'],
		['term-edit', 'edited_term', '/?cat=1', 'term:1', 'floor'],
		[
			'term-assign',
			'added_term_relationship,deleted_term_relationships',
			'/?p=1',
			'post:1',
			'tag'
		],
		['comment', 'wp_insert_comment', '/?p=1', 'comments:1', 'floor'],
		[
			'option-plain',
			'added_option,updated_option',
			PLUGIN_PAGE,
			'option:my_plugin_setting',
			'survives'
		],
		['user', 'clean_user_cache', '/?author=1', 'user:1', 'survives']
	];
	for (const [scenario, hooks, page, tag, how] of controls) {
		it(`control: without ${hooks}, ${scenario} no longer announces ${tag}`, async () => {
			const normal = await runScenario(t, scenario);
			expect(normal.announced, 'the unmutated run announces the tag').toContain(tag);
			expect(purged(stored, normal).paths).toContain(page);
			const mutated = await runScenario(t, scenario, hooks);
			expect(mutated.announced, `the tag is gone with ${hooks} removed`).not.toContain(tag);
			if (how === 'survives') {
				expect(purged(stored, mutated).paths, 'the stale page survives').not.toContain(
					page
				);
			} else if (how === 'floor') {
				expect(mutated.uncovered.length, 'the floor has a gap to catch').toBeGreaterThan(0);
			}
		}, 60_000);
	}
	it('control: a plugin that removes the statement filter is still caught by the host floor', async () => {
		const run = await runScenario(t, 'naive-write-unfiltered');
		expect(run.wholesale).toEqual([]);
		expect(run.announced).toEqual([]);
		expect(run.uncovered).toEqual(['posts']);
	}, 60_000);

	// a theme switch leaves widget housekeeping for the next request, so these two run last
	const structural = [
		{ scenario: 'menu', announces: [], wholesale: true, purges: PATHS },
		{ scenario: 'theme', announces: [], wholesale: true, purges: PATHS }
	];
	for (const set of structural) {
		it(`${set.scenario}: is wholesale, and the host has nothing left to judge`, async () => {
			const run = await runScenario(t, set.scenario);
			runs[set.scenario] = run;
			expect(run.failed).toBe(false);
			expect(run.wholesale.length).toBeGreaterThan(0);
			expect(run.uncovered).toEqual([]);
			expect(purged(stored, run).paths.sort()).toEqual(Object.keys(stored).sort());
		}, 60_000);
	}

	it('prices each write set on the meter from the constants the object uses', () => {
		const table = [...sets, ...structural].map((s) => {
			const run = runs[s.scenario] ?? ({ announced: [], wholesale: [] } as never);
			const outcome = purged(stored, run);
			return {
				scenario: s.scenario,
				...rowsFor(Object.keys(stored).length, outcome),
				purged: outcome.paths.length
			};
		});
		// a scoped write deletes one row a page; a wholesale one marks every stored page
		for (const row of table) {
			if (row.policy === 'wholesale') {
				expect(row.marked).toBe(Object.keys(stored).length);
				expect(row.deleted).toBe(0);
			} else {
				expect(row.marked).toBe(0);
				expect(row.deleted).toBe(row.purged);
			}
		}
		console.info(JSON.stringify(table));
	});
});
