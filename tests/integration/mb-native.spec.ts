import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * `mbstring` in the shipping interpreter, and both halves of the shim that stands in for it.
 *
 * The build gained `--enable-mbstring --disable-mbregex` on 2026-09-08. That makes `MB_FIX` a shim
 * over an extension the build HAS, which is the {@link https://example.invalid inert-shim-guard}
 * shape this project has been caught by before: a wrapper guarded on `!extension_loaded('mbstring')`
 * disables itself and reads as working, while anything the same fragment defines UNCONDITIONALLY
 * still runs and is still the thing being used.
 *
 * So both halves are asserted against the real interpreter rather than reasoned about. The wrappers
 * must be Drupal's own `mb_*`, not the shim's; the `cfw_*` helpers must still exist, because
 * `MB_ASCII` and `UNICODE_TABLES` define them with no guard at all and other fragments call them.
 *
 * **`measure:mb-parity` cannot answer any of this**, which is worth saying because the plan expected
 * it to: it runs on NATIVE php and compares the polyfill to the real functions, so it scores the
 * shim's fidelity and is blind to which one a wasm build actually uses. Its 10 core-reachable
 * divergences are unchanged and no longer reachable, which is a different claim from fixed.
 *
 * `loaded-extensions.spec.ts` covers the other side -- that `get_loaded_extensions()` agrees with
 * `NATIVE_PLATFORM` and `POLYFILLED_PLATFORM` in both directions. What is here is the SHIM's two
 * halves, which that one does not look at.
 */

type Interp = ServeDo & { run: (code: string) => Promise<string> };

const PROBE = `<?php
// NO MB_FIX HERE ON PURPOSE: the object installs it into every interpreter it creates, so this
// measures the state a render actually runs in rather than one this file assembled
$out = [
  'loaded' => extension_loaded('mbstring'),
  // WHOSE FUNCTION ANSWERS. An internal one is the extension; a user one is the shim still in place
  'mb_strlen_internal' => (new ReflectionFunction('mb_strlen'))->isInternal(),
  'mb_substr_internal' => (new ReflectionFunction('mb_substr'))->isInternal(),
  // the unconditional half: these are defined whether or not the extension is there
  // EVERY helper MB_FIX can define, reported as present or not rather than assumed either way
  'helpers' => array_values(array_filter([
    'cfw_mb_sanitize', 'cfw_mb_installed', 'cfw_mb_ascii', 'cfw_mb_final_sigma',
    'cfw_mb_utf8', 'cfw_mb_title_regexp', 'cfw_mb_title_word', 'cfw_mb_encode_subst',
    'cfw_mb_iconv_label', 'cfw_mb_decode_subst', 'cfw_mb_isubpart',
  ], 'function_exists')),
  // and it has to be CORRECT, not merely present
  'utf8_len' => mb_strlen('na\u{00ef}ve caf\u{00e9}'),
  'utf8_sub' => mb_substr('na\u{00ef}ve caf\u{00e9}', 5, 4),
  'upper' => mb_strtoupper('stra\u{00df}e'),
  'regex_absent' => !function_exists('mb_ereg'),
];
echo json_encode($out);`;

describe('mbstring, native in the shipping build', () => {
	it('is loaded, answers Drupal own calls, and leaves the unguarded helpers defined', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const text = await (site as Interp).run(PROBE);
			const at = text.indexOf('{');
			if (at < 0) throw new Error(`no JSON printed; PHP said: ${text.slice(0, 600)}`);
			return JSON.parse(text.slice(at)) as Record<string, unknown>;
		});
		console.log(`[mbstring] ${JSON.stringify(seen)}`);

		expect(
			seen['loaded'],
			'the build has no mbstring, so MB_FIX is still the implementation'
		).toBe(true);
		// THE FIRST HALF: the guarded wrappers stood down, so what runs is the extension
		expect(seen['mb_strlen_internal']).toBe(true);
		expect(seen['mb_substr_internal']).toBe(true);
		// THE SECOND HALF, and it is the one a guard cannot cover: `MB_ASCII` and `UNICODE_TABLES`
		// define these with no `extension_loaded` check, and other fragments call them
		/**
		 * THE SECOND HALF, MEASURED, AND THE INERT SURFACE IS BIGGER THAN IT WAS TAKEN TO BE.
		 *
		 * The expectation was that `MB_ASCII` and `UNICODE_TABLES` define a couple of helpers
		 * unconditionally. **Ten of eleven are defined**, on a build where the wrappers correctly
		 * stood down: the `extension_loaded` guard covers the `mb_*` wrappers and `cfw_mb_installed`
		 * and almost nothing else. They are declarations rather than behaviour, so the cost is a
		 * compile and not a wrong answer -- but "the shim goes inert on its own" describes one tenth
		 * of the fragment, and that is the `inert-shim-guard` family stated precisely.
		 *
		 * Pinned as a SET, so a helper crossing the guard in either direction fails here.
		 */
		expect(seen['helpers']).toEqual([
			'cfw_mb_sanitize',
			'cfw_mb_ascii',
			'cfw_mb_final_sigma',
			'cfw_mb_utf8',
			'cfw_mb_title_regexp',
			'cfw_mb_title_word',
			'cfw_mb_encode_subst',
			'cfw_mb_iconv_label',
			'cfw_mb_decode_subst',
			'cfw_mb_isubpart'
		]);
		// `cfw_mb_installed` is the sentinel INSIDE the guard, so its absence is what says the
		// guarded block did not run at all
		expect(seen['helpers']).not.toContain('cfw_mb_installed');

		// correctness, so "loaded" is not the whole claim
		expect(seen['utf8_len']).toBe(10);
		// MEASURED, not predicted: 'naïve café' is 10 characters, so offset 5 length 4 is ' caf'.
		// The first version of this asserted 'café' and the reading is what corrected it
		expect(seen['utf8_sub']).toBe(' caf');
		expect(seen['upper']).toBe('STRASSE');
		// `--disable-mbregex` is deliberate: oniguruma feeds only `mb_ereg_*` and has zero callers
		expect(seen['regex_absent'], 'mbregex is compiled in, which the rc says it is not').toBe(
			true
		);
	});
});
