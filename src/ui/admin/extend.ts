import { isPaid, type PlanEnv } from '../../ops/plan';
import {
	ADMIN_EXTEND_ACTIONS_HTML,
	ADMIN_EXTEND_EMPTY_HTML,
	ADMIN_EXTEND_HTML,
	ADMIN_EXTEND_INSTALL_WARNING_HTML,
	ADMIN_EXTEND_JS,
	ADMIN_EXTEND_NOTE_HTML,
	ADMIN_EXTEND_ROW_HTML
} from '../../site/generated/assets';
import { escapeHtml, fill, pill, SURFACE_PREFIX } from './shell';

/** one row in the installable list */
export type ExtendEntry = {
	name: string;
	version?: string;
	verdict?: 'installable' | 'blocked' | 'unverifiable' | 'not-found';
	reason?: string;
};

/** the Extend page: a package-name field resolved through `/installable` (versions and verdict) */
export function renderExtend(
	query: string | undefined,
	entries: readonly ExtendEntry[],
	note: string | undefined,
	env?: PlanEnv
): string {
	const rows = entries.length
		? entries
				.map((e) => {
					const installable = e.verdict === 'installable' || e.verdict === 'unverifiable';
					return fill(ADMIN_EXTEND_ROW_HTML, {
						NAME: escapeHtml(e.name),
						VERSION: escapeHtml(e.version ?? '-'),
						PILL: pill(
							e.verdict === 'installable'
								? 'ok'
								: e.verdict === 'blocked' || e.verdict === 'not-found'
									? 'over'
									: 'warn'
						),
						VERDICT: escapeHtml(e.verdict ?? 'unknown'),
						REASON: escapeHtml(e.reason ?? ''),
						ACTIONS: installable
							? fill(ADMIN_EXTEND_ACTIONS_HTML, {
									NAME: escapeHtml(e.name),
									FORCE: e.verdict === 'unverifiable' ? ' data-force="1"' : ''
								})
							: '<span class="dim">-</span>'
					});
				})
				.join('')
		: ADMIN_EXTEND_EMPTY_HTML.trimEnd();

	return fill(ADMIN_EXTEND_HTML, {
		ACTION: `${SURFACE_PREFIX}/extend`,
		QUERY: escapeHtml(query ?? ''),
		NOTE: note ? fill(ADMIN_EXTEND_NOTE_HTML, { NOTE: escapeHtml(note) }) : '',
		INSTALL: isPaid(env) ? '' : ADMIN_EXTEND_INSTALL_WARNING_HTML.trimEnd(),
		ROWS: rows,
		SCRIPT: ADMIN_EXTEND_JS.trimEnd()
	});
}
