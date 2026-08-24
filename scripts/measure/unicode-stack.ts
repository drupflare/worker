#!/usr/bin/env bun
/**
 * Re-emits the shipping mb_* stack as a PHP file a native process can require.
 *
 * The generation is the point. A hand-copied `cfw_mb_sanitize` would be a second copy of a
 * function whose whole job is byte-for-byte agreement with native mbstring, and the wrapped-function
 * list would go stale the first time someone added a wrapper. Both are read out of the shipping
 * fragment.
 *
 * Shared by `mb-parity.ts` (1,232 hand-chosen cases) and `unicode-corpus.ts` (every scalar value),
 * because two copies of this extraction is exactly the drift it exists to prevent.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ICONV_STRRPOS } from '../../src/drupal/iconv-fix.js';
import { MB_ASCII, MB_FIX, MB_SANITIZE } from '../../src/drupal/mb-fix.js';
import { UNICODE_TABLES } from '../../src/drupal/unicode-tables.js';

/**
 * The generated table, in the SIBLING module rather than in `src/`.
 *
 * `src/` is bundle bytes, measured after gzip against a 3 MiB ceiling; this tree is packed into
 * `assets/driver.json` and charged against an asset layer with 15,798 files spare. Measured A/B,
 * the same table costs 4,690 gzipped bundle bytes and zero here.
 */
export const TABLES = resolve(
	new URL('../..', import.meta.url).pathname,
	process.env.DRUPFLARE_SRC ?? '../drupflare',
	'src/unicode-tables.php'
);

/** undoes the single-quoted PHP string escaping the eval() wrappers are written in */
const unescapePhp = (s: string) => s.replace(/\\\\/g, '\\').replace(/\\'/g, "'");

/** the sanitiser body, out of its eval() so `php -l` and a native runner see real source */
export function sanitizeSource(): string {
	const inner = MB_SANITIZE.match(/eval\('([\s\S]*)'\);\s*\}\s*$/)?.[1];
	if (inner === undefined)
		throw new Error('MB_SANITIZE no longer has the eval() shape this reads');
	return unescapePhp(inner);
}

/** the mb_* names MB_FIX declares, read from the fragment rather than listed here */
export function wrappedFunctions(): string[] {
	const wrapped = [...MB_FIX.matchAll(/^function (mb_[a-z_0-9]+)\(/gm)].map(
		(m) => m[1] as string
	);
	if (wrapped.length === 0) throw new Error('MB_FIX declares no mb_* wrappers');
	return wrapped;
}

/**
 * The wrappers themselves, re-emitted into a namespace so a harness can CALL them.
 *
 * mb-parity.ts used to re-implement their argument handling instead -- sanitise the string args,
 * call the polyfill -- which stopped being the truth the moment a wrapper did anything else. It now
 * does an ASCII fast path, a final-sigma post-pass and a table pre-map, none of which a
 * re-implementation would have seen. Measure the shipping function, not a model of it.
 */
export function wrapperSource(): string {
	const src = MB_FIX.match(/cfw_mb_installed\(\) \{ return true; \}([\s\S]*?)'\); \}\s*$/)?.[1];
	if (src === undefined) throw new Error('MB_FIX no longer has the eval() shape this reads');
	return unescapePhp(src);
}

export interface StackFile {
	/** the generated PHP, requiring which defines the helpers and CFW_WRAPPED */
	path: string;
	/** the mb_* names MB_FIX wraps */
	wrapped: string[];
	/** false when ICONV_FIX was left out, which is how that fix gets priced */
	iconvFix: boolean;
}

/**
 * Writes the generated stack to a temp file.
 *
 * The wrappers land in `CfwShip\` rather than the global namespace: their names collide with the
 * real extension's internal functions, and the oracle process is one that HAS the extension.
 */
export function writeStackFile(opts: { iconvFix?: boolean; tables?: string } = {}): StackFile {
	const iconvFix = opts.iconvFix !== false;
	const tables = opts.tables ?? TABLES;
	const wrapped = wrappedFunctions();
	const dir = mkdtempSync(join(tmpdir(), 'mb-stack-'));
	const path = join(dir, 'stack.php');
	writeFileSync(
		path,
		[
			'<?php',
			'namespace {',
			'use Symfony\\Polyfill\\Iconv\\Iconv;',
			// the seam the loader reads: on the edge the table is at its mounted path, here it is
			// the sibling checkout the generator writes
			`define('CFW_UNICODE_TABLES', ${JSON.stringify(tables)});`,
			sanitizeSource(),
			MB_ASCII,
			UNICODE_TABLES,
			iconvFix ? ICONV_STRRPOS : '',
			`const CFW_WRAPPED = ${JSON.stringify(wrapped).replace(/"/g, "'")};`,
			'}',
			'namespace CfwShip {',
			wrapperSource(),
			'}'
		].join('\n')
	);
	return { path, wrapped, iconvFix };
}
