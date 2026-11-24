import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropInMissing, runPhp, WORDPRESS_SRC } from '../../../scripts/wp/harness';
import {
	installFailure,
	MU_DIR,
	PAGE_PATHS,
	purged,
	renderBody,
	renderPage,
	rowsFor,
	runScenario,
	startTagSite,
	summarise,
	type PageTags,
	type ScenarioResult,
	type TagSite
} from '../../../scripts/wp/tags';

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

const SHAPE_PAGES = [
	'/',
	'/?p=1',
	'/?page_id=2',
	'/?cat=1',
	'/?author=1',
	'/?feed=rss2',
	'/?feed=comments-rss2',
	'/?feed=rss2&p=1',
	'/?m=202601',
	'/?year=2026',
	'/?paged=2',
	'/?tag=tagged',
	'/?post_type=book',
	'/?s=zzz',
	'/?p=999'
];

describe.skipIf(skip !== undefined)('wordpress cache tags across site shapes', () => {
	let t: TagSite;
	const swept: Record<string, Record<string, PageTags>> = {};
	const HERE = import.meta.dirname;

	const setup = async (shape: string, extra: Record<string, string> = {}) => {
		const run = await runPhp(t.site, [join(HERE, '../../../scripts/wp/tags-site.php')], {
			SHAPE: shape,
			CFW_LABEL: `setup:${shape}`,
			...extra
		});
		expect(run.code, `${shape}: ${run.stderr.slice(0, 200)}`).toBe(0);
	};
	const sweep = async (label: string) => {
		swept[label] = {};
		for (const path of SHAPE_PAGES) {
			await renderPage(t, path);
			swept[label]![path] = await renderPage(t, path);
		}
	};

	beforeAll(async () => {
		t = await startTagSite('wp-shapes-');
		copyFileSync(
			join(HERE, '../../../scripts/wp/tags-cpt.php'),
			join(t.site.www, 'wp-content/mu-plugins/zz-tags-cpt.php')
		);
		await setup('posts');
		await setup('comments');
		await setup('books');
		await setup('widgets');
		await setup('menu');
		await sweep('twentytwentyfive');
		for (const theme of ['twentytwentyone', 'twentyfifteen', 'twentytwentyfour']) {
			await setup('theme', { THEME: theme });
			await setup('widgets');
			await setup('menu');
			await sweep(theme);
		}
	}, 420_000);

	afterAll(async () => {
		await t?.stop();
		if (t !== undefined) rmSync(t.site.dir, { recursive: true, force: true });
	});

	for (const theme of [
		'twentytwentyfive',
		'twentytwentyone',
		'twentyfifteen',
		'twentytwentyfour'
	]) {
		it(`names the tags of every page under ${theme}, with posts, comments, a post type, widgets and a menu`, () => {
			for (const path of SHAPE_PAGES) {
				const page = swept[theme]![path]!;
				expect(page.untaggable, `${theme} ${path}: ${page.reasons.join(', ')}`).toBeNull();
				expect(page.tags.length, `${theme} ${path}`).toBeGreaterThan(0);
			}
		});

		it(`ties ${theme} archives, pagination and the post type to what a write announces`, () => {
			const pages = swept[theme]!;
			expect(pages['/?p=1']!.tags).toContain('post:1');
			expect(pages['/?p=1']!.tags).toContain('comments:1');
			expect(
				pages['/?post_type=book']!.tags.some((tag) => tag.startsWith('posts:book'))
			).toBe(true);
			expect(pages['/?paged=2']!.tags.some((tag) => tag.startsWith('posts:'))).toBe(true);
			expect(pages['/?tag=tagged']!.tags.some((tag) => tag.startsWith('term:'))).toBe(true);
			expect(pages['/?author=1']!.tags.some((tag) => tag.startsWith('user:'))).toBe(true);
			expect(pages['/?feed=comments-rss2']!.tags).toContain('comments');
		});
	}
});

/** the page of one post by id, which is the key the harness stores it under */
const postPath = (id: number): string => `/?p=${id}`;

/** the previous and next links a post page shows, as direction, target and title */
function linksOf(body: string): string {
	const out: string[] = [];
	const link =
		/<div class="post-navigation-link-(previous|next)[^"]*"[^>]*>.*?<a href="[^"]*?(\?p=\d+)"[^>]*>.*?post-navigation-link__title">([^<]*)</gs;
	for (const m of body.matchAll(link)) out.push(`${m[1]}:${m[2]}:${m[3]}`);
	return out.sort().join('|');
}

/** the handlers that name the published posts beside a post whose place in the order changed */
const NEIGHBOUR_HANDLERS =
	'drupflare_tags_on_transition_neighbours,drupflare_tags_on_post_updated,drupflare_tags_on_deleted_post';

/**
 * A new or removed post also changes its category's post count, which announces the category and
 * so purges every page that loaded it. The runs that isolate the neighbour announce hold that one
 * handler aside; a separate case below pins what it purges.
 */
const COUNT_HANDLER = 'drupflare_tags_on_edited_term_taxonomy';

type Row = { id: number; date: string; status: string };
type Step = { op: string; id?: number; date?: string; status?: string };

describe.skipIf(skip !== undefined)('wordpress previous and next links on a real site', () => {
	const CHAIN = 110;
	const HELLO = 1;
	const NEW_ID = 99_999_999;
	let t: TagSite;
	let chain: number[] = [];
	const model = new Map<number, Row>();

	const stamp = (offsetHours: number): string =>
		new Date(Date.UTC(2015, 0, 1, 12) + offsetHours * 3_600_000)
			.toISOString()
			.slice(0, 19)
			.replace('T', ' ');
	const chainDate = (index: number): string => stamp((index + 1) * 24);
	const between = (index: number): string => stamp((index + 1) * 24 + 6);
	const key = (r: { id: number; date: string }): string =>
		`${r.date}#${String(r.id).padStart(8, '0')}`;

	/** the published posts either side of a place in date order, ties broken by id */
	const beside = (date: string, id: number, except: number): number[] => {
		const published = [...model.values()]
			.filter((r) => r.status === 'publish' && r.id !== except)
			.sort((a, b) => key(a).localeCompare(key(b)));
		const at = key({ id, date });
		const previous = [...published].reverse().find((r) => key(r) < at);
		const next = published.find((r) => key(r) > at);
		return [previous?.id, next?.id].filter((n): n is number => n !== undefined);
	};

	const snapshot = async (paths: string[]) => {
		const out: Record<string, { tags: string[]; stored: boolean; links: string }> = {};
		for (const path of paths) {
			let page = await renderBody(t, path);
			for (let i = 0; i < 3 && page.untaggable !== null && page.status === 200; i++) {
				page = await renderBody(t, path);
			}
			out[path] = {
				tags: page.tags,
				stored: page.untaggable === null,
				links: linksOf(page.body)
			};
		}
		return out;
	};

	const act = (step: Step, hooks?: string) =>
		runScenario(t, 'adjacent', hooks, { ARGS: JSON.stringify(step) });

	/**
	 * One event observed from a cache's side: the pages it holds before, which of them the announced
	 * tags purge, and which pages would still show a link that is no longer true.
	 */
	const observe = async (step: Step, watch: number[], hooks?: string) => {
		const paths = ['/', ...watch.map(postPath)];
		const before = await snapshot(paths);
		const run = await act(step, hooks);
		expect(run.failed).toBe(false);
		const stored: Record<string, string[]> = {};
		for (const p of paths) if (before[p]!.stored) stored[p] = before[p]!.tags;
		const outcome = purged(stored, run);
		const newId = typeof run.output['id'] === 'number' ? run.output['id'] : undefined;
		const after = await snapshot([...paths, ...(newId === undefined ? [] : [postPath(newId)])]);
		const stale = paths.filter(
			(p) =>
				stored[p] !== undefined &&
				!outcome.paths.includes(p) &&
				before[p]!.links !== after[p]!.links
		);
		return { run, outcome, stale, wholesale: run.wholesale, newId };
	};

	beforeAll(async () => {
		t = await startTagSite('wp-adjacent-');
		const HERE = import.meta.dirname;
		const theme = await runPhp(t.site, [join(HERE, '../../../scripts/wp/tags-site.php')], {
			SHAPE: 'theme',
			THEME: 'twentytwentyfour',
			CFW_LABEL: 'setup:adjacent-theme'
		});
		expect(theme.code).toBe(0);
		const seed = await runScenario(t, 'adjacent-seed', undefined, { COUNT: String(CHAIN) });
		chain = seed.output['ids'] as number[];
		expect(chain).toHaveLength(CHAIN);
		chain.forEach((id, i) => model.set(id, { id, date: chainDate(i), status: 'publish' }));
		model.set(HELLO, { id: HELLO, date: '2999-01-01 00:00:00', status: 'publish' });
		await snapshot(['/', postPath(chain[0]!)]);
	}, 900_000);

	afterAll(async () => {
		await t?.stop();
		if (t !== undefined) rmSync(t.site.dir, { recursive: true, force: true });
	});

	const c = (i: number): number => chain[i]!;
	const far = (): number => c(60);

	type Case = {
		name: string;
		/** the place in the order the event touches, for the posts that must be purged */
		expected: () => number[];
		watch: () => number[];
		step: () => Step;
		/** undoes the event after its control run so the real run starts from the same state */
		undo?: (made: number | undefined) => Step;
		setup?: () => Step;
		apply: (made: number | undefined) => void;
		/** whether the all-posts listing page is purged too */
		listing: boolean;
	};

	const entersPublish = (step: Step): boolean =>
		step.op === 'insert' ||
		step.op === 'untrash' ||
		step.op === 'move' ||
		(step.op === 'status' && step.status === 'publish');
	const status = (id: number, to: string): Step => ({
		op: 'status',
		id,
		status: to,
		date: model.get(id)!.date
	});
	const nearby = (i: number, n = 3): number[] =>
		Array.from({ length: n * 2 + 1 }, (_, k) => c(i - n + k)).filter((id) => id !== undefined);

	const cases: Case[] = [
		{
			name: 'publishing a new latest post',
			expected: () => beside('2015-12-01 12:00:00', NEW_ID, 0),
			watch: () => [...nearby(CHAIN - 1, 2), HELLO, far()],
			step: () => ({ op: 'insert', date: '2015-12-01 12:00:00' }),
			undo: (made) => ({ op: 'delete', id: made! }),
			apply: (made) =>
				model.set(made!, { id: made!, date: '2015-12-01 12:00:00', status: 'publish' }),
			listing: true
		},
		{
			name: 'publishing a post between two others by date',
			expected: () => beside(between(20), NEW_ID, 0),
			watch: () => nearby(20),
			step: () => ({ op: 'insert', date: between(20) }),
			undo: (made) => ({ op: 'delete', id: made! }),
			apply: (made) => model.set(made!, { id: made!, date: between(20), status: 'publish' }),
			listing: true
		},
		{
			name: 'trashing a middle post',
			expected: () => [c(30), ...beside(model.get(c(30))!.date, c(30), c(30))],
			watch: () => nearby(30),
			step: () => ({ op: 'trash', id: c(30) }),
			undo: () => ({ op: 'untrash', id: c(30) }),
			apply: () => void (model.get(c(30))!.status = 'trash'),
			listing: true
		},
		{
			name: 'trashing the first post',
			expected: () => [c(0), ...beside(model.get(c(0))!.date, c(0), c(0))],
			watch: () => [c(0), c(1), c(2), far()],
			step: () => ({ op: 'trash', id: c(0) }),
			undo: () => ({ op: 'untrash', id: c(0) }),
			apply: () => void (model.get(c(0))!.status = 'trash'),
			listing: true
		},
		{
			name: 'trashing the last post',
			expected: () => [HELLO, ...beside('2999-01-01 00:00:00', HELLO, HELLO)],
			watch: () => [HELLO, ...beside('2999-01-01 00:00:00', HELLO, HELLO), far()],
			step: () => ({ op: 'trash', id: HELLO }),
			undo: () => ({ op: 'untrash', id: HELLO }),
			apply: () => void (model.get(HELLO)!.status = 'trash'),
			listing: true
		},
		{
			name: 'moving a post past two neighbours',
			expected: () => {
				const from = model.get(c(45))!;
				return [
					c(45),
					...beside(from.date, c(45), c(45)),
					...beside(between(48), c(45), c(45))
				];
			},
			watch: () => [...nearby(45, 2), ...nearby(49, 2)],
			step: () => ({ op: 'move', id: c(45), date: between(48) }),
			undo: () => ({ op: 'move', id: c(45), date: chainDate(45) }),
			apply: () => void (model.get(c(45))!.date = between(48)),
			listing: true
		},
		{
			name: 'drafting a published post',
			expected: () => [c(55), ...beside(model.get(c(55))!.date, c(55), c(55))],
			watch: () => nearby(55),
			step: () => status(c(55), 'draft'),
			undo: () => status(c(55), 'publish'),
			apply: () => void (model.get(c(55))!.status = 'draft'),
			listing: true
		},
		{
			name: 'restoring a post from the trash',
			setup: () => ({ op: 'trash', id: c(65) }),
			expected: () => [c(65), ...beside(model.get(c(65))!.date, c(65), c(65))],
			watch: () => nearby(65),
			step: () => ({ op: 'untrash', id: c(65) }),
			undo: () => ({ op: 'trash', id: c(65) }),
			apply: () => void (model.get(c(65))!.status = 'publish'),
			listing: true
		},
		{
			name: 'publishing a post dated the same as its neighbour',
			expected: () => beside(chainDate(70), NEW_ID, 0),
			watch: () => nearby(70),
			step: () => ({ op: 'insert', date: chainDate(70) }),
			undo: (made) => ({ op: 'delete', id: made! }),
			apply: (made) =>
				model.set(made!, { id: made!, date: chainDate(70), status: 'publish' }),
			listing: true
		},
		{
			name: 'making a published post private',
			expected: () => [c(95), ...beside(model.get(c(95))!.date, c(95), c(95))],
			watch: () => nearby(95),
			step: () => status(c(95), 'private'),
			undo: () => status(c(95), 'publish'),
			apply: () => void (model.get(c(95))!.status = 'private'),
			listing: true
		}
	];

	for (const spec of cases) {
		it(`${spec.name}: purges the post and the two neighbours and keeps every link current`, async () => {
			if (spec.setup !== undefined) await act(spec.setup());
			const expectedIds = [...new Set(spec.expected())];
			const watch = [...new Set([...spec.watch(), ...expectedIds])];

			const control = await observe(
				spec.step(),
				watch,
				`${COUNT_HANDLER},${NEIGHBOUR_HANDLERS}`
			);
			if (entersPublish(spec.step())) {
				expect(
					control.stale.length,
					'without the neighbour announce a link goes stale'
				).toBeGreaterThan(0);
			} else {
				expect(
					control.stale,
					'a post that leaves is covered by its own tag on the pages that linked to it'
				).toEqual([]);
			}
			await act(spec.undo!(control.newId));

			const real = await observe(spec.step(), watch, COUNT_HANDLER);
			expect(real.stale, 'every link a cache would still serve is current').toEqual([]);
			const posts = real.outcome.paths.filter((p) => p !== '/');
			expect(posts.sort()).toEqual(expectedIds.map(postPath).sort());
			expect(real.outcome.paths.includes('/')).toBe(spec.listing);
			expect(real.outcome.paths).not.toContain(postPath(far()));
			expect(real.wholesale).toEqual([]);
			expect(real.run.uncovered.filter((table) => table !== 'term_taxonomy')).toEqual([]);
			spec.apply(real.newId);
		}, 600_000);
	}

	it('a new post still purges every page that loaded its category, since the category count changed', async () => {
		const watch = [...nearby(105), far()];
		const result = await observe({ op: 'insert', date: between(105) }, watch);
		expect(result.stale).toEqual([]);
		expect(result.run.announced).toEqual(expect.arrayContaining(['term:1', 'terms:category']));
		expect(result.outcome.paths).toContain(postPath(far()));
		model.set(result.newId!, { id: result.newId!, date: between(105), status: 'publish' });
	}, 300_000);

	it('a post whose password changes purges the pages that link to it, with no neighbour announce', async () => {
		const target = c(80);
		const watch = [...nearby(80), far()];
		const result = await observe({ op: 'password', id: target }, watch);
		expect(result.stale).toEqual([]);
		expect(result.outcome.paths.filter((p) => p !== '/').sort()).toEqual(
			[c(79), c(80), c(81)].map(postPath).sort()
		);
		expect(result.outcome.paths).not.toContain(postPath(far()));
	}, 300_000);

	it('a new private post purges no post page and leaves every link current', async () => {
		const watch = [...nearby(90), far()];
		const result = await observe({ op: 'insert', status: 'private', date: between(90) }, watch);
		expect(result.stale).toEqual([]);
		expect(result.outcome.paths).toEqual([]);
	}, 300_000);

	it('a retitled post purges its own page and the two pages that link to it, and no others', async () => {
		const watch = [...nearby(100), far()];
		const result = await observe({ op: 'title', id: c(100) }, watch);
		expect(result.stale).toEqual([]);
		const posts = result.outcome.paths.filter((p) => p !== '/').sort();
		expect(posts).toEqual([c(99), c(100), c(101)].map(postPath).sort());
	}, 300_000);

	it('tags a plain adjacent-post read with the links of its own post and not the table', async () => {
		const page = await renderBody(t, postPath(c(40)));
		const again = await renderBody(t, postPath(c(40)));
		expect(again.untaggable).toBeNull();
		expect(again.readers).toContain('get_adjacent_post');
		expect(again.tags).not.toContain('posts');
		expect(again.tags).toContain(`post_links:${c(40)}`);
		expect(again.tags).toEqual(
			expect.arrayContaining([c(40), c(39), c(41)].map((id) => `post:${id}`))
		);
		expect(page.status).toBe(200);
	}, 120_000);

	for (const variant of ['adjacent_term', 'adjacent_excluded', 'adjacent_sorted']) {
		it(`keeps the table-wide tag when a plugin reads adjacent posts with ${variant}`, async () => {
			const path = `${postPath(c(41))}&${variant}=1`;
			await renderBody(t, path);
			const page = await renderBody(t, path);
			expect(page.untaggable).toBeNull();
			expect(page.tags).toContain('posts');
		}, 120_000);
	}
});

describe('a failed install', () => {
	it('names the fatal from the error log when both streams hold only the generic page', () => {
		const dir = mkdtempSync(join(tmpdir(), 'wp-install-failure-'));
		const log = join(dir, 'debug.log');
		try {
			writeFileSync(log, 'PHP Fatal error:  Uncaught Error: Class "Missing" not found\n');
			const message = installFailure(
				{
					code: 255,
					stdout: '<style>.a{}</style><p>There has been a critical error.</p>',
					stderr: ''
				},
				log
			);
			expect(message).toContain('exit 255');
			expect(message).toContain('Class "Missing" not found');
			expect(message).toContain('There has been a critical error.');
			expect(message).not.toContain('<style>');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('still reports the exit code when the install left no log', () => {
		const message = installFailure(
			{ code: null, stdout: '', stderr: '' },
			'/nonexistent/debug.log'
		);
		expect(message).toContain('exit signal');
		expect(message).toContain('log: (empty)');
	});
});
