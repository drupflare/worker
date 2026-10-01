/**
 * The module support table, emitted from the classifier rather than hand-written.
 *
 * `tests/node/module-table.spec.ts` compares these rows against README.md's three lists in both
 * directions. Three states, and only `verified` is a support claim: nothing reaches it except a
 * gated enable-and-assert run, and no path here promotes a module on analysis alone.
 * @module
 */
import { KNOWN_MODULE_CAPABILITIES, SHIPPED_CAPABILITIES, tierFor } from './catalog';
import {
	GENERATED_CAPABILITY_EVIDENCE,
	GENERATED_SHIPPING_CONTRIB,
	GENERATED_VERIFIED
} from './generated/modules';
import { MODULE_TIER_NOTES } from './module-tiers';

/**
 * A module's support state.
 *
 * - `verified`: the gate enabled it on a real site and asserted something it does happened
 * - `untested`: never enabled here; the capability analysis is an inference, not an observation
 * - `blocked`: cannot work, with the mechanism and what would lift it
 */
export type SupportState = 'verified' | 'untested' | 'blocked';

/** the same three as a value, so a test can pin the vocabulary rather than today's census */
export const MODULE_STATES: readonly SupportState[] = ['verified', 'untested', 'blocked'];

/**
 * The contrib modules the shipping pack carries; the rest of `modules/contrib` is a QA fixture
 * (`PACK_CONTRIB=1` in `scripts/pack-drupal.ts`).
 * A `verified` row outside this list was established against a fixture build. The spec reads
 * `assets/drupal-pf/core.pf.json` and fails if this list and the artifact disagree.
 */
export const SHIPPING_PACK_CONTRIB: readonly string[] = GENERATED_SHIPPING_CONTRIB;

/** the clause every fixture-verified row carries; a row gains it by leaving the shipping pack */
export const FIXTURE_CLAUSE =
	'. Required as a dev dependency and verified against the test build rather than shipped, so a ' +
	'site does not carry it unless it asks for it';

/**
 * Modules whose behaviour the gate has asserted, with what was asserted.
 * Absent configuration is a fixture gap a test can fill (a `pathauto` pattern is a config entity
 * the test creates); absent code is not.
 */
export const VERIFIED_BEHAVIOURS: Readonly<Record<string, string>> = GENERATED_VERIFIED;

/** modules whose capability the gate exercised end to end while the module itself is absent */
export const CAPABILITY_EVIDENCE: Readonly<Record<string, string>> = GENERATED_CAPABILITY_EVIDENCE;

/** one row of the support table */
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
 * Words a machine name spells lowercase and a reader does not, matched per snake_case part so one
 * entry fixes `jquery_ui` and `jquery_ui_datepicker` alike (plain capitalising gives `Jquery Ui`).
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

/** the label a reader recognises, derived from the composer name */
export function labelFor(name: string): string {
	const machine = name.split('/')[1] ?? name;
	return machine
		.split('_')
		.map((part) => WORD_CASING[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

/**
 * Every classified module as a row.
 * `blocked` comes from the classifier, so a capability change moves the table; only `verified`
 * needs hand-recorded evidence.
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
			// the fixture clause is appended, not stored per entry
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

/** what would lift a `blocked` row, if recorded */
export function liftFor(name: string): string | undefined {
	return MODULE_TIER_NOTES[name]?.lift;
}
