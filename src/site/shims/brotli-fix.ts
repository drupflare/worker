/**
 * Replaces `ext-brotli` with `node:zlib`'s brotli, for the two functions strata reaches.
 *
 * node:zlib takes no preset dictionary for brotli, so a dictionary is refused here rather than
 * dropped: a stream written against a dictionary the reader does not hold decodes to nothing
 * useful, and nothing fails until it does.
 * @module
 */
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { base64ToBytes, bytesToBase64 } from '../../db/file-store';
import { errorMessage } from '../../util/errors';
import { BROTLI_FIX_PHP } from '../generated/assets';

/** the Module key the PHP half resolves through `vrzno_env()` */
export const BROTLI_BRIDGE = 'cfwBrotli';

/** what the PHP half sends */
export type BrotliRequest = {
	op?: string;
	b64?: string;
	level?: number;
	mode?: number;
	/** a preset dictionary, base64; absent or empty means none */
	dict?: string;
};

/** what it gets back */
export type BrotliReply = { ok: true; b64: string } | { ok: false; error: string };

/**
 * One compression or decompression, decoded (exported so the gate can drive it).
 *
 * A failure is a reply, not a throw: the PHP functions return false on bad input.
 *
 * @internal
 */
export function brotliHostCall(req: BrotliRequest): BrotliReply {
	try {
		if (String(req.dict ?? '') !== '') {
			return { ok: false, error: 'preset dictionaries are not supported on this host' };
		}
		const bytes = base64ToBytes(String(req.b64 ?? ''));
		if (req.op === 'compress') {
			const level = Number(req.level ?? 11);
			if (!Number.isInteger(level) || level < 0 || level > 11) {
				return {
					ok: false,
					error: `compression level (${String(req.level)}) must be within 0..11`
				};
			}
			const mode = Number(req.mode ?? 0);
			if (mode !== 0 && mode !== 1 && mode !== 2) {
				return {
					ok: false,
					error: `compression mode (${String(req.mode)}) is not GENERIC, TEXT or FONT`
				};
			}
			const out = brotliCompressSync(bytes, {
				params: {
					[constants.BROTLI_PARAM_QUALITY]: level,
					[constants.BROTLI_PARAM_MODE]: mode
				}
			});
			return { ok: true, b64: bytesToBase64(out) };
		}
		if (req.op === 'uncompress') {
			return { ok: true, b64: bytesToBase64(brotliDecompressSync(bytes)) };
		}
		return { ok: false, error: `unknown brotli op '${String(req.op)}'` };
	} catch (e) {
		return { ok: false, error: errorMessage(e) };
	}
}

/** the shape `installBrotli` needs of a PHP binary, so it can be driven from a test */
export type BrotliBinary = Record<string, unknown>;

/**
 * Installs the bridge on the PHP Module, masked like the other synchronous bridges: quality 11 is
 * a long JS frame, and a slice interrupt must not suspend across it.
 */
export function installBrotli(binary: BrotliBinary, withMask: <R>(fn: () => R) => R): BrotliBinary {
	binary[BROTLI_BRIDGE] = (json: string) =>
		withMask(() => {
			let req: BrotliRequest;
			try {
				req = JSON.parse(json) as BrotliRequest;
			} catch (e) {
				return JSON.stringify({
					ok: false,
					error: `unparseable request: ${errorMessage(e)}`
				});
			}
			return JSON.stringify(brotliHostCall(req));
		});
	return binary;
}

/**
 * The PHP half: `brotli_compress()`, `brotli_uncompress()` and their constants, declared only
 * where ext-brotli is absent and the bridge resolves.
 */
export const BROTLI_FIX = BROTLI_FIX_PHP;
