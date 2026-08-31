/**
 * What varies between two authenticated renders of the same page, and what it costs to produce.
 *
 * The anonymous census found a front page with zero dynamic bytes and a form page with one
 * dynamic value. Neither says anything about the authenticated tier, where the current user,
 * permissions, the menu active trail and a real `form_token` all live. This drives a login,
 * compiles a plan for each authenticated route with that session, and reports what the compiler
 * could and could not name.
 *
 * `uid` is echoed from the render. A census that silently rendered as uid 0 would look like a
 * result, and every early attempt at this did exactly that.
 *
 *   bunx wrangler dev -c wrangler.jsonc --port 8799 --var SITE_ID:extclock --persist-to <dir>
 *   bun scripts/measure/plan-auth-census.ts [--port=8799] [--site=extclock]
 */

const arg = (name: string, fallback: string) =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const PORT = Number(arg('port', '8799'));
const SITE = arg('site', 'extclock');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'cfw-ExtClock-8812-pass');
const BASE = `http://127.0.0.1:${PORT}`;

const ROUTES = [
	'/',
	'/user/1',
	'/admin/content',
	'/user/1/edit',
	'/admin/config/system/site-information'
];

const url = (path: string) => {
	const u = new URL(BASE + path);
	if (!u.searchParams.has('site')) u.searchParams.set('site', SITE);
	return u;
};

/** logs in through the real serve path and returns the session cookie */
async function sessionCookie(): Promise<string> {
	const form = await (await fetch(url('/serve?path=%2Fuser%2Flogin&edge=0'))).text();
	const buildId = /name="form_build_id"\s+value="(form-[A-Za-z0-9_-]{43})"/.exec(form)?.[1];
	if (!buildId) throw new Error('no form_build_id on the login page');
	const res = await fetch(url('/serve?path=%2Fuser%2Flogin&edge=0'), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			name: USER,
			pass: PASS,
			form_id: 'user_login_form',
			form_build_id: buildId,
			op: 'Log in'
		}),
		redirect: 'manual',
		signal: AbortSignal.timeout(300_000)
	});
	const set = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
	const jar = set
		.map((c) => c.split(';')[0]!)
		.filter((c) => /^S?SESS[a-f0-9]+=/.test(c))
		.join('; ');
	if (jar === '') throw new Error(`login did not set a session cookie: ${res.status}`);
	return jar;
}

/**
 * Varying regions between two renders.
 *
 * Lines occurring exactly once in each render are unambiguous match points; the aligned gaps
 * between consecutive anchors are then trimmed by common prefix and suffix so only bytes that
 * differ are counted.
 *
 * Counting whole unanchored gaps instead reported ~40 KB varying on all five routes, which is
 * what every repeated `</div>` looks like when repeated lines can never be anchors. The
 * self-diff control below is what catches that class of error.
 */
function varyingRegions(a: string, b: string): Array<{ bytes: number; text: string }> {
	const la = a.split('\n');
	const lb = b.split('\n');
	const count = (ls: string[]) => {
		const m = new Map<string, number>();
		for (const l of ls) m.set(l, (m.get(l) ?? 0) + 1);
		return m;
	};
	const ca = count(la);
	const cb = count(lb);
	const idxB = new Map<string, number>();
	lb.forEach((l, i) => {
		if (cb.get(l) === 1) idxB.set(l, i);
	});

	/** the bytes of one aligned gap that neither end explains */
	const divergence = (x: string, y: string): string => {
		const min = Math.min(x.length, y.length);
		let p = 0;
		while (p < min && x[p] === y[p]) p++;
		let q = 0;
		while (q < min - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
		return x.slice(p, x.length - q) + y.slice(p, y.length - q);
	};

	const regions: Array<{ bytes: number; text: string }> = [];
	let ia = 0;
	let ib = 0;
	let gapA: string[] = [];
	const closeGap = (upToB: number) => {
		const x = gapA.join('\n');
		const y = lb.slice(ib, upToB).join('\n');
		gapA = [];
		if (x === y) return;
		const d = divergence(x, y);
		if (d.trim() !== '') regions.push({ bytes: d.length, text: d });
	};
	while (ia < la.length) {
		const line = la[ia]!;
		const at = ca.get(line) === 1 ? idxB.get(line) : undefined;
		if (at !== undefined && at >= ib) {
			closeGap(at);
			ib = at + 1;
		} else {
			gapA.push(line);
		}
		ia++;
	}
	closeGap(lb.length);
	return regions;
}

const compile = async (path: string, cookie: string) =>
	(await (
		await fetch(
			url(
				`/plan?action=compile&path=${encodeURIComponent(path)}&cookie=${encodeURIComponent(cookie)}`
			),
			{ signal: AbortSignal.timeout(600_000) }
		)
	).json()) as Record<string, unknown>;

const render = async (path: string, cookie: string): Promise<string> =>
	(
		await fetch(
			url(
				`/plan?action=render&path=${encodeURIComponent(path)}&cookie=${encodeURIComponent(cookie)}`
			),
			{ signal: AbortSignal.timeout(600_000) }
		)
	).text();

const cookie = await sessionCookie();
const rows: Record<string, unknown>[] = [];
for (const route of ROUTES) {
	const c = await compile(route, cookie);
	const slots = (c.slots ?? {}) as Record<string, { kind: string }>;
	const sample = (c.sample ?? {}) as Record<string, string>;
	rows.push({
		route,
		uid: c.uid,
		bytes: c.bytes,
		renderMs: c.renderMs,
		ops: c.ops,
		slots: Object.entries(slots).map(([n, s]) => s.kind + ':' + (sample[n]?.length ?? 0)),
		unservable: c.unservable,
		explainsBoth: c.explainsBoth,
		generatorAgrees: c.generatorAgrees,
		// the actual varying bytes, which is what says WHICH dynamic value this is
		samples: Object.values(sample).map((v) => (v.length > 220 ? v.slice(0, 220) + '...' : v))
	});

	const ra = await render(route, cookie);
	const rb = await render(route, cookie);
	const regions = varyingRegions(ra, rb);
	rows[rows.length - 1]!.regions = {
		// a render diffed against itself has to report nothing; anything else means the
		// instrument is counting its own alignment failures
		selfControlBytes: varyingRegions(ra, ra).reduce((n, r) => n + r.bytes, 0),
		count: regions.length,
		varyingBytes: regions.reduce((n, r) => n + r.bytes, 0),
		totalBytes: ra.length,
		top: regions
			.slice()
			.sort((x, y) => y.bytes - x.bytes)
			.slice(0, 6)
			.map((r) => ({ bytes: r.bytes, text: r.text.slice(0, 180) }))
	};
}

console.log(
	JSON.stringify({ site: SITE, cookieSeen: cookie.split('=')[0], routes: rows }, null, 2)
);
