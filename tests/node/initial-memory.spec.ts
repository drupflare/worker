import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	importsMemory,
	INITIAL_PAGES,
	PRISTINE_PAGES,
	PRISTINE_WASM,
	readMemorySection,
	TUNED_WASM,
	withImportedMemory,
	withInitialPages
} from '../../scripts/measure/initial-memory.ts';
import { sourceOf } from '../helpers/source';
import { artifactGate } from './helpers/artifact-gate';

/**
 * The interpreter's INITIAL_MEMORY, which decides how much of the isolate is left for a workload.
 *
 * At the published 96 MiB an object five renders old holds 125.83 MiB of a 128 MiB isolate, and
 * anything that then asks for a second interpreter resets it -- which is what took the e2e lane
 * down. At 80 the same workload holds 119.58. The whole curve is in `initial-memory.ts`; what is
 * pinned here is that the tuned binary the seam imports actually carries the lower figure, because
 * the emit is a build step and a build step that silently no-ops is this repo's signature failure.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
const pagesIn = (file: string) =>
	readMemorySection(new Uint8Array(readFileSync(resolve(ROOT, file)))).minPages;

describe('the page count the shipping binary declares', () => {
	it('is lower than the published one, or the tuning bought nothing', () => {
		expect(INITIAL_PAGES).toBeLessThan(PRISTINE_PAGES);
	});

	/**
	 * 768 pages measured best and 512 did not run at all, so the floor is real and close. 40 MiB
	 * (640) reads WORSE than 48 -- the growth step rounds every rise, so a lower start moves where
	 * each later rounding lands rather than simply subtracting.
	 */
	it('stays inside the range that was actually measured', () => {
		expect(INITIAL_PAGES).toBeGreaterThanOrEqual(768);
		expect(INITIAL_PAGES).toBeLessThanOrEqual(1536);
	});

	it('encodes in the same LEB128 field, so no offset in the module moves', () => {
		const pristine = new Uint8Array(readFileSync(resolve(ROOT, PRISTINE_WASM)));
		const before = readMemorySection(pristine);
		const after = withInitialPages(pristine, INITIAL_PAGES);
		expect(after.length, 'the patch changed the file length').toBe(pristine.length);
		expect(readMemorySection(after).minPages).toBe(INITIAL_PAGES);
		expect(readMemorySection(after).minAt).toBe(before.minAt);
	});

	it('refuses a page count the field cannot hold rather than half-applying it', () => {
		const pristine = new Uint8Array(readFileSync(resolve(ROOT, PRISTINE_WASM)));
		// 16384 pages needs three LEB bytes where 1536 takes two
		expect(() => withInitialPages(pristine, 16_384)).toThrow(/does not fit/);
	});
});

describe('the memory the shipping binary imports', () => {
	/** a module with one function import, one memory and a `memory` export: the shipping shape */
	const tiny = () =>
		Uint8Array.from([
			0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
			// type: () -> ()
			0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
			// import env.f
			0x02, 0x09, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00,
			// memory: min 2, max 10
			0x05, 0x04, 0x01, 0x01, 0x02, 0x0a,
			// export memory 0
			0x07, 0x0a, 0x01, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
			// data: 3 bytes at 16
			0x0b, 0x0a, 0x01, 0x00, 0x41, 0x10, 0x0b, 0x03, 0x61, 0x62, 0x63
		]);

	it('moves the memory to an env.memory import with the same limits', async () => {
		const out = withImportedMemory(tiny());
		const module = await WebAssembly.compile(out);
		expect(WebAssembly.Module.imports(module)).toEqual([
			{ module: 'env', name: 'f', kind: 'function' },
			{ module: 'env', name: 'memory', kind: 'memory' }
		]);
		expect(WebAssembly.Module.exports(module)).toEqual([{ name: 'memory', kind: 'memory' }]);
		expect(importsMemory(out)).toBe(true);
		expect(importsMemory(tiny())).toBe(false);
		expect(readMemorySection(out)).toMatchObject({ minPages: 2, maxPages: 10 });
	});

	it('instantiates into a passed memory, rewriting the data but nothing else', async () => {
		const memory = new WebAssembly.Memory({ initial: 3, maximum: 10 });
		const view = new Uint8Array(memory.buffer);
		view[100] = 7;
		const { instance } = await WebAssembly.instantiate(withImportedMemory(tiny()), {
			env: { f: () => {}, memory }
		});
		expect(instance.exports.memory).toBe(memory);
		expect([...view.subarray(16, 19)]).toEqual([0x61, 0x62, 0x63]);
		expect(view[100], 'the host is what zeroes a reused memory, not the module').toBe(7);
	});

	it('refuses a module that already imports its memory', () => {
		expect(() => withImportedMemory(withImportedMemory(tiny()))).toThrow(/no memory section/);
	});
});

describe.skipIf(artifactGate([PRISTINE_WASM]))('the binaries on disk', () => {
	it('leaves the pristine download untouched, so its sha256 still verifies', () => {
		expect(pagesIn(PRISTINE_WASM)).toBe(PRISTINE_PAGES);
	});

	it('emits a tuned binary carrying the lower figure', () => {
		expect(existsSync(resolve(ROOT, TUNED_WASM)), `${TUNED_WASM} was never emitted`).toBe(true);
		expect(pagesIn(TUNED_WASM)).toBe(INITIAL_PAGES);
		expect(importsMemory(new Uint8Array(readFileSync(resolve(ROOT, TUNED_WASM))))).toBe(true);
	});

	// the host builds the memory the binary imports, so the two figures disagreeing is a LinkError on every boot
	it('matches the memory the host creates for a boot', () => {
		const host = sourceOf('src/do/isolate.ts');
		const initial = /INTERPRETER_MEMORY = \{ initial: (\d+),/.exec(host)?.[1];
		expect(Number(initial)).toBe(INITIAL_PAGES);
		expect(pagesIn(TUNED_WASM)).toBe(Number(initial));
	});

	it('is what the shipping seam imports, not the pristine one', () => {
		const seam = readFileSync(resolve(ROOT, 'src/runtime/php-binary-raw.ts'), 'utf8');
		expect(seam).toContain(TUNED_WASM.replace('.interp/', ''));
		expect(seam).not.toMatch(/from '\.\.\/\.\.\/\.interp\/php8\.5\.wasm'/);
	});
});
