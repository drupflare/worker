import { BASE_URL, expect, ownerToken, signInToSurface, SITE, test } from './utils/fixtures.js';

/**
 * Single sign-on, driven the way a person does it: through a real browser, against a real provider.
 *
 * `tests/e2e/oidc.spec.ts` covers the protocol against the same Keycloak and asserts every silent
 * refusal -- a replayed ticket, a mismatched `state`, a token signed outside the JWKS, an expired
 * one, a wrong `aud`. It drives the OBJECT with a hand-rolled cookie jar, and that is the right
 * place for those.
 *
 * WHAT IT STRUCTURALLY CANNOT SEE is whether a browser completes the journey. The defect that opened
 * this lane was exactly that: `/__oidc` is a Durable Object route the front worker refuses from
 * outside by construction, so the callback answered 404 to every browser while 25 assertions on the
 * exchange passed. A hand-rolled jar follows redirects the fetch API allows; a browser follows the
 * ones a browser allows, submits the provider's own form, and reports a page that threw.
 *
 * THE RIG: `docker compose -f docker/compose.yml up -d keycloak`. Without it these skip rather than
 * fail, on the same asymmetry `tests/e2e/README.md` documents -- a developer with no container
 * should not see red, and a lane that skipped everything is indistinguishable from one that passed.
 */

const ISSUER = process.env.CFW_BROWSER_OIDC_ISSUER ?? 'http://127.0.0.1:8081/realms/drupflare';
const CLIENT_ID = process.env.CFW_BROWSER_OIDC_CLIENT ?? 'drupflare-worker';
const USERNAME = process.env.CFW_BROWSER_OIDC_USER ?? 'drupflare';
const PASSWORD = process.env.CFW_BROWSER_OIDC_PASSWORD ?? 'drupflarepass';

/** whether the container is up; the discovery document is the cheapest possible probe */
async function providerReachable(): Promise<boolean> {
	try {
		const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, {
			signal: AbortSignal.timeout(5_000)
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** configures the site through the owner-gated route, which is what the Access page posts to */
async function configureProvider(): Promise<{ ok: boolean; discovery: unknown }> {
	const res = await fetch(`${BASE_URL}/setup/oidc?action=save&site=${SITE}`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${ownerToken()}`,
			'content-type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams({ issuer: ISSUER, clientId: CLIENT_ID }).toString()
	});
	const body = (await res.json()) as { ok?: boolean; discovery?: unknown };
	return { ok: body.ok === true, discovery: body.discovery };
}

let reachable = false;

/**
 * Whether an unreachable provider is a FAILURE rather than a skip.
 *
 * The skip below is right on a laptop with no rig, and it is how this file ran in CI for its whole
 * life without executing: the browser lane started no services, so every describe skipped and the
 * lane reported green having exercised none of the OIDC path the park exists for. The workflow
 * starts keycloak and sets this, so a provider that fails to come up now fails the lane instead of
 * quietly emptying it. Same asymmetry as `REQUIRE_ARTIFACTS` in the node lane.
 */
const REQUIRED = process.env.CFW_BROWSER_REQUIRE_OIDC === '1';

test.beforeAll(async () => {
	reachable = await providerReachable();
	if (REQUIRED && !reachable) {
		throw new Error(
			`CFW_BROWSER_REQUIRE_OIDC=1 but ${ISSUER} did not answer its discovery document. ` +
				'The lane declared it has an identity provider, so this is a failure rather than a skip.'
		);
	}
	if (reachable) {
		const setup = await configureProvider();
		expect(
			setup.ok,
			'the issuer could not be saved, so nothing below would mean anything'
		).toBe(true);
		// the save fetches the discovery document, so this proves the WORKER reaches the provider
		// rather than only that this test process does
		expect(setup.discovery, 'the worker could not discover the provider').toMatchObject({
			ok: true
		});
	}
});

test.describe('a visitor signs in through the identity provider', () => {
	test.skip(
		() => !reachable,
		'keycloak is not up: docker compose -f docker/compose.yml up -d keycloak'
	);

	test('completes the whole redirect journey and comes back holding a ticket', async ({
		page
	}) => {
		// hop 1: the site hands the browser to the provider. A 404 here is the defect this exists for
		await page.goto(`/oidc?action=start&return=${encodeURIComponent('/user/login')}`);

		// hop 2: the provider's own login form, on the provider's own origin
		await expect(page, 'the browser was not redirected to the provider').toHaveURL(
			/127\.0\.0\.1:8081\/realms\/drupflare/
		);
		await expect(page.locator('#username')).toBeVisible();

		// hop 3: real credentials against a real Keycloak
		await page.locator('#username').fill(USERNAME);
		await page.locator('#password').fill(PASSWORD);
		await page.locator('#kc-login').click();

		// hop 4: back on the site, holding the ticket the callback minted. Getting here means the
		// authorization code was exchanged, the id_token signature verified against the live JWKS,
		// and the nonce and state matched -- none of which a browser could have faked
		await page.waitForURL(/cfw_oidc=/, { timeout: 60_000 });
		const landed = new URL(page.url());
		expect(landed.pathname, 'the callback did not return to where the login started').toBe(
			'/user/login'
		);
		expect(landed.searchParams.get('cfw_oidc') ?? '').not.toBe('');
		// and the page it landed on rendered, rather than being a JSON refusal the browser displayed
		await expect(page.locator('form')).toBeVisible();
	});
});

/**
 * The refusals, in a browser.
 *
 * Their own describe because they drive a deliberate 4xx and chromium logs one console error per
 * non-2xx response whether or not the page handled it. Declaring the statuses keeps the guard on for
 * everything else, including the journey above.
 */
test.describe('a callback this site did not start', () => {
	test.use({ refusals: [400, 401, 403] });
	test.skip(
		() => !reachable,
		'keycloak is not up: docker compose -f docker/compose.yml up -d keycloak'
	);

	test('is refused when the state does not belong to a login this site started', async ({
		page
	}) => {
		// the browser-visible half of the refusal `oidc.spec.ts` asserts at the protocol level: a
		// callback nobody started must not complete, and must not look like a page either
		const res = await page.goto('/oidc?action=callback&state=not-a-real-state&code=whatever');
		expect(res?.status(), 'a forged callback was accepted').toBeGreaterThanOrEqual(400);
		await expect(page.locator('body')).toContainText(/state|refus|error/i);
	});

	test('does not complete twice, because the pending login is consumed', async ({ page }) => {
		await page.goto(`/oidc?action=start&return=${encodeURIComponent('/user/login')}`);
		await page.locator('#username').fill(USERNAME);
		await page.locator('#password').fill(PASSWORD);
		await page.locator('#kc-login').click();
		await page.waitForURL(/cfw_oidc=/, { timeout: 60_000 });

		// the callback URL the provider used, replayed. The pending record is cleared whatever
		// happens, so the second attempt has no state to match
		const first = new URL(page.url());
		const replayed = await page.goto(
			`/oidc?action=callback&state=stale&code=${encodeURIComponent(first.searchParams.get('cfw_oidc') ?? 'x')}`
		);
		expect(replayed?.status(), 'a replayed callback completed').toBeGreaterThanOrEqual(400);
	});
});

/**
 * What the Access page shows once a provider is configured.
 *
 * The page is where an operator sets this up, and until 2026-09-08 its Configure form could not
 * submit at all: a plain HTML POST has nowhere to put the bearer token the route requires. This
 * asserts the page reports the provider the journey above actually used.
 */
test.describe('the Access page reflects the provider that is really configured', () => {
	test.skip(
		() => !reachable,
		'keycloak is not up: docker compose -f docker/compose.yml up -d keycloak'
	);

	test('shows the issuer, the client and the discovered endpoints', async ({ page }) => {
		await signInToSurface(page);
		await page.goto('/_cfw/access');

		await expect(page.locator('body')).toContainText(ISSUER);
		await expect(page.locator('body')).toContainText(CLIENT_ID);
		// the secret is a binding and is reported present rather than shown
		await expect(page.locator('body')).toContainText('present');
		// and the redirect URI an operator has to paste into the provider is the one that worked
		await expect(page.locator('body')).toContainText('/oidc');
	});
});
