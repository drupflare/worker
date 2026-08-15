import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	labelFor,
	moduleTable,
	renderModuleTable,
	TABLE_BEGIN,
	TABLE_END,
	VERIFIED_BEHAVIOURS
} from '../../src/ops/module-table';

/**
 * The README module table, against the classifier that produces it.
 *
 * Same discipline as the driver-pack byte-for-byte check: a hand-maintained table goes stale the
 * first time a tier moves, and it goes stale SILENTLY because nothing compares it to anything. This
 * fails when the two disagree and prints the regenerated block, so the fix is a paste rather than an
 * investigation.
 */

const here = dirname(fileURLToPath(import.meta.url));
const README = join(here, '..', '..', 'README.md');

function readmeTable(): string {
	const readme = readFileSync(README, 'utf8');
	const from = readme.indexOf(TABLE_BEGIN);
	const to = readme.indexOf(TABLE_END);
	if (from === -1 || to === -1) {
		throw new Error(
			`README.md has no module table region. Insert:\n\n${renderModuleTable()}\n`
		);
	}
	return readme.slice(from, to + TABLE_END.length);
}

describe('the README module table', () => {
	it('matches what the classifier emits', () => {
		const expected = renderModuleTable();
		expect(
			readmeTable(),
			`README.md is out of date. Replace the region between the markers with:\n\n${expected}\n`
		).toBe(expected);
	});

	it('is generated, not hand-written, so the markers must survive edits', () => {
		const readme = readFileSync(README, 'utf8');
		expect(readme).toContain(TABLE_BEGIN);
		expect(readme).toContain(TABLE_END);
	});
});

describe('moduleTable', () => {
	it('never states a support claim for an unclassified module', () => {
		const rows = moduleTable();
		expect(rows.some((r) => r.name === 'drupal/never_classified')).toBe(false);
		// every row has evidence; a state without a reason is the thing this table exists to avoid
		for (const row of rows) {
			expect(row.evidence.length, row.name).toBeGreaterThan(10);
		}
	});

	/**
	 * The claim that costs the most if it is wrong.
	 *
	 * `verified` may only be set from a test run that asserted behaviour. It is currently empty, and
	 * a green suite must not be able to quietly promote a module into it.
	 */
	it('only reports verified for modules with recorded behaviour evidence', () => {
		const rows = moduleTable();
		for (const row of rows) {
			if (row.state !== 'verified') continue;
			expect(VERIFIED_BEHAVIOURS[row.name], row.name).toBeDefined();
		}
		const verified = rows.filter((r) => r.state === 'verified').map((r) => r.name);
		expect(verified).toEqual(Object.keys(VERIFIED_BEHAVIOURS));
	});

	/**
	 * The verified set, pinned by name.
	 *
	 * This started as "nothing is verified yet" and was written to fail the day the first module was,
	 * so that promotion is a deliberate edit rather than a drift. Two modules earned it under the
	 * workers pool lane; `pathauto` and `token` did not, because the site ships no pathauto pattern
	 * and their behaviour is therefore unreachable rather than broken.
	 */
	it('pins exactly which modules have had their behaviour observed', () => {
		expect(Object.keys(VERIFIED_BEHAVIOURS).sort()).toEqual([
			'drupal/admin_toolbar',
			'drupal/ctools'
		]);
		for (const [name, evidence] of Object.entries(VERIFIED_BEHAVIOURS)) {
			// evidence must say what was exercised, not that it "works"
			expect(evidence.length, name).toBeGreaterThan(40);
			expect(evidence, name).not.toMatch(/^works\b/i);
		}
	});

	it('carries a lift for every blocked row', () => {
		const table = renderModuleTable();
		for (const row of moduleTable()) {
			if (row.state !== 'blocked') continue;
			expect(table, row.name).toContain('**Lift:**');
		}
	});

	it('escapes a pipe so a reason cannot break the table', () => {
		const rendered = renderModuleTable([
			{ name: 'drupal/x', label: 'X', state: 'supported', evidence: 'a | b' }
		]);
		expect(rendered).toContain('a \\| b');
		expect(rendered.split('\n').filter((l) => l.startsWith('| X')).length).toBe(1);
	});
});

describe('labelFor', () => {
	it('turns a composer name into something a reader recognises', () => {
		expect(labelFor('drupal/admin_toolbar')).toBe('Admin Toolbar');
		expect(labelFor('drupal/pathauto')).toBe('Pathauto');
		expect(labelFor('drupal/entity_reference_revisions')).toBe('Entity Reference Revisions');
	});
});
