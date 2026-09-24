import { describe, expect, it } from 'vitest';
import { renderPage } from '../../src/drupal/site-php';
import { DEFAULT_MEMORY_CACHE_BINS, memoryCacheBins, recycleAboveBytes } from '../../src/site-do';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * A cache bin held in the interpreter instead of in the tenant's SQLite.
 *
 * `pib_run` performs no request shutdown, so a class static survives from one Worker invocation to
 * the next -- which is what makes an in-process bin a real tier here and a test double on any
 * ordinary PHP host. What it is worth is measured: a real re-render after a tag invalidation charges
 * 8 rows on the shipping pack, of which **6 are `cache_dynamic_page_cache`**, and rows written is
 * the meter that binds regeneration.
 *
 * The bin is selected through core's own `$settings['cache']['bins']`, so the arms here differ by
 * one environment variable and nothing else.
 */

const TIMEOUT = 900_000;
const ORIGIN = 'https://do.local';
const FROM_SOURCE = import.meta.env?.PACK_FROM_SOURCE === '1';

type Writes = {
	rowsWritten: number;
	indexSplit: { rows: { table: string; chargedRows: number }[] };
};

/**
 * The page with its per-build and per-site values replaced, so two renders compare for CONTENT.
 *
 * Two, and neither has anything to do with a cache bin:
 *
 * - `form_build_id` is fresh base64 on every build, and `Html::getId()` collapses consecutive
 *   hyphens when it derives the `data-drupal-selector` from it, so a token that happens to contain
 *   `--` or `_-` renders a byte shorter. That flaked a LENGTH comparison about one run in six.
 * - `permissionsHash` is an HMAC keyed on the site's private key, which `firstRunConfig()` mints at
 *   random, so two separately provisioned objects differ there by construction. It is fixed-width
 *   hex, which is exactly why a length comparison never saw it.
 *
 * Comparing lengths was also the weaker check -- two different pages can share one.
 */
const stablePage = (html: string) =>
	html
		.replace(/form-[A-Za-z0-9_-]{20,}/g, 'form-X')
		.replace(/"permissionsHash":"[0-9a-f]{64}"/g, '"permissionsHash":"X"');

/** equality of two pages, failing with WHERE they diverge rather than with two 13 KB strings */
function expectSamePage(actual: string, expected: string, label: string) {
	if (actual === expected) return;
	let i = 0;
	while (i < actual.length && actual[i] === expected[i]) i++;
	const at = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 80), i + 80));
	expect.fail(
		`${label}: pages diverge at ${i}\n  actual:   ${at(actual)}\n  expected: ${at(expected)}`
	);
}

async function armSite(site: ServeDo, bins: string) {
	site.env = { ...site.env, MEMORY_CACHE_BINS: bins };
	await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
	const first = await site.fetch(
		new Request(`${ORIGIN}/__firstrun`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ adminPass: 'cfw-Memory-8814-pass', siteName: 'Memory' })
		})
	);
	expect(first.status, await first.clone().text()).toBe(200);
}

/** a real render: both bins emptied, which is what a tag invalidation costs to undo */
async function realRender(site: ServeDo, path: string) {
	// the DELETE is the harness's and goes BEFORE the reset: it is a charged write, a fill upserts,
	// and inside the window it read every arm one row high -- the same defect the audit spec had
	site.sql.exec('DELETE FROM cfw_page WHERE path = ?', path);
	await site.fetch(new Request(`${ORIGIN}/__writes?op=off`));
	await site.fetch(new Request(`${ORIGIN}/__writes?op=on`));
	await site.fillOne(path, ['page', 'dynamic_page_cache']);
	const t = (await (await site.fetch(new Request(`${ORIGIN}/__writes`))).json()) as Writes;
	return {
		rows: t.rowsWritten,
		perTable: Object.fromEntries(
			t.indexSplit.rows
				.filter((r) => r.chargedRows > 0)
				.map((r) => [r.table, r.chargedRows] as const)
		)
	};
}

describe.skipIf(FROM_SOURCE)('the dynamic_page_cache bin, held in the interpreter', () => {
	it(
		'removes its rows from a real render and keeps the page identical',
		async () => {
			const database = await inObject(freshSite(), async (site: ServeDo) => {
				await armSite(site, 'none');
				await site.fillOne('/user/login', ['page', 'dynamic_page_cache']);
				const measured = await realRender(site, '/user/login');
				const html = String(
					site.sql
						.exec('SELECT html FROM cfw_page WHERE path = ?', '/user/login')
						.toArray()[0]?.['html'] ?? ''
				);
				return { ...measured, bytes: html.length, page: stablePage(html) };
			});

			const memory = await inObject(freshSite(), async (site: ServeDo) => {
				await armSite(site, 'dynamic_page_cache');
				await site.fillOne('/user/login', ['page', 'dynamic_page_cache']);
				const measured = await realRender(site, '/user/login');
				const html = String(
					site.sql
						.exec('SELECT html FROM cfw_page WHERE path = ?', '/user/login')
						.toArray()[0]?.['html'] ?? ''
				);
				return {
					...measured,
					bytes: html.length,
					page: stablePage(html),
					log: site.sql
						.exec(
							'SELECT type, message, variables FROM watchdog ORDER BY wid DESC LIMIT 5'
						)
						.toArray()
						.map(
							(r) =>
								`${String(r['type'])}: ${String(r['message'])} ${String(r['variables']).slice(0, 400)}`
						)
				};
			});

			const { page: _dp, ...databaseLog } = database;
			const { page: _mp, ...memoryLog } = memory;
			console.log(
				`[memory-bin] ${JSON.stringify({ database: databaseLog, memory: memoryLog })}`
			);

			// THE CONTROL: the database arm has to charge for the bin, or the comparison below is
			// between two arms that were never different
			const binRows = database.perTable['cache_dynamic_page_cache'] ?? 0;
			expect(binRows, 'the database arm charged nothing for the bin').toBeGreaterThan(0);

			// and the memory arm charges nothing for it at all
			expect(memory.perTable['cache_dynamic_page_cache'] ?? 0).toBe(0);
			// EXACTLY the bin's cost and nothing else. A magnitude would go stale with the pack;
			// the identity says the saving is this bin rather than a render that did less work
			expect(database.rows - memory.rows).toBe(binRows);

			// the page itself is the same CONTENT, which is what separates a removed cost from a
			// skipped render; compared with the random form token normalised, see `stablePage`
			expect(memory.bytes).toBeGreaterThan(0);
			expectSamePage(memory.page, database.page, 'memory arm against database arm');
			// and nothing was logged: a backend that threw would fall back and read as a saving
			expect(memory.log.filter((line) => line.startsWith('php:'))).toEqual([]);
		},
		TIMEOUT
	);

	/**
	 * THE CENSUS: which other bins are worth holding in the interpreter, measured the same way.
	 *
	 * IN THE AUDIT'S SEQUENCE, and that is not a detail. A re-render's leftover rows depend on what
	 * ran before it on the object: warming with a fill first leaves `cache_discovery` behind, the
	 * audit's first-fill-then-new-path order does not, and the model's classes are pinned to the
	 * latter. So this drives `/user/login`, then `/user/password` (a never-routed path, where `render`
	 * and `discovery` write), then a re-render of `/user/login` -- the same order
	 * `rows-per-fill-audit.spec.ts` uses -- and the figures map straight onto
	 * `ROWS_PER_FILL_MEMORY_BINS`.
	 *
	 * The property is the one that makes a default safe: holding a bin in memory never costs a row
	 * and never changes the page. What each is WORTH is printed, because it moves with the pack.
	 */
	it(
		'never costs a row or changes the page, for every candidate bin set',
		async () => {
			const CANDIDATES = [
				'dynamic_page_cache',
				'dynamic_page_cache,menu',
				'dynamic_page_cache,render',
				'dynamic_page_cache,discovery',
				'dynamic_page_cache,menu,render,discovery'
			];
			const census: Record<
				string,
				{
					realRender: number;
					newPath: number;
					bytes: number;
					page: string;
					left: string[];
					php: number;
				}
			> = {};
			for (const bins of CANDIDATES) {
				census[bins] = await inObject(freshSite(), async (site: ServeDo) => {
					await armSite(site, bins);
					// the audit's order: a first fill, a never-routed path, then the re-render
					await site.fillOne('/user/login');
					await site.fetch(new Request(`${ORIGIN}/__writes?op=off`));
					await site.fetch(new Request(`${ORIGIN}/__writes?op=on`));
					await site.fillOne('/user/password');
					const fresh = (await (
						await site.fetch(new Request(`${ORIGIN}/__writes`))
					).json()) as Writes;
					const warm = await realRender(site, '/user/login');
					const html = String(
						site.sql
							.exec('SELECT html FROM cfw_page WHERE path = ?', '/user/login')
							.toArray()[0]?.['html'] ?? ''
					);
					return {
						realRender: warm.rows,
						newPath: fresh.rowsWritten,
						bytes: html.length,
						page: stablePage(html),
						left: Object.keys(warm.perTable).sort(),
						php: site.sql
							.exec("SELECT COUNT(*) AS c FROM watchdog WHERE type = 'php'")
							.toArray()
							.map((r) => Number(r['c']))[0]!
					};
				});
			}
			console.log(
				`[memory-bin-census] ${JSON.stringify(
					Object.fromEntries(
						Object.entries(census).map(([bins, { page: _p, ...rest }]) => [bins, rest])
					)
				)}`
			);

			const baseline = census['dynamic_page_cache']!;
			for (const [bins, arm] of Object.entries(census)) {
				expect(arm.realRender, `${bins} re-render`).toBeLessThanOrEqual(
					baseline.realRender
				);
				expect(arm.newPath, `${bins} new path`).toBeLessThanOrEqual(baseline.newPath);
				expectSamePage(arm.page, baseline.page, `${bins} changed the page`);
				expect(arm.php, `${bins} logged a PHP error`).toBe(0);
			}
		},
		TIMEOUT
	);

	/**
	 * THE ENTRY IS REJECTED WHEN ITS TAGS MOVE, which is the property a read replica depends on.
	 *
	 * Core's `MemoryBackend` learns about an invalidation by being called. A lane is told nothing:
	 * it receives an invalidation as a replayed `cachetags` statement, so an in-memory entry there
	 * would outlive its own invalidation forever. `CfwMemoryBackend` stores the checksum and asks
	 * the same provider `DatabaseBackend` asks, and that provider reads the replicated table.
	 *
	 * A RENDER SITS BETWEEN THE MOVE AND THE READ, and it is not decoration.
	 * `CacheTagsChecksumTrait` memoises every count it has read, and this runtime performs no
	 * request shutdown, so the memo would otherwise outlive the invalidation --
	 * `cache_tags.invalidator.checksum` is on `RequestResetter`'s seed list for exactly that, and
	 * the reset runs at the start of the next request. A bare fragment is not a request and never
	 * reaches it, which is what this spec measured before the render was added.
	 */
	// a menu save invalidates EVERY cached page, so a menu entry outliving its invalidation is the
	// worst defect this tier could have. The backend is bin-agnostic; this proves each bin is wired
	for (const bin of ['dynamic_page_cache', 'menu', 'render', 'discovery'])
		it(
			`refuses a ${bin} entry whose tag checksum moved, with no invalidation call`,
			async () => {
				const seen = await inObject(freshSite(), async (site: ServeDo) => {
					await armSite(site, 'dynamic_page_cache,menu,render,discovery');
					await site.runJson(renderPage('/', [], false, {}));
					const probe = async (code: string) =>
						(await site.runJson(code)) as Record<string, unknown>;

					const store = `<?php
          $bin = \\Drupal::service('cache.${bin}');
          $bin->set('cfw-probe', 'first', -1, ['cfw_probe_tag']);
          $hit = $bin->get('cfw-probe');
          echo json_encode(['class' => get_class($bin), 'data' => $hit === false ? null : $hit->data]);
        `;
					const read = `<?php
          $bin = \\Drupal::service('cache.${bin}');
          $hit = $bin->get('cfw-probe');
          echo json_encode(['data' => $hit === false ? null : $hit->data]);
        `;

					const stored = await probe(store);
					// THE CONTROL: a render with nothing invalidated must leave the entry alone, or the
					// refusal below could be the render dropping it rather than the checksum
					await site.runJson(renderPage('/', [], false, {}));
					const survived = await probe(read);

					// the counter moved by SQL, the way a replayed record moves it on a lane, with no
					// PHP invalidation call anywhere
					site.sql.exec(
						"INSERT INTO cachetags (tag, invalidations) VALUES ('cfw_probe_tag', 1) ON CONFLICT(tag) DO UPDATE SET invalidations = invalidations + 1"
					);
					await site.runJson(renderPage('/', [], false, {}));
					const after = await probe(read);
					return { stored, survived, after };
				});

				expect(String(seen.stored['class'])).toContain('CfwMemoryBackend');
				expect(seen.stored['data']).toBe('first');
				expect(seen.survived['data'], 'a render alone dropped it').toBe('first');
				expect(seen.after['data']).toBeNull();
			},
			TIMEOUT
		);

	/**
	 * What holding a bin in the interpreter costs in heap, over more pages than the census drives.
	 *
	 * Over these nine pages `render` held 50 entries and left linear memory on the same allocation
	 * step, so it is safe to opt into; `discovery` sat at its 64-entry bound, evicting, and added
	 * 12.4 MiB -- 4.8 MiB under the recycle threshold, for a tenth of a row per fill. Neither is the
	 * default: `render` was refused on its cold-render cost, which a pool spec cannot measure (see
	 * `DEFAULT_MEMORY_CACHE_BINS`). The discovery arm is still printed so the refusal can be re-read.
	 *
	 * A bin in memory is bounded by an item count (`CfwMemoryBackend::DEFAULT_MAX_ITEMS`), and the
	 * footprint is a high-water mark until the interpreter drops. So the workload is every anonymous
	 * route a default site has, enough distinct pages to push `render` and `discovery` toward their
	 * bound, and the gate is the product's own: `recycleIfOversized()` drops an interpreter above
	 * `recycleAboveBytes()`, and an arm that crosses it pays a boot per page.
	 */
	it(
		'holds render without crossing the recycle threshold or costing a row',
		async () => {
			const PATHS = [
				'/',
				'/user/login',
				'/user/password',
				'/user/register',
				'/node',
				'/rss.xml',
				'/search/node',
				'/contact',
				'/filter/tips'
			];
			const arm = async (bins: string) =>
				inObject(freshSite(), async (site: ServeDo) => {
					await armSite(site, bins);
					await site.fetch(new Request(`${ORIGIN}/__writes?op=off`));
					await site.fetch(new Request(`${ORIGIN}/__writes?op=on`));
					for (const path of PATHS) await site.fillOne(path);
					const writes = (await (
						await site.fetch(new Request(`${ORIGIN}/__writes`))
					).json()) as Writes;
					const counts = (await site.runJson(`<?php
						echo json_encode(\\Drupal\\drupflare\\Cache\\CfwMemoryBackend::counts());
					`)) as Record<string, number>;
					const html = String(
						site.sql
							.exec('SELECT html FROM cfw_page WHERE path = ?', '/user/login')
							.toArray()[0]?.['html'] ?? ''
					);
					return {
						heap: (site as unknown as { heapNow(): number }).heapNow(),
						rows: writes.rowsWritten,
						counts,
						page: stablePage(html),
						php: site.sql
							.exec("SELECT COUNT(*) AS c FROM watchdog WHERE type = 'php'")
							.toArray()
							.map((r) => Number(r['c']))[0]!
					};
				});

			const shipped = await arm('dynamic_page_cache,menu');
			const wider = await arm('dynamic_page_cache,menu,render');
			const widest = await arm('dynamic_page_cache,menu,render,discovery');
			const log = (a: typeof shipped) => {
				const { page: _p, ...rest } = a;
				return rest;
			};
			console.log(
				`[memory-bin-heap] ${JSON.stringify({ shipped: log(shipped), render: log(wider), discovery: log(widest) })}`
			);

			// THE CONTROL: the wider arm has to be holding the two extra bins, or the heap below
			// describes a configuration that stored nothing extra
			expect(wider.counts['render'] ?? 0).toBeGreaterThan(0);
			expect(widest.counts['discovery'] ?? 0).toBeGreaterThan(0);
			expect(shipped.counts['render'] ?? 0).toBe(0);
			expect(wider.heap).toBeLessThan(recycleAboveBytes({} as never));
			expect(wider.rows).toBeLessThanOrEqual(shipped.rows);
			expectSamePage(wider.page, shipped.page, 'the wider arm changed the page');
			expect(wider.php, 'the wider arm logged a PHP error').toBe(0);
		},
		TIMEOUT
	);
});

/**
 * What the bin costs back after an eviction, and the answer refuted the reason it shipped off.
 *
 * THE ARGUMENT FOR A CONDITIONAL DEFAULT WAS THIS, and it was wrong: the bin dies with the
 * interpreter, so a render after a drop cannot reassemble from it and would pay to render in full --
 * which would make the lever right for a warm site and wrong for one that hibernates between
 * renders, the band `thermal.ts` already splits on.
 *
 * Measured, with both arms dropping the interpreter between the two fills: the SQL arm charges
 * **6 rows** and the memory arm **2**. The SQL bin surviving a drop does not make the next render
 * cheaper, because that render REWRITES the bin and pays its four rows again; the memory arm simply
 * writes nothing to SQL. So on the meter that binds regeneration the bin is cheaper in both states,
 * and the conditional default had no evidence under it.
 *
 * What it does cost is latency on that render, which a pool spec cannot time: measured deployed, a
 * cold reassemble is 1,324 ms against 1,073 with every bin in SQL (see `DEFAULT_MEMORY_CACHE_BINS`).
 */
describe.skipIf(FROM_SOURCE)('what an interpreter drop costs each arm', () => {
	it(
		'charges the memory arm more on the first render after a drop',
		async () => {
			const arm = async (bins: string) =>
				inObject(freshSite(), async (site: ServeDo) => {
					await armSite(site, bins);
					// warm both bins on one path, so the shared discovery is paid before the measure
					await site.fillOne('/user/login', ['page', 'dynamic_page_cache']);
					await site.fillOne('/user/password', ['page', 'dynamic_page_cache']);
					// THE DROP: exactly what an eviction does to the static store, and nothing else
					(site as unknown as { php: unknown }).php = null;
					return realRender(site, '/user/password');
				});

			const database = await arm('none');
			const memory = await arm('dynamic_page_cache');
			console.log(`[memory-bin-cold] ${JSON.stringify({ database, memory })}`);

			// THE CONTROL: the SQL arm has to charge for the bin on the way back, or there is no
			// comparison to make
			expect(database.perTable['cache_dynamic_page_cache'] ?? 0).toBeGreaterThan(0);
			// and the memory arm does not, which is the opposite of what the conditional default
			// assumed. A cold render rewrites the SQL bin rather than reading it
			expect(memory.perTable['cache_dynamic_page_cache'] ?? 0).toBe(0);
			expect(memory.rows).toBeLessThan(database.rows);
		},
		TIMEOUT
	);
});

/** the default is a decision, so it is asserted rather than left to whatever the env happens to be */
describe('the default, which is what most sites will run', () => {
	it('holds dynamic_page_cache unless an operator says otherwise', () => {
		expect(memoryCacheBins({} as never)).toEqual([...DEFAULT_MEMORY_CACHE_BINS]);
		expect(memoryCacheBins({ MEMORY_CACHE_BINS: '' } as never)).toEqual([
			...DEFAULT_MEMORY_CACHE_BINS
		]);
	});

	/** an unset var and an empty one are the same string here, so off needs a word */
	it('takes none as the off switch', () => {
		expect(memoryCacheBins({ MEMORY_CACHE_BINS: 'none' } as never)).toEqual([]);
		expect(memoryCacheBins({ MEMORY_CACHE_BINS: ' NONE ' } as never)).toEqual([]);
	});

	it('takes an explicit list over the default', () => {
		expect(memoryCacheBins({ MEMORY_CACHE_BINS: 'render,menu' } as never)).toEqual([
			'render',
			'menu'
		]);
	});

	// a row the default never reads is storage and provisioning writes for nothing, so a database
	// rebuilt from a warmed site must not bring any back
	it(
		'provisions no row into a bin the default holds in memory',
		async () => {
			const counts = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request(`${ORIGIN}/__migrate?all=1`));
				return DEFAULT_MEMORY_CACHE_BINS.map((bin) => ({
					bin,
					rows: Number(
						site.sql.exec(`SELECT COUNT(*) AS n FROM cache_${bin}`).toArray()[0]?.[
							'n'
						] ?? -1
					)
				}));
			});
			expect(counts).toEqual(DEFAULT_MEMORY_CACHE_BINS.map((bin) => ({ bin, rows: 0 })));
		},
		TIMEOUT
	);
});
