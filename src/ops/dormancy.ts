/**
 * The dormancy audit: every capability the artifact carries is ACTIVE or DORMANT-BY-DESIGN.
 *
 * **THE FAILURE CLASS THIS EXISTS TO MAKE UNSHIPPABLE.** Three defects found in this project were
 * identical in shape, and each one wasted a session:
 *
 *   - `node` installed with zero `node.type.*`, so every save was refused
 *   - the cron driver built and wired with nothing turning it on, so six modules did nothing
 *   - `pathauto` enabled and discoverable with zero `pathauto.pattern.*`, so no alias was ever made
 *
 * Each is a capability PRESENT in the artifact with the configuration that ACTIVATES it ABSENT, and
 * each fails by doing nothing: no exception, no log line, no failing test. The operator concludes
 * the feature does not work rather than that it was never switched on.
 *
 * **THERE ARE EXACTLY TWO LEGAL STATES, AND THE FORCED CHOICE IS THE POINT.** "Pathauto ships
 * without patterns" is a perfectly good product decision -- a pattern is a site owner's editorial
 * choice and guessing one is worse than none. What is not defensible is that nobody had decided.
 * A capability that is neither active nor deliberately dormant is the bug, and the audit names it.
 */

/** what the audit concluded about one capability */
export type DormancyState = 'active' | 'dormant-by-design' | 'undecided';

export interface Capability {
	/** the module or runtime feature */
	id: string;
	/** what a reader calls it */
	label: string;
	/**
	 * The config that turns it on, as a `LIKE` prefix over `config.name`.
	 *
	 * Null means the capability needs no configuration to function -- a field type, a cache layer, a
	 * UI module. Those are still enumerated, because "needs nothing" is itself a decision that
	 * should be written down rather than inferred from an absent entry.
	 */
	activatedBy: string | null;
	/** what the project INTENDS; the audit compares this against what is actually there */
	posture: 'must-be-active' | 'dormant-by-design' | 'no-activation-needed';
	/** required whenever the posture is `dormant-by-design`; this is the decision being recorded */
	reason?: string;
	/** what an operator would have to do to activate it, shown on the ops surface */
	toActivate?: string;
}

/**
 * Every installed module, plus the runtime capabilities.
 *
 * Derived from `core.extension` in the shipped `assets/drupal/site.sqlite` (42 modules) rather than
 * from memory. `dormancy.spec.ts` reads that list back out of the artifact and fails when a module
 * appears there without an entry here, so a module added to the pack cannot skip the decision.
 */
export const CAPABILITIES: readonly Capability[] = [
	// #region content, and the ones that have bitten
	{
		id: 'node',
		label: 'Content types',
		activatedBy: 'node.type.',
		posture: 'must-be-active',
		toActivate: 'a recipe such as core/recipes/page_content_type'
	},
	{
		id: 'pathauto',
		label: 'Pathauto',
		activatedBy: 'pathauto.pattern.',
		posture: 'dormant-by-design',
		reason: 'a URL pattern is a site owner editorial choice and guessing one is worse than none. Pathauto installs, reports success and generates nothing until a pattern exists -- which is correct, and is exactly the sentence an operator needs to be told',
		toActivate: 'add a pathauto pattern at /admin/config/search/path/patterns'
	},
	{
		id: 'taxonomy',
		label: 'Taxonomy',
		activatedBy: 'taxonomy.vocabulary.',
		posture: 'must-be-active'
	},
	{ id: 'media', label: 'Media', activatedBy: 'media.type.', posture: 'must-be-active' },
	{ id: 'views', label: 'Views', activatedBy: 'views.view.', posture: 'must-be-active' },
	{ id: 'image', label: 'Image styles', activatedBy: 'image.style.', posture: 'must-be-active' },
	{
		id: 'filter',
		label: 'Text formats',
		activatedBy: 'filter.format.',
		posture: 'must-be-active'
	},
	{ id: 'block', label: 'Blocks', activatedBy: 'block.block.', posture: 'must-be-active' },
	{ id: 'user', label: 'Roles', activatedBy: 'user.role.', posture: 'must-be-active' },
	{ id: 'field', label: 'Fields', activatedBy: 'field.field.', posture: 'must-be-active' },
	{
		id: 'editor',
		label: 'Text editors',
		activatedBy: 'editor.editor.',
		posture: 'must-be-active'
	},
	{
		id: 'block_content',
		label: 'Custom block types',
		activatedBy: 'block_content.type.',
		posture: 'must-be-active'
	},
	{
		id: 'menu_ui',
		label: 'Menus',
		activatedBy: 'system.menu.',
		posture: 'must-be-active'
	},
	// #endregion

	// #region found dormant by this audit
	{
		id: 'layout_builder',
		label: 'Layout Builder',
		// activation is a third-party setting inside a view display rather than its own config
		// object, so the probe is a substring search rather than a name prefix
		activatedBy: null,
		posture: 'dormant-by-design',
		reason: 'installed and enabled on ZERO entity view displays -- measured: no `core.entity_view_display.*` mentions it. Layout Builder does nothing until an owner turns it on per bundle, and turning it on for them would override the display configuration the pack ships',
		toActivate: 'enable Layout Builder for a bundle at its Manage display tab'
	},
	{
		id: 'announcements_feed',
		label: 'Announcements',
		activatedBy: null,
		posture: 'dormant-by-design',
		reason: 'fetches announcements from drupal.org over HTTP. Outbound here is deferred and prefetch-only, and nothing primes this feed, so it will show nothing rather than fail',
		toActivate: 'uninstall it, or accept an empty announcements list'
	},
	{
		id: 'automated_cron',
		label: 'Automated cron',
		activatedBy: null,
		posture: 'dormant-by-design',
		reason: 'cron is driven by the Durable Object alarm through `driveCron()`, which is sliced and budgeted. Drupal core automated_cron runs `drupal_cron()` INLINE on a visitor request instead -- 187 queries and hooks that reach for sockets this runtime lacks -- so it must be off',
		toActivate: 'nothing; it should stay off. See the audit note about interval 10800'
	},
	// #endregion

	// #region runtime capabilities rather than modules
	{
		id: 'runtime:cron',
		label: 'Drupal cron (alarm-driven)',
		activatedBy: null,
		posture: 'must-be-active',
		toActivate: 'DRUPAL_CRON defaults on; set DRUPAL_CRON=0 only to disable it'
	},
	{
		id: 'runtime:deferred-outbound',
		label: 'Deferred outbound HTTP',
		activatedBy: null,
		posture: 'must-be-active',
		toActivate: 'the queue, alarm drain and response cache all ship'
	},
	{
		id: 'runtime:blocking-outbound',
		label: 'Blocking outbound HTTP',
		activatedBy: null,
		posture: 'dormant-by-design',
		reason: 'the shipping binary is ASYNCIFY=0, so PHP cannot suspend mid-run to wait for a socket. This is a build property, not a setting',
		toActivate: 'a JSPI or Asyncify build; priced and deferred'
	}
	// #endregion
];

/**
 * Modules that function with no activation configuration at all.
 *
 * Enumerated rather than defaulted, because "this one needs nothing" is a decision too. A module
 * absent from BOTH this list and `CAPABILITIES` is what the audit refuses.
 */
export const NO_ACTIVATION_NEEDED: readonly string[] = [
	'big_pipe',
	'breakpoint',
	'ckeditor5',
	'claro',
	'config',
	'contextual',
	'datetime',
	'dblog',
	// the compatibility layer itself, and it needs no configuration because it activates by being
	// installed: DrupflareServiceProvider runs on every container build, and the mail plugin, the
	// logger channel, the image toolkit and the stream wrapper are all wired by service definition
	'drupflare',
	'dynamic_page_cache',
	'field_ui',
	'file',
	'help',
	'layout_discovery',
	'link',
	'menu_link_content',
	'navigation',
	'olivero',
	'options',
	'page_cache',
	'path',
	'path_alias',
	'sqlite',
	'standard',
	'system',
	'text',
	'update',
	'views_ui'
];

export interface AuditRow {
	id: string;
	label: string;
	state: DormancyState;
	/** how many matching config objects were found, when the capability has a config probe */
	found: number;
	detail: string;
	toActivate?: string | undefined;
}

/**
 * Audits the shipped configuration.
 *
 * @param configNames every `config.name` in the artifact
 * @param present ids whose activation cannot be expressed as a config prefix, decided by the caller
 */
export function auditDormancy(
	configNames: readonly string[],
	present: Readonly<Record<string, boolean>> = {},
	capabilities: readonly Capability[] = CAPABILITIES
): AuditRow[] {
	return capabilities.map((cap) => {
		const found =
			cap.activatedBy === null
				? present[cap.id] === true
					? 1
					: 0
				: configNames.filter((n) => n.startsWith(cap.activatedBy as string)).length;

		let state: DormancyState;
		let detail: string;
		if (found > 0) {
			state = 'active';
			detail =
				cap.activatedBy === null
					? 'present'
					: `${found} ${cap.activatedBy}* object(s) ship`;
		} else if (cap.posture === 'dormant-by-design') {
			state = 'dormant-by-design';
			detail = cap.reason ?? 'recorded as deliberately dormant';
		} else if (cap.posture === 'no-activation-needed') {
			state = 'active';
			detail = 'needs no activation configuration';
		} else {
			// the bug: intended to be active, and nothing activates it
			state = 'undecided';
			detail =
				cap.activatedBy === null
					? `${cap.id} is expected to be active and nothing reports it as present`
					: `${cap.id} is expected to be active and NO ${cap.activatedBy}* object ships, so it will install and silently do nothing`;
		}
		return { id: cap.id, label: cap.label, state, found, detail, toActivate: cap.toActivate };
	});
}

/** the rows an operator should be shown: what is installed and will do nothing until configured */
export function dormantSummary(rows: readonly AuditRow[]): string[] {
	return rows
		.filter((r) => r.state === 'dormant-by-design')
		.map((r) =>
			`${r.label} is installed and will do nothing until configured. ${r.toActivate ?? ''}`.trim()
		);
}
