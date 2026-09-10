import { writeFileSync } from 'node:fs';
import { type Cell, TRAFFIC_MIX, decide, ratio, withRtt } from './verdict-math';
import {
	type Sample,
	type Summary,
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
 * - The generator's own ceiling bounds every cell. It is measured first and printed, and a cell
 *   within 20% of it is reported as generator-bound rather than as a result.
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
 * The headers each arm needs; the edge arm names the site, the VPS has only one.
 *
 * `Host`, and the header this used first was DECORATIVE. `x-cfw-site` existed in this file and in
 * two sibling measurement scripts and in no file under `src/`: site identity is the hostname
 * (`src/ops/site-id.ts` resolves KV, then `SITE_ID`, then the host), so every `--site` ever passed
 * locally drove the single object `127.0.0.1` maps to. The tells were a never-used id answering
 * "already migrated" and two random ids reporting the same generation and the same 428 rows.
 */
const HEADERS = { vps: {}, edge: { host: `${SITE}.localhost` } } as const;

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
	return run(base, workload, concurrency, SECONDS, cookie);
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
const ceilings: Record<string, number> = {};
for (const [kind, base, path] of [
	['vps', VPS, '/core/misc/drupal.js'],
	['edge', EDGE, '/core/misc/drupal.js']
] as const) {
	setExtraHeaders(kind === 'edge' ? HEADERS.edge : HEADERS.vps);
	const probe = await one(`${base}${path}`, null);
	if (probe.status !== 200) {
		console.error(
			`[host-verdict] ${kind} answered ${probe.status} for the ceiling path ${path}; ` +
				'a ceiling taken against a non-200 measures the refusal'
		);
		process.exit(2);
	}
	const t0 = Date.now();
	let served = 0;
	while (Date.now() - t0 < 3000) {
		await Promise.all(Array.from({ length: 8 }, () => one(`${base}${path}`, null)));
		served += 8;
	}
	ceilings[kind] = served / ((Date.now() - t0) / 1000);
	console.error(`[host-verdict] ${kind} generator ceiling ${ceilings[kind].toFixed(1)} req/s`);
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

for (const path of ['/user/login', '/', '/admin/content', '/user']) {
	await fetch(`${EDGE}/fill?path=${encodeURIComponent(path)}`, { headers: HEADERS.edge });
	await fetch(`${EDGE}/fill`, { headers: HEADERS.edge });
}

console.error(`[host-verdict] logging in to both arms as ${USER}`);
setExtraHeaders(HEADERS.vps);
const vpsCookie = await login(VPS, USER, PASS);
setExtraHeaders(HEADERS.edge);
const edgeCookie = await login(EDGE, USER, PASS);
if (vpsCookie === null || edgeCookie === null) {
	console.error(
		`could not log in: vps=${vpsCookie === null ? 'failed' : 'ok'} ` +
			`edge=${edgeCookie === null ? 'failed' : 'ok'}. Is --pass right, and has ` +
			'`bun run measure:bench-site` provisioned the edge site?'
	);
	process.exit(2);
}

const notes: string[] = [];
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

// #region the matrix
const cells: Cell[] = [];
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
		const vps = await measureArm(VPS, 'vps', workload, concurrency, vpsCookie);
		const edge = await measureArm(EDGE, 'edge', workload, concurrency, edgeCookie);
		const bound =
			vps.rps > 0.8 * (ceilings.vps ?? Infinity) ||
			edge.rps > 0.8 * (ceilings.edge ?? Infinity);
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
if (RTT > 0) {
	notes.push(
		`the VPS arm carries a stated ${RTT} ms network round trip; the verdict itself is taken ` +
			'from rtt=0, which is the VPS at its best'
	);
}

const verdict = decide(cells, RTT, notes);
const weighted = verdict.weighted;

const report = {
	generatedBy: 'scripts/measure/host-verdict.ts',
	vps: VPS,
	edge: EDGE,
	seconds: SECONDS,
	rttMs: RTT,
	ceilings,
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
	`[host-verdict] weighted p50  vps=${weighted.vps.toFixed(1)}ms edge=${weighted.edge.toFixed(1)}ms`
);
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
