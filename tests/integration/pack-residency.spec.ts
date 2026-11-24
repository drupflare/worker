import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { assetRequestCounts, lazyMountBytes } from '../../src/do/lazy-mount';
import { drupalOp, renderPage, type RenderRequest } from '../../src/drupal/php/site';
import type { SitePhpDurableObject } from '../../src/site-do';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';
import { WP_ORIGIN, configureWordpress } from '../helpers/wordpress-php';

/**
 * What the object's pack and files cost the isolate and the row meters, per route, per arm.
 *
 * `DRUPFLARE_MEASURE=1 bunx vitest run --project=workers --reporter=verbose
 * tests/integration/pack-residency.spec.ts` prints one table per CMS. Counts and bytes only: a
 * local clock says nothing about the platform's CPU. Rows read are summed from the cursors the
 * object's own statements returned, so a cursor that was never drained reads low.
 */

const TIMEOUT = 3_600_000;
const MEASURING = (env as { DRUPFLARE_MEASURE?: string }).DRUPFLARE_MEASURE === '1';
const REPS = 3;
const MIB = 1_048_576;
const PASS = 'cfw-Resid-5512-pass';

type Cursor = { rowsRead: number; rowsWritten: number };
type Tapped = { text: string; cursor: Cursor };
type Sample = Record<string, number>;

/** replaces the object's `sql` with one that remembers every cursor it hands out */
function tap(site: SitePhpDurableObject) {
	const real = site.sql;
	const seen: Tapped[] = [];
	const exec = (text: string, ...params: unknown[]) => {
		const cursor = (real.exec as (...a: unknown[]) => Cursor)(text, ...params);
		seen.push({ text, cursor });
		return cursor;
	};
	site.sql = new Proxy(real, {
		get(target, prop) {
			if (prop === 'exec') return exec;
			const value = Reflect.get(target, prop);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return {
		mark: () => void (seen.length = 0),
		read(): Sample {
			let read = 0;
			let written = 0;
			let packRead = 0;
			let packWritten = 0;
			for (const { text, cursor } of seen) {
				read += cursor.rowsRead;
				written += cursor.rowsWritten;
				if (text.includes('cfw_pack_')) {
					packRead += cursor.rowsRead;
					packWritten += cursor.rowsWritten;
				}
			}
			return { statements: seen.length, read, written, packRead, packWritten };
		}
	};
}

/** everything one route leaves behind: the row meters and what the mount reports */
async function observe(
	site: SitePhpDurableObject,
	meter: ReturnType<typeof tap>,
	run: () => Promise<unknown>
): Promise<Sample> {
	await run();
	const rows = meter.read();
	const lazy = lazyMountBytes(site.mountInfo);
	const stats = (await (
		await (site as unknown as ServeDo).fetch(new Request('https://do.local/__serve-stats'))
	).json()) as { isolateBytes?: Record<string, number> };
	const assets = assetRequestCounts();
	return {
		...rows,
		blob: lazy.blob,
		resident: lazy.resident,
		highWater: lazy.highWater,
		inflated: lazy.inflated,
		inflatedBytes: lazy.inflatedBytes,
		evicted: lazy.evicted,
		reinflated: lazy.reinflated,
		isolateMount: stats.isolateBytes?.['mount'] ?? 0,
		isolateIndex: stats.isolateBytes?.['index'] ?? 0,
		isolateResident: stats.isolateBytes?.['resident'] ?? 0,
		packFetched: assets.packFetched,
		packReused: assets.packReused
	};
}

const median = (values: number[]) => {
	const s = [...values].sort((a, b) => a - b);
	return s.length % 2
		? (s[s.length >> 1] as number)
		: ((s[s.length / 2 - 1] as number) + (s[s.length / 2] as number)) / 2;
};

/** `p50 (min-max)` of one field across the reps of a cell */
function cell(samples: Sample[], field: string, scale = 1): string {
	const v = samples.map((s) => (s[field] ?? 0) / scale);
	const round = (x: number) => (scale === 1 ? String(x) : x.toFixed(2));
	return `${round(median(v))} (${round(Math.min(...v))}-${round(Math.max(...v))})`;
}

const FIELDS: [string, string, number][] = [
	['blobMiB', 'blob', MIB],
	['resMiB', 'resident', MIB],
	['hwMiB', 'highWater', MIB],
	['opened', 'inflated', 1],
	['evicted', 'evicted', 1],
	['reinfl', 'reinflated', 1],
	['rowsRead', 'read', 1],
	['packRead', 'packRead', 1],
	['rowsWritten', 'written', 1]
];

function print(title: string, table: Map<string, Sample[]>) {
	const lines = [`[pack-residency] ${title} (n=${REPS} per cell, p50 (min-max))`];
	for (const [key, samples] of table) {
		const cols = FIELDS.map(
			([label, field, scale]) => `${label}=${cell(samples, field, scale)}`
		);
		lines.push(`  ${key.padEnd(40)} ${cols.join('  ')}`);
	}
	console.log(lines.join('\n'));
}

const form = (cookie: string, body: string): RenderRequest => ({
	method: 'POST',
	body,
	contentType: 'application/x-www-form-urlencoded',
	cookie
});

type Arm = { coldPack: boolean; budget: number; cache?: number };

const DRUPAL_ARMS: Arm[] = [20, 12, 8, 4, 2, 1]
	.map((m): Arm => ({ coldPack: true, budget: m * MIB }))
	.concat([
		{ coldPack: true, budget: 4 * MIB, cache: 32 },
		{ coldPack: true, budget: 4 * MIB, cache: 64 },
		{ coldPack: false, budget: 20 * MIB },
		{ coldPack: false, budget: 4 * MIB }
	]);

async function drupalRep(arm: Arm, table: Map<string, Sample[]>) {
	await inObject(freshSite(), async (obj: ServeDo) => {
		const site = obj as unknown as SitePhpDurableObject;
		site.env = {
			...site.env,
			COLD_PACK: arm.coldPack ? '1' : '0',
			LAZY_FS_BUDGET_BYTES: String(arm.budget),
			...(arm.cache ? { COLD_PACK_CACHE_CHUNKS: String(arm.cache) } : {})
		};
		const meter = tap(site);
		await obj.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		await obj.fetch(
			new Request('https://do.local/__firstrun', {
				method: 'POST',
				body: JSON.stringify({ adminPass: PASS, siteName: 'Resid' }),
				headers: { 'content-type': 'application/json' }
			})
		);
		const login = await obj.runJson(
			renderPage(
				'/user/login',
				[],
				false,
				form(
					'',
					`name=admin&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`
				)
			)
		);
		const lines = Array.isArray(login['setCookie']) ? (login['setCookie'] as string[]) : [];
		const cookie = (lines.find((l) => /^S?SESS/.test(l)) ?? '').split(';')[0] ?? '';
		const label = `${arm.coldPack ? 'on ' : 'off'} ${String(arm.budget / MIB).padStart(2)} MiB c${arm.cache ?? 8}`;
		const stagedRows = meter.read();
		const add = (route: string, phase: string, sample: Sample) => {
			const key = `${label} ${route} ${phase}`;
			table.set(key, [...(table.get(key) ?? []), sample]);
		};
		add('stage', 'once', { ...stagedRows, blob: 0 });

		const routes: [string, () => Promise<unknown>][] = [
			['front', () => obj.runJson(renderPage('/', [], false, {}))],
			['login', () => obj.runJson(renderPage('/user/login', [], false, {}))],
			['auth-front', () => obj.runJson(renderPage('/', [], false, { cookie }))],
			['admin', () => obj.runJson(renderPage('/admin/content', [], false, { cookie }))],
			[
				'status',
				() => obj.runJson(renderPage('/admin/reports/status', [], false, { cookie }))
			],
			[
				'flush',
				() => obj.runJson(drupalOp('drupal_flush_all_caches(); $out["flushed"] = true;'))
			],
			[
				'cron',
				() =>
					obj.runJson(drupalOp('\\Drupal::service("cron")->run(); $out["cron"] = true;'))
			]
		];
		for (const [route, run] of routes) {
			site.dropInterpreter();
			meter.mark();
			add(route, 'cold', await observe(site, meter, run));
			meter.mark();
			add(route, 'warm', await observe(site, meter, run));
		}
	});
}

describe.skipIf(!MEASURING)('pack and file residency, stock Drupal', () => {
	it(
		'reads the mount and the row meters per route and arm',
		async () => {
			const table = new Map<string, Sample[]>();
			for (const arm of DRUPAL_ARMS) {
				// the pack copy a run with the flag off fetches would stay in this isolate's cache
				if (
					!arm.coldPack &&
					DRUPAL_ARMS.indexOf(arm) === DRUPAL_ARMS.findIndex((a) => !a.coldPack)
				) {
					console.log(
						`[pack-residency] assets after the on arms ${JSON.stringify(assetRequestCounts())}`
					);
				}
				for (let rep = 0; rep < REPS; rep++) await drupalRep(arm, table);
			}
			print('drupal', table);
			const counts = assetRequestCounts();
			console.log(`[pack-residency] assets ${JSON.stringify(counts)}`);
			expect(table.size).toBeGreaterThan(0);
		},
		TIMEOUT
	);
});

describe.skipIf(!MEASURING)('pack and file residency, WordPress', () => {
	it(
		'reads the mount and the row meters per route and budget',
		async () => {
			const table = new Map<string, Sample[]>();
			const arms: Arm[] = [
				{ coldPack: true, budget: 4 * MIB },
				{ coldPack: true, budget: 2 * MIB },
				{ coldPack: false, budget: 20 * MIB },
				{ coldPack: false, budget: 4 * MIB }
			];
			for (const { coldPack, budget } of arms) {
				for (let rep = 0; rep < REPS; rep++) {
					await inObject(freshSite(), async (obj: ServeDo) => {
						const wp = await configureWordpress(obj, {
							COLD_PACK: coldPack ? '1' : '0',
							LAZY_FS_BUDGET_BYTES: String(budget)
						});
						const site = wp as unknown as SitePhpDurableObject;
						const meter = tap(site);
						for (const path of ['/', '/wp-login.php', '/?s=hello', '/feed/']) {
							meter.mark();
							const sample = await observe(site, meter, () =>
								wp.fillOne(path, undefined, undefined, { origin: WP_ORIGIN })
							);
							const key = `wp ${coldPack ? 'on ' : 'off'} ${String(budget / MIB).padStart(2)} MiB ${path} cold`;
							table.set(key, [...(table.get(key) ?? []), sample]);
						}
					});
				}
			}
			print('wordpress', table);
			expect(table.size).toBeGreaterThan(0);
		},
		TIMEOUT
	);
});
