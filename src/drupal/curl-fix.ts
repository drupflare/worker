/**
 * Declares the `curl_*` globals over `CurlShim`, so an SDK that calls `curl_init()` directly
 * (Stripe's `CurlClient`) reaches the shim.
 *
 * The answer arrives inside `curl_exec()`, where the runtime can park; where a park is refused it
 * falls back to `CfwDeferredHttp` (the first call returns false with `CURLE_COULDNT_CONNECT`, a
 * later one the body). No `eval()`: a conditional function declaration binds at runtime, so
 * `php -l` can lint the body.
 * @module
 */
import { CURL_FIX_PHP } from '../site/generated/assets';
import { renderTemplate } from '../util/template';

/**
 * The `CURLOPT_*` constants the shim is willing to be given.
 *
 * Numeric literals because ext-curl is absent (curl's stable ABI values). A spec keeps them in
 * step with `CurlShim::OPTIONS`: a constant defined here but unmapped there would be accepted and
 * silently ignored.
 */
export const CURL_OPTIONS: Record<string, number> = {
	CURLOPT_URL: 10002,
	CURLOPT_POSTFIELDS: 10015,
	CURLOPT_HTTPHEADER: 10023,
	CURLOPT_CUSTOMREQUEST: 10036,
	CURLOPT_POST: 47,
	CURLOPT_RETURNTRANSFER: 19913,
	CURLOPT_FOLLOWLOCATION: 52,
	CURLOPT_HTTPGET: 80,
	CURLOPT_NOBODY: 44,
	CURLOPT_HEADER: 42,
	CURLOPT_TIMEOUT: 13,
	CURLOPT_TIMEOUT_MS: 155,
	CURLOPT_CONNECTTIMEOUT: 78,
	CURLOPT_CONNECTTIMEOUT_MS: 156,
	CURLOPT_SSL_VERIFYPEER: 64,
	CURLOPT_SSL_VERIFYHOST: 81,
	CURLOPT_CAINFO: 10065,
	CURLOPT_HTTP_VERSION: 84,
	CURLOPT_SSLVERSION: 32,
	CURLOPT_ENCODING: 10102,
	CURLOPT_FORBID_REUSE: 75,
	CURLOPT_NOSIGNAL: 99,
	CURLOPT_USERAGENT: 10018,
	CURLOPT_USERPWD: 10005,
	CURLOPT_HTTPAUTH: 107,
	CURLOPT_PROXY: 10004,
	CURLOPT_HEADERFUNCTION: 20079,
	CURLOPT_WRITEFUNCTION: 20011,
	CURLINFO_HEADER_OUT: 2
};

/**
 * Constants a caller reads but the shim does not act on.
 *
 * Defined because an undefined constant is a fatal `Error` in PHP 8. `CurlShim::setopt()`
 * refuses an option it does not understand, so a name here does not imply it is honoured.
 */
export const CURL_INERT: Record<string, number> = {
	CURLE_OK: 0,
	CURLE_UNSUPPORTED_PROTOCOL: 1,
	CURLE_COULDNT_RESOLVE_HOST: 6,
	CURLE_COULDNT_CONNECT: 7,
	CURLE_OPERATION_TIMEDOUT: 28,
	CURLE_OPERATION_TIMEOUTED: 28,
	CURLE_SSL_PEER_CERTIFICATE: 51,
	CURLE_SSL_CACERT: 60,
	CURLAUTH_BASIC: 1,
	CURLAUTH_ANY: -17,
	CURLAUTH_ANYSAFE: -18,
	CURL_HTTP_VERSION_NONE: 0,
	CURL_HTTP_VERSION_1_0: 1,
	CURL_HTTP_VERSION_1_1: 2,
	CURL_HTTP_VERSION_2_0: 3,
	CURL_HTTP_VERSION_2TLS: 4,
	CURL_SSLVERSION_TLSv1_2: 6,
	CURLINFO_HEADER_SIZE: 2097163,
	CURLINFO_SIZE_DOWNLOAD: 3145736,
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
 * The PHP half: the ten functions plus the constants they are called with, guarded on
 * `!extension_loaded('curl')`.
 *
 * The handle is an array passed by reference (a userland shim cannot mint a `CurlHandle`), so code
 * that type-checks for `CurlHandle` fails and code that treats the handle as opaque works.
 */
export const CURL_FIX = renderTemplate(CURL_FIX_PHP, {
	CURL_OPTIONS: defines(CURL_OPTIONS),
	CURL_INERT: defines(CURL_INERT)
});
