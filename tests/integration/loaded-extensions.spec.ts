import { describe, expect, it } from 'vitest';
import { NATIVE_PLATFORM, POLYFILLED_PLATFORM } from '../../src/ops/packagist';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What the shipping binary actually loads, asked of the binary.
 *
 * THREE CAPABILITY CLAIMS IN THIS PROJECT WERE FALSE AND EACH READ AS VERIFIED. `DEFAULT_PLATFORM`
 * listed `ext-mbstring` two lines under a docblock saying a missing extension is a real conflict,
 * on a build whose `mb-fix.ts` exists precisely because there is no mbstring; `module-tiers.ts`
 * said focal_point's transform "is GD, which this build has"; and a `driveCron()` note said nothing
 * imported it while `src/site-do.ts` did. None of the three had an instrument that could have
 * disagreed.
 *
 * ASSERTED BOTH WAYS, which is the half that makes it a measurement rather than a list. A name in
 * `NATIVE_PLATFORM` that the binary does not load fails, and so does a name in
 * `POLYFILLED_PLATFORM` that it DOES -- because a polyfill that became an extension must move
 * rather than keep degrading every verdict that rests on it.
 *
 * FUNCTION-NAME EVIDENCE IS ACTIVELY MISLEADING and must not be substituted for this.
 * `curl_init`, `mysqli_stmt_init`, `pg_select` and `imagecreatetruecolor` all appear as strings in
 * a binary carrying none of those extensions, because opcache's optimizer ships a `func_info` table
 * naming functions across every bundled extension. `get_loaded_extensions()` is per-extension and
 * is the evidence that holds.
 *
 * Needs the interpreter, so it is in `ARTIFACT_SPECS`.
 */

/** composer spells an extension `ext-<lowercased module name>` */
const extName = (module: string) => `ext-${module.toLowerCase()}`;

async function loadedExtensions(): Promise<string[]> {
	const out = await inObject(freshSite(), async (site: ServeDo) => {
		const res = await site.fetch(new Request('https://do.local/__php'));
		return (await res.json()) as { version?: string; extensions?: string[] };
	});
	expect(out.version, 'the route reports a PHP version').toMatch(/^\d+\.\d+/);
	return (out.extensions ?? []).map(extName);
}

describe('the extensions the shipping binary loads', () => {
	it('includes every name NATIVE_PLATFORM claims', async () => {
		const loaded = await loadedExtensions();
		const claimed = Object.keys(NATIVE_PLATFORM).filter((k) => k.startsWith('ext-'));
		expect(claimed.length, 'the native map is not empty').toBeGreaterThan(0);
		expect(claimed.filter((ext) => !loaded.includes(ext))).toEqual([]);
	}, 900_000);

	it('includes NONE of the names POLYFILLED_PLATFORM claims', async () => {
		const loaded = await loadedExtensions();
		const polyfilled = Object.keys(POLYFILLED_PLATFORM);
		expect(polyfilled.length, 'the polyfilled map is not empty').toBeGreaterThan(0);
		expect(polyfilled.filter((ext) => loaded.includes(ext))).toEqual([]);
	}, 900_000);

	it('has no gd, which is what focal_point and every derivative-reading contrib depend on', async () => {
		// asserted separately from the maps because nothing requires `ext-gd` here; the claim
		// that was wrong lived in prose, and prose needs its own guard
		expect(await loadedExtensions()).not.toContain('ext-gd');
	}, 900_000);

	// the gap `docs/repository-layout.md` named: the extension set behind two COST decisions was
	// asserted in phasm's `inspect-build.sh` and nowhere in this repository, so a binary swap that
	// dropped opcache would pass the gate and add ~70 ms of parse to every boot. Neither is a
	// composer name, so neither belongs in the platform map
	it('carries the two extensions a binary swap could silently drop', async () => {
		const loaded = await loadedExtensions();
		// ~70 ms of PHP parse per boot
		expect(loaded).toContain('ext-zend opcache');
		// `Dom\\HTMLDocument`; the lexbor surgery was the size lever that would have removed it
		expect(loaded).toContain('ext-lexbor');
	}, 900_000);
});
