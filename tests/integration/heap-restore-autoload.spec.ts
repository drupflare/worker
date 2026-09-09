import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * A restored heap must not turn the autoloader into the boolean `true`.
 *
 * **`require_once` RETURNS TRUE WHEN THE FILE IS ALREADY INCLUDED**, so
 * `$GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php'` yields the boolean rather than
 * the ClassLoader whenever `autoload.php` is in the included-files table and that global is not.
 *
 * A heap restore reaches exactly that state. It brings back linear memory and the included-files
 * table, and `$GLOBALS['__pw_site_booted']` with them, but not every global beside it -- so the guard
 * `!isset($GLOBALS['__pw_autoloader'])` opens, `require_once` answers `true`, and the next
 * `$autoloader->addPsr4(...)` fatals with **`Call to a member function addPsr4() on true`**. Measured
 * on a site holding a heap image, on every sample.
 *
 * The fix is `require` rather than `require_once`, plus a guard on the VALUE rather than the key.
 * Composer's `getLoader()` memoizes, so a plain `require` hands back the same loader and re-registers
 * nothing.
 *
 * The serving path was never broken by this, which is why 4,760 gate tests were green through it: a
 * render reaches the autoloader through a different fragment, and on the ordinary path
 * `$GLOBALS['__pw_kernel']` comes back with `__pw_site_booted` so the bad value is never
 * dereferenced. What it broke is every probe that boots explicitly on an imaged site -- which is the
 * instrument the cold-boot measurement needs.
 */

const ORIGIN = 'https://do.local';
const TIMEOUT = 900_000;

type Json = Record<string, never>;

async function imagedSite(site: ServeDo): Promise<{ id: number | null; restored: unknown }> {
	await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
	await site.fetch(new Request(`${ORIGIN}/__heap?op=snapshot`, { method: 'POST' }));
	const heap = (await (await site.fetch(new Request(`${ORIGIN}/__heap`))).json()) as Json;
	const latest = heap['latest'] as unknown as { id: number } | null;
	return { id: latest?.id ?? null, restored: heap['heapRestore'] };
}

describe('a boot on a site holding a heap image', () => {
	it(
		'renders instead of fataling on an autoloader that came back as a boolean',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				const image = await imagedSite(site);
				// `/__bootphase` drops the interpreter AND the restore cursor, so this boot is the
				// one that lands on a restored heap
				const res = await site.fetch(new Request(`${ORIGIN}/__bootphase?phase=render`));
				const body = (await res.json()) as Json;
				return { image, body };
			});
			console.log(`[heap-autoload] ${JSON.stringify(seen.body['result'])}`);

			// THE CONTROL: without an image the restore never runs and this spec proves nothing
			expect(seen.image.id, 'no heap image was taken, so no restore happens').not.toBeNull();

			const result = seen.body['result'] as unknown as {
				ok: boolean;
				error?: string;
				renderStatus?: number;
				renderBytes?: number;
				alreadyBooted?: number;
			};
			expect(result.error ?? '', 'the boot fataled on a restored heap').not.toContain(
				'addPsr4'
			);
			expect(result.ok).toBe(true);
			expect(result.renderStatus).toBe(200);
			expect(Number(result.renderBytes)).toBeGreaterThan(1000);

			// and the restore really did bring booted state back, which is what made the guard open
			expect(result.alreadyBooted).toBe(1);
		},
		TIMEOUT
	);
});
