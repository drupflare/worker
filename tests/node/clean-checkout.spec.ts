import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Invariants that only break on a checkout WITHOUT the gitignored build artifacts.
 *
 * A developer machine has `vendor/`, `assets/` and the sibling repos, so every one of these passes
 * locally whatever their state. CI has none of them, and the first push failed four jobs on exactly
 * this: three `.mjs` specifiers that no ambient declaration covered, and three workflows that ran
 * `assets:driver` without checking out the modules it packs.
 *
 * Both checks are pure text over files in this repo, so they need no artifacts themselves -- which
 * is the point: a guard that needed the thing it guards could not run in the lane that fails.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const WORKFLOWS = join(ROOT, '.github/workflows');

/** every ambient wildcard `src/vendor.d.ts` declares, as the extension it ends in */
function declaredWildcards(): string[] {
	const src = readFileSync(join(ROOT, 'src/vendor.d.ts'), 'utf8');
	return [...src.matchAll(/declare module '\*([^']+)'/g)].map((m) => m[1] ?? '');
}

/** every relative import specifier under `src/` that points outside `src/` */
function externalSpecifiers(): { file: string; spec: string }[] {
	const out: { file: string; spec: string }[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, name.name);
			if (name.isDirectory()) {
				walk(full);
				continue;
			}
			if (!full.endsWith('.ts')) continue;
			const src = readFileSync(full, 'utf8');
			for (const m of src.matchAll(/from\s+'(\.\.\/\.\.\/[^']+)'/g)) {
				out.push({ file: full.slice(ROOT.length + 1), spec: m[1] ?? '' });
			}
		}
	};
	walk(join(ROOT, 'src'));
	return out;
}

describe('every specifier reaching a gitignored artifact has an ambient declaration', () => {
	it('covers each one with a wildcard in src/vendor.d.ts', () => {
		const wildcards = declaredWildcards();
		// `vendor/`, `assets/` and `.interp/` are all gitignored, so tsc and typedoc resolve these
		// through the declarations alone on a clean checkout
		const uncovered = externalSpecifiers().filter(
			({ spec }) => !wildcards.some((w) => spec.endsWith(w))
		);
		expect(uncovered).toEqual([]);
	});

	it('declares at least the three extensions the build actually imports', () => {
		// a guard that passed because the list was empty would be worse than none
		const wildcards = declaredWildcards();
		expect(wildcards).toContain('.mjs');
		expect(wildcards).toContain('.wasm');
		expect(wildcards).toContain('.zst');
		expect(externalSpecifiers().length).toBeGreaterThan(10);
	});
});

describe('every workflow that packs the Drupal modules can reach them', () => {
	const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'));

	/** the sibling checkouts and env vars `scripts/gen-driver-assets.ts` needs */
	const REQUIRED = [
		'DRUPFLARE_SRC: .siblings/drupflare',
		'ROM_SRC: .siblings/rom',
		'repository: drupflare/drupflare',
		'repository: drupflare/rom'
	];

	const packing = files.filter((f) =>
		readFileSync(join(WORKFLOWS, f), 'utf8').includes('assets:driver')
	);

	it('finds the workflows that pack at all, so an empty list cannot pass', () => {
		// the siblings are the source of truth for the modules and `drupal/` is gone, so a packing
		// job without them fails with "no module files under <path>"
		expect(packing.length).toBeGreaterThan(0);
	});

	it.each(REQUIRED)('every packing workflow carries %s', (needle) => {
		const missing = packing.filter(
			(f) => !readFileSync(join(WORKFLOWS, f), 'utf8').includes(needle)
		);
		expect(missing).toEqual([]);
	});
});
