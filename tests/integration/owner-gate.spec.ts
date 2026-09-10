import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
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
