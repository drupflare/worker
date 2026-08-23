/**
 * Declares the `curl_*` globals over `CurlShim`, which was complete and reached by nothing.
 *
 * P42.2, and it is another [[tested-but-never-called]]. `Drupal\drupflare\Shim\CurlShim` implements
 * `init/setopt/setoptArray/exec/getinfo/errno/error/close` against `CfwDeferredHttp`, it is covered
 * by the sibling's health suite, and it was green on every commit -- while **nothing declared the
 * global `curl_init()`**, so no SDK could ever reach it. The class was correct and unreachable.
 *
 * WHY THIS UNBLOCKS MORE THAN ONE THING. An SDK that bundles its own curl transport does not care
 * which HTTP client Drupal was configured with: Stripe's `CurlClient` calls `curl_init()` directly,
 * and so do many others. Shimming curl once fixes every one of them, which is the argument for
 * doing it here rather than case by case for each SDK.
 *
 * THE SEMANTICS ARE DEFERRED AND HONEST. `CfwDeferredHttp` queues the request and the object drains
 * it between PHP invocations, because PHP here cannot await. So the FIRST `curl_exec()` for a URL
 * returns FALSE with `CURLE_COULDNT_CONNECT` and a later one returns the body. That is a real curl
 * error code for a real condition rather than a pretend success, which is what lets a caller's own
 * retry logic work unmodified.
 *
 * NO `eval()`, like `zlib-fix` and unlike `mb-fix`: a conditional function declaration binds at
 * runtime, so this compiles clean on a build that HAS ext-curl and the branch simply never runs.
 * That is what lets `tests/node/php-fragments.spec.ts` run `php -l` over the body.
 */

/**
 * The `CURLOPT_*` constants the shim is willing to be given.
 *
 * NUMERIC LITERALS, and they have to be: ext-curl is absent, so the constants do not exist to read.
 * These values are curl's own and are stable ABI. Kept in step with `CurlShim::OPTIONS` by
 * `tests/unit/drupal/curl-fix.spec.ts`, which fails if either side gains an entry the other lacks --
 * a constant defined here but unmapped there would be accepted and then silently ignored, which is
 * the failure mode `CurlShim`'s own docblock exists to prevent.
 */
export const CURL_OPTIONS: Record<string, number> = {
	CURLOPT_URL: 10002,
	CURLOPT_POSTFIELDS: 10015,
	CURLOPT_HTTPHEADER: 10023,
	CURLOPT_CUSTOMREQUEST: 10036,
	CURLOPT_POST: 47,
	CURLOPT_RETURNTRANSFER: 19913,
	CURLOPT_FOLLOWLOCATION: 52
};

/**
 * Constants a caller reads but the shim does not act on.
 *
 * Defined because an undefined constant is a fatal `Error` in PHP 8 -- so omitting them turns a
 * silently-ignored option into a dead site. `CurlShim::setopt()` REFUSES an option it does not
 * understand rather than dropping it, so defining the name here does not imply it is honoured; it
 * only means the caller gets a refusal instead of a crash while composing the request.
 */
export const CURL_INERT: Record<string, number> = {
	CURLE_OK: 0,
	CURLE_UNSUPPORTED_PROTOCOL: 1,
	CURLE_COULDNT_RESOLVE_HOST: 6,
	CURLE_COULDNT_CONNECT: 7,
	CURLE_OPERATION_TIMEDOUT: 28,
	CURLINFO_HTTP_CODE: 2097154,
	CURLINFO_RESPONSE_CODE: 2097154,
	CURLINFO_EFFECTIVE_URL: 1048577,
	CURLINFO_CONTENT_TYPE: 1048594,
	CURLINFO_TOTAL_TIME: 3145731
};

const defines = (map: Record<string, number>) =>
	Object.entries(map)
		.map(([name, value]) => `\t\tif (!defined('${name}')) { define('${name}', ${value}); }`)
		.join('\n');

/**
 * The PHP half: the eight functions plus the constants they are called with.
 *
 * Guarded on `!extension_loaded('curl')` so a build that ever gains the real extension keeps it.
 * The handle is an ARRAY passed by reference rather than an object, matching `CurlShim`'s own
 * signatures -- PHP 8 makes `curl_init()` return a `CurlHandle` object, and a userland shim cannot
 * mint one, so an array is the closest honest stand-in. Code that type-checks for `CurlHandle`
 * will not work; code that treats the handle as opaque, which is nearly all of it, will.
 */
export const CURL_FIX = String.raw`
if (!extension_loaded('curl') && !function_exists('cfw_curl_installed')) {
	{
${defines(CURL_OPTIONS)}
${defines(CURL_INERT)}

		function cfw_curl_installed() { return true; }

		/**
		 * The one shim instance, resolved on FIRST USE rather than at declaration time.
		 *
		 * This fragment runs from ensurePhp(), which is before Drupal's autoloader exists, so a
		 * class_exists() guard around the declarations would never pass and the functions would
		 * never be declared at all. Resolving here instead means the class is looked up when a
		 * caller actually makes a request, by which time the module is loaded.
		 *
		 * @return \Drupal\drupflare\Shim\CurlShim|null
		 *   NULL when the module is not loaded, which every caller below treats as a refusal.
		 */
		function cfw_curl_shim() {
			static $shim = null;
			if ($shim === null && class_exists('Drupal\drupflare\Shim\CurlShim')) {
				$shim = new \Drupal\drupflare\Shim\CurlShim();
			}
			return $shim;
		}

		/**
		 * Declares the gap once, then answers the way curl answers a connection it cannot make.
		 *
		 * P45: never silently absent. Without the module there is no queue to defer into, so the
		 * honest answer is the same FALSE a caller already handles -- but an operator gets a
		 * status-report row saying why instead of an unexplained failure.
		 */
		function cfw_curl_absent() {
			if (class_exists('Drupal\drupflare\Degradation')) {
				\Drupal\drupflare\Degradation::record(
					'curl_*',
					'the drupflare module is not loaded, so there is no deferred-HTTP queue to route curl through'
				);
			}
			return false;
		}

		function curl_init($url = null) {
			$shim = cfw_curl_shim();
			if ($shim === null) { return cfw_curl_absent(); }
			return $shim->init($url === null ? null : (string) $url);
		}

		function curl_setopt(&$handle, $option, $value) {
			$shim = cfw_curl_shim();
			if ($shim === null || !is_array($handle)) { return cfw_curl_absent(); }
			return $shim->setopt($handle, (int) $option, $value);
		}

		function curl_setopt_array(&$handle, $options) {
			$shim = cfw_curl_shim();
			if ($shim === null || !is_array($handle)) { return cfw_curl_absent(); }
			return $shim->setoptArray($handle, (array) $options);
		}

		function curl_exec(&$handle) {
			$shim = cfw_curl_shim();
			if ($shim === null || !is_array($handle)) { return cfw_curl_absent(); }
			return $shim->exec($handle);
		}

		function curl_getinfo($handle, $key = null) {
			$shim = cfw_curl_shim();
			if ($shim === null || !is_array($handle)) { return cfw_curl_absent(); }
			return $shim->getinfo($handle, $key === null ? null : (string) $key);
		}

		function curl_errno($handle) {
			$shim = cfw_curl_shim();
			// 7 is CURLE_COULDNT_CONNECT, which is what "there was no transport" really is
			if ($shim === null || !is_array($handle)) { return 7; }
			return $shim->errno($handle);
		}

		function curl_error($handle) {
			$shim = cfw_curl_shim();
			if ($shim === null || !is_array($handle)) { return 'drupflare: curl shim unavailable'; }
			return $shim->error($handle);
		}

		function curl_close(&$handle) {
			$shim = cfw_curl_shim();
			if ($shim !== null && is_array($handle)) { $shim->close($handle); }
		}

		/**
		 * Reports a version the way ext-curl does, so a caller's feature test has something to read.
		 *
		 * The version string names this shim rather than a curl release: a caller comparing against
		 * a real curl version must not conclude a feature is present because the number looked new
		 * enough.
		 */
		function curl_version() {
			return [
				'version' => '0.0.0-drupflare-shim',
				'version_number' => 0,
				'features' => 0,
				'ssl_version' => '',
				'protocols' => ['http', 'https'],
			];
		}
	}
}
`;
