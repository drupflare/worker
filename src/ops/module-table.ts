import { KNOWN_MODULE_CAPABILITIES, SHIPPED_CAPABILITIES, tierFor } from './catalog.js';
import { MODULE_TIER_NOTES } from './module-tiers.js';

/**
 * The module support table, EMITTED from the classifier rather than hand-written.
 *
 * A hand-maintained README table goes stale the first time a tier moves, and it goes stale silently
 * because nothing compares it to anything. `tests/node/module-table.spec.ts` renders these rows and
 * fails when README.md disagrees -- the same discipline as the driver-pack byte-for-byte check.
 *
 * **THREE STATES, AND THE DIFFERENCE BETWEEN THE FIRST TWO IS EVIDENCE.**
 *
 *   - `verified`  the gate enabled it against a real site and asserted it FUNCTIONS. Not that the
 *                 installer returned ok; that a thing the module does actually happened.
 *   - `supported` classified as workable by capability analysis, not yet exercised. This is a
 *                 reasoned claim, and saying so is the point.
 *   - `blocked`   cannot work, with the mechanism and what would lift it.
 */
export type SupportState = 'verified' | 'supported' | 'blocked';

/**
 * Modules whose BEHAVIOUR the gate has asserted, with what was asserted.
 *
 * **The instrument limit is gone; two modules are verified and two are not, for a reason that has
 * nothing to do with memory.**
 *
 * Under `wrangler dev` an enable killed the host process, so no follow-up request could be made and
 * nothing could be verified. Re-run under `@cloudflare/vitest-pool-workers` that limit does not
 * exist: an enable survives, a follow-up request answers, and TWO enables in one object survive --
 * the exact case that killed wrangler dev hardest. The failure was miniflare's proxy controller, a
 * component that only exists locally, and suspecting the instrument first was right.
 *
 * What that leaves is a configuration gap rather than a runtime one:
 *
 *   - `admin_toolbar` and `ctools` are verified, with what was asserted recorded above.
 *   - `pathauto` enables cleanly and has NOTHING TO APPLY: no `pathauto.pattern.*` config ships, so
 *     a node save produces no alias. Installed, `ok: true`, and silently inert.
 *   - `token` is unverifiable for the same reason. Its behaviour is token replacement, and the only
 *     observable on this site would have been the alias pathauto did not generate.
 *
 * A deploy would not change any of this: the blocker is absent config, not the memory envelope, so
 * it would reproduce identically on real infrastructure.
 */
export const VERIFIED_BEHAVIOURS: Readonly<Record<string, string>> = {
	'drupal/admin_toolbar':
		'enabled against a real site in the workers lane; its own routes appear in the `router` table after the install-triggered rebuild',
	'drupal/ctools':
		'enabled against a real site in the workers lane; `core.extension` grew and the site still saved content afterwards. A library module with no user-visible behaviour of its own, so this is the strongest observable it has'
};

export interface TableRow {
	/** composer name */
	name: string;
	/** the short name a reader recognises */
	label: string;
	state: SupportState;
	/** what the gate asserted, for `verified`; what the analysis concluded, otherwise */
	evidence: string;
}

/** the label a reader recognises, derived rather than stored twice */
export function labelFor(name: string): string {
	const machine = name.split('/')[1] ?? name;
	return machine
		.split('_')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
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
	verified: Readonly<Record<string, string>> = VERIFIED_BEHAVIOURS
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
			evidence = verified[name] as string;
		} else if (verdict.tier === 'refused') {
			state = 'blocked';
			evidence = verdict.reason ?? note?.why ?? 'refused by the capability model';
		} else if (verdict.tier === 'unknown') {
			// an unclassified module is not a support claim at all, so it stays out of the table
			continue;
		} else {
			state = 'supported';
			evidence = note?.why ?? verdict.reason ?? 'classified as workable, not yet exercised';
		}
		rows.push({ name, label: labelFor(name), state, evidence });
	}
	return rows;
}

/** `blocked` rows carry the lift, because a refusal without a route out is a shrug */
export function liftFor(name: string): string | null {
	return MODULE_TIER_NOTES[name]?.lift ?? null;
}

/** one markdown cell, with the pipe escaped so a reason cannot break the table */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * The README table, rendered.
 *
 * Emitted with a marker pair around it so the drift test can find exactly the region it owns and a
 * human can see where the generated part starts and stops.
 */
export const TABLE_BEGIN = '<!-- module-table:begin -->';
export const TABLE_END = '<!-- module-table:end -->';

export function renderModuleTable(rows: TableRow[] = moduleTable()): string {
	const counts = {
		verified: rows.filter((r) => r.state === 'verified').length,
		supported: rows.filter((r) => r.state === 'supported').length,
		blocked: rows.filter((r) => r.state === 'blocked').length
	};

	const body = rows.map((row) => {
		const lift = row.state === 'blocked' ? liftFor(row.name) : null;
		return [
			cell(row.label),
			row.state,
			`${cell(row.evidence)}${lift ? ` **Lift:** ${cell(lift)}` : ''}`
		];
	});

	// Padded to the widest cell per column, which is exactly what prettier does to a markdown
	// table. Emitting the unpadded form instead makes prettier rewrite the block on every run and
	// the drift test then fails against its own generator rather than against a real change.
	const header = ['Module', 'State', 'Evidence'];
	const widths = header.map((h, i) =>
		Math.max(h.length, ...body.map((r) => (r[i] ?? '').length))
	);
	const line = (cells: readonly string[]) =>
		`| ${cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join(' | ')} |`;
	const rule = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`;

	return [
		TABLE_BEGIN,
		'',
		`**${counts.verified} verified, ${counts.supported} supported, ${counts.blocked} blocked.** ` +
			'Verified means the gate enabled the module and asserted it functions. Supported means the ' +
			'capability analysis says it works and nothing has exercised it yet.',
		'',
		line(header),
		rule,
		...body.map(line),
		'',
		TABLE_END
	].join('\n');
}
