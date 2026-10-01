import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { harvestShell, renderFragments } from '../../src/drupal/site-php';
import { takeSpareMemory } from '../../src/site-do';
import { claimSite, loginJar } from '../helpers/drupal-forms';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What one request costs BEFORE the render pipeline runs, on the shipping interpreter.
 *
 * Every compiled-render-plan proposal is bounded by this ladder. A plan can only replace
 * pipeline work, so if serving a request that renders nothing already spends most of the
 * budget the direction is capped no matter how good the plan is.
 *
 * Four arms on ONE object, interleaved and reversed on alternate rounds so no arm always
 * sits after a purge:
 *
 *   full  - `page` + `dynamic_page_cache` emptied; the whole pipeline runs
 *   dpc   - `page` emptied only; `dynamic_page_cache` answers and render arrays are reused
 *   pgc   - nothing emptied; Drupal's own `page_cache` middleware answers
 *   bare  - `/session/token`, whose controller returns a Response with no render array
 *   purge - the same bare route WITH both bins emptied, which prices the emptying itself
 *
 * Each arm re-establishes its own precondition in an UNTIMED call first. Without that the
 * arms feed each other: `full` empties both bins, so the `dpc` arm behind it in the same
 * round misses and the `pgc` arm can never hit at all. The first pass read `dpc` and `pgc`
 * as the same 12 ms for exactly that reason.
 *
 * `renderMs` is PHP's `microtime()` inside the object. workerd's clock is 1 ms granular, so
 * every arm is reported as min/p25/median over n rounds and the spread is the resolution.
 * Nothing here is an absolute CPU figure; RULE 0 still reserves those for `cpuTime` on a
 * deployed worker. The load-bearing quantities are the DIFFERENCES between arms.
 *
 * Not part of the gate: a wall-clock reading cannot be hermetic. Run it with
 * `DRUPFLARE_MEASURE=1 bunx vitest run --project=workers tests/integration/render-floor-ladder.spec.ts`.
 */

const TIMEOUT = 900_000;
const MEASURING = (env as { DRUPFLARE_MEASURE?: string }).DRUPFLARE_MEASURE === '1';
const ROUNDS = Number((env as { DRUPFLARE_LADDER_N?: string }).DRUPFLARE_LADDER_N ?? '25');

const ROUTE = '/user/login';
const BARE = '/session/token';

type Arm = { renderMs: number; bytes: number; page: string; dynamic: string };

function stat(ms: number[]): Record<string, number> {
	const s = [...ms].sort((a, b) => a - b);
	const q = (p: number) => s[Math.floor(p * (s.length - 1))];
	return { n: s.length, min: q(0)!, p25: q(0.25)!, median: q(0.5)!, p75: q(0.75)! };
}

describe.skipIf(!MEASURING)('the fixed floor under a render, on the shipping interpreter', () => {
	it(
		'prices a full render against a dynamic-page-cache hit, a page-cache hit and a bare route',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							adminPass: 'cfw-Ladder-9931-pass',
							siteName: 'Ladder'
						})
					})
				);
				expect(first.status, await first.clone().text()).toBe(200);

				const run = async (path: string, bins: string[]): Promise<Arm> => {
					const r = (await site.fillOne(path, bins)) as unknown as Record<
						string,
						unknown
					>;
					return {
						renderMs: Number(r.renderMs ?? -1),
						bytes: Number(r.bytes ?? 0),
						page: String(r.pageCache ?? '-'),
						dynamic: String(r.dynamicCache ?? '-')
					};
				};

				const both = ['page', 'dynamic_page_cache'];
				const arms: Record<string, () => Promise<Arm>> = {
					full: () => run(ROUTE, both),
					dpc: async () => {
						await run(ROUTE, both);
						return run(ROUTE, ['page']);
					},
					pgc: async () => {
						await run(ROUTE, ['page']);
						return run(ROUTE, []);
					},
					bare: () => run(BARE, []),
					purge: () => run(BARE, both)
				};
				const names = Object.keys(arms);

				// warm every arm's caches, and the interpreter, before any clock starts
				for (let i = 0; i < 3; i++) for (const k of names) await arms[k]!();

				const samples: Record<string, number[]> = {};
				const facts: Record<string, Arm> = {};
				for (const k of names) samples[k] = [];
				for (let i = 0; i < ROUNDS; i++) {
					const order = i % 2 === 0 ? names : [...names].reverse();
					for (const k of order) {
						const a = await arms[k]!();
						samples[k]!.push(a.renderMs);
						facts[k] ??= a;
					}
				}
				return { samples, facts };
			});

			const rows = Object.fromEntries(
				Object.entries(out.samples).map(([k, v]) => [k, { ...stat(v), ...out.facts[k] }])
			);
			// eslint-disable-next-line no-console
			console.log(JSON.stringify({ rounds: ROUNDS, route: ROUTE, arms: rows }, null, 2));

			// the arms have to BE what they are named, or the ladder measures one thing five times
			expect(out.facts.full!.dynamic).toBe('MISS');
			expect(out.facts.dpc!.dynamic).toBe('HIT');
			// NOT asserted as a page_cache HIT. `/user/login` is a form, and `FormBuilder` marks the
			// response uncacheable, so this arm degenerates into the `dpc` arm on that route and
			// reports what it really was rather than pretending
			expect(out.facts.pgc!.dynamic).toBe('HIT');
			expect(out.facts.bare!.bytes).toBeLessThan(500);
			expect(out.facts.full!.bytes).toBeGreaterThan(2000);
		},
		TIMEOUT
	);
});

/**
 * The ladder's arms, at n=1 and with no clock read.
 *
 * The measurement above is off in the gate for a real reason -- a wall-clock reading cannot be
 * hermetic -- but that left the arms themselves unchecked on every commit, and an arm that stops
 * being what it is named turns the whole table into one thing measured five times. The arms ARE
 * deterministic; only their durations are not.
 */
describe('the ladder arms are what they are named', () => {
	it(
		'separates a full render, a dynamic-page-cache hit and a bare route',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const both = ['page', 'dynamic_page_cache'];
				const run = async (path: string, bins: string[]): Promise<Arm> => {
					const r = (await site.fillOne(path, bins)) as unknown as Record<
						string,
						unknown
					>;
					return {
						renderMs: Number(r.renderMs ?? -1),
						bytes: Number(r.bytes ?? 0),
						page: String(r.pageCache ?? '-'),
						dynamic: String(r.dynamicCache ?? '-')
					};
				};

				const full = await run(ROUTE, both);
				// the precondition the arm carries in the measurement: `full` has just emptied both
				// bins, so this one hits what it left behind
				const dpc = await run(ROUTE, ['page']);
				const bare = await run(BARE, []);
				return { full, dpc, bare };
			});

			expect(out.full.dynamic).toBe('MISS');
			expect(out.dpc.dynamic).toBe('HIT');
			expect(out.full.bytes).toBeGreaterThan(2000);
			expect(out.bare.bytes).toBeLessThan(500);
			// the instrument still reports a reading rather than the -1 a missing field would give;
			// its VALUE is not assertable here and is not asserted
			for (const arm of [out.full, out.dpc, out.bare]) {
				expect(Number.isFinite(arm.renderMs)).toBe(true);
				expect(arm.renderMs).toBeGreaterThanOrEqual(0);
			}
		},
		TIMEOUT
	);
});

/** one FNV-1a hash per 64 KiB page, the unit gmux diffs its checkpoints by */
function pageHashes(buf: ArrayBuffer): Uint32Array {
	const words = new Uint32Array(buf);
	const perPage = 16_384;
	const out = new Uint32Array(words.length / perPage);
	for (let p = 0; p < out.length; p++) {
		let h = 0x811c9dc5;
		for (let i = p * perPage; i < (p + 1) * perPage; i++)
			h = Math.imul(h ^ words[i]!, 16777619);
		out[p] = h >>> 0;
	}
	return out;
}

/**
 * Where an admin render's time and memory go, which is what decides whether splitting it pays.
 *
 * Asked by the parallel-render and heap-fork proposals (roadmap, v1.1). For each page, on a fresh
 * 64 MiB interpreter with the kernel booted: the render up to the BigPipe cut, the placeholders
 * after it, the same render again on the now-warm interpreter, the page's main view alone, and how
 * many 64 KiB pages of the heap the first render changed. Read 2026-09-30 on the stock site: the cut
 * holds 96-100% of the growth, the warm render is 72-102 ms against ~1.5 s cold, and one render
 * dirties ~60% of the heap, so the first render is warm-up any fork inherits.
 */
describe.skipIf(!MEASURING)('where an admin render spends its time and memory', () => {
	it(
		'splits the render at the placeholder cut, cold against warm, and counts the pages it dirties',
		async () => {
			const heapBytes = async (site: ServeDo) =>
				Number(
					(
						(await (
							await site.fetch(new Request('https://do.local/__heap?op=status'))
						).json()) as {
							linearMemoryBytes?: number;
						}
					).linearMemoryBytes ?? 0
				);
			const memory = (site: ServeDo) =>
				(site as unknown as { php: { binary: { wasmMemory: WebAssembly.Memory } } }).php
					.binary.wasmMemory;
			const origin = 'https://do.local';
			const rows: Record<string, unknown>[] = [];
			for (const [path, view, display] of [
				['/admin/content', 'content', 'page_1'],
				['/admin/people', 'user_admin_people', 'page_1'],
				['/admin/reports/dblog', 'watchdog', 'page']
			] as const) {
				rows.push(
					await inObject(freshSite(), async (site: ServeDo) => {
						await claimSite(site, 'cfw-Ladder-Pass-5521');
						const jar = await loginJar(site, 'admin', 'cfw-Ladder-Pass-5521', origin);
						(site as unknown as { php: unknown }).php = undefined;
						takeSpareMemory();
						await site.runJson(renderFragments(path, {}, { cookie: jar, origin }));
						const booted = await heapBytes(site);
						const base = pageHashes(memory(site).buffer.slice(0));
						const cold = (await site.runJson(
							harvestShell(path, { cookie: jar, origin })
						)) as Record<string, unknown>;
						const cut = await heapBytes(site);
						const after = pageHashes(memory(site).buffer.slice(0));
						const holes = (await site.runJson(
							renderFragments(
								path,
								(cold['recipes'] ?? {}) as Record<string, unknown>,
								{
									cookie: jar,
									origin
								}
							)
						)) as Record<string, unknown>;
						const filled = await heapBytes(site);
						const warm = (await site.runJson(
							harvestShell(path, { cookie: jar, origin })
						)) as Record<string, unknown>;
						const alone = (await site.runJson(
							`<?php $t = microtime(true); $b = views_embed_view('${view}', '${display}'); \\Drupal::service('renderer')->renderRoot($b); echo json_encode(['ms' => round((microtime(true) - $t) * 1000, 1)]);`
						)) as Record<string, unknown>;
						let changed = 0;
						for (let p = 0; p < base.length; p++) if (base[p] !== after[p]) changed++;
						return {
							path,
							status: cold['status'],
							placeholders: cold['recipeCount'],
							coldMs: cold['harvestMs'],
							warmMs: warm['harvestMs'],
							viewMs: alone['ms'],
							cutMiB: (cut - booted) / 1_048_576,
							placeholderMiB: (filled - cut) / 1_048_576,
							dirtyPct: (100 * (changed + after.length - base.length)) / after.length
						};
					})
				);
			}
			console.log(`[render-phases] ${JSON.stringify(rows)}`);
			for (const row of rows) {
				expect(row.status).toBe(200);
				expect(row.dirtyPct as number).toBeGreaterThan(0);
				expect(Number.isFinite(row.warmMs as number)).toBe(true);
			}
		},
		TIMEOUT
	);
});
