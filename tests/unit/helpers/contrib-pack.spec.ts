import { describe, expect, it } from 'vitest';
import { isFixturePack, mustCarry, shippingNames } from '../../helpers/contrib-pack';

const shipping = new Set(shippingNames);
const fixture = new Set([...shippingNames, 'devel']);

describe('a module the mounted pack lacks', () => {
	it('skips against the shipping pack in an ordinary run', () => {
		expect(isFixturePack(shipping)).toBe(false);
		expect(mustCarry(shipping, false)).toBe(false);
	});

	it('fails against a fixture pack', () => {
		expect(mustCarry(fixture, false)).toBe(true);
	});

	it('fails in a fixture run even when the pack looks like the shipping one', () => {
		expect(mustCarry(shipping, true)).toBe(true);
		expect(mustCarry(new Set(), true)).toBe(true);
	});
});
