import { beforeAll, describe, expect, it } from 'vitest';
import {
	verifyIdToken,
	type IdTokenClaims,
	type Jwk,
	type OidcConfig,
	type OidcProvider
} from '../../src/ops/oidc';
import { e2eGate, ENDPOINT, SITE } from './helpers/endpoint';

/** Tier B against a real IdP: the authorization-code flow itself. Rig in `tests/e2e/README.md` */

const ISSUER = process.env.CFW_E2E_OIDC_ISSUER ?? 'http://127.0.0.1:8081/realms/drupflare';
const CLIENT_ID = process.env.CFW_E2E_OIDC_CLIENT ?? 'drupflare-worker';
/** a second client of the SAME provider, which is what makes the audience refusal meaningful */
const OTHER_CLIENT = process.env.CFW_E2E_OIDC_OTHER_CLIENT ?? 'drupflare-other';
const OTHER_SECRET = process.env.CFW_E2E_OIDC_OTHER_SECRET ?? 'drupflare-other-secret';
const USERNAME = process.env.CFW_E2E_OIDC_USER ?? 'drupflare';
const PASSWORD = process.env.CFW_E2E_OIDC_PASSWORD ?? 'drupflarepass';

/** a cookie jar, because the provider's login form is a session and fetch has no jar of its own */
class Browser {
	private readonly jar = new Map<string, string>();

	async hop(url: string, init: RequestInit = {}): Promise<Response> {
		const res = await fetch(url, {
			...init,
			redirect: 'manual',
			headers: { ...(init.headers ?? {}), cookie: this.cookies() },
			signal: AbortSignal.timeout(45_000)
		});
		for (const raw of res.headers.getSetCookie()) {
			const [pair = ''] = raw.split(';');
			const eq = pair.indexOf('=');
			if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
		}
		return res;
	}

	private cookies(): string {
		return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
	}
}

function siteUrl(path: string, params: Record<string, string> = {}): string {
	const url = new URL(`${ENDPOINT}${path}`);
	url.searchParams.set('site', SITE);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url.toString();
}

/** the whole flow, returning every hop so a failure names which one broke */
async function signIn(): Promise<{
	authorize: string;
	loginForm: string;
	callback: string;
	landed: Response;
}> {
	const browser = new Browser();

	const start = await browser.hop(siteUrl('/oidc', { action: 'start' }));
	const authorize = start.headers.get('location') ?? '';
	if (start.status !== 302 || authorize === '') {
		throw new Error(`the login did not start: ${start.status} ${await start.text()}`);
	}

	const page = await browser.hop(authorize);
	const html = await page.text();
	const form = /<form[^>]+action="([^"]+)"/.exec(html);
	if (form === null) throw new Error(`no login form at the provider: ${html.slice(0, 200)}`);
	const loginForm = (form[1] as string).replace(/&amp;/g, '&');

	const submitted = await browser.hop(loginForm, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ username: USERNAME, password: PASSWORD }).toString()
	});
	const callback = submitted.headers.get('location') ?? '';
	if (callback === '') {
		throw new Error(
			`the provider did not redirect back: ${(await submitted.text()).slice(0, 200)}`
		);
	}

	// the site parameter is the local rig's; a deployed site resolves itself from the hostname
	const back = new URL(callback);
	back.searchParams.set('site', SITE);
	return { authorize, loginForm, callback, landed: await browser.hop(back.toString()) };
}

async function providerReachable(): Promise<boolean> {
	try {
		const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, {
			signal: AbortSignal.timeout(4000)
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Whether the WORKER is pointed at the rig, which is a different question from whether the rig is
 * up. A gate that probes one end of a path passes while the path is broken.
 */
async function workerConfigured(): Promise<string | null> {
	try {
		const res = await fetch(siteUrl('/setup/oidc', { action: 'status' }), {
			signal: AbortSignal.timeout(10_000)
		});
		const row = (await res.json()) as { issuer?: string; secretPresent?: boolean };
		if ((row.issuer ?? '') !== ISSUER) {
			return `the worker's issuer is ${row.issuer || '(unset)'}, not ${ISSUER}`;
		}
		if (row.secretPresent !== true) return 'the worker has no OIDC_CLIENT_SECRET bound';
		return null;
	} catch (e) {
		return `the worker did not answer /setup/oidc: ${String((e as Error)?.message ?? e)}`;
	}
}

async function realProvider(): Promise<{ provider: OidcProvider; keys: Jwk[] }> {
	const doc = (await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json()) as {
		issuer: string;
		authorization_endpoint: string;
		token_endpoint: string;
		jwks_uri: string;
	};
	const jwks = (await (await fetch(doc.jwks_uri)).json()) as { keys: Jwk[] };
	return {
		provider: {
			issuer: doc.issuer,
			authorizationEndpoint: doc.authorization_endpoint,
			tokenEndpoint: doc.token_endpoint,
			jwksUri: doc.jwks_uri
		},
		keys: jwks.keys
	};
}

/** a token the provider really signed, issued to a client that is not this site */
async function tokenForOtherClient(tokenEndpoint: string): Promise<string> {
	const res = await fetch(tokenEndpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'password',
			client_id: OTHER_CLIENT,
			client_secret: OTHER_SECRET,
			username: USERNAME,
			password: PASSWORD,
			scope: 'openid'
		}).toString()
	});
	const body = (await res.json()) as { id_token?: string; error_description?: string };
	if (typeof body.id_token !== 'string') {
		throw new Error(`no id_token for ${OTHER_CLIENT}: ${body.error_description ?? '?'}`);
	}
	return body.id_token;
}

function configFor(clientId: string): OidcConfig {
	return {
		issuer: ISSUER,
		clientId,
		scopes: ['openid'],
		redirectUri: `${ENDPOINT}/oidc?action=callback`
	};
}

describe('the OIDC tier against a real identity provider', () => {
	let skip = false;
	let noRig = false;

	beforeAll(async () => {
		skip = await e2eGate();
		if (skip) return;
		noRig = !(await providerReachable());
		if (noRig && process.env.CI) {
			throw new Error(
				`e2e: no identity provider at ${ISSUER} (required in CI). ` +
					'Start it with `docker compose -f docker/compose.yml up -d keycloak`.'
			);
		}
		if (noRig) return;
		const unwired = await workerConfigured();
		if (unwired !== null) {
			if (process.env.CI) {
				throw new Error(
					`e2e: the provider is up but the worker is not wired to it (${unwired}).`
				);
			}
			noRig = true;
		}
	});

	it('completes the authorization-code flow and lands a single-use claims ticket', async (ctx) => {
		if (skip || noRig) return ctx.skip();
		const { authorize, landed } = await signIn();

		// the redirect the provider was given must be one a browser can reach; a `__` path is refused
		// from outside, which is how this shipped unable to complete a login at all
		const sent = new URL(authorize).searchParams.get('redirect_uri') ?? '';
		expect(sent).toContain('/oidc?action=callback');
		expect(sent).not.toContain('/__oidc');
		// PKCE and the nonce never leave the object; only the challenge rides in the URL
		expect(new URL(authorize).searchParams.get('code_challenge_method')).toBe('S256');

		expect(landed.status, await landed.clone().text()).toBe(302);
		const ticket = new URL(landed.headers.get('location') as string).searchParams.get(
			'cfw_oidc'
		);
		expect(ticket, 'the login completed but minted no claims ticket').toBeTruthy();
		// the claims themselves must never ride in the URL
		expect(landed.headers.get('location')).not.toMatch(/sub=|email=|id_token=/);
	});

	it('refuses a replayed callback, because the pending login is consumed', async (ctx) => {
		if (skip || noRig) return ctx.skip();
		const { callback } = await signIn();
		const replay = new URL(callback);
		replay.searchParams.set('site', SITE);

		const again = await fetch(replay.toString(), {
			redirect: 'manual',
			signal: AbortSignal.timeout(45_000)
		});
		expect(again.status).toBeGreaterThanOrEqual(400);
		expect(String(((await again.json()) as { error?: string }).error ?? '')).toMatch(
			/no login is in progress|state does not match/i
		);
	});

	it('refuses a callback whose state is not the one that started', async (ctx) => {
		if (skip || noRig) return ctx.skip();
		await fetch(siteUrl('/oidc', { action: 'start' }), { redirect: 'manual' });
		const forged = await fetch(
			siteUrl('/oidc', { action: 'callback', code: 'anything', state: 'not-the-one' }),
			{ redirect: 'manual', signal: AbortSignal.timeout(45_000) }
		);
		expect(forged.status).toBe(400);
		expect(String(((await forged.json()) as { error?: string }).error ?? '')).toContain(
			'state does not match'
		);
	});

	it('refuses a token the provider really signed for another of its clients', async (ctx) => {
		if (skip || noRig) return ctx.skip();
		const { provider, keys } = await realProvider();
		const idToken = await tokenForOtherClient(provider.tokenEndpoint);
		const nowS = Math.floor(Date.now() / 1000);

		// the control: the same real token verifies for the client it WAS issued to. Without it a
		// refusal below could be the signature failing rather than the audience being checked
		const accepted = await verifyIdToken(
			idToken,
			keys,
			configFor(OTHER_CLIENT),
			provider,
			'',
			nowS
		);
		expect(accepted, JSON.stringify(accepted)).toHaveProperty('claims');
		expect((accepted as { claims: IdTokenClaims }).claims.sub).toBeTruthy();

		const refused = await verifyIdToken(
			idToken,
			keys,
			configFor(CLIENT_ID),
			provider,
			'',
			nowS
		);
		expect(refused).toMatchObject({ refusal: expect.stringContaining('another client') });
	});

	it('refuses a real token once it has expired', async (ctx) => {
		if (skip || noRig) return ctx.skip();
		const { provider, keys } = await realProvider();
		const idToken = await tokenForOtherClient(provider.tokenEndpoint);
		// far enough ahead that the skew allowance cannot absorb it
		const later = Math.floor(Date.now() / 1000) + 86_400;
		expect(
			await verifyIdToken(idToken, keys, configFor(OTHER_CLIENT), provider, '', later)
		).toMatchObject({ refusal: expect.stringContaining('expired') });
	});

	it('refuses a real token signed by a key outside the provider JWKS', async (ctx) => {
		if (skip || noRig) return ctx.skip();
		const { provider, keys } = await realProvider();
		const idToken = await tokenForOtherClient(provider.tokenEndpoint);
		const stranger = await crypto.subtle.generateKey(
			{
				name: 'RSASSA-PKCS1-v1_5',
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: 'SHA-256'
			},
			true,
			['sign', 'verify']
		);
		const foreign = (await crypto.subtle.exportKey(
			'jwk',
			(stranger as CryptoKeyPair).publicKey
		)) as Jwk;
		foreign.kid = keys[0]?.kid;

		expect(
			await verifyIdToken(
				idToken,
				[foreign],
				configFor(OTHER_CLIENT),
				provider,
				'',
				Math.floor(Date.now() / 1000)
			)
		).toMatchObject({ refusal: expect.stringContaining('signature') });
	});
});
