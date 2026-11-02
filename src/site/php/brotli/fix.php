<?php

// ext-brotli stand-in over the host bridge. Declared only where the extension is absent and the
// bridge resolves. A conditional declaration binds at runtime, so this lints clean on a build that
// HAS brotli and the branch does not run.
if (!function_exists('brotli_compress') && function_exists('vrzno_env')) {
	$__cfw_brotli = vrzno_env('cfwBrotli');
	if ($__cfw_brotli !== null) {
		$GLOBALS['__cfw_brotli'] = $__cfw_brotli;

		// the values ext-brotli 0.21 declares
		if (!defined('BROTLI_GENERIC')) {
			define('BROTLI_GENERIC', 0);
		}
		if (!defined('BROTLI_TEXT')) {
			define('BROTLI_TEXT', 1);
		}
		if (!defined('BROTLI_FONT')) {
			define('BROTLI_FONT', 2);
		}
		if (!defined('BROTLI_COMPRESS_LEVEL_MIN')) {
			define('BROTLI_COMPRESS_LEVEL_MIN', 0);
		}
		if (!defined('BROTLI_COMPRESS_LEVEL_MAX')) {
			define('BROTLI_COMPRESS_LEVEL_MAX', 11);
		}
		if (!defined('BROTLI_COMPRESS_LEVEL_DEFAULT')) {
			define('BROTLI_COMPRESS_LEVEL_DEFAULT', 11);
		}

		/**
		 * Runs one op over the bridge.
		 *
		 * @param string $op
		 *   compress or uncompress.
		 * @param string $data
		 *   The bytes to transform.
		 * @param int $level
		 *   A brotli quality, 0 to 11.
		 * @param int $mode
		 *   BROTLI_GENERIC, BROTLI_TEXT or BROTLI_FONT.
		 * @param string $dict
		 *   A preset dictionary, or an empty string for none. The host refuses one.
		 *
		 * @return array{ok: bool, data?: string, error?: string}
		 */
		function cfw_brotli($op, $data, $level = 11, $mode = 0, $dict = ''): array
		{
			$fn = $GLOBALS['__cfw_brotli'];
			$reply = json_decode(
				$fn(
					json_encode([
						'op' => $op,
						'b64' => base64_encode((string) $data),
						'level' => $level,
						'mode' => $mode,
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
		 * Raises the diagnostic ext-brotli raises, then answers FALSE like it does.
		 *
		 * @param string $name
		 *   The PHP function that failed.
		 * @param string $reason
		 *   What ext-brotli would have said.
		 */
		function cfw_brotli_fail($name, $reason): false
		{
			trigger_error($name . '(): ' . $reason, E_USER_WARNING);
			return false;
		}

		/**
		 * @param string $data
		 *   The bytes to compress.
		 * @param int $level
		 *   A brotli quality, 0 to 11.
		 * @param int $mode
		 *   BROTLI_GENERIC, BROTLI_TEXT or BROTLI_FONT.
		 * @param string|null $dict
		 *   Not supported on this host; a non-empty value is refused.
		 *
		 * @return string|false
		 */
		function brotli_compress($data, $level = 11, $mode = 0, $dict = null)
		{
			$r = cfw_brotli('compress', $data, $level, $mode, $dict ?? '');
			return $r['ok'] ? $r['data'] : cfw_brotli_fail('brotli_compress', $r['error']);
		}

		/**
		 * @param string $data
		 *   The brotli stream.
		 * @param string|null $dict
		 *   Not supported on this host; a non-empty value is refused.
		 *
		 * @return string|false
		 */
		function brotli_uncompress($data, $dict = null)
		{
			$r = cfw_brotli('uncompress', $data, 11, 0, $dict ?? '');
			return $r['ok'] ? $r['data'] : cfw_brotli_fail('brotli_uncompress', $r['error']);
		}
	}
}
