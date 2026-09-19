import { describe, expect, it } from 'vitest';
import { payloadUrl } from '../../scripts/hydrate';

/**
 * A payload is fetched from a URL carrying its own digest, and that is a correctness property.
 *
 * Observed 2026-09-19 on a Pages build: hydrate failed with `SHA256SUMS says 33d192f0..., the
 * download is 65a56e88...`, and minutes later the identical pair verified clean from another
 * machine. Nothing was corrupt. `SHA256SUMS` is served uncached (`cf-cache-status: DYNAMIC`) while
 * the tarball carries `max-age=14400`, so for up to four hours after a republish a colo can serve
 * the PREVIOUS tarball against the new digest -- and Cloudflare's cache is per colo, so it fails in
 * some places and not others, which reads as a flaky network rather than as a cache.
 *
 * Measured on the live CDN the same day: the bare URL answered `cf-cache-status: HIT` with
 * `age: 4323`, and the same object with the digest in the query string answered `MISS` and returned
 * the expected bytes.
 */
describe('the payload URL carries its digest', () => {
	const base = 'https://cdn.example.test/payloads/dev-master';
	const asset = 'drupflare-worker-1.0.1.tar.gz';
	const digest = '33d192f046110a09e15c298de86b6623343669ceb77bbfe723c0a1e58a927f01';

	it('gives each published version its own cache key', () => {
		expect(payloadUrl(base, asset, digest)).toBe(`${base}/${asset}?sha256=${digest}`);
	});

	it('changes the key when the digest changes, which is the whole property', () => {
		const other = '65a56e88aba2c17b424197414c4aa386dfb04372ae7c48d18411d86f82c71e50';
		expect(payloadUrl(base, asset, digest)).not.toBe(payloadUrl(base, asset, other));
	});

	it('is stable for one digest, so the object stays cacheable', () => {
		// deliberately NOT a cache-buster: a nonce would defeat the cache on every build and make
		// every hydrate pay a full origin fetch of ~23 MB
		expect(payloadUrl(base, asset, digest)).toBe(payloadUrl(base, asset, digest));
		expect(payloadUrl(base, asset, digest)).not.toContain('Date');
	});
});
