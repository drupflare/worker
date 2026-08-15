import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLATFORM_PHP_VERSION } from '../../src/ops/packagist';

/**
 * The build command a one-click deploy runs must work on a CLEAN CLONE.
 *
 * "Deploy to Cloudflare" clones the template, provisions the bindings declared in `wrangler.jsonc`,
 * then runs install and build before deploying. Workers Builds picks up `build`, so whatever that
 * name means is what a stranger's first deploy executes.
 *
 * It used to mean `vendor && assets`, which bakes the Drupal tree with native PHP against
 * `drupal-src/` -- a directory that is gitignored and has ZERO tracked files. So the button would
 * have died on its first step, on a repository whose entire premise is that the button works. The
 * maintainer's rebuild is `build:all`; `build` hydrates the release payload, which is a plain HTTPS
 * GET needing no Docker, no `gh` auth and no Cloudflare credential.
 *
 * Node lane: it reads package.json and .gitignore from disk.
 */

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
	scripts: Record<string, string>;
};

/** every script the named one expands to, following `bun run x` chains one level at a time */
function expand(name: string, seen = new Set<string>()): string[] {
	if (seen.has(name)) return [];
	seen.add(name);
	const body = pkg.scripts[name];
	if (body === undefined) return [];
	const out = [body];
	for (const [, called] of body.matchAll(/bun run ([a-z0-9:_-]+)/g)) {
		out.push(...expand(called as string, seen));
	}
	return out;
}

describe('the build a one-click deploy runs', () => {
	it('resolves to hydrate, which needs no Docker, no token and no PHP', () => {
		expect(pkg.scripts.build).toBeDefined();
		expect(expand('build').join(' ')).toContain('hydrate');
	});

	it('never reaches a step that needs the Drupal source tree', () => {
		// drupal-src is gitignored with no tracked files, so a clean clone does not have it
		expect(readFileSync('.gitignore', 'utf8')).toMatch(/^drupal-src$/m);
		const steps = expand('build').join(' ');
		expect(steps, 'build must not read drupal-src').not.toContain('drupal-src');
	});

	it('never reaches a step that needs native PHP or Docker', () => {
		const steps = expand('build').join(' ');
		expect(steps, 'build must not shell out to php').not.toMatch(/\bphp\b/);
		expect(steps, 'build must not need docker').not.toMatch(/\bdocker\b/);
	});

	it('keeps the maintainer rebuild reachable under its own name', () => {
		// renaming it away would be worse than the bug: the full rebuild still has to exist
		const all = expand('build:all').join(' ');
		expect(all).toContain('drupal-src');
		expect(all).toMatch(/\bphp\b/);
	});

	it('declares only bindings a one-click deploy can provision', () => {
		// the button provisions what wrangler.jsonc declares; anything requiring a manual step
		// before first deploy breaks the premise
		const config = readFileSync('wrangler.jsonc', 'utf8')
			.split('\n')
			.map((l) => l.replace(/^\s*\/\/.*$/, ''))
			.join('\n');
		const parsed = JSON.parse(config) as Record<string, unknown>;
		expect(parsed.durable_objects).toBeDefined();
		expect(parsed.assets).toBeDefined();
		expect(parsed.main).toBe('src/site.ts');
	});
});

describe('the PHP version the oracle claims, against the binary that ships', () => {
	/** the seam `wrangler.jsonc` aliases, derived rather than named */
	function shippingSeam(): string {
		const config = readFileSync('wrangler.jsonc', 'utf8')
			.split('\n')
			.map((l) => l.replace(/^\s*\/\/.*$/, ''))
			.join('\n');
		const alias = (JSON.parse(config).alias ?? {}) as Record<string, string>;
		const seam = Object.values(alias).find((t) => t.includes('php-binary'));
		if (!seam) throw new Error('wrangler.jsonc has no php-binary alias');
		return seam.replace(/^\.\//, '');
	}

	it('matches the interpreter the shipping seam imports', () => {
		// THE THIRD HARDCODED VERSION TO DRIFT IN ONE DAY. `DEFAULT_PLATFORM.php` sat at 8.3.0
		// while the binary moved to 8.5, so every package requiring >=8.4 was refused as
		// unsatisfiable by a platform that satisfies it -- and a refusal reads as a considered
		// answer, so nothing looked broken. The twig bake and the drupal.org metadata path failed
		// the same way. A constant compared only to itself cannot catch any of them.
		const source = readFileSync(shippingSeam(), 'utf8');
		const found = source.match(/php(\d+\.\d+)-worker\.mjs/);
		expect(
			found,
			`no php<major>.<minor>-worker.mjs import in ${shippingSeam()}`
		).not.toBeNull();
		const shipped = found![1];
		expect(
			PLATFORM_PHP_VERSION.split('.').slice(0, 2).join('.'),
			`the oracle claims PHP ${PLATFORM_PHP_VERSION} and the seam imports ${shipped}`
		).toBe(shipped);
	});
});
