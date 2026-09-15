/**
 * Does an authenticated request answer correctly when a replica lane serves it?
 *
 *   bun scripts/measure/session-on-lane.ts --pass=<admin password> [--workers=6] [--cycles=90]
 *
 * WHY THIS IS ITS OWN HARNESS. `measure:host` reported 4-5 errors per `auth-account` cell and a
 * hand-driven loop caught `RuntimeException: Failed to start the session.` once in ten -- and then
 * 120 consecutive requests on one session came back clean, twice, with and without two candidate
 * fixes. A rate that varies with warmth cannot decide anything, so this drives the variables the
 * ad-hoc loops held fixed.
 *
 * THREE AXES, because the first version of this harness held two of them fixed and read 0 in 40:
 *
 * - **SESSION AGE.** Each cycle logs in fresh and issues `depth` requests, so the early requests of
 *   a young session are sampled `cycles` times instead of once. A defect on session establishment
 *   concentrates at index 0-1 and a defect in steady state spreads flat.
 * - **CONCURRENCY.** `fetch()` on the object captures `refusalsBefore` and `forwardBefore` and
 *   compares them AFTER `route()` resolves, and a Durable Object interleaves awaits -- so two
 *   requests in flight read each other's counters. A serial loop cannot reach that state at all.
 * - **LANE LIFETIME.** `replicaRefusals` is an instance field capped at 20 by `shift()` and never
 *   cleared, so what a request observes depends on how many refusals that INCARNATION has already
 *   recorded. A run of 40 never gets near the cap; the reading is reported against a cumulative
 *   per-lane ordinal so a knee is visible rather than averaged away.
 *
 * AND IT PROVISIONS LANES TO COMPLETION. The first version issued ONE
 * `/replica?action=provision` per lane and counted `res.ok` as ready -- but a lane is copied one
 * bounded step per call, so a partial copy reported ready and the drive measured the primary
 * answering everything. Admission is asserted here, not assumed: a lane that does not reach
 * `SERVING`/`VERIFIED` aborts the run, and the distinct objects named by `x-cfw-replica` are
 * reported beside the result.
 */

import { login, setExtraHeaders } from './vps-compare';

const arg = (name: string, fallback: string): string =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const BASE = arg('base', 'http://127.0.0.1:8787');
const SITE = arg('site', 'bench2');
const PASS = arg('pass', '');
const CYCLES = Number(arg('cycles', '90'));
const DEPTH = Number(arg('depth', '6'));
const LANES = Number(arg('lanes', '3'));
const WORKERS = Number(arg('workers', '6'));
/**
 * One path by default, and that is the point rather than a limitation.
 *
 * `affinityKey()` keys a session-carrying request on the PATH, so a single path is a single lane --
 * which is what concentrates every refusal onto one object's ring instead of spreading them over
 * four and needing four times the samples to reach the cap.
 */
const PATHS = arg('paths', '/user').split(',');
/**
 * A per-request query parameter, because THE COMPILED PLAN ANSWERS IN THE FRONT WORKER AND NEVER
 * REACHES A LANE.
 *
 * Measured 2026-09-15: driving `/user` under one session, request 0 answered `x-cfw-cache: RENDER`
 * from `r3` and every request from 2 onward answered `x-cfw-cache: PLAN`, `x-cfw-plan: mem`,
 * `x-worker-ms: 0` and NO `x-cfw-replica` header at all -- the plan tier resolves in the front
 * worker's isolate with no Durable Object hop. A 600-request run had 429 of its samples answered
 * that way, so the pool was never asked and the reading was a statement about the plan memo.
 *
 * This is the same shape as the `MEM` reading that made an earlier replica curve read flat, and it
 * is the likeliest reason the first version of this harness read 0 in 40.
 *
 * `affinityKey()` splits the query off before hashing, so a varying parameter busts the plan without
 * moving the request off its lane -- verified: every busted request answered `RENDER` from `r3`.
 */
const BUST = arg('bust', '1') !== '0';

if (PASS === '') {
	console.error('usage: bun scripts/measure/session-on-lane.ts --pass=<admin password>');
	process.exit(1);
}

const host = `${SITE}.localhost`;
setExtraHeaders({ host });

type Hit = {
	cycle: number;
	index: number;
	path: string;
	status: number;
	replica: string;
	tier: string;
	error: string;
};

/** a lane is copied one bounded step per call, so it has to be driven to completion */
async function provisionLane(lane: number): Promise<string> {
	let stage = '';
	for (let step = 0; step < 60; step++) {
		const res = await fetch(`${BASE}/replica?action=provision&lane=${lane}&budget=4000`, {
			headers: { host }
		});
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		stage = String(body['stage'] ?? body['state'] ?? '');
		if (body['ok'] === false) break;
		if (body['done'] === true || stage === 'SERVING' || stage === 'VERIFIED') break;
	}
	return stage;
}

/** the message a failure carries, trimmed; a JSON error body and an HTML one both appear here */
function reasonOf(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: string };
		if (typeof parsed.error === 'string') return parsed.error;
	} catch {
		/* an HTML error page, handled below */
	}
	const match = /(RuntimeException|Exception|Error)[^<\n"]{0,120}/.exec(body);
	return match ? match[0] : body.slice(0, 80).replace(/\s+/g, ' ');
}

const stages: Record<string, string> = {};
for (let lane = 1; lane <= LANES; lane++) stages[`r${lane}`] = await provisionLane(lane);
const admitted = Object.values(stages).filter((s) => s === 'SERVING' || s === 'VERIFIED').length;
console.error(`[session-on-lane] lanes ${admitted}/${LANES} ${JSON.stringify(stages)}`);
if (LANES > 0 && admitted < LANES) {
	console.error('[session-on-lane] ABORT: a lane was never admitted, so the drive would measure');
	console.error('[session-on-lane] the primary answering everything. Check system.private_key.');
	process.exit(2);
}

const hits: Hit[] = [];

/**
 * One worker's share of the cycles.
 *
 * Each worker owns a disjoint slice rather than pulling from a shared counter: a shared counter is
 * the round-robin error `load-generator-discipline` records, which distributed unevenly and reported
 * a flat curve.
 */
async function worker(id: number): Promise<void> {
	for (let cycle = id; cycle < CYCLES; cycle += WORKERS) {
		// a transport failure is DATA, not a crash. The first version let one escape and lost a
		// 600-request run to a single timed-out login
		let cookie: string | null = null;
		try {
			cookie = await login(BASE, 'admin', PASS);
		} catch {
			cookie = null;
		}
		if (cookie === null) {
			console.error(`[session-on-lane] cycle ${cycle}: login failed`);
			continue;
		}
		for (let index = 0; index < DEPTH; index++) {
			const path = PATHS[index % PATHS.length] as string;
			const target = BUST
				? `${path}${path.includes('?') ? '&' : '?'}cb=${cycle}-${index}-${id}`
				: path;
			try {
				const res = await fetch(`${BASE}${target}`, {
					redirect: 'manual',
					headers: { host, cookie }
				});
				const body = res.status >= 400 ? await res.text() : '';
				hits.push({
					cycle,
					index,
					path,
					status: res.status,
					replica: res.headers.get('x-cfw-replica') ?? '?',
					tier: res.headers.get('x-cfw-cache') ?? '?',
					error: body === '' ? '' : reasonOf(body)
				});
			} catch (e) {
				hits.push({
					cycle,
					index,
					path,
					status: 0,
					replica: '?',
					tier: '?',
					error: `transport: ${(e as Error).message}`
				});
			}
		}
	}
}

await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));

const failures = hits.filter((h) => h.status >= 500);
const byIndex = Array.from({ length: DEPTH }, (_, i) => {
	const at = hits.filter((h) => h.index === i);
	return { index: i, n: at.length, failed: at.filter((h) => h.status >= 500).length };
});

/**
 * The reading that separates a rate from a cap.
 *
 * `hits` is in completion order, which is the order the lane saw them under concurrency. Bucketed in
 * twenties because the ring `replicaRefusals` keeps is twenty deep: a defect that is a RATE spreads
 * evenly across these buckets and one that is a CAP is empty until the ring fills and solid after.
 */
const BIN = 20;
const perLane: Record<string, Hit[]> = {};
for (const h of hits) (perLane[h.replica] ??= []).push(h);
const byLaneOrdinal: Record<string, Array<{ from: number; n: number; failed: number }>> = {};
for (const [lane, laneHits] of Object.entries(perLane)) {
	const bins: Array<{ from: number; n: number; failed: number }> = [];
	for (let at = 0; at < laneHits.length; at += BIN) {
		const slice = laneHits.slice(at, at + BIN);
		bins.push({
			from: at,
			n: slice.length,
			failed: slice.filter((h) => h.status >= 500).length
		});
	}
	byLaneOrdinal[lane] = bins;
}

const reasons: Record<string, number> = {};
for (const f of failures) reasons[f.error] = (reasons[f.error] ?? 0) + 1;
const objects: Record<string, number> = {};
for (const h of hits) objects[h.replica] = (objects[h.replica] ?? 0) + 1;
const statuses: Record<string, number> = {};
for (const h of hits) statuses[String(h.status)] = (statuses[String(h.status)] ?? 0) + 1;

console.log(
	JSON.stringify(
		{
			site: SITE,
			paths: PATHS,
			lanes: admitted,
			stages,
			workers: WORKERS,
			requests: hits.length,
			// THE SHARE THAT ACTUALLY REACHED A LANE, and a run where this is low measured the front
			// worker rather than the pool. Reported beside the rate because a denominator of 600 with
			// 171 lane hits in it is the error this harness exists to stop repeating
			onLane: hits.filter((h) => h.replica !== '?' && h.replica !== 'primary').length,
			offLane: hits.filter((h) => h.replica === '?').length,
			failed: failures.length,
			failureRate: hits.length === 0 ? 0 : failures.length / hits.length,
			statuses,
			// the reading that separates establishment from steady state
			byRequestIndex: byIndex,
			// the reading that separates a rate from the twenty-deep refusal ring
			byLaneOrdinal,
			reasons,
			objects,
			verdict: failures.length === 0 ? 'no failure reproduced' : 'reproduced'
		},
		null,
		1
	)
);
process.exit(failures.length === 0 ? 0 : 1);
