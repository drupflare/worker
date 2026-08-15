import { describe, expect, it } from 'vitest';
import { KNOWN_MODULE_CAPABILITIES, SHIPPED_CAPABILITIES, tierFor } from '../../../src/ops/catalog';
import {
	allKnownCapabilities,
	CLASSIFIED_MODULES,
	MODULE_TIER_NOTES
} from '../../../src/ops/module-tiers';

/**
 * The classification table, checked against the classifier it feeds.
 *
 * The property that matters most is that an unclassified module stays `unknown`. Defaulting to
 * `works-today` would make the tier agree with the install verdict on everything and therefore
 * report nothing -- the same failure the blank meters had.
 */

const merged = allKnownCapabilities(KNOWN_MODULE_CAPABILITIES);

const REQUESTED = [
	'drupal/pathauto',
	'drupal/redirect',
	'drupal/metatag',
	'drupal/webform',
	'drupal/scheduler',
	'drupal/search_api',
	'drupal/facets',
	'drupal/paragraphs',
	'drupal/entity_reference_revisions',
	'drupal/token',
	'drupal/ctools',
	'drupal/field_group',
	'drupal/admin_toolbar',
	'drupal/linkit',
	'drupal/honeypot',
	'drupal/captcha',
	'drupal/simple_sitemap',
	'drupal/purge',
	'drupal/twig_tweak',
	'drupal/devel',
	'drupal/migrate_plus',
	'drupal/stage_file_proxy',
	'drupal/image_optimize',
	'drupal/filefield_sources',
	'drupal/queue_ui'
];

describe('coverage', () => {
	it('classifies every module on the list', () => {
		const missing = REQUESTED.filter((m) => !(m in MODULE_TIER_NOTES));
		expect(missing, `unclassified: ${missing.join(', ')}`).toEqual([]);
	});

	it('gives every entry a mechanism, not just a capability', () => {
		for (const [name, note] of Object.entries(MODULE_TIER_NOTES)) {
			expect(note.why.length, name).toBeGreaterThan(10);
		}
	});

	/** a refusal without a route out is a shrug; every non-empty need says what would lift it */
	it('says what would move every constrained module up a tier', () => {
		for (const [name, note] of Object.entries(MODULE_TIER_NOTES)) {
			if (note.needs.length === 0) continue;
			expect(note.lift, `${name} has needs but no lift`).toBeDefined();
			expect(note.lift?.length ?? 0, name).toBeGreaterThan(20);
		}
	});
});

describe('tiers under the shipped capabilities', () => {
	it('lands the local modules on works-today', () => {
		for (const name of [
			'drupal/pathauto',
			'drupal/token',
			'drupal/ctools',
			'drupal/redirect',
			'drupal/metatag',
			'drupal/admin_toolbar',
			'drupal/field_group',
			'drupal/linkit',
			'drupal/honeypot',
			'drupal/twig_tweak',
			'drupal/paragraphs',
			'drupal/entity_reference_revisions',
			'drupal/webform',
			'drupal/filefield_sources',
			'drupal/devel',
			'drupal/facets'
		]) {
			expect(tierFor(name, SHIPPED_CAPABILITIES).tier, name).toBe('works-today');
		}
	});

	/**
	 * Cron is TRUE in `SHIPPED_CAPABILITIES` because the alarm exists, so these classify as
	 * works-today by the capability model. That is the model being honest about a capability and
	 * the site being dishonest about using it: `driveCron()` is written, tested and never called.
	 * The `lift` field is where that gap is recorded.
	 */
	it('reports the cron modules against the capability, and records the unwired gap in lift', () => {
		for (const name of [
			'drupal/scheduler',
			'drupal/search_api',
			'drupal/simple_sitemap',
			'drupal/queue_ui'
		]) {
			expect(merged[name]).toContain('cron');
			expect(MODULE_TIER_NOTES[name]?.lift).toMatch(/cron wiring|driveCron/);
		}
	});

	it('refuses cron modules on a runtime without cron, naming the reason', () => {
		const noCron = { ...SHIPPED_CAPABILITIES, cron: false };
		const verdict = tierFor('drupal/scheduler', noCron);
		expect(verdict.tier).toBe('refused');
		expect(verdict.reason).toContain('cron');
	});

	it('puts the outbound modules on the deferred tier', () => {
		for (const name of [
			'drupal/captcha',
			'drupal/recaptcha',
			'drupal/stage_file_proxy',
			'drupal/purge'
		]) {
			expect(tierFor(name, SHIPPED_CAPABILITIES).tier, name).toBe('needs-deferred-tier');
		}
	});

	/** the one structural refusal, and it stays refused until the binary can suspend */
	it('refuses only search_api_solr, and only on blocking outbound', () => {
		const refused = REQUESTED.filter(
			(m) => tierFor(m, SHIPPED_CAPABILITIES).tier === 'refused'
		);
		expect(refused).toEqual([]);

		const solr = tierFor('drupal/search_api_solr', SHIPPED_CAPABILITIES);
		expect(solr.tier).toBe('refused');
		expect(solr.reason).toContain('INSIDE one render');
	});

	it('would refuse the deferrable ones on a runtime with no deferred tier', () => {
		const none = { ...SHIPPED_CAPABILITIES, deferredOutbound: false };
		expect(tierFor('drupal/recaptcha', none).tier).toBe('refused');
	});
});

describe('unknown stays unknown', () => {
	it('does not classify a module nobody looked at', () => {
		expect(tierFor('drupal/never_seen', SHIPPED_CAPABILITIES).tier).toBe('unknown');
	});

	it('merges without inventing entries', () => {
		expect(Object.keys(merged).length).toBeGreaterThanOrEqual(CLASSIFIED_MODULES.length);
		for (const name of CLASSIFIED_MODULES) expect(merged[name]).toBeDefined();
	});
});
