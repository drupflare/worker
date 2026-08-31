import { describe, expect, it } from 'vitest';
import {
	ADVISORY_SCHEMA,
	ADVISORY_STALE_AFTER_S,
	advisoryFreshness,
	readAdvisories
} from '../../../src/ops/advisories';

/**
 * The reader for what the update module found.
 *
 * Every case here is about one asymmetry: an unreadable record must answer `unknown` and never
 * `current`. A site nothing has checked and a site checked and found clean are the same bytes to a
 * reader that does not distinguish them, and reporting the first as the second tells an operator
 * something false about a security question.
 */

/** the cell shape the host reads: a state row holds a PHP-serialized string */
function cell(json: string): string {
	return `s:${new TextEncoder().encode(json).length}:"${json}";`;
}

function record(over: Record<string, unknown> = {}): string {
	return cell(
		JSON.stringify({
			schema: ADVISORY_SCHEMA,
			at: 1_700_000_000,
			checked: true,
			reason: '',
			insecure: [],
			stale: [],
			...over
		})
	);
}

describe('what an unreadable record answers', () => {
	it('is unknown, never current, for every shape that cannot be read', () => {
		for (const blob of [
			undefined,
			null,
			'',
			'i:1;',
			'b:1;',
			'N;',
			'a:0:{}',
			cell('not json'),
			cell('[]'),
			cell('null')
		]) {
			expect(readAdvisories(blob).state, JSON.stringify(blob)).toBe('unknown');
		}
	});

	it('refuses a schema it does not read, in BOTH directions', () => {
		// a NEWER record may carry a status this cannot classify, and guessing is the false all-clear
		expect(readAdvisories(record({ schema: ADVISORY_SCHEMA + 1 })).state).toBe('unknown');
		expect(readAdvisories(record({ schema: ADVISORY_SCHEMA - 1 })).state).toBe('unknown');
	});

	it('reports a scan that had nothing to read as unknown, and keeps its reason', () => {
		const out = readAdvisories(
			record({ checked: false, reason: 'the update module has computed no project data' })
		);
		expect(out.state).toBe('unknown');
		expect(out.detail).toContain('no project data');
		// the timestamp survives, so an operator can tell a scan that ran and found nothing from one
		// that never ran at all
		expect(out.at).toBe(1_700_000_000);
	});
});

describe('what a readable record answers', () => {
	it('reports an advisory, with the projects that carry it', () => {
		const out = readAdvisories(
			record({
				insecure: [
					{
						project: 'ctools',
						installed: '4.0.4',
						recommended: '4.1.0',
						why: 'not-secure'
					}
				],
				stale: [{ project: 'token', installed: '1.13', recommended: '1.15' }]
			})
		);
		expect(out.state).toBe('insecure');
		expect(out.insecure).toBe(1);
		expect(out.detail).toContain('ctools 4.0.4 -> 4.1.0');
		// the stale one is counted but does not become the verdict
		expect(out.stale).toBe(1);
		expect(out.projects).toHaveLength(1);
	});

	it('keeps behind-but-not-insecure separate from an advisory', () => {
		// conflating them is how a security signal stops meaning anything: every site is behind on
		// something most of the time
		const out = readAdvisories(
			record({ stale: [{ project: 'token', installed: '1.13', recommended: '1.15' }] })
		);
		expect(out.state).toBe('stale');
		expect(out.insecure).toBe(0);
	});

	it('reports current only when the scan ran and found nothing', () => {
		const out = readAdvisories(record());
		expect(out.state).toBe('current');
		expect(out.detail).toBe('every project is current');
	});
});

describe('a verdict has an age, and an old one is not an answer', () => {
	it('is fresh inside the bound', () => {
		const verdict = readAdvisories(record({ at: 1_000_000 }));
		expect(advisoryFreshness(verdict, 1_000_000 + ADVISORY_STALE_AFTER_S).fresh).toBe(true);
	});

	it('is stale outside it, because an advisory is published against the world', () => {
		// "checked a fortnight ago and was clean" is not "clean"; the advisory may postdate the scan
		const verdict = readAdvisories(record({ at: 1_000_000 }));
		const out = advisoryFreshness(verdict, 1_000_000 + ADVISORY_STALE_AFTER_S + 1);
		expect(out.fresh).toBe(false);
		expect(out.ageS).toBe(ADVISORY_STALE_AFTER_S + 1);
	});

	it('treats a record with no timestamp as infinitely old rather than as fresh', () => {
		expect(advisoryFreshness(readAdvisories(undefined), 1_000_000).fresh).toBe(false);
	});
});
