import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

/**
 * Packs the Drupal tree with EVERY FILE COMPRESSED INDEPENDENTLY.
 *
 *   bun scripts/pack-perfile.ts <drupal-root> <out-dir> [core.json]
 *
 * This is the largest single cost in the project. Cold start on the edge is 3,754 ms of cpuTime, and **3,066 ms of that is
 * mounting the pack** -- measured, 6.1x the local figure and the largest
 * local-to-edge factor recorded. That mount is pure JavaScript: one
 * DecompressionStream over a single gzip member, then FS.writeFile in a loop over
 * 11,447 files. No PHP is involved, so none of the JSPI/slicing work can touch it.
 *
 * The blocker for reading files on demand was that ONE gzip stream is not
 * random-access, so the only way to reach the last file is to inflate everything
 * before it. Compressing each file on its own makes the blob an index plus
 * independently-inflatable members, so a file can be materialised when PHP actually
 * opens it -- and boot only opens about 2,987 of the 11,447.
 *
 * Cost of the change is compression ratio, because per-member dictionaries cannot
 * share across files. Measured below; the budget is the 25 MiB per-asset ceiling.
 *
 * `deflateRawSync` rather than gzip: fflate's `inflateSync` on the worker side wants
 * raw deflate, and a per-member gzip header would be 18 wasted bytes x 11,447.
 */

const [root, outDir, indexPath] = process.argv.slice(2);
if (!root || !outDir) {
	console.error('usage: pack-perfile.ts <drupal-root> <out-dir> [core.json]');
	process.exit(1);
}

// reuse the existing pack's file list so this is a format change and NOT a change of
// which files ship; otherwise a size or boot comparison would be measuring two things
const source = JSON.parse(await readFile(indexPath ?? join(outDir, 'core.json'), 'utf8'));

const index: { p: string; o: number; c: number; l: number; m: number; s?: number }[] = [];
const parts: Uint8Array[] = [];
let offset = 0;
let rawTotal = 0;
let missing = 0;
let stored = 0;

for (const entry of source) {
	const path = entry.p;
	if (path.startsWith('/')) continue;
	let buf;
	let mtime;
	try {
		buf = await readFile(join(root, path));
		mtime = Math.floor((await stat(join(root, path))).mtimeMs);
	} catch {
		missing++;
		continue;
	}

	const deflated = deflateRawSync(buf, { level: 9 });
	// a tiny or incompressible file can deflate LARGER; store it verbatim and mark it,
	// so the reader skips inflate entirely for those
	const useRaw = deflated.length >= buf.length;
	const payload = useRaw ? buf : deflated;
	if (useRaw) stored++;

	index.push({
		p: path,
		o: offset,
		c: payload.length,
		l: buf.length,
		m: mtime,
		// only present when the member is stored rather than deflated
		...(useRaw ? { s: 1 } : {})
	});
	parts.push(payload);
	offset += payload.length;
	rawTotal += buf.length;
}

const blob = Buffer.concat(parts);
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'core.pf.bin'), blob);
await writeFile(join(outDir, 'core.pf.json'), JSON.stringify(index));

const indexBytes = (await readFile(join(outDir, 'core.pf.json'))).length;
const ceiling = 25 * 1024 * 1024;

console.log(
	JSON.stringify(
		{
			files: index.length,
			missing,
			storedVerbatim: stored,
			rawBytes: rawTotal,
			rawMb: +(rawTotal / 1048576).toFixed(2),
			packedBytes: blob.length,
			packedMb: +(blob.length / 1048576).toFixed(2),
			ratio: +(blob.length / rawTotal).toFixed(3),
			indexBytes,
			indexMb: +(indexBytes / 1048576).toFixed(2),
			underPerAssetCeiling: blob.length < ceiling,
			headroomMb: +((ceiling - blob.length) / 1048576).toFixed(2)
		},
		null,
		2
	)
);
