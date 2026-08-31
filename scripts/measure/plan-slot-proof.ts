/**
 * Does Drupal accept a form whose `form_build_id` this Worker generated, with no PHP involved
 * in producing the page?
 *
 * The compiled-plan measurement priced the execution engine with a synthetic slot value. This
 * is the other half: serve `/user/login` entirely from the plan, take the build id out of the
 * bytes the JS VM produced, and POST a real login with it. Drupal answering "the form has
 * become outdated" is the finding that would close the direction; a completed login is the
 * proof it survives contact with correctness.
 *
 * Three arms, so a pass cannot be a pass for the wrong reason:
 *
 *   php    - the control: the form served by Drupal, its own build id, posted back
 *   plan   - the form served by the JS VM, a build id PHP never generated
 *   forged - a syntactically valid build id that never appeared on any page
 *
 * `forged` is the one that decides what a `plan` pass MEANS. If a made-up id is also accepted,
 * the build id is not a server-side binding on this form and the plan is not proving anything
 * about tokens -- which is itself the answer, and it is reported rather than hidden.
 *
 *   bunx wrangler dev -c wrangler.jsonc --port 8799 --var SITE_ID:extclock --persist-to <dir>
 *   bun scripts/measure/plan-slot-proof.ts [--port=8799] [--site=extclock]
 */

const arg = (name: string, fallback: string) =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const PORT = Number(arg('port', '8799'));
const SITE = arg('site', 'extclock');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'cfw-ExtClock-8812-pass');
const BASE = `http://127.0.0.1:${PORT}`;

const url = (path: string) => {
	const u = new URL(BASE + path);
	if (!u.searchParams.has('site')) u.searchParams.set('site', SITE);
	return u;
};

const buildIdOf = (html: string): string | null =>
	/name="form_build_id"\s+value="(form-[A-Za-z0-9_-]{43})"/.exec(html)?.[1] ?? null;

/** posts a login and reports what Drupal did with it */
async function login(buildId: string): Promise<Record<string, unknown>> {
	const body = new URLSearchParams({
		name: USER,
		pass: PASS,
		form_id: 'user_login_form',
		form_build_id: buildId,
		op: 'Log in'
	});
	const res = await fetch(url('/serve?path=%2Fuser%2Flogin&edge=0'), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body,
		redirect: 'manual',
		signal: AbortSignal.timeout(300_000)
	});
	const text = await res.text();
	const cookies = res.headers.get('set-cookie') ?? '';
	return {
		status: res.status,
		location: res.headers.get('location'),
		// the two refusals that matter, in Drupal's own words
		saysOutdated: /form has become outdated/i.test(text),
		saysTokenInvalid: /security token/i.test(text),
		// a session cookie is the only unambiguous evidence the login was accepted
		sessionCookie: /SESS[a-f0-9]+=/.test(cookies) || /SSESS[a-f0-9]+=/.test(cookies),
		bytes: text.length
	};
}

const get = async (path: string) => {
	const res = await fetch(url(path), { signal: AbortSignal.timeout(300_000) });
	return { status: res.status, text: await res.text() };
};

// the plan has to exist and has to be servable; a 409 here is the fail-closed path doing its job
const compiled = (await (
	await fetch(url('/plan?action=compile&path=%2Fuser%2Flogin'))
).json()) as Record<string, unknown>;

const php = await get('/assemble?path=%2Fuser%2Flogin&bins=page,dynamic_page_cache');
const stored = await get('/serve?path=%2Fuser%2Flogin&edge=0');
const plan = await get('/plan?action=run&path=%2Fuser%2Flogin');

const phpId = buildIdOf(stored.text);
const planId = buildIdOf(plan.text);
const forgedId = `form-${'A'.repeat(43)}`;

const out = {
	compiled,
	served: {
		phpStatus: php.status,
		planStatus: plan.status,
		planBytes: plan.text.length,
		storedBytes: stored.text.length,
		// the JS VM produced a build id, and it is not the one PHP last stored
		phpBuildId: phpId,
		planBuildId: planId,
		planIdIsFresh: !!planId && planId !== phpId
		// NOT re-derived here. Whether the plan's page is Drupal's page is decided by
		// `compiled.explainsBoth`, which the object computes against the two real renders byte
		// for byte; a substitution rebuilt in this script is a weaker check with its own bugs,
		// and the first version of it reported a mismatch on a correct page. What this script
		// adds is the POST, which no byte comparison can stand in for
	},
	posts: {
		php: await login(phpId ?? forgedId),
		plan: await login(planId ?? forgedId),
		forged: await login(forgedId)
	}
};

console.log(JSON.stringify(out, null, 2));
