/**
 * Replaces `ext-zstd` with `node:zlib`'s zstd, which workerd ships under nodejs_compat, so no
 * compressor is added to the bundle.
 *
 * Dictionaries pass through: node:zlib takes one as an option on both calls, and the CLI reads
 * the frames both ways (checked by tests/node/codec-shims.spec.ts).
 * @module
 */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { base64ToBytes, bytesToBase64 } from '../../db/file-store';
import { errorMessage } from '../../util/errors';
import { ZSTD_FIX_PHP } from '../generated/assets';

/** the Module key the PHP half resolves through `vrzno_env()` */
export const ZSTD_BRIDGE = 'cfwZstd';

/** the level ext-zstd defaults to, and the highest it accepts */
export const ZSTD_LEVEL_DEFAULT = 3;
export const ZSTD_LEVEL_MAX = 22;

/** what the PHP half sends */
export type ZstdRequest = {
	op?: string;
	b64?: string;
	level?: number;
	/** a preset dictionary, base64; absent or empty means none */
	dict?: string;
};

/** what it gets back */
export type ZstdReply = { ok: true; b64: string } | { ok: false; error: string };

/**
 * One compression or decompression, decoded (exported so the gate can drive it).
 *
 * A failure is a reply, not a throw: the PHP functions return false on bad input.
 *
 * @internal
 */
export function zstdHostCall(req: ZstdRequest): ZstdReply {
	try {
		const bytes = base64ToBytes(String(req.b64 ?? ''));
		const dict = String(req.dict ?? '');
		const dictionary = dict === '' ? undefined : base64ToBytes(dict);
		if (req.op === 'compress') {
			const level = Number(req.level ?? ZSTD_LEVEL_DEFAULT);
			if (!Number.isInteger(level) || level > ZSTD_LEVEL_MAX) {
				return {
					ok: false,
					error: `compression level (${String(req.level)}) must be within 1..22 or smaller then 0`
				};
			}
			// workerd zstd refuses incompressible input above 4 KiB; a stored frame is valid zstd
			let out: Uint8Array;
			try {
				out = zstdCompressSync(bytes, {
					params: { [constants.ZSTD_c_compressionLevel]: level },
					dictionary
				});
			} catch {
				out = storedZstdFrame(bytes);
			}
			return { ok: true, b64: bytesToBase64(out) };
		}
		if (req.op === 'uncompress') {
			return { ok: true, b64: bytesToBase64(zstdDecompressSync(bytes, { dictionary })) };
		}
		return { ok: false, error: `unknown zstd op '${String(req.op)}'` };
	} catch (e) {
		return { ok: false, error: errorMessage(e) };
	}
}

/** the largest block a zstd frame may carry */
const ZSTD_BLOCK_MAX = 1 << 17;

/**
 * One single-segment zstd frame of raw (stored) blocks: the frame RFC 8878 defines for data that
 * does not compress, with no entropy coding and no checksum. Every zstd reader accepts it.
 *
 * @internal
 */
export function storedZstdFrame(plain: Uint8Array): Uint8Array {
	const n = plain.length;
	const blocks = Math.max(1, Math.ceil(n / ZSTD_BLOCK_MAX));
	const out = new Uint8Array(4 + 1 + 8 + n + blocks * 3);
	const view = new DataView(out.buffer);
	view.setUint32(0, 0xfd2fb528, true);
	// single segment, 8-byte content size, no checksum, no dictionary id
	out[4] = 0xe0;
	view.setBigUint64(5, BigInt(n), true);
	let at = 13;
	for (let b = 0; b < blocks; b++) {
		const start = b * ZSTD_BLOCK_MAX;
		const size = Math.min(ZSTD_BLOCK_MAX, n - start);
		const last = b === blocks - 1 ? 1 : 0;
		// block type 0 is raw
		const header = (size << 3) | last;
		out[at] = header & 0xff;
		out[at + 1] = (header >> 8) & 0xff;
		out[at + 2] = (header >> 16) & 0xff;
		at += 3;
		out.set(plain.subarray(start, start + size), at);
		at += size;
	}
	return out;
}

/** the shape `installZstd` needs of a PHP binary, so it can be driven from a test */
export type ZstdBinary = Record<string, unknown>;

/**
 * Installs the bridge on the PHP Module, masked like the other synchronous bridges: level 19 is a
 * long JS frame, and a slice interrupt must not suspend across it.
 */
export function installZstd(binary: ZstdBinary, withMask: <R>(fn: () => R) => R): ZstdBinary {
	binary[ZSTD_BRIDGE] = (json: string) =>
		withMask(() => {
			let req: ZstdRequest;
			try {
				req = JSON.parse(json) as ZstdRequest;
			} catch (e) {
				return JSON.stringify({
					ok: false,
					error: `unparseable request: ${errorMessage(e)}`
				});
			}
			return JSON.stringify(zstdHostCall(req));
		});
	return binary;
}

/**
 * The PHP half: `zstd_compress()`, `zstd_uncompress()`, the two `_dict` pairs and their
 * constants, declared only where ext-zstd is absent and the bridge resolves.
 */
export const ZSTD_FIX = ZSTD_FIX_PHP;
