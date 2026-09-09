/**
 * Asserts the deployed bundle still fits the free-plan size ceiling.
 *
 * Run it against a `wrangler deploy --dry-run --outdir=` tree:
 *
 * ```sh
 * bunx wrangler deploy --dry-run --outdir=/tmp/b
 * bun scripts/measure/bundle-size.ts /tmp/b
 * ```
 *
 * @see tests/unit/bundle-size.spec.ts for the arithmetic
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * Worker size limit: 64 MiB UNCOMPRESSED, the same on Free and Paid since 2026-09-04.
 *
 * Cloudflare removed the compressed limit that day and their docs say "There is no compressed size
 * limit. Only the uncompressed bundle size counts." So the meter this project spent two sessions
 * engineering around is gone, and the quantity to check is RAW rather than gzipped.
 *
 * THE OLD CEILINGS WERE 3,145,728 FREE AND 10,485,760 PAID, ON THE GZIPPED FIGURE, and both were
 * confirmed at the time by the API's own `code: 10027` rejection and by wrangler's reported figure
 * either side of the boundary. They are recorded here because most of the interpreter work in the
 * report is scored against them, and a reader meeting a 2,485,488-byte brotli frame needs to know
 * what it was for.
 */
export const SIZE_CEILING = 67_108_864;

/**
 * Kept so the report's historical figures still resolve, and so nothing silently re-checks against
 * a limit that no longer exists.
 *
 * @deprecated the compressed limit was removed on 2026-09-04; check {@link SIZE_CEILING} on raw bytes
 */
export const FREE_CEILING = SIZE_CEILING;

/** @deprecated see {@link FREE_CEILING}; Free and Paid are the same limit now */
export const PAID_CEILING = SIZE_CEILING;

/**
 * Files wrangler writes that are NOT uploaded.
 *
 * A sourcemap is the expensive one: it ran 2,455,503-2,524,490 bytes next to a 3 MB budget, so
 * counting it inflates the total by more than any lever this project has found.
 */
const NOT_UPLOADED = /\.map$|^README\.md$/;

export interface BundleReport {
	/** every uploaded file, largest first */
	files: { name: string; raw: number; gz: number }[];
	raw: number;
	/**
	 * Concatenates the files and gzips ONCE, because Cloudflare compresses the upload as one
	 * stream and summing per-file gzips under-reports -- measured at 30,114 bytes.
	 *
	 * LEVEL 6, not 9, because that is what wrangler's own compressor does. Measuring at 9 reported
	 * 22,475-25,260 BELOW the real meter on the phasm binaries -- optimistic, against a hard cap.
	 *
	 * Even at the right level this stays a tripwire rather than an authority: concatenation order
	 * and zlib version still move it a little against what `wrangler deploy` prints, and that
	 * printed figure is the number to quote.
	 */
	gz: number;
	freeHeadroom: number;
	paidHeadroom: number;
	fitsFree: boolean;
}

/** measures an outdir produced by `wrangler deploy --dry-run --outdir=` */
export function measureBundle(outdir: string): BundleReport {
	const names = readdirSync(outdir).filter(
		(n) => !NOT_UPLOADED.test(n) && statSync(join(outdir, n)).isFile()
	);
	if (names.length === 0) throw new Error(`no uploadable files in ${outdir}`);

	const bodies = names.map((n) => readFileSync(join(outdir, n)));
	const files = names
		.map((n, i) => ({
			name: n,
			raw: bodies[i]!.length,
			gz: gzipSync(bodies[i]!, { level: 6 }).length
		}))
		.sort((a, b) => b.raw - a.raw);

	const raw = bodies.reduce((t, b) => t + b.length, 0);
	const gz = gzipSync(Buffer.concat(bodies), { level: 6 }).length;

	// AGAINST RAW, not gz. The gzipped figure is still reported because it is what every historical
	// measurement in the report is expressed in, but it is no longer what any limit is checked on
	return {
		files,
		raw,
		gz,
		freeHeadroom: SIZE_CEILING - raw,
		paidHeadroom: SIZE_CEILING - raw,
		fitsFree: raw <= SIZE_CEILING
	};
}

/** formats the report; exported so the spec can pin the wording */
export function formatBundle(r: BundleReport): string {
	const lines = [
		'uploaded files:',
		...r.files.map((f) => `  ${f.raw.toLocaleString().padStart(12)} raw  ${f.name}`),
		'',
		`raw total        ${r.raw.toLocaleString().padStart(12)}  <- the limit is checked on this`,
		`gzip, one stream ${r.gz.toLocaleString().padStart(12)}  <- reported, no longer limited`,
		'',
		`vs ${SIZE_CEILING.toLocaleString()} uncompressed: ${r.freeHeadroom >= 0 ? `${r.freeHeadroom.toLocaleString()} under` : `${(-r.freeHeadroom).toLocaleString()} OVER`}`
	];
	return lines.join('\n');
}

if (import.meta.main) {
	const outdir = process.argv[2];
	if (!outdir) {
		console.error('usage: bun scripts/measure/bundle-size.ts <wrangler --outdir>');
		process.exit(2);
	}
	const report = measureBundle(outdir);
	console.log(formatBundle(report));
	if (!report.fitsFree) {
		console.error(
			`\nFAIL: over the free ceiling by ${(-report.freeHeadroom).toLocaleString()}`
		);
		process.exit(1);
	}
}
