import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import ignoreSource from '../../../assets/.assetsignore?raw';
import lazyFsSource from '../../../node_modules/@drupflare/cartridge/src/lazy-fs.ts?raw';
import wranglerSource from '../../../wrangler.jsonc?raw';

/**
 * The canonical config's asset set, pinned against the canonical vars.
 *
 * The defect this exists for: `wrangler.jsonc` is the config `bun run deploy`, `bun run dev`,
 * the vitest pool and the Deploy to Cloudflare button all use, and its `assets.directory` was
 * the whole 97 MB / 317 file `assets/` tree. A 48 MB attempt failed with a connectivity error
 * after ~49 s, so the canonical config could not deploy at all -- and separately, Workers
 * assets are served publicly, so it also published `/drupal/site.sqlite` (the entire site
 * database) and every measurement fixture next to it.
 *
 * `assets/.assetsignore` fixes both without a staging directory or a parallel config. What can
 * silently rot is the DERIVATION: the subset is only correct for `LAZY_MOUNT=1` with the
 * default `MIGRATE_ENGINE`, so the vars and the ignore file have to agree. These tests are the
 * thing that fails when they stop agreeing.
 *
 * Reached through the real `ASSETS` binding rather than by reimplementing gitignore matching:
 * the pool serves `assets/` through the same `.assetsignore` wrangler uploads through, so a
 * 404 here is the same 404 the edge would give.
 */

/** Every path the shipping runtime fetches through ASSETS, with the call site that fetches it. */
const SHIPPING = [
	['/driver.json', 'mountDriver, src/runtime/mount.ts'],
	['/prefill.json', 'prefill seed, src/site-do.ts'],
	['/drupal-pf/core.pf.json', 'mountDrupalLazy, src/runtime/lazy-fs.ts'],
	['/drupal-pf/core.pf.bin', 'mountDrupalLazy, src/runtime/lazy-fs.ts'],
	['/drupal-sql/manifest.json', 'assetChunkLoader, src/db/migrate-sql.ts'],
	['/drupal-sql/0000.json', 'assetChunkLoader, src/db/migrate-sql.ts']
] as const;

/**
 * Assets that exist on disk and must NOT be uploaded.
 *
 * `drupal/site.sqlite` is the disclosure half: it is the hand-trimmed site database, and it
 * was reachable at a guessable URL. The rest are measurement fixtures and alternate packs
 * that no shipping call site reads.
 */
const WITHHELD = [
	'/drupal/site.sqlite',
	'/drupal/core.bin.gz',
	'/drupal/core.json',
	'/drupal-std/site.sqlite',
	'/drupal-min/core.bin.gz',
	'/drupal-trim/core.pf.bin',
	'/probe/pw-probe.php',
	'/pack.bin',
	'/lib/gen0.php'
];

const asset = (path: string) => env.ASSETS.fetch(new URL(`https://a.local${path}`));

describe('the canonical config serves every asset the shipping runtime reads', () => {
	it.each(SHIPPING)('serves %s (%s)', async (path) => {
		const res = await asset(path);
		expect(res.status).toBe(200);
	});
});

describe('the canonical config withholds everything else', () => {
	it.each(WITHHELD)('does not serve %s', async (path) => {
		const res = await asset(path);
		expect(res.status).not.toBe(200);
	});

	it('denies by default rather than listing what to drop', () => {
		// `/*` first, then negations. A file added under assets/ later must be opted IN, because
		// the failure mode of the other order is silent: a new fixture ships and nobody looks
		const firstRule = ignoreSource
			.split('\n')
			.map((l) => l.trim())
			.find((l) => l !== '' && !l.startsWith('#'));
		expect(firstRule).toBe('/*');
	});
});

describe('the withheld set is only correct for the canonical vars', () => {
	const active = wranglerSource
		.split('\n')
		.filter((l) => !l.trim().startsWith('//'))
		.join('\n');

	it('withholds the streaming pack only because LAZY_MOUNT selects the per-file one', () => {
		expect(/"LAZY_MOUNT"\s*:\s*"1"/.test(active)).toBe(true);
		expect(ignoreSource).toContain('core.pf.json');
	});

	it('withholds site.sqlite only because the JS migration engine is the default', () => {
		// `database: true` is what would fetch it, and only the php engine asks for that
		expect(/"MIGRATE_ENGINE"\s*:/.test(active)).toBe(false);
		expect(lazyFsSource).toContain('opts.database === true');
	});

	it('keeps the per-file prefix the ignore file names in step with the mount default', () => {
		const prefix = /opts\.prefix \?\? '([\w-]+)'/.exec(lazyFsSource)?.[1];
		expect(prefix).toBe('drupal-pf');
		expect(ignoreSource).toContain(`!/${prefix}/`);
	});
});
