/**
 * The VPS comparison arm, and the generator that drives both sides of it.
 *
 * WHY THIS EXISTS. Every performance figure this project owns compares drupflare against drupflare:
 * a cached read against a render, an edge plan against an `EDGE_PLAN=0` control, a warm object
 * against a cold one. The goal it is scored against is comparative, and until this script there was
 * no comparison arm. The one number that did exist -- 3.57x warm against native PHP -- is a
 * same-machine interpreter ratio, not a host.
 *
 * WHAT IS AND IS NOT COMPARABLE HERE, because reading this wrong produces a confident wrong answer:
 *
 * - Both arms are driven over LOCALHOST, so neither carries network latency. That is a BEST CASE for
 *   the VPS, which in production sits in one region while drupflare answers from the visitor's own
 *   colo. A localhost VPS number is therefore a floor no real visitor experiences, and the network
 *   term has to be added back before an end-to-end claim is made.
 * - The generator and both targets share one machine, so the generator's own ceiling is part of every
 *   reading. `--workload=ceiling` measures it against a no-work endpoint and every other run is
 *   meaningless above that. This project has already produced three confidently wrong scaling curves
 *   from generator errors, one of them completely flat.
 * - Service time is what this measures. Absolute edge CPU still comes only from `cpuTime` on a
 *   deployed worker.
 *
 * The clock here is fine: this runs under bun, not inside a Worker, so `Date.now()` advances. The
 * rule it must not break is measuring across a synchronous `php._run()`, which happens inside the
 * object and not here.
 */

export interface Sample {
	ms: number;
	status: number;
	bytes: number;
	/** which tier answered, when the arm reports one; empty on the VPS, which has no tiers */
	tier: string;
	/**
	 * Which OBJECT answered, from `x-cfw-replica`; empty on the VPS and on an edge-cache hit.
	 *
	 * THE CONTROL FOR EVERY LANE CLAIM. A latency number from a run where one object answered
	 * everything is a single-object number however many lanes were provisioned, and that is exactly
	 * what every anonymous figure here has been. Captured so the reading can be believed rather
	 * than assumed.
	 */
	replica: string;
	/**
	 * The front worker's own round trip, from `x-worker-ms`; null on the VPS.
	 *
	 * `ms - workerMs` IS THE CLIENT'S CONTRIBUTION, and capturing it is what separates this rig from
	 * the host it is measuring. A closed loop obeys X = C / mean(R), so every millisecond the
	 * generator adds to R subtracts from measured throughput proportionally -- at any rate, not only
	 * near the generator's ceiling. Comparing against a no-work ceiling cannot see that, which is why
	 * the 1.00/2.05/3.16/5.72 curve could report a shortfall no server-side mechanism accounts for.
	 */
	workerMs: number | null;
	/**
	 * Whether the EDGE refused this request before the worker ever ran.
	 *
	 * THE WORST INSTRUMENT FAILURE AVAILABLE HERE, and it has already happened. Cloudflare answers
	 * 403 to any request carrying a client-set `cf-connecting-ip`, which this generator sent on
	 * every anonymous request. A deployed sweep then read `/`, `/x.php` and `/robots.txt` at an
	 * identical 25 ms p50 and 1,144-1,190 req/s -- three different paths agreeing to the
	 * millisecond, because every sample was the same refusal page. Nothing in the summary could
	 * say so: a 403 is an ordinary status and the cell looked fast.
	 *
	 * Recognised by the ABSENCE of `x-worker-ms` on a 4xx: the worker stamps that on every response
	 * it produces, so a refusal carrying none never reached it.
	 */
	edgeRefused: boolean;
	/**
	 * How many requests the object was already handling when this one arrived, from
	 * `x-cfw-gate-ahead`; null when the response never entered the gate.
	 *
	 * A COUNT TAKEN INSIDE THE OBJECT WITH NO CLOCK IN IT, which is the property that makes it
	 * uncontaminated by the client. If queueing is on the server this rises with the pool; if it is
	 * in the generator's event loop this stays flat while `ms` climbs.
	 */
	gateAhead: number | null;
}

/** a header that is absent or unparseable is null, never 0 -- 0 is a real reading */
function numberHeader(res: Response, name: string): number | null {
	const raw = res.headers.get(name);
	if (raw === null) return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

export interface Summary {
	workload: string;
	concurrency: number;
	n: number;
	errors: number;
	rps: number;
	p50: number;
	p95: number;
	p99: number;
	/**
	 * The MEAN, and its absence is why a shortfall went unattributed for a session.
	 *
	 * A closed loop obeys X = C / mean(R), not C / p50. Re-deriving the 1/2/4/8 sweep with the mean
	 * closes Little's Law at every point; the "gap at 4 and 8" was the substitution. p50 rose 15 ms
	 * across that sweep while the mean rose 209, so the body was flat and the tail was everything.
	 */
	mean: number;
	/** which tiers answered and how often; empty on the VPS. Discarding this hid the anon question */
	tiers: Record<string, number>;
	/** which objects answered and how often; one entry means the pool did nothing for this arm */
	replicas: Record<string, number>;
	/** mean `x-worker-ms`, or null when the arm stamps none */
	workerMs: number | null;
	/** mean client-side residue, `ms - workerMs`: what the GENERATOR contributed */
	clientMs: number | null;
	/** mean `x-cfw-gate-ahead`: queueing measured inside the object, with no clock in it */
	gateAhead: number | null;
	/** samples the edge refused before the worker ran; any is a broken run, see {@link Sample} */
	edgeRefusals: number;
	min: number;
	max: number;
	bytes: number;
}

/** the six workloads, plus the generator's own control */
export const WORKLOADS: Record<string, { path: string; auth: boolean; note: string }> = {
	// `--ceiling-path` because the two arms do not share a no-work endpoint: the VPS serves Drupal's
	// `/robots.txt` and drupflare answers it 404 through the deny list, which is not no-work and read
	// 109 req/s against the same generator's real 2,368
	ceiling: { path: '/robots.txt', auth: false, note: "the generator's own ceiling; no work" },
	'anon-cached': { path: '/', auth: false, note: 'the dominant ordinary path' },
	'anon-miss': { path: '/?cachebust=', auth: false, note: 'the regeneration boundary' },
	'auth-front': { path: '/', auth: true, note: 'authenticated, role-shaped' },
	'auth-admin': { path: '/admin/content', auth: true, note: 'authenticated, admin-shaped' },
	// `/user/1`, NOT `/user`. `/user` is a 302 to `/user/<uid>` for a signed-in visitor and `one()`
	// does not follow redirects, so this cell measured how fast each host emits a redirect -- a
	// 358-byte body on the VPS arm over 1,732 samples, which the body-size guard caught. The weight
	// on this slice is meant to buy a user-specific PAGE. Every `auth-account` figure taken before
	// 2026-09-11 is a redirect timing and is not comparable with one taken after
	'auth-account': { path: '/user/1', auth: true, note: 'authenticated, user-specific' }
};

/** extra request headers, which is how a drupflare arm names the site it is driving */
let EXTRA: Record<string, string> = {};

export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx] as number;
}

/**
 * Logs in, THROUGH THE ARM'S OWN HEADERS.
 *
 * It sent none until 2026-09-09, and that was invisible for as long as the site header was
 * decorative: with `x-cfw-site` unread, a login without it reached the same object as a login with
 * it. Once site identity became the real `Host`, this function was logging into whatever site
 * `127.0.0.1` resolves to and then measuring a different one -- which surfaced as "could not log
 * in", not as a wrong number, only because the two sites had different passwords.
 */
export async function login(base: string, user: string, pass: string): Promise<string | null> {
	// THE FORM HAS TO BE SERVED BEFORE A LOGIN MEANS ANYTHING, and this took it once. A cold
	// `/user/login` is a 503 carrying no `form_build_id`, and a busy local worker answers
	// `ECONNRESET` -- both return null here, which the caller reports as "cannot log in" and which
	// reads as a wrong password. It cost a run and then a wrong diagnosis: the second editor's
	// login failed with three replica lanes and succeeded with none, so the lanes looked
	// responsible. Isolated afterwards, a fresh account's FIRST login succeeds at three lanes and
	// at zero, both answered by `x-cfw-replica: primary`. The pool was never involved.
	// THE WHOLE EXCHANGE RETRIES, not the form fetch alone. Retrying only the GET fixed the case
	// where a cold form carried no token and left the POST one-shot -- so a login whose form arrived
	// fine and whose POST met a busy object still returned null, and the caller still reported it as
	// a wrong password. It failed that way on two consecutive runs against a SECOND editor created
	// moments earlier, which is exactly the window where one attempt is not enough.
	for (let attempt = 0; attempt < 40; attempt++) {
		const session = await loginOnce(base, user, pass);
		if (session !== null) return session;
		await fetch(`${base}/fill?path=%2Fuser%2Flogin`, { headers: EXTRA }).catch(() => {});
		await new Promise((r) => setTimeout(r, 1000));
	}
	return null;
}

/** one form-then-post exchange; null for every reason a retry could fix */
async function loginOnce(base: string, user: string, pass: string): Promise<string | null> {
	let page: Response;
	try {
		page = await fetch(`${base}/user/login`, { redirect: 'manual', headers: EXTRA });
	} catch {
		// a reset is the worker being busy, not an answer
		return null;
	}
	const html = await page.text();
	const token = /name="form_build_id" value="([^"]+)"/.exec(html)?.[1];
	if (token === undefined) return null;
	const formId = /name="form_id" value="([^"]+)"/.exec(html)?.[1] ?? 'user_login_form';
	const jar = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
	const body = new URLSearchParams({
		name: user,
		pass,
		form_build_id: token,
		form_id: formId,
		op: 'Log in'
	});
	let res: Response;
	try {
		res = await fetch(`${base}/user/login`, {
			method: 'POST',
			body,
			redirect: 'manual',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				...EXTRA,
				...(jar ? { cookie: jar } : {})
			}
		});
	} catch {
		return null;
	}
	const set = res.headers.getSetCookie?.() ?? [];
	const session = set
		.map((c) => c.split(';')[0] as string)
		.filter((c) => c.startsWith('SESS') || c.startsWith('SSESS'))
		.join('; ');
	return session === '' ? null : session;
}

/**
 * Points the generator at a different arm.
 *
 * Module state rather than a parameter, and that is safe for exactly one reason: an orchestrator
 * must drive the arms SEQUENTIALLY. Both live on this machine, so running them at once makes each
 * one the other's noise and the ratio measures the laptop's scheduler.
 */
export function setExtraHeaders(headers: Record<string, string>): void {
	EXTRA = headers;
}

/**
 * The address a synthetic client presents.
 *
 * TEST-NET-3, which RFC 5737 reserves for documentation, so nothing here can be mistaken for a real
 * client and nothing routable is implied.
 */
export const clientAddress = (index: number): string => `203.0.113.${(index % 254) + 1}`;

/**
 * Whether a target is this machine, which decides whether the spread header may be sent.
 *
 * `URL.hostname` KEEPS THE BRACKETS on an IPv6 literal, so `http://[::1]:8787` answers `[::1]` and
 * a bare `::1` comparison misses it. `host-verdict.ts` carried that comparison and imports this now.
 */
export function isLocalTarget(target: string): boolean {
	const host = (URL.parse(target)?.hostname ?? '').replace(/^\[|\]$/g, '');
	return (
		host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')
	);
}

/**
 * The per-client headers, which are NOT the same on a local target and a deployed one.
 *
 * `cf-connecting-ip` is what `affinityKey()` spreads anonymous traffic by, and miniflare accepts
 * whatever a client sends -- so locally it is the only way a single-address generator reaches more
 * than one lane, and `anon-cached` is 82% of the traffic weight. Cloudflare owns that header on a
 * real deployment and answers **403 at the edge** to any request that presents one, before the
 * worker runs. Sending it to both kinds of target measured a refusal page and called it a host.
 *
 * Nothing replaces it remotely: Cloudflare sets the header to the true client address, so a
 * single-source benchmark reaches one lane whatever it does. That is a property of the routing and
 * of the rig, not something a header can paper over.
 */
export function spreadHeaders(base: string, index: number): Record<string, string> {
	return isLocalTarget(base) ? { 'cf-connecting-ip': clientAddress(index) } : {};
}

export async function one(
	url: string,
	cookie: string | null,
	extra: Record<string, string> = {}
): Promise<Sample> {
	const t0 = Date.now();
	try {
		const res = await fetch(url, {
			redirect: 'manual',
			headers: { ...EXTRA, ...extra, ...(cookie ? { cookie } : {}) }
		});
		const buf = await res.arrayBuffer();
		const cache = res.headers.get('x-cfw-cache') ?? '';
		const plan = res.headers.get('x-cfw-plan') ?? '';
		const workerMs = numberHeader(res, 'x-worker-ms');
		return {
			ms: Date.now() - t0,
			status: res.status,
			bytes: buf.byteLength,
			tier: cache === 'PLAN' && plan !== '' ? `PLAN:${plan}` : cache,
			replica: res.headers.get('x-cfw-replica') ?? '',
			workerMs,
			// a 4xx with no `x-worker-ms` never reached the worker; see `edgeRefused`
			edgeRefused: res.status >= 400 && res.status < 500 && workerMs === null,
			gateAhead: numberHeader(res, 'x-cfw-gate-ahead')
		};
	} catch {
		return {
			ms: Date.now() - t0,
			status: 0,
			bytes: 0,
			tier: '',
			replica: '',
			workerMs: null,
			edgeRefused: false,
			gateAhead: null
		};
	}
}

/**
 * A CLOSED-LOOP run at fixed concurrency for a fixed wall-clock duration.
 *
 * Fixed DURATION rather than a fixed request count, because a fixed count gives every arm a different
 * amount of time and a slow arm then reports a rate computed over a longer window. Each virtual
 * client loops until the deadline, which is what keeps offered load proportional to the arm's own
 * speed rather than to the generator's patience.
 */
export async function run(
	base: string,
	workload: string,
	concurrency: number,
	seconds: number,
	cookie: string | null
): Promise<Summary> {
	const spec = WORKLOADS[workload];
	if (!spec) throw new Error(`unknown workload ${workload}`);
	const deadline = Date.now() + seconds * 1000;
	const samples: Sample[] = [];
	let counter = 0;

	/**
	 * ONE ADDRESS PER CLIENT ON A LOCAL TARGET, and none on a deployed one; see {@link spreadHeaders}.
	 *
	 * `affinityKey()` spreads an anonymous request by `cf-connecting-ip` and falls back to the path
	 * only when there is none. This generator sent no address at all until 2026-09-10, so every
	 * anonymous request in every run collapsed onto ONE affinity key and therefore one lane -- and
	 * `anon-cached` is 82% of the traffic weight and the slice that decides the verdict.
	 *
	 * Sent to both arms of a LOCAL run so the two remain identical in what they transmit; nginx and
	 * php-fpm have no use for it, and it cannot reach the edge cache key, which `cacheKey()` builds
	 * from explicit parts and no headers.
	 */
	const client = async (index: number): Promise<void> => {
		const extra = spreadHeaders(base, index);
		while (Date.now() < deadline) {
			// a unique query per request on the miss arm, so nothing upstream can answer it twice
			const url = spec.path.endsWith('=')
				? `${base}${spec.path}${++counter}-${concurrency}`
				: `${base}${spec.path}`;
			samples.push(await one(url, spec.auth ? cookie : null, extra));
		}
	};

	const started = Date.now();
	await Promise.all(Array.from({ length: concurrency }, (_, i) => client(i)));
	const elapsed = (Date.now() - started) / 1000;

	const ok = samples.filter((s) => s.status >= 200 && s.status < 400);
	const times = ok.map((s) => s.ms).sort((a, b) => a - b);
	return {
		workload,
		concurrency,
		n: samples.length,
		errors: samples.length - ok.length,
		// OVER SUCCESSFUL REQUESTS, and it used to be over every attempt. A dead server answers
		// instantly with status 0, so `samples.length / elapsed` read 45,279 req/s on an arm whose
		// worker had crashed -- a confident wrong number, and the one a reader would quote. Identical
		// on any cell with no errors, which is every cell that means anything
		rps: ok.length / elapsed,
		p50: percentile(times, 50),
		p95: percentile(times, 95),
		p99: percentile(times, 99),
		min: times[0] ?? 0,
		max: times[times.length - 1] ?? 0,
		mean: times.length === 0 ? 0 : times.reduce((n, t) => n + t, 0) / times.length,
		tiers: ok.reduce<Record<string, number>>((acc, s) => {
			if (s.tier !== '') acc[s.tier] = (acc[s.tier] ?? 0) + 1;
			return acc;
		}, {}),
		replicas: ok.reduce<Record<string, number>>((acc, s) => {
			if (s.replica !== '') acc[s.replica] = (acc[s.replica] ?? 0) + 1;
			return acc;
		}, {}),
		workerMs: meanOf(ok.map((s) => s.workerMs)),
		clientMs: meanOf(ok.map((s) => (s.workerMs === null ? null : s.ms - s.workerMs))),
		gateAhead: meanOf(ok.map((s) => s.gateAhead)),
		// over EVERY sample, not the successful ones: a refusal is a 403 and never counts as ok
		edgeRefusals: samples.filter((s) => s.edgeRefused).length,
		bytes: ok.length === 0 ? 0 : Math.round(ok.reduce((n, s) => n + s.bytes, 0) / ok.length)
	};
}

/** the mean of the readings that exist, or null when none does; 0 would read as a measurement */
function meanOf(values: readonly (number | null)[]): number | null {
	const present = values.filter((v): v is number => v !== null);
	if (present.length === 0) return null;
	return present.reduce((n, v) => n + v, 0) / present.length;
}

/**
 * How long each arm takes to PRODUCE a page, rather than to serve a stored one.
 *
 * The two arms reach it differently, because each does what it does in production. The VPS renders
 * on the request, so a unique query string is a render. drupflare refuses to render on the request
 * for an anonymous path it has never seen -- it answers 503 and queues -- so its render is driven:
 * bump the generation to invalidate the stored page, enqueue the path, then time the drain.
 *
 * BOTH TIMES SPAN I/O, which is the `Date.now()` shape RULE 0 permits. Neither is taken across a
 * synchronous `php._run()`; the drupflare figure brackets an HTTP call to the object from outside it.
 *
 * WHICH BINS ARE WARM. Neither arm empties Drupal's own `render` or `dynamic_page_cache`, so both
 * measure a re-render with Drupal's internal caches warm. That is the workload a content change
 * produces and it is NOT the 2,127 ms "both bins emptied" figure in the report, which is a colder
 * thing measured on the edge. Do not subtract one from the other.
 */
export async function renderArm(
	base: string,
	kind: 'vps' | 'drupflare',
	n: number
): Promise<number[]> {
	const times: number[] = [];
	for (let i = 0; i < n; i++) {
		if (kind === 'vps') {
			const t0 = Date.now();
			const res = await fetch(`${base}/?renderprobe=${Date.now()}-${i}`, { headers: EXTRA });
			await res.arrayBuffer();
			times.push(Date.now() - t0);
			continue;
		}
		await fetch(`${base}/bump?reason=renderprobe`, { headers: EXTRA });
		await fetch(`${base}/fill?path=${encodeURIComponent('/')}`, { headers: EXTRA });
		const t0 = Date.now();
		const res = await fetch(`${base}/fill`, { headers: EXTRA });
		await res.arrayBuffer();
		times.push(Date.now() - t0);
	}
	return times;
}

/**
 * One authenticated session, driven sequentially, reported per request rather than as a percentile.
 *
 * THE CLOSED-LOOP ARM CANNOT ANSWER THIS QUESTION. A p50 over a ten-second window is taken after the
 * session has already converged, so it neither shows the entry cost nor proves that convergence
 * happened -- and a mean over the same window hides which requests were which. The claim being tested
 * is that a normal session reaches an edge artifact and stays there, and that is a CURVE.
 *
 * The generation is bumped first on the drupflare arm, because the isolate outlives a run: a shared
 * plan compiled by an earlier session of the same role set would answer request 1 and the entry cost
 * this exists to measure would never appear. The VPS arm has nothing to bump and nothing to clear;
 * its opcache stays warm, which is its best case and is left that way on purpose.
 */
export async function sessionArm(
	base: string,
	kind: 'vps' | 'drupflare',
	path: string,
	n: number,
	user: string,
	pass: string
): Promise<Sample[]> {
	if (kind === 'drupflare') {
		await fetch(`${base}/bump?reason=sessionprobe`, { headers: EXTRA });
		// the bump empties the page store, and a local rig fires no alarm to refill it, so
		// `/user/login` answers 503 `warming` and the login below cannot read a form build id.
		// Driven synchronously here for the same reason `bench-site.ts` drives it
		for (const warm of ['/user/login', path]) {
			await fetch(`${base}/fill?path=${encodeURIComponent(warm)}`, { headers: EXTRA });
		}
	}
	const session = await login(base, user, pass);
	if (session === null) throw new Error(`could not log in to ${base} as ${user}`);
	const out: Sample[] = [];
	for (let i = 0; i < n; i++) out.push(await one(`${base}${path}`, session));
	return out;
}

/**
 * The CLI, guarded so the module can be IMPORTED.
 *
 * `host-verdict.ts` drives both arms through the functions above, and at module scope this block
 * would run a benchmark as a side effect of the import.
 */
if (import.meta.main) {
	function arg(name: string, fallback: string): string {
		const hit = process.argv.find((a: string) => a.startsWith(`--${name}=`));
		return hit ? (hit.split('=').slice(1).join('=') as string) : fallback;
	}

	const base = arg('target', 'http://127.0.0.1:8099').replace(/\/$/, '');
	const label = arg('label', base);
	const site = arg('site', '');
	// `Host` rather than `x-cfw-site`: nothing under `src/` ever read that header, so it selected
	// no site at all. Site identity is the hostname
	if (site !== '') EXTRA = { host: `${site}.localhost` };
	const seconds = Number(arg('seconds', '10'));
	const warmupSeconds = Number(arg('warmup', '3'));
	const levels = arg('concurrency', '1,2,4,8,16,32')
		.split(',')
		.map((n) => Number(n.trim()))
		.filter((n) => Number.isFinite(n) && n >= 1);
	const wanted = arg('workload', 'ceiling,anon-cached,anon-miss').split(',');
	const ceilingPath = arg('ceiling-path', '');
	if (ceilingPath !== '') WORKLOADS.ceiling!.path = ceilingPath;
	const user = arg('user', 'admin');
	const pass = arg('pass', '');

	let cookie: string | null = null;
	if (wanted.some((w) => WORKLOADS[w]?.auth)) {
		if (pass === '') {
			console.error('an authenticated workload needs --pass=<admin password>');
			process.exit(2);
		}
		cookie = await login(base, user, pass);
		if (cookie === null) {
			console.error(`could not log in to ${base} as ${user}; is the password right?`);
			process.exit(2);
		}
		console.error(`[vps-compare] authenticated as ${user}`);
	}

	const sessionKind = arg('session', '');
	if (sessionKind !== '') {
		if (sessionKind !== 'vps' && sessionKind !== 'drupflare') {
			console.error('--session must be vps or drupflare');
			process.exit(2);
		}
		if (pass === '') {
			console.error('--session needs --pass=<admin password>');
			process.exit(2);
		}
		const n = Number(arg('n', '10'));
		const path = arg('path', '/');
		const samples = await sessionArm(
			base,
			sessionKind as 'vps' | 'drupflare',
			path,
			n,
			user,
			pass
		);
		const ms = samples.map((s) => s.ms);
		const total = ms.reduce((a, b) => a + b, 0);
		const tail = ms.slice(1).sort((a, b) => a - b);
		console.error(
			`[${label}] session ${path} n=${n} first=${ms[0]}ms ` +
				`rest p50=${percentile(tail, 50)}ms mean=${(total / n).toFixed(1)}ms ` +
				`curve=[${ms.join(', ')}]`
		);
		for (const [i, s] of samples.entries()) {
			console.error(
				`  #${String(i + 1).padStart(2)} ${String(s.ms).padStart(5)}ms ${s.tier}`
			);
		}
		console.log(
			JSON.stringify(
				{ target: base, label, kind: sessionKind, path, n, meanMs: total / n, samples },
				null,
				2
			)
		);
		process.exit(0);
	}

	const renderKind = arg('render', '');
	if (renderKind !== '') {
		if (renderKind !== 'vps' && renderKind !== 'drupflare') {
			console.error('--render must be vps or drupflare');
			process.exit(2);
		}
		const n = Number(arg('n', '9'));
		// the first sample on either arm is a cold interpreter or a cold opcache and is reported
		// separately rather than folded into a median, the way every other cold reading here is
		const times = await renderArm(base, renderKind as 'vps' | 'drupflare', n);
		const cold = times[0] as number;
		const warm = times.slice(1).sort((a, b) => a - b);
		console.error(
			`[${label}] render cold=${cold}ms warm n=${warm.length} ` +
				`min=${warm[0]} p50=${percentile(warm, 50)} max=${warm[warm.length - 1]} ` +
				`all=[${warm.join(', ')}]`
		);
		console.log(JSON.stringify({ target: base, label, kind: renderKind, cold, warm }, null, 2));
		process.exit(0);
	}

	const rows: Summary[] = [];
	for (const workload of wanted) {
		if (!WORKLOADS[workload]) {
			console.error(
				`unknown workload ${workload}; known: ${Object.keys(WORKLOADS).join(', ')}`
			);
			process.exit(2);
		}
		// warm the arm before the first level, so opcache, the container and any lazy mount are paid for
		// outside the readings rather than folded into the first one
		if (warmupSeconds > 0) await run(base, workload, 2, warmupSeconds, cookie);
		for (const concurrency of levels) {
			const summary = await run(base, workload, concurrency, seconds, cookie);
			rows.push(summary);
			console.error(
				`[${label}] ${workload.padEnd(12)} c=${String(concurrency).padStart(3)} ` +
					`rps=${summary.rps.toFixed(1).padStart(7)} p50=${String(summary.p50).padStart(5)}ms ` +
					`p95=${String(summary.p95).padStart(5)}ms p99=${String(summary.p99).padStart(5)}ms ` +
					`err=${summary.errors} bytes=${summary.bytes}`
			);
			// LOUD, because the alternative is a fast-looking cell. A run that measured the edge's
			// refusal page reported three different paths at the same 25 ms and 1,150 req/s
			if (summary.edgeRefusals > 0) {
				console.error(
					`[${label}] ${summary.edgeRefusals} of ${summary.n} samples were refused AT THE ` +
						'EDGE (a 4xx carrying no x-worker-ms), so this cell measured Cloudflare and ' +
						'not the host'
				);
				process.exit(3);
			}
		}
	}

	console.log(JSON.stringify({ target: base, label, seconds, rows }, null, 2));
}
