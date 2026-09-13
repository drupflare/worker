import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	INITIAL_PAGES,
	PRISTINE_PAGES,
	PRISTINE_WASM,
	readMemorySection,
	TUNED_WASM,
	withInitialPages
} from '../../scripts/measure/initial-memory.ts';
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

describe.skipIf(artifactGate([PRISTINE_WASM]))('the binaries on disk', () => {
	it('leaves the pristine download untouched, so its sha256 still verifies', () => {
		expect(pagesIn(PRISTINE_WASM)).toBe(PRISTINE_PAGES);
	});

	it('emits a tuned binary carrying the lower figure', () => {
		expect(existsSync(resolve(ROOT, TUNED_WASM)), `${TUNED_WASM} was never emitted`).toBe(true);
		expect(pagesIn(TUNED_WASM)).toBe(INITIAL_PAGES);
	});

	it('is what the shipping seam imports, not the pristine one', () => {
		const seam = readFileSync(resolve(ROOT, 'src/runtime/php-binary-raw.ts'), 'utf8');
		expect(seam).toContain(TUNED_WASM.replace('.interp/', ''));
		expect(seam).not.toMatch(/from '\.\.\/\.\.\/\.interp\/php8\.5\.wasm'/);
	});
});
