import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Imports that bundle under vite and not under esbuild, which is what wrangler uses.
 *
 * edgeport 1.0.6's root barrel re-exports 20 namespaces it never imports; vite tolerates that and
 * esbuild emits no bundle, so the whole gate was green while `wrangler deploy` was broken.
 * `wrangler deploy --dry-run` is the real check; this is the cheap guard that runs every commit.
 */

const ROOT = new URL('../..', import.meta.url).pathname;

/** package roots that are broken barrels, and the subpath to use instead */
const BROKEN_ROOTS: Readonly<Record<string, string>> = {
	// re-exports dns/ftp/imap/irc/ldap/... with no matching import; `edgeport/core` declares the
	// error classes properly and is the subpath `tcp.ts` and `mail.ts` already use
	edgeport: 'edgeport/core'
};

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) sourceFiles(full, out);
		else if (entry.endsWith('.ts')) out.push(full);
	}
	return out;
}

describe('shipping imports', () => {
	const files = sourceFiles(join(ROOT, 'src'));

	it('reads every module under src/', () => {
		expect(files.length).toBeGreaterThan(50);
	});

	for (const [pkg, instead] of Object.entries(BROKEN_ROOTS)) {
		it(`no module imports the ${pkg} root barrel`, () => {
			const pattern = new RegExp(`from\\s+['"]${pkg}['"]`);
			const offenders = files
				.filter((f) => pattern.test(readFileSync(f, 'utf8')))
				.map((f) => f.slice(ROOT.length));
			expect(
				offenders,
				`${pkg}'s root barrel does not bundle under esbuild; import from ${instead}`
			).toEqual([]);
		});
	}

	// the control: a regex over a package name is exactly the kind of check that stops matching
	it('the pattern matches a root import when one is present', () => {
		const pattern = new RegExp(`from\\s+['"]edgeport['"]`);
		expect(pattern.test(`import { AuthError } from 'edgeport';`)).toBe(true);
		expect(pattern.test(`import { connect } from 'edgeport/core';`)).toBe(false);
	});
});
