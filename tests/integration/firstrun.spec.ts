import { describe, expect, it } from 'vitest';
import { OWNER_TOKEN_KEY } from '../../src/ops/site-secrets';
import { freshSite, inObject } from '../helpers/serve-do';

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
 * than an intended reconfiguration, so the second one is a 409 unless `force=1` says otherwise.
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

/**
 * Provisioning is trust-on-first-use, and the claim window has to actually close.
 *
 * `/firstrun` is reachable WITHOUT `PW_DIAGNOSTICS=1` because the owner token is minted here and
 * nowhere else, and that token is what `/export` takes. While this route was diagnostic-gated the
 * only way to obtain it was to expose `/sql`, `/restore` and `/php` to the internet first -- so the
 * supported way to take your own data out was to open a remote shell.
 *
 * The trade is a claim window on an UNPROVISIONED site. What must hold is that it is the only
 * window: once `first_run_at` is set, `?force=1` resets the admin password and therefore needs the
 * token. These drive the object directly, which is where the check lives -- a gate in the Worker in
 * front is a second place to get it right, not the place it has to be right.
 */
describe('the trust-on-first-use window closes once the site is provisioned', () => {
	/**
	 * Marks the site provisioned without booting a kernel; `first_run_at` is the whole state.
	 *
	 * Turns `PW_DIAGNOSTICS` OFF, because the pool sets it to `1` and diagnostics is
	 * still a way past this check -- it already exposes `/sql`, so gating `force` against it would
	 * be theatre. Left on, every case below would pass for the wrong reason.
	 */
	async function provision(stub: DurableObjectStub, token = 'owner-token-for-this-site') {
		await inObject(stub, (site) => {
			const meta = site as unknown as { metaSet: (k: string, v: unknown) => void };
			meta.metaSet('first_run_at', Date.now());
			meta.metaSet(OWNER_TOKEN_KEY, token);
			site.env.PW_DIAGNOSTICS = '0';
		});
		return token;
	}

	it('refuses a second POST with 409, naming the token as the way through', async () => {
		const stub = freshSite();
		await provision(stub);
		const res = await stub.fetch(URL_BASE, { method: 'POST', body: '{}' });
		expect(res.status).toBe(409);
		const body = (await res.json()) as { ok: boolean; error: string; how: string };
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/already configured/);
		expect(body.how).toMatch(/owner token/);
	});

	it('refuses force=1 with NO token: an unauthenticated reset is a site takeover', async () => {
		const stub = freshSite();
		await provision(stub);
		const res = await stub.fetch(`${URL_BASE}?force=1`, { method: 'POST', body: '{}' });
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string; how: string };
		expect(body.error).toMatch(/owner token/);
		expect(body.how).toMatch(/Bearer/);
	});

	it('refuses force=1 with the WRONG token', async () => {
		const stub = freshSite();
		await provision(stub);
		const res = await stub.fetch(`${URL_BASE}?force=1`, {
			method: 'POST',
			body: '{}',
			headers: { authorization: 'Bearer not-the-right-token' }
		});
		expect(res.status).toBe(401);
	});

	it('lets force=1 THROUGH with the right token, or the escape hatch does not exist', async () => {
		const stub = freshSite();
		const token = await provision(stub);
		const res = await stub.fetch(`${URL_BASE}?force=1`, {
			method: 'POST',
			body: '{}',
			headers: { authorization: `Bearer ${token}` }
		});
		// past the gate; what happens next needs a booted kernel and is not what this asserts
		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(409);
	});

	it('lets force=1 through on DIAGNOSTICS as well, which is unchanged', async () => {
		const stub = freshSite();
		await provision(stub);
		await inObject(stub, (site) => {
			// diagnostics already exposes /sql, so it is not a lesser credential than the token
			site.env.PW_DIAGNOSTICS = '1';
		});
		const res = await stub.fetch(`${URL_BASE}?force=1`, { method: 'POST', body: '{}' });
		expect(res.status).not.toBe(401);
	});

	it('still lets an UNPROVISIONED site be claimed with no credential at all', async () => {
		// the window itself: this is the property that makes one-click provisioning work, and the
		// three cases above are what stop it staying open
		const stub = freshSite();
		const res = await stub.fetch(URL_BASE, { method: 'POST', body: '{}' });
		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(409);
	});
});

/**
 * Claiming a site also fixes the host it renders absolute URLs against.
 *
 * The render origin is trust-on-first-use (`src/ops/site-origin.ts`), which leaves one window open:
 * the first request after a deploy pins it, and that request is not necessarily the owner's. This
 * closes it from the other end -- the owner is here, on the host they mean -- and it
 * overwrites whatever a first visitor pinned.
 */
describe('claiming a site pins its render origin', () => {
	/**
	 * A REAL claim, against a migrated database. The pin rides the SUCCESS branch, so a
	 * `freshSite()` with no database would leave it untouched and both cases here would pass
	 * without exercising anything.
	 */
	async function claimFrom(host: string, existing: string | null): Promise<string | null> {
		const stub = freshSite();
		await stub.fetch('https://do.local/__migrate?all=1&prefill=0');
		if (existing !== null) {
			await inObject(stub, (site) => site.metaSet('site_origin', existing));
		}
		const res = await stub.fetch(`${host}/__firstrun`, {
			method: 'POST',
			body: JSON.stringify({ siteName: 'Owned' }),
			headers: { 'content-type': 'application/json' }
		});
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok, 'the claim itself has to succeed or this measures nothing').toBe(true);
		return inObject(stub, (site) => site.metaGet('site_origin'));
	}

	it('pins the host the claim arrived on, overwriting an earlier pin', async () => {
		const pinned = await claimFrom(
			'https://the-owners-host.example',
			'https://whoever-got-here-first.example'
		);
		expect(pinned).toBe('https://the-owners-host.example');
	}, 900_000);

	// the same rule the serve path follows: a dev claim must not fix a real site to a laptop
	it('leaves the pin alone when the claim arrives over a local host', async () => {
		const pinned = await claimFrom('https://do.local', 'https://real.example');
		expect(pinned).toBe('https://real.example');
	}, 900_000);
});
