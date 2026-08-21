import { renderPage, type RenderRequest } from '../../src/drupal/site-php';
import type { ServeDo } from './serve-do';

/**
 * Driving a real Drupal form through the real serve path: provision, log in, read the token back.
 *
 * Lifted out of `csrf.spec.ts` and `submission-wall.spec.ts`, which had grown their own copies of
 * the same five functions. A third copy for the static-state sweep is what forced the issue: the
 * hidden-field reader and the cookie-jar reader are the two places a silent behaviour change would
 * make every form spec agree with each other and with nothing else.
 *
 * Not a `.spec.ts`, so vitest does not collect it, and `tests/**` is excluded from coverage.
 */

/** what `renderPage()`'s PHP prints, as far as a form spec reads it */
export type FormResult = Record<string, unknown>;

/** one render through the real serve path */
export const render = (site: ServeDo, path: string, request: RenderRequest = {}) =>
	site.runJson(renderPage(path, [], false, request)) as Promise<FormResult>;

/** a urlencoded POST carrying a cookie jar */
export const formPost = (body: string, cookie = ''): RenderRequest => ({
	method: 'POST',
	body,
	contentType: 'application/x-www-form-urlencoded',
	cookie
});

/**
 * Every hidden input in a rendered form, decoded.
 *
 * `form_build_id` and `form_token` both arrive this way and both have to travel back verbatim, so
 * the entity decoding is load-bearing rather than tidiness: a token carrying `&amp;` fails
 * validation and reads exactly like a token the server refused.
 */
export function hiddenFields(html: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const tag of html.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []) {
		const name = /name="([^"]*)"/.exec(tag)?.[1];
		const value = (/value="([^"]*)"/.exec(tag)?.[1] ?? '')
			.replace(/&amp;/g, '&')
			.replace(/&quot;/g, '"')
			.replace(/&#0?39;/g, "'");
		if (name) fields[name] = value;
	}
	return fields;
}

export const encodeForm = (fields: Record<string, string>) =>
	Object.entries(fields)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&');

/**
 * The whole `Set-Cookie` line a login issued, or null.
 *
 * `renderPage()` reports both sources -- the Response headers and PHP's own `headers_list()` --
 * because `session_start()` writes into the second one and the Response never sees it.
 */
export function sessionCookie(result: FormResult): string | null {
	const lines = Array.isArray(result['setCookie']) ? (result['setCookie'] as string[]) : [];
	return lines.find((line) => /^S?SESS/.test(line)) ?? null;
}

/** the same cookie reduced to what a `Cookie` request header carries */
export function cookieJar(result: FormResult): string {
	const line = sessionCookie(result);
	return line ? (line.split(';')[0] ?? '') : '';
}

/** the body of a login POST */
export const credentials = (name: string, pass: string) =>
	`name=${encodeURIComponent(name)}&pass=${encodeURIComponent(pass)}` +
	'&form_id=user_login_form&op=Log+in';

/** one login attempt through the real serve path */
export const login = (site: ServeDo, name: string, pass: string) =>
	render(site, '/user/login', formPost(credentials(name, pass)));

/** a migrated site with a known admin password; `/__firstrun` is the only thing that sets one */
export async function claimSite(
	site: ServeDo,
	adminPass: string,
	siteName = 'Sweep'
): Promise<void> {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	await site.fetch(
		new Request('https://do.local/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass, siteName }),
			headers: { 'content-type': 'application/json' }
		})
	);
}
