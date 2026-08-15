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
 * Free-plan Worker size after gzip, and it is MiB rather than MB: 3 * 1024 * 1024.
 *
 * Confirmed twice over -- by the API's own `code: 10027` rejection, and by wrangler's reported
 * figure for bundles measured either side of the boundary.
 */
export const FREE_CEILING = 3_145_728;

/** paid, for the second verdict */
export const PAID_CEILING = 10_485_760;

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

	return {
		files,
		raw,
		gz,
		freeHeadroom: FREE_CEILING - gz,
		paidHeadroom: PAID_CEILING - gz,
		fitsFree: gz <= FREE_CEILING
	};
}

/** formats the report; exported so the spec can pin the wording */
export function formatBundle(r: BundleReport): string {
	const lines = [
		'uploaded files:',
		...r.files.map((f) => `  ${f.raw.toLocaleString().padStart(12)} raw  ${f.name}`),
		'',
		`raw total        ${r.raw.toLocaleString().padStart(12)}`,
		`gzip, one stream ${r.gz.toLocaleString().padStart(12)}`,
		'',
		`vs free ${FREE_CEILING.toLocaleString()}: ${r.freeHeadroom >= 0 ? `${r.freeHeadroom.toLocaleString()} under` : `${(-r.freeHeadroom).toLocaleString()} OVER`}`,
		`vs paid ${PAID_CEILING.toLocaleString()}: ${r.paidHeadroom.toLocaleString()} under`
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
