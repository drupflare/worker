import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Exactly one copy of `@drupflare/cartridge` may be installed.
 *
 * A duplicate install is a correctness bug, not a size one. `cartridge/src/mask.ts` exports
 * `export const mask = createMask()` -- a module-level singleton holding `let depth = 0` -- and the
 * reentrancy gate is that counter. Two copies means two counters: `withMask()` increments one while
 * `maskDepth()` reads the other, so a genuine reentrant call goes undetected, and a reentrant call
 * into the interpreter hangs forever rather than throwing.
 *
 * This happened. Pinning `"@drupflare/cartridge": "0.1.1"` exactly, while `durabledb@0.1.0` asks for
 * `^0.1.0`, left a nested `0.1.0` in place; both reached the bundle, which carried the
 * `unbalanced mask` string twice instead of once. `bun install --force` deduped it and the
 * `overrides` entry in package.json keeps it deduped.
 *
 * Node lane, because it reads the installed tree and workerd has no `node:fs`.
 */

const COPIES = globSync('node_modules/**/@drupflare/cartridge/package.json');

describe('the cartridge install is not duplicated', () => {
	it('finds exactly one copy on disk', () => {
		expect(COPIES, `found ${COPIES.length} copies:\n${COPIES.join('\n')}`).toHaveLength(1);
	});

	it('has that copy at the top level, not nested under another package', () => {
		expect(COPIES[0]).toBe('node_modules/@drupflare/cartridge/package.json');
	});

	/**
	 * THE RANGE-SKEW CALCULATION IS GONE. It read every `@drupflare/*` package.json, extracted the
	 * declared range for cartridge and asserted each one accepted the installed version -- which is
	 * dependency arithmetic against whatever the lockfile resolved this morning, not a statement about
	 * this repository. If a skew ever does install a second copy, the two cases above say so directly.
	 */
});
