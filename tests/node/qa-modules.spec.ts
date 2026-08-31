import { describe, expect, it } from 'vitest';
import {
	CORE_MODULES,
	QA_MODULES,
	SHIPPED_CONTRIB,
	classify,
	type Capability,
	type Verdict
} from '../../scripts/qa/modules';

/**
 * The QA pass's classifier, without a site.
 *
 * The property that matters most is `absent` outranking everything. Twenty-one of the twenty-five
 * modules are not in the shipped pack, and the temptation is to report the prediction for those --
 * "recaptcha: refused" reads as a result when nothing was tested. It is not a result, and this
 * spec is what stops the runner from producing one.
 */

const base = {
	discoverable: true,
	enabled: true,
	needs: [] as readonly Capability[],
	expected: 'works' as Verdict
};

describe('the module table', () => {
	it('covers 25 modules with unique machine names', () => {
		expect(QA_MODULES).toHaveLength(25);
		const names = QA_MODULES.map((m) => m.machine);
		expect(new Set(names).size).toBe(names.length);
	});

	it('gives every module a reason, not just a prediction', () => {
		for (const m of QA_MODULES) {
			expect(m.why.length, m.machine).toBeGreaterThan(10);
			expect(m.composer, m.machine).toMatch(/^[a-z0-9_-]+\/[a-z0-9_-]+$/);
		}
	});

	it('uses only the three capability names the runtime models', () => {
		const allowed = new Set<Capability>(['deferrable-outbound', 'blocking-outbound', 'cron']);
		for (const m of QA_MODULES) {
			for (const n of m.needs) expect(allowed.has(n), `${m.machine}: ${n}`).toBe(true);
		}
	});

	it('names exactly one structural refusal', () => {
		const refused = QA_MODULES.filter((m) => m.needs.includes('blocking-outbound'));
		expect(refused.map((m) => m.machine)).toEqual(['search_api_solr']);
	});

	it('names the two deferrable cases', () => {
		const deferrable = QA_MODULES.filter((m) => m.needs.includes('deferrable-outbound'));
		expect(deferrable.map((m) => m.machine).sort()).toEqual(['recaptcha', 'stage_file_proxy']);
	});
});

describe('classify', () => {
	it('reports core as core whatever else was observed', () => {
		for (const machine of CORE_MODULES) {
			expect(classify({ ...base, machine, discoverable: false, enabled: false })).toBe(
				'core'
			);
		}
	});

	it('reports an absent module as absent, never as its prediction', () => {
		// nothing was tested, so no capability verdict has been earned
		expect(
			classify({
				...base,
				machine: 'recaptcha',
				discoverable: false,
				enabled: false,
				needs: ['deferrable-outbound'],
				expected: 'needs-deferred-tier'
			})
		).toBe('absent');
		expect(
			classify({
				...base,
				machine: 'search_api_solr',
				discoverable: false,
				enabled: false,
				needs: ['blocking-outbound'],
				expected: 'refused'
			})
		).toBe('absent');
	});

	it('keeps obsolete ahead of absence, because the module has no release to find', () => {
		expect(
			classify({
				...base,
				machine: 'file_entity',
				discoverable: false,
				enabled: false,
				expected: 'obsolete'
			})
		).toBe('obsolete');
	});

	it('reports a discoverable module that would not enable as refused', () => {
		expect(classify({ ...base, machine: 'metatag', enabled: false })).toBe('refused');
	});

	it('separates the three outbound tiers once the code is actually present', () => {
		expect(
			classify({ ...base, machine: 'search_api_solr', needs: ['blocking-outbound'] })
		).toBe('refused');
		expect(
			classify({ ...base, machine: 'stage_file_proxy', needs: ['deferrable-outbound'] })
		).toBe('needs-deferred-tier');
		expect(classify({ ...base, machine: 'scheduler', needs: ['cron'] })).toBe('needs-cron');
	});

	it('gates on the harder capability when a module needs two', () => {
		expect(classify({ ...base, machine: 'x', needs: ['deferrable-outbound', 'cron'] })).toBe(
			'needs-deferred-tier'
		);
		expect(classify({ ...base, machine: 'x', needs: ['blocking-outbound', 'cron'] })).toBe(
			'refused'
		);
	});

	it('reports a packed contrib module as ships and anything else as works', () => {
		for (const machine of SHIPPED_CONTRIB) {
			expect(classify({ ...base, machine })).toBe('ships');
		}
		expect(classify({ ...base, machine: 'metatag' })).toBe('works');
	});
});
