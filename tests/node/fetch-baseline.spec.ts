import { describe, expect, it } from 'vitest';
import {
	artifactIsLive,
	pickRun,
	WORKFLOW,
	type RunRow
} from '../../scripts/measure/fetch-baseline.ts';

/**
 * Resolving the document a gate is judged against, by ref.
 *
 * This is what keeps the CUMULATIVE reading alive after `metrics/baseline.json` was deleted: creep
 * since a release is the same comparison as creep since the previous commit, with a different
 * `--ref`. Two things can go quietly wrong -- picking a run that failed, and downloading nothing
 * from a run whose artifact expired -- and both would answer a cumulative question with silence
 * that reads like agreement.
 *
 * Node lane: the module shells out to `gh`.
 */

function row(over: Partial<RunRow> = {}): RunRow {
	return {
		databaseId: 1,
		headSha: 'a'.repeat(40),
		createdAt: '2026-08-17T05:18:05Z',
		conclusion: 'success',
		...over
	};
}

describe('picking the run that answers the question', () => {
	it('takes the newest passing run when no ref was named', () => {
		const rows = [row({ databaseId: 3 }), row({ databaseId: 2 }), row({ databaseId: 1 })];
		expect(pickRun(rows)?.databaseId).toBe(3);
	});

	it('never takes a run that failed, however recent', () => {
		const rows = [
			row({ databaseId: 9, conclusion: 'failure' }),
			row({ databaseId: 8, conclusion: 'success' })
		];
		expect(pickRun(rows)?.databaseId).toBe(8);
	});

	it('takes the run for an exact commit when a ref resolved to one', () => {
		const wanted = 'b'.repeat(40);
		const rows = [row({ databaseId: 3 }), row({ databaseId: 2, headSha: wanted })];
		expect(pickRun(rows, wanted)?.databaseId).toBe(2);
	});

	it('finds nothing rather than falling back to the newest run', () => {
		// silently answering a question about v1.0.0 with master's numbers is the failure this
		// guards; a cumulative reading that quietly changed subject is worse than none
		const rows = [row({ databaseId: 3 })];
		expect(pickRun(rows, 'c'.repeat(40))).toBeUndefined();
	});

	it('finds nothing in an empty history', () => {
		expect(pickRun([])).toBeUndefined();
		expect(pickRun([], 'd'.repeat(40))).toBeUndefined();
	});
});

describe('whether the run still carries a document', () => {
	it('accepts a live artifact under the name the workflow uploads', () => {
		expect(artifactIsLive([{ name: 'metrics', expired: false }])).toBe(true);
	});

	it('refuses an expired one rather than downloading nothing', () => {
		expect(artifactIsLive([{ name: 'metrics', expired: true }])).toBe(false);
	});

	it('refuses a run carrying only other artifacts', () => {
		expect(artifactIsLive([{ name: 'coverage', expired: false }])).toBe(false);
		expect(artifactIsLive([])).toBe(false);
	});
});

describe('what it points at', () => {
	it('names the workflow that archives the document', () => {
		expect(WORKFLOW).toBe('metrics.yml');
	});
});
