import { describe, expect, it } from 'vitest';
import { releaseEvicted } from '../../../src/ops/release-host';

/**
 * RELEASE_EVICTED: an evicted file's bytes are detached, not only dropped, when the flag is `1`.
 *
 * The node is cleared either way, so the difference is whether a buffer another holder still
 * references goes to length 0 under it. The transfer is the only observable effect.
 */

const bytes = () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

describe('releaseEvicted', () => {
	it('leaves the bytes alone when the flag is unset', () => {
		const contents = bytes();
		expect(releaseEvicted({}, contents)).toBe(false);
		expect(contents.byteLength).toBe(8);
	});

	it('leaves the bytes alone for any value other than 1', () => {
		const contents = bytes();
		expect(releaseEvicted({ RELEASE_EVICTED: '0' }, contents)).toBe(false);
		expect(contents.byteLength).toBe(8);
	});

	it('detaches a whole buffer the node owned when the flag is 1', () => {
		const contents = bytes();
		const held = contents.buffer;
		expect(releaseEvicted({ RELEASE_EVICTED: '1' }, contents)).toBe(true);
		expect(contents.byteLength).toBe(0);
		expect(held.byteLength).toBe(0);
	});

	it('does not detach a view over a buffer it does not cover', () => {
		const backing = new Uint8Array(16);
		const view = backing.subarray(4, 12);
		expect(releaseEvicted({ RELEASE_EVICTED: '1' }, view)).toBe(false);
		expect(view.byteLength).toBe(8);
		expect(backing.byteLength).toBe(16);
	});

	it('does nothing for a node with no contents', () => {
		expect(releaseEvicted({ RELEASE_EVICTED: '1' }, null)).toBe(false);
	});

	it('falls back to a plain drop when the buffer cannot transfer', () => {
		const contents = bytes();
		Object.defineProperty(contents.buffer, 'transfer', { value: undefined });
		expect(releaseEvicted({ RELEASE_EVICTED: '1' }, contents)).toBe(false);
		expect(contents.byteLength).toBe(8);
	});

	it('returns false when the buffer was already detached', () => {
		const contents = bytes();
		expect(releaseEvicted({ RELEASE_EVICTED: '1' }, contents)).toBe(true);
		expect(releaseEvicted({ RELEASE_EVICTED: '1' }, contents)).toBe(false);
	});
});
