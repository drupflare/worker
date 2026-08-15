import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Generates a synthetic PHP tree plus a packed blob of the same files, so the
 * cost of N individual ASSETS subrequests can be compared against one fetch.
 *
 * File sizes are drawn to match real Drupal core PHP files rather than being
 * uniform: measured median is ~4 KB with a long tail past 100 KB.
 *
 *   bun scripts/measure/gen-assets.mjs --out=/tmp/gen-assets [count]
 *
 * The seed and the size distribution are the instrument behind the
 * granular-vs-packed table in TECHNICAL_REPORT.md, so do not change them: with
 * the default count this prints `200 files, 2988695 bytes total, median 8354
 * bytes`, which is the figure that table cites.
 */

/**
 * Everything this script writes; anything else in the target is somebody else's.
 */
const OWN_OUTPUT = new Set(['lib', 'pack.bin', 'pack.json']);

const outFlag = process.argv.find((a) => a.startsWith('--out='));
if (!outFlag) {
	// no default: this used to resolve to ../assets and rm -rf it, which is the
	// 48 MB generated pack tree plus driver.json and drupal-sql
	console.error('usage: bun scripts/measure/gen-assets.mjs --out=<dir> [count]');
	console.error('  --out is required; it is emptied before generating');
	process.exit(1);
}
const outDir = resolve(outFlag.slice('--out='.length));
const COUNT = Number(process.argv.filter((a) => !a.startsWith('--out='))[2] ?? 200);

// refuse a target holding anything this script did not produce, so pointing it
// at a real asset directory fails instead of emptying it
const existing = await readdir(outDir).catch(() => []);
const foreign = existing.filter((e) => !OWN_OUTPUT.has(e));
if (foreign.length > 0) {
	console.error(`refusing to empty ${outDir}: it holds files this script did not generate`);
	console.error(`  found: ${foreign.slice(0, 8).join(', ')}${foreign.length > 8 ? ', ...' : ''}`);
	process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(resolve(outDir, 'lib'), { recursive: true });

// deterministic pseudo-random so runs are comparable
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const files = [];
for (let i = 0; i < COUNT; i++) {
	// log-ish distribution: mostly small, occasional large
	const bytes = Math.floor(500 + rand() ** 3 * 60000);
	const filler = '// ' + 'x'.repeat(Math.max(0, bytes - 120));
	const src = `<?php
class Gen${i} {
	public const ID = ${i};
	public static function value(): int { return ${i} * 2; }
}
${filler}
`;
	const name = `lib/gen${i}.php`;
	await writeFile(resolve(outDir, name), src);
	files.push({ name, bytes: src.length });
}

// packed form: one blob plus an index, the profile-guided-packing shape
const parts = [];
const index = [];
let offset = 0;
for (const f of files) {
	const src = await import('node:fs/promises').then((fs) => fs.readFile(resolve(outDir, f.name)));
	index.push({ name: f.name, offset, length: src.length });
	parts.push(src);
	offset += src.length;
}
await writeFile(resolve(outDir, 'pack.bin'), Buffer.concat(parts));
await writeFile(resolve(outDir, 'pack.json'), JSON.stringify(index));

const total = offset;
console.log(
	`${COUNT} files, ${total} bytes total, median ${
		files.map((f) => f.bytes).sort((a, b) => a - b)[Math.floor(COUNT / 2)]
	} bytes`
);
console.log(`packed: assets/pack.bin (${total} bytes) + assets/pack.json`);
