<?php

// ext-zstd stand-in over the host bridge. Declared only where the extension is absent and the
// bridge resolves. A conditional declaration binds at runtime, so this lints clean on a build that
// HAS zstd and the branch does not run.
if (!function_exists('zstd_compress') && function_exists('vrzno_env')) {
	$__cfw_zstd = vrzno_env('cfwZstd');
	if ($__cfw_zstd !== null) {
		$GLOBALS['__cfw_zstd'] = $__cfw_zstd;

		// the values ext-zstd 0.18 declares
		if (!defined('ZSTD_COMPRESS_LEVEL_MIN')) {
			define('ZSTD_COMPRESS_LEVEL_MIN', 1);
		}
		if (!defined('ZSTD_COMPRESS_LEVEL_MAX')) {
			define('ZSTD_COMPRESS_LEVEL_MAX', 22);
		}
		if (!defined('ZSTD_COMPRESS_LEVEL_DEFAULT')) {
			define('ZSTD_COMPRESS_LEVEL_DEFAULT', 3);
		}

		/**
		 * Runs one op over the bridge.
		 *
		 * @param string $op
		 *   compress or uncompress.
		 * @param string $data
		 *   The bytes to transform.
		 * @param int $level
		 *   A zstd level, 1 to 22 (or zero and below).
		 * @param string $dict
		 *   A preset dictionary, or an empty string for none.
		 *
		 * @return array{ok: bool, data?: string, error?: string}
		 */
		function cfw_zstd($op, $data, $level = 3, $dict = ''): array
		{
			$fn = $GLOBALS['__cfw_zstd'];
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
		 * Raises the diagnostic ext-zstd raises, then answers FALSE like it does.
		 *
		 * @param string $name
		 *   The PHP function that failed.
		 * @param string $reason
		 *   What ext-zstd would have said.
		 */
		function cfw_zstd_fail($name, $reason): false
		{
			trigger_error($name . '(): ' . $reason, E_USER_WARNING);
			return false;
		}

		/**
		 * @param string $data
		 *   The bytes to compress.
		 * @param int $level
		 *   A zstd level, 1 to 22 (or zero and below).
		 * @param string|null $dict
		 *   A preset dictionary, or NULL for none.
		 *
		 * @return string|false
		 */
		function zstd_compress($data, $level = 3, $dict = null)
		{
			$r = cfw_zstd('compress', $data, $level, $dict ?? '');
			return $r['ok'] ? $r['data'] : cfw_zstd_fail('zstd_compress', $r['error']);
		}

		/**
		 * @param string $data
		 *   The zstd frame.
		 * @param string|null $dict
		 *   The dictionary the frame was compressed with, or NULL for none.
		 *
		 * @return string|false
		 */
		function zstd_uncompress($data, $dict = null)
		{
			$r = cfw_zstd('uncompress', $data, 3, $dict ?? '');
			return $r['ok'] ? $r['data'] : cfw_zstd_fail('zstd_uncompress', $r['error']);
		}

		/**
		 * The alias ext-zstd documents beside zstd_uncompress().
		 *
		 * @param string $data
		 *   The zstd frame.
		 * @param string|null $dict
		 *   The dictionary the frame was compressed with, or NULL for none.
		 *
		 * @return string|false
		 */
		function zstd_decompress($data, $dict = null)
		{
			$r = cfw_zstd('uncompress', $data, 3, $dict ?? '');
			return $r['ok'] ? $r['data'] : cfw_zstd_fail('zstd_decompress', $r['error']);
		}

		/**
		 * @param string $data
		 *   The bytes to compress.
		 * @param string $dict
		 *   The dictionary; required.
		 * @param int $level
		 *   A zstd level, 1 to 22 (or zero and below).
		 *
		 * @return string|false
		 */
		function zstd_compress_dict($data, $dict, $level = 3)
		{
			$r = cfw_zstd('compress', $data, $level, (string) $dict);
			return $r['ok'] ? $r['data'] : cfw_zstd_fail('zstd_compress_dict', $r['error']);
		}

		/**
		 * @param string $data
		 *   The zstd frame.
		 * @param string $dict
		 *   The dictionary the frame was compressed with; required.
		 *
		 * @return string|false
		 */
		function zstd_uncompress_dict($data, $dict)
		{
			$r = cfw_zstd('uncompress', $data, 3, (string) $dict);
			return $r['ok'] ? $r['data'] : cfw_zstd_fail('zstd_uncompress_dict', $r['error']);
		}
	}
}
