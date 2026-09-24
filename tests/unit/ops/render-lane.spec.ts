import { describe, expect, it } from 'vitest';
import {
	derivativeUri,
	eagerDerivativesEnabled,
	frameDerive,
	unframeDerive
} from '../../../src/ops/render-lane';

describe('a rendering lane slice', () => {
	it('round-trips the transform and every source byte', () => {
		const source = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
		const transform = { width: 220, height: 220, fit: 'scale-down', format: 'avif' };
		const back = unframeDerive(frameDerive(transform, source));
		expect(back.transform).toEqual(transform);
		expect([...back.source]).toEqual([...source]);
	});

	it('reads a slice that sits at an offset inside a larger buffer', () => {
		const framed = frameDerive({ width: 10 }, new Uint8Array([7, 8, 9]));
		const padded = new Uint8Array(framed.length + 5);
		padded.set(framed, 5);
		expect([...unframeDerive(padded.subarray(5)).source]).toEqual([7, 8, 9]);
	});
});

describe('whether uploads render ahead of the first view', () => {
	it('follows the binding, with 0 as the off switch', () => {
		expect(eagerDerivativesEnabled({})).toBe(false);
		expect(eagerDerivativesEnabled({ RENDER_LANES: {} })).toBe(true);
		expect(eagerDerivativesEnabled({ RENDER_LANES: {}, EAGER_DERIVATIVES: '0' })).toBe(false);
	});

	it('keys a stored derivative by its delivery identity', () => {
		expect(derivativeUri('abc123')).toBe('public://cfw-derivatives/abc123');
	});
});
