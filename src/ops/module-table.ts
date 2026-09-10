import { KNOWN_MODULE_CAPABILITIES, SHIPPED_CAPABILITIES, tierFor } from './catalog.js';
import {
	GENERATED_CAPABILITY_EVIDENCE,
	GENERATED_SHIPPING_CONTRIB,
	GENERATED_VERIFIED
} from './generated/modules.js';
import { MODULE_TIER_NOTES } from './module-tiers.js';

/**
 * The module support table, EMITTED from the classifier rather than hand-written.
 *
 * A hand-maintained README table goes stale the first time a tier moves, and it goes stale silently
 * because nothing compares it to anything. `tests/node/module-table.spec.ts` compares these rows
 * against README.md's three lists in both directions -- the same discipline as the driver-pack
 * byte-for-byte check.
 *
 * **THAT SENTENCE WAS FALSE FOR AS LONG AS IT HAD BEEN WRITTEN**, which is the reason it is worth
 * pointing at. It claimed the spec "fails when README.md disagrees"; the spec compared this map
 * against the SPEC FILES, so a `verified` row needed a run behind it and the published table needed
 * nothing. Three rows were edited by hand on the strength of the guard described here. The
 * comparison exists now.
 *
 * **THREE STATES, AND ONLY ONE OF THEM IS A SUPPORT CLAIM.**
 *
 *   - `verified`  the gate enabled it against a real site and asserted it FUNCTIONS. Not that the
 *                 installer returned ok; that a thing the module does actually happened.
 *   - `untested`  nobody has enabled it here. The capability analysis says it should work, which is
 *                 an inference about the runtime and not an observation about the module.
 *   - `blocked`   cannot work, with the mechanism and what would lift it.
 *
 * **`supported` WAS A STATE HERE AND IT WAS DISSOLVED** (2026-08-18, Gregory's call). It meant
 * "the capability this module needs was measured WITHOUT the module", which is a reasoned claim and
 * reads to anybody else as a promise. Renaming it `untested` is the whole fix: the row still carries
 * the same evidence, and it no longer claims something no test has shown.
 *
 * The rule that replaces it: **nothing reaches `verified` except through a gated enable-and-assert
 * run.** There is no path in this file that promotes a module on analysis alone, and adding one
 * would put the old problem back under a new name.
 */
export type SupportState = 'verified' | 'untested' | 'blocked';

/**
 * The same three, as a value, so a test can pin the VOCABULARY rather than today's census.
 *
 * The distinction earned its own export: the spec used to assert the exact set of states in use,
 * which passed while every row happened to be `verified` or `blocked` and then failed the moment a
 * module was honestly reclassified to `untested`.
 */
export const MODULE_STATES: readonly SupportState[] = ['verified', 'untested', 'blocked'];

/**
 * The contrib modules the SHIPPING pack carries, which is four and has always been four.
 *
 * `scripts/pack-drupal.ts` puts `modules/contrib` behind `PACK_CONTRIB=1` and says why in its own
 * comment: the other modules under `drupal-src/modules/contrib` are a QA fixture rather than
 * product. So a `verified` row outside this list was established against a fixture build, and
 * re-running the gate against the shipping artifact SKIPS it rather than re-establishing it.
 *
 * Measured from `assets/drupal-pf/core.pf.json` rather than believed --
 * `tests/node/module-table.spec.ts` reads the pack index and fails if this list and the artifact
 * disagree in either direction.
 */
export const SHIPPING_PACK_CONTRIB: readonly string[] = GENERATED_SHIPPING_CONTRIB;

/**
 * The clause every fixture-verified row carries, so the reader is not left to infer it.
 *
 * One string rather than twelve copies: the distinction is a property of the pack, so a row gains
 * or loses it by moving in or out of {@link SHIPPING_PACK_CONTRIB}, never by someone editing prose.
 */
export const FIXTURE_CLAUSE =
	'. Required as a dev dependency and verified against the test build rather than shipped, so a ' +
	'site does not carry it unless it asks for it';

/**
 * Modules whose BEHAVIOUR the gate has asserted, with what was asserted.
 *
 * Under `wrangler dev` an enable killed the host process, so no follow-up request could be made and
 * nothing could be verified. Re-run under `@cloudflare/vitest-pool-workers` that limit does not
 * exist: an enable survives, a follow-up request answers, and TWO enables in one object survive --
 * the exact case that killed wrangler dev hardest. The failure was miniflare's proxy controller, a
 * component that only exists locally, and suspecting the instrument first was right.
 *
 * What that left was a configuration gap rather than a runtime one, and **the gap was closed by
 * supplying the configuration rather than by waiting for it.** This block used to record `pathauto`
 * as inert (no `pathauto.pattern.*` ships, so a node save produces no alias) and `token` as
 * unverifiable for the same reason. A pattern is a config entity a SITE OWNER creates, so the test
 * creates one; both are now verified against an alias the run generated.
 *
 * The distinction worth keeping: absent CONFIGURATION is a fixture gap a test can fill, absent CODE
 * is not. Twelve rows here are in the second class -- see {@link SHIPPING_PACK_CONTRIB}.
 */
export const VERIFIED_BEHAVIOURS: Readonly<Record<string, string>> = GENERATED_VERIFIED;

/**
 * Modules whose CAPABILITY the gate exercised end to end, while the module itself is absent.
 */
export const CAPABILITY_EVIDENCE: Readonly<Record<string, string>> = GENERATED_CAPABILITY_EVIDENCE;

export interface TableRow {
	/** composer name */
	name: string;
	/** the short name a reader recognises */
	label: string;
	state: SupportState;
	/** what the gate asserted, for `verified`; what the analysis concluded, otherwise */
	evidence: string;
}

/**
 * Words a machine name spells lowercase and a reader does not.
 *
 * Word-by-word rather than whole-name, so `jquery_ui_datepicker` and `jquery_ui` both read right
 * from one entry each. A machine name is snake_case by Drupal convention, and capitalising each
 * part gave `Uswds Base`, `Xmlsitemap` and `Jquery Ui` -- correct by the rule and wrong on the page.
 */
const WORD_CASING: Readonly<Record<string, string>> = {
	api: 'API',
	captcha: 'CAPTCHA',
	cdn: 'CDN',
	ckeditor: 'CKEditor',
	csv: 'CSV',
	dap: 'DAP',
	gov: 'Gov',
	imce: 'IMCE',
	jquery: 'jQuery',
	js: 'JS',
	json: 'JSON',
	oidc: 'OIDC',
	php: 'PHP',
	pdf: 'PDF',
	rss: 'RSS',
	seo: 'SEO',
	smtp: 'SMTP',
	solr: 'Solr',
	sql: 'SQL',
	svg: 'SVG',
	ui: 'UI',
	url: 'URL',
	usfedgov: 'USFedGov',
	uswds: 'USWDS',
	vbo: 'VBO',
	xml: 'XML',
	xmlsitemap: 'XMLSitemap'
};

/** the label a reader recognises, derived rather than stored twice */
export function labelFor(name: string): string {
	const machine = name.split('/')[1] ?? name;
	return machine
		.split('_')
		.map((part) => WORD_CASING[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

/**
 * Every classified module as a row.
 *
 * `blocked` comes from the classifier, never from this file, so a capability change moves the table
 * without anyone editing it. `verified` is the only state that needs evidence recorded by hand,
 * because only a test run can establish it.
 */
export function moduleTable(
	capabilities = SHIPPED_CAPABILITIES,
	verified: Readonly<Record<string, string>> = VERIFIED_BEHAVIOURS,
	capabilityEvidence: Readonly<Record<string, string>> = CAPABILITY_EVIDENCE
): TableRow[] {
	const names = new Set([
		...Object.keys(MODULE_TIER_NOTES),
		...Object.keys(KNOWN_MODULE_CAPABILITIES)
	]);
	const rows: TableRow[] = [];
	for (const name of [...names].sort()) {
		const verdict = tierFor(name, capabilities);
		const note = MODULE_TIER_NOTES[name];
		let state: SupportState;
		let evidence: string;

		if (name in verified) {
			state = 'verified';
			// the fixture clause is appended rather than written into each entry, so a row gains or
			// loses it by moving in or out of the shipping pack
			evidence =
				(verified[name] as string) +
				(SHIPPING_PACK_CONTRIB.includes(name) ? '' : FIXTURE_CLAUSE);
		} else if (verdict.tier === 'refused') {
			state = 'blocked';
			evidence = verdict.reason ?? note?.why ?? 'refused by the capability model';
		} else if (verdict.tier === 'unknown') {
			// an unclassified module is not a support claim at all, so it stays out of the table
			continue;
		} else {
			state = 'untested';
			evidence =
				capabilityEvidence[name] ??
				note?.why ??
				verdict.reason ??
				'not enabled here; nothing has been asserted about it';
		}
		rows.push({ name, label: labelFor(name), state, evidence });
	}
	return rows;
}

/** `blocked` rows carry the lift, because a refusal without a route out is a shrug */
export function liftFor(name: string): string | null {
	return MODULE_TIER_NOTES[name]?.lift ?? null;
}
