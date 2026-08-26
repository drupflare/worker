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
	'drupal/imageapi_optimize',
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
		// `simple_sitemap` is NOT here any more, and the reason is the point: it is classified
		// `cron` and refused before cron is ever reached, on a missing `XMLWriter`. Its lift
		// describes that instead, so requiring the cron sentence would force it to carry a lift for
		// a question downstream of an install that does not happen
		for (const name of ['drupal/scheduler', 'drupal/search_api', 'drupal/queue_ui']) {
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

	/**
	 * Nothing on the stress list refuses any more, and `simple_sitemap` was the last one.
	 *
	 * It was refused on a capability VECTOR rather than on the coarse three-value vocabulary --
	 * `hook_requirements()` demanding `ext-xmlwriter`, which is neither outbound nor cron. The
	 * host now supplies a pure-PHP `XMLWriter`, verified byte for byte against libxml, so the
	 * vector passes and the refusal is gone. An empty set is a weak assertion on its own, which is
	 * why the vector path is asserted separately below: the mechanism must still be WIRED, or this
	 * test would keep passing after `tierFor()` stopped consulting vectors at all.
	 */
	it('leaves nothing on the stress list refused', () => {
		const refused = REQUESTED.filter(
			(m) => tierFor(m, SHIPPED_CAPABILITIES).tier === 'refused'
		);
		expect(refused).toEqual([]);
	});

	it('still scores the sitemap on its capability vector, not on the coarse vocabulary', () => {
		const vectors = MODULE_TIER_NOTES['drupal/simple_sitemap']?.vectors ?? [];
		expect(vectors).toContain('runtime.xmlwriter');

		const sitemap = tierFor('drupal/simple_sitemap', SHIPPED_CAPABILITIES);
		expect(sitemap.tier).not.toBe('refused');
		// and never on the socket mechanism, which was always a different question about it
		expect(sitemap.reason ?? '').not.toContain('INSIDE one render');
	});

	/**
	 * `search_api_solr` LEFT the refused set on 2026-08-23, and it left for a measured reason.
	 *
	 * It was refused because a Solr query must answer inside the render that asked. Measured against
	 * solarium 6.4.2, the transport is interceptable ABOVE the adapter -- `PreExecuteRequest` short-
	 * circuits it and `search_api_solr` hands Drupal's dispatcher to the client -- so the deferred
	 * tier reaches it after all. This assertion exists so the move is deliberate: if it ever reads
	 * `refused` again, something regressed rather than a spec being tidied.
	 */
	// its transport is interceptable and is not what refuses it: a transitive `php-64bit` makes
	// composer's platform check abort every request on this build
	it('no longer refuses search_api_solr, because the integer width was its only blocker', () => {
		const solr = tierFor('drupal/search_api_solr', SHIPPED_CAPABILITIES);
		expect(solr.tier).not.toBe('refused');
		// its remaining tier is about the transport, which was never the blocker
		expect(solr.tier).toBe('needs-deferred-tier');
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
