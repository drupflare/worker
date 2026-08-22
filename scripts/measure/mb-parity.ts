#!/usr/bin/env bun
/**
 * Drives `mb-parity.php`, generating its sanitiser input out of `mb-fix.ts`.
 *
 * The generation is the point. A hand-copied `cfw_mb_sanitize` would be a second
 * copy of a function whose whole job is byte-for-byte agreement with native
 * mbstring, and the wrapped-function list would go stale the first time someone
 * added a wrapper. Both are read out of the shipping fragment here.
 *
 * usage: bun scripts/measure/mb-parity.ts [--json] [--root=./drupal-src]
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ICONV_STRRPOS } from '../../src/drupal/iconv-fix.js';
import { MB_ASCII, MB_FIX, MB_SANITIZE } from '../../src/drupal/mb-fix.js';

const here = new URL('.', import.meta.url).pathname;
const args = process.argv.slice(2);
const root = resolve(
	args.find((a) => a.startsWith('--root='))?.slice(7) ?? `${here}../../drupal-src`
);

// MB_SANITIZE wraps its body in eval() so the fragment can be concatenated after
// other statements; unwrap it here so php -l and this runner see real source
const inner = MB_SANITIZE.match(/eval\('([\s\S]*)'\);\s*\}\s*$/)?.[1];
if (inner === undefined) throw new Error('MB_SANITIZE no longer has the eval() shape this reads');
const sanitizeSrc = inner.replace(/\\\\/g, '\\').replace(/\\'/g, "'");

const wrapped = [...MB_FIX.matchAll(/^function (mb_[a-z_0-9]+)\(/gm)].map((m) => m[1]);
if (wrapped.length === 0) throw new Error('MB_FIX declares no mb_* wrappers');

// The wrappers themselves, re-emitted into a namespace so the harness can CALL them.
// It used to re-implement their argument handling instead -- sanitise the string args,
// call the polyfill -- which stopped being the truth the moment a wrapper did anything
// else. It now does: an ASCII fast path and a final-sigma post-pass, neither of which a
// re-implementation would have seen. Measure the shipping function, not a model of it.
const wrapperSrc = MB_FIX.match(
	/cfw_mb_installed\(\) \{ return true; \}([\s\S]*?)'\); \}\s*$/
)?.[1];
if (wrapperSrc === undefined) throw new Error('MB_FIX no longer has the eval() shape this reads');
const wrapperPhp = wrapperSrc.replace(/\\\\/g, '\\').replace(/\\'/g, "'");

// --no-iconv-fix leaves cfw_iconv_strrpos undefined, so the harness falls back to
// the upstream polyfill; that is how ICONV_FIX gets priced rather than asserted
const withIconvFix = !args.includes('--no-iconv-fix');
const dir = mkdtempSync(join(tmpdir(), 'mb-parity-'));
const file = join(dir, 'sanitize.php');
writeFileSync(
	file,
	[
		'<?php',
		'namespace {',
		'use Symfony\\Polyfill\\Iconv\\Iconv;',
		sanitizeSrc,
		MB_ASCII,
		withIconvFix ? ICONV_STRRPOS : '',
		`const CFW_WRAPPED = ${JSON.stringify(wrapped).replace(/"/g, "'")};`,
		'}',
		// the wrappers name internal functions, so they can only be declared away from
		// the global namespace on a build that HAS the extension
		'namespace CfwShip {',
		wrapperPhp,
		'}'
	].join('\n')
);

const r = spawnSync(
	'php',
	[
		'-d',
		'opcache.enable_cli=0',
		'-d',
		'xdebug.mode=off',
		join(here, 'mb-parity.php'),
		`--root=${root}`,
		`--sanitize=${file}`,
		...args.filter((a) => a === '--json')
	],
	{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }
);
if (r.error) throw r.error;

console.log(r.stdout);
console.log(`wrappers read from MB_FIX: ${wrapped.length} (${wrapped.join(' ')})`);
console.log(`ICONV_FIX applied: ${withIconvFix}`);
