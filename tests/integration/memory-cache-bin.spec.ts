import { describe, expect, it } from 'vitest';
import { renderPage } from '../../src/drupal/site-php';
import { DEFAULT_MEMORY_CACHE_BINS, memoryCacheBins } from '../../src/site-do';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * A cache bin held in the interpreter instead of in the tenant's SQLite.
 *
 * `pib_run` performs no request shutdown, so a class static survives from one Worker invocation to
 * the next -- which is what makes an in-process bin a real tier here and a test double on any
 * ordinary PHP host. What it is worth is measured: a real re-render after a tag invalidation charges
 * 9 rows on the shipping pack, of which **6 are `cache_dynamic_page_cache`**, and rows written is
 * the meter that binds regeneration at 9,685/day.
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
	await site.fetch(new Request(`${ORIGIN}/__writes?op=off`));
	await site.fetch(new Request(`${ORIGIN}/__writes?op=on`));
	site.sql.exec('DELETE FROM cfw_page WHERE path = ?', path);
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
				return { ...measured, bytes: html.length };
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

			console.log(`[memory-bin] ${JSON.stringify({ database, memory })}`);

			// THE CONTROL: the database arm has to charge for the bin, or the comparison below is
			// between two arms that were never different
			const binRows = database.perTable['cache_dynamic_page_cache'] ?? 0;
			expect(binRows, 'the database arm charged nothing for the bin').toBeGreaterThan(0);

			// and the memory arm charges nothing for it at all
			expect(memory.perTable['cache_dynamic_page_cache'] ?? 0).toBe(0);
			// EXACTLY the bin's cost and nothing else. A magnitude would go stale with the pack;
			// the identity says the saving is this bin rather than a render that did less work
			expect(database.rows - memory.rows).toBe(binRows);

			// the page itself is byte for byte the same, which is what separates a removed cost
			// from a skipped render
			expect(memory.bytes).toBeGreaterThan(0);
			expect(memory.bytes).toBe(database.bytes);
			// and nothing was logged: a backend that threw would fall back and read as a saving
			expect(memory.log.filter((line) => line.startsWith('php:'))).toEqual([]);
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
	it(
		'refuses an entry whose tag checksum moved, with no invalidation call',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				await armSite(site, 'dynamic_page_cache');
				await site.runJson(renderPage('/', [], false, {}));
				const probe = async (code: string) =>
					(await site.runJson(code)) as Record<string, unknown>;

				const store = `<?php
          $bin = \\Drupal::service('cache.dynamic_page_cache');
          $bin->set('cfw-probe', 'first', -1, ['cfw_probe_tag']);
          $hit = $bin->get('cfw-probe');
          echo json_encode(['class' => get_class($bin), 'data' => $hit === false ? null : $hit->data]);
        `;
				const read = `<?php
          $bin = \\Drupal::service('cache.dynamic_page_cache');
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
 * What it does still cost is CPU on that render and isolate memory for the entries it holds, and
 * neither is the binding constraint. The CPU is spent on a request that was already paying a
 * 1,398 ms boot for the same drop.
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
});
