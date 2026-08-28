import { describe, expect, it } from 'vitest';
import { FREE_QUOTAS, ROWS_PER_FILL, envelope } from '../../scripts/measure/free-envelope';
import {
	AUTH_ALLOWANCE_HEADER,
	AUTH_DAY_HEADER,
	AUTH_SPENT_HEADER,
	DAILY_DO_QUOTA,
	DAILY_ROWS_QUOTA,
	DEFAULT_AUTH_ROWS_FRACTION,
	DO_REQUESTS_PER_AUTH_RENDER,
	MAX_AUTH_ROWS_FRACTION,
	MIN_AUTH_ROWS_FRACTION,
	ROWS_PER_AUTH_RENDER,
	SESSION_COOKIE_RE,
	authAllowance,
	authSpendHeaders,
	decideAuthMode,
	hasSessionCookie,
	isAuthenticatedRequest,
	parseAuthSpend,
	secondsUntilUtcReset,
	spendForToday,
	utcDayKey
} from '../../src/ops/auth-budget';
import siteSource from '../../src/site.ts?raw';

/**
 * The authenticated allowance, and the ladder that keeps the site from going dark.
 *
 * Every number here is checked against `scripts/measure/free-envelope.ts` rather than restated,
 * which is what the first describe covers: the module copies two measured constants to keep a CLI
 * script out of the Worker bundle, and a copied measured number is exactly the drift this project
 * has been bitten by twice.
 */

describe('the constants are pinned to the envelope script, not restated', () => {
	it('matches the daily rows quota', () => {
		expect(DAILY_ROWS_QUOTA).toBe(FREE_QUOTAS.rowsWrittenPerDay);
	});

	it('matches the daily DO quota', () => {
		expect(DAILY_DO_QUOTA).toBe(FREE_QUOTAS.doRequestsPerDay);
	});

	it('prices an authenticated view as a realRender, not a warm reassemble', () => {
		// an authenticated view empties both bins for that user, so it is the render figure. Pricing
		// it as warmReassemble (2) would overstate the allowance six-fold
		expect(ROWS_PER_AUTH_RENDER).toBe(ROWS_PER_FILL.realRender);
		expect(ROWS_PER_AUTH_RENDER).not.toBe(ROWS_PER_FILL.warmReassemble);
	});

	it('is the 12 the audit measured, not the retired flat 17', () => {
		// 13 until the serve tables became WITHOUT ROWID and a fill stopped paying an index row;
		// `tests/integration/rows-per-fill-audit.spec.ts` is what re-measures it
		expect(ROWS_PER_AUTH_RENDER).toBe(12);
	});
});

describe('session detection', () => {
	it.each([
		['SESS0123456789abcdef0123456789abcdef=x', 'http session'],
		['SSESS0123456789abcdef0123456789abcdef=x', 'https session'],
		['foo=1; SSESS0123456789abcdef0123456789abcdef=x; bar=2', 'among other cookies'],
		[' SSESS0123456789abcdef0123456789abcdef=x ', 'with surrounding whitespace']
	])('detects %s (%s)', (cookie) => {
		expect(hasSessionCookie(cookie)).toBe(true);
	});

	it.each([
		[null, 'no header'],
		[undefined, 'undefined'],
		['', 'empty'],
		['foo=1; bar=2', 'unrelated cookies'],
		['NO_CACHE=1', 'the page-cache bypass, which is set for anonymous users too'],
		['Drupal.visitor.name=bob', 'a visitor cookie, which is not a login'],
		['SESSION=x', "another framework's session cookie, which is NOT Drupal's shape"],
		['XSESS0123456789abcdef0123456789abcdef=x', 'a prefix that does not begin the name'],
		['SESSshort=x', 'a suffix that is not 32 hex characters'],
		['SESS0123456789ABCDEF0123456789ABCDEF=x', 'uppercase hex; PHP hashes lowercase'],
		['SESS0123456789abcdef0123456789abcdefff=x', '34 hex characters, so not substr(...,0,32)']
	])('does not detect %s (%s)', (cookie, why) => {
		// both columns are declared: vitest types the callback against every column, and taking
		// only the first is a tsc error. Using `why` as the assertion label is the better shape
		// anyway -- a failure then says WHICH cookie shape regressed.
		expect(hasSessionCookie(cookie as string | null | undefined), why).toBe(false);
	});

	it('reads the cookie off a request', () => {
		const authed = new Request('https://x/', {
			headers: { cookie: 'SSESS0123456789abcdef0123456789abcdef=x' }
		});
		expect(isAuthenticatedRequest(authed)).toBe(true);
		expect(isAuthenticatedRequest(new Request('https://x/'))).toBe(false);
	});

	it('is exactly 32 lowercase hex, which is what the source produces in every branch', () => {
		// `getUnprefixedName()` returns substr(hash('sha256', ...), 0, 32) OUTSIDE its if/elseif/else
		// (SessionConfiguration.php:109), so the test-UA and cookie_domain branches hash too. A looser
		// pattern matched `SESSION=` and would have charged every such request as authenticated
		expect(SESSION_COOKIE_RE.source).toContain('[0-9a-f]{32}');
		expect(hasSessionCookie('SSESS' + 'a'.repeat(32) + '=x')).toBe(true);
		expect(hasSessionCookie('SSESS' + 'a'.repeat(31) + '=x')).toBe(false);
	});

	/**
	 * BOTH PREFIXES AND ONLY THOSE TWO. `SessionConfiguration.php:79` is
	 * `$prefix = $request->isSecure() ? 'SSESS' : 'SESS'`, so a site reached over HTTP and the same
	 * site over HTTPS name their cookie differently -- matching only one would read every request on
	 * the other scheme as anonymous, and serve a logged-in visitor the shared page.
	 */
	it('matches both the secure and the plain prefix, and nothing shaped like them', () => {
		const id = 'a'.repeat(32);
		expect(hasSessionCookie(`SESS${id}=x`)).toBe(true);
		expect(hasSessionCookie(`SSESS${id}=x`)).toBe(true);
		for (const name of [`SSSESS${id}`, `XSESS${id}`, `SES${id}`, `SESS${id.toUpperCase()}`]) {
			expect(hasSessionCookie(`${name}=x`), name).toBe(false);
		}
	});
});

describe('authAllowance: the reservation splits the meter', () => {
	it('reserves a quarter of the rows by default', () => {
		const a = authAllowance({ PLAN: 'free' });
		expect(a.fraction).toBe(DEFAULT_AUTH_ROWS_FRACTION);
		expect(a.rowsReserved).toBe(25_000);
		expect(a.rowsForAnonymous).toBe(75_000);
	});

	it('buys 2,083 authenticated views/day at 12 rows each', () => {
		expect(authAllowance({ PLAN: 'free' }).rendersPerDay).toBe(2_083);
	});

	it('is bound by rows rather than DO requests', () => {
		// 25,000 rows / 12 = 2,083; 25,000 DO requests / 1 = 25,000. Rows bind by 12x, which is why
		// the reservation is expressed as a rows fraction
		const a = authAllowance({ PLAN: 'free' });
		expect(a.boundBy).toBe('rows');
		expect(a.doRequestsReserved).toBe(25_000);
	});

	/**
	 * The OTHER branch, which no shipped configuration reaches.
	 *
	 * The quotas are equal and a render is one hop, so `byRows <= byDo` for every integer
	 * rowsPerRender and `'rows'` always wins. Driving it needs a render that costs less than one row,
	 * which is the shape a boot-on-the-alarm retry would produce -- so it is covered rather than
	 * deleted, and this is the test that would fail if someone deleted it as dead.
	 */
	it('reports do when a render costs fewer rows than DO hops', () => {
		const a = authAllowance({ PLAN: 'free', AUTH_ROWS_PER_RENDER: '0.5' });
		expect(a.boundBy).toBe('do');
		expect(a.rendersPerDay).toBe(a.doRequestsReserved);
	});

	// the constants that make the branch above unreachable today, asserted so a change is visible
	it('has equal quotas and one hop per render, which is WHY rows always bind', () => {
		expect(DAILY_DO_QUOTA).toBe(DAILY_ROWS_QUOTA);
		expect(DO_REQUESTS_PER_AUTH_RENDER).toBe(1);
		expect(ROWS_PER_AUTH_RENDER).toBeGreaterThan(DO_REQUESTS_PER_AUTH_RENDER);
	});

	it('leaves the anonymous side above what a 3M-visit month needs', () => {
		// the whole reservation is only safe if what remains still clears the real workload
		const a = authAllowance({ PLAN: 'free' });
		const full = envelope(undefined, { windowed: true });
		expect(full.regenerationsPerDay).toBe(8_196);
		expect(full.regenerationBoundBy).toBe('rows');
		// rows scale linearly, so the anonymous slice is the same ceiling times the leftover fraction
		const anonymous = Math.floor(
			full.regenerationsPerDay * (a.rowsForAnonymous / DAILY_ROWS_QUOTA)
		);
		expect(anonymous).toBe(6_147);
		// 1,000/day is the need at 3M visits/month and 1% dynamic
		expect(anonymous / 1_000).toBeGreaterThan(5);
	});

	it('clamps a fraction that would delete the protection or the capability', () => {
		expect(authAllowance({ PLAN: 'free', AUTH_ROWS_FRACTION: 0.99 }).fraction).toBe(
			MAX_AUTH_ROWS_FRACTION
		);
		expect(authAllowance({ PLAN: 'free', AUTH_ROWS_FRACTION: 0.001 }).fraction).toBe(
			MIN_AUTH_ROWS_FRACTION
		);
	});

	it('falls back to the default for a fraction that is not a number', () => {
		for (const bad of ['', null, undefined, 'abc', 0, -1]) {
			expect(authAllowance({ PLAN: 'free', AUTH_ROWS_FRACTION: bad as never }).fraction).toBe(
				DEFAULT_AUTH_ROWS_FRACTION
			);
		}
	});

	it('takes a rows-per-render override for a site with a different profile', () => {
		const a = authAllowance({ PLAN: 'free', AUTH_ROWS_PER_RENDER: 25 });
		expect(a.rowsPerRender).toBe(25);
		expect(a.rendersPerDay).toBe(1_000);
	});

	it('does not enforce on paid, where these meters do not bind', () => {
		expect(authAllowance({ PLAN: 'paid' }).enforced).toBe(false);
		expect(authAllowance({ PLAN: 'free' }).enforced).toBe(true);
	});

	it('treats an absent or misspelt plan as free, never as paid', () => {
		// a typo must not silently hand out an unreserved budget
		expect(authAllowance({}).enforced).toBe(true);
		expect(authAllowance({ PLAN: 'PAIDD' }).enforced).toBe(true);
		expect(authAllowance(null).enforced).toBe(true);
	});
});

describe('spendForToday: the UTC rollover', () => {
	const noon = Date.UTC(2026, 7, 13, 12, 0, 0);

	it('keeps a record from today', () => {
		expect(spendForToday({ day: '2026-08-13', renders: 40 }, noon)).toEqual({
			day: '2026-08-13',
			renders: 40
		});
	});

	it('discards a record from another day, because the quota has refilled', () => {
		expect(spendForToday({ day: '2026-08-12', renders: 9_999 }, noon)).toEqual({
			day: '2026-08-13',
			renders: 0
		});
	});

	it('treats a missing or malformed record as zero for today', () => {
		expect(spendForToday(null, noon).renders).toBe(0);
		expect(spendForToday({ day: '2026-08-13', renders: NaN }, noon).renders).toBe(0);
		expect(spendForToday({ day: '2026-08-13', renders: -5 }, noon).renders).toBe(0);
	});

	it('names the day the way the quotas reset', () => {
		expect(utcDayKey(noon)).toBe('2026-08-13');
		// 23:59 UTC is still the same day; the boundary is midnight UTC, not local
		expect(utcDayKey(Date.UTC(2026, 7, 13, 23, 59, 59))).toBe('2026-08-13');
		expect(utcDayKey(Date.UTC(2026, 7, 14, 0, 0, 0))).toBe('2026-08-14');
	});
});

describe('decideAuthMode: the ladder, and it never goes dark', () => {
	const now = Date.UTC(2026, 7, 13, 12, 0, 0);
	const free = { PLAN: 'free' };
	const get = { method: 'GET' };
	const post = { method: 'POST' };

	it('renders while inside the allowance', () => {
		const d = decideAuthMode(get, { day: '2026-08-13', renders: 10 }, free, now);
		expect(d.mode).toBe('render');
		expect(d.remaining).toBe(2_073);
	});

	it('renders on the very last unit of the allowance', () => {
		const d = decideAuthMode(get, { day: '2026-08-13', renders: 2_082 }, free, now);
		expect(d.mode).toBe('render');
		expect(d.remaining).toBe(1);
	});

	it('degrades a read to stale exactly at the allowance, not one past it', () => {
		const d = decideAuthMode(get, { day: '2026-08-13', renders: 2_083 }, free, now);
		expect(d.mode).toBe('stale');
		expect(d.remaining).toBe(0);
	});

	it('never answers dark: a spent read is stale, never a refusal', () => {
		for (const method of ['GET', 'HEAD', 'get', 'head']) {
			expect(
				decideAuthMode({ method }, { day: '2026-08-13', renders: 99_999 }, free, now).mode
			).toBe('stale');
		}
	});

	it('refuses a WRITE by name rather than serving a stale page as if it worked', () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			const d = decideAuthMode({ method }, { day: '2026-08-13', renders: 99_999 }, free, now);
			expect(d.mode).toBe('read-only');
			// a stale GET is fine; a stale POST would look like the edit was saved
			expect(d.reason).toContain('writes resume at 00:00 UTC');
		}
	});

	it('names the numbers in the reason, so a header explains itself', () => {
		const d = decideAuthMode(get, { day: '2026-08-13', renders: 2_500 }, free, now);
		expect(d.reason).toContain('2500/2083');
	});

	it('refills after midnight UTC, from the same stale record', () => {
		const spent = { day: '2026-08-13', renders: 99_999 };
		expect(decideAuthMode(get, spent, free, now).mode).toBe('stale');
		const tomorrow = Date.UTC(2026, 7, 14, 0, 0, 1);
		expect(decideAuthMode(get, spent, free, tomorrow).mode).toBe('render');
	});

	it('always renders on paid, whatever the counter says', () => {
		const d = decideAuthMode(
			post,
			{ day: '2026-08-13', renders: 10_000_000 },
			{ PLAN: 'paid' },
			now
		);
		expect(d.mode).toBe('render');
		expect(d.remaining).toBe(Infinity);
		expect(d.reason).toContain('paid');
	});

	it('renders when the counter has never been read, rather than assuming the worst', () => {
		// null means "the object has not told us yet". Degrading on that would make the FIRST
		// authenticated request of every isolate stale, which is a worse failure than one over-spend
		expect(decideAuthMode(get, null, free, now).mode).toBe('render');
	});
});

describe('secondsUntilUtcReset', () => {
	it('counts to the next midnight UTC', () => {
		expect(secondsUntilUtcReset(Date.UTC(2026, 7, 13, 23, 59, 0))).toBe(60);
		expect(secondsUntilUtcReset(Date.UTC(2026, 7, 13, 0, 0, 0))).toBe(86_400);
	});

	it('never answers zero, because Retry-After: 0 means retry immediately', () => {
		expect(secondsUntilUtcReset(Date.UTC(2026, 7, 13, 23, 59, 59, 999))).toBeGreaterThan(0);
	});
});

describe('the Durable Object contract: one codec, two callers', () => {
	it('round-trips a spend record through headers', () => {
		const allowance = authAllowance({ PLAN: 'free' });
		const spend = { day: '2026-08-13', renders: 42 };
		const headers = new Headers(authSpendHeaders(spend, allowance));
		expect(headers.get(AUTH_SPENT_HEADER)).toBe('42');
		expect(headers.get(AUTH_ALLOWANCE_HEADER)).toBe('2083');
		expect(headers.get(AUTH_DAY_HEADER)).toBe('2026-08-13');
		expect(parseAuthSpend(headers)).toEqual(spend);
	});

	it('answers null when the object reported nothing, NOT a fresh budget', () => {
		// "did not say" and "said zero" lead to different decisions; collapsing them is how a missing
		// header reads as an unspent allowance forever
		expect(parseAuthSpend(new Headers())).toBeNull();
		expect(parseAuthSpend(new Headers({ [AUTH_DAY_HEADER]: '2026-08-13' }))).toBeNull();
		expect(parseAuthSpend(new Headers({ [AUTH_SPENT_HEADER]: '5' }))).toBeNull();
	});

	it('rejects a malformed count rather than reading it as zero', () => {
		for (const bad of ['abc', '-1', '']) {
			expect(
				parseAuthSpend(
					new Headers({ [AUTH_DAY_HEADER]: '2026-08-13', [AUTH_SPENT_HEADER]: bad })
				)
			).toBeNull();
		}
	});
});

describe('the wiring in src/site.ts', () => {
	/**
	 * SOURCE ASSERTIONS, and the same bracket `runtime/route-gate.spec.ts` uses for the same stated
	 * reason: the decision sits in the Worker's `fetch`, ahead of any binding, so there is nothing to
	 * drive it against without a real Durable Object. Driving `site.ts` directly is also blocked today
	 * -- importing it pulls `src/drupal/enable-php.ts`, which does not parse (see the report).
	 *
	 * What these pin is ORDERING and REFUSAL, which are the two things that break silently. Every
	 * assertion is whitespace-tolerant, because a source assertion in this repo already broke once on
	 * prettier changing quote style.
	 */

	it('decides authenticated-ness BEFORE the DO hop, which is the whole point', () => {
		// after the hop the DO request is already spent, so the reservation would buy nothing
		const decidedAt = siteSource.indexOf('isAuthenticatedRequest(request)');
		const hopAt = siteSource.indexOf('await stub.fetch(innerRequest)');
		expect(decidedAt).toBeGreaterThan(-1);
		expect(hopAt).toBeGreaterThan(-1);
		expect(decidedAt).toBeLessThan(hopAt);
	});

	it('reads the memoised spend before deciding, so degrading costs no DO request', () => {
		const readAt = siteSource.indexOf('await readAuthSpend(');
		const decideAt = siteSource.indexOf('decideAuthMode(request');
		expect(readAt).toBeGreaterThan(-1);
		expect(readAt).toBeLessThan(decideAt);
	});

	it('keeps a personalised request out of every shared read tier', () => {
		// edgeWanted gates both the edge cache and the KV tier, so one guard covers both reads
		expect(/edgeWanted\s*=\s*serving[\s\S]{0,120}!personalised/.test(siteSource)).toBe(true);
	});

	it('refuses to STORE a personalised page in the edge cache, structurally', () => {
		expect(siteSource).toContain("if (isAuthenticated) return 'skipped:authenticated'");
		// two independent signals: the request was authenticated, and the response is per-user
		expect(siteSource).toContain(
			"if (res.headers.has('set-cookie')) return 'skipped:set-cookie'"
		);
	});

	it('refuses to STORE a personalised page in KV too, because that key has no user in it either', () => {
		expect(/serving && personalised[\s\S]{0,200}skipped:authenticated/.test(siteSource)).toBe(
			true
		);
		expect(/serving && res\.headers\.has\('set-cookie'\)/.test(siteSource)).toBe(true);
	});

	it('never goes dark: a spent read falls through as anonymous rather than refusing', () => {
		// stale mode strips the session so the object answers the public page
		expect(siteSource).toContain("innerRequest.headers.delete('cookie')");
	});

	it('refuses a spent WRITE with a retry time rather than a blank page', () => {
		const readOnly = siteSource.slice(
			siteSource.indexOf("if (authMode === 'read-only')"),
			siteSource.indexOf('// in stale mode the request is served as ANONYMOUS')
		);
		expect(readOnly).toContain('status: 503');
		// the quotas refill at midnight UTC, so that is the only correct retry time
		expect(readOnly).toContain('secondsUntilUtcReset(t0)');
		expect(readOnly).toContain('private, no-store');
	});

	it('charges the object only for a render, never for a stale fallthrough', () => {
		const region = siteSource.slice(
			siteSource.indexOf('const innerRequest'),
			siteSource.indexOf('const doCache =')
		);
		expect(/if \(personalised\)[\s\S]{0,240}AUTH_REQUEST_HEADER/.test(region)).toBe(true);
	});

	it('marks a personalised response uncacheable by anything downstream', () => {
		expect(/if \(authenticated\)[\s\S]{0,320}private, no-store/.test(siteSource)).toBe(true);
	});

	it('reports the mode on the response, so a measurement can see which rung it took', () => {
		expect(siteSource).toContain('AUTH_MODE_HEADER');
		expect(siteSource).toContain('AUTH_REASON_HEADER');
	});
});
