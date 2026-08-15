import { describe, expect, it } from 'vitest';
import { renderPage, type RenderRequest } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * An operator's day, as one sustained sequence against ONE site.
 *
 * login -> read -> create -> config -> status -> update -> read back -> delete -> read again
 *
 * **Sequential and stateful on purpose.** Each step depends on the one before, which is what catches
 * the failures a set of independent tests cannot: a session that does not survive between steps, a
 * form build id that does not outlive a hibernation, a cache not invalidated after an update, a
 * delete that leaves the page still served. None of those appear when every test starts from a fresh
 * object.
 */

type Payload = Record<string, unknown>;
const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Journey-Pass-4417';

const raw = (site: ServeDo, path: string, init?: RequestInit) =>
	site.fetch(new Request(`https://do.local${path}`, init)).then(async (r) => ({
		status: r.status,
		generation: r.headers.get('x-cfw-generation'),
		cache: r.headers.get('x-cfw-cache'),
		body: await r.text()
	}));

const json = (site: ServeDo, path: string, init?: RequestInit) =>
	raw(site, path, init).then((r) => {
		try {
			return { ...r, json: JSON.parse(r.body) as Payload };
		} catch {
			return { ...r, json: {} as Payload };
		}
	});

/**
 * One render, driven through the same fragment `/__serve` builds.
 *
 * Direct rather than through `/__serve` so the journey is not at the mercy of the inline render
 * budget: a free-plan MISS answers 503 and queues, which is correct product behaviour and useless
 * for asserting what Drupal did. `serve-lanes.spec.ts` owns that decision; this owns Drupal.
 */
const render = (site: ServeDo, path: string, request: RenderRequest = {}) =>
	site.runJson(renderPage(path, [], false, request)) as Promise<Payload>;

const form = (body: string, cookie: string): RenderRequest => ({
	method: 'POST',
	body,
	contentType: 'application/x-www-form-urlencoded',
	cookie
});

/** every hidden input Drupal put in the form, which is what a browser would send back */
function hiddenFields(html: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const tag of html.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []) {
		const name = /name="([^"]*)"/.exec(tag)?.[1];
		const value = /value="([^"]*)"/.exec(tag)?.[1] ?? '';
		if (name) fields[name] = decodeHtml(value);
	}
	return fields;
}

function decodeHtml(value: string): string {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'");
}

function encodeForm(fields: Record<string, string>): string {
	return Object.entries(fields)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&');
}

/**
 * Drupal's own error text, so a form that re-renders says WHY.
 *
 * A rejected submission and a successful one differ by a status code and nothing else a diff can
 * read; without this, "expected 303, got 200" is where the investigation starts rather than ends.
 */
function errorsOf(html: string): string {
	const region = /class="[^"]*messages[^"]*"[\s\S]{0,1200}?<\/div>/g;
	return (html.match(region) ?? [])
		.map((block) =>
			block
				.replace(/<[^>]*>/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
		)
		.join(' | ')
		.slice(0, 400);
}

/** the session cookie as a browser would send it back, name=value with the attributes dropped */
function jarOf(result: Payload): string {
	const lines = Array.isArray(result['setCookie']) ? (result['setCookie'] as string[]) : [];
	const session = lines.find((line) => /^S?SESS/.test(line));
	return session ? (session.split(';')[0] ?? '') : '';
}

describe('the CRUD journey, in one object, without resetting', () => {
	it(
		'logs in, creates, configures, updates and deletes through real forms',
		async () => {
			const journey = await inObject(freshSite(), async (site) => {
				const steps: Record<string, unknown> = {};

				// #region 1. a site that serves, with an admin password set
				await json(site, '/__migrate?all=1');
				await json(site, '/__firstrun', {
					method: 'POST',
					body: JSON.stringify({ adminPass: PASS, siteName: 'Journey' }),
					headers: { 'content-type': 'application/json' }
				});
				const home = await render(site, '/');
				steps['read'] = { status: home['status'], uid: home['uid'] };
				// #endregion

				// #region 2. login
				const login = await render(
					site,
					'/user/login',
					form(
						`name=admin&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`,
						''
					)
				);
				const jar = jarOf(login);
				steps['login'] = {
					status: login['status'],
					uid: login['uid'],
					location: login['location'],
					hasCookie: jar !== ''
				};
				// #endregion

				// #region 3. the same path, with and without the session
				const anonAdd = await render(site, '/node/add/page');
				const authedAdd = await render(site, '/node/add/page', { cookie: jar });
				const addHtml = String(authedAdd['html'] ?? '');
				const addFields = hiddenFields(addHtml);
				steps['authorization'] = {
					anonStatus: anonAdd['status'],
					anonUid: anonAdd['uid'],
					authedStatus: authedAdd['status'],
					authedUid: authedAdd['uid'],
					hasToken: typeof addFields['form_token'] === 'string',
					hasBuildId: typeof addFields['form_build_id'] === 'string'
				};
				// #endregion

				// #region 4. create, through the form rather than the entity API
				const created = await render(
					site,
					'/node/add/page',
					form(
						encodeForm({
							...addFields,
							'title[0][value]': 'Journey One',
							'body[0][value]': 'first body',
							// an unchecked checkbox sends nothing, so a form built from hidden
							// fields alone saves an UNPUBLISHED node that anonymous cannot read
							'status[value]': '1',
							op: 'Save'
						}),
						jar
					)
				);
				const nid = Number(
					/\/node\/(\d+)/.exec(String(created['location'] ?? ''))?.[1] ?? '0'
				);
				steps['create'] = {
					status: created['status'],
					location: created['location'],
					nid,
					errors: errorsOf(String(created['html'] ?? ''))
				};
				// #endregion

				// #region 5. read the created content back
				const readBack = await render(site, `/node/${nid}`);
				steps['readBack'] = {
					status: readBack['status'],
					sawTitle: String(readBack['html'] ?? '').includes('Journey One')
				};
				// #endregion

				// #region 6. an administrative configuration change, which is its own capability
				const settingsForm = await render(site, '/admin/config/system/site-information', {
					cookie: jar
				});
				const settingsFields = hiddenFields(String(settingsForm['html'] ?? ''));
				const savedSettings = await render(
					site,
					'/admin/config/system/site-information',
					form(
						encodeForm({
							...settingsFields,
							site_name: 'Journey Renamed',
							site_mail: 'admin@example.com',
							site_slogan: '',
							site_frontpage: '/node',
							site_403: '',
							site_404: '',
							op: 'Save configuration'
						}),
						jar
					)
				);
				const siteName = await json(
					site,
					`/__sql?q=${encodeURIComponent("SELECT name FROM config WHERE name = 'system.site'")}`
				);
				const afterRename = await render(site, '/');
				steps['config'] = {
					formStatus: settingsForm['status'],
					saveStatus: savedSettings['status'],
					saveErrors: errorsOf(String(savedSettings['html'] ?? '')),
					configRowPresent: Array.isArray(siteName.json['rows']),
					sawNewName: String(afterRename['html'] ?? '').includes('Journey Renamed')
				};
				// #endregion

				// #region 7. a status read, which is the other half of an operator's day
				const status = await render(site, '/admin/reports/status', { cookie: jar });
				steps['status'] = {
					status: status['status'],
					uid: status['uid'],
					isStatusPage: String(status['html'] ?? '').includes('Status report')
				};
				// #endregion

				// #region 8. update the node through its edit form
				const editForm = await render(site, `/node/${nid}/edit`, { cookie: jar });
				const editFields = hiddenFields(String(editForm['html'] ?? ''));
				const updated = await render(
					site,
					`/node/${nid}/edit`,
					form(
						encodeForm({
							...editFields,
							'title[0][value]': 'Journey Two',
							'body[0][value]': 'second body',
							'status[value]': '1',
							op: 'Save'
						}),
						jar
					)
				);
				const readUpdated = await render(site, `/node/${nid}`);
				steps['update'] = {
					formStatus: editForm['status'],
					saveStatus: updated['status'],
					sawNewTitle: String(readUpdated['html'] ?? '').includes('Journey Two'),
					sawOldTitle: String(readUpdated['html'] ?? '').includes('Journey One')
				};
				// #endregion

				// #region 9. delete, which Drupal drives through a confirm form rather than a verb
				const deleteForm = await render(site, `/node/${nid}/delete`, { cookie: jar });
				const deleteFields = hiddenFields(String(deleteForm['html'] ?? ''));
				const deleted = await render(
					site,
					`/node/${nid}/delete`,
					form(encodeForm({ ...deleteFields, op: 'Delete' }), jar)
				);
				const gone = await render(site, `/node/${nid}`);
				const count = await json(
					site,
					`/__sql?q=${encodeURIComponent('SELECT COUNT(*) AS c FROM node')}`
				);
				steps['delete'] = {
					formStatus: deleteForm['status'],
					deleteStatus: deleted['status'],
					readAfterStatus: gone['status'],
					nodesLeft: Array.isArray(count.json['rows'])
						? (count.json['rows'] as Payload[])[0]?.['c']
						: null
				};
				// #endregion

				return steps;
			});

			// #region the session, which everything else stands on
			const read = journey['read'] as Payload;
			expect(read['status'], 'the front page must serve').toBe(200);
			expect(read['uid'], 'a visitor with no cookie is anonymous').toBe(0);

			const login = journey['login'] as Payload;
			expect(login['status'], 'a successful login redirects').toBe(303);
			expect(login['uid']).toBe(1);
			expect(login['hasCookie'], 'no session cookie means no session').toBe(true);
			expect(String(login['location'])).toContain('/user/1');
			// #endregion

			// #region identity isolation, which is the disclosure case rather than a feature
			const authorization = journey['authorization'] as Payload;
			expect(
				authorization['anonUid'],
				'the request after a login must not inherit the login'
			).toBe(0);
			expect(authorization['anonStatus'], 'anonymous may not create content').toBe(403);
			expect(authorization['authedStatus'], 'the admin may').toBe(200);
			expect(authorization['authedUid']).toBe(1);
			expect(
				authorization['hasToken'],
				'FormBuilder was reached and issued a CSRF token'
			).toBe(true);
			expect(authorization['hasBuildId']).toBe(true);
			// #endregion

			// #region create
			const create = journey['create'] as Payload;
			expect(create['status'], `a saved node redirects to itself: ${create['errors']}`).toBe(
				303
			);
			expect(Number(create['nid'])).toBeGreaterThan(0);

			const readBack = journey['readBack'] as Payload;
			expect(readBack['status']).toBe(200);
			expect(readBack['sawTitle'], 'the created title must be on the created page').toBe(
				true
			);
			// #endregion

			// #region administrative configuration, which had never been exercised
			const config = journey['config'] as Payload;
			expect(config['formStatus'], 'the settings form must build for an admin').toBe(200);
			expect(
				config['saveStatus'],
				`saving configuration redirects: ${config['saveErrors']}`
			).toBe(303);
			expect(config['sawNewName'], 'the renamed site must appear on the front page').toBe(
				true
			);
			// #endregion

			const status = journey['status'] as Payload;
			expect(status['status'], 'the status report must build for an admin').toBe(200);
			expect(status['isStatusPage']).toBe(true);

			// #region update
			const update = journey['update'] as Payload;
			expect(update['formStatus']).toBe(200);
			expect(update['saveStatus']).toBe(303);
			expect(update['sawNewTitle'], 'the edit did not take').toBe(true);
			expect(update['sawOldTitle'], 'the old title is still being served').toBe(false);
			// #endregion

			// #region delete
			const del = journey['delete'] as Payload;
			expect(del['formStatus']).toBe(200);
			expect(del['deleteStatus']).toBe(303);
			expect(del['readAfterStatus'], 'a deleted node must stop resolving').toBe(404);
			expect(Number(del['nodesLeft'])).toBe(0);
			// #endregion
		},
		REQUEST_TIMEOUT
	);

	/**
	 * The method threading, asserted on the emitted source.
	 *
	 * Kept as a source assertion rather than folded into the journey because it is the one thing the
	 * journey cannot distinguish: a GET that silently gained arguments still renders correctly, and
	 * three `/__assemble` specs read this exact argument list.
	 */
	it('threads a method into the render, and a plain anonymous GET is unchanged', () => {
		const withPost = renderPage('/', ['page'], false, {
			method: 'POST',
			body: 'a=b',
			contentType: 'application/x-www-form-urlencoded'
		});
		expect(withPost).toContain('"\\"POST\\""');

		// a GET with no cookie emits no request arguments at all, so its source is byte-identical to
		// what it was before either parameter existed
		const get = /\$response = cfw_serve\([^;]*\);/.exec(renderPage('/'))?.[0];
		expect(get).toBe('$response = cfw_serve($path, false);');

		// a cookie is enough on its own, because an authenticated GET is the case it exists for
		const withCookie = renderPage('/', ['page'], false, { cookie: 'SESSabc=1' });
		expect(withCookie).toContain('"\\"SESSabc=1\\""');
	});
});
