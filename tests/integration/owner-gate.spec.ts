import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	OWNER_FAIL_LIMIT,
	OWNER_FAIL_WINDOW_MS,
	resetOwnerFailures
} from '../../src/ops/admin-session';
import { KV_OVERRIDABLE } from '../../src/ops/plan';
import worker, { routeTable } from '../../src/site';
import { provisionedNamedSite } from '../helpers/serve-do';

/**
 * The owner credential, asserted with the diagnostic flag OFF.
 *
 * `vitest.config.ts` binds `PW_DIAGNOSTICS: '1'` for the whole workers project, and that flag makes
 * the front worker skip the credential check on every owner route that is not a product surface. So
 * every spec in this lane -- 4,000-odd of them -- ran against a worker whose authentication was
 * disabled, and the gate itself was unassertable: a spec expecting 401 would have failed, so nobody
 * wrote one, and the routes that install code and export a database had no test saying they are
 * closed.
 *
 * These call the worker directly with an env that omits the flag, which is the only way to see the
 * shipping behaviour from inside this project. `SELF.fetch()` cannot: it carries the pool's own
 * bindings, flag included.
 */

const TIMEOUT = 900_000;
const SITE = 'ownergate.example';

/**
 * The budget is module state in the worker's own isolate, which this lane shares.
 *
 * Without the reset a file that exhausts it leaves every later spec refused before the object is
 * ever asked, which reads as an authentication failure rather than as leaked state.
 */
beforeEach(() => resetOwnerFailures());

/** the front worker with the diagnostic flag absent, which is how it is deployed */
async function guarded(path: string, init: RequestInit = {}): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`https://cfw.local${path}?site=${SITE}`, init),
		{ ...env, PW_DIAGNOSTICS: undefined } as unknown as typeof env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return res;
}

/** and with it on, which is what every other spec in this lane silently gets */
async function diagnostic(path: string): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`https://cfw.local${path}?site=${SITE}`),
		{ ...env, PW_DIAGNOSTICS: '1' } as unknown as typeof env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return res;
}

describe('an owner route refuses a caller with no credential', () => {
	it(
		'answers 401 with a challenge on every non-surface owner route',
		async () => {
			await provisionedNamedSite(SITE);
			const { owner } = routeTable();
			// the product surfaces answer a redirect to the sign-in page instead, and are covered
			// by the case below; everything else is an API and gets a 401
			const api = [...owner].filter((p) => !p.startsWith('/_cfw'));
			expect(api.length, 'the owner route set is empty').toBeGreaterThan(10);

			for (const path of api) {
				const res = await guarded(path);
				expect(res.status, `${path} did not refuse an anonymous caller`).toBe(401);
				expect(
					res.headers.get('www-authenticate'),
					`${path} refused without saying how to authenticate`
				).toContain('Bearer');
			}
		},
		TIMEOUT
	);

	it(
		'redirects a browser on a product surface rather than answering text',
		async () => {
			await provisionedNamedSite(SITE);
			const surfaces = [...routeTable().owner].filter((p) => p.startsWith('/_cfw'));
			expect(surfaces.length, 'no product surface in the owner set').toBeGreaterThan(0);

			for (const path of surfaces) {
				const res = await guarded(path);
				expect(res.status, `${path} did not redirect`).toBe(302);
				const to = res.headers.get('location') ?? '';
				expect(to, `${path} redirected nowhere useful`).toContain('next=');
			}
		},
		TIMEOUT
	);

	it(
		'refuses a wrong bearer token as firmly as no token',
		async () => {
			await provisionedNamedSite(SITE);
			const res = await guarded('/export', {
				headers: { authorization: 'Bearer not-the-owner-token' }
			});
			expect(res.status).toBe(401);
		},
		TIMEOUT
	);

	/**
	 * The control, and the point of the file.
	 *
	 * With the flag on the same request is NOT refused. That is what the rest of this lane runs
	 * against, so without this pair a reader cannot tell whether the assertions above measure the
	 * gate or measure the flag.
	 */
	it(
		'is exactly what PW_DIAGNOSTICS turns off',
		async () => {
			await provisionedNamedSite(SITE);
			const closed = await guarded('/export');
			const open = await diagnostic('/export');
			expect(closed.status).toBe(401);
			expect(open.status).not.toBe(401);
		},
		TIMEOUT
	);

	it(
		'never opens a product surface, however the flag is set',
		async () => {
			await provisionedNamedSite(SITE);
			const surface = [...routeTable().owner].find((p) => p.startsWith('/_cfw'));
			expect(surface, 'no product surface to check').toBeTruthy();
			// the one part of the owner set the flag does not reach: these pages install code
			const open = await diagnostic(surface as string);
			expect(open.status).toBe(302);
		},
		TIMEOUT
	);
});

/**
 * The failure budget, which is checked BEFORE the object hop.
 *
 * The token is 32 CSPRNG bytes compared in constant time, so guessing it is not a practical
 * attack; what was free was the COST of guessing. Every presented token -- right or wrong --
 * cost one Durable Object request, which is the meter the whole free-plan model is scored
 * against, so an unauthenticated client could drive a site to read-only at one DO request per
 * HTTP request.
 *
 * The guard is what removes that amplification, and it was asserted by nothing: the branch at
 * `site.ts`'s `ownerCredential()` never executed in any lane.
 */
describe('a wrong token is refused before it can spend the meter', () => {
	/** one wrong bearer from a named client, so the budget has a key to count against */
	const wrong = (ip: string) =>
		guarded('/export', {
			headers: { authorization: 'Bearer not-the-owner-token', 'cf-connecting-ip': ip }
		});

	it(
		'stops asking the object once a client has spent its budget',
		async () => {
			await provisionedNamedSite(SITE);
			const ip = '203.0.113.7';
			// every one of these is refused, which is the same answer the budget gives -- so the
			// STATUS cannot distinguish them and the assertion below is about the ceiling instead
			for (let i = 0; i < OWNER_FAIL_LIMIT + 4; i++) {
				expect((await wrong(ip)).status, `attempt ${i + 1}`).toBe(401);
			}
			// and the refusal is now instant: the guard returns before `siteFor()` and before any
			// stub is constructed. Asserted through the budget's own reader rather than by timing,
			// because a wall-clock threshold is a magnitude and this lane has no stable one
			const { ownerRefusedForNow } = await import('../../src/ops/admin-session');
			expect(ownerRefusedForNow(ip, Date.now())).toBe(true);
		},
		TIMEOUT
	);

	it(
		'counts per client, so one attacker cannot lock out an operator',
		async () => {
			await provisionedNamedSite(SITE);
			const attacker = '198.51.100.9';
			for (let i = 0; i < OWNER_FAIL_LIMIT + 1; i++) await wrong(attacker);

			const { ownerRefusedForNow } = await import('../../src/ops/admin-session');
			expect(ownerRefusedForNow(attacker, Date.now())).toBe(true);
			// a different address has spent nothing
			expect(ownerRefusedForNow('192.0.2.5', Date.now())).toBe(false);
		},
		TIMEOUT
	);

	it(
		'forgets a client once the window passes, so the refusal is not permanent',
		async () => {
			await provisionedNamedSite(SITE);
			const ip = '203.0.113.99';
			for (let i = 0; i < OWNER_FAIL_LIMIT + 1; i++) await wrong(ip);

			const { ownerRefusedForNow } = await import('../../src/ops/admin-session');
			const now = Date.now();
			expect(ownerRefusedForNow(ip, now)).toBe(true);
			expect(ownerRefusedForNow(ip, now + OWNER_FAIL_WINDOW_MS + 1)).toBe(false);
		},
		TIMEOUT
	);

	/**
	 * A CLIENT PRESENTING NOTHING IS NOT COUNTED, and that separation is load bearing.
	 *
	 * `ownerCredential()` returns before the budget when no token was presented at all, so an
	 * ordinary anonymous visitor hitting an owner route -- a crawler, a health check -- can never
	 * exhaust a budget and lock out the operator sharing its address.
	 */
	it(
		'does not count a caller who presented no token at all',
		async () => {
			await provisionedNamedSite(SITE);
			const ip = '203.0.113.150';
			for (let i = 0; i < OWNER_FAIL_LIMIT + 5; i++) {
				await guarded('/export', { headers: { 'cf-connecting-ip': ip } });
			}
			const { ownerRefusedForNow } = await import('../../src/ops/admin-session');
			expect(ownerRefusedForNow(ip, Date.now())).toBe(false);
		},
		TIMEOUT
	);
});

/**
 * `/settings`, the write side of the KV levers.
 *
 * `resolvePlan()` and `resolveSettings()` had read the `plan` and `settings` keys since they
 * shipped and nothing in `src/` ever called `CONFIG_KV.put()`, so every name on `KV_OVERRIDABLE`
 * was a knob that could only be turned by editing `wrangler.jsonc` and redeploying. This drives
 * the writer, and the allow-list is enforced HERE rather than only at the reader: a reader-side
 * filter makes an unlisted name inert, a writer-side one makes it unstorable.
 */
describe('the runtime levers are writable, within the allow-list', () => {
	/** the route with the diagnostic flag on, which is the only way to reach a writer in this lane */
	const settings = async (init: RequestInit = {}): Promise<Response> => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new Request(`https://cfw.local/settings?site=${SITE}`, init),
			{ ...env, PW_DIAGNOSTICS: '1' } as unknown as typeof env,
			ctx
		);
		await waitOnExecutionContext(ctx);
		return res;
	};

	const put = (body: unknown) =>
		settings({
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});

	it(
		'reports every lever with the value in force AND where it came from',
		async () => {
			const res = await settings();
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				ok: boolean;
				plan: { plan: string };
				levers: { name: string; value: unknown; source: string }[];
			};
			expect(body.ok).toBe(true);
			// EVERY name, including the ones with no override: a caller renders the whole surface
			// from one response rather than having to know the list
			expect(body.levers.map((l) => l.name).sort()).toEqual([...KV_OVERRIDABLE].sort());
			for (const lever of body.levers) {
				expect(['kv', 'var', 'default'], lever.name).toContain(lever.source);
			}
			expect(body.plan.plan).toBeTruthy();
		},
		TIMEOUT
	);

	it(
		'stores a listed lever and reports it as sourced from kv afterwards',
		async () => {
			const name = 'RENDER_BUDGET_MS';
			const wrote = await put({ [name]: '4321' });
			expect(wrote.status).toBe(200);
			expect(((await wrote.json()) as { ok: boolean }).ok).toBe(true);

			const after = (await (await settings()).json()) as {
				levers: { name: string; value: unknown; source: string }[];
			};
			const lever = after.levers.find((l) => l.name === name);
			expect(lever?.value).toBe('4321');
			expect(lever?.source).toBe('kv');

			// a listed name with a value outside its domain is reported and not stored
			const bad = (await (await put({ [name]: 'written-by-the-spec' })).json()) as {
				invalid: { name: string }[];
			};
			expect(bad.invalid.map((i) => i.name)).toEqual([name]);
			const kept = (await (await settings()).json()) as {
				levers: { name: string; value: unknown }[];
			};
			expect(kept.levers.find((l) => l.name === name)?.value).toBe('4321');
		},
		TIMEOUT
	);

	/**
	 * THE ALLOW-LIST IS A PRIVILEGE BOUNDARY. `KV_OVERRIDABLE`'s own docblock names what a stored
	 * `PW_DIAGNOSTICS` would reach: `/sql` and `/restore`. So an unlisted name must not be
	 * storable, not merely ignored on the way out.
	 */
	it(
		'refuses to STORE an unlisted name rather than making it inert',
		async () => {
			const res = await put({ PW_DIAGNOSTICS: '1', NOT_A_LEVER: 'x' });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { ok: boolean; refused?: string[] };
			expect(body.ok).toBe(true);
			// NAMED in the reply rather than dropped in silence: a caller that set a knob has to
			// learn it was refused, or it reads as stored and inert
			expect(body.refused ?? []).toEqual(
				expect.arrayContaining(['PW_DIAGNOSTICS', 'NOT_A_LEVER'])
			);

			const after = (await (await settings()).json()) as { levers: { name: string }[] };
			expect(after.levers.map((l) => l.name)).not.toContain('PW_DIAGNOSTICS');
		},
		TIMEOUT
	);

	/**
	 * `PLAN` HAS ITS OWN KEY AND ITS OWN AUTHORISATION. Every other name on the list has a worst
	 * case of "a slow site"; `PLAN` selects a whole limits profile, and the quotas it models are
	 * ACCOUNT-WIDE while any actor setting it is one tenant.
	 */
	it(
		'validates PLAN rather than storing whatever it is handed',
		async () => {
			const res = await put({ PLAN: 'enterprise' });
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toContain('PLAN must be');
		},
		TIMEOUT
	);

	it(
		'never lets PLAN through the lever writer, at any spelling',
		async () => {
			await put({ plan: 'paid' });
			const after = (await (await settings()).json()) as { levers: { name: string }[] };
			expect(after.levers.map((l) => l.name)).not.toContain('PLAN');
			expect(after.levers.map((l) => l.name)).not.toContain('plan');
		},
		TIMEOUT
	);

	it(
		'refuses a body that is not a JSON object, and says which',
		async () => {
			const notJson = await settings({ method: 'PUT', body: 'not json at all' });
			expect(notJson.status).toBe(400);
			expect(((await notJson.json()) as { error: string }).error).toContain('not JSON');

			const array = await put(['a', 'b']);
			expect(array.status).toBe(400);
			expect(((await array.json()) as { error: string }).error).toContain('JSON object');
		},
		TIMEOUT
	);

	it(
		'refuses a method that is neither a read nor a write',
		async () => {
			const res = await settings({ method: 'DELETE' });
			expect(res.status).toBe(405);
		},
		TIMEOUT
	);

	// the route is owner-only and has NO DO_ROUTE entry: CONFIG_KV is a front-worker binding, so
	// an object hop would spend a Durable Object request to reach a namespace this isolate holds
	it(
		'is an owner route answered by the worker, with no object hop',
		async () => {
			expect([...routeTable().owner]).toContain('/settings');
			const res = await guarded('/settings');
			expect(res.status).toBe(401);
		},
		TIMEOUT
	);
});
