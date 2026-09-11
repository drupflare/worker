import { writeFileSync } from 'node:fs';
import {
	type Cell,
	P95_CLOCK_QUANTUM_MS,
	TRAFFIC_MIX,
	decide,
	generatorBound,
	ratio,
	withRtt
} from './verdict-math';
import {
	type Sample,
	type Summary,
	WORKLOADS,
	isLocalTarget as isLocal,
	login,
	one,
	percentile,
	renderArm,
	run,
	setExtraHeaders
} from './vps-compare';

/**
 * Drives BOTH hosts through one matched workload set and answers the viability question.
 *
 * ```sh
 * bun run vps:up                                        # nginx + php-fpm 8.5 on the same tree
 * bun run dev                                           # the drupflare arm
 * bun run measure:bench-site -- --pass=<pw>             # provision the site the edge arm serves
 * bun run measure:host -- --pass=<pw>
 * ```
 *
 * WHY A SECOND SCRIPT. `vps-compare.ts` drives ONE arm and prints what it saw, which is the right
 * shape for a measurement and the wrong shape for a decision: every comparison so far was made by a
 * human reading two JSON documents and dividing, and that is where "225x" came from. This computes
 * the ratio from the two runs it performed itself, in one process, so no arm can be compared against
 * a reading taken under different conditions.
 *
 * THE ARMS RUN SEQUENTIALLY, and that is the whole reason this is trustworthy on a laptop. Both
 * targets and the generator share one machine. Run at once, each arm is the other's noise and the
 * ratio measures the scheduler.
 *
 * SEQUENTIAL IS NOT ENOUGH ON ITS OWN, and this justification stopped there until 2026-09-10. The
 * order was `vps` then `edge` in every cell of every run, so whatever drifts inside a cell was
 * charged to the edge arm every time rather than to each arm half the time -- a bias with a
 * direction, in a rig whose output is a verdict about that arm. The order rotates per cell now, and
 * a self-control runs one arm as both to print the resolution a difference has to beat.
 *
 * LOCALHOST IS THE VPS'S BEST CASE AND THAT IS WHY THIS CLAIM IS SAFE. A VPS answers from one
 * region; drupflare answers from the visitor's own colo. The network term is therefore missing from
 * the VPS side of every cell here, and adding it back can only move the result further in
 * drupflare's favour. So a drupflare win measured locally is a floor: it understates the production
 * gap rather than inventing one. `--rtt=<ms>` reports the same cells with a stated one-way network
 * term added to the VPS arm, and the verdict is always taken from the rtt=0 column.
 *
 * WHAT IT STILL CANNOT SAY, unchanged from `vps-compare.ts`:
 *
 * - Absolute edge CPU comes only from `cpuTime` on a deployed worker. These are service times.
 * - `wrangler dev` is one local workerd, so throughput here is a property of this machine. The
 *   RATIO is what transfers, not the req/s.
 * - The generator's own ceiling bounds every cell. It is measured first PER CONCURRENCY LEVEL,
 *   through the same closed loop the cells use, and a cell within 20% of the ceiling at its own
 *   width is reported as generator-bound rather than as a result.
 */

function arg(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? (hit.split('=').slice(1).join('=') as string) : fallback;
}

const VPS = arg('vps', 'http://127.0.0.1:8099').replace(/\/$/, '');
const EDGE = arg('edge', 'http://127.0.0.1:8787').replace(/\/$/, '');
const SITE = arg('site', 'bench');
const USER = arg('user', 'admin');
const PASS = arg('pass', '');
const SECOND_USER = arg('second-user', 'bench-editor');
const SECONDS = Number(arg('seconds', '10'));
const WARMUP = Number(arg('warmup', '3'));
const RTT = Number(arg('rtt', '0'));
/**
 * A static file both arms serve without touching PHP, so the reading is the generator's.
 *
 * 284 BYTES. It was `/core/misc/drupal.js`, which is 20,512 -- 1.7x the
 * ~12,000-byte cached page it was meant to bound. At thousands of req/s on loopback the transfer
 * dominates, so the bigger body read as a LOWER ceiling and `anon-cached` on the VPS came in at
 * 5,932 req/s against an asserted 3,447. A ceiling has to be the cheapest thing either arm serves,
 * which is why {@link ceilingBytes} is checked against every cell below rather than assumed.
 */
const CEILING_PATH = arg('ceiling-path', '/core/misc/checkbox.js');
const CEILING_SECONDS = Number(arg('ceiling-seconds', '3'));
/**
 * A network the operator INJECTED on the VPS arm, in milliseconds of round trip.
 *
 * Declared rather than detected, because the rig cannot tell a delaying proxy from a slow harness
 * and the two mean opposite things: an incidental floor difference is an artifact to discount, and
 * an injected one is the term being measured. Without this the floor note tells a later reader to
 * discount exactly the quantity the run existed to price.
 */
const NETWORK_MS = Number(arg('network-ms', '0'));
/**
 * Under this many bytes, a page workload answered with nothing whatever its status said.
 *
 * 512, which is under the smallest real page either arm serves and over any redirect or empty JSON
 * body. A 2-byte mean is what prompted it: `auth-account c=16` on a lane pool, 200s carrying `{}`.
 */
const EMPTY_BODY_BYTES = 512;
const LEVELS = arg('concurrency', '1,4,16')
	.split(',')
	.map((n) => Number(n.trim()))
	.filter((n) => Number.isFinite(n) && n >= 1);
/**
 * The closed-loop matrix excludes `anon-miss`, which `coldPathArm` measures instead.
 *
 * A closed-loop cell needs both arms doing the SAME work. The uncached tail does not qualify: one
 * side renders and the other refuses and queues. Its traffic weight stays in the mix and is
 * reported through the cold-path arm, so the slice is not silently dropped from the picture.
 */
const CLOSED_LOOP = Object.keys(TRAFFIC_MIX).filter((w) => w !== 'anon-miss');
const WANTED = arg('workload', CLOSED_LOOP.join(',')).split(',');

/**
 * ONLY A LOCAL EDGE NEEDS THE SYNTHETIC HOST. A deployed worker's own hostname already resolves to
 * the site, and overriding `Host` on an https target makes the client verify the certificate
 * against `<site>.localhost` -- which fails as `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` and looks
 * like a blocked network rather than a header this file added.
 */
const HEADERS = {
	vps: {} as Record<string, string>,
	edge: (isLocal(EDGE) ? { host: `${SITE}.localhost` } : {}) as Record<string, string>
} as const;

/**
 * Creates the second account both arms need, through Drupal's own form.
 *
 * A SHARED EDGE PLAN NEEDS TWO DIFFERENT SESSIONS OF A ROLE SET TO AGREE, which is
 * `noteEdgeRender()`'s `wa === wb` refusal, and one benchmark client can never give it. Every
 * authenticated figure this project has published was therefore taken with the compiled-plan tier
 * unreachable -- correct as a safety property and a real hole in the comparison, because the tier
 * answers a warm authenticated page in 5 ms and the arm it was compared against had to render.
 *
 * Through `/admin/people/create` rather than a host op, for one reason: the VPS needs the same
 * account, and a host op does not exist there. A form both arms serve keeps the two sites identical.
 *
 * Idempotent by the outcome rather than by a check: Drupal refuses a duplicate name, and a refusal
 * means the account is already there.
 */
async function ensureSecondUser(
	base: string,
	cookie: string,
	headers: Record<string, string>
): Promise<'created' | 'present'> {
	const form = await fetch(`${base}/admin/people/create`, {
		headers: { ...headers, cookie },
		redirect: 'manual'
	});
	const html = await form.text();
	const buildId = /name="form_build_id" value="([^"]+)"/.exec(html)?.[1];
	const token = /name="form_token" value="([^"]+)"/.exec(html)?.[1] ?? '';
	if (!buildId) throw new Error(`${base}/admin/people/create served no form to ${USER}`);

	const body = new URLSearchParams({
		name: SECOND_USER,
		mail: `${SECOND_USER}@example.invalid`,
		'pass[pass1]': PASS,
		'pass[pass2]': PASS,
		status: '1',
		// the same role as the benchmark admin, so the two sessions land in ONE role set. Two
		// sessions in DIFFERENT role sets key different plans and neither ever gets a second witness
		'roles[administrator]': 'administrator',
		form_build_id: buildId,
		form_id: 'user_register_form',
		form_token: token,
		op: 'Create new account'
	});
	const res = await fetch(`${base}/admin/people/create`, {
		method: 'POST',
		body,
		redirect: 'manual',
		headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...headers }
	});
	const after = await res.text();
	if (/is already taken|already in use/.test(after)) return 'present';
	if (res.status >= 400) throw new Error(`creating ${SECOND_USER} answered ${res.status}`);
	// A REJECTED FORM IS A 200, so `status < 400` said "created" for an account that does not
	// exist -- and the run then died three steps later with "the second editor exists but cannot
	// log in", which names the symptom and hides the cause. Drupal re-renders the form with its
	// messages region populated; that region is the actual answer.
	const plain = after
		.replace(/<svg[\s\S]*?<\/svg>/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ');
	const refusal = /Error message(.{0,200})/.exec(plain)?.[1];
	if (refusal !== undefined) {
		throw new Error(`creating ${SECOND_USER} was refused: ${refusal.trim()}`);
	}
	return 'created';
}

/**
 * The authenticated curve, driven by TWO sessions alternately.
 *
 * Alternating rather than one-then-the-other: the compile needs the last two samples of a page to
 * come from different witnesses, so two consecutive requests from session A followed by two from B
 * gives the pair (B, B) and refuses. Alternating gives (A, B) on every even sample.
 *
 * The returned curve is session A's requests only. B is present to complete the pair, and folding
 * its samples in would report a convergence curve twice as long as the one a user experiences.
 */
async function pairedSessionArm(
	base: string,
	kind: 'vps' | 'edge',
	path: string,
	n: number,
	a: string,
	b: string
): Promise<Sample[]> {
	if (kind === 'edge') {
		await fetch(`${base}/bump?reason=hostverdict`, { headers: HEADERS.edge });
		// the bump empties the page store and a local rig fires no alarm to refill it, so
		// `/user/login` would answer 503 `warming`. Driven synchronously, as `bench-site.ts` does
		for (const warm of ['/user/login', path]) {
			await fetch(`${base}/fill?path=${encodeURIComponent(warm)}`, { headers: HEADERS.edge });
			await fetch(`${base}/fill`, { headers: HEADERS.edge });
		}
	}
	const out: Sample[] = [];
	for (let i = 0; i < n; i++) {
		out.push(await one(`${base}${path}`, a));
		await one(`${base}${path}`, b);
	}
	return out;
}

/**
 * Provisions the replica lanes the edge arm needs to answer concurrent requests.
 *
 * WITHOUT THIS THE CONCURRENCY CELLS COMPARE 32 PHP WORKERS AGAINST ONE THREAD. A Durable Object
 * serves one request at a time and holds it for a whole render, so at four clients the edge arm
 * queues while the VPS's `pm.max_children = 32` does not -- measured before the lanes existed:
 * `/admin/content` read 309 ms on the edge against 63 on the VPS at c=4, and 80 against 71 at c=1.
 * That is not the VPS at its best against drupflare at its best; it is drupflare configured for no
 * concurrency at all.
 *
 * `REPLICA_COUNT` alone only tells the ROUTER lanes exist. Autoscaling is what creates them, off the
 * alarm, and a local `wrangler dev` object is rebuilt often enough that an armed alarm frequently
 * never fires -- so the copy is driven synchronously here, the same way `bench-site.ts` drives a
 * fill. A lane that is not SERVING answers 421 and the front worker retries on the primary, which
 * means a half-provisioned pool degrades into the single-object reading rather than into an error.
 *
 * @returns the lanes that reached SERVING.
 */
async function provisionLanes(base: string, lanes: number): Promise<number[]> {
	const ready: number[] = [];
	for (let lane = 1; lane <= lanes; lane++) {
		let done = false;
		// THE CURSOR IS CARRIED BACK BY THE CALLER, and omitting it looks like slow progress rather
		// than like a mistake: `ProvisionCursor` is handed back rather than stored on the primary, so
		// a loop that drops it re-copies the same chunk forever. Measured while getting this wrong --
		// 26 consecutive calls each reported `copied: 560` with the cursor pinned at index 19.
		let cursor = '';
		// a bound rather than a while(true): a lane that cannot copy would otherwise spin here, and
		// the degradation path is a 421 retry on the primary, which is a usable arm
		for (let step = 0; step < 120 && !done; step++) {
			const res = await fetch(
				`${base}/replica?action=provision&lane=${lane}&budget=4000` +
					(cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`),
				{ headers: HEADERS.edge }
			);
			if (!res.ok) break;
			const body = (await res.json()) as {
				ok?: boolean;
				done?: boolean;
				reason?: string;
				cursor?: unknown;
			};
			// A REFUSAL IS HTTP 200 WITH `ok:false`, and reading only `res.ok` cost a whole run: the
			// loop retried a deterministic schema refusal 200 times per lane, 600 requests of it,
			// and the login that followed timed out. A refused copy is refused; stop asking.
			if (body.ok === false) {
				console.error(`[host-verdict] lane ${lane} refused: ${body.reason ?? 'no reason'}`);
				break;
			}
			done = body.done === true;
			if (body.cursor !== undefined) cursor = JSON.stringify(body.cursor);
		}
		if (done) ready.push(lane);
	}
	return ready;
}

/**
 * The uncached tail, measured as TIME TO SERVED rather than as a closed-loop cell.
 *
 * THE CLOSED-LOOP VERSION COMPARED TWO DIFFERENT WORKLOADS AND I SHIPPED IT ONCE. A unique query
 * string is a render on the VPS and a path drupflare has never seen, which it answers 503 and
 * queues -- so the cell read 967 errors and a p50 of 0 on the edge against a 25 ms render on the
 * VPS. That is this project's signature mistake reproduced inside its own comparison harness: one
 * axis, two workloads, two instruments.
 *
 * What a VISITOR experiences is comparable, and it is the only thing here that is: how long until
 * this URL answers with a page. On the VPS that is one render. On drupflare it is a refusal, a
 * queued fill, and a retry -- and the retry loop is the cost, so it is counted rather than hidden.
 * A local rig fires no alarm reliably, so the drain is driven the way `bench-site.ts` drives it;
 * that removes scheduling latency the platform would add, which is the one place this arm flatters
 * drupflare and it is stated rather than buried.
 *
 * @returns ms from the first request to the first 2xx, and how many requests that took.
 */
async function coldPathArm(
	base: string,
	kind: 'vps' | 'edge',
	n: number
): Promise<{ ms: number; attempts: number }[]> {
	const out: { ms: number; attempts: number }[] = [];
	for (let i = 0; i < n; i++) {
		const url = `${base}/?coldpath=${i}-${SECONDS}`;
		const t0 = Date.now();
		let attempts = 0;
		let served = false;
		// 12 is a bound, not an expectation: an unbounded retry against a path the chain has proven
		// it cannot store would never terminate, which `noteStorable()` exists to stop on the host
		while (attempts < 12 && !served) {
			attempts++;
			const sample = await one(url, null);
			if (sample.status >= 200 && sample.status < 400) {
				served = true;
				break;
			}
			if (kind === 'edge') await fetch(`${base}/fill`, { headers: HEADERS.edge });
		}
		out.push({ ms: served ? Date.now() - t0 : -1, attempts });
	}
	return out;
}

async function measureArm(
	base: string,
	kind: 'vps' | 'edge',
	workload: string,
	concurrency: number,
	cookie: string | null
): Promise<Summary> {
	setExtraHeaders(kind === 'edge' ? HEADERS.edge : HEADERS.vps);
	const summary = await run(base, workload, concurrency, SECONDS, cookie);
	// STOP THE RUN, do not note it. A cell whose samples never reached the host has no latency in
	// it, and the shape it produces is a FAST one: three different paths once read an identical
	// 25 ms p50 and ~1,150 req/s because every sample was Cloudflare's own refusal page
	if (summary.edgeRefusals > 0) {
		console.error(
			`[host-verdict] ${kind} ${workload} c=${concurrency}: ${summary.edgeRefusals} of ` +
				`${summary.n} samples were refused at the EDGE (a 4xx carrying no x-worker-ms). ` +
				'Nothing below measured the host; fix the request the generator is sending.'
		);
		process.exit(3);
	}
	return summary;
}

if (PASS === '') {
	console.error('usage: bun scripts/measure/host-verdict.ts --pass=<admin password> [--rtt=25]');
	console.error(
		'  every authenticated workload needs it, and so does creating the second editor'
	);
	process.exit(2);
}

// #region the generator's own ceiling, which bounds every cell below it
// Against each arm's OWN no-work endpoint, because they do not share one: drupflare answers
// `/robots.txt` as a deny-list 404, which is not no-work and read 109 req/s against a real 1,231
WORKLOADS.ceiling!.path = CEILING_PATH;

/**
 * PER CONCURRENCY LEVEL, AND THROUGH `run()` -- the same closed loop the cells use.
 *
 * One ceiling taken at a fixed width cannot bound a matrix that varies width. It was measured by
 * `Promise.all` over batches of 8, which is a BARRIER: every round costs the slowest of its eight,
 * so the reading is a floor on the generator rather than its ceiling. The cells drive an open pool
 * where each client loops independently. Measured against that, `anon-cached` on the VPS read
 * 5,932 req/s at c=4 while the "ceiling" said 2,639 -- 2.2x its own asserted bound, which is the
 * tell that the two were not the same instrument.
 *
 * It mattered beyond the printed line: `generatorBound` EXCLUDES a cell from the p95 rule, so an
 * under-read ceiling switches a verdict rule off on cells that are not bound, and a c=1 cell could
 * never be flagged at all against a c=8 reading.
 */
const ceilings: Record<string, Record<number, number>> = { vps: {}, edge: {} };
const ceilingBytes: Record<string, number> = {};
/** each arm's transport cost with no application code in it; see the c=1 branch below */
const floorMs: Record<string, number> = {};
for (const [kind, base] of [
	['vps', VPS],
	['edge', EDGE]
] as const) {
	setExtraHeaders(kind === 'edge' ? HEADERS.edge : HEADERS.vps);
	const probe = await one(`${base}${CEILING_PATH}`, null);
	ceilingBytes[kind] = probe.bytes;
	if (probe.status !== 200) {
		console.error(
			`[host-verdict] ${kind} answered ${probe.status} for the ceiling path ${CEILING_PATH}; ` +
				'a ceiling taken against a non-200 measures the refusal'
		);
		process.exit(2);
	}
	for (const concurrency of LEVELS) {
		const summary = await run(base, 'ceiling', concurrency, CEILING_SECONDS, null);
		ceilings[kind]![concurrency] = summary.rps;
		// THE SAME PASS MEASURES EACH ARM'S HARNESS FLOOR, because the ceiling path runs no
		// application code on either side -- verified: it carries no `x-worker-ms` and no
		// `x-cfw-cache`, so the Worker script never executes for it. The arms are NOT equidistant
		// from the generator, which is the premise `decidedOn: total-p50` rests on: measured
		// 2026-09-11 at c=1, vps 0.561 ms against edge 1.165 ms over 3x400 interleaved samples.
		// nginx is one hop on a published port; `wrangler dev` is a node proxy in front of workerd.
		// INTEGER MILLISECONDS, because `run()` samples on `Date.now()` -- so this reports the floor
		// to the nearest quantum and under-expresses it. `scratchpad/harness-floor.mjs` measures the
		// same thing on `hrtime` and read vps 0.561 ms against edge 1.165 ms; use that figure when a
		// precise one is wanted and this one to know whether a cell is inside it at all
		if (concurrency === 1) floorMs[kind] = summary.p50;
		console.error(
			`[host-verdict] ${kind} generator ceiling c=${String(concurrency).padStart(3)} ` +
				`${summary.rps.toFixed(1).padStart(8)} req/s` +
				(concurrency === 1 ? `  harness floor p50 ${summary.p50} ms` : '')
		);
		// LET THE CLIENT'S OWN CONNECTION POOL DRAIN. This loop opens thousands of loopback sockets
		// in seconds, and the request immediately after it failed with `ConnectionRefused` on every
		// one of eight runs -- while `curl` against the same port answered 200 and `lsof` showed
		// three listeners throughout, and workerd held one pid at a flat 188 MB. The server was
		// never down; the client could not open a socket. Forty retries over twenty seconds did not
		// recover it, which is what says this is pool state rather than back-pressure.
		await new Promise((r) => setTimeout(r, 3000));
	}
}
// #endregion

/**
 * Fills the paths the login sequence needs, AFTER the lanes are copied.
 *
 * Order matters and cost a run: copying a lane advances the generation, which empties the page
 * store, so a warm-up taken before provisioning is discarded and `/user/login` answers 503 again.
 *
 * A local `wrangler dev` object is torn down and rebuilt often, and any applied reconciliation step
 * invalidates every stored page, so `/user/login` answers 503 `warming` with nothing scheduled to
 * refill it. `login()` then reads no `form_build_id` and the whole run dies reporting a wrong
 * password. `/fill` with no path drains one synchronously, which is what the route exists for.
 */
const LANES = Number(arg('lanes', '3'));
const lanesReady = LANES > 0 ? await provisionLanes(EDGE, LANES) : [];
console.error(
	`[host-verdict] edge replica lanes ready: ${lanesReady.length}/${LANES}` +
		`${lanesReady.length < LANES ? ' (the rest degrade to a 421 retry on the primary)' : ''}`
);

// `/user/login` LAST, because the run's own later arms bump: `renderArm` bumps once per sample and
// `sessionArm` once more, so a verdict run leaves the site cold for the next one and a login page
// warmed first is invalidated by the fills after it. Measured: the generation moved 16 -> 24 across
// two runs, one step per bump, and `login()` then read a 503 and reported a wrong password
for (const path of ['/', '/admin/content', '/user', '/user/login']) {
	// UNTIL IT SERVES, not once. `/fill` drains ONE queued path, FIFO, so a single drain per path
	// fills whatever was already queued and leaves this one cold -- and a cold `/user/login` is a
	// 503 with no `form_build_id` in it, which `login()` reports as a wrong password. Measured on
	// a deployed run whose queue held 15 entries from the previous arm's cold-path workload.
	for (let i = 0; i < 40; i++) {
		// `redirect: 'manual'`, and WITHOUT IT THIS ENDED TEN RUNS BEFORE ANYTHING WAS MEASURED.
		// `/serve?path=/user` answers 302 to an unauthenticated client, and this rig sends
		// `Host: <site>.localhost` so the object can tell the sites apart -- so Drupal builds the
		// `Location` from that host, bun follows it to `<site>.localhost:80`, nothing listens
		// there, and the throw is `ConnectionRefused` against a URL the log never shows.
		//
		// It reads exactly like the worker dying, and it is not. Measured while it happened: `curl`
		// answered 200 on the same port throughout, `lsof` showed three listeners, and workerd held
		// ONE pid at a flat 188 MB. Four theories died on that evidence -- an OS kill for memory, a
		// workerd restart, the 1.2 GB observability trace store, and client socket pressure after
		// the ceiling pass. `curl` never saw it because curl does not follow redirects.
		//
		// A 302 IS served for warming purposes, which is what the `< 400` below already says.
		const res = await fetch(`${EDGE}/serve?path=${encodeURIComponent(path)}`, {
			headers: HEADERS.edge,
			redirect: 'manual'
		});
		await res.arrayBuffer();
		if (res.status < 400) break;
		await fetch(`${EDGE}/fill?path=${encodeURIComponent(path)}`, { headers: HEADERS.edge });
		await fetch(`${EDGE}/fill`, { headers: HEADERS.edge });
	}
}

console.error(`[host-verdict] logging in to both arms as ${USER}`);
/**
 * Retried, because a login here fails intermittently and the failure is NOT a wrong password.
 *
 * A generation bump empties `cfw_page`, and this run's own later arms bump: `renderArm` once per
 * sample and `sessionArm` once more. A cold `/user/login` answers 503 with no `form_build_id` in
 * it, which reads as a credential error. Observed failing and then succeeding six times in a row
 * against the same deployment seconds later, so the retry re-warms rather than re-asking.
 */
async function loginRetrying(
	base: string,
	headers: Record<string, string>
): Promise<string | null> {
	for (let i = 0; i < 4; i++) {
		setExtraHeaders(headers);
		const cookie = await login(base, USER, PASS);
		if (cookie !== null) return cookie;
		const res = await fetch(`${base}/serve?path=${encodeURIComponent('/user/login')}`, {
			headers
		});
		await res.arrayBuffer();
		console.error(`[host-verdict] login attempt ${i + 1} failed; /user/login is ${res.status}`);
		await fetch(`${base}/fill?path=${encodeURIComponent('/user/login')}`, { headers }).catch(
			() => undefined
		);
		await fetch(`${base}/fill`, { headers }).catch(() => undefined);
	}
	return null;
}

const vpsCookie = await loginRetrying(VPS, HEADERS.vps);
const edgeCookie = await loginRetrying(EDGE, HEADERS.edge);
setExtraHeaders(HEADERS.edge);
if (vpsCookie === null || edgeCookie === null) {
	console.error(
		`could not log in: vps=${vpsCookie === null ? 'failed' : 'ok'} ` +
			`edge=${edgeCookie === null ? 'failed' : 'ok'}. Is --pass right, and has ` +
			'`bun run measure:bench-site` provisioned the edge site?'
	);
	process.exit(2);
}

const notes: string[] = [];

/**
 * A LOCAL EDGE ARM CANNOT MEASURE CONCURRENCY, and the verdict is decided by the cell it cannot
 * measure.
 *
 * `wrangler dev` is one `workerd` process on one thread; a colo is not. Measured 2026-09-10 on the
 * anonymous cached path, the slice carrying 0.82 of the traffic weight and answered entirely by
 * `caches.default` with no Durable Object in it at all: locally 427 / 511 / 536 req/s at
 * c=1 / 4 / 32 with p50 2 / 6 / 51 ms, and on a deployed free worker 19.9 / 90.6 / 727.9 req/s at
 * the same levels with p50 47 / 41 / 41 ms and `x-worker-ms` flat at 6.8-8.1. So the profile that
 * collapses here does not degrade at all on the platform; what saturates locally is one thread
 * running the front worker script, which on the same rig pushes 1,805 req/s on a path that never
 * enters it.
 *
 * The VPS arm has no equivalent handicap -- nginx plus `pm.max_children = 32` uses every core -- so
 * a concurrency cell taken this way compares a real VPS against a single-threaded simulation.
 */
if (isLocal(EDGE) && LEVELS.some((c) => c > 1)) {
	notes.push(
		'the edge arm is a local `wrangler dev`, which is one workerd thread, so every cell above ' +
			'c=1 measures that thread rather than the platform; the deployed anonymous cached path ' +
			'holds p50 flat from c=4 to c=32'
	);
	console.error(`[host-verdict] ${notes[notes.length - 1]}`);
}

for (const [kind, base, cookie] of [
	['vps', VPS, vpsCookie],
	['edge', EDGE, edgeCookie]
] as const) {
	setExtraHeaders(kind === 'edge' ? HEADERS.edge : HEADERS.vps);
	const state = await ensureSecondUser(base, cookie, kind === 'edge' ? HEADERS.edge : {});
	notes.push(`${kind}: second editor ${SECOND_USER} ${state}`);
	console.error(`[host-verdict] ${kind} second editor ${state}`);
}

setExtraHeaders(HEADERS.vps);
const vpsSecond = await login(VPS, SECOND_USER, PASS);
setExtraHeaders(HEADERS.edge);
const edgeSecond = await login(EDGE, SECOND_USER, PASS);
if (vpsSecond === null || edgeSecond === null) {
	console.error('the second editor exists but cannot log in; the plan tier cannot be reached');
	process.exit(2);
}

/**
 * The rig's own resolution, measured by running ONE arm as both arms.
 *
 * Its ratio is 1.000x by construction, so whatever it prints is the floor below which a per-cell
 * difference is not a finding. Comparing three interpreter ABIs, a per-arm-block run reported
 * long64 1.5% faster than wasm32 and an interleaved one read 1.001x; the self-control is what
 * dated that as noise rather than a result.
 */
async function selfControl(): Promise<{ p50: number; rps: number; p95SpreadMs: number }> {
	setExtraHeaders(HEADERS.edge);
	const a = await measureArm(EDGE, 'edge', CONTROL_WORKLOAD, CONTROL_LEVEL, edgeCookie);
	const b = await measureArm(EDGE, 'edge', CONTROL_WORKLOAD, CONTROL_LEVEL, edgeCookie);
	// the ABSOLUTE spread as well as the ratio, because rule 2 is a ratio and a ratio over one or
	// two clock quanta reports the quantisation: `anon-cached c=1` failed the whole verdict at
	// 3ms against 1ms while the two arms were 2ms apart
	return {
		p50: ratio(a.p50, b.p50),
		rps: ratio(b.rps, a.rps),
		p95SpreadMs: Math.abs(a.p95 - b.p95)
	};
}

const CONTROL_WORKLOAD = 'anon-cached';
const CONTROL_LEVEL = 4;

function reportControl(
	when: 'before' | 'after',
	c: { p50: number; rps: number; p95SpreadMs: number }
): void {
	console.error(
		`[host-verdict] rig resolution ${when} the matrix, one arm as both: ` +
			`p50x=${c.p50.toFixed(2)} rpsx=${c.rps.toFixed(2)} p95spread=${c.p95SpreadMs}ms`
	);
}

/**
 * TWO controls, because one cannot see the thing that made the old fixed order dangerous.
 *
 * A single reading dates the noise floor. A pair dates DRIFT: if the machine is the same at the end
 * as at the start, the two agree, and a cross-arm ratio taken between them means what it says. If
 * they disagree, something moved during the run -- memory filling, a cache warming, another job
 * arriving -- and that is exactly the condition under which the order arms are driven in decides
 * the result.
 */
const controlBefore = await selfControl();
reportControl('before', controlBefore);

// #region the matrix
const cells: Cell[] = [];
let round = 0;
for (const workload of WANTED) {
	const spec = TRAFFIC_MIX[workload];
	if (!spec) {
		console.error(
			`unknown workload ${workload}; known: ${Object.keys(TRAFFIC_MIX).join(', ')}`
		);
		process.exit(2);
	}
	// warm each arm once per workload, outside the readings, so an opcache fill or a lazy mount is
	// not folded into the first level
	if (WARMUP > 0) {
		await measureArm(VPS, 'vps', workload, 2, vpsCookie);
		await measureArm(EDGE, 'edge', workload, 2, edgeCookie);
	}
	for (const concurrency of LEVELS) {
		// ROTATED, and it used to be `vps` then `edge` on every cell of every run. Any drift
		// inside a cell -- a page cache filling, memory pressure building, another job starting --
		// lands on whichever arm goes second, so a FIXED order charges all of it to the same arm
		// and the bias points one way in every reading the rig has ever produced. This project
		// measured the same mistake comparing interpreter ABIs: per-arm blocks reported long64
		// 1.5% faster than wasm32, and interleaved on a quiet machine the two read 1.001x
		const edgeLeads = round++ % 2 === 1;
		let vps: Summary;
		let edge: Summary;
		if (edgeLeads) {
			edge = await measureArm(EDGE, 'edge', workload, concurrency, edgeCookie);
			vps = await measureArm(VPS, 'vps', workload, concurrency, vpsCookie);
		} else {
			vps = await measureArm(VPS, 'vps', workload, concurrency, vpsCookie);
			edge = await measureArm(EDGE, 'edge', workload, concurrency, edgeCookie);
		}
		// A CEILING BIGGER THAN THE CELL IS NOT A CEILING. On loopback at these rates the transfer
		// dominates, so a heavier no-work path reads as a lower bound and every cell above it looks
		// generator-bound -- which is the direction that silently removes cells from the p95 rule.
		//
		// TWO CAUSES, AND THE FIRST VERSION GAVE THE WRONG ADVICE FOR ONE. `auth-account c=16` came
		// back at 2 BYTES and this told the operator to pass a smaller ceiling path. A page
		// workload answering in two bytes did not measure a page: it is the "a dead arm is not a
		// fast arm" shape, a 200 carrying nothing, which the error-fraction check cannot see
		for (const [kind, arm] of [
			['vps', vps],
			['edge', edge]
		] as const) {
			const ceilBytes = ceilingBytes[kind] ?? 0;
			if (arm.bytes > 0 && arm.bytes < EMPTY_BODY_BYTES) {
				console.error(
					`[host-verdict] ${kind} ${workload} c=${concurrency}: a mean body of ` +
						`${arm.bytes} bytes over ${arm.n} samples. A page workload answering in ` +
						'fewer bytes than a redirect measured no page, whatever status it carried.'
				);
				process.exit(3);
			}
			if (arm.bytes > 0 && ceilBytes > arm.bytes) {
				console.error(
					`[host-verdict] ${kind} ${workload} c=${concurrency}: the ceiling path is ` +
						`${ceilBytes} bytes against this cell's ${arm.bytes}, so the ceiling is the ` +
						'heavier request and cannot bound it. Pass a smaller --ceiling-path.'
				);
				process.exit(2);
			}
		}
		const bound = generatorBound(
			concurrency,
			{ vps: vps.rps, edge: edge.rps },
			{ vps: ceilings.vps, edge: ceilings.edge }
		);
		cells.push({
			workload,
			concurrency,
			vps,
			edge,
			p50Ratio: ratio(withRtt(vps.p50, RTT), edge.p50),
			p95Ratio: ratio(withRtt(vps.p95, RTT), edge.p95),
			rpsRatio: ratio(edge.rps, vps.rps),
			generatorBound: bound
		});
		const c = cells[cells.length - 1] as Cell;
		console.error(
			`[host-verdict] ${workload.padEnd(13)} c=${String(concurrency).padStart(3)} ` +
				`vps p50=${String(vps.p50).padStart(5)}ms rps=${vps.rps.toFixed(1).padStart(7)} | ` +
				`edge p50=${String(edge.p50).padStart(5)}ms rps=${edge.rps.toFixed(1).padStart(7)} | ` +
				`p50x=${c.p50Ratio.toFixed(2)} rpsx=${c.rpsRatio.toFixed(2)}` +
				`${bound ? ' GENERATOR-BOUND' : ''}${edge.errors || vps.errors ? ' ERRORS' : ''}`
		);
	}
}

const controlAfter = await selfControl();
reportControl('after', controlAfter);
const drifted = Math.abs(controlAfter.p50 - controlBefore.p50) > 0.25;
if (drifted) {
	notes.push(
		`the rig drifted during the matrix: self-control p50x ${controlBefore.p50.toFixed(2)} ` +
			`before against ${controlAfter.p50.toFixed(2)} after, so a cross-arm ratio taken ` +
			'between them is not safe to read'
	);
	console.error(`[host-verdict] ${notes[notes.length - 1]}`);
}
// #endregion

// #region the authenticated curve, where the plan tier finally has two witnesses
const curves: Record<string, { first: number; converged: number; tiers: string[] }> = {};
for (const [kind, base, a, b] of [
	['vps', VPS, vpsCookie, vpsSecond],
	['edge', EDGE, edgeCookie, edgeSecond]
] as const) {
	setExtraHeaders(kind === 'edge' ? HEADERS.edge : HEADERS.vps);
	// 12 RATHER THAN 8, because 8 sat ON the convergence point and so measured the bound. Driven by
	// hand against the same site, the pair reaches `PLAN:private` at request 7 -- and a single ERROR
	// in the sequence costs a witness and pushes it further, which is how this arm kept reporting
	// that no cell ever reached the plan tier while the tier was working
	const samples = await pairedSessionArm(base, kind, '/admin/content', 12, a, b);
	const tail = samples
		.slice(3)
		.map((s) => s.ms)
		.sort((x, y) => x - y);
	curves[kind] = {
		first: samples[0]?.ms ?? 0,
		converged: percentile(tail, 50),
		tiers: samples.map((s) => s.tier)
	};
	console.error(
		`[host-verdict] ${kind} /admin/content paired curve first=${curves[kind]?.first}ms ` +
			`converged p50=${curves[kind]?.converged}ms tiers=[${curves[kind]?.tiers.join(' ')}]`
	);
}
// #endregion

// #region the uncached tail, as a visitor meets it
const coldPaths: Record<string, { ms: number; attempts: number }[]> = {};
for (const [kind, base] of [
	['vps', VPS],
	['edge', EDGE]
] as const) {
	setExtraHeaders(kind === 'edge' ? HEADERS.edge : HEADERS.vps);
	coldPaths[kind] = await coldPathArm(base, kind, 5);
	const served = (coldPaths[kind] ?? []).filter((r) => r.ms >= 0);
	const times = served.map((r) => r.ms).sort((a, b) => a - b);
	console.error(
		`[host-verdict] ${kind} cold path served ${served.length}/5 ` +
			`p50=${percentile(times, 50)}ms attempts=[${(coldPaths[kind] ?? [])
				.map((r) => r.attempts)
				.join(', ')}]`
	);
}
// #endregion

// #region the render arm, which is the same workload on both sides
const renders: Record<string, { cold: number; warm: number[] }> = {};
for (const [kind, base] of [
	['vps', VPS],
	['edge', EDGE]
] as const) {
	setExtraHeaders(kind === 'edge' ? HEADERS.edge : HEADERS.vps);
	const times = await renderArm(base, kind === 'edge' ? 'drupflare' : 'vps', 7);
	renders[kind] = { cold: times[0] as number, warm: times.slice(1).sort((a, b) => a - b) };
	const w = renders[kind]?.warm ?? [];
	console.error(
		`[host-verdict] ${kind} re-render cold=${renders[kind]?.cold}ms ` +
			`warm p50=${percentile(w, 50)}ms all=[${w.join(', ')}]`
	);
}
// #endregion

const planned = (curves.edge?.tiers ?? []).some((t) => t.startsWith('PLAN'));
if (!planned) {
	notes.push(
		'NO CELL WAS ANSWERED BY THE COMPILED-PLAN TIER. The two-witness pair did not converge, so ' +
			'the authenticated figures are a render-against-render comparison and understate the arm.'
	);
}
if (lanesReady.length < LANES) {
	notes.push(
		`the edge arm ran with ${lanesReady.length} of ${LANES} replica lanes, so its concurrency ` +
			'cells are closer to the single-object reading than to the pooled one'
	);
}
// THE ARMS ARE NOT EQUIDISTANT FROM THE GENERATOR, and `decidedOn: total-p50` says they are. The
// gap is reported rather than subtracted: subtracting it silently would be the rig deciding which
// milliseconds belong to whom, and a reader comparing sub-millisecond cells needs to see both
const floorGap = Math.abs((floorMs.edge ?? 0) - (floorMs.vps ?? 0));
if (floorMs.edge !== undefined && floorMs.vps !== undefined && floorGap > 0) {
	notes.push(
		NETWORK_MS > 0
			? `THE VPS ARM CARRIES AN INJECTED ${NETWORK_MS} ms ROUND TRIP, which is what the ` +
					`${floorGap} ms floor difference is: vps ${floorMs.vps} ms against edge ` +
					`${floorMs.edge} ms on a path that runs no application code on either arm. That gap ` +
					'is the QUANTITY BEING MEASURED, not an artifact to discount -- a single-region VPS ' +
					'is one network hop from a visitor and an edge network answers from their own colo. ' +
					'It understates twice: the proxy delays data rather than the TCP handshake, and the ' +
					'edge arm stays local and pays no network at all.'
			: `HARNESS FLOORS DIFFER: vps ${floorMs.vps} ms against edge ${floorMs.edge} ms on a ` +
					'path that runs no application code on either arm (it carries no `x-worker-ms`, so ' +
					`the Worker script never executes for it). Any cell whose p50 gap is at or under ` +
					`${floorGap} ms is inside the transport difference rather than the hosts. nginx ` +
					'answers on a published docker port; `wrangler dev` proxies a node process in front ' +
					'of workerd, which a deployed worker does not do.'
	);
}
if (RTT > 0) {
	notes.push(
		`the VPS arm carries a stated ${RTT} ms network round trip; the verdict itself is taken ` +
			'from rtt=0, which is the VPS at its best'
	);
}

/**
 * ASYMMETRIC ARMS CANNOT BE JUDGED ON TOTAL LATENCY, so the quantity is chosen rather than assumed.
 *
 * A localhost VPS carries no network; a deployed worker driven from one laptop carries 30-42 ms of
 * round trip to ONE colo, which no real visitor pays because a real visitor is answered from their
 * own. Comparing the two totals measures the distance from this machine to Cloudflare. The fix is
 * not to drop the network term -- `--rtt` still prices it on the VPS side -- it is to say plainly
 * which question the number answers.
 */
const DECIDED_ON = isLocal(EDGE) === isLocal(VPS) ? 'total-p50' : 'service-time';
// THE RIG'S OWN RESOLUTION, taken from the pair of identical runs rather than chosen. The worse of
// the two controls, because a floor that only holds on the quiet half of a run is not a floor
const P95_FLOOR = Math.max(
	P95_CLOCK_QUANTUM_MS,
	controlBefore.p95SpreadMs,
	controlAfter.p95SpreadMs
);
const verdict = decide(cells, RTT, notes, TRAFFIC_MIX, DECIDED_ON, P95_FLOOR);
const weighted = verdict.weighted;

const report = {
	generatedBy: 'scripts/measure/host-verdict.ts',
	vps: VPS,
	edge: EDGE,
	seconds: SECONDS,
	rttMs: RTT,
	ceilings,
	// each arm's transport-only cost, so a reader can subtract it themselves rather than trust a
	// cross-arm p50 on a workload smaller than the difference between the two harnesses
	harnessFloorMs: floorMs,
	lanesRequested: LANES,
	lanesReady,
	trafficMix: TRAFFIC_MIX,
	cells,
	curves,
	coldPaths,
	renders,
	verdict
};

console.error('');
console.error(
	`[host-verdict] weighted ${verdict.decidedOn}  vps=${weighted.vps.toFixed(1)}ms ` +
		`edge=${weighted.edge.toFixed(1)}ms  ratio=${verdict.weightedRatio.toFixed(2)}x`
);
console.error(`[host-verdict] ${verdict.because}`);
console.error(`[host-verdict] VIABLE: ${verdict.viable ? 'yes' : 'no'}`);
for (const r of verdict.regressions) console.error(`[host-verdict]   regression: ${r}`);
for (const n of verdict.notes) console.error(`[host-verdict]   note: ${n}`);

const out = arg('out', '');
if (out !== '') {
	writeFileSync(out, JSON.stringify(report, null, 2));
	console.error(`[host-verdict] wrote ${out}`);
} else {
	console.log(JSON.stringify(report, null, 2));
}

process.exit(verdict.viable ? 0 : 1);
