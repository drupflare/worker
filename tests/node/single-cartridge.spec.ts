import { globSync, readFileSync } from 'node:fs';
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

	it('has one installed copy that satisfies EVERY declared consumer', () => {
		// the invariant is the OUTCOME, not the mechanism. An `overrides` block used to force this and
		// is no longer needed: durabledb 0.1.1 asks for the same `^0.1.2` the worker does, so one copy
		// resolves naturally. What must never happen is a RANGE SKEW -- if a consumer's range stops
		// matching, a nested second copy becomes legal again, and cartridge exports a module-level
		// singleton whose counter IS the reentrancy gate, so two copies split it silently.
		const installed = JSON.parse(readFileSync(COPIES[0]!, 'utf8')).version as string;
		const consumers: Record<string, string> = {};

		const root = JSON.parse(readFileSync('package.json', 'utf8'));
		consumers['(this package)'] = root.dependencies['@drupflare/cartridge'];

		for (const dep of globSync('node_modules/@drupflare/*/package.json')) {
			const pkg = JSON.parse(readFileSync(dep, 'utf8'));
			const range =
				pkg.dependencies?.['@drupflare/cartridge'] ??
				pkg.peerDependencies?.['@drupflare/cartridge'];
			if (range) consumers[pkg.name] = range;
		}

		// every declared range must accept the single installed version. `^0.1.2` accepts 0.1.2+
		const major = installed.split('.').slice(0, 2).join('.');
		for (const [who, range] of Object.entries(consumers)) {
			expect(range, `${who} declares ${range}, installed is ${installed}`).toContain(major);
		}
		expect(Object.keys(consumers).length).toBeGreaterThan(1);
	});
});
