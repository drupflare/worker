import { createHash } from 'node:crypto';

/**
 * Does an AUTHENTICATED render reach the shared page cache?
 *
 *   bun scripts/qa/cache-poison.ts --origin=http://localhost:8791 --site=<name> [--path=/]
 *
 * `devel` was on the "should work" list because nothing it does needs outbound or cron. That reads
 * the module against the wrong constraint. Its whole value is `dpm()` and kint dumping debug output
 * INTO THE RENDERED PAGE, and this runtime has two properties that make that dangerous in a way it
 * is not on a normal host: the interpreter PERSISTS between requests, and anonymous output is stored
 * in `cfw_page` and served to everyone. That is the same shape as the uid-1 poisoning bug this
 * project has already shipped once.
 *
 * So the question is not "does devel install" -- it is not even in the pack -- but "can an
 * authenticated render land in the shared cache at all". That is a property of the RUNTIME, testable
 * today with any module that renders differently for a logged-in user, and if the answer is yes then
 * devel is the least of it: every admin page is a leak waiting for a cache key.
 *
 * The probe is three requests and a diff:
 *
 *   1. anonymous GET of `path`, recorded
 *   2. the same GET carrying a Drupal-shaped session cookie
 *   3. anonymous GET again
 *
 * If (3) differs from (1) and resembles (2), authenticated HTML reached the shared copy. The cookie
 * name matches `SESSION_COOKIE_RE` in `src/ops/auth-budget.ts` -- `S?SESS` plus 32 hex -- because
 * that is the predicate the Worker actually uses to decide a request is authenticated. A cookie
 * shaped any other way tests nothing.
 */

const args = process.argv.slice(2);
const flag = (name: string, fallback = ''): string => {
	const hit = args.find((a: string) => a === `--${name}` || a.startsWith(`--${name}=`));
	if (hit === undefined) return fallback;
	return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '1';
};

const origin = flag('origin', 'http://localhost:8791').replace(/\/+$/, '');
const site = flag('site', 'poison');
const path = flag('path', '/');

/** a cookie the Worker's own predicate accepts as a login */
const SESSION_COOKIE = `SESS${'a'.repeat(32)}=probe-session-value`;

const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

interface Shot {
	label: string;
	status: number;
	tier: string | null;
	bytes: number;
	sha: string;
	authMode: string | null;
	edgePut: string | null;
}

async function shot(label: string, cookie: string | null): Promise<Shot> {
	const url = new URL('/serve', origin);
	url.searchParams.set('site', site);
	url.searchParams.set('path', path);
	// the edge tier is bypassed so the object's own copy is what is being read; leaving it on would
	// test `caches.default` rather than `cfw_page` and the two have different guards
	url.searchParams.set('edge', '0');
	const res = await fetch(url, {
		headers: cookie ? { cookie } : {},
		signal: AbortSignal.timeout(300_000)
	});
	const body = await res.text();
	return {
		label,
		status: res.status,
		tier: res.headers.get('x-cfw-cache'),
		bytes: body.length,
		sha: digest(body),
		authMode: res.headers.get('x-cfw-auth-mode'),
		edgePut: res.headers.get('x-cfw-edge-put')
	};
}

/**
 * Empties the stored copy so the NEXT request renders rather than answering from it.
 *
 * Without this the whole probe is inconclusive by construction: a warm `cfw_page` answers every
 * shot from the same row, so all three digests match and nothing has been tested. `/invalidate`
 * bumps the generation, which is the supported way to make the object re-render a path.
 */
async function invalidate(): Promise<string> {
	const url = new URL('/invalidate', origin);
	url.searchParams.set('site', site);
	const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	return `${res.status} ${(await res.text()).slice(0, 120)}`;
}

const rows: Shot[] = [];
// the ORDER is the whole probe. An authenticated render has to be the one that fills a cold cache,
// because that is the only sequence in which its output could become the shared copy. Doing the
// anonymous request first fills the row and tests nothing.
console.log(`invalidate: ${await invalidate()}`);
rows.push(await shot('1 authenticated (cold)', SESSION_COOKIE));
rows.push(await shot('2 anonymous (after)', null));
console.log(`invalidate: ${await invalidate()}`);
rows.push(await shot('3 anonymous (cold)', null));

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
console.log(
	pad('shot', 24) +
		pad('status', 8) +
		pad('tier', 10) +
		pad('bytes', 9) +
		pad('sha256', 18) +
		'auth-mode'
);
console.log('-'.repeat(90));
for (const r of rows) {
	console.log(
		pad(r.label, 24) +
			pad(String(r.status), 8) +
			pad(r.tier ?? '-', 10) +
			pad(String(r.bytes), 9) +
			pad(r.sha, 18) +
			(r.authMode ?? '-')
	);
}

const before = rows[0] as Shot;
const auth = rows[1] as Shot;
const after = rows[2] as Shot;

const anonChanged = before.sha !== after.sha;
const afterMatchesAuth = after.sha === auth.sha;
const authDiffers = auth.sha !== before.sha;

console.log('');
console.log(`authenticated render differs from anonymous: ${authDiffers}`);
console.log(`anonymous response changed after it:         ${anonChanged}`);
console.log(`anonymous now byte-identical to the authed:  ${afterMatchesAuth}`);
console.log('');

if (anonChanged && afterMatchesAuth) {
	console.log('POISONED: an authenticated render reached the shared page cache');
	process.exit(3);
}
if (!authDiffers) {
	console.log(
		'INCONCLUSIVE: the authenticated render was byte-identical to the anonymous one, so this ' +
			'path cannot distinguish a leak from a correct shared copy. Re-run against a path that ' +
			'renders differently for a logged-in user.'
	);
	process.exit(2);
}
console.log('CLEAN: the authenticated render did not replace the shared copy');
