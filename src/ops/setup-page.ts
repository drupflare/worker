/**
 * What a site that nobody has claimed yet serves instead of its front page.
 *
 * The pack ships an installed database, so `install.php` never asks for a password; until
 * `/firstrun` runs, uid 1 has an empty hash and the site looks finished with no way in, and anyone
 * who finds the URL can claim it. This page closes that window. Inline everything, like the
 * warming page: a stylesheet or image request would return this page too.
 * @module
 */
import { SETUP_PAGE_CSS, SETUP_PAGE_HTML, SETUP_PAGE_JS } from '../site/generated/assets';
import { renderTemplate } from '../util/template';
import { wantsHtml } from './warming-page';

/** the `cfw_meta` key `/firstrun` stamps once a site has been configured */
export const FIRST_RUN_KEY = 'first_run_at';

/**
 * Whether this request should be answered with the setup page.
 *
 * HTML navigations only, and only reads: `curl`, assets and POSTs fall through (a site-wide block
 * would break every non-browser client for a state meant to last minutes).
 *
 * @param configured - whether `first_run_at` is set; a configured site never sees this page
 */
export function needsSetup(request: Request, configured: boolean): boolean {
	if (configured) return false;
	const method = request.method.toUpperCase();
	if (method !== 'GET' && method !== 'HEAD') return false;
	return wantsHtml(request);
}

/**
 * The page itself.
 *
 * The button is one `fetch()` POST (`/firstrun` takes a JSON body); the curl command is printed
 * underneath for scripting off.
 */
export function setupHtml(origin: string): string {
	return renderTemplate(SETUP_PAGE_HTML, {
		STYLE: SETUP_PAGE_CSS.trimEnd(),
		SCRIPT: SETUP_PAGE_JS.trimEnd(),
		ORIGIN: origin
	});
}

/**
 * The response.
 *
 * 200 rather than 503 (a 503 would tell a monitor the deploy failed), and never stored: it stops
 * being correct once somebody claims the site.
 */
export function setupResponse(origin: string, headers: Record<string, string> = {}): Response {
	return new Response(setupHtml(origin), {
		status: 200,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'x-robots-tag': 'noindex',
			'x-cfw-setup': 'required',
			...headers
		}
	});
}
