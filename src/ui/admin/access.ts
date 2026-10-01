import {
	ADMIN_ACCESS_DISCOVERY_ENDPOINTS_HTML,
	ADMIN_ACCESS_DISCOVERY_HTML,
	ADMIN_ACCESS_HTML,
	ADMIN_ACCESS_JS
} from '../../site/generated/assets';
import { errorCard, escapeHtml, fill, LOGIN_PATH, pill } from './shell';

/** the OIDC provider setup as `/setup/oidc` reports it */
export interface OidcSetupRow {
	issuer: string;
	clientId: string;
	secretPresent: boolean;
	redirectUri: string;
	saved?: boolean;
	discovery?: {
		ok: boolean;
		error?: string;
		authorization?: string;
		token?: string;
		jwks?: string;
	};
	error?: string;
}

/** where a visitor starts an SSO login; the object's own public route */
export const OIDC_START_PATH = '/oidc';

/**
 * The single sign-on surface. Writes go to `/setup/oidc`, which takes the owner token rather than
 * this page's weaker gate (the issuer picks the provider every login trusts); the secret is
 * reported present or absent, never shown.
 */
export function renderAccess(row: OidcSetupRow): string {
	const configured = row.issuer !== '' && row.clientId !== '';
	const d = row.discovery;
	// derived from the redirect uri the object composed, so both come from the same origin rather
	// than from a guess about how this page is being served
	let startUrl = OIDC_START_PATH;
	try {
		startUrl = new URL(OIDC_START_PATH, row.redirectUri).toString();
	} catch {
		startUrl = OIDC_START_PATH;
	}
	return fill(ADMIN_ACCESS_HTML, {
		CARD: configured ? 'card' : 'card warn',
		STATUS: configured ? `${pill('ok')} Configured` : `${pill('none')} Not Configured`,
		ISSUER: escapeHtml(row.issuer || 'not set'),
		CLIENT_ID: escapeHtml(row.clientId || 'not set'),
		SECRET: row.secretPresent
			? `<span class="ok">present</span>`
			: `<span class="over">absent</span>`,
		REDIRECT_URI: escapeHtml(row.redirectUri),
		START_URL: escapeHtml(startUrl),
		START_LINK: configured
			? ` <a href="${escapeHtml(OIDC_START_PATH)}">Try It</a>`
			: ' <span class="dim">available once an issuer is configured</span>',
		ISSUER_INPUT: escapeHtml(row.issuer),
		CLIENT_ID_INPUT: escapeHtml(row.clientId),
		CLEAR_DISABLED: configured ? '' : ' disabled',
		ERROR: row.error ? errorCard(row.error) : '',
		DISCOVERY: d
			? fill(ADMIN_ACCESS_DISCOVERY_HTML, {
					CLASS: d.ok ? 'card' : 'card bad',
					BODY: d.ok
						? fill(ADMIN_ACCESS_DISCOVERY_ENDPOINTS_HTML, {
								AUTHORIZATION: escapeHtml(d.authorization ?? ''),
								TOKEN: escapeHtml(d.token ?? ''),
								JWKS: escapeHtml(d.jwks ?? '')
							})
						: `<span class="over">${escapeHtml(d.error ?? 'discovery failed')}</span>`
				})
			: '',
		SCRIPT: fill(ADMIN_ACCESS_JS, { LOGIN_PATH })
	});
}
