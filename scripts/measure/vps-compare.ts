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
	/** mean `x-worker-ms`, or null when the arm stamps none */
	workerMs: number | null;
	/** mean client-side residue, `ms - workerMs`: what the GENERATOR contributed */
	clientMs: number | null;
	/** mean `x-cfw-gate-ahead`: queueing measured inside the object, with no clock in it */
	gateAhead: number | null;
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
	'auth-account': { path: '/user', auth: true, note: 'authenticated, user-specific' }
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
	const page = await fetch(`${base}/user/login`, { redirect: 'manual', headers: EXTRA });
	const html = await page.text();
	const token = /name="form_build_id" value="([^"]+)"/.exec(html)?.[1];
	const formId = /name="form_id" value="([^"]+)"/.exec(html)?.[1] ?? 'user_login_form';
	if (!token) return null;
	const jar = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
	const body = new URLSearchParams({
		name: user,
		pass,
		form_build_id: token,
		form_id: formId,
		op: 'Log in'
	});
	const res = await fetch(`${base}/user/login`, {
		method: 'POST',
		body,
		redirect: 'manual',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			...EXTRA,
			...(jar ? { cookie: jar } : {})
		}
	});
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

export async function one(url: string, cookie: string | null): Promise<Sample> {
	const t0 = Date.now();
	try {
		const res = await fetch(url, {
			redirect: 'manual',
			headers: { ...EXTRA, ...(cookie ? { cookie } : {}) }
		});
		const buf = await res.arrayBuffer();
		const cache = res.headers.get('x-cfw-cache') ?? '';
		const plan = res.headers.get('x-cfw-plan') ?? '';
		return {
			ms: Date.now() - t0,
			status: res.status,
			bytes: buf.byteLength,
			tier: cache === 'PLAN' && plan !== '' ? `PLAN:${plan}` : cache,
			workerMs: numberHeader(res, 'x-worker-ms'),
			gateAhead: numberHeader(res, 'x-cfw-gate-ahead')
		};
	} catch {
		return {
			ms: Date.now() - t0,
			status: 0,
			bytes: 0,
			tier: '',
			workerMs: null,
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

	const client = async (): Promise<void> => {
		while (Date.now() < deadline) {
			// a unique query per request on the miss arm, so nothing upstream can answer it twice
			const url = spec.path.endsWith('=')
				? `${base}${spec.path}${++counter}-${concurrency}`
				: `${base}${spec.path}`;
			samples.push(await one(url, spec.auth ? cookie : null));
		}
	};

	const started = Date.now();
	await Promise.all(Array.from({ length: concurrency }, () => client()));
	const elapsed = (Date.now() - started) / 1000;

	const ok = samples.filter((s) => s.status >= 200 && s.status < 400);
	const times = ok.map((s) => s.ms).sort((a, b) => a - b);
	return {
		workload,
		concurrency,
		n: samples.length,
		errors: samples.length - ok.length,
		rps: samples.length / elapsed,
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
		workerMs: meanOf(ok.map((s) => s.workerMs)),
		clientMs: meanOf(ok.map((s) => (s.workerMs === null ? null : s.ms - s.workerMs))),
		gateAhead: meanOf(ok.map((s) => s.gateAhead)),
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
		}
	}

	console.log(JSON.stringify({ target: base, label, seconds, rows }, null, 2));
}
