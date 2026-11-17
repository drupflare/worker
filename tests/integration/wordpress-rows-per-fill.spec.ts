import { describe, expect, it } from 'vitest';
import { ROWS_PER_FILL_WORDPRESS } from '../../scripts/measure/free-envelope';
import { wordpressRender } from '../../src/wordpress/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What a WordPress fill, a scoped purge and a floor purge cost on the row meter, against the
 * constants the WordPress ceiling is computed from.
 *
 * Same harness and meter as `rows-per-fill-audit.spec.ts`: one object per arm group, every arm
 * driven consecutively, the reset kept outside the tracked window. WordPress has no cache bins, so a
 * fill of a stored path is both its real render and its reassemble; it keeps no separate class.
 *
 * Needs `bun run assets:wordpress`. It is listed in `ARTIFACT_SPECS`, so a clean checkout skips it.
 */

const ORIGIN = 'https://wp.example';
const TIMEOUT = 600_000;
const POST = '/2026/01/01/hello-world/';
const PAGE = '/sample-page/';
const DATE = '/2026/01/';

type Tagged = ServeDo & {
	migrator(): { runAll(): Promise<{ done: boolean }> };
	runJsonMaybeParked(code: string): Promise<Record<string, unknown>>;
	resetPhp(): void;
	queueDepth(): number;
};

type Arm = { rows: number; statements: number; perTable: { table: string; rows: number }[] };

const ready = async (site: ServeDo): Promise<Tagged> => {
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
};

const arm = async (site: ServeDo, run: () => Promise<unknown>): Promise<Arm> => {
	await site.fetch(new Request('https://do.local/__writes?op=off'));
	await site.fetch(new Request('https://do.local/__writes?op=on'));
	await run();
	const t = (await (await site.fetch(new Request('https://do.local/__writes'))).json()) as {
		rowsWritten: number;
		statements: number;
		indexSplit: { rows: { table: string; chargedRows: number }[] };
	};
	return {
		rows: t.rowsWritten,
		statements: t.statements,
		perTable: t.indexSplit.rows
			.filter((r) => r.chargedRows > 0)
			.map((r) => ({ table: r.table, rows: r.chargedRows }))
			.sort((a, b) => b.rows - a.rows)
	};
};

const fill = (site: ServeDo, path: string) =>
	site.fillOne(path, undefined, undefined, { origin: ORIGIN });

const fragment = (php: string): string =>
	wordpressRender('/?drupflare_test=1', { origin: ORIGIN }).replace(
		'require $cfwRoot . $cfwScript;',
		`require $cfwRoot . '/wp-load.php'; global $wpdb; ${php}`
	);

const run = async (wp: Tagged, php: string) => {
	const out = await wp.runJsonMaybeParked(fragment(php));
	wp.resetPhp();
	return out;
};

const SAVE = "wp_update_post(['ID' => 1, 'post_title' => 'Edited in a test']);";
const NAIVE =
	"remove_filter('query', 'drupflare_tags_on_query', 99999); $wpdb->query(\"UPDATE {$wpdb->posts} SET post_title = 'Naive' WHERE ID = 1\");";

/** fills a path until a row is stored, which a fresh site's first renders do not manage */
const storeIt = async (wp: Tagged, path: string) => {
	for (let i = 0; i < 5; i++) {
		await fill(wp, path);
		const n = wp.sql.exec('SELECT 1 FROM cfw_page WHERE path = ?', path).toArray().length;
		if (n > 0) return;
	}
};

describe('rows per WordPress fill, against the constants the ceiling is computed from', () => {
	it(
		'measures each fill class and reports it beside the constant',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const wp = await ready(site);
				const firstFillOnFreshObject = await arm(wp, () => fill(wp, '/'));
				const firstStored = await arm(wp, () => fill(wp, '/'));
				const firstEverForPath = await arm(wp, () => fill(wp, PAGE));
				// an existing row is upserted: the steady-state fill, and the reassemble WordPress lacks
				const realRender = await arm(wp, () => fill(wp, PAGE));
				const realRenderFront = await arm(wp, () => fill(wp, '/'));
				const refusedPath = await arm(wp, () => fill(wp, '/?s=probe'));
				const stored = wp.sql
					.exec('SELECT path FROM cfw_page ORDER BY path')
					.toArray()
					.map((r) => String(r['path']));
				return {
					firstFillOnFreshObject,
					firstStored,
					firstEverForPath,
					realRender,
					realRenderFront,
					refusedPath,
					stored
				};
			});
			console.log(
				`[wordpress-rows-per-fill] ${JSON.stringify({
					firstFillOnFreshObject: {
						measured: out.firstFillOnFreshObject.rows,
						constant: ROWS_PER_FILL_WORDPRESS.firstFillOnFreshObject
					},
					firstEverForPath: {
						measured: out.firstEverForPath.rows,
						constant: ROWS_PER_FILL_WORDPRESS.firstEverForPath
					},
					realRender: {
						measured: out.realRender.rows,
						constant: ROWS_PER_FILL_WORDPRESS.realRender
					},
					detail: out
				})}`
			);
			for (const [name, a] of Object.entries(out)) {
				if (name === 'stored' || name === 'refusedPath') continue;
				expect(
					(a as Arm).rows,
					`${name} wrote nothing, so it prices nothing`
				).toBeGreaterThan(0);
			}
			expect(out.stored).toEqual(expect.arrayContaining([PAGE, '/']));
			// pinned, not ranged: the charges are exact, so a drift is a real change
			expect(out.firstFillOnFreshObject.rows).toBe(
				ROWS_PER_FILL_WORDPRESS.firstFillOnFreshObject
			);
			expect(out.firstEverForPath.rows).toBe(ROWS_PER_FILL_WORDPRESS.firstEverForPath);
			expect(out.realRender.rows).toBe(ROWS_PER_FILL_WORDPRESS.realRender);
			// the front page is the dearer path, and the class is priced on it
			expect(out.realRenderFront.rows).toBeLessThanOrEqual(
				ROWS_PER_FILL_WORDPRESS.realRender
			);
			// a path the rule refuses by shape is rendered and not recorded: it writes nothing at all
			expect(out.refusedPath.rows).toBe(0);
			// the class ordering the warmth mix relies on
			expect(out.firstFillOnFreshObject.rows).toBeGreaterThanOrEqual(
				out.firstEverForPath.rows
			);
			expect(out.firstEverForPath.rows).toBeGreaterThanOrEqual(out.realRender.rows);
		},
		TIMEOUT
	);

	it(
		'prices a scoped purge and a floor purge by the rows they add to the same write',
		async () => {
			const measure = async (php: string, pages: string[]) =>
				inObject(freshSite(), async (site: ServeDo) => {
					const wp = await ready(site);
					await fill(wp, '/');
					await fill(wp, '/');
					for (const p of pages) await storeIt(wp, p);
					// the refills the earlier fills queued would land inside the window
					while (wp.queueDepth() > 0) await fill(wp, '/');
					const before = wp.sql.exec('SELECT 1 FROM cfw_page').toArray().length;
					const a = await arm(wp, () => run(wp, php));
					const after = wp.sql.exec('SELECT 1 FROM cfw_page').toArray().length;
					const live = wp.sql
						.exec('SELECT 1 FROM cfw_page WHERE stale_at IS NULL')
						.toArray().length;
					return { arm: a, before, after, live, queued: wp.queueDepth() };
				});
			const none = await measure(SAVE, []);
			const three = await measure(SAVE, [POST, PAGE, DATE]);
			const naiveNone = await measure(NAIVE, []);
			const naiveThree = await measure(NAIVE, [POST, PAGE, DATE]);
			const scopedExtra = three.arm.rows - none.arm.rows;
			const floorExtra = naiveThree.arm.rows - naiveNone.arm.rows;
			const scopedPages = three.before - three.after - (none.before - none.after);
			const floorPages = naiveThree.before - naiveNone.before;
			console.log(
				`[wordpress-purge-rows] ${JSON.stringify({
					scoped: { none, three, extraRows: scopedExtra },
					wholesale: { none: naiveNone, three: naiveThree, extraRows: floorExtra },
					constants: { purgeRowsPerPage: ROWS_PER_FILL_WORDPRESS.purgeRowsPerPage }
				})}`
			);
			// the save dropped the pages that carry the post's tags and queued their refills
			expect(three.after).toBeLessThan(three.before);
			expect(three.queued).toBeGreaterThan(0);
			expect(scopedExtra).toBe(ROWS_PER_FILL_WORDPRESS.purgeRowsPerPage * scopedPages);
			// a write nobody announced marks every stored row stale and keeps it
			expect(naiveThree.after).toBe(naiveThree.before);
			expect(naiveThree.live).toBe(0);
			expect(floorExtra).toBe(ROWS_PER_FILL_WORDPRESS.purgeRowsPerPage * floorPages);
		},
		TIMEOUT
	);
});
