import { deflateSync, gunzipSync, gzipSync, inflateSync, unzlibSync, zlibSync } from 'fflate';
import { base64ToBytes, bytesToBase64 } from '../db/file-store';

/**
 * Replaces `ext-zlib` with fflate, so the six gz* functions Drupal reaches survive
 * a build compiled with `WITH_ZLIB=0`.
 *
 * Not `CompressionStream`: workerd has it and it is the obvious candidate,
 * but it is a stream and PHP's gz* functions are synchronous. The shipping build
 * sets `ASYNCIFY=0`, so PHP cannot await anything, and a host function that
 * returned a Promise would hand PHP an object it can only stringify. fflate's
 * sync API is the only shape that fits.
 */

/** the Module key the PHP half resolves through `vrzno_env()` */
export const ZLIB_BRIDGE = 'cfwZlib';

/**
 * The container each PHP function wants, named the way the request carries it.
 *
 * gzip is RFC1952, zlib is RFC1950, raw is a bare RFC1951 deflate stream. The
 * three are not interchangeable: `gzuncompress()` on gzip bytes fails, which is
 * how a wrong mapping would show up.
 */
export type ZlibOp = 'gzip' | 'gunzip' | 'zlib' | 'unzlib' | 'deflate' | 'inflate';

/** what the PHP half sends */
export type ZlibRequest = {
	op?: string;
	b64?: string;
	level?: number;
};

/** what it gets back */
export type ZlibReply = { ok: true; b64: string } | { ok: false; error: string };

/**
 * PHP's level to fflate's.
 *
 * PHP accepts -1 for "the library default", which zlib defines as 6. fflate has
 * no such sentinel, so -1 has to be resolved here rather than passed through.
 */
export function zlibLevel(level: unknown): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
	const n = Number(level);
	if (!Number.isFinite(n) || n === -1) return 6;
	const clamped = Math.min(9, Math.max(0, Math.trunc(n)));
	return clamped as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

/**
 * One compression or decompression, decoded.
 *
 * Exported so the gate can drive every op without a Durable Object.
 *
 * `mtime: 0` is load-bearing. fflate stamps the current time into the gzip
 * header by default, which makes `gzencode()` non-reproducible for identical
 * input; zlib writes 0 there. Measured on PHP 8.5.7, native `gzencode()` emits
 * header bytes 1f 8b 08 00 00 00 00 00 02 13 and fflate emitted a live mtime in
 * bytes 4-7 until this was set.
 *
 * @internal
 */
export function zlibApply(op: string, bytes: Uint8Array, level: number): Uint8Array {
	switch (op) {
		case 'gzip':
			return gzipSync(bytes, { level: zlibLevel(level), mtime: 0 });
		case 'gunzip':
			return gunzipSync(bytes);
		case 'zlib':
			return zlibSync(bytes, { level: zlibLevel(level) });
		case 'unzlib':
			return unzlibSync(bytes);
		case 'deflate':
			return deflateSync(bytes, { level: zlibLevel(level) });
		case 'inflate':
			return inflateSync(bytes);
		default:
			throw new Error(`unknown zlib op '${op}'`);
	}
}

/**
 * The whole host side, as a pure function over the decoded request.
 *
 * A failure is a reply rather than a throw, because the PHP functions this backs
 * return FALSE on bad input and do not raise. `gzuncompress()` on a truncated
 * string is a normal outcome for Drupal: `UrlHelper::uncompressQueryParameter()`
 * calls it on user-supplied base64 and tests the return value.
 *
 * @internal
 */
export function zlibHostCall(req: ZlibRequest): ZlibReply {
	try {
		const out = zlibApply(
			String(req.op ?? ''),
			base64ToBytes(String(req.b64 ?? '')),
			Number(req.level ?? -1)
		);
		return { ok: true, b64: bytesToBase64(out) };
	} catch (e: any) {
		return { ok: false, error: String(e?.message ?? e) };
	}
}

/** the shape `installZlib` needs of a PHP binary, so it can be driven from a test */
export type ZlibBinary = Record<string, unknown>;

/**
 * Installs the bridge on the PHP Module.
 *
 * Masked, like the SQL bridge in `@drupflare/durabledb`. fflate's sync deflate is
 * a long JavaScript frame under the PHP stack, which is exactly the window a
 * slice interrupt must not try to suspend across.
 *
 * @param binary
 *   The instantiated PHP module.
 * @param withMask
 *   The mask wrapper; injected rather than imported so the gate can assert that
 *   the call really happens inside it.
 */
export function installZlib(binary: ZlibBinary, withMask: <R>(fn: () => R) => R): ZlibBinary {
	binary[ZLIB_BRIDGE] = (json: string) =>
		withMask(() => {
			let req: ZlibRequest;
			try {
				req = JSON.parse(json) as ZlibRequest;
			} catch (e: any) {
				const why = String(e?.message ?? e);
				return JSON.stringify({ ok: false, error: `unparseable request: ${why}` });
			}
			return JSON.stringify(zlibHostCall(req));
		});
	return binary;
}

/**
 * The PHP half: the six functions and the three encoding constants.
 *
 * Defined only when the bridge resolves. Returning FALSE
 * from every call on a host with no bridge would let `AssetDumper` write a
 * zero-byte `.gz` next to a real `.css` and serve it as gzip, which is a broken
 * site that looks fine in the logs. An undefined function is loud, and a build
 * that has no bridge has no database either.
 *
 * Which functions: every zlib call site in Drupal 11.4.5 outside tests, found by
 * grep over the whole tree: `Asset\AssetDumper::dump()` calls
 * `gzencode($data, 9, FORCE_GZIP)`; `Component\Utility\UrlHelper` calls
 * `gzcompress()` and `@gzuncompress()`. `gzdecode`, `gzdeflate` and `gzinflate`
 * are carried because they are the inverses of the three that are reached and a
 * codec that can encode a form it cannot decode is a defect, not a saving.
 *
 * What is not covered, all three out of reach of a synchronous
 * bridge or off the served path: `gzopen()` and the rest of the stream family
 * (`pear/archive_tar`, the update manager's tarballs), `gzencode`/`gzdecode` in
 * `symfony/http-kernel`'s profiler storage, and the `compress.zlib://` stream
 * wrapper named by `Core\Command\DbImportCommand`. A stream wrapper is a
 * separate mechanism from a function, and none of the three runs while a page is
 * being served.
 */
export const ZLIB_FIX = String.raw`
// NO eval(), unlike mb-fix. A conditional declaration colliding with an internal function is
// deferred to runtime, so this compiles clean on a build that HAS zlib and the branch simply
// does not run -- verified with php -l plus a run on a host with the extension loaded. Plain
// PHP is what lets tests/node/php-fragments.spec.ts see inside the body at all.
if (!extension_loaded('zlib') && !function_exists('cfw_zlib_installed')) {
	$__cfw_zlib = function_exists('vrzno_env') ? vrzno_env('${ZLIB_BRIDGE}') : null;
	if ($__cfw_zlib !== null) {
		$GLOBALS['__cfw_zlib'] = $__cfw_zlib;

		// ext-zlib declares these, so they vanish with it. FORCE_GZIP is read by AssetDumper and
		// would be an Error("Undefined constant") without this line.
		if (!defined('ZLIB_ENCODING_RAW')) { define('ZLIB_ENCODING_RAW', -15); }
		if (!defined('ZLIB_ENCODING_DEFLATE')) { define('ZLIB_ENCODING_DEFLATE', 15); }
		if (!defined('ZLIB_ENCODING_GZIP')) { define('ZLIB_ENCODING_GZIP', 31); }
		if (!defined('FORCE_DEFLATE')) { define('FORCE_DEFLATE', 15); }
		if (!defined('FORCE_GZIP')) { define('FORCE_GZIP', 31); }

		function cfw_zlib_installed() { return true; }

		/**
		 * Runs one op over the bridge.
		 *
		 * @return array
		 *   ['ok' => true, 'data' => string] or ['ok' => false, 'error' => string].
		 */
		function cfw_zlib($op, $data, $level = -1) {
			$fn = $GLOBALS['__cfw_zlib'];
			$reply = json_decode(
				$fn(json_encode(['op' => $op, 'b64' => base64_encode((string) $data), 'level' => $level])),
				true
			);
			if (!is_array($reply) || ($reply['ok'] ?? false) !== true) {
				$why = is_array($reply) ? (string) ($reply['error'] ?? 'no reason given') : 'unreadable reply';
				return ['ok' => false, 'error' => $why];
			}
			$out = base64_decode((string) ($reply['b64'] ?? ''), true);
			if ($out === false) { return ['ok' => false, 'error' => 'reply was not base64']; }
			return ['ok' => true, 'data' => $out];
		}

		/**
		 * Raises the diagnostic ext-zlib raises, then answers FALSE like it does.
		 */
		function cfw_zlib_fail($name, $reason) {
			trigger_error($name . '(): ' . $reason, E_USER_WARNING);
			return false;
		}

		/**
		 * Refuses a level outside -1..9, with the ValueError ext-zlib throws.
		 */
		function cfw_zlib_level($name, $level) {
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
		 */
		function cfw_zlib_encoding($name, $encoding) {
			if ($encoding === 31) { return 'gzip'; }
			if ($encoding === 15) { return 'zlib'; }
			if ($encoding === -15) { return 'deflate'; }
			throw new ValueError(
				$name .
					"(): Argument #3 (\$encoding) must be one of ZLIB_ENCODING_RAW, ZLIB_ENCODING_GZIP, or ZLIB_ENCODING_DEFLATE"
			);
		}

		/**
		 * Applies $max_length the way zlib does, which is NOT a truncation.
		 *
		 * Measured: gzuncompress(gzcompress('hello world'), 5) is FALSE, not 'hello'. zlib fails
		 * the inflate when its output buffer is too small, so a cap below the payload is a data
		 * error rather than a short read. 0 means no cap.
		 */
		function cfw_zlib_cap($name, $data, $max_length) {
			if ($max_length > 0 && strlen($data) > $max_length) {
				return cfw_zlib_fail($name, 'data error');
			}
			return $data;
		}

		// the encoding defaults are spelled as ints rather than as the constants defined above, so
		// the signature does not depend on when a define() ran
		function gzencode($data, $level = -1, $encoding = 31) {
			$op = cfw_zlib_encoding('gzencode', $encoding);
			cfw_zlib_level('gzencode', $level);
			$r = cfw_zlib($op, $data, $level);
			return $r['ok'] ? $r['data'] : cfw_zlib_fail('gzencode', $r['error']);
		}

		function gzcompress($data, $level = -1, $encoding = 15) {
			$op = cfw_zlib_encoding('gzcompress', $encoding);
			cfw_zlib_level('gzcompress', $level);
			$r = cfw_zlib($op, $data, $level);
			return $r['ok'] ? $r['data'] : cfw_zlib_fail('gzcompress', $r['error']);
		}

		function gzdeflate($data, $level = -1, $encoding = -15) {
			$op = cfw_zlib_encoding('gzdeflate', $encoding);
			cfw_zlib_level('gzdeflate', $level);
			$r = cfw_zlib($op, $data, $level);
			return $r['ok'] ? $r['data'] : cfw_zlib_fail('gzdeflate', $r['error']);
		}

		function gzdecode($data, $max_length = 0) {
			$r = cfw_zlib('gunzip', $data);
			if (!$r['ok']) { return cfw_zlib_fail('gzdecode', 'data error'); }
			return cfw_zlib_cap('gzdecode', $r['data'], $max_length);
		}

		function gzuncompress($data, $max_length = 0) {
			$r = cfw_zlib('unzlib', $data);
			if (!$r['ok']) { return cfw_zlib_fail('gzuncompress', 'data error'); }
			return cfw_zlib_cap('gzuncompress', $r['data'], $max_length);
		}

		function gzinflate($data, $max_length = 0) {
			$r = cfw_zlib('inflate', $data);
			if (!$r['ok']) { return cfw_zlib_fail('gzinflate', 'data error'); }
			return cfw_zlib_cap('gzinflate', $r['data'], $max_length);
		}
	}
}
`;
