import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

/**
 * Builds `assets/prefill.json` from the RUNTIME's own renders, not from native PHP.
 *
 *   bun scripts/lift-prefill.ts --endpoint=http://localhost:8801 --site=bake [--paths=/,/user/login]
 *
 * WHY A LIFT AND NOT A NATIVE RENDER. `scripts/drupal/prefill-cache.php` renders on native PHP,
 * which is much cheaper (a warm page is 5.45 ms against ~46 ms of edge cpuTime) and was the obvious
 * way to build this. It ships bytes that **differ from what the site actually produces**:
 *
 * - every block id came back suffixed `--2`, because `Html::$seenIds` is a plain static that
 *   `drupal_static_reset()` does not clear, so render 2 -- the one shipped -- saw every id as taken.
 *   Resetting it per render fixed most of them.
 * - one id still diverges (`block-olivero-account-menu`) on the FIRST render of a fresh process,
 *   independent of the repeat count.
 *
 * The favicon divergence is the packer. Native
 * renders `/core/themes/olivero/favicon.ico` and wasm renders `/core/misc/favicon.ico`, and the
 * fork is a single `file_exists()`:
 * `core/lib/Drupal/Core/Extension/ThemeSettingsProvider.php:121` takes the theme's own icon when
 * `<theme path>/favicon.ico` is on disk and falls back to `core/misc/favicon.ico` when it is not.
 * Both `system.theme.global` and `olivero.settings` ship `favicon.use_default: true` with an empty
 * `favicon.path`, so that branch is the only thing deciding. `scripts/pack-drupal.ts:91,135` drops
 * `.ico` from the pack on the reasoning that "PHP never opens them", which is true of `fopen` and
 * false of `file_exists` -- the same mistake the `.svg` exception three lines above already
 * documents -- so no pack index carries `core/themes/olivero/favicon.ico` and the wasm
 * `file_exists()` is correctly false. Not a wasm bug and not a reset bug: a missing file.
 *
 * Which means the icon question and the divergence question are separate. The lift closes the
 * divergence regardless of which icon wins, because it takes whatever the runtime says.
 *
 * `assets/prefill.json` has now been rebuilt through this script and is no longer the native
 * artifact. Measured after the rebuild: `/` is **12,304 bytes / sha1 10077de5f0bd**, byte-identical
 * to what `/serve` returns, with **zero** `--2` ids where the native file had 5, 10 and 3, and no
 * `/core/themes/olivero/favicon.ico` anywhere. Whether the pack should also ship the theme's own
 * icon is a separate cosmetic call -- both URLs 404 for a visitor today, since `assets/` serves no
 * Drupal core tree.
 *
 * That matters because prefill is the DEFAULT on free: a prefilled path is a HIT on its first
 * ever request, so whatever is in this file IS the page the visitor sees. Shipping HTML the site
 * cannot reproduce means the page changes the first time it is genuinely re-rendered, which is the
 * plausible-output-no-error failure this project keeps producing.
 *
 * Taking the bytes from the runtime removes the entire class by construction: prefilled output and
 * rendered output are the same because they came from the same renderer. It costs one local
 * `wrangler dev` run at build time and nothing at runtime. Same reasoning as `lift-container.ts` --
 * where a build artifact must match a runtime, the runtime is the authority.
 */

const arg = (name: string, fallback: string): string => {
	const hit = process.argv.find((a: string) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};

const endpoint = arg('endpoint', 'http://localhost:8801').replace(/\/+$/, '');
const site = arg('site', 'bake');
const paths = arg('paths', '/,/user/login')
	.split(',')
	.map((p) => p.trim())
	.filter(Boolean);
const out = arg('out', 'assets/prefill.json');

/** renders one path through the real worker and returns the shape prefill.json stores */
async function renderOne(path: string) {
	const url = new URL(`${endpoint}/serve`);
	url.searchParams.set('site', site);
	url.searchParams.set('path', path);
	// a cold object answers 202 on its first request while the kernel comes up, so retry rather
	// than record an 8-byte body as the page
	for (let attempt = 0; attempt < 12; attempt++) {
		const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
		const html = await res.text();
		if (res.status === 200 && html.length > 200) {
			return {
				status: res.status,
				contentType: res.headers.get('content-type') ?? 'text/html; charset=utf-8',
				html,
				renderMs: Number(res.headers.get('x-cfw-render-ms') ?? 0)
			};
		}
		await new Promise((r) => setTimeout(r, 1500));
	}
	throw new Error(`${path}: never returned a rendered 200 from ${endpoint}`);
}

const prefill: Record<string, unknown> = {};
for (const path of paths) {
	const page = await renderOne(path);
	prefill[path] = page;
	const suffixed = (page.html.match(/--2/g) ?? []).length;
	// UTF-8 BYTES, not `html.length`. A JS string length counts UTF-16 code units, so the front page
	// reported 12,296 for content that is 12,304 bytes on the wire -- an 8-byte gap that looks exactly
	// like a page which failed to match the recorded acceptance value while being byte-identical to it.
	// The digest is printed for the same reason: it is what a restore byte-compare compares.
	const bytes = new TextEncoder().encode(page.html);
	const digest = createHash('sha1').update(bytes).digest('hex').slice(0, 12);
	console.log(`  ${path}: ${bytes.length} bytes, sha1 ${digest}, "--2" ids: ${suffixed}`);
	if (suffixed > 0) {
		// the runtime is the authority, so a suffix here is real rather than an artifact -- but it
		// is worth seeing, because it would mean the page genuinely contains a duplicate id
		console.log(`    note: ${suffixed} suffixed ids came from the RUNTIME, so they are real`);
	}
}

writeFileSync(out, JSON.stringify(prefill));
console.log(
	JSON.stringify(
		{
			out,
			paths: Object.keys(prefill),
			bytes: JSON.stringify(prefill).length,
			source: `${endpoint} (site=${site})`,
			note: 'prefilled output now matches rendered output by construction'
		},
		null,
		2
	)
);
