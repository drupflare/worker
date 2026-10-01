import {
	ADMIN_COMMANDS_ERROR_HTML,
	ADMIN_COMMANDS_HTML,
	ADMIN_COMMANDS_RESULT_HTML,
	ADMIN_COMMANDS_ROW_HTML
} from '../../site/generated/assets';
import { escapeHtml, fill, pill, SURFACE_PREFIX } from './shell';

/**
 * One operation `/__ops` knows about.
 *
 * `driver` is absent where nothing can run it yet, so the list does not imply `cex` and `cim`
 * work like `cr`.
 */
export type OpsEntry = { op: string; label: string; driver?: string; cost?: string };

/** what a typed command resolved to, or why it did not resolve */
export type DrushCommand =
	| { kind: 'run'; route: string; params: Record<string, string> }
	| { kind: 'error'; message: string };

/**
 * Every Drush spelling, mapped to the operation this site registers.
 *
 * Mirrors `CommandLine::DRUSH_ALIASES` in the sibling module (`tests/node/drush-aliases.spec.ts`
 * fails on divergence). `/__ops` matches operation names exactly and does not canonicalise.
 */
export const DRUSH_ALIASES: Readonly<Record<string, string>> = {
	cr: 'cr',
	'cache:rebuild': 'cr',
	'cache-rebuild': 'cr',
	rebuild: 'cr',
	cc: 'cr',
	'cache:clear': 'cr',
	updb: 'updb',
	updatedb: 'updb',
	'updatedb:status': 'updb',
	cex: 'cex',
	'config:export': 'cex',
	'config-export': 'cex',
	cim: 'cim',
	'config:import': 'cim',
	'config-import': 'cim',
	en: 'en',
	'pm:install': 'en',
	'pm-enable': 'en',
	'pm:enable': 'en',
	'theme:enable': 'en',
	pmu: 'pmu',
	'pm:uninstall': 'pmu',
	'pm-uninstall': 'pmu',
	'theme:uninstall': 'pmu',
	status: 'status',
	'core:status': 'status',
	'core-status': 'status',
	st: 'status',
	'sql-dump': 'sql-dump',
	'sql:dump': 'sql-dump',
	'core:requirements': 'requirements',
	requirements: 'requirements',
	'state:get': 'state-get',
	'state-get': 'state-get',
	sget: 'state-get',
	'state:set': 'state-set',
	'state-set': 'state-set',
	sset: 'state-set',
	'config:get': 'config-get',
	'config-get': 'config-get',
	cget: 'config-get',
	'config:set': 'config-set',
	'config-set': 'config-set',
	cset: 'config-set',
	'role:list': 'role-list',
	'role-list': 'role-list',
	rls: 'role-list',
	'user:information': 'user-info',
	'user-info': 'user-info',
	uinf: 'user-info',
	'watchdog:show': 'watchdog-show',
	'watchdog-show': 'watchdog-show',
	'wd-show': 'watchdog-show',
	ws: 'watchdog-show',
	'queue:list': 'queue-list',
	'queue-list': 'queue-list',
	'queue-drain': 'queue-drain',
	'advancedqueue:queue:process': 'queue-drain',
	aqp: 'queue-drain',
	'config-write': 'config-write',
	'cache:clear-bin': 'cache-clear',
	'cache-clear': 'cache-clear'
};

/**
 * Turns what an operator typed into the route that already serves it.
 *
 * `/__ops` takes an operation name and nothing else, so `en webform` routes to the module-install
 * route instead. An operation given arguments it cannot take is refused by name, not truncated to
 * its first word.
 */
export function parseDrush(input?: string): DrushCommand | undefined {
	const words = String(input ?? '')
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	const typed = words[0];
	if (typed === undefined) return undefined;
	const head = DRUSH_ALIASES[typed] ?? typed;

	const flags = words.filter((w) => w.startsWith('-'));
	const rest = words.slice(1).filter((w) => !w.startsWith('-'));

	// `en` is the one operation with an argument, and it has a route of its own that installs;
	// the registry entry is sliced and refuses
	if (head === 'en') {
		const module = rest[0];
		if (module === undefined) {
			return {
				kind: 'error',
				message: `${typed} needs a module name, as in \`${typed} webform\``
			};
		}
		if (rest.length > 1) {
			return {
				kind: 'error',
				message: `${typed} takes one module at a time; got ${rest.length}`
			};
		}
		return {
			kind: 'run',
			route: '/__enable',
			params: { module, ...(flags.includes('--dry') ? { dry: '1' } : {}) }
		};
	}

	if (rest.length > 0) {
		return {
			kind: 'error',
			message: `${typed} takes no arguments; \`${rest.join(' ')}\` was not understood`
		};
	}
	return { kind: 'run', route: '/__ops', params: { op: head } };
}

/**
 * A Drush-shaped command field over `/__ops`.
 *
 * The operations are the ones the object registers. One with no driver renders disabled and says
 * why, rather than being offered and failing.
 */
export function renderCommands(
	entries: readonly OpsEntry[],
	result?: string,
	submitted?: string,
	error?: string
): string {
	const rows = entries
		.map((e) =>
			fill(ADMIN_COMMANDS_ROW_HTML, {
				OP: escapeHtml(e.op),
				LABEL: escapeHtml(e.label),
				DRIVER: e.driver
					? `${pill('ok')} <span class="dim">${escapeHtml(e.driver)}</span>`
					: `${pill('none')} <span class="over">no driver exists yet</span>`,
				COST: escapeHtml(e.cost ?? '')
			})
		)
		.join('');
	const runnable = entries.filter((e) => e.driver !== undefined).length;

	return fill(ADMIN_COMMANDS_HTML, {
		RUNNABLE: escapeHtml(String(runnable)),
		TOTAL: escapeHtml(String(entries.length)),
		ACTION: `${SURFACE_PREFIX}/commands`,
		SUBMITTED: escapeHtml(submitted ?? ''),
		ERROR: error ? fill(ADMIN_COMMANDS_ERROR_HTML, { MESSAGE: escapeHtml(error) }) : '',
		RESULT: result ? fill(ADMIN_COMMANDS_RESULT_HTML, { OUTPUT: escapeHtml(result) }) : '',
		ROWS: rows
	});
}
