<?php

// NO eval(), unlike mb-fix. A conditional declaration colliding with an internal function is
// deferred to runtime, so this compiles clean on a build that HAS zlib and the branch simply
// does not run -- verified with php -l plus a run on a host with the extension loaded. Plain
// PHP is what lets tests/node/php-fragments.spec.ts see inside the body at all.

// FIRST BLOCK: the bridge itself plus the one capability ext-zlib does not have. Nothing here
// collides with an internal function, so it is declared on every build.
if (!function_exists('cfw_zlib_dict')) {
	$__cfw_zlib = function_exists('vrzno_env') ? vrzno_env('cfwZlib') : null;
	if ($__cfw_zlib !== null) {
		$GLOBALS['__cfw_zlib'] = $__cfw_zlib;

		/**
		 * Runs one op over the bridge.
		 *
		 * @param string $op
		 *   gzip, gunzip, zlib, unzlib, deflate or inflate.
		 * @param string $data
		 *   The bytes to transform.
		 * @param int $level
		 *   A zlib level, or -1 for the default.
		 * @param string $dict
		 *   A preset dictionary, or an empty string for none.
		 *
		 * @return array{ok: bool, data?: string, error?: string}
		 *   ['ok' => true, 'data' => string] or ['ok' => false, 'error' => string].
		 */
		function cfw_zlib($op, $data, $level = -1, $dict = ''): array
		{
			$fn = $GLOBALS['__cfw_zlib'];
			$reply = json_decode(
				$fn(
					json_encode([
						'op' => $op,
						'b64' => base64_encode((string) $data),
						'level' => $level,
						'dict' => base64_encode((string) $dict),
					]),
				),
				true,
			);
			if (!is_array($reply) || ($reply['ok'] ?? false) !== true) {
				$why = is_array($reply)
					? (string) ($reply['error'] ?? 'no reason given')
					: 'unreadable reply';
				return ['ok' => false, 'error' => $why];
			}
			$out = base64_decode((string) ($reply['b64'] ?? ''), true);
			if ($out === false) {
				return ['ok' => false, 'error' => 'reply was not base64'];
			}
			return ['ok' => true, 'data' => $out];
		}

		/**
		 * Raises the diagnostic ext-zlib raises, then answers FALSE like it does.
		 *
		 * @param string $name
		 *   The PHP function that failed.
		 * @param string $reason
		 *   What ext-zlib would have said.
		 */
		function cfw_zlib_fail($name, $reason): false
		{
			trigger_error($name . '(): ' . $reason, E_USER_WARNING);
			return false;
		}

		/**
		 * Compresses or decompresses against a preset dictionary.
		 *
		 * NOT shaped like a gz* function: PHP has never had a dictionary
		 * parameter on gzcompress(), so widening one of those signatures would make a host-only
		 * argument look like part of the language. function_exists('cfw_zlib_dict') is the feature
		 * test a caller uses.
		 *
		 * $op is 'zlib' to compress and 'unzlib' to decompress; the output is an ordinary zlib
		 * stream with FDICT set. gzip and the raw pair are refused, because neither has anywhere
		 * to record the dictionary's checksum -- so a wrong dictionary would decode to plausible
		 * garbage instead of failing.
		 *
		 * @param string $op
		 *   zlib or unzlib.
		 * @param string $data
		 *   The bytes to transform.
		 * @param string $dict
		 *   The preset dictionary.
		 * @param int $level
		 *   A zlib level, or -1 for the default.
		 *
		 * @return string|false
		 *   The bytes, or FALSE with an E_USER_WARNING, matching the gz* functions.
		 */
		function cfw_zlib_dict($op, $data, $dict, $level = -1)
		{
			if ($op !== 'zlib' && $op !== 'unzlib') {
				return cfw_zlib_fail(
					'cfw_zlib_dict',
					"op '" .
						$op .
						"' takes no preset dictionary; use zlib to compress or unzlib to decompress",
				);
			}
			if ((string) $dict === '') {
				return cfw_zlib_fail('cfw_zlib_dict', 'the dictionary is empty');
			}
			$r = cfw_zlib($op, $data, $level, $dict);
			return $r['ok'] ? $r['data'] : cfw_zlib_fail('cfw_zlib_dict', $r['error']);
		}
	}
}

// SECOND BLOCK: the six names ext-zlib owns. Inert wherever the extension is loaded, which
// includes the shipping binary.
if (!extension_loaded('zlib') && !function_exists('cfw_zlib_installed')) {
	$__cfw_zlib = function_exists('vrzno_env') ? vrzno_env('cfwZlib') : null;
	if ($__cfw_zlib !== null) {
		$GLOBALS['__cfw_zlib'] = $__cfw_zlib;

		// ext-zlib declares these, so they vanish with it. FORCE_GZIP is read by AssetDumper and
		// would be an Error("Undefined constant") without this line.
		if (!defined('ZLIB_ENCODING_RAW')) {
			define('ZLIB_ENCODING_RAW', -15);
		}
		if (!defined('ZLIB_ENCODING_DEFLATE')) {
			define('ZLIB_ENCODING_DEFLATE', 15);
		}
		if (!defined('ZLIB_ENCODING_GZIP')) {
			define('ZLIB_ENCODING_GZIP', 31);
		}
		if (!defined('FORCE_DEFLATE')) {
			define('FORCE_DEFLATE', 15);
		}
		if (!defined('FORCE_GZIP')) {
			define('FORCE_GZIP', 31);
		}

		function cfw_zlib_installed(): bool
		{
			return true;
		}

		/**
		 * Refuses a level outside -1..9, with the ValueError ext-zlib throws.
		 *
		 * @param string $name
		 *   The PHP function being called.
		 * @param int $level
		 *   The level the caller passed.
		 *
		 * @return int
		 *   The level, unchanged.
		 */
		function cfw_zlib_level($name, $level)
		{
			if ($level < -1 || $level > 9) {
				throw new ValueError($name . "(): Argument #2 (\$level) must be between -1 and 9");
			}
			return $level;
		}

		/**
		 * The container an encoding names.
		 *
		 * All three encoders accept all three encodings and emit that container -- measured on
		 * 8.5.7, gzcompress(x, 9, ZLIB_ENCODING_GZIP) is byte-identical to
		 * gzencode(x, 9, FORCE_GZIP) -- so the three share one mapping.
		 *
		 * @param string $name
		 *   The PHP function being called.
		 * @param int $encoding
		 *   A ZLIB_ENCODING_* value.
		 */
		function cfw_zlib_encoding($name, $encoding): string
		{
			if ($encoding === 31) {
				return 'gzip';
			}
			if ($encoding === 15) {
				return 'zlib';
			}
			if ($encoding === -15) {
				return 'deflate';
			}
			throw new ValueError(
				$name .
					"(): Argument #3 (\$encoding) must be one of ZLIB_ENCODING_RAW, ZLIB_ENCODING_GZIP, or ZLIB_ENCODING_DEFLATE",
			);
		}

		/**
		 * Applies $max_length the way zlib does, which is NOT a truncation.
		 *
		 * Measured: gzuncompress(gzcompress('hello world'), 5) is FALSE, not 'hello'. zlib fails
		 * the inflate when its output buffer is too small, so a cap below the payload is a data
		 * error rather than a short read. 0 means no cap.
		 *
		 * @param string $name
		 *   The PHP function being called.
		 * @param string $data
		 *   The inflated bytes.
		 * @param int $max_length
		 *   The cap, or 0 for none.
		 *
		 * @return string|false
		 *   The bytes, or FALSE with an E_USER_WARNING when the cap was exceeded.
		 */
		function cfw_zlib_cap($name, $data, $max_length)
		{
			if ($max_length > 0 && strlen($data) > $max_length) {
				return cfw_zlib_fail($name, 'data error');
			}
			return $data;
		}

		// the encoding defaults are spelled as ints rather than as the constants defined above, so
		// the signature does not depend on when a define() ran
		/**
		 * @param string $data
		 *   The bytes to compress.
		 * @param int $level
		 *   A zlib level, or -1 for the default.
		 * @param int $encoding
		 *   A ZLIB_ENCODING_* value.
		 *
		 * @return string|false
		 */
		function gzencode($data, $level = -1, $encoding = 31)
		{
			$op = cfw_zlib_encoding('gzencode', $encoding);
			cfw_zlib_level('gzencode', $level);
			$r = cfw_zlib($op, $data, $level);
			return $r['ok'] ? $r['data'] : cfw_zlib_fail('gzencode', $r['error']);
		}

		/**
		 * @param string $data
		 *   The bytes to compress.
		 * @param int $level
		 *   A zlib level, or -1 for the default.
		 * @param int $encoding
		 *   A ZLIB_ENCODING_* value.
		 *
		 * @return string|false
		 */
		function gzcompress($data, $level = -1, $encoding = 15)
		{
			$op = cfw_zlib_encoding('gzcompress', $encoding);
			cfw_zlib_level('gzcompress', $level);
			$r = cfw_zlib($op, $data, $level);
			return $r['ok'] ? $r['data'] : cfw_zlib_fail('gzcompress', $r['error']);
		}

		/**
		 * @param string $data
		 *   The bytes to compress.
		 * @param int $level
		 *   A zlib level, or -1 for the default.
		 * @param int $encoding
		 *   A ZLIB_ENCODING_* value.
		 *
		 * @return string|false
		 */
		function gzdeflate($data, $level = -1, $encoding = -15)
		{
			$op = cfw_zlib_encoding('gzdeflate', $encoding);
			cfw_zlib_level('gzdeflate', $level);
			$r = cfw_zlib($op, $data, $level);
			return $r['ok'] ? $r['data'] : cfw_zlib_fail('gzdeflate', $r['error']);
		}

		/**
		 * @param string $data
		 *   The gzip stream.
		 * @param int $max_length
		 *   The cap on the inflated size, or 0 for none.
		 *
		 * @return string|false
		 */
		function gzdecode($data, $max_length = 0)
		{
			$r = cfw_zlib('gunzip', $data);
			if (!$r['ok']) {
				return cfw_zlib_fail('gzdecode', 'data error');
			}
			return cfw_zlib_cap('gzdecode', $r['data'], $max_length);
		}

		/**
		 * @param string $data
		 *   The zlib stream.
		 * @param int $max_length
		 *   The cap on the inflated size, or 0 for none.
		 *
		 * @return string|false
		 */
		function gzuncompress($data, $max_length = 0)
		{
			$r = cfw_zlib('unzlib', $data);
			if (!$r['ok']) {
				return cfw_zlib_fail('gzuncompress', 'data error');
			}
			return cfw_zlib_cap('gzuncompress', $r['data'], $max_length);
		}

		/**
		 * @param string $data
		 *   The raw deflate stream.
		 * @param int $max_length
		 *   The cap on the inflated size, or 0 for none.
		 *
		 * @return string|false
		 */
		function gzinflate($data, $max_length = 0)
		{
			$r = cfw_zlib('inflate', $data);
			if (!$r['ok']) {
				return cfw_zlib_fail('gzinflate', 'data error');
			}
			return cfw_zlib_cap('gzinflate', $r['data'], $max_length);
		}
	}
}
