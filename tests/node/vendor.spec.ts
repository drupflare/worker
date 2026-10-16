import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VERSIONS, writeOnce } from '../../scripts/vendor';

const dirs: string[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), 'vendor-'));
	dirs.push(dir);
	return dir;
};

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * `vendor/` is append-only and its files are named in `cdn-manifest.json`, so a newer php-wasm
 * package must not be able to replace one of them. php-wasm 0.2.0 ships a different 8.3 build than
 * 0.1.0 did, which is the case this guards.
 */
describe('writeOnce', () => {
	it('writes a file that is not there yet', async () => {
		const path = join(scratch(), 'php8.3.wasm');
		expect(await writeOnce(path, new Uint8Array([1, 2, 3]))).toBe('written');
		expect([...readFileSync(path)]).toEqual([1, 2, 3]);
	});

	it('leaves a file that already holds the same bytes', async () => {
		const path = join(scratch(), 'php8.3-web.mjs');
		writeFileSync(path, 'glue');
		expect(await writeOnce(path, 'glue')).toBe('same');
	});

	it('refuses to replace a backed-up file with a different build', async () => {
		const path = join(scratch(), 'php8.3.wasm');
		writeFileSync(path, new Uint8Array([1, 2, 3]));
		await expect(writeOnce(path, new Uint8Array([9, 9]))).rejects.toThrow(/append-only/);
		expect([...readFileSync(path)]).toEqual([1, 2, 3]);
	});

	it('only ever extracts the two versions the store holds', () => {
		expect(VERSIONS).toEqual(['8.3', '8.4']);
	});
});
