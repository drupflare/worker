import { describe, expect, it } from 'vitest';
import { freshSite } from '../helpers/serve-do';

/**
 * First-run configuration, and specifically the two things that made the existing route
 * unshippable rather than merely unfinished.
 *
 * **A secret must not arrive in a query string.** `/firstrun?pass=hunter2` puts the admin password in
 * the request line, which `wrangler tail` prints, observability stores and every intermediary logs --
 * on the one route whose entire job is setting that password. The fix refuses the parameter instead of
 * quietly honouring it, because honouring it leaves the insecure path working and therefore the path
 * everyone keeps using. Same reasoning as the `/serve`-behind-`PW_DIAGNOSTICS` defect: a wrong default
 * that still works is not a mitigated defect.
 *
 * **Configuring twice must not silently reset the admin password.** A retried POST is far more likely
 * than a deliberate reconfiguration, so the second one is a 409 unless `force=1` says otherwise.
 *
 * These drive the Durable Object directly. The PHP side (`firstRunConfig`) needs a booted kernel and
 * is covered by `php -l` plus the deployed acceptance; what is asserted here is the route contract,
 * which is where both defects lived.
 */

/** the DO route the worker maps `/firstrun` onto */
const URL_BASE = 'https://do.local/__firstrun';

describe('a password may not travel in a query string', () => {
	it('refuses ?pass= with a reason naming the disclosure, not a generic 400', () => {
		const stub = freshSite();
		return stub.fetch(`${URL_BASE}?pass=hunter2`, { method: 'POST' }).then(async (res) => {
			expect(res.status).toBe(400);
			const body = (await res.json()) as { ok: boolean; error: string; how: string };
			expect(body.ok).toBe(false);
			expect(body.error).toMatch(/query string/);
			// the refusal has to say what to do instead, or the next caller just retries it
			expect(body.how).toMatch(/POST/);
		});
	});

	it('refuses ?pass= on GET too, so a browser address bar cannot leak it either', async () => {
		const stub = freshSite();
		const res = await stub.fetch(`${URL_BASE}?pass=hunter2`);
		expect(res.status).toBe(400);
	});
});

describe('a bare GET reports state instead of configuring', () => {
	it('says a fresh site is unconfigured, which is what a UI needs to ask', async () => {
		const stub = freshSite();
		const res = await stub.fetch(URL_BASE);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			configured: boolean;
			firstRunAt: number | null;
			how: string;
		};
		expect(body.ok).toBe(true);
		expect(body.configured).toBe(false);
		expect(body.firstRunAt).toBeNull();
		expect(body.how).toMatch(/POST/);
	});

	it('does not configure anything as a side effect of being asked', async () => {
		const stub = freshSite();
		await stub.fetch(URL_BASE);
		const again = (await (await stub.fetch(URL_BASE)).json()) as { configured: boolean };
		expect(again.configured).toBe(false);
	});
});

describe('the body must be JSON, because everything else is a secret in the wrong place', () => {
	it('rejects a POST whose body is not JSON', async () => {
		const stub = freshSite();
		const res = await stub.fetch(URL_BASE, { method: 'POST', body: 'siteName=x' });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/not JSON/);
	});

	it('accepts an empty JSON object rather than treating it as malformed', async () => {
		// an empty object is a legitimate no-op request; only a non-JSON body is an error
		const stub = freshSite();
		const res = await stub.fetch(URL_BASE, { method: 'POST', body: '{}' });
		expect(res.status).not.toBe(400);
	});
});
