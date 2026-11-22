/**
 * Runs the package checks on a real plugin archive and on two damaged copies of it.
 *
 * ```sh
 * bun scripts/wp/real-plugin-archives.ts <folder> <slug> <version>
 * ```
 *
 * The folder holds `<slug>.<version>.zip` as wordpress.org serves it. The archive is read from disk
 * and never committed. The checks are the pure ones `deliverPackage()` runs before it writes:
 * the pinned digest, the archive rules and the main file's headers. Nothing here touches a site.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_WP_PACKAGES } from '../../src/wordpress/generated/packages';
import { readHeader } from '../../src/wordpress/registry';
import { readZipPackage, ZipRefused } from '../../src/wordpress/zip';
import { buildZip } from '../../tests/fixtures/wordpress/zip-builder';

const [folder, slug, version] = process.argv.slice(2);
if (!folder || !slug || !version) {
	console.error('usage: bun scripts/wp/real-plugin-archives.ts <folder> <slug> <version>');
	process.exit(2);
}

const pin = GENERATED_WP_PACKAGES[slug]?.versions[version];
if (!pin) {
	console.error(`${slug} ${version} is not pinned`);
	process.exit(2);
}

const sha256 = async (bytes: Uint8Array) =>
	`sha256:${Buffer.from(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)).toString('hex')}`;

const real = new Uint8Array(readFileSync(join(folder, `${slug}.${version}.zip`)));
const decoder = new TextDecoder();

const rows: string[][] = [['case', 'digest matches pin', 'archive rules', 'headers']];

const good = readZipPackage(real, slug);
const main = good.files.find((f) => f.path === `${slug}.php`)!;
const source = decoder.decode(main.bytes.subarray(0, 8192));
rows.push([
	'real archive',
	String((await sha256(real)) === pin.digest),
	`accepted, ${good.files.length} files, ${good.skipped.length} skipped`,
	`Version ${readHeader(source, 'Version')}, Requires PHP ${readHeader(source, 'Requires PHP')}`
]);

const flipped = real.slice();
flipped[Math.floor(flipped.length / 2)]! ^= 0xff;
let flippedRules: string;
try {
	readZipPackage(flipped, slug);
	flippedRules = 'accepted (the digest is what refuses it)';
} catch (e) {
	flippedRules = e instanceof ZipRefused ? `refused: ${e.rule}` : `threw: ${String(e)}`;
}
rows.push(['one byte flipped', String((await sha256(flipped)) === pin.digest), flippedRules, '-']);

const injected = buildZip([
	{ name: `${slug}/` },
	...good.files.map((f) => ({ name: `${slug}/${f.path}`, data: f.bytes })),
	{ name: `${slug}/../evil.php`, data: '<?php // injected' }
]);
let injectedRules: string;
try {
	readZipPackage(injected, slug);
	injectedRules = 'ACCEPTED';
} catch (e) {
	injectedRules = e instanceof ZipRefused ? `refused: ${e.rule}` : `threw: ${String(e)}`;
}
rows.push([
	'a ../ entry added',
	String((await sha256(injected)) === pin.digest),
	injectedRules,
	'-'
]);

for (const row of rows) console.log(row.join(' | '));
