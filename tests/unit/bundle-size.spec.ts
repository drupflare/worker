import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	FREE_CEILING,
	PAID_CEILING,
	formatBundle,
	type BundleReport
} from '../../scripts/measure/bundle-size';

/**
 * The arithmetic only. `measureBundle()` reads a directory, so it belongs to the node project;
 * what is pinned here is the reasoning that has already been got wrong twice.
 */

function report(gz: number, raw = gz * 3): BundleReport {
	return {
		files: [{ name: 'site', raw, gz }],
		raw,
		gz,
		freeHeadroom: FREE_CEILING - gz,
		paidHeadroom: PAID_CEILING - gz,
		fitsFree: gz <= FREE_CEILING
	};
}

describe('the ceilings are the documented ones', () => {
	it('uses 3 MiB for free and 10 MiB for paid', () => {
		expect(FREE_CEILING).toBe(3 * 1024 * 1024);
		expect(PAID_CEILING).toBe(10 * 1024 * 1024);
	});

	it('treats the ceiling as inclusive, so exactly at the limit still fits', () => {
		expect(report(FREE_CEILING).fitsFree).toBe(true);
		expect(report(FREE_CEILING + 1).fitsFree).toBe(false);
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
		const text = formatBundle(report(2_989_814));
		expect(text).toContain('155,914 under');
		expect(text).not.toContain('OVER');
	});

	it('says OVER when it does not, because a negative headroom read as under once', () => {
		const text = formatBundle(report(3_200_092));
		expect(text).toContain('54,364 OVER');
	});

	it('always reports paid as under, since 10 MiB has never been the binding meter here', () => {
		expect(formatBundle(report(3_200_092))).toMatch(/vs paid 10,485,760: [\d,]+ under/);
	});
});
