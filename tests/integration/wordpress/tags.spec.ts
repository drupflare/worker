import { describe, expect, it } from 'vitest';
import { wordpressRender } from '../../../src/wordpress/site-php';
import { freshSite, inObject, type ServeDo } from '../../helpers/serve-do';

/**
 * A WordPress object saves a post through WordPress itself and purges exactly the stored pages that
 * depend on it. Real DO SQLite, the real interpreter, the real pack, the host plugin's own emitter
 * and the host function that receives it.
 *
 * It stores pages, so it needs the test switch of the store rule; nothing else here turns storing
 * on. Needs `bun run assets:wordpress`. It is listed in `ARTIFACT_SPECS`, so a clean checkout skips it.
 */

const ORIGIN = 'https://wp.example';
const HOME = '/';
const POST = '/2026/01/01/hello-world/';
const PAGE = '/sample-page/';
const PATHS = [HOME, POST, PAGE];

type Tagged = ServeDo & {
	migrator(): { runAll(): Promise<{ done: boolean }> };
	runJsonMaybeParked(code: string): Promise<Record<string, unknown>>;
	resetPhp(): void;
	generation(): number;
	wordpressTags?: {
		announced: number;
		wholesale: number;
		floorPurges: number;
		lastFloor?: { tables: string[] };
		lastWholesale?: { reason: string };
	};
};

/** the request fragment with a few lines of WordPress code run in place of the front controller */
const fragment = (php: string): string =>
	wordpressRender('/?drupflare_test=1', { origin: ORIGIN }).replace(
		'require $cfwRoot . $cfwScript;',
		`require $cfwRoot . '/wp-load.php'; global $wpdb; ${php}`
	);

const SAVE = "wp_update_post(['ID' => 1, 'post_title' => 'Edited in a test']);";

async function ready(site: ServeDo): Promise<Tagged> {
	Object.assign(site.env, {
		CMS: 'wordpress',
		SQL_CHUNK_PREFIX: 'wordpress/sql',
		SITE_ORIGIN: ORIGIN,
		HEAP_SNAPSHOT: '0',
		WORDPRESS_PAGE_CACHE: '1'
	});
	const wp = site as Tagged;
	await wp.migrator().runAll();
	wp.ensureServeTables();
	return wp;
}

const rows = (site: ServeDo): { path: string; stale: boolean }[] =>
	site.sql
		.exec('SELECT path, stale_at FROM cfw_page ORDER BY path')
		.toArray()
		.map((r) => ({ path: String(r['path']), stale: r['stale_at'] != null }));

const live = (site: ServeDo): string[] =>
	rows(site)
		.filter((r) => !r.stale)
		.map((r) => r.path);

/** serves each path until its row is stored; a fresh site's first renders write bookkeeping options */
async function storePages(site: ServeDo): Promise<void> {
	for (const path of PATHS) {
		for (let attempt = 0; attempt < 5 && !rows(site).some((r) => r.path === path); attempt++) {
			await site.fetch(
				new Request(`https://do.local/__serve?path=${encodeURIComponent(path)}`)
			);
		}
	}
}

/** runs WordPress code in one interpreter, as `fillOne()` does, and drops the interpreter after */
async function run(wp: Tagged, php: string): Promise<Record<string, unknown>> {
	const out = await wp.runJsonMaybeParked(fragment(php));
	wp.resetPhp();
	return out;
}

describe('a WordPress save purges what depends on it', () => {
	it('stores the three pages with tags and no wholesale purge on the way', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			await storePages(wp);
			const tags = Object.fromEntries(
				wp.sql
					.exec('SELECT path, tags FROM cfw_page')
					.toArray()
					.map((r) => [String(r['path']), JSON.parse(String(r['tags'])) as string[]])
			);
			return { paths: rows(wp).map((r) => r.path), tags };
		});
		expect(out.paths.sort()).toEqual([...PATHS].sort());
		expect(out.tags[POST]).toEqual(expect.arrayContaining(['post:1']));
		expect(out.tags[HOME]).toEqual(expect.arrayContaining(['posts:post']));
		for (const path of PATHS) expect(out.tags[path]!.length, path).toBeGreaterThan(0);
	}, 240_000);

	it('purges the post and the listing it appears in, and keeps the page that does not show it', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			await storePages(wp);
			const before = {
				live: live(wp),
				generation: wp.generation(),
				wholesale: wp.wordpressTags?.wholesale ?? 0
			};
			const saved = await run(wp, SAVE);
			return {
				before,
				saved,
				after: rows(wp),
				generation: wp.generation(),
				stats: wp.wordpressTags
			};
		});
		expect(out.before.live.sort()).toEqual([...PATHS].sort());
		expect(out.saved['error']).toBeUndefined();
		expect(out.after.map((r) => r.path)).toEqual([PAGE]);
		expect(out.after[0]!.stale).toBe(false);
		expect(out.generation).toBeGreaterThan(out.before.generation);
		expect(out.stats).toMatchObject({ floorPurges: 0 });
		expect(out.stats!.announced).toBeGreaterThan(0);
		// the fresh site's first renders wrote widget options, which went wholesale before this save
		expect(out.stats!.wholesale).toBe(out.before.wholesale);
	}, 240_000);

	it('control: without the emitter hooks the page is not purged by tags, and the floor is what makes it stale', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			await storePages(wp);
			await run(
				wp,
				`remove_action('clean_post_cache', 'drupflare_tags_on_clean_post_cache');
				 remove_action('added_post_meta', 'drupflare_tags_on_post_meta');
				 remove_action('updated_post_meta', 'drupflare_tags_on_post_meta');
				 remove_action('transition_post_status', 'drupflare_tags_on_transition_post_status');
				 ${SAVE}`
			);
			return { rows: rows(wp), stats: wp.wordpressTags };
		});
		// every hook that names the post is gone, so no announced tag reaches its page and the scoped
		// purge deletes nothing: the row is still there, and only the floor has marked it stale
		expect(out.rows.find((r) => r.path === POST)).toEqual({ path: POST, stale: true });
		expect(out.stats?.floorPurges).toBe(1);
	}, 240_000);

	it('turns a write nobody announced into a wholesale purge, and counts it', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			await storePages(wp);
			const before = wp.generation();
			await run(
				wp,
				"remove_filter('query', 'drupflare_tags_on_query', 99999); $wpdb->query(\"UPDATE {$wpdb->posts} SET post_title = 'Naive' WHERE ID = 1\");"
			);
			return { rows: rows(wp), stats: wp.wordpressTags, moved: wp.generation() - before };
		});
		expect(out.rows.map((r) => r.path).sort()).toEqual([...PATHS].sort());
		expect(out.rows.every((r) => r.stale)).toBe(true);
		expect(out.stats).toMatchObject({ floorPurges: 1, lastFloor: { tables: ['posts'] } });
		expect(out.moved).toBeGreaterThan(0);
	}, 240_000);

	it('has the emitter itself call a plugin write a wholesale purge, with no floor needed', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			await storePages(wp);
			await run(
				wp,
				'$wpdb->query("UPDATE {$wpdb->posts} SET post_title = \'Naive\' WHERE ID = 1");'
			);
			return { rows: rows(wp), stats: wp.wordpressTags };
		});
		expect(out.rows.every((r) => r.stale)).toBe(true);
		expect(out.stats?.floorPurges).toBe(0);
		expect(out.stats?.lastWholesale?.reason).toMatch(/^direct-write:/);
	}, 240_000);

	it('purges nothing for a write that failed, when the emitter did not see it either', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			await storePages(wp);
			await run(
				wp,
				'remove_filter("query", "drupflare_tags_on_query", 99999); $wpdb->query("UPDATE {$wpdb->posts} SET no_such_column = 1");'
			);
			return { live: live(wp), stats: wp.wordpressTags };
		});
		expect(out.live.sort()).toEqual([...PATHS].sort());
		expect(out.stats?.floorPurges ?? 0).toBe(0);
	}, 240_000);

	it('counts no floor purge across a post save, a term edit, a comment and an option update', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			await storePages(wp);
			await run(wp, SAVE);
			await run(wp, "wp_update_term(1, 'category', ['name' => 'Renamed']);");
			await run(
				wp,
				"wp_insert_comment(['comment_post_ID' => 1, 'comment_content' => 'hi', 'comment_approved' => 1, 'comment_author' => 'a']);"
			);
			await run(wp, "update_option('my_plugin_setting', 'on');");
			return wp.wordpressTags;
		});
		expect(out?.floorPurges).toBe(0);
		expect(out?.lastFloor).toBeUndefined();
		expect(out!.announced).toBeGreaterThan(0);
	}, 360_000);

	it('leaves the pages alone when a render writes nothing', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			await storePages(wp);
			const before = wp.generation();
			await run(wp, '');
			return { live: live(wp), stats: wp.wordpressTags, moved: wp.generation() - before };
		});
		expect(out.live.sort()).toEqual([...PATHS].sort());
		expect(out.moved).toBe(0);
	}, 240_000);
});
