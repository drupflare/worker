/**
 * The four Open Measurements, driven against a DEPLOYED worker.
 *
 * Every arm tags its measured request with `&tag=`, which `scripts/measure/obs-cpu.ts` joins the
 * platform's own `cpuTime` back to. Wall clock is reported beside it and is legal under the narrowed
 * RULE 0 -- an HTTP round trip is a delta SPANNING I/O -- but it is never the CPU figure.
 *
 * **THE TAG REACHES ONLY THE FRONT WORKER'S INVOCATIONS.** Measured 2026-09-21: a Durable Object
 * event carries `event.request: null`, so no tag can be recovered for one by any path, and the
 * `search` auto-extraction that `obs-cpu.ts` was written against populated 5 of 500 stateless
 * events. The object's own `cpuTime` therefore has to be attributed by TIME WINDOW, which is why
 * each arm here runs as a contiguous block with nothing else driving the site.
 *
 * ## stale
 *
 * The front worker's previous-generation serve. Three things it needs and each one alone makes the
 * tier read as dead code: `PAGE_KV` bound, `PAGE_KV_ENABLED=1` or a paid plan, and the generation
 * pointer TAUGHT FORWARD before the sample -- the pointer is discovered once per `GEN_BUCKET_MS`, so
 * a request straight after a bump is answered from the memo at the old generation and answers
 * `x-cfw-edge: MISS` off an ordinary KV hit. Both tiers report `x-cfw-cache: KV`, so the arm asserts
 * on `x-cfw-edge` and `x-cfw-stale-behind` instead; reading `x-cfw-cache` alone has already misfiled
 * one deployed measurement.
 *
 * The pointer is taught with a DIFFERENT path, because an `edge=0` request to the sampled path
 * re-mirrors it into KV at the new generation and there is then nothing to fall back from.
 *
 * ## park / tax
 *
 * `park` drives an authenticated status report, which is the one page a default site renders that
 * makes an outbound HTTP call. It is repeatable only because the response is cached in
 * `key_value_expire` as `system:advisories_response`; deleting that row before each sample is what
 * turns a once-per-site event into a sample. `tax` drives the same session against pages that call
 * nothing, which is the paired arm `src/ops/park.ts` asks for: arming routes EVERY render through
 * `cfw_park_run`, so the cost is paid by 100% of renders and only two deploys differing in `PARK`
 * can price it.
 *
 * ## decay
 *
 * One object, one client, cached serves, `edge=0` so every request reaches it. Reports `x-worker-ms`
 * per bucket and `rowsToday` beside it, because a free site that exhausts its row budget goes
 * read-only and the symptom is not a quota message.
 *
 *   bun scripts/measure/open-measure.ts --arm=stale --base=https://cfw-m1.<sub>.workers.dev --n=30
 */

type Args = Record<string, string | undefined>;

const args = (): Args => {
	const out: Args = {};
	for (const raw of process.argv.slice(2)) {
		const eq = raw.indexOf('=');
		if (raw.startsWith('--') && eq > 0) out[raw.slice(2, eq)] = raw.slice(eq + 1);
		else if (raw.startsWith('--')) out[raw.slice(2)] = '1';
	}
	return out;
};

const a = args();
const BASE = (a['base'] ?? '').replace(/\/+$/, '');
const SITE = a['site'] ?? '';
const N = Number(a['n'] ?? 20);
const RUN = a['run'] ?? String(Date.now());
const ARM = a['arm'] ?? '';
const PASS = a['pass'] ?? 'cfw-Measure-2260';
const USER = a['user'] ?? 'admin';
const LABEL = a['label'] ?? ARM;

if (BASE === '') {
	console.error('--base is required');
	process.exit(2);
}

/** a local target carries site identity in `Host`; a deployed one IS the site */
const local = /^(localhost|127\.0\.0\.1|::1)$/.test(URL.parse(BASE)?.hostname ?? '');
const hostHeader: Record<string, string> = local && SITE ? { host: `${SITE}.localhost` } : {};

const url = (path: string, q: Record<string, string | number> = {}) => {
	const u = new URL(BASE + path);
	if (SITE) u.searchParams.set('site', SITE);
	for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
	return u.toString();
};

type Reply = { status: number; body: string; headers: Headers; wallMs: number };

async function hit(target: string, cookie = '', timeoutMs = 240_000): Promise<Reply> {
	const t0 = Date.now();
	try {
		const res = await fetch(target, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { ...hostHeader, ...(cookie ? { cookie } : {}) }
		});
		const body = await res.text();
		return { status: res.status, body, headers: res.headers, wallMs: Date.now() - t0 };
	} catch (e) {
		return {
			status: 0,
			body: String((e as Error).message),
			headers: new Headers(),
			wallMs: Date.now() - t0
		};
	}
}

const json = (r: Reply): Record<string, any> => {
	try {
		return JSON.parse(r.body) as Record<string, any>;
	} catch {
		return {};
	}
};

const emit = (row: Record<string, unknown>) =>
	console.log(JSON.stringify({ run: RUN, arm: LABEL, ...row }));

const sql = (q: string) => hit(url('/sql', { q }));

const stats = async (): Promise<Record<string, any>> => json(await hit(url('/serve-stats')));

/**
 * Refuses the run if anything provisioned a replica lane.
 *
 * A lane is a full database copy and the meter it spends is rows written at N+1 per change. The
 * three vars that stop one are checked at the object; this checks the OBSERVABLE, because a var that
 * did not reach the deploy looks exactly like a var that did.
 */
async function assertNoLanes(): Promise<void> {
	const s = await stats();
	const provisioned = Number(s['lanesProvisioned'] ?? s['replicaLanes'] ?? 0);
	const r = await hit(url('/serve', { path: '/' }));
	const header = r.headers.get('x-cfw-lanes');
	if (provisioned > 0 || (header !== null && Number(header) > 0)) {
		console.error(
			`REFUSING: the site reports ${provisioned} provisioned lane(s), x-cfw-lanes=${header}`
		);
		process.exit(3);
	}
	console.error(`[guard] lanes: provisioned=${provisioned} x-cfw-lanes=${header ?? 'absent'}`);
}

/**
 * A session, verified rather than assumed.
 *
 * A successful login is a 303 carrying the cookie, and `fetch` follows it by default -- the hop after
 * it answers 403, so a followed login reads as a failed one and every later request drives
 * anonymously. The verification is the second half: a wrong password answers 200 with the form and
 * `x-cfw-roles: anonymous`, which is the shape a read-only site also produces.
 */
async function signIn(): Promise<string> {
	const res = await fetch(url('/serve', { path: '/user/login' }), {
		method: 'POST',
		headers: { ...hostHeader, 'content-type': 'application/x-www-form-urlencoded' },
		body: `name=${encodeURIComponent(USER)}&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`,
		redirect: 'manual',
		signal: AbortSignal.timeout(240_000)
	});
	const line = (res.headers.getSetCookie?.() ?? []).find((c) => /^S?SESS/.test(c));
	const cookie = line ? (line.split(';')[0] ?? '') : '';
	if (cookie === '') {
		console.error(`login failed: ${res.status}, roles=${res.headers.get('x-cfw-roles')}`);
		process.exit(4);
	}
	const check = await hit(url('/serve', { path: '/user/1', edge: 0 }), cookie);
	const roles = check.headers.get('x-cfw-roles') ?? '';
	if (!roles.includes('authenticated')) {
		console.error(`the session did not authenticate: roles=${roles || 'none'}`);
		process.exit(4);
	}
	console.error(`[auth] roles=${roles}`);
	return cookie;
}

const percentile = (xs: number[], p: number): number => {
	if (xs.length === 0) return NaN;
	const s = [...xs].sort((x, y) => x - y);
	const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
	return s[i] as number;
};

const summary = (label: string, xs: number[]) =>
	console.error(
		`[${label}] n=${xs.length} p50=${percentile(xs, 50)} p90=${percentile(xs, 90)} ` +
			`min=${Math.min(...xs)} max=${Math.max(...xs)}`
	);

// #region stale: the previous-generation serve

/**
 * The sampled path is warmed into KV once, then every sample reads the previous generation.
 *
 * A STALE answer never reaches the Durable Object and is never stored by `putPage()`, so the tier
 * re-runs on every request rather than settling into the edge cache -- which is what makes a p50
 * with an n possible from one warm-up.
 */
async function staleArm(): Promise<void> {
	const path = a['path'] ?? '/';
	const teach = a['teach'] ?? '/user/login';

	// warm the sampled path into KV at the current generation
	await hit(url('/fill', { path, max: 8 }));
	const warm = await hit(url('/serve', { path }));
	console.error(
		`[stale] warm ${path}: ${warm.status} cache=${warm.headers.get('x-cfw-cache')} ` +
			`kvPut=${warm.headers.get('x-cfw-kv-put')} gen=${warm.headers.get('x-cfw-generation')}`
	);
	// a second pass, because the KV mirror is deferred and the first serve may have been a MISS
	await hit(url('/serve', { path }));
	const mirrored = await hit(url('/serve', { path, edge: 0 }));
	console.error(`[stale] mirror check kvPut=${mirrored.headers.get('x-cfw-kv-put')}`);

	const bumped = json(await hit(url('/bump', { reason: 'measure-stale' })));
	console.error(`[stale] bumped to generation ${bumped['generation']}`);

	// TEACH THE POINTER with a different path. `edge=0` skips the edge tiers, so the response comes
	// from the object carrying the new `x-cfw-generation` and the front worker writes the pointer.
	// Using the sampled path here would re-mirror it at the new generation and remove the miss the
	// tier needs.
	for (let i = 0; i < 3; i++) {
		const t = await hit(url('/serve', { path: teach, edge: 0 }));
		console.error(`[stale] teach ${teach}: gen=${t.headers.get('x-cfw-generation')}`);
		await new Promise((r) => setTimeout(r, 300));
	}

	const wall: number[] = [];
	let staleHits = 0;
	for (let i = 0; i < N; i++) {
		const tag = `stale-n${i}-${RUN}`;
		const r = await hit(url('/serve', { path, tag }));
		const edge = r.headers.get('x-cfw-edge');
		if (edge === 'STALE') {
			staleHits++;
			wall.push(Number(r.headers.get('x-worker-ms') ?? r.wallMs));
		}
		emit({
			i,
			tag,
			path,
			status: r.status,
			wallMs: r.wallMs,
			workerMs: Number(r.headers.get('x-worker-ms') ?? NaN),
			cache: r.headers.get('x-cfw-cache'),
			edge,
			behind: r.headers.get('x-cfw-stale-behind'),
			generation: r.headers.get('x-cfw-generation'),
			agedMs: r.headers.get('x-cfw-aged-ms'),
			bytes: r.body.length
		});
	}
	console.error(`[stale] ${staleHits}/${N} samples answered x-cfw-edge: STALE`);
	if (wall.length > 0) summary('stale x-worker-ms', wall);
}

/** the control: the same path rendered by the object, so the stale figure has something to beat */
async function coldArm(): Promise<void> {
	const path = a['path'] ?? '/';
	const wall: number[] = [];
	for (let i = 0; i < N; i++) {
		const tag = `cold-n${i}-${RUN}`;
		await hit(url('/bump', { reason: 'measure-cold' }));
		const r = await hit(url('/serve', { path, edge: 0, tag }));
		wall.push(Number(r.headers.get('x-worker-ms') ?? r.wallMs));
		emit({
			i,
			tag,
			path,
			status: r.status,
			wallMs: r.wallMs,
			workerMs: Number(r.headers.get('x-worker-ms') ?? NaN),
			cache: r.headers.get('x-cfw-cache'),
			serveMs: r.headers.get('x-cfw-serve-ms'),
			booted: r.headers.get('x-cfw-php-booted')
		});
	}
	summary('cold x-worker-ms', wall);
}

// #endregion

// #region park and tax

/**
 * What has to be expired before a sample, and both halves are load-bearing.
 *
 * `key_value_expire[system:advisories_response]` is Drupal's own cache of the advisories feed, so
 * without deleting it the outbound call happens once per site and there is no second sample.
 * `cfw_http_cache` is the DEFERRED transport's cache and only that arm reads it -- `ParkFetchHandler`
 * parks unconditionally and never consults it. Leaving it in place made the `PARK=0` arm answer from
 * cache, so `deferredInRender` stayed 0 and no re-drive fired: the control read as a re-drive that
 * costs nothing rather than as a re-drive that never ran.
 */
const CLEAR_BEFORE_SAMPLE = [
	"DELETE FROM key_value_expire WHERE collection='system' AND name='advisories_response'",
	'DELETE FROM cfw_http_cache',
	'DELETE FROM cfw_http_queue'
];

/**
 * One authenticated status report per sample, with the advisories response expired first.
 *
 * `parkTotals` is read either side because it is CUMULATIVE: one park sits under the 1 ms meter, so
 * the denominator has to be a difference of two reads rather than a field on the sample.
 */
async function parkArm(cookie: string): Promise<void> {
	const path = a['path'] ?? '/admin/reports/status';
	const wall: number[] = [];
	let trips = 0;
	let redrives = 0;
	for (let i = 0; i < N; i++) {
		for (const q of CLEAR_BEFORE_SAMPLE) await sql(q);
		const before = await stats();
		const tag = `park-n${i}-${RUN}`;
		const r = await hit(url('/serve', { path, edge: 0, tag }), cookie);
		const after = await stats();
		const t =
			Number(after['parkTotals']?.trips ?? 0) - Number(before['parkTotals']?.trips ?? 0);
		const runs =
			Number(after['parkTotals']?.runs ?? 0) - Number(before['parkTotals']?.runs ?? 0);
		trips += t;
		const redrive = after['lastRedrive'] ?? null;
		// `seq`, not a deep compare: every re-drive of the same path produces identical counts, so
		// equality could not tell a second occurrence from the first record still sitting there
		const redriven =
			redrive !== null &&
			Number(redrive.seq ?? 0) > Number((before['lastRedrive'] as any)?.seq ?? 0);
		if (redriven) redrives++;
		wall.push(Number(r.headers.get('x-worker-ms') ?? r.wallMs));
		emit({
			i,
			tag,
			path,
			status: r.status,
			roles: r.headers.get('x-cfw-roles'),
			wallMs: r.wallMs,
			workerMs: Number(r.headers.get('x-worker-ms') ?? NaN),
			serveMs: r.headers.get('x-cfw-serve-ms'),
			cache: r.headers.get('x-cfw-cache'),
			parkRuns: runs,
			parkTrips: t,
			parkState: after['park']?.state ?? null,
			parkArmed: after['park']?.armed ?? null,
			lastPark: after['lastPark'] ?? null,
			redriven,
			lastRedrive: redrive,
			rowsToday: after['rowsToday'] ?? null,
			bytes: r.body.length
		});
	}
	console.error(`[park] ${trips} trips and ${redrives} re-drives over ${N} renders`);
	summary('park x-worker-ms', wall);
}

/**
 * Renders that call nothing, which is what prices the wrapper rather than the yield.
 *
 * Every render is forced by expiring the object's own stored page, so each sample is a real render
 * rather than a cache read. Authenticated, because an anonymous page is answered from `cfw_page`
 * before any PHP runs.
 */
async function taxArm(cookie: string): Promise<void> {
	const paths = (a['paths'] ?? '/admin/content,/user/1,/admin/structure').split(',');
	const wall: number[] = [];
	for (let i = 0; i < N; i++) {
		const path = paths[i % paths.length] as string;
		const before = await stats();
		const tag = `tax-n${i}-${RUN}`;
		const r = await hit(url('/serve', { path, edge: 0, tag }), cookie);
		const after = await stats();
		wall.push(Number(r.headers.get('x-worker-ms') ?? r.wallMs));
		emit({
			i,
			tag,
			path,
			status: r.status,
			roles: r.headers.get('x-cfw-roles'),
			wallMs: r.wallMs,
			workerMs: Number(r.headers.get('x-worker-ms') ?? NaN),
			serveMs: r.headers.get('x-cfw-serve-ms'),
			cache: r.headers.get('x-cfw-cache'),
			parkRuns:
				Number(after['parkTotals']?.runs ?? 0) - Number(before['parkTotals']?.runs ?? 0),
			parkTrips:
				Number(after['parkTotals']?.trips ?? 0) - Number(before['parkTotals']?.trips ?? 0),
			parkState: after['park']?.state ?? null,
			rowsToday: after['rowsToday'] ?? null,
			bytes: r.body.length
		});
	}
	summary('tax x-worker-ms', wall);
}

// #endregion

// #region decay

/**
 * One object, one client, cached serves, in buckets so a step is visible where a single p50 is not.
 *
 * `edge=0` is what puts the request on the object; without it the front worker's page memo answers
 * and the reading is a property of the isolate rather than of the Durable Object.
 */
async function decayArm(): Promise<void> {
	const path = a['path'] ?? '/';
	const bucket = Number(a['bucket'] ?? 30);
	const wall: number[] = [];
	let seen = 0;
	for (let b = 0; b * bucket < N; b++) {
		const slice: number[] = [];
		for (let i = 0; i < bucket && seen < N; i++, seen++) {
			const tag = `decay-b${b}-n${i}-${RUN}`;
			const r = await hit(url('/serve', { path, edge: 0, tag }));
			const ms = Number(r.headers.get('x-worker-ms') ?? r.wallMs);
			slice.push(ms);
			wall.push(ms);
			emit({
				i: seen,
				bucket: b,
				tag,
				status: r.status,
				wallMs: r.wallMs,
				workerMs: ms,
				cache: r.headers.get('x-cfw-cache'),
				serveMs: r.headers.get('x-cfw-serve-ms'),
				booted: r.headers.get('x-cfw-php-booted'),
				colo: r.headers.get('cf-ray')?.split('-')[1] ?? null
			});
		}
		const s = await stats();
		console.error(
			`[decay] bucket ${b}: n=${slice.length} p50=${percentile(slice, 50)} ` +
				`p90=${percentile(slice, 90)} rowsToday=${s['rowsToday']} ` +
				`doToday=${s['doRequestsToday'] ?? s['requestsToday'] ?? '?'} ` +
				`recycles=${s['recycles']}`
		);
	}
	summary('decay x-worker-ms', wall);
}

// #endregion

await assertNoLanes();

if (ARM === 'stale') await staleArm();
else if (ARM === 'cold') await coldArm();
else if (ARM === 'park') await parkArm(await signIn());
else if (ARM === 'tax') await taxArm(await signIn());
else if (ARM === 'decay') await decayArm();
else {
	console.error(`unknown --arm=${ARM}; one of stale, cold, park, tax, decay`);
	process.exit(2);
}
