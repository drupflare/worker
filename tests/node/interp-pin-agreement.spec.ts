import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARCHIVED } from '../../scripts/backup-cdn.ts';
import { PIN_PATH, type InterpreterPin } from '../../scripts/fetch-interpreter.ts';

/** the two places that pin the shipping interpreter, held to each other; they drifted twice */

const pin: InterpreterPin = JSON.parse(readFileSync(resolve(process.cwd(), PIN_PATH), 'utf8'));
const mirrored = ARCHIVED.filter((e) => e.mirrors?.startsWith('.interp/'));

describe('interp.lock.json against cdn-manifest.json', () => {
	it('mirrors at least the wasm and its glue', () => {
		expect(mirrored.map((e) => e.mirrors).sort()).toEqual([
			'.interp/php8.5-worker.mjs',
			'.interp/php8.5.wasm'
		]);
	});

	it.each(mirrored)('agrees on $mirrors', (entry) => {
		const pinned = pin.files.find((f) => f.path === entry.mirrors);
		expect(
			pinned,
			`${entry.mirrors} is mirrored from the CDN but absent from ${PIN_PATH}`
		).toBeDefined();
		expect(pinned?.sha256).toBe(entry.sha256);
		expect(pinned?.bytes).toBe(entry.bytes);
	});

	it('names the variant in the CDN key, so the ABI is readable from either file', () => {
		for (const entry of mirrored) {
			expect(entry.key, entry.key).toContain(`static-${pin.variant}/`);
		}
	});

	it('pins the variant the fetch script actually fetches', () => {
		const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
		const cmd = String(pkg.scripts?.['fetch:interp85'] ?? '');
		expect(
			cmd,
			'fetch:interp85 would overwrite the shipping binary with another variant'
		).toContain(` ${pin.variant} `);
	});
});

describe('the pinned bytes are the bytes on disk', () => {
	const have = pin.files.every((f) => existsSync(resolve(process.cwd(), f.path)));

	it.skipIf(!have).each(pin.files)('$path is $bytes bytes', (file) => {
		expect(readFileSync(resolve(process.cwd(), file.path)).byteLength).toBe(file.bytes);
	});

	it.skipIf(have)('is skipped without .interp/, which a clean checkout does not have', () => {
		expect(existsSync(resolve(process.cwd(), '.interp/php8.5.wasm'))).toBe(false);
	});
});
