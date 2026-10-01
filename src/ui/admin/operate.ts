import {
	ADMIN_OPERATE_HTML,
	ADMIN_OPERATE_JS,
	ADMIN_OPERATE_ROW_HTML
} from '../../site/generated/assets';
import { escapeHtml, fill, LOGIN_PATH, pill } from './shell';

/** one owner action, and what pressing it actually does */
export interface OperateAction {
	/** the owner route, as the front worker maps it */
	path: string;
	label: string;
	/** what it does, in one sentence a site owner can act on */
	detail: string;
	/** extra query the button sends, e.g. `action=run` */
	query?: string;
	/** true when it changes the site, which is what earns a confirmation */
	writes: boolean;
}

/**
 * Every owner route the Operate page puts a button on.
 *
 * `/pitr` and `/restore` otherwise need `PW_DIAGNOSTICS=1`, the flag that opens arbitrary SQL.
 * The list is data so the page and its test read the same thing.
 */
export const OPERATE_ACTIONS: readonly OperateAction[] = [
	{
		path: '/health',
		label: 'Check Health',
		detail: 'the ledger, the circuit breaker and whether anything quarantined this site',
		writes: false
	},
	{
		path: '/serve-stats',
		label: 'Serving Stats',
		detail: 'cached paths, queue depth, recycles and the day’s row and request spend',
		writes: false
	},
	{
		path: '/sweep',
		label: 'Sweep Coverage',
		detail: 'how much of the site is pre-rendered, and what bounded the last step',
		writes: false
	},
	{
		path: '/sweep',
		label: 'Sweep Now',
		detail: 'take one addressable-sweep step immediately rather than waiting for the interval',
		query: 'run=1',
		writes: true
	},
	{
		path: '/reconcile',
		label: 'Reconcile',
		detail: 'what this site still owes the shipping pack, and one step of paying it',
		query: 'action=run',
		writes: true
	},
	{
		path: '/updb',
		label: 'Database Updates',
		detail: 'what the pending-update chain is doing, and which units have run',
		writes: false
	},
	{
		path: '/updb',
		label: 'Start Update Run',
		detail: 'raise the maintenance fence, snapshot the bookkeeping and plan the units',
		query: 'action=prepare',
		writes: true
	},
	{
		path: '/updb',
		label: 'Advance One Beat',
		detail: 'drive one beat of the pending-update chain and report the phase',
		query: 'action=run',
		writes: true
	},
	{
		path: '/updb',
		label: 'Roll Back Update Run',
		detail: 'restore the bookkeeping a halted run snapshotted; content tables are the R2 export',
		query: 'action=rollback',
		writes: true
	},
	{
		path: '/invalidate',
		label: 'Purge Everything',
		detail: 'invalidate every cached page; they regenerate as visitors ask for them',
		writes: true
	},
	{
		path: '/bump',
		label: 'Bump Generation',
		detail: 'retire every stored page and edge entry at once, which is the wider hammer',
		writes: true
	},
	{
		path: '/armfill',
		label: 'Wake The Fill Chain',
		detail: 'restart regeneration on a site whose alarm chain has stopped',
		writes: true
	},
	{
		path: '/migrate',
		label: 'Replay The Pack',
		detail: 'replay the packed database from where the cursor stopped',
		writes: true
	},
	{
		path: '/pitr',
		label: 'Recovery Points',
		detail: 'the platform’s own 30-day bookmark window; there is no dashboard button for this',
		writes: false
	},
	// a queue deeper than a batch resets the isolate in the alarm (103 entries, free worker)
	{
		path: '/queue',
		label: 'Fill Queue',
		detail: 'what is waiting to be regenerated, and which paths have spent their retries',
		writes: false
	},
	{
		path: '/queue',
		label: 'Drop The Queue',
		detail: 'empty the fill queue; a queue too deep to drain resets the object on every alarm, and this is the only way out',
		query: 'action=drop',
		writes: true
	},
	{
		path: '/setup/mail',
		label: 'Mail Setup',
		detail: 'which step sending is waiting on, and whether the connected token can see enough to tell',
		writes: false
	},
	{
		path: '/setup/mail',
		label: 'Apply Mail DNS',
		detail: 'create the sending subdomain and write the SPF and DKIM records this site needs',
		query: 'action=apply',
		writes: true
	}
];

/**
 * The Operate surface.
 *
 * Reads print what came back; writes confirm first, then print. Nothing is behind a flag.
 */
export function renderOperate(): string {
	const row = (a: OperateAction, i: number): string =>
		fill(ADMIN_OPERATE_ROW_HTML, {
			LABEL: escapeHtml(a.label),
			PATH: escapeHtml(a.path),
			DETAIL: escapeHtml(a.detail),
			EFFECT: a.writes ? `${pill('warn')} writes` : `${pill('ok')} read only`,
			INDEX: String(i),
			QUERY: escapeHtml(a.query ?? ''),
			WRITES: a.writes ? '1' : '0'
		});

	return fill(ADMIN_OPERATE_HTML, {
		ROWS: OPERATE_ACTIONS.map(row).join(''),
		SCRIPT: fill(ADMIN_OPERATE_JS, { LOGIN_PATH })
	});
}
