import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { e2eGate, ENDPOINT, SITE } from './helpers/endpoint';

/**
 * simplesamlphp_auth completing a real SAML login and logout against Keycloak.
 *
 * Needs a worker whose pack carries the module (the simplesamlphp phase of the contrib fixture),
 * started with `--var PW_DIAGNOSTICS:1 --var SITE_ID:<site>` so a request without `?site=` reaches the
 * site, a migrated and claimed site, and the realm client `urn:drupflare:ssp-rig` from
 * `docker/keycloak-realm.json`:
 *
 *   docker compose -f docker/compose.yml up -d keycloak
 *   bun scripts/contrib-fixture.ts --mount
 *   CFW_E2E_SITE=<site> CFW_E2E_OWNER_TOKEN=<token> bunx vitest run --project=e2e tests/e2e/saml.spec.ts
 *
 * The spec uploads `fixtures/ssp-rig` through `/modify`, which holds only what a site owner supplies:
 * the SimpleSAMLphp config directory and the module's own settings. Everything else comes from
 * drupflare: the `/simplesaml/module.php` endpoints, the `exit` and `Location` handling and the
 * session save in `Drupal\drupflare\SimpleSaml\ResponseBridge`, and the session store
 * `Drupal\drupflare\SimpleSaml\DatabaseStore`, named in the config as `store.type`. It skips with a
 * printed reason when Keycloak or the module is absent.
 */

const IDP = process.env.CFW_E2E_SAML_IDP ?? 'http://127.0.0.1:8081';
const REALM = 'drupflare';
const CLIENT_ID = 'urn:drupflare:ssp-rig';
const USERNAME = 'saml-rig';
const PASSWORD = 'samlrigpass';
const OWNER = process.env.CFW_E2E_OWNER_TOKEN ?? '';
const PACKAGE = 'ssp_rig';
const PROVIDER = 'simplesamlphp_auth';
const FIXTURE = join(import.meta.dirname, 'fixtures', 'ssp-rig');
/** request signing and assertion encryption; CFW_E2E_SAML_SIGNED=0 runs the unsigned path */
const SIGNED = process.env.CFW_E2E_SAML_SIGNED !== '0';

/** a cookie jar, because both the provider and the site answer with sessions fetch does not keep */
class Jar {
	private readonly jar = new Map<string, string>();

	async hop(url: string, init: RequestInit = {}): Promise<Response> {
		const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
		const res = await fetch(url, {
			...init,
			redirect: 'manual',
			headers: { ...(init.headers ?? {}), cookie },
			signal: AbortSignal.timeout(120_000)
		});
		for (const raw of res.headers.getSetCookie()) {
			const [pair = ''] = raw.split(';');
			const eq = pair.indexOf('=');
			if (eq <= 0) continue;
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			if (
				value === '' ||
				value === 'deleted' ||
				/expires=Thu, 01[ -]Jan[ -]1970/i.test(raw)
			) {
				this.jar.delete(name);
			} else {
				this.jar.set(name, value);
			}
		}
		return res;
	}

	has(prefix: string): boolean {
		return [...this.jar.keys()].some((k) => k.startsWith(prefix));
	}

	/** the value of the first cookie whose name starts with the prefix */
	value(prefix: string): string {
		return [...this.jar].find(([k]) => k.startsWith(prefix))?.[1] ?? '';
	}
}

const unescape = (s: string) =>
	s
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#x2F;/g, '/')
		.replace(/&#039;/g, "'");
const site = (path: string) => new URL(path, ENDPOINT).toString();
const ownerHeaders = (): Record<string, string> =>
	OWNER === '' ? {} : { authorization: `Bearer ${OWNER}` };

async function ownerCall(path: string, init: RequestInit = {}): Promise<Response> {
	const url = new URL(path, ENDPOINT);
	url.searchParams.set('site', SITE);
	return fetch(url, {
		...init,
		headers: { ...ownerHeaders(), ...(init.headers ?? {}) },
		signal: AbortSignal.timeout(170_000)
	});
}

async function rows(query: string): Promise<Record<string, unknown>[]> {
	const res = await ownerCall(`/sql?q=${encodeURIComponent(query)}`);
	return ((await res.json()) as { rows?: Record<string, unknown>[] }).rows ?? [];
}

const authmap = () =>
	rows(`SELECT authname, uid FROM authmap WHERE provider = '${PROVIDER}' ORDER BY authname`);

async function idpReachable(): Promise<boolean> {
	try {
		const res = await fetch(`${IDP}/realms/${REALM}/protocol/saml/descriptor`, {
			signal: AbortSignal.timeout(4000)
		});
		return res.ok;
	} catch {
		return false;
	}
}

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

/** the realm keys change on every container start, so the descriptor is read fresh and uploaded */
async function upload(): Promise<{ refused: string | null; cert: string }> {
	const dir = mkdtempSync(join(tmpdir(), 'ssp-rig-'));
	const key = join(dir, 'sp.key');
	const crt = join(dir, 'sp.crt');
	execFileSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			key,
			'-out',
			crt,
			'-days',
			'2',
			'-subj',
			'/CN=ssp-rig'
		],
		{ stdio: 'ignore', timeout: 30_000 }
	);
	const descriptor = await (
		await fetch(`${IDP}/realms/${REALM}/protocol/saml/descriptor`)
	).text();
	const sources: Record<string, string> = {
		[`modules/custom/${PACKAGE}/ssp-config/idp.xml`]: descriptor,
		[`modules/custom/${PACKAGE}/ssp-config/cert/sp.key`]: readFileSync(key, 'utf8'),
		[`modules/custom/${PACKAGE}/ssp-config/cert/sp.crt`]: readFileSync(crt, 'utf8')
	};
	for (const file of files(FIXTURE)) {
		sources[`modules/custom/${PACKAGE}/${relative(FIXTURE, file)}`] = readFileSync(
			file,
			'utf8'
		);
	}
	if (!SIGNED) {
		const authsources = `modules/custom/${PACKAGE}/ssp-config/authsources.php`;
		sources[authsources] = (sources[authsources] ?? '')
			.replace("'sign.authnrequest' => true", "'sign.authnrequest' => false")
			.replace("'sign.logout' => true", "'sign.logout' => false");
	}
	const declared = Object.entries(sources).map(([path, source]) => ({
		path,
		source,
		hash: createHash('sha256').update(source).digest('hex'),
		bytes: Buffer.byteLength(source)
	}));
	const modify = async (action: string, body: unknown) =>
		(await (
			await ownerCall(`/modify?action=${action}&package=${PACKAGE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		).json()) as { ok?: boolean; want?: string[] };
	const plan = await modify('plan', { files: declared });
	const want = new Set(plan.want ?? []);
	await modify('blobs', {
		blobs: declared
			.filter((f) => want.has(f.hash))
			.map((f) => ({ hash: f.hash, source: f.source }))
	});
	const commit = await modify('commit', {
		files: declared.map((f) => ({ path: f.path, hash: f.hash }))
	});
	if (commit.ok !== true) {
		return {
			refused: `the rig module was refused: ${JSON.stringify(commit).slice(0, 200)}`,
			cert: ''
		};
	}
	for (const module of [PROVIDER, PACKAGE]) {
		const res = (await (await ownerCall(`/enable?module=${module}`)).json()) as {
			ok?: boolean;
			requirementsError?: string;
		};
		if (res.ok !== true) {
			return {
				refused: `${module} did not enable (${res.requirementsError ?? 'see /enable'}): the worker's pack does not carry it`,
				cert: ''
			};
		}
	}
	return { refused: null, cert: readFileSync(crt, 'utf8') };
}

/**
 * Keycloak sends the logout response to the URL the client names, which the realm file fixes at the
 * e2e default port. Moves it to the endpoint under test through the admin API, and gives the client
 * this run's SP certificate: the signing key Keycloak verifies requests with, and the encryption key
 * it seals assertions to. With signing on the client refuses unsigned requests.
 */
async function pointLogoutAtEndpoint(cert: string): Promise<void> {
	const token = (await (
		await fetch(`${IDP}/realms/master/protocol/openid-connect/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'password',
				client_id: 'admin-cli',
				username: 'admin',
				password: 'admin'
			}).toString()
		})
	).json()) as { access_token: string };
	const auth = { authorization: `Bearer ${token.access_token}` };
	const list = (await (
		await fetch(
			`${IDP}/admin/realms/${REALM}/clients?clientId=${encodeURIComponent(CLIENT_ID)}`,
			{
				headers: auth
			}
		)
	).json()) as { id: string; attributes: Record<string, string>; redirectUris: string[] }[];
	const client = list[0];
	if (client === undefined) throw new Error(`the realm has no client ${CLIENT_ID}`);
	client.attributes['saml_single_logout_service_url_redirect'] =
		`${ENDPOINT}/simplesaml/module.php/saml/sp/saml2-logout.php/default-sp`;
	client.redirectUris = [...new Set([...client.redirectUris, `${ENDPOINT}/*`])];
	const pem = cert.replace(/-----[^-]+-----|\s/g, '');
	client.attributes['saml.client.signature'] = String(SIGNED);
	client.attributes['saml.signing.certificate'] = pem;
	client.attributes['saml.encrypt'] = String(SIGNED);
	client.attributes['saml.encryption.certificate'] = pem;
	// the key transport SimpleSAMLphp's legacy decrypt path can unwrap: RSA-OAEP with a SHA-1 digest
	client.attributes['saml.encryption.keyAlgorithm'] =
		'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p';
	client.attributes['saml.encryption.digestMethod'] = 'http://www.w3.org/2000/09/xmldsig#sha1';
	await fetch(`${IDP}/admin/realms/${REALM}/clients/${client.id}`, {
		method: 'PUT',
		headers: { ...auth, 'content-type': 'application/json' },
		body: JSON.stringify(client)
	});
}

type Issued = { acs: string; samlResponse: string; relayState: string };

/** SP-initiated: the site hands the visitor to Keycloak, which signs the visitor in and answers */
async function viaIdp(visitor: Jar, idp: Jar = new Jar()): Promise<Issued> {
	const start = await visitor.hop(site('/saml_login'));
	const sso = start.headers.get('location') ?? '';
	if (start.status !== 303 || !sso.startsWith(IDP)) {
		throw new Error(`/saml_login did not redirect to the provider: ${start.status} ${sso}`);
	}
	expect(
		new URL(sso).searchParams.get('SAMLRequest'),
		'no AuthnRequest in the redirect'
	).toBeTruthy();
	expect(new URL(sso).searchParams.has('Signature'), 'the AuthnRequest signature').toBe(SIGNED);
	const page = await idp.hop(sso);
	let html = await page.text();
	let issued = /name="SAMLResponse"/.test(html);
	if (!issued) {
		const form = /<form[^>]+id="kc-form-login"[^>]*action="([^"]+)"/.exec(html);
		if (form === null) throw new Error(`no login form at the provider: ${html.slice(0, 200)}`);
		const signedIn = await idp.hop(unescape(form[1] as string), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ username: USERNAME, password: PASSWORD }).toString()
		});
		html = await signedIn.text();
		issued = /name="SAMLResponse"/.test(html);
	}
	const action = /<form[^>]+action="([^"]+)"/.exec(html);
	const saml = /name="SAMLResponse"\s+value="([^"]+)"/.exec(html);
	const relay = /name="RelayState"\s+value="([^"]*)"/.exec(html);
	if (!issued || action === null || saml === null) {
		throw new Error(`the provider issued no SAMLResponse: ${html.slice(0, 200)}`);
	}
	return {
		acs: unescape(action[1] as string),
		samlResponse: unescape(saml[1] as string),
		relayState: unescape(relay?.[1] ?? '')
	};
}

function postAcs(
	visitor: Jar,
	issued: Issued,
	samlResponse = issued.samlResponse
): Promise<Response> {
	return visitor.hop(issued.acs, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			SAMLResponse: samlResponse,
			...(issued.relayState === '' ? {} : { RelayState: issued.relayState })
		}).toString()
	});
}

/** the whole login: provider, ACS, then the module's own route which turns the assertion into an account */
async function signIn(
	visitor: Jar,
	idp: Jar = new Jar()
): Promise<{ acs: Response; back: Response; issued: Issued }> {
	const issued = await viaIdp(visitor, idp);
	const acs = await postAcs(visitor, issued);
	const back = await visitor.hop(site(acs.headers.get('location') ?? '/saml_login'));
	return { acs, back, issued };
}

/** flips one character of the last ciphertext in the response, which is the assertion's data */
function tamperCipher(xml: string): string {
	const tag = 'CipherValue>';
	const at = xml.lastIndexOf(tag) + tag.length;
	return xml.slice(0, at) + (xml[at] === 'A' ? 'B' : 'A') + xml.slice(at + 1);
}

const location = (res: Response) => res.headers.get('location') ?? '';

describe('simplesamlphp_auth against a real SAML identity provider', () => {
	let skip = false;
	let why = '';

	beforeAll(async () => {
		skip = await e2eGate();
		if (skip) return;
		if (!(await idpReachable())) {
			why = `no identity provider at ${IDP}; docker compose -f docker/compose.yml up -d keycloak`;
			if (process.env.CI) throw new Error(`e2e: ${why}`);
			skip = true;
			return;
		}
		const { refused, cert } = await upload();
		if (refused !== null) {
			why = refused;
			skip = true;
			return;
		}
		await pointLogoutAtEndpoint(cert);
	}, 600_000);

	it('logs the visitor in through the provider and opens a session for the account it created', async (ctx) => {
		if (skip) return ctx.skip();
		const before = await authmap();
		const visitor = new Jar();
		const { acs, back, issued } = await signIn(visitor);
		// the control is the unsigned run, where the provider sends the assertion in the clear
		const sent = Buffer.from(issued.samlResponse, 'base64').toString('utf8');
		expect(sent.includes('EncryptedAssertion'), 'the assertion encryption').toBe(SIGNED);
		expect(acs.status, 'the ACS did not redirect after the assertion').toBe(303);
		expect(location(acs)).toContain('/saml_login');
		expect(back.status, await back.clone().text()).toBe(302);
		expect(visitor.has('SESS'), 'the login set no Drupal session cookie').toBe(true);

		const after = await authmap();
		// a site that has seen this account before already holds its row
		const known = before.some((r) => r['authname'] === USERNAME);
		expect(after.length).toBe(before.length + (known ? 0 : 1));
		const mapped = after.find((r) => r['authname'] === USERNAME);
		expect(mapped, 'no authmap row for the NameID the provider sent').toBeTruthy();
		const account = await rows(
			`SELECT name, mail FROM users_field_data WHERE uid = ${Number(mapped?.['uid'])}`
		);
		// the attributes the provider's mappers send: `cn` is the first name, `mail` the address
		expect(account[0]).toEqual({ name: 'Sam', mail: 'saml-rig@example.test' });

		const user = await visitor.hop(site('/user'));
		expect(location(user)).toMatch(new RegExp(`/user/${Number(mapped?.['uid'])}$`));
		expect((await visitor.hop(location(user))).status).toBe(200);
	});

	it('makes the provider refuse an AuthnRequest with its signature removed', async (ctx) => {
		if (skip) return ctx.skip();
		// the control: the client requires signed requests, so this one must not reach the login form
		if (!SIGNED) return ctx.skip();
		const start = await new Jar().hop(site('/saml_login'));
		const sso = new URL(location(start));
		sso.searchParams.delete('Signature');
		sso.searchParams.delete('SigAlg');
		const page = await (await new Jar().hop(sso.toString())).text();
		expect(page, 'the provider accepted an unsigned AuthnRequest').not.toContain(
			'id="kc-form-login"'
		);
	});

	it('does not sign in the next visitor, who sends no cookie, as the previous one', async (ctx) => {
		if (skip) return ctx.skip();
		// the control is the previous test: the same request that was just a login
		const stranger = new Jar();
		const start = await stranger.hop(site('/saml_login'));
		expect(start.status).toBe(303);
		expect(location(start).startsWith(IDP), 'an anonymous request was signed in').toBe(true);
		expect(location(await stranger.hop(site('/user')))).toContain('/user/login');
	});

	it('refuses an assertion altered after the provider signed it', async (ctx) => {
		if (skip) return ctx.skip();
		const before = await authmap();
		const visitor = new Jar();
		const issued = await viaIdp(visitor);
		const xml = Buffer.from(issued.samlResponse, 'base64').toString('utf8');
		// encrypted, the NameID is not in the clear: the change goes into the last ciphertext instead
		const forged = SIGNED
			? tamperCipher(xml)
			: xml.replace(`>${USERNAME}</saml:NameID>`, '>administrator</saml:NameID>');
		if (!SIGNED) expect(xml).toContain(`>${USERNAME}</saml:NameID>`);
		const acs = await postAcs(visitor, issued, Buffer.from(forged).toString('base64'));
		expect(acs.status).toBeGreaterThanOrEqual(400);
		expect(location(await visitor.hop(site('/saml_login'))).startsWith(IDP)).toBe(true);
		expect(await authmap()).toEqual(before);
	});

	it('refuses the same assertion delivered again', async (ctx) => {
		if (skip) return ctx.skip();
		const first = new Jar();
		const issued = await viaIdp(first);
		expect((await postAcs(first, issued)).status).toBe(303);
		// the control: the first delivery did sign that visitor in
		expect((await first.hop(site('/saml_login'))).status).toBe(302);

		const second = new Jar();
		const replay = await postAcs(second, issued);
		expect(replay.status).toBeGreaterThanOrEqual(400);
		expect(location(await second.hop(site('/saml_login'))).startsWith(IDP)).toBe(true);
	});

	it('leaves a visitor anonymous when the ACS receives no SAMLResponse', async (ctx) => {
		if (skip) return ctx.skip();
		const before = await authmap();
		const visitor = new Jar();
		const issued = await viaIdp(visitor);
		const acs = await visitor.hop(issued.acs, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: ''
		});
		expect(acs.status).toBeGreaterThanOrEqual(400);
		expect(location(await visitor.hop(site('/saml_login'))).startsWith(IDP)).toBe(true);
		expect(await authmap()).toEqual(before);
	});

	it('logs out through Drupal, which ends the SAML session at the provider too', async (ctx) => {
		if (skip) return ctx.skip();
		const visitor = new Jar();
		const idp = new Jar();
		await signIn(visitor, idp);
		const me = location(await visitor.hop(site('/user')));
		const uid = Number(/\/user\/(\d+)$/.exec(me)?.[1]);
		expect(uid, 'the visitor is not signed in before the logout').toBeGreaterThan(0);
		// Drupal stores a session under the base64url sha256 of the cookie value
		const sid = createHash('sha256')
			.update(visitor.value('SESS'))
			.digest('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		const open = () => rows(`SELECT COUNT(*) AS n FROM sessions WHERE sid = '${sid}'`);
		expect(Number((await open())[0]?.['n']), 'no session row before the logout').toBe(1);

		// Drupal's logout is a confirm form; its submit runs user_logout(), which this module hooks
		const confirm = await (await visitor.hop(site('/user/logout/confirm'))).text();
		const field = (name: string) =>
			new RegExp(
				`name="${name}"[^>]*value="([^"]*)"|value="([^"]*)"[^>]*name="${name}"`
			).exec(confirm);
		const body = new URLSearchParams({ op: 'Log out' });
		for (const name of ['form_build_id', 'form_token', 'form_id']) {
			const found = field(name);
			body.set(name, unescape(found?.[1] ?? found?.[2] ?? ''));
		}
		let res = await visitor.hop(site('/user/logout/confirm'), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: body.toString()
		});
		// SP-initiated single logout: the LogoutRequest goes to the provider, whose answer comes back
		// to the site's SLO endpoint; follow every hop the way a browser would
		for (let hop = 0; hop < 8; hop++) {
			const next = location(res);
			if (next !== '') {
				res = await (next.startsWith(IDP) ? idp : visitor).hop(
					new URL(next, ENDPOINT).toString()
				);
				continue;
			}
			const html = await res.clone().text();
			const form = /<form[^>]+action="([^"]+)"/.exec(html);
			const saml = /name="(SAMLResponse|SAMLRequest)"\s+value="([^"]+)"/.exec(html);
			if (form === null || saml === null) break;
			const target = unescape(form[1] as string);
			res = await (target.startsWith(IDP) ? idp : visitor).hop(target, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					[saml[1] as string]: unescape(saml[2] as string)
				}).toString()
			});
		}

		expect(
			location(await visitor.hop(site('/user'))),
			'the cookie still authenticates'
		).toContain('/user/login');
		expect(Number((await open())[0]?.['n']), 'the session row survived the logout').toBe(0);
		// the provider's end: a new site visitor on the same provider cookies is asked to sign in again
		const again = await new Jar().hop(site('/saml_login'));
		const page = await idp.hop(location(again));
		expect(await page.text(), 'the provider session survived the logout').not.toContain(
			'name="SAMLResponse"'
		);
	});
});
