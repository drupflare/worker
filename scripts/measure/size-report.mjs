#!/usr/bin/env node
/**
 * Uniform size verdict for a static php-wasm build directory: raw bytes, gzip -9
 * bytes for wasm and glue, the free/paid ceiling verdict, whether a dylink
 * section is present in the first 16 bytes, and the asyncify symbol count.
 *
 * usage: node scripts/measure/size-report.mjs vendor/static-o2 vendor/static-iconv ...
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const FREE = 3145728;
const PAID = 10485760;

// shells out to gzip -9 rather than node:zlib: every gzip figure already in
// TECHNICAL_REPORT.md came from `gzip -9 -c | wc -c`, and zlib's output is ~18 KB larger
// on the wasm, which would make the new numbers non-comparable
const gz = (path) =>
	Number(
		execSync(`gzip -9 -c ${JSON.stringify(path)} | wc -c`, {
			encoding: 'utf8'
		}).trim()
	);

const rows = [];
for (const dir of process.argv.slice(2)) {
	let files;
	try {
		files = readdirSync(dir);
	} catch {
		rows.push({ build: basename(dir), note: 'MISSING' });
		continue;
	}
	const wasmName = files.find((f) => f.endsWith('.wasm'));
	const glueName = files.find((f) => f.endsWith('.mjs') || f.endsWith('.js'));
	if (!wasmName) {
		rows.push({ build: basename(dir), note: 'no .wasm' });
		continue;
	}
	const wasmPath = join(dir, wasmName);
	const wasm = readFileSync(wasmPath);
	const glue = glueName ? readFileSync(join(dir, glueName)) : Buffer.alloc(0);

	const head = wasm.subarray(0, 16).toString('latin1');
	const dylink = head.includes('dylink');
	const asyncify = (glue.toString('latin1').match(/asyncify/g) ?? []).length;

	const wasmGz = gz(wasmPath);
	const glueGz = glue.length ? gz(join(dir, glueName)) : 0;
	const total = wasmGz + glueGz;

	rows.push({
		build: basename(dir),
		raw: wasm.length,
		wasmGz,
		glueGz,
		total,
		free: total <= FREE ? `fits (${FREE - total} under)` : `${(total / FREE).toFixed(2)}x over`,
		paid:
			total <= PAID
				? `fits (${((total / PAID) * 100).toFixed(1)}% of ceiling)`
				: `${(total / PAID).toFixed(2)}x over`,
		dylink: dylink ? 'DYLINK PRESENT' : 'none',
		asyncify,
		mtime: statSync(join(dir, wasmName)).mtime.toISOString().slice(0, 19)
	});
}

const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : (v ?? '-'));
console.log(
	'| build | wasm raw | wasm gzip | glue gzip | total gzip | free (3,145,728) | paid (10,485,760) | dylink | asyncify syms |'
);
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
	if (r.note) {
		console.log(`| ${r.build} | ${r.note} | | | | | | | |`);
		continue;
	}
	console.log(
		`| ${r.build} | ${n(r.raw)} | ${n(r.wasmGz)} | ${n(r.glueGz)} | ${n(r.total)} | ${r.free} | ${r.paid} | ${r.dylink} | ${r.asyncify} |`
	);
}
