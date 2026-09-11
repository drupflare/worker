import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ADMIN_COOKIE } from '../../src/ops/admin-session';
import worker, { routeTable } from '../../src/site';
import {
	ADMIN_PAGES,
	LOGIN_PATH,
	LOGOUT_PATH,
	OPERATE_ACTIONS,
	SURFACE_PREFIX,
	renderOperate,
	renderShell
} from '../../src/ui/admin';

/**
 * The seven `/_cfw` pages, driven through the front worker rather than through their renderers.
 *
 * NOTHING TESTED THESE AT THE ROUTE LEVEL AND ONE OF THEM WAS BROKEN ON EVERY INPUT. The Extend page
 * proxies to `/__installable`; it sent `name` and the route has always read `module`, so every query
 * ran against the empty string, `checkInstallable('')` failed the name check, and the page answered
 * `not-found` for every package that exists. It also read `body.newest` where `InstallVerdict` names
 * the field `version`, so the version column was permanently blank.
 *
 * `tests/unit/ui/admin.spec.ts` covers the renderers with hand-built rows and passed throughout. This
 * is the same shape as the `/fleet` defect the serve-edge spec already pins: every function green,
 * the route answering nothing to every caller. A renderer test cannot see a field-name mismatch in
 * the proxy that feeds it.
 */

const DIAG = { ...env, PW_DIAGNOSTICS: '1' } as unknown as typeof env;

/** what the spy object accepts as this site's owner token */
const TOKEN = 'owner-token-for-the-spy';

/** a namespace that records what the pages asked it for and answers each route plausibly */
function objectSpy(answers: Record<string, unknown> = {}) {
	const seen: URL[] = [];
	const auth: (string | null)[] = [];
	return {
		seen,
		auth,
		namespace: {
			idFromName: (name: string) => ({ name, toString: () => name }),
			newUniqueId: () => ({ toString: () => 'unique' }),
			get: () => ({
				fetch: async (r: Request) => {
					const url = new URL(r.url);
					seen.push(url);
					auth.push(r.headers.get('authorization'));
					if (url.pathname === '/__ownercheck') {
						return new Response(null, {
							status: r.headers.get('authorization') === `Bearer ${TOKEN}` ? 200 : 401
						});
					}
					const body = answers[url.pathname] ?? {};
					return Response.json(body);
				}
			})
		}
	};
}

type PageOptions = {
	overrides?: Record<string, unknown>;
	/** omitted means an operator who has not signed in */
	token?: string | null;
	method?: string;
	body?: string;
};

async function page(path: string, namespace: unknown, options: PageOptions = {}) {
	const { overrides = {}, token = TOKEN, method = 'GET', body } = options;
	const headers: Record<string, string> = {};
	if (token !== null) headers.cookie = `${ADMIN_COOKIE}=${encodeURIComponent(token)}`;
	if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`https://cfw.local${path}`, { method, headers, body }),
		{ ...DIAG, SITE: namespace, ...overrides } as unknown as typeof env,
		ctx
	);
	const text = await res.text();
	await waitOnExecutionContext(ctx);
	return {
		status: res.status,
		body: text,
		location: res.headers.get('location'),
		setCookie: res.headers.get('set-cookie')
	};
}

describe('every admin page answers', () => {
	it.each(ADMIN_PAGES.map((p) => [p.label, p.path] as const))(
		'%s renders HTML with its own nav',
		async (label, path) => {
			const spy = objectSpy();
			const out = await page(path, spy.namespace);
			expect(out.status).toBe(200);
			expect(out.body).toContain('<!doctype html>');
			// the shell carries a link to every other page, so a page that rendered an error string
			// with a 200 fails here rather than passing on the status alone
			for (const other of ADMIN_PAGES) expect(out.body).toContain(other.path);
			expect(out.body).toContain(label);
		}
	);

	it('reaches the object as the owner rather than anonymously', async () => {
		// the Git page's remotes and the Access page's issuer both come from routes that check the
		// token again inside the object; without the header they answered 401 and the pages rendered
		// "No remotes yet" and "Not Configured", which is a wrong answer that looks like a state
		const spy = objectSpy({ '/__git': { ok: true, remotes: [] } });
		await page(`${SURFACE_PREFIX}/git`, spy.namespace);
		const asked = spy.seen.findIndex((u) => u.pathname === '/__git');
		expect(asked, 'the page never reached /__git').toBeGreaterThanOrEqual(0);
		expect(spy.auth[asked]).toBe(`Bearer ${TOKEN}`);
	});
});

/**
 * The credential, which the surface did not have.
 *
 * `PW_DIAGNOSTICS=1` was the ONLY way in, and it is one boolean that also opens `/sql` and `/php` --
 * so the pages that install code were reachable by anybody who could reach a worker with the flag on.
 * Each button then called `window.prompt('Owner token')` and sent whatever was typed as a bearer, and
 * with the flag on nothing compared it to anything, so any string worked. The Access page's Configure
 * form could not work in either state: a plain HTML POST has nowhere to put a bearer token.
 */
describe('the surface takes the owner token', () => {
	it.each(ADMIN_PAGES.map((p) => [p.label, p.path] as const))(
		'%s redirects an operator who has not signed in',
		async (_label, path) => {
			const out = await page(path, objectSpy().namespace, { token: null });
			expect(out.status).toBe(302);
			expect(out.location).toContain(LOGIN_PATH);
			// so the browser comes back where it was going
			expect(out.location).toContain(encodeURIComponent(path));
		}
	);

	it('refuses a cookie carrying the wrong token', async () => {
		const out = await page(SURFACE_PREFIX, objectSpy().namespace, { token: 'not-the-token' });
		expect(out.status).toBe(302);
	});

	it('is not opened by PW_DIAGNOSTICS, which opens everything else', async () => {
		// THE HOLE. Diagnostics reaches `/sql` and `/php` by design; it must not also reach a surface
		// whose buttons install code, or the credential is decorative wherever the flag is set
		for (const p of ADMIN_PAGES) {
			const out = await page(p.path, objectSpy().namespace, {
				token: null,
				overrides: { PW_DIAGNOSTICS: '1' }
			});
			expect(out.status, p.path).toBe(302);
		}
	});

	it('signs in with the token and hands back a cookie a script cannot read', async () => {
		const out = await page(LOGIN_PATH, objectSpy().namespace, {
			token: null,
			method: 'POST',
			body: new URLSearchParams({ token: TOKEN, next: `${SURFACE_PREFIX}/git` }).toString()
		});
		expect(out.status).toBe(303);
		expect(out.location).toBe(`${SURFACE_PREFIX}/git`);
		expect(out.setCookie).toContain(`${ADMIN_COOKIE}=`);
		expect(out.setCookie).toContain('HttpOnly');
		// the CSRF defence, and it is load-bearing: `/install` acts on a GET
		expect(out.setCookie).toContain('SameSite=Strict');
		expect(out.setCookie).toContain('Secure');
	});

	it('refuses the wrong token and sets no cookie', async () => {
		const out = await page(LOGIN_PATH, objectSpy().namespace, {
			token: null,
			method: 'POST',
			body: new URLSearchParams({ token: 'wrong' }).toString()
		});
		expect(out.status).toBe(401);
		expect(out.setCookie).toBeNull();
		expect(out.body).toContain('owner token');
	});

	it('renders the form to a browser that has not signed in', async () => {
		const out = await page(LOGIN_PATH, objectSpy().namespace, { token: null });
		expect(out.status).toBe(200);
		expect(out.body).toContain('<form method="POST"');
		// the nav is absent, so nothing links to a page the operator cannot open
		expect(out.body).not.toContain(`href="${SURFACE_PREFIX}/git"`);
	});

	it('will not forward to another origin after a successful sign-in', async () => {
		for (const next of [
			'https://evil.example/',
			'//evil.example',
			'/\\evil.example',
			'/user/1'
		]) {
			const out = await page(LOGIN_PATH, objectSpy().namespace, {
				token: null,
				method: 'POST',
				body: new URLSearchParams({ token: TOKEN, next }).toString()
			});
			expect(out.status, next).toBe(303);
			expect(out.location, next).toBe(SURFACE_PREFIX);
		}
	});

	it('signs out by expiring the cookie', async () => {
		const out = await page(LOGOUT_PATH, objectSpy().namespace);
		expect(out.status).toBe(303);
		expect(out.location).toBe(LOGIN_PATH);
		expect(out.setCookie).toContain('Max-Age=0');
	});

	it('lets a bearer token in, so a script does not need a browser', async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new Request(`https://cfw.local${SURFACE_PREFIX}`, {
				headers: { authorization: `Bearer ${TOKEN}` }
			}),
			{ ...env, PW_DIAGNOSTICS: '0', SITE: objectSpy().namespace } as unknown as typeof env,
			ctx
		);
		const body = await res.text();
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(200);
		expect(body).toContain('<!doctype html>');
	});
});

describe('the Extend page asks the object a question it can answer', () => {
	const verdict = {
		name: 'drupal/pathauto',
		version: '1.13.0',
		verdict: 'installable',
		conflicts: [],
		satisfied: ['drupal/token']
	};

	it('sends the parameter the route reads', async () => {
		const spy = objectSpy({ '/__installable': verdict });
		await page(`${SURFACE_PREFIX}/extend?q=drupal%2Fpathauto`, spy.namespace);

		const asked = spy.seen.find((u) => u.pathname === '/__installable');
		expect(asked, 'the page never reached /__installable').toBeDefined();
		// THE DEFECT. `module` is what the route reads; `name` was what the page sent
		expect(asked?.searchParams.get('module')).toBe('drupal/pathauto');
	});

	it('renders the verdict it was given rather than a blank not-found row', async () => {
		const spy = objectSpy({ '/__installable': verdict });
		const out = await page(`${SURFACE_PREFIX}/extend?q=drupal%2Fpathauto`, spy.namespace);
		expect(out.body).toContain('drupal/pathauto');
		expect(out.body).toContain('installable');
		// the version column read `newest`, which no response has ever carried
		expect(out.body).toContain('1.13.0');
		expect(out.body).not.toContain('not-found');
	});

	it('still reports a real refusal', async () => {
		const spy = objectSpy({
			'/__installable': {
				name: 'drupal/nope',
				version: null,
				verdict: 'not-found',
				conflicts: []
			}
		});
		const out = await page(`${SURFACE_PREFIX}/extend?q=drupal%2Fnope`, spy.namespace);
		expect(out.body).toContain('not-found');
	});

	it('asks nothing with an empty query', async () => {
		const spy = objectSpy({ '/__installable': verdict });
		const out = await page(`${SURFACE_PREFIX}/extend`, spy.namespace);
		expect(out.status).toBe(200);
		expect(spy.seen.some((u) => u.pathname === '/__installable')).toBe(false);
	});
});

/**
 * Installing, which the check tier only ever said was possible.
 *
 * `installPackage()` had no caller anywhere in `src/`, `tests/` or `scripts/`, and three comments in
 * `site-do.ts` described it as the host half of `composer require`. There was no composer path at
 * all: `/git` could deliver a module from a remote you control and nothing could fetch one from a
 * registry. `/__installable` said "the Workflow path does the installing" and no Workflow exists.
 */
describe('the install route', () => {
	it('is owner-gated, because it writes code the site did not ship with', async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new Request('https://cfw.local/install?module=drupal/pathauto'),
			{ ...env, PW_DIAGNOSTICS: '0', SITE: objectSpy().namespace } as unknown as typeof env,
			ctx
		);
		await res.text();
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(401);
	});

	it.each(['/install', '/enable', '/installable'])(
		'%s is reachable with an owner token rather than only with diagnostics',
		(path) => {
			// the half that was missing: a production operator could deliver a module through `/git`
			// and had no owner-gated way to install one or to turn one on
			const table = routeTable();
			expect(table.owner.has(path), `${path} is not owner-reachable`).toBe(true);
			expect(table.doRoute[path], `${path} has no DO_ROUTE entry, so it is a 404`).toBeTypeOf(
				'string'
			);
		}
	);
});

describe('the pages that proxy survive an object that will not answer', () => {
	/** signs in, then throws on the route the page came for */
	const deadProxy = {
		idFromName: (name: string) => ({ name, toString: () => name }),
		newUniqueId: () => ({ toString: () => 'unique' }),
		get: () => ({
			fetch: async (r: Request) => {
				if (new URL(r.url).pathname === '/__ownercheck') {
					return new Response(null, {
						status: r.headers.get('authorization') === `Bearer ${TOKEN}` ? 200 : 401
					});
				}
				throw new Error('object unavailable');
			}
		})
	};

	it.each(ADMIN_PAGES.map((p) => [p.label, p.path] as const))(
		'%s still renders',
		async (_label, path) => {
			const out = await page(path, deadProxy);
			expect(out.status).toBe(200);
			expect(out.body).toContain('<!doctype html>');
		}
	);

	it('fails the credential CLOSED when the object cannot answer at all', async () => {
		// a migrating or quarantined object throws on `/__ownercheck` too, and an unavailable object
		// has not said yes -- the alternative is a site whose check is skipped exactly when it is
		// least healthy
		const dead = {
			idFromName: (name: string) => ({ name, toString: () => name }),
			newUniqueId: () => ({ toString: () => 'unique' }),
			get: () => ({
				fetch: async () => {
					throw new Error('object unavailable');
				}
			})
		};
		const out = await page(SURFACE_PREFIX, dead);
		expect(out.status).toBe(302);
		expect(out.location).toContain(LOGIN_PATH);
	});
});

/**
 * The Operate surface, and the gap it closes.
 *
 * ELEVEN OWNER ROUTES REACHED THE PRODUCT WITH NO CONTROL ANYWHERE. Taking your own data out,
 * reading the health ledger, purging your own cache, driving the update chain and replaying the
 * pack were all owner-gated, all documented, all driven by `drangler` -- and unreachable from a
 * browser. Two more were worse: `/pitr` and `/restore` are the backup and recovery pair and sat
 * behind `PW_DIAGNOSTICS`, the same flag that opens arbitrary SQL.
 *
 * These assert the WIRING rather than the markup: every path the page offers has to be an owner
 * route with a `DO_ROUTE` entry, or the button is a 404 with a confident label on it.
 */
describe('the Operate page reaches what it offers', () => {
	it('offers only paths that are owner-reachable and mapped', () => {
		const table = routeTable();
		for (const action of OPERATE_ACTIONS) {
			expect(table.owner.has(action.path), `${action.path} is not owner-reachable`).toBe(
				true
			);
			expect(
				table.doRoute[action.path] ?? (action.path === '/fleet' ? 'worker' : undefined),
				`${action.path} has no DO_ROUTE entry, so the button is a 404`
			).toBeTypeOf('string');
		}
	});

	// the backup story. Named explicitly because the general assertion above would still pass if
	// they were quietly dropped from the page
	it.each(['/pitr', '/export'])('%s is owner-reachable, not diagnostic-only', (p) => {
		expect(routeTable().owner.has(p)).toBe(true);
	});

	// THE OTHER HALF, and it is the control that gives the line above its meaning. `/restore`
	// replays SQL a caller supplies, so it is the same shape as `/sql` rather than the same shape
	// as `/pitr`: a bookmark names a state the platform already holds, a body names one the caller
	// invents. It was promoted with `/pitr` for one commit and `serve-edge.spec.ts` caught it.
	it.each(['/restore', '/sql'])(
		'%s stays diagnostic-only, so the owner tier did not widen',
		(p) => {
			expect(routeTable().owner.has(p)).toBe(false);
		}
	);

	it('renders a control for every declared action, and marks the writes', () => {
		const html = renderOperate();
		for (const action of OPERATE_ACTIONS) {
			expect(html, action.label).toContain(action.label);
			expect(html, action.path).toContain(action.path);
		}
		// a write has to be distinguishable, or a purge reads like a report
		expect(OPERATE_ACTIONS.some((a) => a.writes)).toBe(true);
		expect(OPERATE_ACTIONS.some((a) => !a.writes)).toBe(true);
		expect(html).toContain('data-writes="1"');
		expect(html).toContain('data-writes="0"');
	});

	it('is in the nav, so it is reachable without knowing the URL', () => {
		expect(ADMIN_PAGES.some((p) => p.page === 'operate')).toBe(true);
		expect(renderShell('operate', '', env)).toContain(`${SURFACE_PREFIX}/operate`);
	});
});
