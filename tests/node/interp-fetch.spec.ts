import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertSeamImports, buildPin, type FetchResult } from '../../scripts/fetch-interpreter.ts';
import { assertDeclaredSize, packWasm } from '../../scripts/pack-wasm-zstd.ts';

/**
 * The interpreter update lane fetches 12 MB of unreviewable binary and packs it, so everything it
 * can get wrong SILENTLY is checked here.
 *
 * Two failures shape these assertions. A frame whose header disagrees with the binary inflates to
 * the wrong length and throws at isolate startup on the edge, where the only symptom is an exit
 * code. And a fetch for the wrong PHP version writes files the aliased seam does not import, so on
 * a hydrated tree the bundle builds, the size gate passes, and what was measured is the incumbent.
 *
 * Node lane: it shells out to the zstd CLI and reads the filesystem.
 */

const temps: string[] = [];
function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), 'interp-spec-'));
	temps.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** a zstd frame header declaring `size` in the 4-byte single-segment form the CLI emits */
function frameDeclaring(size: number): Uint8Array {
	const bytes = new Uint8Array(9);
	bytes.set([0x28, 0xb5, 0x2f, 0xfd, 0xa0]);
	new DataView(bytes.buffer).setUint32(5, size, true);
	return bytes;
}

/** a header with the content-size field absent, which is legal and unusable */
function frameDeclaringNothing(): Uint8Array {
	return new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00]);
}

function hasZstd(): boolean {
	try {
		execFileSync('zstd', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

/** a checkout whose canonical config aliases a seam importing the 8.5 interpreter */
function checkout(): string {
	const root = fixture();
	mkdirSync(join(root, 'src/runtime'), { recursive: true });
	writeFileSync(
		join(root, 'wrangler.jsonc'),
		'{ "alias": { "./runtime/php-binary.js": "./src/runtime/php-binary-85.ts" } }'
	);
	writeFileSync(
		join(root, 'src/runtime/php-binary-85.ts'),
		[
			"import PHPFactory from '../../.interp/php8.5-worker.mjs';",
			"import blob from '../../.interp/php8.5.wasm.zst';",
			"import decoder from '../../.interp/zstddec.wasm';",
			'export { PHPFactory, blob, decoder };'
		].join('\n')
	);
	return root;
}

function result(phpVersion: string, overrides: Partial<FetchResult> = {}): FetchResult {
	return {
		wasm: `.interp/php${phpVersion}.wasm`,
		glue: `.interp/php${phpVersion}-worker.mjs`,
		frame: `.interp/php${phpVersion}.wasm.zst`,
		raw: 12_218_393,
		packed: 2_659_133,
		declared: 12_218_393,
		artifactId: '4102938475',
		...overrides
	};
}

describe('a frame that declares the wrong length is a startup throw on the edge', () => {
	it('accepts a header declaring exactly what was packed', () => {
		expect(assertDeclaredSize(frameDeclaring(12_218_393), 12_218_393, 'php8.5.wasm')).toBe(
			12_218_393
		);
	});

	it('refuses a header that disagrees, naming both numbers', () => {
		expect(() =>
			assertDeclaredSize(frameDeclaring(12_218_400), 12_218_393, 'php8.5.wasm')
		).toThrow(/declares 12218400 inflated bytes against 12218393/);
	});

	it('refuses a header with no content size at all', () => {
		// the wasm decoder cannot size its output buffer from a frame like this and throws instead
		expect(() => assertDeclaredSize(frameDeclaringNothing(), 64, 'php8.5.wasm')).toThrow(
			/declares no content size/
		);
	});

	it('refuses bytes that are not a zstd frame', () => {
		expect(() => assertDeclaredSize(new Uint8Array([0, 1, 2, 3, 4, 5]), 6, 'x.wasm')).toThrow(
			/declares no content size/
		);
	});

	it.skipIf(!hasZstd())('round-trips a real CLI frame, which is what the pack produces', () => {
		const root = fixture();
		const source = join(root, 'sample.wasm');
		// incompressible bytes, so the frame cannot collapse to a degenerate header
		const raw = new Uint8Array(4096).map((_, i) => (i * 37 + (i >> 3)) & 0xff);
		writeFileSync(source, raw);

		const packed = packWasm(source, join(root, 'out'));
		expect(packed.raw).toBe(4096);
		expect(packed.declared).toBe(4096);
		expect(packed.out).toBe(join(root, 'out', 'sample.wasm.zst'));
	});
});

describe('the pin is the only reviewable part of an interpreter bump', () => {
	it('content-addresses every file and records which artifact produced them', () => {
		const root = fixture();
		mkdirSync(join(root, '.interp'), { recursive: true });
		writeFileSync(join(root, '.interp/php8.5.wasm'), 'wasm');
		writeFileSync(join(root, '.interp/php8.5-worker.mjs'), 'glue');
		writeFileSync(join(root, '.interp/php8.5.wasm.zst'), 'frame');

		const paths = result('8.5', {
			wasm: join(root, '.interp/php8.5.wasm'),
			glue: join(root, '.interp/php8.5-worker.mjs'),
			frame: join(root, '.interp/php8.5.wasm.zst')
		});
		const pin = buildPin(paths, 'control85', '8.5', 'drupflare/phasm');

		expect(pin.name).toBe('drupflare-interpreter-pin');
		expect(pin.version).toBe(1);
		expect(pin.variant).toBe('control85');
		expect(pin.phpVersion).toBe('8.5');
		expect(pin.artifactId).toBe('4102938475');
		expect(pin.frame).toEqual({ raw: 12_218_393, packed: 2_659_133, declared: 12_218_393 });
		expect(pin.files).toHaveLength(3);
		for (const file of pin.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(pin.files.map((f) => `${f.path.split('/').pop()}:${f.bytes}`)).toEqual([
			'php8.5-worker.mjs:4',
			'php8.5.wasm:4',
			'php8.5.wasm.zst:5'
		]);
	});

	it('orders the files, so the same fetch produces the same pin', () => {
		const root = fixture();
		mkdirSync(join(root, '.interp'), { recursive: true });
		for (const name of ['php8.5.wasm', 'php8.5-worker.mjs', 'php8.5.wasm.zst']) {
			writeFileSync(join(root, '.interp', name), name);
		}
		const paths = result('8.5', {
			wasm: join(root, '.interp/php8.5.wasm'),
			glue: join(root, '.interp/php8.5-worker.mjs'),
			frame: join(root, '.interp/php8.5.wasm.zst')
		});
		const once = buildPin(paths, 'control85', '8.5');
		const twice = buildPin(paths, 'control85', '8.5');
		expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
		expect(once.files.map((f) => f.path)).toEqual([...once.files.map((f) => f.path)].sort());
	});
});

describe('fetching a version the seam does not import measures the incumbent', () => {
	it('passes when the fetched files are the ones the alias reaches', () => {
		expect(() => assertSeamImports(checkout(), result('8.5'))).not.toThrow();
	});

	it('refuses a fetch for a version the seam never imports', () => {
		expect(() => assertSeamImports(checkout(), result('8.3'))).toThrow(
			/would ship the interpreter already on disk/
		);
	});

	it('names both sides, because the tree still builds and the gate still passes', () => {
		let message = '';
		try {
			assertSeamImports(checkout(), result('8.3'));
		} catch (cause) {
			message = cause instanceof Error ? cause.message : String(cause);
		}
		expect(message).toContain('.interp/php8.5.wasm.zst');
		expect(message).toContain('.interp/php8.3.wasm.zst');
	});
});
