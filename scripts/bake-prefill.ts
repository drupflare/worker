/**
 * Produces `assets/prefill.json` offline, by booting the runtime and asking it to render.
 *
 * ```sh
 * bun scripts/bake-prefill.ts                 # boot, migrate, lift five pages, tear down
 * bun scripts/bake-prefill.ts --port=8802
 * bun scripts/bake-prefill.ts --keep          # leave the scratch state for inspection
 * ```
 *
 * "Offline" means no release and no credential, NOT no runtime. The bytes in this file have to be
 * bytes the site actually produces, and the only thing that produces them is the site -- so this
 * boots one. `wrangler dev` runs the worker locally in workerd with its own Durable Object, needing
 * no Cloudflare login, which is what makes this a build step rather than a deploy step.
 *
 * WHY NOT RENDER ON NATIVE PHP. `scripts/drupal/prefill-cache.php` did, and it is much cheaper -- a
 * warm page is 5.45 ms against ~46 ms of edge cpuTime. It shipped bytes the site could not reproduce:
 * every block id came back suffixed `--2` because `Html::$seenIds` is a static that
 * `drupal_static_reset()` does not clear, and the favicon resolved to a different path because the
 * packer drops `.ico` and native PHP's `file_exists()` therefore disagreed with wasm's. A prefilled
 * path is a HIT on its first ever request, so those bytes ARE the page a visitor sees, and the page
 * would change the first time it was re-rendered.
 *
 * THE MIGRATION IS NOT OPTIONAL. `/serve` answers 202 on a site that has never been migrated, and
 * `renderOne` retries a 202 twelve times before giving up -- so skipping it produces a run that looks
 * like a slow failure rather than a missing step.
 *
 * AND IT RUNS WITH PREFILL OFF, which is the difference between a bake and a copy. `/migrate` seeds
 * the serving table from the shipped `assets/prefill.json`, so with it on every `/serve` here is a
 * HIT of the file being rebuilt: measured, all five pages came back byte-identical to the old
 * artifact with `renderMs` carried across unchanged, and a config change made two steps earlier was
 * nowhere in the output.
 *
 * @see scripts/lift-prefill.ts for the render loop this drives, and what it measured
 * @see scripts/dev-server.ts for the boot
 */

import { migrateSite, startDevServer } from './dev-server';
import { liftPrefill, PREFILL_PATHS } from './lift-prefill';

const arg = (name: string, fallback: string): string => {
	const hit = process.argv.find((a: string) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};

/**
 * Boots a worker, migrates a site into it, lifts every path, and stops it.
 *
 * @param out - where the file lands, relative to the working directory
 * @returns the paths that were lifted
 */
export async function bakePrefill(
	out = 'assets/prefill.json',
	site = 'bake',
	paths: readonly string[] = PREFILL_PATHS,
	port = 8801,
	keep = false
): Promise<string[]> {
	// PW_DIAGNOSTICS is off in `wrangler.jsonc` because a DEPLOYED worker must not expose /migrate;
	// this boot is local, throwaway, and needs it to provision the site at all
	const dev = await startDevServer({
		label: 'prefill',
		port,
		vars: { PW_DIAGNOSTICS: '1' },
		keep
	});
	try {
		console.log(`[prefill] migrating site=${site}`);
		// prefill OFF, or the bake reads its own output: /migrate seeds cfw_page from the shipped
		// prefill.json and /serve then answers a HIT, so the rebuild reproduces the stale file exactly
		const passes = await migrateSite(dev.origin, site, { prefill: false });
		console.log(`[prefill] migrated in ${passes} pass(es); rendering ${paths.length} paths`);
		const prefill = await liftPrefill(dev.origin, site, paths, out);
		return Object.keys(prefill);
	} finally {
		dev.stop();
	}
}

if (import.meta.main) {
	await bakePrefill(
		arg('out', 'assets/prefill.json'),
		arg('site', 'bake'),
		arg('paths', PREFILL_PATHS.join(','))
			.split(',')
			.map((p) => p.trim())
			.filter(Boolean),
		Number(arg('port', '8801')),
		process.argv.includes('--keep')
	);
}
