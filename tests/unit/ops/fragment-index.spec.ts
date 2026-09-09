import { describe, expect, it } from 'vitest';
import {
	dependencyValues,
	dirtyFragments,
	fragmentAddress,
	pagesWithDirtyFragments,
	readTagList,
	shellVerdict,
	type FragmentSql
} from '../../../src/ops/fragment-index';

/**
 * The address and the verdict, which are the two decisions the index makes.
 *
 * The statements themselves are driven against a real Durable Object in
 * `tests/integration/fragment-index.spec.ts`; a fake here would be a test of the fake. What a fake
 * IS good for is the filter on top of a full scan, which is where a tag belonging to one fragment
 * and not its sibling is decided.
 */

/** the `exec(text, ...params)` shape, answering canned rows so the FILTER is what is asserted */
function canned(rows: Record<string, Record<string, unknown>[]>): FragmentSql {
	return {
		exec(sql: string) {
			for (const [table, out] of Object.entries(rows)) {
				if (sql.includes(table)) return { toArray: () => out };
			}
			return { toArray: () => [] };
		}
	};
}

const MENU = { callback: 'block', args: ['main_menu'] };
const CRUMBS = { callback: 'block', args: ['breadcrumbs'] };

describe('a fragment address names one rendering of one plan', () => {
	it('changes when the plan changes', async () => {
		const deps = { 'config:block_list': 1 };
		const a = await fragmentAddress({ plan: MENU, deps, generation: 4 });
		const b = await fragmentAddress({ plan: CRUMBS, deps, generation: 4 });
		expect(a).not.toBe(b);
	});

	it('changes when a dependency value changes', async () => {
		const a = await fragmentAddress({
			plan: MENU,
			deps: { 'config:system.menu.main': 3 },
			generation: 4
		});
		const b = await fragmentAddress({
			plan: MENU,
			deps: { 'config:system.menu.main': 4 },
			generation: 4
		});
		expect(a).not.toBe(b);
	});

	it('changes when the generation changes', async () => {
		const deps = { 'config:block_list': 1 };
		const a = await fragmentAddress({ plan: MENU, deps, generation: 4 });
		const b = await fragmentAddress({ plan: MENU, deps, generation: 5 });
		expect(a).not.toBe(b);
	});

	it('is stable across key order, so a re-serialised recipe is the same fragment', async () => {
		const a = await fragmentAddress({
			plan: { callback: 'block', args: ['main_menu'], token: 'x' },
			deps: { b: 2, a: 1 },
			generation: 4
		});
		const b = await fragmentAddress({
			plan: { token: 'x', args: ['main_menu'], callback: 'block' },
			deps: { a: 1, b: 2 },
			generation: 4
		});
		expect(a).toBe(b);
	});

	it('is a sha256, so it is fixed width and hex', async () => {
		const addr = await fragmentAddress({ plan: MENU, deps: {}, generation: 0 });
		expect(addr).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('a tag reaches the fragment that declared it and not its siblings', () => {
	const sql = canned({
		cfw_fragment: [
			{
				path: '/',
				id: 'menu',
				addr: 'a'.repeat(64),
				tags: JSON.stringify(['config:block_list', 'config:system.menu.main'])
			},
			{
				path: '/',
				id: 'crumbs',
				addr: 'b'.repeat(64),
				tags: JSON.stringify(['config:block_list'])
			},
			{
				path: '/about',
				id: 'menu',
				addr: 'c'.repeat(64),
				tags: JSON.stringify(['config:system.menu.main'])
			}
		]
	});

	it('names only the fragment that depends on the saved tag', () => {
		const dirty = dirtyFragments(sql, ['config:system.menu.main']);
		expect(dirty.map((f) => `${f.path}#${f.id}`)).toEqual(['/#menu', '/about#menu']);
		// the sibling on the same page survives, which is the half a purge that removes everything
		// would also pass
		expect(dirty.some((f) => f.id === 'crumbs')).toBe(false);
	});

	it('names every fragment when the tag is one they share', () => {
		expect(dirtyFragments(sql, ['config:block_list']).length).toBe(2);
	});

	it('answers no fragments for a tag nothing declared', () => {
		expect(dirtyFragments(sql, ['node:9'])).toEqual([]);
		expect(dirtyFragments(sql, [])).toEqual([]);
	});

	it('rolls the fragments up to the pages carrying them', () => {
		expect(pagesWithDirtyFragments(sql, ['config:system.menu.main'])).toEqual(['/', '/about']);
	});
});

describe('dependency values come from Drupal own invalidation counters', () => {
	it('reads the counter for a tag and 0 for one never invalidated', () => {
		const sql = canned({
			cachetags: [
				{ tag: 'node_list', invalidations: 7 },
				{ tag: 'unrelated', invalidations: 99 }
			]
		});
		expect(dependencyValues(sql, ['node_list', 'node:1'])).toEqual({
			node_list: 7,
			'node:1': 0
		});
	});

	it('answers zeroes rather than throwing on a site with no cachetags table', () => {
		const sql: FragmentSql = {
			exec() {
				throw new Error('no such table: cachetags');
			}
		};
		expect(dependencyValues(sql, ['node_list'])).toEqual({ node_list: 0 });
	});
});

describe('a shell is dropped unless every invalidated tag is accounted for', () => {
	const fragmentTags = ['config:block_list', 'config:system.menu.main', 'local_task'];
	const shellTags = ['config:block_list', 'node_list', 'config:system.site'];

	it('keeps the shell when the save only reaches a fragment', () => {
		const verdict = shellVerdict({
			invalidated: ['config:system.menu.main'],
			shellTags,
			fragmentTags
		});
		expect(verdict.drop).toBe(false);
	});

	it('drops it when the save reaches the shell own bytes', () => {
		const verdict = shellVerdict({ invalidated: ['node_list'], shellTags, fragmentTags });
		expect(verdict.drop).toBe(true);
		expect(verdict.reason).toContain('node_list');
	});

	it('drops it on a tag the page cannot account for at all', () => {
		const verdict = shellVerdict({ invalidated: ['node:41'], shellTags, fragmentTags });
		expect(verdict.drop).toBe(true);
		expect(verdict.reason).toContain('not accounted for');
	});

	it('drops it when one tag of several reaches the shell', () => {
		const verdict = shellVerdict({
			invalidated: ['config:system.menu.main', 'node_list'],
			shellTags,
			fragmentTags
		});
		expect(verdict.drop).toBe(true);
	});

	it('drops a shell stored before the column existed', () => {
		const verdict = shellVerdict({
			invalidated: ['config:system.menu.main'],
			shellTags: null,
			fragmentTags
		});
		expect(verdict.drop).toBe(true);
		expect(verdict.reason).toContain('cannot speak for itself');
	});

	it('keeps a shell when nothing was invalidated', () => {
		expect(shellVerdict({ invalidated: [], shellTags, fragmentTags }).drop).toBe(false);
	});

	it('tells an empty recorded set from an absent one', () => {
		expect(readTagList('[]')).toEqual([]);
		expect(readTagList(null)).toBeNull();
		expect(readTagList('')).toBeNull();
		expect(readTagList('not json')).toBeNull();
		expect(readTagList('{"tag":1}')).toBeNull();
	});
});
