import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SIZE_CEILING, formatBundle, type BundleReport } from '../../scripts/measure/bundle-size';

/**
 * The arithmetic only. `measureBundle()` reads a directory, so it belongs to the node project;
 * what is pinned here is the reasoning that has already been got wrong twice.
 */

/** the verdict is on RAW now; gz is carried because the report still prints it */
function report(raw: number, gz = Math.round(raw / 3)): BundleReport {
	return {
		files: [{ name: 'site', raw, gz }],
		raw,
		gz,
		freeHeadroom: SIZE_CEILING - raw,
		paidHeadroom: SIZE_CEILING - raw,
		fitsFree: raw <= SIZE_CEILING
	};
}

describe('the ceiling is the documented one', () => {
	it('uses 64 MiB uncompressed, the same on both plans', () => {
		// Cloudflare removed the compressed limit on 2026-09-04. It was 3 MiB free and 10 MiB paid
		// on the GZIPPED figure, and most of the interpreter work in the report is scored against it
		expect(SIZE_CEILING).toBe(64 * 1024 * 1024);
	});

	it('scores RAW bytes, because scoring gz would pass anything', () => {
		// the shipping bundle is 13,580,216 raw and about 4 MB gzipped; scoring the compressed
		// figure against 64 MiB would make the check unable to fail
		expect(report(SIZE_CEILING).fitsFree).toBe(true);
		expect(report(SIZE_CEILING + 1).fitsFree).toBe(false);
		// the old ceiling is now comfortably inside the limit, which is the whole change
		expect(report(3_145_729).fitsFree).toBe(true);
	});
});

describe('one gzip stream, not a sum of gzips', () => {
	it('concatenating before gzip reports less than gzipping separately', () => {
		// the shipping bundle's two members are highly self-similar JS plus a wasm; any repeated
		// input shows the effect that cost this project 30,114 bytes of under-reporting when the
		// per-file gzips were summed instead
		const a = Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(400));
		const b = Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(400));
		const summed = gzipSync(a, { level: 9 }).length + gzipSync(b, { level: 9 }).length;
		const oneStream = gzipSync(Buffer.concat([a, b]), { level: 9 }).length;
		expect(oneStream).toBeLessThan(summed);
	});
});

describe('the report says which side of the line it is on', () => {
	it('says under when it fits', () => {
		const text = formatBundle(report(13_580_216));
		expect(text).toContain('53,528,648 under');
		expect(text).not.toContain('OVER');
	});

	it('says OVER when it does not, because a negative headroom read as under once', () => {
		const text = formatBundle(report(SIZE_CEILING + 54_364));
		expect(text).toContain('54,364 OVER');
	});

	it('labels which figure the limit is checked on, so the two are never confused', () => {
		const text = formatBundle(report(13_580_216));
		expect(text).toContain('the limit is checked on this');
		expect(text).toContain('no longer limited');
	});
});
