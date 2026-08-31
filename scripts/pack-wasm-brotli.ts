/**
 * Recompresses an interpreter binary with brotli so the bundle ships it as a `Data` module.
 *
 * SAME MECHANISM AS THE ZSTD PACKER, BETTER RATIO. Cloudflare measures the bundle after its own
 * gzip and gzip cannot shrink bytes that are already well compressed, so what matters is the state
 * the bytes are in when they reach the meter. Measured on this interpreter, `wrangler deploy
 * --dry-run` reporting: 2,671,745 bytes as a zstd frame against 2,485,488 as a brotli one.
 *
 * The reason brotli became usable is the INFLATE side, not the ratio. `node:zlib` carries brotli,
 * workerd runs `brotliDecompressSync` at module scope, and that removes the 25,473-byte
 * `zstddec.wasm` the zstd path had to ship to avoid a slow pure-JS decoder. See
 * `src/runtime/php-binary-85.ts`.
 *
 * ```sh
 * bun scripts/pack-wasm-brotli.ts .interp/php8.5.wasm
 * ```
 *
 * Reads `vendor/` and never writes to it -- the binaries there are unreproducible.
 *
 * @see scripts/pack-wasm-zstd.ts, which still packs the 8.3 seam and the experiment arms
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

export const OUT_DIR = '.interp';

/**
 * Quality 11 is the maximum. The WINDOW is the interesting parameter and it is a memory decision
 * rather than a size one: `lgwin` 24 asks the decoder for a 16 MiB ring buffer and 22 asks for
 * 4 MiB, for 18,738 bytes of difference on this binary (2,466,750 against 2,485,488).
 *
 * 22 is chosen. The frame is inflated at module scope inside a Durable Object isolate capped at
 * 128 MiB, and this project's repeated production failure is that ceiling rather than the bundle
 * one -- an authenticated render has been measured at 138.63 MiB. Spending 12 MiB of transient
 * startup allocation to save 18 KiB on a meter that already has room is the wrong side of that
 * trade. Revisit only with a measurement of module-scope peak on a deployed object.
 *
 * Measured and rejected: `lgwin` 20 costs 95,244 more; `large_window` 30 is 3 bytes worse than 24
 * and needs a decoder opt-in.
 */
const LGWIN = 22;

const PARAMS = {
	[constants.BROTLI_PARAM_QUALITY]: 11,
	[constants.BROTLI_PARAM_LGWIN]: LGWIN,
	[constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC
};

/**
 * Whether an existing frame was packed from the binary now on disk.
 *
 * MTIME ONLY, and that is a real difference from the zstd packer rather than an omission. That one
 * cross-checks the length the zstd header declares; brotli has no such field, so there is nothing to
 * read back. The zstd packer's own docblock records that mtime is the STRONGER of its two keys --
 * phasm has been measured rebuilding the same interpreter to a different byte count (12,218,400 then
 * 12,218,393), which a length key misses and mtime catches.
 */
export function frameIsCurrent(source: string, out: string): boolean {
	if (!existsSync(out)) return false;
	try {
		return statSync(out).mtimeMs >= statSync(source).mtimeMs;
	} catch {
		return false;
	}
}

/**
 * Compress one wasm binary.
 *
 * @param force - repack even when {@link frameIsCurrent} says the frame on disk already matches
 */
export function packWasmBrotli(
	source: string,
	outDir = OUT_DIR,
	force = false
): { raw: number; packed: number; out: string; cached: boolean } {
	const raw = statSync(source).size;
	mkdirSync(outDir, { recursive: true });
	const out = join(outDir, `${basename(source)}.br`);

	if (!force && frameIsCurrent(source, out)) {
		return { raw, packed: statSync(out).size, out, cached: true };
	}

	// node's own brotli rather than the CLI: the runtime that INFLATES this is also node's, so
	// producer and consumer are the same implementation and cannot disagree about a parameter
	const frame = brotliCompressSync(readFileSync(source), { params: PARAMS });
	writeFileSync(out, frame);
	return { raw, packed: frame.byteLength, out, cached: false };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const force = args.includes('--force');
	const sources = args.filter((a: string) => !a.startsWith('--'));
	if (sources.length === 0) {
		console.error('usage: bun scripts/pack-wasm-brotli.ts <wasm> [<wasm>...] [--force]');
		process.exit(2);
	}
	for (const source of sources) {
		const { raw, packed, out, cached } = packWasmBrotli(source, OUT_DIR, force);
		const saved = raw - packed;
		console.log(
			`${out}  raw=${raw}  brotli=${packed}  lgwin=${LGWIN}  ` +
				`(-${saved}, ${((100 * saved) / raw).toFixed(1)}%)` +
				(cached ? '  [cached, --force repacks]' : '')
		);
	}
}
