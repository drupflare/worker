/**
 * The dormancy audit: every capability the artifact carries is active or dormant by design.
 *
 * A capability present without the configuration that activates it fails silently (`node` with
 * no `node.type.*`, `pathauto` with no pattern). Shipping one dormant is a fine decision; leaving
 * it undecided is the bug the audit names.
 * @module
 */

/** what the audit concluded about one capability */
export type DormancyState = 'active' | 'dormant-by-design' | 'undecided';

/** one capability and the decision recorded about it */
export interface Capability {
	/** the module or runtime feature */
	id: string;
	/** what a reader calls it */
	label: string;
	/** the config that turns it on, as a `LIKE` prefix over `config.name`; null needs none */
	activatedBy: string | null;
	/** what the project intends; the audit compares it against what is there */
	posture: 'must-be-active' | 'dormant-by-design' | 'no-activation-needed';
	/** required whenever the posture is `dormant-by-design`; this is the decision being recorded */
	reason?: string;
	/** what an operator would have to do to activate it, shown on the ops surface */
	toActivate?: string;
}

/**
 * Every installed module, plus the runtime capabilities.
 *
 * Derived from `core.extension` in the shipped database; `dormancy.spec.ts` fails when a module
 * appears there without an entry here.
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
		// activation is a third-party setting inside a view display, not its own config object
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
 * Modules that function with no activation configuration. A module absent from both this list and
 * `CAPABILITIES` is what the audit refuses.
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
	// activates by being installed (`DrupflareServiceProvider` wires it by service definition)
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

/** one capability's audit result */
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
			detail = cap.reason ?? 'recorded as dormant by design';
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
