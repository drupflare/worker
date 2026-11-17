/**
 * Drives a WordPress site on a local `wrangler dev` through claim, login, admin, REST, AJAX and
 * every kind of exit WordPress ends a request with, and prints one JSON report.
 *
 * It starts its own worker on a scratch state directory and removes both when it finishes. The
 * password is generated per run. `E2E_STORE=0` runs the same sequence with the test store switch off.
 *
 * Usage: `bun scripts/wp/serve-e2e.ts` (environment: `E2E_PORT`, `E2E_STORE`, `E2E_KEEP=1`).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 8791);
const STORE = (process.env.E2E_STORE ?? '1') === '1';
const ORIGIN = `http://localhost:${PORT}`;
const PASS = `pw-${crypto.randomUUID()}`;
const STATE = mkdtempSync(join(tmpdir(), 'wp-serve-e2e-'));

type Answer = { status: number; headers: Headers; body: string; cookies: string[] };
type Check = { name: string; ok: boolean; evidence: unknown };
const checks: Check[] = [];
const check = (name: string, ok: boolean, evidence: unknown = undefined) => {
	checks.push({ name, ok, evidence });
};

const log: string[] = [];
const vars = [
	'PW_DIAGNOSTICS:1',
	'CMS:wordpress',
	'PLAN:paid',
	`SITE_ORIGIN:${ORIGIN}`,
	'SQL_CHUNK_PREFIX:wordpress/sql',
	'HEAP_SNAPSHOT:0',
	'CRON_INTERVAL_MS:0',
	...(STORE ? ['WORDPRESS_PAGE_CACHE:1'] : [])
];
const worker: ChildProcess = spawn(
	'bunx',
	[
		'wrangler',
		'dev',
		'-c',
		'wrangler.jsonc',
		'--port',
		String(PORT),
		'--inspector-port',
		String(PORT + 500),
		'--persist-to',
		STATE,
		...vars.flatMap((v) => ['--var', v])
	],
	{ cwd: new URL('../..', import.meta.url).pathname, detached: true }
);
worker.stdout?.on('data', (d) => log.push(String(d)));
worker.stderr?.on('data', (d) => log.push(String(d)));

const stop = async () => {
	try {
		if (worker.pid !== undefined) process.kill(-worker.pid, 'SIGTERM');
	} catch {
		// already gone
	}
	await new Promise((r) => setTimeout(r, 1500));
	if (process.env.E2E_KEEP !== '1') rmSync(STATE, { recursive: true, force: true });
};

const jar = new Map<string, string>();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const take = (cookies: string[]) => {
	for (const line of cookies) {
		const [pair = ''] = line.split(';');
		const eq = pair.indexOf('=');
		const name = pair.slice(0, eq);
		const value = pair.slice(eq + 1);
		// a cookie WordPress clears carries an expiry in the past, not the epoch
		const expires = /expires=([^;]+)/i.exec(line)?.[1];
		const gone =
			(expires !== undefined && Date.parse(expires) < Date.now()) || /max-age=0/i.test(line);
		if (gone || value === 'deleted') jar.delete(name);
		else jar.set(name, value);
	}
};

async function call(
	path: string,
	init: RequestInit & { cookie?: boolean; headers?: Record<string, string> } = {}
): Promise<Answer> {
	const { cookie, headers, ...rest } = init;
	const res = await fetch(`${ORIGIN}${path}`, {
		redirect: 'manual',
		...rest,
		headers: {
			accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			...(cookie === false || jar.size === 0 ? {} : { cookie: cookieHeader() }),
			...headers
		}
	});
	const cookies = res.headers.getSetCookie();
	if (cookie !== false) take(cookies);
	return { status: res.status, headers: res.headers, body: await res.text(), cookies };
}
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const stored = (a: Answer) =>
	['EDGE', 'MEM', 'KV', 'HIT'].includes(a.headers.get('x-cfw-cache') ?? '') ||
	a.headers.get('x-cfw-edge') === 'HIT';
const authCookies = () =>
	[...jar.keys()].filter((k) => /^wordpress(_logged_in)?_[0-9a-f]{32}$/.test(k));

async function ready(): Promise<void> {
	const deadline = Date.now() + 240_000;
	for (;;) {
		try {
			const res = await fetch(`${ORIGIN}/wp-login.php`, { headers: { accept: '*/*' } });
			if (res.status === 200) return;
		} catch {
			// not listening yet
		}
		if (Date.now() > deadline) throw new Error('the worker never answered 200');
		await new Promise((r) => setTimeout(r, 1500));
	}
}

async function drive(): Promise<void> {
	await ready();
	const setup = await call('/', { cookie: false });
	check(
		'an unclaimed site shows the setup page to a browser',
		setup.headers.get('x-cfw-setup') === 'required',
		{ header: setup.headers.get('x-cfw-setup') }
	);

	// claim
	const claim = await call('/firstrun', {
		method: 'POST',
		body: JSON.stringify({
			adminName: 'owner',
			adminMail: 'owner@example.test',
			adminPass: PASS,
			siteName: 'E2E Site'
		}),
		cookie: false
	});
	const claimed = JSON.parse(claim.body) as Record<string, unknown>;
	check(
		'the claim creates the administrator and shows the owner token once, never the password',
		claim.status === 200 &&
			typeof claimed.ownerToken === 'string' &&
			!claim.body.includes(PASS),
		{ status: claim.status, keys: Object.keys(claimed) }
	);
	const again = await call('/firstrun', {
		method: 'POST',
		body: JSON.stringify({ adminName: 'intruder', adminPass: 'another-pass-1' }),
		cookie: false
	});
	check('a second claim is refused with 409', again.status === 409, { status: again.status });

	const front = await call('/', { headers: { accept: '*/*' }, cookie: false });
	check(
		'the front page answers 200 with the installed title',
		front.status === 200 && front.body.includes('<title>E2E Site</title>'),
		{ status: front.status }
	);

	// stores, anonymous
	const seq: Array<Record<string, string | null>> = [];
	let served = false;
	for (let i = 0; i < 8; i++) {
		const a = await call('/', { headers: { accept: '*/*' }, cookie: false });
		seq.push({
			cache: a.headers.get('x-cfw-cache'),
			edge: a.headers.get('x-cfw-edge'),
			put: a.headers.get('x-cfw-edge-put'),
			kvPut: a.headers.get('x-cfw-kv-put'),
			cc: a.headers.get('cache-control')
		});
		if (stored(a)) served = true;
		if (STORE && served && i >= 3) break;
	}
	if (STORE) {
		check(
			'an anonymous page is stored and served from the store on a later request',
			served,
			seq
		);
	} else {
		check(
			'with the switch off nothing is stored and nothing is served from a store',
			!served && seq.every((s) => s.put === 'skipped:page-cache-off'),
			seq
		);
	}

	// login, invalid first
	const bad = await call('/wp-login.php', {
		method: 'POST',
		headers: { ...FORM, cookie: 'wordpress_test_cookie=WP%20Cookie%20check' },
		body: form({
			log: 'owner',
			pwd: 'not-the-password',
			'wp-submit': 'Log In',
			redirect_to: `${ORIGIN}/wp-admin/`,
			testcookie: '1'
		}),
		cookie: false
	});
	check(
		'an invalid login shows the error and sets no authentication cookie',
		bad.status === 200 &&
			/login_error|incorrect/i.test(bad.body) &&
			!bad.cookies.some((c) => /^wordpress(_logged_in)?_[0-9a-f]{32}=/.test(c)),
		{ status: bad.status, cookies: bad.cookies.map((c) => c.split('=')[0]) }
	);

	const login = await call('/wp-login.php', {
		method: 'POST',
		headers: { ...FORM, cookie: 'wordpress_test_cookie=WP%20Cookie%20check' },
		body: form({
			log: 'owner',
			pwd: PASS,
			'wp-submit': 'Log In',
			redirect_to: `${ORIGIN}/wp-admin/`,
			testcookie: '1'
		}),
		cookie: false
	});
	take(login.cookies);
	const names = login.cookies.map((c) => c.split('=')[0] ?? '');
	check(
		'a valid login redirects to /wp-admin/ and sets the login cookies',
		login.status === 302 &&
			login.headers.get('location') === `${ORIGIN}/wp-admin/` &&
			names.some((n) => n.startsWith('wordpress_logged_in_')) &&
			names.some((n) => /^wordpress_[0-9a-f]{32}$/.test(n)),
		{ status: login.status, location: login.headers.get('location'), cookies: names }
	);
	const afterLogin = await call('/?s=after-login-exit-check', {
		cookie: false,
		headers: { accept: '*/*' }
	});
	check(
		'the request after the login redirect is clean',
		afterLogin.status === 200 && afterLogin.body.includes('<title>'),
		{ status: afterLogin.status }
	);

	// the same path with the cookie is fresh WordPress, never the stored copy
	const withCookie = await call('/');
	check(
		'the same path with the login cookie answers fresh WordPress, not the stored copy',
		withCookie.status === 200 &&
			withCookie.body.includes('wpadminbar') &&
			!stored(withCookie) &&
			withCookie.headers.get('x-cfw-edge-put') !== 'deferred',
		{
			cache: withCookie.headers.get('x-cfw-cache'),
			put: withCookie.headers.get('x-cfw-edge-put'),
			cc: withCookie.headers.get('cache-control')
		}
	);
	const again2 = await call('/', { cookie: false, headers: { accept: '*/*' } });
	check('the anonymous copy never held the signed in page', !again2.body.includes('wpadminbar'), {
		cache: again2.headers.get('x-cfw-cache')
	});
	for (let i = 0; i < 3; i++) {
		const c = await call('/', {
			headers: { cookie: `wordpress_logged_in_${'a'.repeat(32)}=x` },
			cookie: false
		});
		check(
			`a request with another WordPress cookie is not served from the store (${i + 1})`,
			!stored(c) && c.headers.get('x-cfw-edge-put') !== 'deferred',
			{ cache: c.headers.get('x-cfw-cache'), put: c.headers.get('x-cfw-edge-put') }
		);
	}
	const unknown = await call('/', { headers: { cookie: 'unclassified=1' }, cookie: false });
	check(
		'an unclassified cookie skips the shared copy',
		!stored(unknown) && unknown.headers.get('x-cfw-edge-put') !== 'deferred',
		{ cache: unknown.headers.get('x-cfw-cache') }
	);
	const app = await call('/', {
		headers: { authorization: `Basic ${btoa('owner:abcd efgh ijkl mnop qrst uvwx')}` },
		cookie: false
	});
	check(
		'an application password request is not served from the store and not stored',
		!stored(app) && app.headers.get('x-cfw-edge-put') !== 'deferred',
		{ cache: app.headers.get('x-cfw-cache'), put: app.headers.get('x-cfw-edge-put') }
	);
	const loginPage = await call('/wp-login.php', { cookie: false, headers: { accept: '*/*' } });
	check(
		'a response that sets a cookie is not stored',
		loginPage.cookies.length > 0 &&
			loginPage.headers.get('x-cfw-edge-put') !== 'deferred' &&
			loginPage.headers.get('x-cfw-kv-put') !== 'deferred',
		{
			cookies: loginPage.cookies.map((c) => c.split('=')[0]),
			put: loginPage.headers.get('x-cfw-edge-put')
		}
	);

	// admin
	const dash = await call('/wp-admin/');
	check(
		'/wp-admin/ answers 200 with the dashboard',
		dash.status === 200 && /Dashboard/.test(dash.body) && dash.body.includes('wpadminbar'),
		{ status: dash.status, bytes: dash.body.length, body: dash.body.slice(0, 400) }
	);
	const general = await call('/wp-admin/options-general.php');
	check(
		'/wp-admin/options-general.php answers 200 with the settings form',
		general.status === 200 && /General Settings/.test(general.body),
		{ status: general.status, bytes: general.body.length }
	);
	check(
		'no admin page is stored',
		[dash, general].every((a) => !stored(a) && a.headers.get('x-cfw-edge-put') !== 'deferred'),
		undefined
	);

	// REST
	const restNonce = (await call('/wp-admin/admin-ajax.php?action=rest-nonce')).body.trim();
	check('admin-ajax answers the rest-nonce action', /^[0-9a-f]{10}$/.test(restNonce), {
		body: restNonce.slice(0, 200)
	});
	const me = await call('/wp-json/wp/v2/users/me', { headers: { 'x-wp-nonce': restNonce } });
	const meJson = JSON.parse(me.body || '{}') as { id?: number; slug?: string };
	check(
		'GET /wp-json/wp/v2/users/me with cookie and nonce is the administrator',
		me.status === 200 && meJson.id === 1,
		{ status: me.status, id: meJson.id, slug: meJson.slug }
	);
	const meAnon = await call('/wp-json/wp/v2/users/me', { cookie: false });
	check('the same route without a cookie is 401', meAnon.status === 401, {
		status: meAnon.status
	});
	const meNoNonce = await call('/wp-json/wp/v2/users/me');
	check(
		'with the cookie and no nonce it is refused as WordPress refuses it',
		meNoNonce.status === 401 || meNoNonce.status === 403,
		{ status: meNoNonce.status }
	);
	const post = await call('/wp-json/wp/v2/posts', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-wp-nonce': restNonce },
		body: JSON.stringify({ title: 'E2E draft', status: 'draft', content: 'draft body' })
	});
	const postJson = JSON.parse(post.body || '{}') as { id?: number; status?: string };
	check(
		'POST /wp-json/wp/v2/posts creates a draft',
		post.status === 201 && postJson.status === 'draft' && typeof postJson.id === 'number',
		{ status: post.status, id: postJson.id, state: postJson.status }
	);
	const postAnon = await call('/wp-json/wp/v2/posts', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ title: 'x' }),
		cookie: false
	});
	check('an unauthenticated POST to posts is 401', postAnon.status === 401, {
		status: postAnon.status
	});
	const afterRest = await call('/', { headers: { accept: '*/*' }, cookie: false });
	check(
		'REST_REQUEST does not reach the next request: the front page is HTML',
		afterRest.status === 200 &&
			afterRest.body.includes('<title>') &&
			/text\/html/.test(afterRest.headers.get('content-type') ?? ''),
		{ type: afterRest.headers.get('content-type') }
	);

	// AJAX
	const compression = await call('/wp-admin/admin-ajax.php?action=wp-compression-test&test=1');
	check(
		'an authenticated admin-ajax action ends in wp_die and keeps its body and status',
		compression.status === 200 && compression.body.length > 0,
		{ status: compression.status, bytes: compression.body.length }
	);
	const noAction = await call('/wp-admin/admin-ajax.php?action=no_such_action', {
		cookie: false
	});
	check(
		'admin-ajax wp_die(0, 400) returns its 400 and body',
		noAction.status === 400 && noAction.body === '0',
		{ status: noAction.status, body: noAction.body }
	);
	const afterAjax = await call('/wp-admin/options-general.php');
	check(
		'DOING_AJAX does not reach the next request: the settings page is a full page',
		afterAjax.status === 200 && /General Settings/.test(afterAjax.body),
		{ status: afterAjax.status }
	);

	// the other endings
	const redirectUnauth = await call('/wp-admin/', { cookie: false });
	check(
		'auth_redirect (wp_redirect, exit) returns 302 to the login page',
		redirectUnauth.status === 302 &&
			/wp-login\.php\?redirect_to=/.test(redirectUnauth.headers.get('location') ?? ''),
		{ status: redirectUnauth.status, location: redirectUnauth.headers.get('location') }
	);
	const ays = await call('/wp-login.php?action=logout');
	check(
		'wp_die on a nonce failure returns its status and page',
		ays.status === 403 && /log out/i.test(ays.body),
		{ status: ays.status }
	);
	const restIndex = await call('/wp-json/', { cookie: false });
	check(
		'the REST index (die) returns 200 JSON',
		restIndex.status === 200 &&
			/^application\/json/.test(restIndex.headers.get('content-type') ?? ''),
		{ status: restIndex.status }
	);
	const canonical = await call('/?p=1', { cookie: false, headers: { accept: '*/*' } });
	check(
		'the canonical redirect (exit) returns its 301 and Location',
		canonical.status === 301 && !!canonical.headers.get('location'),
		{ status: canonical.status, location: canonical.headers.get('location') }
	);
	const clean = await call('/?s=clean-after-endings', {
		cookie: false,
		headers: { accept: '*/*' }
	});
	check(
		'the request after every ending is clean',
		clean.status === 200 && clean.body.includes('<title>'),
		{ status: clean.status }
	);

	// logout through the nonce link on the admin bar
	if (process.env.E2E_DUMP) writeFileSync(process.env.E2E_DUMP, dash.body);
	const logoutHref = /href=["']([^"']*wp-login\.php\?action=logout[^"']*)["']/
		.exec(dash.body)?.[1]
		?.replaceAll('&#038;', '&')
		.replaceAll('&amp;', '&');
	if (logoutHref !== undefined) {
		const path = logoutHref.replace(ORIGIN, '');
		const out = await call(path);
		check(
			'logout redirects and clears the login cookies',
			(out.status === 302 || out.status === 200) && authCookies().length === 0,
			{ status: out.status, location: out.headers.get('location'), left: authCookies() }
		);
		const gone = await call('/wp-admin/');
		check('after logout /wp-admin/ asks for the login again', gone.status === 302, {
			status: gone.status
		});
	} else {
		check('the admin bar carries a logout link', false, undefined);
	}

	// nothing exited the runtime, and the password is nowhere
	const statsRes = await fetch(`${ORIGIN}/serve-stats`);
	const statsText = await statsRes.text();
	const stats = JSON.parse(statsText) as Record<string, unknown>;
	check('no run ended in an exit or a trap', stats.exitedRuns === 0 && stats.trappedRuns === 0, {
		exitedRuns: stats.exitedRuns,
		trappedRuns: stats.trappedRuns
	});
	check(
		'the password is not in /serve-stats or the worker log',
		!statsText.includes(PASS) && !log.join('').includes(PASS),
		{ logBytes: log.join('').length }
	);
}

let failure: string | undefined;
try {
	await drive();
} catch (e) {
	failure = String((e as Error)?.stack ?? e);
}
await stop();
const failed = checks.filter((c) => !c.ok);
console.log(
	JSON.stringify(
		{
			store: STORE,
			port: PORT,
			failure,
			passed: checks.length - failed.length,
			failed: failed.length,
			checks
		},
		null,
		1
	)
);
process.exit(failure !== undefined || failed.length > 0 ? 1 : 0);
