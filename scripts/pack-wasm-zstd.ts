/**
 * Recompresses an interpreter binary with zstd so the bundle ships it as a `Data` module.
 *
 * WHY. Cloudflare measures the bundle after ITS OWN gzip, and gzip cannot shrink bytes that are
 * already well compressed. Measured on wrangler's own reported figure, the PHP 8.5 binary counts
 * 3,641,600 as `CompiledWasm` and 2,643,722 as a zstd blob. The shipping 8.3 binary goes from
 * 2,779,161 to 2,070,852.
 *
 * ```sh
 * bun scripts/pack-wasm-zstd.ts vendor/static-o2/php8.3-worker.mjs.wasm
 * ```
 *
 * Reads `vendor/` and never writes to it -- the binaries there are unreproducible.
 *
 * @see src/runtime/php-binary-zstd.ts for the consumer
 * @see https://github.com/drupflare/cartridge `wasmModuleFromZstd` for the inflate half
 */

import { zstdContentSize } from '@drupflare/cartridge/inflate';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** where the packed frames land; gitignored, rebuilt from vendor/ on demand */
export const OUT_DIR = '.interp';

/**
 * `--ultra -22` measured 4,306 bytes better than `-19` on the 8.5 binary. `--long=27` was WORSE by
 * 1,896, so the bigger window is not free here.
 */
const ZSTD_ARGS = ['--ultra', '-22', '-q', '-f'];

/**
 * Asserts a frame declares the raw length it was built from.
 *
 * The frame header's content size is what `wasmModuleFromZstd` pre-sizes its output buffer from at
 * startup, so a frame that declares the wrong length -- or omits the field, which `zstd` does when
 * it compresses a stream rather than a file -- is an interpreter that fails on the edge and nowhere
 * else. Reads the header with cartridge's own parser, so producer and consumer cannot disagree.
 *
 * @param frame - the packed bytes, header included
 * @param raw - the byte length of the file that was packed
 * @returns the declared length, which equals `raw`
 * @throws when the field is absent or disagrees.
 */
export function assertDeclaredSize(frame: Uint8Array, raw: number, source: string): number {
	const declared = zstdContentSize(frame);
	if (declared === undefined) {
		throw new Error(
			`the frame packed from ${source} declares no content size, so the seam cannot ` +
				'pre-size its output and the wasm decoder refuses it outright'
		);
	}
	if (declared !== raw) {
		throw new Error(
			`the frame packed from ${source} declares ${declared} inflated bytes against ${raw} on disk`
		);
	}
	return declared;
}

/**
 * Whether an existing frame was packed from the binary now on disk.
 *
 * `--ultra -22` over 12 MB is the slowest repeatable step in the whole build, and it is pure waste
 * when the interpreter has not moved. The frame's own header carries the inflated length, so the
 * cache key is read out of the artifact rather than kept beside it -- a `.zst` that declares a
 * different length was packed from a different binary and is rebuilt.
 *
 * The mtime comparison is the second half: a rebuild of the same interpreter to the same byte count
 * is exactly what phasm has been measured doing (12,218,400 then 12,218,393), so length alone is a
 * weaker key than it looks.
 */
export function frameIsCurrent(source: string, out: string): boolean {
	if (!existsSync(out)) return false;
	try {
		if (statSync(out).mtimeMs < statSync(source).mtimeMs) return false;
		return zstdContentSize(readFileSync(out)) === statSync(source).size;
	} catch {
		return false;
	}
}

/**
 * Compress one wasm binary, returning the before/after sizes and the length the frame declares.
 *
 * @param force - repack even when {@link frameIsCurrent} says the frame on disk already matches
 */
export function packWasm(
	source: string,
	outDir = OUT_DIR,
	force = false
): { raw: number; packed: number; declared: number; out: string; cached: boolean } {
	const raw = statSync(source).size;
	mkdirSync(outDir, { recursive: true });
	const out = join(outDir, `${basename(source)}.zst`);

	if (!force && frameIsCurrent(source, out)) {
		const existing = readFileSync(out);
		return {
			raw,
			packed: existing.byteLength,
			declared: assertDeclaredSize(existing, raw, source),
			out,
			cached: true
		};
	}

	let frame: Buffer;
	try {
		frame = execFileSync('zstd', [...ZSTD_ARGS, '-c', source], { maxBuffer: 1 << 30 });
	} catch (cause) {
		// a build step, so a missing tool is a setup error rather than something to fall back from:
		// gzip would silently produce a frame fzstd cannot read
		throw new Error(
			`the zstd CLI is required to pack ${source} and did not run (${cause instanceof Error ? cause.message : String(cause)}). Install it: brew install zstd`
		);
	}
	const declared = assertDeclaredSize(frame, raw, source);
	writeFileSync(out, frame);
	return { raw, packed: frame.byteLength, declared, out, cached: false };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const force = args.includes('--force');
	const sources = args.filter((a: string) => !a.startsWith('--'));
	if (sources.length === 0) {
		console.error('usage: bun scripts/pack-wasm-zstd.ts <wasm> [<wasm>...] [--force]');
		process.exit(2);
	}
	for (const source of sources) {
		const { raw, packed, declared, out, cached } = packWasm(source, OUT_DIR, force);
		const saved = raw - packed;
		console.log(
			`${out}  raw=${raw}  zstd=${packed}  declared=${declared}  ` +
				`(-${saved}, ${((100 * saved) / raw).toFixed(1)}%)` +
				(cached ? '  [cached, --force repacks]' : '')
		);
	}
}
