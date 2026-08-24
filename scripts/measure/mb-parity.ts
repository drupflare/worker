#!/usr/bin/env bun
/**
 * Drives `mb-parity.php` over 1,232 hand-chosen cases, generating its subject out of `mb-fix.ts`.
 *
 * The wide sweep lives next door: `unicode-corpus.ts` runs every Unicode scalar value through the
 * same stack. This one exists for what a codepoint sweep cannot reach -- malformed byte families,
 * offsets, needles, encodings, and the return types around them.
 *
 * usage: bun scripts/measure/mb-parity.ts [--json] [--no-iconv-fix] [--root=./drupal-src]
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeStackFile } from './unicode-stack.js';

const here = new URL('.', import.meta.url).pathname;
const args = process.argv.slice(2);
const root = resolve(
	args.find((a) => a.startsWith('--root='))?.slice(7) ?? `${here}../../drupal-src`
);

// --no-iconv-fix leaves cfw_iconv_strrpos undefined, so the harness falls back to the upstream
// polyfill; that is how ICONV_FIX gets priced rather than asserted
const stack = writeStackFile({ iconvFix: !args.includes('--no-iconv-fix') });

const r = spawnSync(
	'php',
	[
		'-d',
		'opcache.enable_cli=0',
		'-d',
		'xdebug.mode=off',
		`${here}mb-parity.php`,
		`--root=${root}`,
		`--sanitize=${stack.path}`,
		...args.filter((a) => a === '--json')
	],
	{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }
);
if (r.error) throw r.error;

console.log(r.stdout);
console.log(`wrappers read from MB_FIX: ${stack.wrapped.length} (${stack.wrapped.join(' ')})`);
console.log(`ICONV_FIX applied: ${stack.iconvFix}`);
