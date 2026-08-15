#!/usr/bin/env node
/**
 * Runs MB_PROBE2 natively and against a wasm build, then diffs the malformed
 * UTF-8 block. Deterministic: the same inputs always produce the same
 * verdict, so the comparison never depends on reading two JSON blobs by eye.
 *
 * usage: node scripts/measure/mb-diff.mjs <wasm-url> [drupal-root]
 *   node scripts/measure/mb-diff.mjs http://localhost:8801/mb2 ./drupal-src
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MB_PROBE2 } from '../src/probes/mb-probe2.js';

const url = process.argv[2] ?? 'http://localhost:8801/mb2';
const root = resolve(process.argv[3] ?? './drupal-src');
const tmp = '/tmp/phpwasm-build/mb';
mkdirSync(tmp, { recursive: true });

const phpFile = `${tmp}/mb-probe2.php`;
writeFileSync(phpFile, MB_PROBE2);

const nativeRaw = execFileSync(
	'/opt/homebrew/bin/php',
	[
		'-d',
		'opcache.enable_cli=0',
		'-d',
		'xdebug.mode=off',
		'-r',
		`define('MB_ROOT', ${JSON.stringify(root)}); require ${JSON.stringify(phpFile)};`
	],
	{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
);
const native = JSON.parse(nativeRaw.slice(nativeRaw.indexOf('{')));

const res = await fetch(url);
const wasmRaw = await res.text();
const wasm = JSON.parse(wasmRaw.slice(wasmRaw.indexOf('{')));

const hex = (h) =>
	h === ''
		? "''"
		: Buffer.from(h, 'hex')
				.toString('latin1')
				.replace(/[\x00-\x1f]/g, '.');

const rows = [];
let same = 0;
let diff = 0;
for (const key of Object.keys(native.invalid)) {
	for (const fn of Object.keys(native.invalid[key])) {
		const n = native.invalid[key][fn];
		const w = wasm.invalid?.[key]?.[fn];
		const eq = JSON.stringify(n) === JSON.stringify(w);
		eq ? same++ : diff++;
		const fmt = (v) =>
			fn.startsWith('mb_substr') || fn === 'mb_strtolower' || fn === 'mb_convert_utf8'
				? hex(String(v))
				: String(v);
		rows.push({
			input: key,
			fn,
			native: fmt(n),
			wasm: fmt(w),
			match: eq ? 'yes' : 'NO'
		});
	}
}

const blanked = rows.filter(
	(r) => r.fn.startsWith('mb_substr') && r.wasm === "''" && r.native !== "''"
);

console.log(
	`native php: ${execFileSync('/opt/homebrew/bin/php', ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8' })}`
);
console.log(
	`build: ${res.headers.get('x-build') ?? '?'}  mount files: ${res.headers.get('x-mount-files') ?? '?'}`
);
console.log(
	`ext: native mbstring=${native.ext.mbstring} iconv=${native.ext.iconv} | wasm mbstring=${wasm.ext.mbstring} iconv=${wasm.ext.iconv}`
);
console.log('');
console.log('| input | function | native | wasm | match |');
console.log('| --- | --- | --- | --- | --- |');
for (const r of rows)
	console.log(`| ${r.input} | ${r.fn} | ${r.native} | ${r.wasm} | ${r.match} |`);
console.log('');
console.log(`compared ${rows.length} cells: ${same} identical, ${diff} divergent`);
console.log(
	`mb_substr blanked-to-empty cases: ${blanked.length} (0 means the data-loss bug is closed)`
);
console.log(`VERDICT: ${blanked.length === 0 ? 'BUG CLOSED' : 'BUG STILL PRESENT'}`);

// the other three divergences AGENT-FINDINGS recorded, so one run answers all of
// them rather than only the serious one
const cmp = (label, n, w) => {
	const eq = JSON.stringify(n) === JSON.stringify(w);
	console.log(
		`| ${label} | ${JSON.stringify(n)} | ${JSON.stringify(w)} | ${eq ? 'yes' : 'NO'} |`
	);
	return eq;
};
console.log('');
console.log('| other divergence | native | wasm | match |');
console.log('| --- | --- | --- | --- |');
const d2 = cmp(
	'DIVERGENCE 2 greek final sigma (ODOS lower)',
	native.greek.ODOS.lower,
	wasm.greek?.ODOS?.lower
);
const d2t = cmp(
	'DIVERGENCE 2 greek title (ODOS)',
	native.greek.ODOS.title,
	wasm.greek?.ODOS?.title
);
const d3 = cmp(
	'DIVERGENCE 3 mb_strwidth emoji',
	native.strwidth.emoji_grin,
	wasm.strwidth?.emoji_grin
);
const d4 = cmp('DIVERGENCE 4 Unicode::check()', native.unicode_check, wasm.unicode_check);
const d4s = cmp(
	'DIVERGENCE 4 Unicode::getStatus()',
	native.unicode_getStatus,
	wasm.unicode_getStatus
);
console.log('');
console.log(
	`divergences 2/3/4 closed: ${[d2 && d2t, d3, d4 && d4s].filter(Boolean).length} of 3 (greek, strwidth, self-report)`
);
