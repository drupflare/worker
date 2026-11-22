import { describe, expect, it } from 'vitest';
import { installLookupMemo, lookupMemoFor } from '../../../src/ops/lookup-memo';

/**
 * LOOKUP_MEMO: a fresh interpreter's absolute `/drupal/` lookups are answered from a bounded cache,
 * and any structural change clears it.
 *
 * The fake FS counts the lookups that reach the real resolver, so a hit is a lookup that did not.
 */

class ErrnoError extends Error {
	constructor(readonly errno: number) {
		super(`errno ${errno}`);
		this.name = 'ErrnoError';
	}
}

function fakeFs(paths: string[]) {
	const counts = { resolved: 0 };
	const fs = {
		ErrnoError,
		tree: new Set(paths),
		lookupPath(this: { tree: Set<string> }, path: string, _opts: Record<string, unknown> = {}) {
			counts.resolved++;
			if (path === '/drupal/bad') throw new TypeError('not an errno');
			if (!this.tree.has(path)) throw new ErrnoError(44);
			return { path, node: { path } };
		},
		mkdir(this: { tree: Set<string> }, path: string) {
			this.tree.add(path);
		},
		unlink(this: { tree: Set<string> }, path: string) {
			this.tree.delete(path);
		}
	};
	return { fs, counts };
}

describe('LOOKUP_MEMO', () => {
	it('answers a repeated absolute lookup without resolving it again', () => {
		const { fs, counts } = fakeFs(['/drupal/a']);
		installLookupMemo(fs);
		fs.lookupPath('/drupal/a');
		fs.lookupPath('/drupal/a');
		expect(counts.resolved).toBe(1);
	});

	it('resolves relative and non-drupal paths every time', () => {
		const { fs, counts } = fakeFs(['/other/a', 'a']);
		installLookupMemo(fs);
		fs.lookupPath('a');
		fs.lookupPath('a');
		fs.lookupPath('/other/a');
		fs.lookupPath('/other/a');
		expect(counts.resolved).toBe(4);
	});

	it('caches a miss until a create makes the path exist', () => {
		const { fs, counts } = fakeFs([]);
		installLookupMemo(fs);
		expect(() => fs.lookupPath('/drupal/new')).toThrow(ErrnoError);
		expect(() => fs.lookupPath('/drupal/new')).toThrow(ErrnoError);
		expect(counts.resolved).toBe(1);
		fs.mkdir('/drupal/new');
		expect(fs.lookupPath('/drupal/new').path).toBe('/drupal/new');
		expect(counts.resolved).toBe(2);
	});

	it('drops a cached entry when the path is removed', () => {
		const { fs } = fakeFs(['/drupal/a']);
		installLookupMemo(fs);
		fs.lookupPath('/drupal/a');
		fs.unlink('/drupal/a');
		expect(() => fs.lookupPath('/drupal/a')).toThrow(ErrnoError);
	});

	it('rethrows an error that is not an errno, and does not cache it', () => {
		const { fs, counts } = fakeFs([]);
		installLookupMemo(fs);
		expect(() => fs.lookupPath('/drupal/bad')).toThrow(TypeError);
		expect(() => fs.lookupPath('/drupal/bad')).toThrow(TypeError);
		expect(counts.resolved).toBe(2);
	});

	it('evicts the oldest entry past the bound', () => {
		const { fs, counts } = fakeFs(['/drupal/a', '/drupal/b', '/drupal/c']);
		installLookupMemo(fs, 2);
		fs.lookupPath('/drupal/a');
		fs.lookupPath('/drupal/b');
		fs.lookupPath('/drupal/c');
		fs.lookupPath('/drupal/c');
		expect(counts.resolved).toBe(3);
		fs.lookupPath('/drupal/a');
		expect(counts.resolved).toBe(4);
	});

	it('does nothing unless LOOKUP_MEMO is 1', () => {
		const { fs, counts } = fakeFs(['/drupal/a']);
		const original = fs.lookupPath;
		expect(lookupMemoFor({}, fs)).toBeUndefined();
		expect(lookupMemoFor({ LOOKUP_MEMO: '0' }, fs)).toBeUndefined();
		expect(fs.lookupPath).toBe(original);
		fs.lookupPath('/drupal/a');
		fs.lookupPath('/drupal/a');
		expect(counts.resolved).toBe(2);
	});
});
