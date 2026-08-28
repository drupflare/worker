import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tierFor } from '../../src/ops/catalog';
import {
	FIXTURE_CLAUSE,
	labelFor,
	liftFor,
	MODULE_STATES,
	moduleTable,
	SHIPPING_PACK_CONTRIB,
	VERIFIED_BEHAVIOURS
} from '../../src/ops/module-table';
import { artifactGate } from './helpers/artifact-gate';

const here = dirname(fileURLToPath(import.meta.url));

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
		expect(verified.sort()).toEqual(Object.keys(VERIFIED_BEHAVIOURS).sort());
	});

	/**
	 * The verified set, pinned by name.
	 */
	it('pins exactly which modules have had their behaviour observed', () => {
		expect(Object.keys(VERIFIED_BEHAVIOURS).sort()).toEqual([
			'drupal/address',
			'drupal/admin_toolbar',
			'drupal/backup_migrate',
			'drupal/better_exposed_filters',
			'drupal/captcha',
			'drupal/coffee',
			'drupal/colorbox',
			'drupal/config_ignore',
			'drupal/crop',
			'drupal/csv_serialization',
			'drupal/ctools',
			'drupal/devel',
			'drupal/easy_breadcrumb',
			'drupal/editor_advanced_link',
			'drupal/entity',
			'drupal/entity_browser',
			'drupal/entity_reference_revisions',
			'drupal/externalauth',
			'drupal/facets',
			'drupal/field_group',
			'drupal/filefield_sources',
			'drupal/focal_point',
			'drupal/google_analytics',
			'drupal/google_tag',
			'drupal/honeypot',
			'drupal/imageapi_optimize',
			'drupal/imce',
			'drupal/jquery_ui',
			'drupal/jquery_ui_autocomplete',
			'drupal/jquery_ui_datepicker',
			'drupal/jquery_ui_menu',
			'drupal/json_field',
			'drupal/key',
			'drupal/libraries',
			'drupal/linkit',
			'drupal/mailsystem',
			'drupal/menu_block',
			'drupal/metatag',
			'drupal/metatag_search_gov',
			'drupal/migrate_plus',
			'drupal/module_filter',
			'drupal/paragraphs',
			'drupal/pathauto',
			'drupal/purge',
			'drupal/queue_ui',
			'drupal/recaptcha',
			'drupal/redirect',
			'drupal/scheduler',
			'drupal/search_api',
			'drupal/search_api_solr',
			'drupal/simple_sitemap',
			'drupal/stage_file_proxy',
			'drupal/svg_image',
			'drupal/token',
			'drupal/twig_tweak',
			'drupal/usfedgov_google_analytics',
			'drupal/uswds_base',
			'drupal/video_embed_field',
			'drupal/views_bulk_operations',
			'drupal/views_data_export',
			'drupal/webform',
			'drupal/xmlsitemap'
		]);
		for (const [name, evidence] of Object.entries(VERIFIED_BEHAVIOURS)) {
			// evidence must say what was exercised, not that it "works"
			expect(evidence.length, name).toBeGreaterThan(40);
			expect(evidence, name).not.toMatch(/^works\b/i);
		}
	});

	/**
	 * `verified` OVERRIDES `refused`, and nothing said so until a refused module was installable.
	 *
	 * `moduleTable()` tests `name in verified` first, so an entry added for a module the classifier
	 * refuses silently flips its state -- and smtp is now a dev dependency that enables cleanly, which
	 * makes writing that entry the natural mistake. The install is not the capability: what refuses
	 * smtp is the socket, and an enable-and-assert run cannot see that.
	 */
	it('never lets a verified entry overturn a refusal', () => {
		for (const name of Object.keys(VERIFIED_BEHAVIOURS)) {
			expect(
				tierFor(name).tier,
				`${name} is refused by the classifier and has a verified entry, which hides the refusal`
			).not.toBe('refused');
		}
	});

	it('carries a lift for every blocked row', () => {
		for (const row of moduleTable()) {
			if (row.state !== 'blocked') continue;
			expect(liftFor(row.name), `${row.name} is blocked with no route out`).toBeTruthy();
		}
	});

	/**
	 * `supported` was dissolved on 2026-08-18 and must not come back under any spelling.
	 *
	 * It meant "the capability this module needs was measured WITHOUT the module", which is an
	 * inference that read to everybody else as a promise. The rule now is that `verified` is the only
	 * support claim and it is reachable only through a gated enable-and-assert run - so a state that
	 * sounds like a promise is a regression, not a wording choice.
	 */
	it('has no state that claims support without a gated run', () => {
		const states = new Set(moduleTable().map((r) => r.state));
		// THE VOCABULARY IS WHAT IS PINNED, not the census. This asserted `['blocked','verified']`
		// while P8b had every row in one of those two, and that made a CORRECT reclassification fail:
		// `search_api_solr` moved off `blocked` the day its transport was proven interceptable, and
		// `untested` is the honest state for a module whose capability is measured and which no gated
		// run has enabled. A test that fails on honesty is pinning a moment, not a rule.
		for (const state of states) expect(MODULE_STATES).toContain(state);
		expect(states.has('supported' as never)).toBe(false);
		for (const row of moduleTable()) {
			expect(row.evidence, `${row.name} claims support in its evidence`).not.toMatch(
				/\bsupported\b/i
			);
		}
	});
});

/**
 * The pack boundary, read from the artifact rather than from a comment.
 *
 * Measured 2026-08-20: twelve of the fourteen `verified` rows name modules the shipping pack does
 * not carry, and `contrib-verify.spec.ts` answers that with `not in the mounted pack, skipped` and
 * a PASS -- eleven of twelve cases asserting nothing, green. The claims are real, established
 * against a `PACK_CONTRIB=1` fixture build; what was missing is anything that could notice the
 * difference. The workers lane cannot, because it is the lane that skips.
 */
const PACK_INDEX = join(here, '..', '..', 'assets', 'drupal-pf', 'core.pf.json');

/** the contrib machine names the per-file pack actually carries */
function packedContrib(): string[] {
	const entries = JSON.parse(readFileSync(PACK_INDEX, 'utf8')) as { p?: string }[];
	const found = new Set<string>();
	for (const entry of entries) {
		const machine = /^modules\/contrib\/([^/]+)\//.exec(entry.p ?? '')?.[1];
		if (machine !== undefined) found.add(`drupal/${machine}`);
	}
	return [...found].sort();
}

describe('the shipping pack and what the table claims about it', () => {
	it('records every verified row as shipping-packed or fixture-only, never neither', () => {
		const verified = Object.keys(VERIFIED_BEHAVIOURS);
		const shipping = verified.filter((n) => SHIPPING_PACK_CONTRIB.includes(n));
		const fixture = verified.filter((n) => !SHIPPING_PACK_CONTRIB.includes(n));
		expect(shipping.length + fixture.length).toBe(verified.length);
		// the partition has to be visible to a reader, or it is bookkeeping nobody acts on
		// the partition has to reach the evidence, or a reader cannot tell a shipped module from one
		// only the fixture build carries
		const marker = 'dev dependency';
		expect(FIXTURE_CLAUSE).toContain(marker);
		const carrying = moduleTable().filter((r) => r.evidence.includes(marker));
		expect(carrying.map((r) => r.name).sort()).toEqual(fixture.sort());
		expect(fixture.length, 'nothing is fixture-only; drop the clause').toBeGreaterThan(0);
	});

	it('agrees with the pack index in both directions', () => {
		if (artifactGate(['assets/drupal-pf/core.pf.json'])) return;
		const packed = packedContrib();
		// EITHER DIRECTION. A name on the list that the pack does not carry overstates what the
		// gate can re-run; a module in the pack that the list omits is the stale-exemption case,
		// and it is the one that quietly waves the next skipped row through
		expect(packed).toEqual([...SHIPPING_PACK_CONTRIB].sort());
	});

	it('never marks a shipping-packed module fixture-only', () => {
		for (const name of SHIPPING_PACK_CONTRIB) {
			const evidence = VERIFIED_BEHAVIOURS[name];
			if (evidence === undefined) continue;
			expect(evidence, name).not.toContain('PACK_CONTRIB=1');
		}
	});
});

/**
 * Every `verified` claim, tied to a test that produced it.
 *
 * `only reports verified for modules with recorded behaviour evidence` above checks the evidence
 * STRING exists. A string is prose: a name could be added with a convincing sentence and no run
 * behind it, and nothing would fail. That is the shape of the defect `check:reachability` exists
 * for -- green, documented, and wired to nothing -- pointed at the support matrix instead of at a
 * module.
 *
 * Two specs are legitimate sources, and the split is the pack boundary rather than a convenience:
 * `contrib-verify.spec.ts` drives a `PACK_CONTRIB=1` fixture build, and `module-behaviour.spec.ts`
 * drives the four modules the shipping pack actually carries in the default gate.
 */
describe('every verified module has a run behind it, not just a sentence', () => {
	const readSpec = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

	/** the machine names each spec exercises */
	function exercised(): Set<string> {
		const fixture = readSpec('integration/contrib-verify.spec.ts');
		const shipping = readSpec('integration/module-behaviour.spec.ts');
		const names = new Set<string>();
		// a fixture case declares itself as `module: 'name'`
		for (const m of fixture.matchAll(/module:\s*'([a-z0-9_]+)'/g)) names.add(m[1] as string);
		// the shipping spec enables by name
		for (const m of shipping.matchAll(/enable\(site,\s*'([a-z0-9_]+)'\)/g))
			names.add(m[1] as string);
		return names;
	}

	it('names a spec case for every verified row', () => {
		const runs = exercised();
		const missing = Object.keys(VERIFIED_BEHAVIOURS)
			.map((n) => n.split('/')[1] as string)
			.filter((n) => !runs.has(n));
		expect(
			missing,
			'verified with no enable-and-assert case; either add the case or drop the claim'
		).toEqual([]);
	});

	/**
	 * The other direction, which is the one an allow-list never catches.
	 *
	 * A case that runs and asserts but whose module is not `verified` is either a refusal the table
	 * is right to keep (smtp: the classifier refuses it because of the socket, and an install cannot
	 * see that) or a claim somebody forgot to make.
	 */
	it('accounts for every case that runs but is not verified', () => {
		const verified = new Set(Object.keys(VERIFIED_BEHAVIOURS).map((n) => n.split('/')[1]));
		const unclaimed = [...exercised()].filter((n) => !verified.has(n)).sort();
		expect(unclaimed, 'a case runs for this module but the table makes no claim').toEqual([
			'search_gov_results_api',
			'smtp'
		]);
		// each is absent for its own reason. `smtp` needs a socket inside the request that sends the
		// mail, which the classifier refuses. `search_gov_results_api` is NOT refused: measured, the
		// deferred tier carries its GET across two renders, so what it lacks is a Search.gov API key
		// rather than a capability -- see `guzzle-handler.spec.ts`
		expect(tierFor('drupal/smtp').tier).toBe('refused');
		expect(tierFor('drupal/search_gov_results_api').tier).not.toBe('refused');
		expect(tierFor('drupal/simple_sitemap').tier).not.toBe('refused');
		// the vector is still what decides it; only the vector's answer moved
		expect(tierFor('drupal/simple_sitemap').reason).not.toContain('runtime.xmlwriter');
	});

	/**
	 * The first module here refused by the INTEGER WIDTH rather than by a capability.
	 *
	 * `search_api_solr` pulls `maennchen/zipstream-php`, which declares `php-64bit`, so composer
	 * emits a `platform_check.php` asserting `PHP_INT_SIZE === 8`. On this build that is 4 and the
	 * check aborts every request before Drupal boots -- measured by installing it: all 56 other
	 * contrib cases failed too. With the check disabled the module installs clean and 57/57 pass.
	 */
	it('stops refusing search_api_solr once the integer width is satisfied', () => {
		// `runtime.int64` was its only refusal and the vector now answers true, so what is left is
		// the transport tier. It reached `verified` on 2026-08-27 with the platform check still ON,
		// which is the run the note said it was waiting for
		expect(tierFor('drupal/search_api_solr').tier).not.toBe('refused');
		expect(VERIFIED_BEHAVIOURS['drupal/search_api_solr']).toContain('platform check ON');
	});
});

describe('labelFor', () => {
	it('turns a composer name into something a reader recognises', () => {
		expect(labelFor('drupal/admin_toolbar')).toBe('Admin Toolbar');
		expect(labelFor('drupal/pathauto')).toBe('Pathauto');
		expect(labelFor('drupal/entity_reference_revisions')).toBe('Entity Reference Revisions');
	});
});
