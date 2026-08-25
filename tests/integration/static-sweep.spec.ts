import { describe, expect, it } from 'vitest';
import {
	abandonTransaction,
	BOUNDARY_STATE,
	createUser,
	LEAK_OPEN_SESSION,
	leakOutputBuffer,
	renderPage,
	TRANSLATE_ENGLISH
} from '../../src/drupal/site-php';
import {
	claimSite,
	cookieJar,
	encodeForm,
	formPost,
	hiddenFields,
	login,
	render,
	type FormResult
} from '../helpers/drupal-forms';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What survives a request boundary in an interpreter that does not die.
 *
 * PHP on a real SAPI resets class statics by ending the process, so Drupal never had to. Here the
 * interpreter is a warm Durable Object serving many requests for many people, and six members of
 * this family had been found -- `Html::$seenIds`, `PathMatcher::$isCurrentFrontPage`,
 * `PageCache::$cid`, `drupal_static()`, uid-1 cache poisoning and `FormState::$anyErrors` -- every
 * one of them by accident. This file is the sweep that stops that being the discovery mechanism.
 *
 * **The design rule, and it is why the last one hid for the life of the project.** A harness that
 * repeats a step and byte-diffs would NOT have caught `FormState::$anyErrors`: two identical failed
 * logins agree exactly, because both fail and neither needs the submit handler the flag gates. So
 * every step that can succeed or fail is run in BOTH orders. Varying the outcome is what makes a
 * gate visible; repeating the step is what hides it.
 *
 * Three instruments, because no one of them sees the whole family:
 *
 * - **byte diff, warm against cold.** The same request as step N of a warm sequence and as step 1
 *   of a fresh object. Sees anything that reaches the response.
 * - **named carriers**, via `BOUNDARY_STATE`. Instance state on container services --
 *   `ThemeManager::$activeTheme` is a property, not a static -- which the blind half cannot see.
 * - **the blind static fingerprint**, every static property of every declared class. Sees a carrier
 *   nobody has thought of, and is the half that caught `Renderer::$contextCollection`.
 *
 * **The confound this file had to rule out first.** An authenticated admin page renders 118,936
 * bytes on its first pass and 95,215 on every one after it, in the same object, for the same user,
 * with no identity change -- BigPipe scaffolding that a warm `dynamic_page_cache` makes unnecessary.
 * That is Drupal working, and a byte-diff harness that did not name its bins would report it as a
 * leak. `is measuring carried state and not cache warmth` at the bottom is the control that pins it.
 */

const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Sweep-2262';

type Payload = Record<string, unknown>;

/** the cache bins an authenticated page has to have emptied to be comparable; see the docblock */
const COLD_BINS = ['dynamic_page_cache', 'render', 'page'];

const boundary = (site: ServeDo) => site.runJson(BOUNDARY_STATE) as Promise<Payload>;

const renderWith = (site: ServeDo, path: string, bins: string[], cookie = '') =>
	site.runJson(renderPage(path, bins, false, { cookie })) as Promise<Payload>;

const html = (result: Payload | FormResult) => String(result['html'] ?? '');

/** collapses runs of whitespace, so a comparison is about content rather than indentation */
const squash = (source: string) => source.replace(/\s+/g, ' ');

/** a migrated site with a known admin password and two ordinary accounts to interleave */
async function provision(site: ServeDo) {
	await claimSite(site, PASS, 'Sweep');
	await site.runJson(createUser({ name: 'alice', pass: PASS }));
	await site.runJson(createUser({ name: 'bob', pass: PASS }));
}

/** one of the Durable Object's own diagnostic routes, as JSON */
const callDo = (site: ServeDo, path: string) =>
	site.fetch(new Request(`https://do.local${path}`)).then((r) => r.json() as Promise<Payload>);

const countRows = (site: ServeDo, sql: string) =>
	site
		.fetch(new Request(`https://do.local/__sql?q=${encodeURIComponent(sql)}`))
		.then((r) => r.json() as Promise<Payload>)
		.then((out) => Number(((out['rows'] as Payload[]) ?? [])[0]?.['c'] ?? -1));

const NODE_BODY = {
	'title[0][value]': 'Sweep Probe Node',
	'body[0][value]': 'body',
	'status[value]': '1',
	op: 'Save'
};

/** the markup a leak in this family has shown up in: the theme, the menu trail, the asset list */
const marks = (source: string) => ({
	bytes: source.length,
	squashed: squash(source).length,
	activeTrail: source.includes('primary-nav__menu-item--active-trail'),
	claro: source.includes('claro/css'),
	olivero: source.includes('olivero/css')
});

/** logs uid 1 in and returns the jar plus a built node form, which is what a submission needs */
async function adminWithForm(site: ServeDo) {
	const jar = cookieJar(await login(site, 'admin', PASS));
	const built = await render(site, '/node/add/page', { cookie: jar });
	return { jar, fields: hiddenFields(html(built)) };
}

describe('identity interleaving: what one visitor leaves for the next', () => {
	/**
	 * A VISITOR USED TO BE SERVED THE ADMIN THEME. Fixed 2026-08-20; this is the regression test.
	 *
	 * **THE MECHANISM: `ThemeManager::$activeTheme`.** `getActiveTheme()` memoises the negotiated
	 * theme into it and the only reset in core is `resetActiveTheme()`, reached from `user_login`,
	 * `user_logout` and the theme settings form -- never on an ordinary request, because on a real
	 * SAPI the process dies instead. So the first route an object negotiates decides the theme for
	 * every request after it.
	 *
	 * `theme.manager` was already on the resetter's seed list, which is exactly why nobody looked:
	 * it has no `reset()`, so `method_exists()` skipped it in silence and the id read as handled.
	 * That skip is now recorded -- see `says which seeded services it could not reset` below.
	 *
	 * BLAST RADIUS while it was live: any request touching an admin route pinned Claro, and the next
	 * anonymous front page came back 14,933 bytes instead of 17,670, in admin-theme markup. On this
	 * runtime the anonymous front page is also what the fill alarm renders and stores in `cfw_page`,
	 * so one admin's page view could be baked into the page every visitor is served.
	 *
	 * The 4-byte tolerance is a MEASURED residual and not slack: after an `/admin/*` render the next
	 * anonymous page comes back 17,666 against 17,670, and the two are identical once runs of
	 * whitespace are collapsed. `squashed` is asserted exactly for that reason -- if the difference
	 * ever becomes content, this fails. `is whitespace at two measured places, and nothing else`
	 * below pins where those four bytes are.
	 */
	it(
		'gives an anonymous visitor the site theme after an admin request pinned the admin one',
		async () => {
			const warm = await inObject(freshSite(), async (site) => {
				await provision(site);
				const jar = cookieJar(await login(site, 'admin', PASS));
				const adminPage = await render(site, '/admin/content', { cookie: jar });
				const during = await boundary(site);
				const anon = await render(site, '/');
				return {
					adminNegotiated: during['theme'],
					adminStatus: adminPage['status'],
					anonUid: anon['uid'],
					anonTheme: (await boundary(site))['theme'],
					marks: marks(html(anon))
				};
			});
			const cold = await inObject(freshSite(), async (site) => {
				await provision(site);
				const anon = await render(site, '/');
				return { marks: marks(html(anon)), theme: (await boundary(site))['theme'] };
			});

			// the setup has to really have negotiated the admin theme, or this proves nothing
			expect(warm.adminStatus).toBe(200);
			expect(warm.adminNegotiated, 'an admin route must negotiate claro').toBe('claro');

			expect(cold.theme).toBe('olivero');
			expect(warm.anonTheme, 'and the next visitor must not inherit it').toBe('olivero');
			expect(warm.anonUid).toBe(0);

			expect(warm.marks.claro, 'no admin-theme stylesheet on a visitor page').toBe(false);
			expect(warm.marks.olivero).toBe(true);
			expect(warm.marks.squashed, 'content identical to what a cold object serves').toBe(
				cold.marks.squashed
			);
			expect(Math.abs(warm.marks.bytes - cold.marks.bytes)).toBeLessThanOrEqual(4);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * What the four bytes above ARE, pinned so they cannot quietly become something else.
	 *
	 * Two whitespace-only tokens of 2,093, both at the start of a region's `{{ content }}`. It takes
	 * an authenticated request to an ADMIN route with no prior anonymous `/`, and then latches. Not
	 * cache warmth, not the theme, not template resolution, not autoload state -- all measured.
	 * See TECHNICAL_REPORT.md; the carrier is bounded rather than named.
	 */
	it(
		'is whitespace at two measured places, and nothing else',
		async () => {
			const warm = await inObject(freshSite(), async (site) => {
				await provision(site);
				const jar = cookieJar(await login(site, 'admin', PASS));
				await render(site, '/admin/content', { cookie: jar });
				return html(await render(site, '/'));
			});
			const cold = await inObject(freshSite(), async (site) => {
				await provision(site);
				return html(await render(site, '/'));
			});

			// the per-site nonces are masked, so the token comparison below is about the request
			// ordering rather than about which site rendered
			const mask = (source: string) => source.replace(/[0-9a-f]{64}/g, '<64hex>');
			const left = mask(cold).split(/(\s+)/);
			const right = mask(warm).split(/(\s+)/);

			expect(left.length, 'no element may appear or disappear').toBe(right.length);

			const differing = left
				.map((token, index) => [index, token, right[index]] as const)
				.filter(([, a, b]) => a !== b);
			const content = differing.filter(([, a, b]) => /\S/.test(a) || /\S/.test(String(b)));
			expect(
				content.map(([i, a, b]) => `@${i} ${JSON.stringify(a)} -> ${JSON.stringify(b)}`),
				'every difference must be whitespace once the site nonces are masked'
			).toEqual([]);

			const delta = differing.reduce((sum, [, a, b]) => sum + a.length - String(b).length, 0);
			expect(differing.length, 'two whitespace runs, both named in the docblock').toBe(2);
			expect(delta, 'four bytes, all of them whitespace').toBe(4);
			expect(cold.length - warm.length).toBe(delta);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * The same leak pointed the other way, which is the half a one-directional test would miss.
	 *
	 * An anonymous front page pins Olivero, and the admin interface then renders in the front-end
	 * theme: measured at 110,173 bytes with no Claro stylesheet at all, against 118,931 cold.
	 *
	 * Both arms run the IDENTICAL suffix and differ only in what precedes it, and both empty the
	 * render bins, for the reason the file docblock gives. Within 1% rather than byte-exact because
	 * the page carries a form build id and a token, which move every render.
	 */
	it(
		'gives an admin the admin theme after an anonymous request pinned the site one',
		async () => {
			const suffix = async (site: ServeDo) => {
				const jar = cookieJar(await login(site, 'admin', PASS));
				await renderWith(site, '/', COLD_BINS, jar);
				const adminPage = await renderWith(site, '/admin/content', COLD_BINS, jar);
				return {
					marks: marks(html(adminPage)),
					status: adminPage['status'],
					theme: (await boundary(site))['theme']
				};
			};

			const cold = await inObject(freshSite(), async (site) => {
				await provision(site);
				return suffix(site);
			});
			const warm = await inObject(freshSite(), async (site) => {
				await provision(site);
				await renderWith(site, '/', COLD_BINS);
				await renderWith(site, '/user/login', COLD_BINS);
				await renderWith(site, '/no-such-path', COLD_BINS);
				return suffix(site);
			});

			expect(cold.status).toBe(200);
			expect(cold.theme).toBe('claro');
			expect(warm.theme, 'three requests earlier must not decide this one').toBe('claro');
			expect(warm.marks.claro).toBe(true);
			expect(Math.abs(warm.marks.bytes - cold.marks.bytes) / cold.marks.bytes).toBeLessThan(
				0.01
			);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * Three identities in one object, with a different user immediately after an authenticated one.
	 *
	 * The uid a render reports is `Drupal::currentUser()->id()` AFTER the request, which is the
	 * value the uid-1 cache poisoning was found through: an unrestored account switch made the
	 * alarm render the front page as uid 1 and store that admin HTML in the anonymous page cache.
	 */
	it(
		'answers as the visitor who asked, through anonymous, alice, bob and back to alice',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await provision(site);
				const anonFirst = await render(site, '/');
				const aliceJar = cookieJar(await login(site, 'alice', PASS));
				const alice = await render(site, '/user/2', { cookie: aliceJar });
				const bobJar = cookieJar(await login(site, 'bob', PASS));
				const bob = await render(site, '/user/3', { cookie: bobJar });
				// bob's session on alice's page, immediately after alice's own request
				const cross = await render(site, '/user/2/edit', { cookie: bobJar });
				const aliceAgain = await render(site, '/user/2', { cookie: aliceJar });
				const anonLast = await render(site, '/');
				return {
					anonFirstUid: anonFirst['uid'],
					anonFirstMarks: marks(html(anonFirst)),
					aliceUid: alice['uid'],
					bobUid: bob['uid'],
					crossUid: cross['uid'],
					crossStatus: cross['status'],
					aliceAgainUid: aliceAgain['uid'],
					anonLastUid: anonLast['uid'],
					anonLastMarks: marks(html(anonLast)),
					bobHtml: html(bob)
				};
			});

			expect(out.anonFirstUid).toBe(0);
			expect(out.aliceUid).toBe(2);
			expect(out.bobUid).toBe(3);
			expect(out.aliceAgainUid, 'alice must still be alice after bob').toBe(2);
			expect(out.anonLastUid, 'and an anonymous request after both is anonymous').toBe(0);

			// authorization holds across the identity change rather than falling back to the last one
			expect(out.crossUid).toBe(3);
			expect(out.crossStatus).toBe(403);
			expect(out.bobHtml).not.toContain('alice');

			// and the anonymous front page is the same page before and after four authenticated
			// requests, which is the observable the page cache stores
			expect(out.anonLastMarks).toEqual(out.anonFirstMarks);
		},
		REQUEST_TIMEOUT
	);
});

describe('the caches whose key is the request they were first asked in', () => {
	/**
	 * THE ASSET LIST AND THE MENU TRAIL WERE DECIDED BY THE FIRST ROUTE. Fixed 2026-08-20.
	 *
	 * **THE MECHANISM: a `CacheCollector` computes `getCid()` once and memoises it.** Three
	 * carriers, one shape, and each was only visible once the one in front of it was fixed:
	 *
	 * - `LibraryDiscoveryCollector::getCid()` is `library_info:<active theme>`, and `$storage` holds
	 *   the definitions resolved under that theme with its `libraries-extend` folded in.
	 * - `LibraryDependencyResolver::$librariesDependencies` memoises each library's dependency
	 *   closure keyed by LIBRARY NAME with no theme at all. It has no `reset()`, no
	 *   `clearCachedDefinitions()` and no `needs_destruction` tag.
	 * - `MenuActiveTrail::getCid()` is `active-trail:route:<route name>`, and unlike
	 *   `LibraryDiscoveryCollector` it does NOT override `reset()` to clear `$cid` --
	 *   `CacheCollector::reset()` empties `$storage` and leaves the cid, so the next request loads
	 *   the previous route's trail straight back out of `cache.menu`.
	 *
	 * Measured: an admin route then an anonymous `/` gave 17,869 against 17,670, two Claro
	 * stylesheets on Olivero; emptying seven cache bins moved none of it. `menu.active_trail` is
	 * `lazy: true`, so reflection on the proxy throws and reads like a reset that had no effect.
	 *
	 * BLAST RADIUS while it was live: the wrong theme's stylesheets and the wrong page's navigation
	 * highlight on every page after the first, baked into `cfw_page`.
	 */
	it(
		'renders the same front page whatever route the object served first',
		async () => {
			const prefixes: [string, string[]][] = [
				['nothing', []],
				['one front page', ['/']],
				['a login page', ['/user/login']],
				['a 404', ['/no-such-path']],
				['a 404 then a login page', ['/no-such-path', '/user/login']]
			];

			const seen: Record<string, ReturnType<typeof marks>> = {};
			for (const [name, paths] of prefixes) {
				seen[name] = await inObject(freshSite(), async (site) => {
					await provision(site);
					for (const path of paths) await render(site, path);
					return marks(html(await render(site, '/')));
				});
			}

			const baseline = seen['nothing'];
			expect(baseline?.activeTrail, 'a cold front page highlights itself in the menu').toBe(
				true
			);
			for (const [name, got] of Object.entries(seen)) {
				expect(got, `front page after ${name}`).toEqual(baseline);
			}
		},
		REQUEST_TIMEOUT
	);

	/**
	 * The same collector defect seen from the other side: a non-front page after a front page.
	 *
	 * Kept separate because it fails differently. The test above shows a page losing markup it
	 * should have; this one shows a page GAINING markup that belongs to another route, which is the
	 * direction a "the page looks right" check never catches.
	 */
	it(
		'does not highlight the front page in the menu of a page that is not the front page',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await provision(site);
				const first = await render(site, '/');
				const loginAfter = await render(site, '/user/login');
				return {
					frontTrail: marks(html(first)).activeTrail,
					loginTrail: marks(html(loginAfter)).activeTrail,
					loginStatus: loginAfter['status']
				};
			});
			const cold = await inObject(freshSite(), async (site) => {
				await provision(site);
				return marks(html(await render(site, '/user/login'))).activeTrail;
			});

			expect(out.loginStatus).toBe(200);
			expect(out.frontTrail, 'the setup must really have set a trail').toBe(true);
			expect(cold, 'a cold login page highlights nothing').toBe(false);
			expect(out.loginTrail, 'and a warm one must not inherit the front page').toBe(false);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * ONE VISITOR'S ROLES USED TO KEY THE NEXT VISITOR'S TRANSLATIONS. Fixed 2026-08-20.
	 *
	 * **THE MECHANISM: `LocaleLookup::getCid()` folds `Drupal::currentUser()->getRoles()` into the
	 * key and memoises it**, and the `LocaleLookup` objects live on `LocaleTranslation::$translations`
	 * -- a container service that outlives the request. Core resets it only from
	 * `TranslationManager::reset()`, which nothing but a test calls, so the FIRST request to
	 * translate a given langcode and context decides the cache key for every request after it.
	 *
	 * This is the shape the two collectors above have, pointed at the USER rather than the route,
	 * which is why it is the more dangerous one and why it is here rather than with them.
	 *
	 * Measured with `locale` on, admin then anonymous then alice: all three rows carried the FIRST
	 * visitor's key, in both directions. With the entry in `REQUEST_SCOPED_COLLECTORS` each row is
	 * the roles of the visitor who asked.
	 *
	 * BLAST RADIUS while it was live: cache-key mixing rather than disclosure -- the VALUE does not
	 * vary by role -- but the key is what core added the role ids to avoid, and it is per-user state
	 * crossing a request boundary. `locale` is off on the packed site, so it costs nothing until a
	 * site turns it on.
	 */
	it(
		'gives each visitor a translation cache key keyed on their own roles',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await provision(site);
				const enabled = await callDo(site, '/__enable?module=locale');
				const translating = await site.runJson(TRANSLATE_ENGLISH);
				const adminJar = cookieJar(await login(site, 'admin', PASS));
				const adminPage = await renderWith(site, '/admin/content', COLD_BINS, adminJar);
				const afterAdmin = await boundary(site);
				const anon = await renderWith(site, '/', COLD_BINS);
				const afterAnon = await boundary(site);
				const aliceJar = cookieJar(await login(site, 'alice', PASS));
				const alice = await renderWith(site, '/user/2', COLD_BINS, aliceJar);
				const afterAlice = await boundary(site);
				return {
					enabled: enabled['ok'],
					added: enabled['added'],
					translating,
					adminStatus: adminPage['status'],
					adminCids: afterAdmin['localeCids'] as Record<string, string>,
					anonUid: anon['uid'],
					anonCids: afterAnon['localeCids'] as Record<string, string>,
					aliceUid: alice['uid'],
					aliceCids: afterAlice['localeCids'] as Record<string, string>,
					collectors: (anon['reset'] as Payload | null)?.['collectors']
				};
			});

			// the setup has to have really enabled locale and made it translate, or every cid below
			// is null and the assertions are vacuous
			expect(out.enabled, `locale did not enable: ${JSON.stringify(out.added)}`).toBe(true);
			expect(out.translating).toMatchObject({ ok: true, translateEnglish: true });
			expect(out.adminStatus).toBe(200);
			expect(out.anonUid).toBe(0);
			expect(out.aliceUid).toBe(2);

			// and it has to have built a lookup per request, or an empty map would pass everything
			for (const [name, cids] of [
				['admin', out.adminCids],
				['anonymous', out.anonCids],
				['alice', out.aliceCids]
			] as const) {
				expect(
					Object.keys(cids ?? {}).length,
					`${name} built no LocaleLookup`
				).toBeGreaterThan(0);
			}

			// each request's keys carry its OWN roles and nobody else's. Rebuilt from the map key,
			// which is `<langcode>|<context>`, so the whole cid is compared rather than a suffix --
			// `:authenticated` is also the tail of `:administrator:authenticated`.
			//
			// FIRST, ahead of the reset log below, so removing the fix fails on the leak rather
			// than on the bookkeeping that reports the fix ran
			const wrong = (cids: Record<string, string>, roles: string) =>
				Object.entries(cids)
					.map(([key, cid]) => [`locale:${key.replace('|', ':')}:${roles}`, cid])
					.filter(([want, got]) => want !== got)
					.map(([want, got]) => `want ${want}, got ${got}`);
			expect(
				wrong(out.anonCids, 'anonymous'),
				'the admin roles must not key the next visitor'
			).toEqual([]);
			expect(
				wrong(out.aliceCids, 'authenticated'),
				'nor the ordinary user after them'
			).toEqual([]);
			expect(
				wrong(out.adminCids, 'administrator:authenticated'),
				'and the admin must not inherit the key from before the login'
			).toEqual([]);

			expect(out.collectors).toMatchObject({
				'string_translator.locale.lookup': 'reset-only'
			});
		},
		REQUEST_TIMEOUT
	);
});

describe('outcome ordering: a failure followed by a success, and the reverse', () => {
	/**
	 * All four login orderings, because only one of them can see a flag that gates success.
	 *
	 * `wrong, wrong` is the ordering that passed while `FormState::$anyErrors` was live, and it
	 * passed for a reason that generalises to every gate of that shape: both attempts fail, so both
	 * set the flag and neither needs the handler it blocks. `right` after `wrong` is the only
	 * arrangement in which the gate has anything to stop.
	 */
	it.each([
		['right then right', ['admin', 'admin'], [303, 303]],
		['wrong then right', ['nobody', 'admin'], [200, 303]],
		['right then wrong', ['admin', 'nobody'], [303, 200]],
		['wrong then wrong', ['nobody', 'nobody'], [200, 200]]
	] as [string, string[], number[]][])(
		'%s',
		async (_name, order, expected) => {
			const out = await inObject(freshSite(), async (site) => {
				await provision(site);
				const results: Payload[] = [];
				for (const who of order) {
					results.push(
						await login(site, 'admin', who === 'admin' ? PASS : 'not-the-password')
					);
				}
				return results.map((r) => ({
					status: r['status'],
					uid: r['uid'],
					cookie:
						(r['setCookie'] as string[] | undefined)?.some((c) => /^S?SESS/.test(c)) ??
						false,
					refused: html(r).includes('Unrecognized username or password')
				}));
			});

			for (const [index, step] of out.entries()) {
				const wanted = expected[index];
				expect(step.status, `step ${index + 1} of ${order.join(',')}`).toBe(wanted);
				if (wanted === 303) {
					expect(step.uid, `step ${index + 1} must authenticate`).toBe(1);
					expect(step.cookie, `step ${index + 1} must issue a session`).toBe(true);
					expect(step.refused).toBe(false);
				} else {
					// a refusal must SAY so; silence is what the static-gated failure looked like
					expect(step.refused, `step ${index + 1} must say why it refused`).toBe(true);
					expect(step.uid).toBe(0);
					expect(step.cookie).toBe(false);
				}
			}
		},
		REQUEST_TIMEOUT
	);

	/**
	 * The same axis on a write, where the observable is rows rather than a redirect.
	 *
	 * `csrf.spec.ts` owns whether the token is enforced and covers reject-then-login. What is here
	 * is the ORDERING: an accepted submission must behave the same whether it comes before or after
	 * a rejected one, and the rejected one must write nothing in either position.
	 */
	it(
		'saves once and only once, whichever order the accepted and rejected submissions arrive in',
		async () => {
			const rejectFirst = await inObject(freshSite(), async (site) => {
				await provision(site);
				const { jar, fields } = await adminWithForm(site);
				const { form_token: _dropped, ...noToken } = fields;
				const rejected = await render(
					site,
					'/node/add/page',
					formPost(encodeForm({ ...noToken, ...NODE_BODY }), jar)
				);
				const accepted = await render(
					site,
					'/node/add/page',
					formPost(encodeForm({ ...fields, ...NODE_BODY }), jar)
				);
				return {
					rejectedStatus: rejected['status'],
					acceptedStatus: accepted['status'],
					acceptedLocation: accepted['location'],
					nodes: await countRows(site, 'SELECT COUNT(*) AS c FROM node')
				};
			});

			const acceptFirst = await inObject(freshSite(), async (site) => {
				await provision(site);
				const { jar, fields } = await adminWithForm(site);
				const accepted = await render(
					site,
					'/node/add/page',
					formPost(encodeForm({ ...fields, ...NODE_BODY }), jar)
				);
				const { form_token: _dropped, ...noToken } = fields;
				const rejected = await render(
					site,
					'/node/add/page',
					formPost(encodeForm({ ...noToken, ...NODE_BODY }), jar)
				);
				return {
					rejectedStatus: rejected['status'],
					acceptedStatus: accepted['status'],
					acceptedLocation: accepted['location'],
					nodes: await countRows(site, 'SELECT COUNT(*) AS c FROM node')
				};
			});

			for (const [name, run] of [
				['reject first', rejectFirst],
				['accept first', acceptFirst]
			] as const) {
				expect(run.acceptedStatus, `${name}: the valid submission must save`).toBe(303);
				expect(String(run.acceptedLocation), name).toContain('/node/');
				expect(run.rejectedStatus, `${name}: the invalid one must not`).toBe(200);
				expect(run.nodes, `${name}: exactly one node`).toBe(1);
			}
		},
		REQUEST_TIMEOUT
	);
});

describe('the message queue', () => {
	/**
	 * The ordinary path: a save message reaches its author and no one else.
	 *
	 * **This test asserts exactly that and no more, and the docblock it used to carry was wrong.**
	 * It claimed uid 1 saving a node was enough to make the next anonymous GET render "has been
	 * created", and it is not: falsified 2026-08-20 by re-running with `rebindBags()` off, with the
	 * started/closed flags off, with `$_SESSION = []` off, and with the whole of `resetSession()`
	 * replaced by an early return -- cold bins throughout, so a warm page is not the explanation.
	 *
	 * The mechanism it named does not exist in Drupal 11. `StackMiddleware\Session::handle()` calls
	 * `$session->start()` on EVERY main request where `PHP_SAPI !== 'cli'` -- and PHP_SAPI is
	 * `embed` here, measured -- and `SessionManager::start()`'s no-cookie branch is
	 * `$_SESSION = []; $this->loadSession();`. So core rebinds the bags for an anonymous visitor
	 * with no cookie, which is the case the old docblock said nothing rebound.
	 *
	 * The disclosure IS reachable, behind one precondition, and it has its own test below.
	 */
	it(
		'shows a save message to the visitor who caused it and to nobody else',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await provision(site);
				const { jar, fields } = await adminWithForm(site);
				const saved = await render(
					site,
					'/node/add/page',
					formPost(encodeForm({ ...fields, ...NODE_BODY }), jar)
				);
				const queued = await boundary(site);
				// COLD_BINS, or this proves nothing: a warm `page`/`dynamic_page_cache` serves the
				// anonymous front page without rendering it, so the flash bag is never consulted and
				// the test passes with the whole of `resetSession()` disabled -- measured
				const anon = await renderWith(site, '/', COLD_BINS);
				const target = String(saved['location'] ?? '/').replace(/^https?:\/\/[^/]+/, '');
				const own = await renderWith(site, target, COLD_BINS, jar);
				return {
					savedStatus: saved['status'],
					queued: queued['messages'],
					anonUid: anon['uid'],
					anonHtml: html(anon),
					ownUid: own['uid'],
					ownHtml: html(own)
				};
			});

			// the setup must really have queued a message, or the anonymous assertion is vacuous
			expect(out.savedStatus).toBe(303);
			expect(out.queued, 'a save must queue one status message').toEqual({ status: 1 });

			expect(out.anonUid).toBe(0);
			expect(out.anonHtml, 'the next visitor must not be told about it').not.toContain(
				'has been created'
			);
			expect(out.anonHtml).not.toContain('Sweep Probe Node');

			expect(out.ownUid).toBe(1);
			expect(out.ownHtml, 'and the author must still be').toContain('has been created');
		},
		REQUEST_TIMEOUT
	);

	/**
	 * ONE VISITOR IS SHOWN ANOTHER'S STATUS MESSAGE, once the session is left open. Fixed 2026-08-20.
	 *
	 * `loadSession()` binds each bag BY REFERENCE, and a session left open never reaches it again,
	 * so the flash bag stays on the previous visitor's array. Measured with both resets disabled:
	 * an anonymous `/` came back 19,198 bytes carrying the author's message. No ordinary request
	 * reaches the precondition, so `LEAK_OPEN_SESSION` manufactures it.
	 *
	 * TWO INDEPENDENT RESETS COVER IT, so falsifying this means disabling both. See
	 * TECHNICAL_REPORT.md for the mechanism and the blast radius.
	 */
	it(
		'does not hand the next visitor a message from a session the previous request left open',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await provision(site);
				const { jar, fields } = await adminWithForm(site);
				const saved = await render(
					site,
					'/node/add/page',
					formPost(encodeForm({ ...fields, ...NODE_BODY }), jar)
				);
				const queued = await boundary(site);
				const hazard = await site.runJson(LEAK_OPEN_SESSION);
				const anon = await renderWith(site, '/', COLD_BINS);
				const target = String(saved['location'] ?? '/').replace(/^https?:\/\/[^/]+/, '');
				const own = await renderWith(site, target, COLD_BINS, jar);
				return {
					savedStatus: saved['status'],
					queued: queued['messages'],
					hazard,
					anonUid: anon['uid'],
					anonHtml: html(anon),
					anonSession: (anon['reset'] as Payload | null)?.['session'],
					ownUid: own['uid'],
					ownHtml: html(own)
				};
			});

			// the setup must really have queued a message AND really have left the session open,
			// or both halves below are vacuous
			expect(out.savedStatus).toBe(303);
			expect(out.queued, 'a save must queue one status message').toEqual({ status: 1 });
			expect(
				out.hazard,
				'the probe must leave the session open with the message in it'
			).toMatchObject({ ok: true, started: true, closed: false, flashes: { status: 1 } });

			expect(out.anonUid).toBe(0);
			expect(out.anonHtml, 'the next visitor must not be told about it').not.toContain(
				'has been created'
			);
			expect(out.anonHtml, 'nor be given the title of what was created').not.toContain(
				'Sweep Probe Node'
			);

			// the half a naive drain breaks: the author must still get what they earned
			expect(out.ownUid).toBe(1);
			expect(out.ownHtml, 'and the author must still be').toContain('has been created');

			// LAST, after the disclosure: removing a reset must fail on the leak rather than on the
			// bookkeeping that reports the reset ran
			expect(out.anonSession).toMatchObject({
				storage: [
					'session_manager.started',
					'session_manager.closed',
					'session_manager.startedLazy'
				],
				bags: ['_sf2_attributes', '_symfony_flashes', '_sf2_meta']
			});
		},
		REQUEST_TIMEOUT
	);
});

describe('process globals that outlive the script', () => {
	/**
	 * PHP's output-buffer stack belongs to the interpreter, not to the script.
	 *
	 * On a real SAPI request shutdown pops and flushes every level, so a handler that forgets its
	 * `ob_end_clean()` costs one response. Measured here, two levels left open by one fragment were
	 * still open at the start of the next -- which would send the whole of the next response into a
	 * buffer nobody will close, and the host would read nothing at all.
	 *
	 * Two assertions, and the first is what makes the second mean anything: the hazard is real (the
	 * levels do survive), and `RequestResetter::closeOutputBuffers()` closes them. The shipping
	 * render path leaks none of its own -- `renderPage()` records `ob_get_level()` before its
	 * `ob_start()` and unwinds to it on a throw -- so without the leak probe this would be a test
	 * that cannot fail.
	 */
	it(
		'closes output buffers a previous request left open',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await provision(site);
				await render(site, '/');
				const leaked = await site.runJson(leakOutputBuffer(2));
				const survived = await boundary(site);
				// the boundary probe clears what it reports, so the leak is made again for the render
				await site.runJson(leakOutputBuffer(2));
				const next = await render(site, '/');
				return {
					opened: leaked['opening'],
					survived: survived['obLevel'],
					closed: (next['reset'] as Payload | null)?.['output_buffers_closed'],
					status: next['status'],
					bytes: html(next).length,
					atRest: (await boundary(site))['obLevel']
				};
			});

			expect(out.opened).toBe(2);
			expect(out.survived, 'the hazard is real: the stack crosses the script boundary').toBe(
				2
			);
			expect(out.closed, 'and the resetter closes exactly what was left').toBe(2);
			expect(out.status, 'so the next response is delivered rather than swallowed').toBe(200);
			expect(out.bytes).toBeGreaterThan(1000);
			expect(out.atRest, 'a render of its own leaves none').toBe(0);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * A TRANSACTION LEFT OPEN USED TO SILENCE EVERY LATER WRITE. Fixed 2026-08-20; regression test.
	 *
	 * **THE MECHANISM: `cfw_do_sqlite\Connection::$buffer`, on a connection `Database::$connections`
	 * holds forever.** The driver withholds writes while a Drupal transaction is open and replays
	 * them at commit, because `ctx.storage.sql` refuses BEGIN. A script that ends between
	 * `startTransaction()` and the commit leaves the buffer open: on a real SAPI the Transaction
	 * object is destructed and `TransactionManagerBase` rolls back, and here the symbol table
	 * survives the script so the destructor never runs.
	 *
	 * Measured before the fix: after the halt, `isBuffering()` was TRUE, the NEXT render answered
	 * 200 with the same 17,670 bytes as a clean one, `isBuffering()` was still TRUE afterwards, host
	 * transactions had not moved and the row the halted script wrote was not in the database.
	 * Nothing about that request looks wrong from outside and every write it made was discarded.
	 *
	 * `Connection::discardOrphanedTransaction()` in the `rom` sibling drops the buffer AND Drupal's
	 * own stack -- dropping only the buffer leaves the next `startTransaction()` recording a
	 * savepoint into something that no longer exists, which throws `UncommittedStateException`.
	 * `RequestResetter` calls it at the boundary, on connections that are already open.
	 *
	 * BLAST RADIUS while it was live: silent write loss for the life of the object. Sessions never
	 * persisted, so logins stopped sticking; cache writes never landed, so every render recomputed;
	 * a node save reported success and saved nothing. No cross-user disclosure.
	 */
	it(
		'discards a transaction a halted request left open, and lets the next write land',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await provision(site);
				await render(site, '/');
				const opened = await site.runJson(abandonTransaction('scope'));
				const orphaned = await boundary(site);
				const next = await render(site, '/');
				const settled = await boundary(site);
				// a real write AFTER the boundary; withheld into a live buffer it would never appear
				const carol = await site.runJson(createUser({ name: 'carol', pass: PASS }));
				return {
					openedBuffering: opened['buffering'],
					orphaned: orphaned['db'],
					discarded: (next['reset'] as Payload | null)?.['transaction'],
					nextStatus: next['status'],
					settled: settled['db'],
					carolOk: carol['ok'],
					// written inside the doomed transaction, so it must NOT have survived
					probeRows: await countRows(
						site,
						"SELECT COUNT(*) AS c FROM key_value WHERE name = 'cfw_orphan_probe'"
					),
					carolRows: await countRows(
						site,
						"SELECT COUNT(*) AS c FROM users_field_data WHERE name = 'carol'"
					)
				};
			});

			// the setup has to really leave one open, or everything below is vacuous
			expect(out.openedBuffering, 'the probe must open a buffer').toBe(1);
			expect((out.orphaned as Payload)['buffering'], 'and it must cross the boundary').toBe(
				1
			);

			expect(out.discarded, 'the resetter must report what it threw away').toMatchObject({
				'default:default': { manager: true }
			});
			expect(
				Number(((out.discarded as Payload)['default:default'] as Payload)['buffered']),
				'and the count must be the statements the halted script buffered'
			).toBeGreaterThan(0);
			expect(out.nextStatus).toBe(200);
			expect((out.settled as Payload)['buffering'], 'nothing left buffering').toBe(0);
			expect((out.settled as Payload)['inTransaction']).toBe(0);

			// both directions: the abandoned write is gone and a later write reaches the database
			expect(out.probeRows, 'the halted transaction must have written nothing').toBe(0);
			expect(out.carolOk).toBe(true);
			expect(out.carolRows, 'and the next write must not be withheld').toBe(1);
		},
		REQUEST_TIMEOUT
	);
});

describe('the blind half: every static property of every declared class', () => {
	/**
	 * Statics that legitimately differ between two interpreters, each with the reason it may.
	 *
	 * This list is the whole judgement in the sweep, so it is named rather than pattern-matched. A
	 * new entry is a claim that a carrier is a pure cache or a per-interpreter identity; anything
	 * else that appears here is a finding.
	 */
	const BENIGN = new Map<string, string>([
		[
			'Drupal\\Component\\DependencyInjection\\ReverseContainer::recordedServices',
			'service ids keyed by spl_object_hash, which differs per interpreter by construction'
		],
		[
			'Drupal\\Component\\FileCache\\FileCache::cached',
			'parsed file contents keyed by filename; a pure function of the file'
		],
		[
			'Drupal\\Component\\FileCache\\FileCacheFactory::prefix',
			'derived from the site hash salt, which is minted per site'
		],
		[
			'Drupal\\Component\\Utility\\Html::classes',
			'cleaned class names keyed by the raw name; a pure function of the input'
		],
		[
			'Drupal\\Component\\Utility\\Html::seenIds',
			'reset at the START of every request, so a residue at the boundary is the last render'
		],
		[
			'Symfony\\Component\\Yaml\\Inline::parsedLineNumber',
			'a parse cursor; its value is how much YAML the object has read'
		],
		[
			'Symfony\\Polyfill\\Mbstring\\Mbstring::iconvSupportsIgnore',
			'a one-time capability probe of the runtime, not of the request'
		],
		['MabeEnum\\Enum::constants', 'enum reflection keyed by class name'],
		['MabeEnum\\Enum::instances', 'enum reflection keyed by class name'],
		['MabeEnum\\Enum::names', 'enum reflection keyed by class name'],
		[
			'Drupal\\views\\Plugin\\views\\display\\Page::pageRenderArray',
			'FOUND AND NOT FIXED: ViewPageController stores the built page on this class static and ' +
				'nothing removes it. Re-verified 2026-08-20 against the shipped tree: ' +
				'setPageRenderArray() has exactly one caller, ViewPageController.php:70, and ' +
				'getPageRenderArray() has NONE, so no shipped code can read the previous ' +
				'visitor. Each views page overwrites it rather than accumulating, so it is ' +
				'retention of one render array. The reason it is worth re-checking when the ' +
				'module set grows is the ampersand -- it is assigned BY REFERENCE, so a contrib ' +
				"reader would get the last visitor's array rather than a copy of it. Its value " +
				'here also depends on whether a warm dynamic_page_cache let the controller run ' +
				'at all, which is why it cannot be compared across two objects'
		]
	]);

	/**
	 * The instrument that found `Renderer::$contextCollection`, run as an assertion.
	 *
	 * Compared on the keys the two objects SHARE. A warm object has loaded more classes, and a
	 * static that exists in one interpreter and not the other is a difference in what was
	 * autoloaded rather than in what was carried across a request.
	 *
	 * What it cannot see, said here rather than left to be discovered: instance state on container
	 * services. `ThemeManager::$activeTheme` is a property on a service, not a class static, and
	 * this half of the sweep is blind to it -- which is why `BOUNDARY_STATE` reads the named
	 * carriers as well.
	 */
	it(
		'carries nothing across the boundary that is not a named cache',
		async () => {
			const warm = await inObject(freshSite(), async (site) => {
				await provision(site);
				await render(site, '/');
				const jar = cookieJar(await login(site, 'admin', PASS));
				await render(site, '/admin/content', { cookie: jar });
				await render(site, '/');
				const aliceJar = cookieJar(await login(site, 'alice', PASS));
				await render(site, '/user/2', { cookie: aliceJar });
				await render(site, '/');
				return boundary(site);
			});
			const cold = await inObject(freshSite(), async (site) => {
				await provision(site);
				await render(site, '/');
				return boundary(site);
			});

			const left = (cold['statics'] ?? {}) as Record<string, string>;
			const right = (warm['statics'] ?? {}) as Record<string, string>;
			const moved = Object.keys(left)
				.filter((key) => key in right && left[key] !== right[key])
				.filter((key) => !BENIGN.has(key));

			// the instrument has to be looking at something, or an empty diff means nothing
			expect(Number(cold['staticCount'])).toBeGreaterThan(90);
			expect(Number(cold['classCount'])).toBeGreaterThan(1500);
			expect(Number(warm['staticSkipped']), 'no class may be unreadable').toBe(0);

			expect(moved, moved.map((k) => `${k}: ${left[k]} -> ${right[k]}`).join('\n')).toEqual(
				[]
			);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * THE RENDER CONTEXT COLLECTION GREW FOREVER. Fixed 2026-08-20; regression test.
	 *
	 * **THE MECHANISM: `Renderer::$contextCollection` is a `protected static SplObjectStorage` keyed
	 * by the Request OBJECT.** `setCurrentRenderContext()` writes into it and nothing ever removes
	 * an entry, so it is correct per request and unbounded across them. Measured over one warm
	 * sequence it read 0, 1, 2, 5, 6 and never went down, against 1 in a fresh object serving the
	 * same page.
	 *
	 * BLAST RADIUS while it was live: memory, not disclosure. Every Request ever served stays
	 * referenced with its cookies, its POST body and its session, against a heap that peaks near
	 * 115 MB on an install -- so the object is evicted sooner the longer it stays up. Nothing reads
	 * a stale entry, because the key is the request that owns it.
	 *
	 * `views\Plugin\views\display\Page::$pageRenderArray` is the same shape, was found by the same
	 * instrument, and is deliberately NOT fixed: it is overwritten by the next views page rather
	 * than accumulating, Drupal 11 core has no reader for it, and clearing it from `drupflare`
	 * means reflection on a class name phpstan cannot resolve. It sits on the benign list above
	 * with that reasoning, which is where a found-and-declined item belongs.
	 */
	it(
		'does not accumulate a render context per request',
		async () => {
			const counts = await inObject(freshSite(), async (site) => {
				await provision(site);
				const seen: unknown[] = [];
				for (let i = 0; i < 4; i++) {
					await render(site, '/');
					seen.push((await boundary(site))['renderContexts']);
				}
				return seen;
			});

			// each reading is what ONE request left behind, so they must agree rather than climb
			expect(counts).toEqual([counts[0], counts[0], counts[0], counts[0]]);
			expect(Number(counts[0])).toBeLessThanOrEqual(2);
		},
		REQUEST_TIMEOUT
	);
});

describe('the instrument itself', () => {
	/**
	 * A seeded service with no `reset()` was skipped in silence, and that is how the theme leak hid.
	 *
	 * `RequestResetter` gates on `method_exists($service, 'reset')`. Ten of the thirteen ids on its
	 * seed list do not have one: four are handled by name elsewhere in the class, and six were doing
	 * nothing at all while reading, from the seed list, as handled. The log now names them.
	 *
	 * Read off the SECOND render rather than the first, and that is a real property rather than
	 * convenience: the resetter runs before `$kernel->handle()`, so on the first request of an
	 * object the middleware chain does not exist yet and `page_cache_cid_cleared` is legitimately 0.
	 */
	it(
		'says which seeded services it could not reset',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await provision(site);
				await render(site, '/');
				const second = await render(site, '/');
				return { reset: second['reset'], audit: (await boundary(site))['resetAudit'] };
			});
			const log = out.reset as Payload;
			const audit = out.audit as Record<string, string>;

			// the three that really do reset, and the log must name them
			expect(log['services']).toEqual([
				'entity.memory_cache',
				'cache.static',
				'language_manager'
			]);

			// and every id the loop passed over must appear rather than vanish
			const skipped = log['skipped'] as string[];
			expect(skipped).toContain('theme.manager');
			expect(skipped).toContain('renderer');

			// the audit read from the container agrees with what the resetter reported, so neither
			// side is describing a list the other does not have
			for (const id of skipped) expect(audit[id], id).toBe('no-reset');
			for (const id of log['services'] as string[]) expect(audit[id], id).toBe('reset');

			// the carriers the loop cannot reach are handled by name, and the log proves each ran
			expect(log['theme'], 'theme.manager, by resetActiveTheme()').toBeDefined();
			expect(log['collectors']).toMatchObject({
				'library.discovery': true,
				'menu.active_trail': true,
				'library.dependency_resolver': true
			});
			expect(log['identity']).toMatchObject({ after: 0 });
			expect(log['session']).toMatchObject({
				bags: ['_sf2_attributes', '_symfony_flashes', '_sf2_meta']
			});
			expect(log['form_errors_reset']).toBe(true);
			expect(log['html_seen_ids_reset']).toBe(true);
			expect(Number(log['page_cache_cid_cleared'])).toBeGreaterThan(0);
			expect(Number(log['render_contexts_dropped'])).toBeGreaterThanOrEqual(0);
			expect(log['output_buffers_closed'], 'a clean render leaks no buffer').toBe(0);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * The control for every byte comparison above: a warm render cache changes the bytes on its own.
	 *
	 * An authenticated admin page came back 118,936 bytes on its first pass in an object and 95,215
	 * on the second, same user, same cookie, nothing in between -- BigPipe placeholders and their
	 * no-JS fallbacks, which a warm `dynamic_page_cache` makes unnecessary. Emptying the bins each
	 * time, the difference is gone.
	 *
	 * Without this the theme tests would be quoting a number that moves for a reason that has
	 * nothing to do with state carried across a boundary, and the first byte-diff harness written
	 * here reported exactly that as a leak.
	 */
	it(
		'is measuring carried state and not cache warmth',
		async () => {
			const emptied = await inObject(freshSite(), async (site) => {
				await provision(site);
				const jar = cookieJar(await login(site, 'admin', PASS));
				const seen: number[] = [];
				for (let i = 0; i < 3; i++) {
					seen.push(
						html(await renderWith(site, '/admin/content', COLD_BINS, jar)).length
					);
				}
				return seen;
			});
			const kept = await inObject(freshSite(), async (site) => {
				await provision(site);
				const jar = cookieJar(await login(site, 'admin', PASS));
				return [
					html(await renderWith(site, '/admin/content', [], jar)).length,
					html(await renderWith(site, '/admin/content', [], jar)).length
				];
			});

			// with the bins emptied the page is stable; the residual jitter is the form build id
			const [first = 0, ...rest] = emptied;
			for (const bytes of rest) expect(Math.abs(bytes - first)).toBeLessThan(100);

			// and left warm it is not, by more than 20 KB, which is the confound being pinned
			const [warmFirst = 0, warmSecond = 0] = kept;
			expect(warmFirst - warmSecond).toBeGreaterThan(20_000);
		},
		REQUEST_TIMEOUT
	);
});
