import { describe, expect, it } from 'vitest';
import { CURL_FIX, CURL_INERT, CURL_OPTIONS } from '../../../src/drupal/curl-fix';

/**
 * The curl shim's PHP surface, and the drift that would make it silently wrong.
 *
 * `CurlShim` was complete, covered by the sibling's health suite, and reached by NOTHING -- no
 * global `curl_init()` existed, so no SDK could get to it. That is the [[tested-but-never-called]]
 * family, and a unit test of the class could never have caught it because the class was fine.
 *
 * WHAT THIS FILE GUARDS IS THE SEAM, which is where the remaining risk is. A `CURLOPT_*` constant
 * defined here but absent from `CurlShim::OPTIONS` would be accepted by a caller and then refused
 * at runtime; the reverse leaves a mapped option no caller can name. Both are the "silently
 * ignored option" failure `CurlShim`'s own docblock exists to prevent.
 */

/** the option ids `CurlShim::OPTIONS` maps, transcribed from the sibling */
const SHIM_OPTION_IDS = [10002, 10015, 10023, 10036, 47, 19913, 52];

describe('the curl option constants', () => {
	it('names exactly the ids the shim maps, with nothing extra', () => {
		expect([...Object.values(CURL_OPTIONS)].sort((a, b) => a - b)).toEqual(
			[...SHIM_OPTION_IDS].sort((a, b) => a - b)
		);
	});

	it('uses curlstable ABI values rather than invented ones', () => {
		// 10002 is CURLOPT_URL in every curl release; a wrong value here would route a URL into
		// whichever handle key the shim maps that id to, silently
		expect(CURL_OPTIONS.CURLOPT_URL).toBe(10002);
		expect(CURL_OPTIONS.CURLOPT_RETURNTRANSFER).toBe(19913);
		expect(CURL_OPTIONS.CURLOPT_POSTFIELDS).toBe(10015);
	});

	it('carries the error codes the shim actually returns', () => {
		// exec() answers CURLE_COULDNT_CONNECT when the request could only be queued, so a caller
		// comparing curl_errno() against the constant has to get the same number
		expect(CURL_INERT.CURLE_OK).toBe(0);
		expect(CURL_INERT.CURLE_COULDNT_CONNECT).toBe(7);
	});

	it('defines every constant it names, because an undefined one is a PHP 8 fatal', () => {
		for (const [name, value] of Object.entries({ ...CURL_OPTIONS, ...CURL_INERT })) {
			expect(CURL_FIX, name).toContain(`define('${name}', ${value})`);
		}
	});
});

describe('the declared functions', () => {
	it('declares every curl_* function an SDK reaches for', () => {
		for (const fn of [
			'curl_init',
			'curl_setopt',
			'curl_setopt_array',
			'curl_exec',
			'curl_getinfo',
			'curl_errno',
			'curl_error',
			'curl_close',
			'curl_version'
		]) {
			expect(CURL_FIX).toContain(`function ${fn}(`);
		}
	});

	it('is inert on a build that HAS ext-curl', () => {
		// a conditional declaration binds at runtime, so this compiles clean either way and the
		// branch simply does not run. It is also why php -l can see inside the body at all
		expect(CURL_FIX).toContain("!extension_loaded('curl')");
	});

	it('resolves the shim class on FIRST USE, not at declaration time', () => {
		// the fragment runs from ensurePhp(), before Drupal's autoloader exists. A class_exists()
		// guard around the declarations would never pass and the functions would never exist
		// comments stripped first: the docblock below EXPLAINS why there is no class_exists guard,
		// so matching raw text found the prose and failed on a fragment that was already correct
		const code = CURL_FIX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		const declaration = code.slice(0, code.indexOf('function cfw_curl_shim'));
		expect(declaration).not.toContain('class_exists');
		expect(CURL_FIX).toContain('static $shim = null');
	});

	it('DECLARES the gap rather than failing silently when the module is absent', () => {
		// P45: shimmed, accommodated or declared. Without the module there is no deferred-HTTP
		// queue, so the honest answer is curl's own FALSE plus a status-report row
		expect(CURL_FIX).toContain('Degradation::record');
		expect(CURL_FIX).toContain('function cfw_curl_absent');
	});

	it('reports a version that cannot be mistaken for a real curl release', () => {
		// a caller feature-testing on version_number must not conclude a capability exists
		expect(CURL_FIX).toContain("'version' => '0.0.0-drupflare-shim'");
		expect(CURL_FIX).toContain("'version_number' => 0");
	});
});
