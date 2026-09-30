import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { firstRunConfig } from '../../src/drupal/site-php';
import { MANDATORY_STATE } from '../../src/ops/replica-admission';
import { OWNER_TOKEN_KEY } from '../../src/ops/site-secrets';
import worker from '../../src/site';
import { freshSite, inObject, markProvisioned, provisionedSite } from '../helpers/serve-do';

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
		const stub = await provisionedSite();
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
		const stub = await provisionedSite();
		const res = await stub.fetch(URL_BASE, { method: 'POST', body: '{}' });
		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(409);
	});
});

/**
 * A claim waits for the first-boot replay.
 *
 * Measured on `wrangler dev`: a claim POSTed while the replay stood at chunk 44 of 74 answered
 * `ok: true` without `uid1.pass` in `applied`, and the replay then failed on a `key_value` row the
 * claim had already written, so the site answered 503 for good. The same claim after the replay
 * set the password and the site served.
 */
describe('a claim waits for the database replay', () => {
	it('refuses a site that has never migrated, and asks it to start', async () => {
		const stub = freshSite();
		const res = await stub.fetch(URL_BASE, { method: 'POST', body: '{"siteName":"x"}' });
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe('2');
		expect(res.headers.get('x-cfw-migrate')).toBe('starting');
		expect(((await res.json()) as { error: string }).error).toBe('migrating');
		const state = await inObject(stub, (site) => ({
			claimed: (site as unknown as { metaGet: (k: string) => unknown }).metaGet(
				'first_run_at'
			),
			asked: (site as unknown as { provisionRequested: () => boolean }).provisionRequested()
		}));
		expect(state).toEqual({ claimed: null, asked: true });
	});

	it('refuses a site part-way through its replay, naming the chunk', async () => {
		const stub = freshSite();
		await inObject(stub, (site) => {
			markProvisioned(site);
			site.sql.exec(`UPDATE cfw_migrate SET state = 'running', chunk = 44, chunks = 74`);
		});
		const res = await stub.fetch(URL_BASE, { method: 'POST', body: '{"siteName":"x"}' });
		expect(res.status).toBe(503);
		expect(res.headers.get('x-cfw-migrate')).toBe('44/74');
		expect(res.headers.get('x-cfw-migrate-state')).toBe('running');
	});

	it('CONTROL: a provisioned site is past the guard', async () => {
		const stub = await provisionedSite();
		const res = await stub.fetch(URL_BASE, { method: 'POST', body: '{"siteName":"x"}' });
		expect(res.status).not.toBe(503);
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

/**
 * The one value a replica may never mint for itself.
 *
 * `admissionVerdict()` lists `state:system.private_key` as mandatory, correctly: it keys CSRF
 * tokens, so two objects each minting their own issue tokens the other rejects. Drupal creates it
 * LAZILY, on the first render that needs a token, which a migrated-and-claimed site has not had --
 * so no replica of a new site could ever be admitted, and nothing in `src/` minted it.
 *
 * The report described this as fixed with a mint on the primary. No such call existed anywhere in
 * the tree. Measured on a local rig before the fix: three lanes sat at stage `CREATED` through 40
 * provision steps each, then reached `VERIFIED` in ONE step each once a single `/user/login` render
 * had minted the key.
 */
describe('a claimed site holds the state a replica cannot produce', () => {
	async function claimed(): Promise<DurableObjectStub> {
		const stub = freshSite();
		await stub.fetch('https://do.local/__migrate?all=1&prefill=0');
		const res = await stub.fetch('https://do.local/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ siteName: 'Replicable' }),
			headers: { 'content-type': 'application/json' }
		});
		expect(((await res.json()) as { ok: boolean }).ok, 'the claim has to succeed').toBe(true);
		return stub;
	}

	const stateNames = async (stub: DurableObjectStub): Promise<string[]> =>
		inObject(stub, (site) =>
			site.sql
				.exec("SELECT name FROM key_value WHERE collection = 'state'")
				.toArray()
				.map((r) => String(r['name']))
		);

	it('mints system.private_key at the claim, so a lane can be admitted', async () => {
		expect(await stateNames(await claimed())).toContain('system.private_key');
	}, 900_000);

	/**
	 * EVERY mandatory name, derived from the admission module rather than restated. A list written
	 * out here goes stale in the direction that matters: a name added to `MANDATORY_STATE` would
	 * be a value no new site holds and nothing would report it.
	 */
	it('holds every name admission declares mandatory', async () => {
		const present = new Set(await stateNames(await claimed()));
		const wanted = MANDATORY_STATE.filter((e) => e.collection === 'state').map((e) => e.name);
		expect(wanted.length, 'no mandatory state to check').toBeGreaterThan(0);
		expect(wanted.filter((name) => !present.has(name))).toEqual([]);
	}, 900_000);

	// the control, and the reason the case above is not vacuous: an UNCLAIMED site does not hold it,
	// so the claim is what produces it rather than the pack shipping it
	it('CONTROL: a migrated but unclaimed site does not hold it', async () => {
		const stub = freshSite();
		await stub.fetch('https://do.local/__migrate?all=1&prefill=0');
		expect(await stateNames(stub)).not.toContain('system.private_key');
	}, 900_000);
});

/**
 * A migrated site already has an administrator and a site identity, and a claim must not touch
 * either: the normal claim rewrites uid 1's name, mail, password and birthday, which on a migrated
 * site is the real administrator. The normal claim on the same shape of site is the control.
 */
describe('a migrated claim mints the owner token and changes no account', () => {
	const post = (stub: DurableObjectStub, body: unknown, query = '') =>
		stub.fetch(`${URL_BASE}${query}`, {
			method: 'POST',
			body: JSON.stringify(body),
			headers: { 'content-type': 'application/json' }
		});

	/** a site shaped like a migrated one: uid 1 with a known hash, and a distinct site name */
	async function migratedShape(): Promise<DurableObjectStub> {
		const stub = freshSite();
		await stub.fetch('https://do.local/__migrate?all=1&prefill=0');
		const set = (await inObject(stub, (site) =>
			site.runJson(
				firstRunConfig({
					siteName: 'Legacy Site',
					siteMail: 'legacy@example.org',
					adminName: 'legacy_admin',
					adminMail: 'legacy_admin@example.org',
					adminPass: 'legacy-password',
					claimedAt: 1_500_000_000
				})
			)
		)) as { ok: boolean };
		expect(set.ok, 'building the migrated shape has to succeed').toBe(true);
		return stub;
	}

	const account = (stub: DurableObjectStub) =>
		inObject(stub, (site) => ({
			user: site.sql
				.exec('SELECT name, mail, pass, created FROM users_field_data WHERE uid = 1')
				.toArray(),
			site: site.sql
				.exec("SELECT hex(data) AS data FROM config WHERE name = 'system.site'")
				.toArray()
		}));

	it('keeps uid 1 and system.site byte-identical and still returns a token', async () => {
		const stub = await migratedShape();
		const before = await account(stub);
		expect(before.user).toHaveLength(1);
		const res = await post(stub, { migrated: true });
		const body = (await res.json()) as { ok: boolean; ownerToken?: string; adminPass?: string };
		expect(body.ok).toBe(true);
		expect(body.ownerToken).toMatch(/\S{20,}/);
		expect(
			body.adminPass,
			'no password is minted for an account that keeps its own'
		).toBeUndefined();
		expect(await account(stub)).toEqual(before);
		const state = await inObject(stub, (site) => site.metaGet('first_run_at'));
		expect(state, 'the site is marked claimed').not.toBeNull();
	}, 900_000);

	it('the normal claim on the same shape of site does change them', async () => {
		const stub = await migratedShape();
		const before = await account(stub);
		const res = await post(stub, {
			siteName: 'Renamed',
			adminName: 'renamed_admin',
			adminMail: 'renamed@example.org',
			adminPass: 'a-new-password'
		});
		expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
		const after = await account(stub);
		const [was] = before.user as Record<string, unknown>[];
		const [now] = after.user as Record<string, unknown>[];
		for (const field of ['name', 'mail', 'pass', 'created']) {
			expect(now![field], field).not.toEqual(was![field]);
		}
		expect(after.site).not.toEqual(before.site);
	}, 900_000);

	it('refuses an already claimed site, and refuses migrated with an adminPass', async () => {
		const stub = freshSite();
		const both = await post(stub, { migrated: true, adminPass: 'x' });
		expect(both.status).toBe(400);
		await inObject(stub, (site) => site.metaSet('first_run_at', Date.now()));
		const again = await post(stub, { migrated: true });
		expect(again.status).toBe(409);
		const forced = await post(stub, { migrated: true }, '?force=1');
		expect(forced.status).toBe(409);
	});
});

/**
 * The front worker sends a claim as three object invocations.
 *
 * The CPU limit is per invocation and a reset rolls the whole invocation back, so a claim that
 * installed modules and then hashed a password on a ~150-module site (Thunder) was reset at 32 s of
 * CPU on every attempt and reinstalled the same two modules each time.
 */
describe('a claim reaches the object as three invocations', () => {
	function recordingEnv(): { seen: string[]; env: typeof env } {
		const seen: string[] = [];
		const SITE = {
			idFromName: (name: string) => name,
			get: () => ({
				fetch: async (input: Request) => {
					const u = new URL(input.url);
					const phase = u.searchParams.get('phase');
					seen.push(u.pathname + (phase ? `?phase=${phase}` : ''));
					return Response.json({ ok: true });
				}
			})
		};
		return { seen, env: { ...env, SITE } as unknown as typeof env };
	}

	it('warms and installs in their own invocations before it forwards the claim', async () => {
		const { seen, env: recording } = recordingEnv();
		await worker.fetch(
			new Request('https://cfw.local/firstrun?site=x', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			}),
			recording
		);
		expect(seen.filter((p) => p.startsWith('/__firstrun'))).toEqual([
			'/__firstrun?phase=warm',
			'/__firstrun?phase=consistency',
			'/__firstrun'
		]);
	});

	it('CONTROL: a force=1 reconfigure and a bare GET are forwarded alone', async () => {
		for (const [path, method] of [
			['/firstrun?site=x&force=1', 'POST'],
			['/firstrun?site=x', 'GET']
		] as const) {
			const { seen, env: recording } = recordingEnv();
			await worker.fetch(
				new Request(`https://cfw.local${path}`, {
					method,
					...(method === 'POST' ? { body: '{}' } : {})
				}),
				recording
			);
			expect(seen.filter((p) => p.startsWith('/__firstrun'))).toEqual(['/__firstrun']);
		}
	});
});
