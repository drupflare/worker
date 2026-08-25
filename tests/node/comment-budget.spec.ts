import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A ceiling on comment prose, so it can only come down.
 *
 * The house rule is one line, two at most, with long reasoning in `TECHNICAL_REPORT.md` instead.
 * A block of five or more consecutive comment lines is over that by any reading, and a TSDoc block
 * on an export is measured the same way: a paragraph is a paragraph.
 */

const ROOT = new URL('../..', import.meta.url).pathname;
const SKIP_DIRS = new Set(['node_modules', 'coverage', '.wrangler']);

/** the house rule is one line, two at most; everything past that is the overage */
const ALLOWED = 2;

/** measured 2026-08-24; ceilings that may only come down */
const BUDGET: Readonly<Record<string, number>> = {
	src: 9139,
	tests: 5092,
	scripts: 2774
};

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) sourceFiles(full, out);
		else if (entry.endsWith('.ts') && !entry.startsWith('comment-budget')) out.push(full);
	}
	return out;
}

/**
 * Comment lines past the two-line rule, summed over every block.
 *
 * Counting BLOCKS was the first attempt and it measures the wrong thing: cutting a 48-line header to
 * 15 lines leaves one block either way, so real work moved the number not at all.
 */
export function overage(source: string): number {
	let run = 0;
	let over = 0;
	const close = () => {
		if (run > ALLOWED) over += run - ALLOWED;
		run = 0;
	};
	for (const line of source.split('\n')) {
		const t = line.trim();
		if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/**')) run++;
		else close();
	}
	close();
	return over;
}

function countIn(dir: string): { total: number; worst: [string, number][] } {
	const per: [string, number][] = [];
	let total = 0;
	for (const file of sourceFiles(join(ROOT, dir))) {
		const n = overage(readFileSync(file, 'utf8'));
		if (n > 0) {
			per.push([file.slice(ROOT.length), n]);
			total += n;
		}
	}
	per.sort((a, b) => b[1] - a[1]);
	return { total, worst: per.slice(0, 5) };
}

describe('comment prose stays inside its budget', () => {
	for (const [dir, budget] of Object.entries(BUDGET)) {
		it(`${dir}/ carries at most ${budget} comment lines over the rule`, () => {
			const { total, worst } = countIn(dir);
			expect(
				total,
				`${dir}/ is ${total} comment lines over the two-line rule, against a ceiling of ${budget}. ` +
					`Worst: ${worst.map(([f, n]) => `${f} (${n})`).join(', ')}. ` +
					'Cut them to a line or two and lower the ceiling here.'
			).toBeLessThanOrEqual(budget);
		});
	}

	// the control: a counter blind to a cut is a ceiling nothing can move
	it('charges only the lines past the rule, and falls when a block is cut', () => {
		expect(overage('// one\nconst a = 1;')).toBe(0);
		expect(overage('// 1\n// 2\nconst a = 1;')).toBe(0);
		expect(overage('// 1\n// 2\n// 3\nconst a = 1;')).toBe(1);
		expect(overage('/**\n * 2\n * 3\n * 4\n * 5\n */')).toBe(4);
		// a block that runs to the end of the file still counts
		expect(overage('// 1\n// 2\n// 3')).toBe(1);
		expect(overage('// 1\n// 2\n// 3\nx\n// 1\n// 2\n// 3\ny')).toBe(2);
	});
});
