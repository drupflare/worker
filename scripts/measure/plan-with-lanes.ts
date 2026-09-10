/**
 * Does the plan tier compile when replica lanes exist?
 *
 *   bun scripts/measure/plan-with-lanes.ts --pass=<admin password> [--lanes=3] [--base=...]
 *
 * WHY THIS IS ITS OWN PROBE. `measure:host` answers it as a side effect of a full sweep, and that
 * sweep drives six workloads at several concurrencies through a single local workerd -- which times
 * out on a laptop that has been serving all night and tells you nothing about the question. This
 * asks the question directly: a dozen requests, no concurrency, no VPS arm.
 *
 * THE MECHANISM UNDER TEST. `compileFromSamples()` needs two samples for one path whose session
 * WITNESSES DIFFER, which is what stops a per-user string being frozen into a plan and served to a
 * whole role set. `affinityKey()` used to route a session-carrying request by its SESSION, so two
 * sessions hashed to two lanes by construction and no lane ever held the pair: measured at 0 lanes
 * the curve reached `PLAN:private` at request 4, and at 3 lanes it read `RENDER` for all eight.
 * Routing those requests by PATH puts every session for a path on one lane, and the compiled plan
 * reaches the others through `PAGE_KV`.
 *
 * The reading is the TIER SEQUENCE, not a latency. Latency on this rig is a property of the laptop;
 * which tier answered is not.
 *
 * ONE PATH IS A COIN FLIP, WHICH IS WHY THIS RUNS SEVERAL. Under the old rule two sessions still
 * collide on one lane with probability 1/lanes, so a single trial that compiles a plan says nothing.
 * Each path is its own trial -- the plan cache is keyed by path -- and the reading is the FRACTION
 * of trials that compiled.
 */

import { login, setExtraHeaders } from './vps-compare';

const arg = (name: string, fallback: string): string =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const BASE = arg('base', 'http://127.0.0.1:8787');
const SITE = arg('site', 'bench');
const PASS = arg('pass', '');
const LANES = Number(arg('lanes', '3'));
const PATHS = arg(
	'paths',
	'/,/user/1,/admin/content,/admin/reports/status,/node/1,/admin/structure,/admin/config,/admin/people'
).split(',');
const ROUNDS = Number(arg('rounds', '8'));

if (PASS === '') {
	console.error('usage: bun scripts/measure/plan-with-lanes.ts --pass=<admin password>');
	process.exit(1);
}

const host = `${SITE}.localhost`;
setExtraHeaders({ Host: host });

const call = (path: string, cookie?: string): Promise<Response> =>
	fetch(`${BASE}${path}`, {
		redirect: 'manual',
		headers: { Host: host, ...(cookie ? { cookie } : {}) }
	});

/** the tier a response reports, with the plan's own sub-tier when it carries one */
function tierOf(res: Response): string {
	const cache = res.headers.get('x-cfw-cache') ?? '';
	const plan = res.headers.get('x-cfw-plan') ?? '';
	return cache === 'PLAN' && plan !== '' ? `PLAN:${plan}` : cache || `${res.status}`;
}

async function provisionLanes(lanes: number): Promise<number> {
	let ready = 0;
	for (let lane = 1; lane <= lanes; lane++) {
		const res = await call(`/replica?action=provision&lane=${lane}`);
		if (res.ok) ready += 1;
	}
	// they converge on their own; the probe only needs them routable
	return ready;
}

const laneReport = LANES > 0 ? await provisionLanes(LANES) : 0;
console.error(`[plan-lanes] lanes requested ${LANES}, provisioned ${laneReport}`);

/**
 * A FRESH PAIR PER TRIAL, because one pair reused across every path is one draw, not eight.
 *
 * Under the session-keyed rule the pair's lanes are decided by the two cookies, so reusing them
 * fixes the outcome for the whole run: a pair that happens to collide compiles everywhere and a pair
 * that does not compiles nowhere. Measured while getting this wrong -- 5/8 compiled and all eight
 * trials reported the same single lane.
 */
async function sessionPair(): Promise<[string, string] | null> {
	const a = await login(BASE, 'admin', PASS);
	const b = await login(BASE, 'admin', PASS);
	if (a === null || b === null || a === b) return null;
	return [a, b];
}

const warmup = await sessionPair();
if (warmup === null) {
	console.error('[plan-lanes] could not open two distinct sessions; is --pass right?');
	process.exit(1);
}

type Trial = {
	path: string;
	tiers: string[];
	replicas: string[];
	compiled: boolean;
	firstPlanAtRequest: number | null;
};

const trials: Trial[] = [];
for (const path of PATHS) {
	const pair = await sessionPair();
	if (pair === null) {
		console.error(`[plan-lanes] could not open a session pair for ${path}`);
		process.exit(1);
	}
	const [a, b] = pair;
	const tiers: string[] = [];
	const replicas: string[] = [];
	for (let i = 0; i < ROUNDS; i++) {
		const res = await call(path, i % 2 === 0 ? a : b);
		tiers.push(tierOf(res));
		replicas.push(res.headers.get('x-cfw-replica') ?? '?');
	}
	const at = tiers.findIndex((t) => t.startsWith('PLAN'));
	trials.push({
		path,
		tiers,
		// WHICH OBJECT ANSWERED, captured because the reading is worthless without it: a rig that
		// drove the copy by hand left `lanes_provisioned` unwritten, so every request went to the
		// primary and the arm labelled `3 lanes` was the single-object arm
		replicas: [...new Set(replicas)],
		compiled: at >= 0,
		firstPlanAtRequest: at < 0 ? null : at + 1
	});
}

const compiled = trials.filter((t) => t.compiled).length;
const spread = [...new Set(trials.flatMap((t) => t.replicas))].sort();
console.log(
	JSON.stringify(
		{
			lanes: LANES,
			rounds: ROUNDS,
			trials,
			compiledTrials: `${compiled}/${trials.length}`,
			lanesObserved: spread,
			verdict:
				compiled === trials.length
					? 'the plan tier compiles on every path with lanes'
					: `the plan tier compiled on ${compiled} of ${trials.length} paths`
		},
		null,
		1
	)
);
process.exit(compiled === trials.length ? 0 : 1);
