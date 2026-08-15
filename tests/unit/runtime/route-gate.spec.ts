import { describe, expect, it } from 'vitest';
import binary85Source from '../../../src/runtime/php-binary-85.ts?raw';
import binaryO2Source from '../../../src/runtime/php-binary-o2.ts?raw';
import binaryZstdSource from '../../../src/runtime/php-binary-zstd.ts?raw';
import siteDoSource from '../../../src/site-do.ts?raw';
import siteSource from '../../../src/site.ts?raw';
import wranglerSource from '../../../wrangler.jsonc?raw';

/**
 * The diagnostic gate, pinned at the source and at the shipping config.
 *
 * The defect this exists for: every route was behind `PW_DIAGNOSTICS`, `/serve` included,
 * and `wrangler.jsonc` -- the config `bun run deploy` uses -- set that flag to `"1"`. So a
 * deployed worker had exactly two states: serve pages AND expose `/php` (arbitrary PHP) and
 * `/sql` (arbitrary SQL against the site database) to anyone, or expose nothing and serve
 * nothing. There was no configuration that served a page without also shipping a remote
 * shell, and the default was the exposed one.
 *
 * `mountDrupalLazy`-style runtime assertions are not available for this -- the gate is in the
 * Worker's `fetch`, ahead of any binding -- so these are source assertions, the same bracket
 * `mask.spec.ts` uses and for the same stated reason. Quote-agnostic and whitespace-tolerant,
 * because a source assertion in this repo already broke once on prettier changing quote style.
 */

describe('the route gate lets a visitor in and keeps a shell out', () => {
	it('declares public and diagnostic routes as separate sets', () => {
		expect(/const PUBLIC_ROUTES = new Set\(/.test(siteSource)).toBe(true);
		expect(/const DIAGNOSTIC_ROUTES = new Set\(/.test(siteSource)).toBe(true);
	});

	it('puts serve in the public set and NOT in the diagnostic set', () => {
		const pub = siteSource.slice(
			siteSource.indexOf('const PUBLIC_ROUTES'),
			siteSource.indexOf('const DIAGNOSTIC_ROUTES')
		);
		expect(pub).toContain("'/serve'");
		const diag = siteSource.slice(
			siteSource.indexOf('const DIAGNOSTIC_ROUTES'),
			siteSource.indexOf('const ROUTES =')
		);
		expect(/'\/serve'/.test(diag)).toBe(false);
	});

	it.each(['/php', '/sql', '/export', '/savenode', '/firstrun', '/nativefetch'])(
		'keeps %s behind the diagnostic gate',
		(route) => {
			const diag = siteSource.slice(
				siteSource.indexOf('const DIAGNOSTIC_ROUTES'),
				siteSource.indexOf('const ROUTES =')
			);
			expect(diag).toContain(`'${route}'`);
		}
	);

	it('gates on membership of the public set rather than on the route table alone', () => {
		// the exact shape matters: an unconditional `PW_DIAGNOSTICS !== '1'` return is the bug
		expect(
			/if\s*\(\s*!PUBLIC_ROUTES\.has\([^)]+\)\s*&&\s*env\?\.PW_DIAGNOSTICS\s*!==\s*'1'\s*\)/.test(
				siteSource
			)
		).toBe(true);
	});

	it('still refuses an unknown path before either check', () => {
		const unknownAt = siteSource.indexOf('if (!ROUTES.has(');
		const gateAt = siteSource.indexOf('!PUBLIC_ROUTES.has(');
		expect(unknownAt).toBeGreaterThan(-1);
		expect(gateAt).toBeGreaterThan(unknownAt);
	});
});

/** every seam the alias is allowed to name, so a new one has to be registered here */
const SEAM_SOURCES: Record<string, string> = {
	'src/runtime/php-binary-o2.ts': binaryO2Source,
	'src/runtime/php-binary-zstd.ts': binaryZstdSource,
	'src/runtime/php-binary-85.ts': binary85Source
};

describe('the shipping config does not enable diagnostics', () => {
	it('leaves PW_DIAGNOSTICS unset in wrangler.jsonc', () => {
		// a commented-out line is fine and is what documents the decision; an ACTIVE
		// assignment is the defect. Match only an uncommented one
		const active = wranglerSource
			.split('\n')
			.filter((l) => !l.trim().startsWith('//'))
			.join('\n');
		expect(/"PW_DIAGNOSTICS"\s*:/.test(active)).toBe(false);
	});

	it('enables the lazy mount, which no config did before', () => {
		const active = wranglerSource
			.split('\n')
			.filter((l) => !l.trim().startsWith('//'))
			.join('\n');
		expect(/"LAZY_MOUNT"\s*:\s*"1"/.test(active)).toBe(true);
	});

	it('aliases the binary seam at a build that fits the free ceiling', () => {
		const active = wranglerSource
			.split('\n')
			.filter((l) => !l.trim().startsWith('//'))
			.join('\n');
		// the INVARIANT is the binary, not the filename: two seams ship `vendor/static-o2`, one as a
		// CompiledWasm import and one as a zstd frame, and pinning the name failed when the second
		// arrived even though the shipped interpreter never changed. What must never ship is a probe
		// build -- `static-free-v1` measured 586,923 OVER the ceiling
		const target =
			/"\.\/runtime\/php-binary\.js":\s*"\.\/(src\/runtime\/php-binary-[a-z0-9]+\.ts)"/.exec(
				active
			);
		expect(target).not.toBeNull();
		const seam = SEAM_SOURCES[target![1]!];
		expect(seam, `no seam source registered for ${target![1]}`).toBeDefined();
		// the invariant is a SANCTIONED binary, not one hardcoded path. `vendor/static-o2` is the
		// shipping 8.3; `.interp/php8.5` is a phasm artifact, and it lives outside vendor/ because
		// vendor/ holds unreproducible hand-built binaries and is never written to
		expect(seam).toMatch(/vendor\/static-o2\/|\.interp\/php8\.5/);
		// what must never ship is a probe build; `static-free-v1` measured 586,923 OVER the ceiling
		for (const probe of [
			'static-free-v1',
			'static-free/',
			'static-cap',
			'static-mem',
			'static-prof'
		]) {
			expect(seam, `${target![1]} references the probe build ${probe}`).not.toContain(probe);
		}
	});

	it('imports the binary through the exact specifier the alias keys on', () => {
		// measured: with `from './runtime/php-binary'` the alias key `./runtime/php-binary.js` does
		// not match, esbuild resolves the default seam, and the dry-run bundle went 2,876,078 ->
		// 3,856,138 gzipped bytes, 710,410 OVER the ceiling, carrying `static-free-v1`. The alias
		// value was correct throughout, so the assertion above cannot see it
		const alias = /"(\.\/[^"]*php-binary[^"]*)":/.exec(wranglerSource);
		expect(alias, 'wrangler.jsonc aliases no php-binary specifier').not.toBeNull();
		const specifier = alias![1]!.replace(/^\.\//, './');
		const imported = /from\s+'(\.\/runtime\/php-binary[^']*)'/.exec(siteDoSource);
		expect(imported, 'src/site-do.ts imports no binary seam').not.toBeNull();
		expect(imported![1]).toBe(specifier);
	});
});
