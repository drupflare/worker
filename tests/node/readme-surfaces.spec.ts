import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_PAGES } from '../../src/ui/admin';

/**
 * The README's admin-surface table against what the code renders.
 *
 * It said "Six pages" and listed six while `ADMIN_PAGES` held seven: **Operate** was absent from
 * the published table entirely, which is the page carrying every repair action an owner has. The
 * same drift the module table already has a guard for, on the surface next to it, with nothing
 * checking this one.
 *
 * Paths and the count, not the prose. What each page does is a maintainer's wording to choose;
 * what has to agree is WHICH pages exist.
 */
describe('README.md lists every admin surface the worker serves', () => {
	const README = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8');

	/** the `/_cfw…` paths inside the table, taken from the second column rather than from prose */
	const listed = new Set(
		[...README.matchAll(/^\|\s*\*\*[^|]+\*\*\s*\|\s*`(\/_cfw[^`]*)`\s*\|/gm)].map(
			(m) => m[1] as string
		)
	);

	it('found the table, so this cannot pass by matching nothing', () => {
		expect(listed.size).toBeGreaterThan(3);
	});

	it('lists every page and invents none', () => {
		const shipped = new Set(ADMIN_PAGES.map((p) => p.path));
		expect(
			[...shipped].filter((p) => !listed.has(p)),
			'shipped but not in README.md'
		).toEqual([]);
		expect(
			[...listed].filter((p) => !shipped.has(p)),
			'in README.md but not shipped'
		).toEqual([]);
	});

	/**
	 * The written count too. A row can be added to the table without the sentence above it moving,
	 * and the sentence is what a reader skimming the section actually takes away.
	 */
	it('states the number it then lists', () => {
		const words = [
			'Zero',
			'One',
			'Two',
			'Three',
			'Four',
			'Five',
			'Six',
			'Seven',
			'Eight',
			'Nine',
			'Ten'
		];
		const said = README.match(/\b(\w+) pages under `\/_cfw`/);
		expect(said, 'README.md no longer says how many pages there are').toBeTruthy();
		expect(said?.[1]).toBe(words[ADMIN_PAGES.length]);
	});
});
