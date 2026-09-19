/**
 * The three v1.0.1 readings, driven against a DEPLOYED worker in one run.
 *
 * Each arm had a reason it had never been read, and two of them were properties of the instrument
 * rather than of the work:
 *
 * - **Boot amortisation** needs a batch inside ONE invocation, because `cpuTime` meters an
 *   invocation. `/fill` was `fillOne()` and took no `max`, so k separate requests were k invocations
 *   and there was no batch to price. The route drains a batch now.
 * - **The stale-generation serve** needs `PAGE_KV`. `readStalePage()` returns null at its first line
 *   without it and the shipping config bound none, so the tier could not fire at all: a bump then a
 *   re-serve answered `x-cfw-cache: HIT`, never `STALE`.
 * - **The replica curve above 4 lanes** needs lanes that traffic actually reaches, which is
 *   `lanes_provisioned` rather than `REPLICA_COUNT`, and readmission so a withdrawn lane can come
 *   back.
 *
 * Wall clock is the figure for the stale and replica arms and that is legal: the narrowed RULE 0
 * permits a `Date.now()` delta SPANNING I/O, which is what an HTTP round trip is. It is NOT legal
 * for the amortisation arm, where the whole quantity is synchronous PHP, so that arm emits `&tag=`
 * per request and `scripts/measure/obs-cpu.ts` joins the platform's own `cpuTime` back to it.
 *
 * **INTERLEAVED, NEVER BLOCKED BY ARM.** This project has twice published a number that was an
 * artifact of a fixed order. Every k is sampled once per round.
 *
 *   bun scripts/measure/v101-arms.ts --base=https://<worker>.workers.dev --site=m1 --n=5
 */

type Args = Record<string, string | undefined>;

const args = (): Args => {
	const out: Args = {};
	for (const raw of process.argv.slice(2)) {
		const eq = raw.indexOf('=');
		if (raw.startsWith('--') && eq > 0) out[raw.slice(2, eq)] = raw.slice(eq + 1);
	}
	return out;
};

const a = args();
const BASE = (a['base'] ?? '').replace(/\/+$/, '');
const SITE = a['site'] ?? 'm1';
const N = Number(a['n'] ?? 5);
const KS = (a['ks'] ?? '1,5,10,20').split(',').map((s) => Number(s.trim()));
const LANES = Number(a['lanes'] ?? 7);
const RUN = a['run'] ?? String(Date.now());
const ONLY = a['only'] ?? '';
const ADMIN_PASS = a['pass'] ?? 'cfw-Measure-2260';
/**
 * Offered load PER REPLICA, so the pool's own load stays constant as it grows.
 *
 * A fixed total concurrency is the error `load-generator-discipline` already records: it gives every
 * arm a different per-replica load, so a pool that scales perfectly still reads flat because the
 * generator, not the pool, is the bottleneck. Total concurrency is this times (lanes + 1).
 */
const PER_LANE = Number(a['perLane'] ?? 6);
/**
 * The router's own FNV-1a, copied so the spread is computed against the real function.
 *
 * `src/ops/replica-routing.ts` cannot be imported here: it pulls the worker's module graph.
 * `tests/node/spread-coverage.spec.ts` asserts the two agree, which is what makes a copy safe.
 */
function laneHash(value: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/**
 * One path per lane, chosen so every lane in the pool receives offered load.
 *
 * **A FIXED PATH LIST SILENTLY UNDER-COVERS A POOL, AND THE OLD EIGHT DID.** `affinityKey()` keys a
 * session-carrying request on the path and the router takes `hash(key) % (lanes + 1)`, so the list
 * has to cover every bucket or the idle lanes read as a pool that will not scale. Computed against
 * the hash above, the previous eight paths covered 6 of 9 buckets at 8 lanes, **7 of 17 at 16** and
 * 8 of 33 at 32 -- so any curve this rig produced above 4 lanes was measuring a fraction of the pool
 * it named.
 *
 * Coverage is chosen rather than hoped for: walk a candidate pool, keep the first path that lands in
 * each bucket, and refuse the run if any bucket is still empty. A refusal here is cheaper than a
 * published curve that under-measured.
 *
 * It does NOT spread the anonymous arm, which keys on the client address; `--clients=N` is that one.
 */
export function coveringSpread(
	lanes: number,
	candidates: readonly string[]
): { paths: string[]; covered: number; buckets: number; missing: number[] } {
	const buckets = lanes + 1;
	const byBucket = new Map<number, string>();
	for (const path of candidates) {
		const bucket = laneHash(`p:${path}`) % buckets;
		if (!byBucket.has(bucket)) byBucket.set(bucket, path);
	}
	const missing: number[] = [];
	for (let i = 0; i < buckets; i++) if (!byBucket.has(i)) missing.push(i);
	return {
		paths: [...byBucket.values()],
		covered: byBucket.size,
		buckets,
		missing
	};
}

/**
 * Every candidate path that hashes to ONE lane bucket.
 *
 * Driving a single bucket isolates one object, which is the only way to read per-object throughput
 * without a route that pins a lane -- `?site=<site>#r<n>` is not honoured, so the topology ceiling
 * cannot be addressed directly. `solo x (lanes + 1)` is then the ceiling a pool would reach if
 * distribution were perfect, and the routed measurement divided by it is what distribution actually
 * costs. Reporting only the routed number and comparing it against a directly-addressed one from
 * another run is how two different questions get one answer.
 */
export function pathsForBucket(
	lanes: number,
	bucket: number,
	candidates: readonly string[],
	want: number
): string[] {
	const buckets = lanes + 1;
	const out: string[] = [];
	for (const path of candidates) {
		if (out.length >= want) break;
		if (laneHash(`p:${path}`) % buckets === bucket) out.push(path);
	}
	return out;
}

/**
 * Where the candidate paths come from.
 *
 * `/node/N` is the only family that scales to an arbitrary pool AND does comparable work per
 * request, which a mixed list of `/`, `/rss.xml` and `/user/login` does not. The pool is widened
 * until every bucket is filled; `--nodes` says how many nodes the site actually has, because a path
 * with no node renders a 404 and a 404 is not the workload.
 */
const NODES = Number(a['nodes'] ?? 200);

function candidatePaths(): string[] {
	const out = ['/', '/node'];
	for (let i = 1; i <= NODES; i++) out.push(`/node/${i}`);
	return out;
}

const COVER = coveringSpread(LANES, candidatePaths());
const SPREAD = COVER.paths;

// guarded so `coveringSpread` can be imported by its spec without the rig running
if (import.meta.main) {
	if (!BASE) {
		console.error('--base is required');
		process.exit(1);
	}

	// a pool with idle lanes reads as a pool that will not scale, so this refuses rather than reports
	if (COVER.missing.length > 0) {
		console.error(
			`spread covers ${COVER.covered} of ${COVER.buckets} lane buckets; ` +
				`${COVER.missing.length} would receive no load (${COVER.missing.slice(0, 12).join(', ')}` +
				`${COVER.missing.length > 12 ? ', ...' : ''}). Raise --nodes above ${NODES}.`
		);
		process.exit(1);
	}
	console.log(
		`[spread] ${COVER.paths.length} paths cover ${COVER.covered}/${COVER.buckets} buckets at ${LANES} lanes`
	);
}

const url = (path: string, q: Record<string, string | number> = {}) => {
	const u = new URL(BASE + path);
	u.searchParams.set('site', SITE);
	for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
	return u.toString();
};

type Reply = { status: number; body: string; headers: Headers; wallMs: number };

/**
 * ONE ANONYMOUS CLIENT IS ONE LANE.
 *
 * `affinityKey()` keys a request on its session, then on `cf-connecting-ip`, then on the path. A
 * generator running from one machine presents one address, so an ANONYMOUS drive lands entirely on
 * whichever lane that address hashes to -- measured on a local rig, `x-cfw-replica` came back
 * `{r3: 662}`, one object for every sample.
 *
 * `--clients=N` presents N synthetic addresses, honoured by a local `wrangler dev` only.
 *
 * **It does not explain the low replica reading, and this comment first said it did.** The replica
 * arm below drives AUTHENTICATED requests, which key on the PATH, and `SPREAD`'s eight paths cover
 * 4 of 4 buckets at 3 lanes -- computed offline against the router's own FNV-1a. What was actually
 * wrong is that no lane had been admitted: a lane refuses until something mints
 * `state:system.private_key`, which a migrated site with `/firstrun` run does not yet have. Render
 * one page carrying a form before provisioning lanes.
 */
const SYNTHETIC_CLIENTS = Number(
	process.argv.find((arg: string) => arg.startsWith('--clients='))?.split('=')[1] ?? '1'
);

let clientSeq = 0;

/** a stable spread of addresses in TEST-NET-3, which is reserved for exactly this */
function syntheticAddress(): string | null {
	if (!Number.isFinite(SYNTHETIC_CLIENTS) || SYNTHETIC_CLIENTS <= 1) return null;
	const n = clientSeq++ % Math.floor(SYNTHETIC_CLIENTS);
	return `203.0.113.${(n % 254) + 1}`;
}

async function hit(target: string, timeoutMs = 240_000, cookie = ''): Promise<Reply> {
	const t0 = Date.now();
	const address = syntheticAddress();
	const headers: Record<string, string> = {
		...(cookie ? { cookie } : {}),
		// only honoured by a local `wrangler dev`; a deployed worker gets the real one from the
		// edge and this header is ignored, which is why the flag defaults off
		...(address ? { 'cf-connecting-ip': address } : {})
	};
	try {
		const res = await fetch(target, {
			signal: AbortSignal.timeout(timeoutMs),
			...(Object.keys(headers).length > 0 ? { headers } : {})
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

const json = (r: Reply): Record<string, unknown> => {
	try {
		return JSON.parse(r.body) as Record<string, unknown>;
	} catch {
		return {};
	}
};

const emit = (row: Record<string, unknown>) => console.log(JSON.stringify({ run: RUN, ...row }));

const median = (xs: number[]): number => {
	if (xs.length === 0) return NaN;
	const s = [...xs].sort((x, y) => x - y);
	const mid = s.length >> 1;
	return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

/** enough addressable URLs that the sweep can queue the largest k */
async function seed(want: number): Promise<void> {
	for (let i = 0; i < want; i++) {
		await hit(url('/savenode', { title: `v101-${RUN}-${i}` }), 240_000);
	}
}

// #region arm 1: boot amortisation

/**
 * One independent sample: retire everything, queue EXACTLY k paths, then measure one batched drain.
 *
 * Enqueued by name rather than swept. The sweep refuses while anything is pending -- `boundBy:
 * backlog`, "the sweep yields to the fill batch" -- so a swept queue was 5 deep whatever k asked
 * for, and k=10 and k=20 would have drained 5 and read as a plateau that is an artifact of the
 * queueing, not of the batch. `/fill?path=` enqueues without draining, which is what makes the
 * depth exact.
 */
async function amortSample(k: number, i: number): Promise<void> {
	const tag = `amort-k${k}-n${i}-${RUN}`;
	await hit(url('/bump'));
	// drain whatever the bump requeued, so the batch below is k and not k plus the leftovers
	await hit(url('/fill', { max: 64 }));
	// ONE REQUEST SEATS THE BATCH AND DRAINS IT. Enqueuing in a separate request arms the fill
	// alarm, which fires before the caller's next round trip arrives, so the batch is drained by the
	// alarm and the measured invocation finds an empty queue. Measured: `?path=` answered `depth: 1`
	// and the next request answered `depth: 0`.
	const paths = Array.from({ length: k }, (_, n) => `/node/${n + 1}`).join(',');
	const filled = await hit(url('/fill', { max: k, path: paths, tag }));
	const body = json(filled);
	emit({
		arm: 'amortisation',
		k,
		i,
		tag,
		status: filled.status,
		wallMs: filled.wallMs,
		queued: k,
		asked: body['asked'] ?? null,
		fills: body['fills'] ?? null,
		drained: body['drained'] ?? null,
		remaining: body['remaining'] ?? null,
		oversized: body['oversized'] ?? null
	});
}

// #endregion

// #region arm 2: the stale-generation serve

/**
 * The tier is read on EVERY sample rather than only where it is expected.
 *
 * A run that fell through to RENDER would otherwise be reported as a very slow stale serve, which is
 * the `anon-cached` misattribution in miniature.
 */
async function staleSample(path: string, i: number): Promise<void> {
	// warm it into the page store, and into KV, so there is a previous generation to read
	await hit(url('/serve', { path }));
	await hit(url('/fill', { max: 5 }));
	await hit(url('/bump'));
	const served = await hit(url('/serve', { path, tag: `stale-n${i}-${RUN}` }));
	emit({
		arm: 'stale',
		i,
		path,
		status: served.status,
		wallMs: served.wallMs,
		tier: served.headers.get('x-cfw-cache'),
		booted: served.headers.get('x-cfw-php-booted'),
		workerMs: served.headers.get('x-worker-ms'),
		lanes: served.headers.get('x-cfw-lanes')
	});
}

// #endregion

// #region arm 3: the replica curve

/** the session the load is driven under; without one every request stops at the front worker */
async function signIn(): Promise<string> {
	// MANUAL, because a successful login is a 303 and fetch follows it by default -- the redirect
	// carries the Set-Cookie and the hop after it answers 403, so a followed login reads as a failed
	// one and every later request drives ANONYMOUSLY, which keys on the address and never spreads
	const res = await fetch(url('/serve', { path: '/user/login' }), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: `name=admin&pass=${encodeURIComponent(ADMIN_PASS)}&form_id=user_login_form&op=Log+in`,
		redirect: 'manual',
		signal: AbortSignal.timeout(240_000)
	});
	const set = res.headers.getSetCookie?.() ?? [];
	const session = set.find((line) => /^S?SESS/.test(line));
	return session ? (session.split(';')[0] ?? '') : '';
}

/** a lane is copied one bounded step per call, so it has to be driven to completion */
async function provisionLane(lane: number): Promise<Record<string, unknown>> {
	let last: Record<string, unknown> = {};
	for (let step = 0; step < 60; step++) {
		last = json(await hit(url('/replica', { action: 'provision', lane })));
		const stage = String(last['stage'] ?? last['state'] ?? '');
		if (last['done'] === true || stage === 'SERVING' || stage === 'VERIFIED') break;
		if (last['ok'] === false) break;
	}
	return last;
}

/**
 * Offered load held constant per lane, so the curve is scaling and not just more traffic.
 *
 * **AUTHENTICATED, because an anonymous read never reaches a lane.** Driven anonymously first and
 * the curve was flat at 111-116 req/s from 0 to 7 lanes -- with `MEM` on 99% of samples, the front
 * worker's own page memo, which answers before the Durable Object hop. That is not the pool
 * refusing to scale; it is the pool never being asked. A session skips the shared tiers by
 * construction, which is what puts the request on a lane.
 *
 * The tier is counted on every sample for exactly this reason: the flat anonymous curve looked like
 * a result until the header said what answered it.
 */
async function drive(
	concurrency: number,
	seconds: number,
	cookie: string
): Promise<Record<string, unknown>> {
	// `edge=0` DECLINES THE MEMO AND THE EDGE CACHE TOGETHER, which is what puts the request on the
	// object and therefore on a lane. Without it 99% of samples answered `MEM` -- the front worker's
	// own page memo -- and the curve was flat from 0 to 7 lanes because the pool was never asked.
	const until = Date.now() + seconds * 1000;
	let done = 0;
	let errors = 0;
	const lat: number[] = [];
	const tiers = new Map<string, number>();
	const answered = new Map<string, number>();
	const worker = async () => {
		while (Date.now() < until) {
			// THE PATH VARIES, because `affinityKey()` hashes session, address and PATH -- and a run
			// with one path, no session and one client address is one affinity value, so every
			// request lands on the SAME lane however many exist. Measured: `answeredBy` was
			// `{r4: 5770}` across a whole sweep, which is one lane saturating and reads as a pool
			// that does not scale.
			const spread = SPREAD[Math.floor(Math.random() * SPREAD.length)] as string;
			const r = await hit(url('/serve', { path: spread, edge: 0 }), 30_000, cookie);
			done++;
			if (r.status !== 200) errors++;
			lat.push(r.wallMs);
			const t = r.headers.get('x-cfw-cache') ?? 'none';
			tiers.set(t, (tiers.get(t) ?? 0) + 1);
			// WHICH OBJECT ANSWERED. Without it a flat curve cannot be told apart from a pool
			// nothing was routed to, which is how every earlier `with lanes` reading was taken.
			const who = r.headers.get('x-cfw-replica') ?? r.headers.get('x-cfw-lanes') ?? 'primary';
			answered.set(who, (answered.get(who) ?? 0) + 1);
		}
	};
	const t0 = Date.now();
	await Promise.all(Array.from({ length: concurrency }, worker));
	const elapsed = (Date.now() - t0) / 1000;
	return {
		concurrency,
		requests: done,
		errors,
		reqPerSec: Number((done / elapsed).toFixed(2)),
		p50: median(lat),
		tiers: Object.fromEntries(tiers),
		answeredBy: Object.fromEntries(answered)
	};
}

// #endregion

if (import.meta.main) {
	if (ONLY === '' || ONLY === 'amort') {
		await seed(Math.max(...KS) + 6);
		for (let i = 0; i < N; i++) for (const k of KS) await amortSample(k, i);
	}

	if (ONLY === '' || ONLY === 'stale') {
		for (let i = 0; i < N * 2; i++) await staleSample('/', i);
	}

	if (ONLY === '' || ONLY === 'replica') {
		const jar = await signIn();
		emit({ arm: 'replica-auth', signedIn: jar !== '' });
		// the control FIRST, so the curve has a zero-lane baseline taken on the same object and the
		// same day rather than one quoted from an earlier run
		emit({ arm: 'replica', lanes: 0, ...(await drive(PER_LANE, 10, jar)) });
		for (let lane = 1; lane <= LANES; lane++) {
			const out = await provisionLane(lane);
			emit({
				arm: 'replica-provision',
				lane,
				stage: out['stage'] ?? null,
				ok: out['ok'] ?? null
			});
			emit({ arm: 'replica', lanes: lane, ...(await drive(PER_LANE * (lane + 1), 10, jar)) });
		}
	}
}
