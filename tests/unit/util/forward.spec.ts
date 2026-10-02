import { describe, expect, it } from 'vitest';
import { forwardTo } from '../../../src/util/forward';

class Counter {
	n = 1;
	bump() {
		this.n += 1;
		return this.n;
	}
}

describe('forwardTo', () => {
	it('reads through to the current owner and follows a swap', () => {
		const owner = { current: new Counter() };
		const proxy = forwardTo(owner);
		expect(proxy.n).toBe(1);
		owner.current = Object.assign(new Counter(), { n: 10 });
		expect(proxy.n).toBe(10);
	});

	it('binds methods to the real owner', () => {
		const owner = { current: new Counter() };
		const proxy = forwardTo(owner);
		const { bump } = proxy;
		expect(bump()).toBe(2);
		expect(owner.current.n).toBe(2);
	});

	it('writes and has go to the owner', () => {
		const owner = { current: new Counter() };
		const proxy = forwardTo(owner);
		proxy.n = 5;
		expect(owner.current.n).toBe(5);
		expect('bump' in proxy).toBe(true);
		expect('missing' in proxy).toBe(false);
	});
});
