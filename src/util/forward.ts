/**
 * An object whose every property is the current owner's, so a closure made against it follows the
 * owner when it changes. Methods are bound to the owner (the real instance is `this`).
 */
export function forwardTo<T extends object>(owner: { current: T }): T {
	return new Proxy({} as T, {
		get: (_t, key) => {
			const cur = owner.current;
			const v = Reflect.get(cur, key, cur);
			return typeof v === 'function' ? v.bind(cur) : v;
		},
		set: (_t, key, value) => Reflect.set(owner.current, key, value, owner.current),
		has: (_t, key) => Reflect.has(owner.current, key)
	});
}
