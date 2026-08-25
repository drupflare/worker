import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Backlog ids belong in the backlog, not in the checkout: they name entries in a file that is not in
 * this repository, so a comment citing one is a dangling pointer. Say the reason instead.
 *
 * The budgets are what existed when this landed. Lower one when you clean a file; never raise one.
 */

const ROOT = new URL('../..', import.meta.url).pathname;

/** an id like P47 or C112, not a version (`v8.5`), a size (`P3` in a table) or a hex byte */
const BACKLOG_ID = /(?<![\w-])[PC](?:[1-9]\d{0,2})(?![\w-])/g;

/** measured 2026-08-24; ceilings that may only come down */
const BUDGET: Readonly<Record<string, number>> = {
	src: 0,
	tests: 76,
	scripts: 0
};

const SKIP_DIRS = new Set(['node_modules', 'coverage', '.wrangler']);

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) sourceFiles(full, out);
		else if (/\.(ts|mjs|js)$/.test(entry) && !entry.startsWith('backlog-ids')) out.push(full);
	}
	return out;
}

function countIn(dir: string): { total: number; worst: [string, number][] } {
	const per = new Map<string, number>();
	let total = 0;
	for (const file of sourceFiles(join(ROOT, dir))) {
		const hits = (readFileSync(file, 'utf8').match(BACKLOG_ID) ?? []).length;
		if (hits > 0) {
			per.set(file.slice(ROOT.length), hits);
			total += hits;
		}
	}
	const worst = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
	return { total, worst };
}

describe('backlog ids do not leak into the repository', () => {
	for (const [dir, budget] of Object.entries(BUDGET)) {
		it(`${dir}/ carries at most ${budget}`, () => {
			const { total, worst } = countIn(dir);
			expect(
				total,
				`${dir}/ has ${total} backlog ids against a ceiling of ${budget}. ` +
					`Worst: ${worst.map(([f, n]) => `${f} (${n})`).join(', ')}. ` +
					'Replace the id with the reason; lower the ceiling in this file when you do.'
			).toBeLessThanOrEqual(budget);
		});
	}

	// the control: a ceiling nothing can breach is not a ceiling
	it('counts an id when one is present, and ignores what looks like one', () => {
		const hits = (s: string) => (s.match(BACKLOG_ID) ?? []).length;
		expect(hits('// per P45, the module stays unmodified')).toBe(1);
		expect(hits('// C112 closed it')).toBe(1);
		expect(hits('const PHP8 = 1; // php8.5, PORT, a-P1-b')).toBe(0);
	});
});
