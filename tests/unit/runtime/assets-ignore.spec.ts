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
 *
 * The `/core/**` half is a second defect and not the same one. Nothing in `src/` reads those paths;
 * the BROWSER does, and every pack drops their extensions on the reasoning that PHP never opens
 * them -- true, and irrelevant, because nothing serves a file out of the PHP MEMFS over HTTP either.
 * So the asset layer is the only thing that can answer them, and until it did every stylesheet,
 * script and font on every page 404'd.
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
 * Static files the BROWSER fetches, which no call site in `src/` reads.
 *
 * A different failure from the rest of this file, and it is the reason `/core/` is served at all:
 * every pack SKIPs `css|js|woff2|...` because PHP never opens them, and nothing serves a file out of
 * the PHP MEMFS over HTTP -- so before `scripts/pack-static.ts` these 404'd and the site rendered
 * unstyled with no fonts. One of each kind, because the three arrive by different Drupal mechanisms:
 * a `<script>` from a library definition, a `<link>` from the theme, and a `url()` inside that
 * stylesheet.
 */
const STATIC = [
	['/core/misc/drupal.js', 'a library <script>'],
	['/core/themes/olivero/css/base/fonts.css', 'a theme <link>'],
	['/core/themes/olivero/fonts/lora/lora-v14-latin-regular.woff2', 'a url() inside that CSS'],
	// the contrib half, and it is a different subtree rather than a deeper path: `assets/core/`
	// cannot answer `/modules/**`, so the first enabled module shipping its own css 404s
	['/modules/contrib/token/css/token.css', 'a contrib module stylesheet'],
	// the THIRD subtree, and it was missing for the whole life of the project. `assets:static`
	// builds `assets/themes` and neither `.assetsignore` nor `PAYLOAD_ASSETS` carried it, so the
	// bidirectional check between those two stayed green while both omitted it -- a guard between
	// two lists cannot see what the packer writes to a third place
	[
		'/themes/contrib/uswds_base/starterkits/uswds_base_subtheme/css/uswds_base.css',
		'a contrib theme stylesheet'
	]
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

/** the prefilled pages, read through the binding rather than imported, so the 103 KB stays out */
const prefilledPages = async (): Promise<{ html: string }[]> =>
	Object.values(
		(await (await asset('/prefill.json')).json()) as Record<string, { html: string }>
	);

describe('the canonical config serves every asset the shipping runtime reads', () => {
	it.each(SHIPPING)('serves %s (%s)', async (path) => {
		const res = await asset(path);
		expect(res.status).toBe(200);
	});
});

describe('the canonical config serves the static tree the browser reads', () => {
	it.each(STATIC)('serves %s (%s)', async (path) => {
		const res = await asset(path);
		expect(res.status).toBe(200);
		expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
	});

	it('negates /core/ without re-ignoring its contents', () => {
		// `!/dir/` plus `/dir/*` is the idiom that reaches INTO a directory without shipping it, and
		// it is what drupal-pf uses two lines below. Doing that here would serve nothing
		const rules = ignoreSource
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l !== '' && !l.startsWith('#'));
		expect(rules).toContain('!/core/');
		expect(rules).not.toContain('/core/*');
	});

	it('keeps the aggregator off, because an aggregate has no file to read', async () => {
		// with the raw tree served there is nothing for preprocessing to buy, and both its outcomes
		// break: a hash mismatch 301s, and a match sends JsOptimizer at a file no pack carries
		for (const page of await prefilledPages()) {
			expect(page.html).not.toMatch(/\/files\/(css\/css_|js\/js_)/);
		}
	});

	it('serves every core asset the prefilled pages reference', async () => {
		// the prefill IS the first page a visitor sees, so a URL in it that 404s is a broken render
		// rather than a missing optimisation
		const referenced = new Set<string>();
		for (const page of await prefilledPages()) {
			for (const m of page.html.matchAll(/\/core\/[A-Za-z0-9/_.@-]+\.[a-z0-9]{2,5}/g)) {
				referenced.add(m[0]);
			}
		}
		expect(referenced.size).toBeGreaterThan(50);

		const missing: string[] = [];
		for (const path of referenced) {
			if ((await asset(path)).status !== 200) missing.push(path);
		}
		expect(missing).toEqual([]);
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
