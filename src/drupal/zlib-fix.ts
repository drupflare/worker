/**
 * Replaces `ext-zlib` with fflate so the six gz* functions Drupal reaches survive a
 * `WITH_ZLIB=0` build.
 *
 * Not `CompressionStream`: it is a stream and PHP's gz* functions are synchronous (`ASYNCIFY=0`,
 * so a host function returning a Promise hands PHP an object it can only stringify).
 * @module
 */
import { deflateSync, gunzipSync, gzipSync, inflateSync, unzlibSync, zlibSync } from 'fflate';
import { deflateSync as nodeDeflate, inflateSync as nodeInflate } from 'node:zlib';
import { base64ToBytes, bytesToBase64 } from '../db/file-store';
import { ZLIB_FIX_PHP } from '../site/generated/assets';
import { errorMessage } from '../util/errors';

/** the Module key the PHP half resolves through `vrzno_env()` */
export const ZLIB_BRIDGE = 'cfwZlib';

/**
 * The container each PHP function wants, named the way the request carries it.
 *
 * gzip is `RFC1952`, zlib `RFC1950`, raw a bare `RFC1951` stream; they are not interchangeable.
 */
export type ZlibOp = 'gzip' | 'gunzip' | 'zlib' | 'unzlib' | 'deflate' | 'inflate';

/** what the PHP half sends */
export type ZlibRequest = {
	op?: string;
	b64?: string;
	level?: number;
	/** a preset dictionary, base64; absent or empty means none */
	dict?: string;
};

/**
 * The ops a preset dictionary may be used with: zlib only, because gzip has no header field for
 * one and a raw stream has no dictionary checksum. They run on `node:zlib`, not fflate: given a
 * wrong dictionary it answers "Bad dictionary" where fflate returns plausible garbage.
 */
export const DICTIONARY_OPS = ['zlib', 'unzlib'] as const;

/** what it gets back */
export type ZlibReply = { ok: true; b64: string } | { ok: false; error: string };

/** PHP's level to fflate's; -1 (library default) resolves to 6 because fflate has no sentinel */
export function zlibLevel(level: unknown): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
	const n = Number(level);
	if (!Number.isFinite(n) || n === -1) return 6;
	const clamped = Math.min(9, Math.max(0, Math.trunc(n)));
	return clamped as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

/**
 * One compression or decompression, decoded (exported so the gate can drive every op).
 *
 * `mtime: 0` is load-bearing: fflate stamps the time into the gzip header while zlib writes 0, so
 * `gzencode()` would not be reproducible.
 *
 * @internal
 */
export function zlibApply(
	op: string,
	bytes: Uint8Array,
	level: number,
	dictionary?: Uint8Array
): Uint8Array {
	if (dictionary !== undefined) {
		if (!(DICTIONARY_OPS as readonly string[]).includes(op)) {
			throw new Error(`op '${op}' does not carry a preset dictionary`);
		}
		// node:zlib rather than fflate: only it verifies the dictionary checksum
		const out =
			op === 'zlib'
				? nodeDeflate(bytes, { dictionary, level: zlibLevel(level) })
				: nodeInflate(bytes, { dictionary });
		return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
	}
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
 * A failure is a reply, not a throw: the PHP functions return false on bad input (Drupal calls
 * `gzuncompress()` on user-supplied base64).
 *
 * @internal
 */
export function zlibHostCall(req: ZlibRequest): ZlibReply {
	try {
		const dict = String(req.dict ?? '');
		const out = zlibApply(
			String(req.op ?? ''),
			base64ToBytes(String(req.b64 ?? '')),
			Number(req.level ?? -1),
			dict === '' ? undefined : base64ToBytes(dict)
		);
		return { ok: true, b64: bytesToBase64(out) };
	} catch (e) {
		return { ok: false, error: errorMessage(e) };
	}
}

/** the shape `installZlib` needs of a PHP binary, so it can be driven from a test */
export type ZlibBinary = Record<string, unknown>;

/**
 * Installs the bridge on the PHP Module, masked like the SQL bridge (a slice interrupt must not
 * suspend across fflate's long synchronous frame).
 *
 * @param binary
 *   The instantiated PHP module.
 * @param withMask
 *   The mask wrapper; injected so the gate can assert the call happens inside it.
 */
export function installZlib(binary: ZlibBinary, withMask: <R>(fn: () => R) => R): ZlibBinary {
	binary[ZLIB_BRIDGE] = (json: string) =>
		withMask(() => {
			let req: ZlibRequest;
			try {
				req = JSON.parse(json) as ZlibRequest;
			} catch (e) {
				const why = errorMessage(e);
				return JSON.stringify({ ok: false, error: `unparseable request: ${why}` });
			}
			return JSON.stringify(zlibHostCall(req));
		});
	return binary;
}

/**
 * The PHP half: the six gz* functions, the encoding constants and `cfw_zlib_dict()`.
 *
 * The gz* functions are defined only when the bridge resolves (a stub returning false would let
 * `AssetDumper` serve a zero-byte `.gz` as gzip). Stream functions and `compress.zlib://` are not
 * covered. `cfw_zlib_dict()` sits outside the extension guard: the shipping binary loads ext-zlib,
 * which has no dictionary support.
 */
export const ZLIB_FIX = ZLIB_FIX_PHP;
