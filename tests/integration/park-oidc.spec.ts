import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BOOT_KERNEL } from '../../src/drupal/site-php';
import { SHIPPED_CAPABILITIES } from '../../src/ops/catalog';
import { PARK_PROBE, parkTrapInstall } from '../../src/ops/park';
import { drivePark, ParkSockets } from '../../src/ops/park-drive';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * `drupal/openid_connect` completing a real login through its OWN token exchange.
 *
 * This is the acceptance test for the park, and the reason it is worth one: the authorization code
 * is single use, so the deferred transport cannot serve it -- an answer delivered on a later drain
 * reaches a request that can no longer use it. The module has to have the token set before it writes
 * its response, which is the one shape only a park provides.
 *
 * WHAT MAKES IT A SUPPORT CLAIM rather than a smoke test: the `authmap` row is written by
 * `externalauth` under a provider string `openid_connect` owns, keyed on the `sub` of an `id_token`
 * that only the live Keycloak could have signed, obtained with a code only a real login could mint.
 * No stub reaches that row.
 *
 * Needs the rig and the contrib pack:
 *
 *   docker compose -f docker/compose.yml up -d keycloak
 *   bun scripts/contrib-fixture.ts --mount
 *   bunx vitest run --project=workers tests/integration/park-oidc.spec.ts
 */

const IDP = 'http://127.0.0.1:8081';
const REALM = 'drupflare';
/**
 * The client WITHOUT a PKCE requirement, and that is not an arbitrary choice.
 * `drupflare-worker` carries `pkce.code.challenge.method: S256`, so Keycloak demands a
 * `code_challenge`; `getRequestOptions()` in `OpenIDConnectClientBase` sends none, so that client
 * refuses the authorization request before any of this is reachable.
 */
const CLIENT = 'drupflare-other';
const SECRET = 'drupflare-other-secret';
const LOGIN = { username: 'drupflare', password: 'drupflarepass' };
const EMAIL = 'drupflare@example.test';
/** registered in `docker/keycloak-realm.json`, and Drupal must compute the SAME string */
const ORIGIN = 'http://127.0.0.1:8787';
const ENTITY = 'keycloak';
const REDIRECT = `${ORIGIN}/openid-connect/${ENTITY}`;

type Interp = ServeDo & { run: (code: string) => Promise<string> };

const call = (site: ServeDo, path: string) =>
	site.fetch(new Request(`https://do.local${path}`)).then((r) => r.json() as Promise<unknown>);

/** workerd splits `set-cookie`, so the multi-value accessor is the one that sees all of them */
function jar(res: Response): string {
	const all =
		typeof res.headers.getSetCookie === 'function'
			? res.headers.getSetCookie()
			: [res.headers.get('set-cookie') ?? ''];
	return all
		.filter((c) => c !== '')
		.map((c) => c.split(';')[0])
		.join('; ');
}

/**
 * A real authorization code, obtained by driving Keycloak's own login form.
 *
 * The browser lane does these two hops with a browser; here they are two `fetch` calls, because the
 * thing under test is the SERVER half and a browser would only add a dependency to it. The code that
 * comes back is single use and expires, so it is minted immediately before it is spent.
 */
async function authorizationCode(state: string): Promise<{ code?: string; why?: string }> {
	const auth = new URL(`${IDP}/realms/${REALM}/protocol/openid-connect/auth`);
	auth.searchParams.set('client_id', CLIENT);
	auth.searchParams.set('response_type', 'code');
	auth.searchParams.set('scope', 'openid email profile');
	auth.searchParams.set('redirect_uri', REDIRECT);
	auth.searchParams.set('state', state);

	const page = await fetch(auth, { redirect: 'manual' });
	if (!page.ok) return { why: `the authorization endpoint answered ${page.status}` };
	const cookies = jar(page);
	const html = await page.text();
	const action = /action="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
	if (!action) return { why: 'no login form in the authorization response' };

	const posted = await fetch(action, {
		method: 'POST',
		redirect: 'manual',
		headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies },
		body: new URLSearchParams({ ...LOGIN, credentialId: '' }).toString()
	});
	const location = posted.headers.get('location');
	if (!location) return { why: `the login POST answered ${posted.status} with no redirect` };
	const code = new URL(location).searchParams.get('code');
	return code ? { code } : { why: `the redirect carried no code: ${location}` };
}

/** the client entity, the registration override and the anti-forgery token the callback checks */
function arrange(state: string): string {
	const endpoint = `${IDP}/realms/${REALM}/protocol/openid-connect`;
	return [
		// A REQUEST HAS TO BE ON THE STACK BEFORE ANY OF THIS. `router.request_context` is built
		// from `request_stack` and `RequestContext::fromRequest()` type-errors on the NULL an empty
		// stack yields, so saving a config entity fatals before the callback is ever dispatched.
		`$seed = \\Symfony\\Component\\HttpFoundation\\Request::create('${ORIGIN}/');`,
		"\\Drupal::service('request_stack')->push($seed);",
		// and `preHandle()`, which is what loads `common.inc`. `BOOT_KERNEL` stops before any
		// request is handled, so `SAVED_NEW` does not exist yet and saving a config entity dies on
		// it -- a property of this harness rather than of the site, since a render calls it
		"$GLOBALS['__pw_kernel']->preHandle($seed);",
		"$storage = \\Drupal::entityTypeManager()->getStorage('openid_connect_client');",
		`if (!$storage->load('${ENTITY}')) {`,
		'  $storage->create([',
		`    'id' => '${ENTITY}', 'label' => 'Keycloak', 'plugin' => 'generic', 'status' => true,`,
		"    'settings' => [",
		`      'client_id' => '${CLIENT}', 'client_secret' => '${SECRET}',`,
		`      'issuer_url' => '', 'authorization_endpoint' => '${endpoint}/auth',`,
		`      'token_endpoint' => '${endpoint}/token', 'userinfo_endpoint' => '${endpoint}/userinfo',`,
		"      'end_session_endpoint' => '', 'scopes' => ['openid', 'email'],",
		"      'provider_slug' => '', 'iss_allowed_domains' => '', 'prompt' => ['login'],",
		'    ],',
		'  ])->save();',
		'}',
		// core ships `register: admin_only`, which refuses the account the login has to create;
		// the override is the module's own lever for exactly that
		"\\Drupal::configFactory()->getEditable('openid_connect.settings')",
		"  ->set('override_registration_settings', true)->save();",
		`\\Drupal::service('session')->set('openid_connect_state', '${state}');`,
		"\\Drupal::service('session')->set('openid_connect_op', 'login');"
	].join('\n');
}

/** dispatches the provider's redirect through Drupal's own kernel and reports what it produced */
function callback(code: string, state: string): string {
	const url = `${REDIRECT}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
	return [
		`$request = \\Symfony\\Component\\HttpFoundation\\Request::create('${url}');`,
		"$request->setSession(\\Drupal::service('session'));",
		'$status = 0; $location = null; $error = null;',
		'try {',
		"  $response = \\Drupal::service('http_kernel')->handle($request);",
		'  $status = $response->getStatusCode();',
		"  $location = method_exists($response, 'getTargetUrl') ? $response->getTargetUrl() : null;",
		"} catch (Throwable $e) { $error = get_class($e) . ': ' . $e->getMessage(); }",
		"$map = \\Drupal::database()->select('authmap', 'a')",
		"  ->fields('a', ['provider', 'authname', 'uid'])->execute()->fetchAll(\\PDO::FETCH_ASSOC);",
		"$mail = \\Drupal::database()->select('users_field_data', 'u')",
		"  ->fields('u', ['uid', 'mail', 'name', 'status'])->condition('u.uid', 0, '>')",
		'  ->execute()->fetchAll(\\PDO::FETCH_ASSOC);',
		'echo json_encode([',
		"  'status' => $status, 'location' => $location, 'error' => $error,",
		"  'authmap' => $map, 'users' => $mail,",
		"  'refusal' => $GLOBALS['CFW_PARK_REFUSAL'] ?? null,",
		'], JSON_PARTIAL_OUTPUT_ON_ERROR);'
	].join('\n');
}

type Seen = {
	status?: number;
	location?: string | null;
	error?: string | null;
	authmap?: { provider: string; authname: string; uid: string }[];
	users?: { uid: string; mail: string; name: string; status: string }[];
	refusal?: { unsafe?: number; frames?: string[]; url?: string } | null;
};

/**
 * Whether the pack the object mounts carries the module at all.
 *
 * Read through the real ASSETS binding, the same bytes `mountDrupalLazy()` fetches. Contrib is a dev
 * dependency here, so the shipping pack has four modules and this is not one of them; the fixture
 * build is what carries it, and a skip names that rather than reading as a pass.
 */
async function packed(): Promise<boolean> {
	const res = await env.ASSETS.fetch(new URL('https://a.local/drupal-pf/core.pf.json'));
	if (!res.ok) throw new Error(`pack index not reachable: core.pf.json ${res.status}`);
	return (await res.text()).includes('modules/contrib/openid_connect/');
}

describe('drupal/openid_connect, logging in through its own token exchange', () => {
	it('exchanges a real authorization code inside the request and writes its authmap row', async (ctx) => {
		if (!(await packed())) {
			ctx.skip(
				'openid_connect is not in the mounted pack. `bun scripts/contrib-fixture.ts --mount` ' +
					'builds the fixture that carries it; restore with `--restore` afterwards.'
			);
			return;
		}
		const state = 'cfw-park-state-1';
		const minted = await authorizationCode(state).catch((e: unknown) => ({
			why: e instanceof Error ? e.message : String(e)
		}));
		if (!('code' in minted) || !minted.code) {
			ctx.skip(`no authorization code from the rig: ${minted.why ?? 'unknown'}`);
			return;
		}
		const code = minted.code;
		// NOT A SKIP. `pickHandlerClass()` reads this through `cfwParkFetch` when the container is
		// BUILT, so with the capability off the site is wired to the deferred transport and this
		// spec would be measuring something else. The measurement that justifies the flag is
		// `park-dispatch.spec.ts`; this is the consequence of it.
		expect(SHIPPED_CAPABILITIES.blockingOutbound).toBe(true);

		const outcome = await inObject(freshSite(), async (site: ServeDo) => {
			const one = site as Interp;
			if ((await site.runJson(PARK_PROBE))['park'] !== true)
				return { build: 'absent' as const };

			await call(site, '/__migrate?all=1&prefill=0');
			const enabled = await call(site, `/__enable?module=openid_connect`);
			const booted = await site.runJson(BOOT_KERNEL);
			if (booted['ok'] !== true) return { build: 'no-kernel' as const, enabled, booted };

			const armed = await site.runJson(parkTrapInstall(['fetch']));

			const sockets = new ParkSockets();
			const driven = await drivePark(
				{ runText: (c: string) => one.run(c) },
				sockets,
				// the lever the rig exists for: Keycloak is on loopback and the SSRF guard refuses
				// that by default, correctly, since PHP names the URL a parked fetch reaches
				{ OUTBOUND_GUARD: '0' },
				`<?php\n${arrange(state)}\n${callback(code, state)}`
			);
			await sockets.closeAll();
			return { build: 'current' as const, enabled, armed, driven };
		});

		if (outcome.build !== 'current') {
			console.log(`[park-oidc] ${outcome.build} ${JSON.stringify(outcome).slice(0, 400)}`);
			expect(outcome.build).toBe('current');
			return;
		}
		const driven = outcome.driven;
		console.log(
			`[park-oidc] ${driven.state} in ${driven.trips.length} trips ` +
				`(${driven.trips.map((t) => `${t.fn}/${t.op}`).join(' ')}) ${driven.why ?? ''}\n` +
				driven.output.slice(0, 900)
		);
		expect(outcome.armed['armed']).toContain('stream_socket_client');
		expect(driven.state, driven.why ?? '').toBe('done');

		const seen = JSON.parse(driven.output.slice(driven.output.indexOf('{'))) as Seen;
		expect(seen.error ?? null).toBeNull();

		// THE PARK CARRIED IT. Two outbound calls in one request -- the token POST and the userinfo
		// GET -- and both were answered by JavaScript while PHP was frozen mid-call. A refusal here
		// would have fallen back to the deferred transport and the login could not have completed.
		expect(driven.trips.map((t) => t.op)).toEqual(['fetch', 'fetch']);
		// and nothing in Drupal's dispatch refused one, which is what the trampoline splice buys
		expect(seen.refusal ?? null).toBeNull();

		// THE OBSERVABLE THE MODULE OWNS: `externalauth` keyed on the provider string
		// `openid_connect.<client>`, with the `sub` of an id_token Keycloak signed.
		const rows = seen.authmap ?? [];
		expect(rows.map((r) => r.provider)).toEqual([`openid_connect.${ENTITY}`]);
		expect(rows[0]?.authname ?? '').toMatch(/^[0-9a-f-]{36}$/);

		// the account the login created, with the address the provider holds for that subject
		expect((seen.users ?? []).map((u) => u.mail)).toContain(EMAIL);
		// and the session was established, which is what `completeAuthorization` returning true means
		expect(seen.status).toBe(302);
	});
});
