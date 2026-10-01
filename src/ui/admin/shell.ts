import { isPaid, type PlanEnv } from '../../ops/plan';
import {
	ADMIN_ERROR_CARD_HTML,
	ADMIN_LOGIN_HTML,
	ADMIN_LOGIN_NAV_HTML,
	ADMIN_NAV_TAIL_HTML,
	ADMIN_PAGE_HTML,
	ADMIN_SHELL_CSS
} from '../../site/generated/assets';
import { renderTemplate } from '../../util/template';

/**
 * Escapes text for HTML text nodes and quoted attributes alike.
 * A displayed `__CFW_` gets an entity underscore so it is not read as a template token.
 */
export function escapeHtml(value: unknown): string {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
		.replace(/__CFW_/g, '__CFW&#95;');
}

/** fills an admin asset and drops the newline its file ends with, which the page text never had */
export function fill(asset: string, vars: Readonly<Record<string, string>>): string {
	return renderTemplate(asset, vars).trimEnd();
}

/** the seven surfaces */
export type AdminPage =
	'thresholds' | 'extend' | 'commands' | 'operate' | 'deploy' | 'git' | 'access';

/**
 * The prefix every product surface lives under.
 *
 * Not `/admin`, which is Drupal core's own dashboard. Drupal owns the URL space, so anything this
 * Worker claims has to be somewhere Drupal will not generate.
 */
export const SURFACE_PREFIX = '/_cfw';

/** where a browser exchanges the owner token for a session cookie */
export const LOGIN_PATH = `${SURFACE_PREFIX}/login`;

/** where a browser gives the session cookie back */
export const LOGOUT_PATH = `${SURFACE_PREFIX}/logout`;

/** every page, with the path that renders it */
export const ADMIN_PAGES: readonly { page: AdminPage; path: string; label: string }[] = [
	{ page: 'thresholds', path: SURFACE_PREFIX, label: 'Limits' },
	{ page: 'extend', path: `${SURFACE_PREFIX}/extend`, label: 'Extend' },
	{ page: 'commands', path: `${SURFACE_PREFIX}/commands`, label: 'Commands' },
	{ page: 'operate', path: `${SURFACE_PREFIX}/operate`, label: 'Operate' },
	{ page: 'deploy', path: `${SURFACE_PREFIX}/deploy`, label: 'Deploy' },
	{ page: 'git', path: `${SURFACE_PREFIX}/git`, label: 'Git' },
	{ page: 'access', path: `${SURFACE_PREFIX}/access`, label: 'Access' }
] as const;

/** the head and body wrapper both the shell and the sign-in page use */
function page(title: string, nav: string, body: string): string {
	return fill(ADMIN_PAGE_HTML, {
		TITLE: escapeHtml(title),
		STYLE: ADMIN_SHELL_CSS.trimEnd(),
		NAV: nav,
		BODY: body
	});
}

/** wraps already-escaped body HTML in the shell; `current` marks the active nav item */
export function renderShell(current: AdminPage, body: string, env?: PlanEnv): string {
	const nav = ADMIN_PAGES.map(
		(p) =>
			`<a href="${escapeHtml(p.path)}"${p.page === current ? ' aria-current="page"' : ''}>${escapeHtml(p.label)}</a>`
	).join('');
	const plan = isPaid(env) ? 'paid' : 'free';
	return page(
		ADMIN_PAGES.find((p) => p.page === current)?.label ?? 'Admin',
		nav + fill(ADMIN_NAV_TAIL_HTML, { PLAN: escapeHtml(plan), LOGOUT_PATH }),
		body
	);
}

/**
 * The sign-in page.
 *
 * A form POST, because a browser cannot put a header on its own navigation. It takes the owner
 * token minted by `/firstrun`, the same credential `/export` takes.
 */
export function renderLogin(next: string | undefined, error: string | undefined): string {
	return page(
		'Sign In',
		ADMIN_LOGIN_NAV_HTML.trimEnd(),
		fill(ADMIN_LOGIN_HTML, {
			ERROR: error ? errorCard(error) : '',
			LOGIN_PATH,
			NEXT: escapeHtml(next ?? SURFACE_PREFIX)
		})
	);
}

/** a bordered card carrying one escaped error message */
export function errorCard(message: string): string {
	return fill(ADMIN_ERROR_CARD_HTML, { MESSAGE: escapeHtml(message) });
}

/** a status word as a coloured pill; an unknown status reads as dim */
export const pill = (status: string) => {
	const cls =
		status === 'over' ? 'over' : status === 'warn' ? 'warn' : status === 'ok' ? 'ok' : 'dim';
	return `<span class="pill ${cls}">${escapeHtml(status)}</span>`;
};
