/** drives one comparison arm (drupflare or the VPS) and prints what it saw; `host-verdict.ts` decides */

export interface Sample {
	ms: number;
	status: number;
	bytes: number;
	/** which tier answered, when the arm reports one; empty on the VPS, which has no tiers */
	tier: string;
	/** which object answered, from `x-cfw-replica`; the control for every lane claim */
	replica: string;
	/** the front worker's round trip from `x-worker-ms`; null on the VPS */
	workerMs: number | null;
	/** whether the edge refused the request before the worker ran; a 4xx with no `x-worker-ms` */
	edgeRefused: boolean;
	/** requests the object was already handling on arrival, from `x-cfw-gate-ahead`; null if none */
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
	/** the mean latency; a closed loop obeys X = C / mean(R), not C / p50 */
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
	// `--ceiling-path`: the arms share no no-work endpoint, and drupflare's `/robots.txt` is a deny-list 404.
	ceiling: { path: '/robots.txt', auth: false, note: "the generator's own ceiling; no work" },
	'anon-cached': { path: '/', auth: false, note: 'the dominant ordinary path' },
	'anon-miss': { path: '/?cachebust=', auth: false, note: 'the regeneration boundary' },
	'auth-front': { path: '/', auth: true, note: 'authenticated, role-shaped' },
	'auth-admin': { path: '/admin/content', auth: true, note: 'authenticated, admin-shaped' },
	// `/user/1`, not `/user`: that is a redirect, and `one()` does not follow it. Earlier `auth-account` figures measured redirects.
	'auth-account': { path: '/user/1', auth: true, note: 'authenticated, user-specific' }
};

/** extra request headers, which is how a drupflare arm names the site it is driving */
let EXTRA: Record<string, string> = {};

export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx] as number;
}

/** logs in through the arm's own headers; without them it reaches whichever site 127.0.0.1 resolves to */
export async function login(base: string, user: string, pass: string): Promise<string | null> {
	// the form must be served before a login means anything: a cold form is a 503 with no form_build_id.
	// retry the whole exchange, not the form fetch alone; one attempt is not enough.
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

/** points the generator at an arm; module state is safe only because arms run sequentially */
export function setExtraHeaders(headers: Record<string, string>): void {
	EXTRA = headers;
}

/** the address a synthetic client presents: TEST-NET-3 (RFC 5737), a documentation range */
export const clientAddress = (index: number): string => `203.0.113.${(index % 254) + 1}`;

/** whether a target is this machine; `URL.hostname` keeps the brackets on an IPv6 literal */
export function isLocalTarget(target: string): boolean {
	const host = (URL.parse(target)?.hostname ?? '').replace(/^\[|\]$/g, '');
	return (
		host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')
	);
}

/** per-client headers for a local target only; Cloudflare owns `cf-connecting-ip` and answers 403 to it */
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

/** a closed-loop run at fixed concurrency for a fixed wall-clock duration */
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

	/** one address per client on a local target, since affinity keys on it; see {@link spreadHeaders} */
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
		// over successful requests: a dead server answers instantly with status 0 and inflates the rate.
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

/** one render, with the evidence that it WAS one attached to it */
export interface RenderSample {
	/** the client-side round trip, a `Date.now()` delta spanning I/O */
	ms: number;
	/** the host's own clock: `x-worker-ms` on the edge, nginx `$request_time` on the VPS */
	serverMs: number | null;
	/** rendered HTML bytes, so a caller can refuse a ratio taken on two different pages */
	bytes: number;
	/** Drupal's `X-Drupal-Dynamic-Cache` on both arms; a cell is comparable only when both MISS */
	dynamicCache: string;
}

/** ms to produce a page, not serve a stored one; drupflare renders through `/assemble` */
export async function renderArm(
	base: string,
	kind: 'vps' | 'drupflare',
	n: number
): Promise<RenderSample[]> {
	const samples: RenderSample[] = [];
	for (let i = 0; i < n; i++) {
		if (kind === 'vps') {
			const t0 = Date.now();
			const res = await fetch(`${base}/?renderprobe=${Date.now()}-${i}`, { headers: EXTRA });
			const body = await res.arrayBuffer();
			const ms = Date.now() - t0;
			// a cell answered by any cache in front of the renderer is not a render, and reads as fast
			for (const header of ['x-fastcgi-cache', 'x-drupal-cache', 'x-drupal-dynamic-cache']) {
				const value = res.headers.get(header) ?? '';
				if (value.toUpperCase() === 'HIT') {
					throw new Error(
						`the vps render arm was answered from cache (${header}: ${value}), so ` +
							'this sample measured a lookup and not a render'
					);
				}
			}
			const vpsMs = Number(res.headers.get('x-vps-ms') ?? NaN);
			samples.push({
				ms,
				serverMs: Number.isFinite(vpsMs) ? Math.round(vpsMs * 1000) : null,
				bytes: body.byteLength,
				dynamicCache: res.headers.get('x-drupal-dynamic-cache') ?? ''
			});
			continue;
		}
		const t0 = Date.now();
		const res = await fetch(
			`${base}/assemble?path=${encodeURIComponent('/')}&bins=page,dynamic_page_cache`,
			{ headers: EXTRA }
		);
		const outcome = (await res.json()) as {
			filled?: string | null;
			bytes?: number;
			dynamicCache?: string | null;
		};
		const ms = Date.now() - t0;
		if ((outcome.filled ?? null) === null || (outcome.bytes ?? 0) === 0) {
			throw new Error(
				`the drupflare render arm rendered nothing: ${JSON.stringify(outcome).slice(0, 200)}`
			);
		}
		const workerMs = Number(res.headers.get('x-worker-ms') ?? NaN);
		samples.push({
			ms,
			serverMs: Number.isFinite(workerMs) ? workerMs : null,
			bytes: outcome.bytes ?? 0,
			dynamicCache: outcome.dynamicCache ?? ''
		});
	}
	return samples;
}

/** whether two arms rendered the same page, to a percentage tolerance; byte counts differ by query string */
export function bodiesAgree(a: number, b: number, tolerance = 0.02): boolean {
	if (a <= 0 || b <= 0) return false;
	return Math.abs(a - b) / Math.max(a, b) <= tolerance;
}

/** one authenticated session, driven sequentially and reported per request, since the entry cost is the claim */
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
		// the bump empties the page store and no alarm refills it locally, so drive `/user/login` synchronously.
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

/** the CLI, guarded so `host-verdict.ts` can import the functions above without running a benchmark */
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
		const samples = await renderArm(base, renderKind as 'vps' | 'drupflare', n);
		const cold = (samples[0] as RenderSample).ms;
		const rest = samples.slice(1);
		const warm = rest.map((s) => s.ms).sort((a, b) => a - b);
		const server = rest
			.map((s) => s.serverMs)
			.filter((v): v is number => v !== null)
			.sort((a, b) => a - b);
		console.error(
			`[${label}] render cold=${cold}ms warm n=${warm.length} ` +
				`min=${warm[0]} p50=${percentile(warm, 50)} max=${warm[warm.length - 1]} ` +
				`serverP50=${server.length === 0 ? '-' : percentile(server, 50)}ms ` +
				`bytes=${rest[0]?.bytes ?? 0} dpc=${rest[0]?.dynamicCache ?? '-'} ` +
				`all=[${warm.join(', ')}]`
		);
		console.log(
			JSON.stringify(
				{ target: base, label, kind: renderKind, cold, warm, samples: rest },
				null,
				2
			)
		);
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
			// fail loudly: the alternative is a fast-looking cell that measured the edge's refusal page.
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
