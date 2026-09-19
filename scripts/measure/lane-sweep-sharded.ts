/**
 * The replica scaling curve, driven from inside Cloudflare instead of from a laptop.
 *
 * A 256-lane pool at constant per-lane load needs on the order of 1,500 concurrent HTTPS
 * connections doing real Drupal renders, which is well past what one machine on a home connection
 * sustains -- and a generator that saturates before the pool does reads as a pool that will not
 * scale. `loadgen-worker.ts` runs the clients on Cloudflare's network; this script only starts
 * shards and sums what they report, so the laptop holds one connection per shard.
 *
 * **Every arm is normalised to a 1-lane control taken in the SAME batch.** Arms are built in
 * batches because 900-odd lanes cannot all exist at once, and a ratio against a control measured on
 * a different day is the drift this file exists to avoid.
 *
 * A shard is capped at 900 subrequests by the platform, and `exhausted` says when one stopped for
 * that reason rather than because the run ended -- a short shard is visible instead of quietly
 * lowering the arm's throughput.
 *
 *   bun scripts/measure/lane-sweep-sharded.ts \
 *     --gen=https://cfw-loadgen.example.workers.dev \
 *     --workers=1@cfw-l001.example.workers.dev,32@cfw-l032.example.workers.dev \
 *     --rounds=3
 */

import { coveringSpread, pathsForBucket } from './v101-arms';

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
const GEN = (a['gen'] ?? '').replace(/\/+$/, '');
const ROUNDS = Number(a['rounds'] ?? 3);
/** per-lane clients; `--perLane=auto` measures it instead, which is the default */
const PER_LANE_ARG = a['perLane'] ?? 'auto';
const PASS = a['pass'] ?? 'cfw-Measure-2260';
const SITE = a['site'] ?? 'm';
/** virtual clients per shard; the rest of the concurrency comes from running more shards */
// HIGH ON PURPOSE, so a drive uses as FEW shards as it can. Each shard is one HTTP request the
// laptop holds open, and fanning them out is what the in-Cloudflare generator was supposed to
// remove: measured against a no-work path, one shard sustains ~250 req/s while eight shards
// collapse to 15. Every arm this rig read at ~30 req/s regardless of pool size was reading that
// collapse rather than a pool.
const PER_SHARD = Number(a['perShard'] ?? 400);
/**
 * Sub-invocations the GENERATOR splits a shard into, so the caller still holds one connection.
 *
 * The rig's own ceiling is ~250 req/s from a single invocation, which bounds the pool it can
 * measure at roughly 19 objects. Past that the generator is the constraint and every arm reads the
 * same number, which looks exactly like a pool that stopped scaling.
 */
const FANOUT = Number(a['fanout'] ?? 1);
const SOLO = String(a['solo'] ?? '0') !== '0';
/** subrequests each shard may spend; the platform caps it at 900 */
const SHARD_REQUESTS = Number(a['shardRequests'] ?? 150);
/** the discarded pass that makes the timed one a measurement of serving rather than of booting */
const WARM_REQUESTS = Number(a['warmRequests'] ?? Math.max(24, Math.round(SHARD_REQUESTS / 2)));

/**
 * Each arm needs BOTH a URL and a service binding.
 *
 * The laptop signs in over the URL, which is one request. The load itself goes through a binding
 * because a Worker subrequest to another `workers.dev` host on the same account is refused with
 * `error code: 1042` -- measured at 8 of 8. The binding name is derived from the worker name so
 * there is one thing to keep in step rather than two.
 */
const ARMS: { base: string; binding: string; lanes: number }[] = (a['workers'] ?? '')
	.split(',')
	.filter((s) => s !== '')
	.map((pair) => {
		const [lanes, host] = pair.split('@');
		const name = (host ?? '').split('.')[0] ?? '';
		return {
			base: `https://${host}`,
			binding: `ARM_${name.replace(/^cfw-/, '').toUpperCase()}`,
			lanes: Number(lanes)
		};
	});

const median = (xs: number[]): number => {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((x, y) => x - y);
	return s[Math.floor(s.length / 2)] ?? 0;
};

async function signIn(base: string): Promise<string> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const u = new URL(`${base}/serve`);
		u.searchParams.set('site', SITE);
		u.searchParams.set('path', '/user/login');
		// manual: a successful login is a 303 and the Set-Cookie rides on it; following lands on a 403
		const res = await fetch(u.toString(), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: `name=admin&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`,
			redirect: 'manual',
			signal: AbortSignal.timeout(240_000)
		});
		const line = (res.headers.getSetCookie?.() ?? []).find((l) => /^S?SESS/.test(l));
		if (line) return line.split(';')[0] ?? '';
		await new Promise((r) => setTimeout(r, 3000));
	}
	return '';
}

type Shard = {
	requests: number;
	errors: number;
	elapsedMs: number;
	latencies: number[];
	answeredBy: Record<string, number>;
	tiers: Record<string, number>;
	exhausted: boolean;
	statuses?: Record<string, number>;
	sample?: string;
	threw?: string;
};

/**
 * The peak throughput one arm sustains, by ramping offered load to its own knee.
 *
 * **ONE FIXED LOAD CANNOT MEASURE EVERY POOL, and calibrating on the smallest arm was the same
 * mistake one level up.** Offered load has to scale with the pool, but the primary is not a peer of
 * its lanes: it serves bucket 0 AND feeds replication for all of them, so per-bucket-equal load
 * saturates it first. Measured at 4 clients per lane on a 48-lane pool, the platform answered
 * `Durable Object is overloaded. Requests queued for too long.` 91 times, while the same depth on a
 * 1-lane pool shed nothing.
 *
 * So each arm is ramped on its own and reported at its knee: the highest successful throughput
 * reached while shedding stays under {@link SHED_CEILING}. Past the knee a pool gets FASTER on paper
 * the more it drops, which is why the shed share bounds the search rather than latency.
 */
const SHED_CEILING = 0.05;
const DEPTHS = [1, 2, 4, 8];

async function rampArm(
	arm: { base: string; binding: string; lanes: number },
	cookie: string,
	requests: number
) {
	let best: Record<string, unknown> | null = null;
	for (const depth of DEPTHS) {
		// warmed at the same depth it is measured at, because a lane that hibernated between arms
		// pays a 1,264 ms boot on its first request and that lands inside the timed window
		await driveArm(
			arm.base,
			arm.binding,
			arm.lanes,
			cookie,
			depth,
			Math.max(20, requests >> 2)
		);
		const out = await driveArm(arm.base, arm.binding, arm.lanes, cookie, depth, requests);
		const shed = Number(out['shedShare']);
		const rps = Number(out['reqPerSec']);
		console.log(
			JSON.stringify({
				lanes: arm.lanes,
				depth,
				reqPerSec: rps,
				shedShare: shed,
				p50: out['p50'],
				objects: out['objects']
			})
		);
		if (shed > SHED_CEILING) break;
		if (best === null || rps > Number(best['reqPerSec'])) best = { ...out, depth };
	}
	return best;
}

/** the same ramp against ONE bucket, so the per-object figure is taken at its own knee too */
async function rampSolo(
	arm: { base: string; binding: string; lanes: number },
	cookie: string,
	requests: number
) {
	let best: Record<string, unknown> | null = null;
	for (const depth of DEPTHS) {
		await driveSolo(
			arm.base,
			arm.binding,
			arm.lanes,
			cookie,
			depth,
			Math.max(20, requests >> 2)
		);
		const out = await driveSolo(arm.base, arm.binding, arm.lanes, cookie, depth, requests);
		if (Number(out['shedShare']) > SHED_CEILING) break;
		if (best === null || Number(out['reqPerSec']) > Number(best['reqPerSec'])) {
			best = { ...out, depth };
		}
	}
	return best;
}

/** candidate paths, wide enough to cover any pool this rig builds */
/**
 * Candidate paths for one arm, bounded by the content it actually holds.
 *
 * **A PATH THAT 404s IS NOT A RENDER, and an unbounded list is full of them.** The node ids are
 * global to the candidate pool while each arm was built with its own node count, so a 2-node arm
 * driven over `/node/1..2200` answers 404 to almost everything -- cheap, fast, and counted. It read
 * as 100% shed on the solo drive, which took the per-object figure to zero and the topology ceiling
 * with it.
 */
function candidatesFor(nodes: number): string[] {
	return [
		'/',
		'/node',
		...Array.from({ length: Math.max(1, nodes) }, (_, i) => `/node/${i + 1}`)
	];
}

/** how many nodes an arm holds, so its candidate paths all resolve */
async function nodeCount(base: string): Promise<number> {
	const u = new URL(`${base}/sql`);
	u.searchParams.set('site', SITE);
	u.searchParams.set('q', 'SELECT COUNT(*) AS c FROM node');
	const res = await fetch(u, { signal: AbortSignal.timeout(60_000) });
	const body = (await res.json()) as { rows?: { c?: number }[] };
	return Number(body.rows?.[0]?.c ?? 0);
}

const CANDIDATES_BY_ARM = new Map<string, string[]>();
const candidates = (base: string): string[] => CANDIDATES_BY_ARM.get(base) ?? candidatesFor(2200);

/**
 * One lane's throughput in isolation, by driving only the paths that hash to its bucket.
 *
 * `solo x (lanes + 1)` is the ceiling the pool would reach with perfect distribution, so the routed
 * figure over that ceiling is what routing and replication actually cost. Without this the curve has
 * no denominator and "16 lanes is not 16x" has no attributable cause.
 */
async function driveSolo(
	base: string,
	binding: string,
	lanes: number,
	cookie: string,
	perLane: number,
	perShardRequests = SHARD_REQUESTS
) {
	const paths = pathsForBucket(lanes, 1, candidates(base), 24);
	if (paths.length === 0) throw new Error(`${base}: no path hashes to lane 1`);
	return driveWith(base, binding, lanes, cookie, perLane, paths, 1, perShardRequests);
}

async function driveArm(
	base: string,
	binding: string,
	lanes: number,
	cookie: string,
	perLane: number,
	perShardRequests = SHARD_REQUESTS
) {
	const cover = coveringSpread(lanes, candidates(base));
	if (cover.missing.length > 0) {
		throw new Error(
			`${base}: ${cover.missing.length} of ${cover.buckets} lanes would get no load`
		);
	}
	return driveWith(
		base,
		binding,
		lanes,
		cookie,
		perLane,
		cover.paths,
		lanes + 1,
		perShardRequests
	);
}

async function driveWith(
	base: string,
	binding: string,
	lanes: number,
	cookie: string,
	perLane: number,
	paths: string[],
	widthForLoad: number,
	perShardRequests = SHARD_REQUESTS
) {
	const cover = { paths };
	// load scales with how many objects the paths actually reach, so a solo run is not over-driven
	const clients = perLane * widthForLoad;
	const shards = Math.max(1, Math.ceil(clients / PER_SHARD));
	const perShard = Math.ceil(clients / shards);

	const t0 = Date.now();
	const replies = await Promise.all(
		Array.from({ length: shards }, async (_, n) => {
			const res = await fetch(`${GEN}${FANOUT > 1 ? '/drive-fanout' : '/drive'}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					binding,
					site: SITE,
					// the arm's real host, or every lane pins the generator's and serves uid 0
					origin: new URL(base).origin,
					cookie,
					// rotate the path offset per shard so shards do not all start on lane 0
					paths: cover.paths
						.slice(n % cover.paths.length)
						.concat(cover.paths.slice(0, n % cover.paths.length)),
					concurrency: perShard,
					requests: perShardRequests,
					...(FANOUT > 1 ? { fanout: FANOUT } : {})
				}),
				signal: AbortSignal.timeout(300_000)
			});
			if (!res.ok) throw new Error(`shard ${n}: generator answered ${res.status}`);
			return (await res.json()) as Shard;
		})
	);
	const elapsed = (Date.now() - t0) / 1000;

	const answeredBy = new Map<string, number>();
	const tiers = new Map<string, number>();
	// WITHOUT THIS AN ERROR COUNT IS A NUMBER WITH NO CAUSE. The generator has reported a status
	// histogram and a body sample since it was written and neither was aggregated here, so a run that
	// read `errors: 114` could not say whether that was a 503 warming, a 500, or a refusal.
	const statuses = new Map<string, number>();
	let requests = 0;
	let errors = 0;
	let latencies: number[] = [];
	let exhausted = 0;
	let sample: string | undefined;
	let threw: string | undefined;
	for (const s of replies) {
		requests += s.requests;
		errors += s.errors;
		latencies = latencies.concat(s.latencies);
		if (s.exhausted) exhausted += 1;
		sample ??= s.sample;
		threw ??= s.threw;
		for (const [k, v] of Object.entries(s.answeredBy))
			answeredBy.set(k, (answeredBy.get(k) ?? 0) + v);
		for (const [k, v] of Object.entries(s.tiers)) tiers.set(k, (tiers.get(k) ?? 0) + v);
		for (const [k, v] of Object.entries(s.statuses ?? {}))
			statuses.set(k, (statuses.get(k) ?? 0) + v);
	}
	// THROUGHPUT IS SUCCESSFUL RENDERS, NOT RESPONSES. Under concurrency the primary sheds with a
	// 503 -- it serves bucket 0 AND feeds replication for the whole pool -- and a shed is far cheaper
	// than a render, so counting it would report a pool as FASTER the more it failed. The shed rate is
	// the interesting half and is reported beside the rate rather than folded into it.
	const ok = statuses.get('200') ?? 0;
	return {
		base,
		lanes,
		shards,
		requests,
		errors,
		ok,
		shedShare: requests > 0 ? Number(((requests - ok) / requests).toFixed(3)) : 0,
		reqPerSec: Number((ok / elapsed).toFixed(2)),
		p50: median(latencies),
		objects: answeredBy.size,
		exhaustedShards: exhausted,
		answeredBy: Object.fromEntries(answeredBy),
		tiers: Object.fromEntries(tiers),
		statuses: Object.fromEntries(statuses),
		...(sample === undefined ? {} : { sample }),
		...(threw === undefined ? {} : { threw })
	};
}

if (import.meta.main) {
	if (GEN === '' || ARMS.length === 0) {
		console.error('--gen and --workers are required');
		process.exit(1);
	}
	// EVERY arm is signed in before any is driven, and every failure is reported together. Exiting
	// on the first one costs a whole run to learn about one arm, and the interesting case is which
	// SUBSET fails: four of twelve failing is a defect with a shape, one is a flake.
	const jars = new Map<string, string>();
	const unauthenticated: string[] = [];
	for (const arm of ARMS) {
		const jar = await signIn(arm.base);
		if (jar === '') unauthenticated.push(arm.base);
		else jars.set(arm.base, jar);
		const nodes = await nodeCount(arm.base).catch(() => 0);
		CANDIDATES_BY_ARM.set(arm.base, candidatesFor(nodes));
		const cover = coveringSpread(arm.lanes, candidatesFor(nodes));
		console.log(
			JSON.stringify({
				arm: arm.lanes,
				nodes,
				buckets: cover.buckets,
				missing: cover.missing.length
			})
		);
		if (cover.missing.length > 0) {
			console.error(
				`${arm.base}: ${nodes} nodes cover only ${cover.covered} of ${cover.buckets} buckets; ` +
					`the arm needs more content before it can be driven`
			);
			process.exit(1);
		}
	}
	if (unauthenticated.length > 0) {
		console.error(
			`no session on ${unauthenticated.length} of ${ARMS.length} arms; an anonymous drive ` +
				`never reaches a lane:\n  ${unauthenticated.join('\n  ')}`
		);
		process.exit(1);
	}

	// EACH ARM IS RAMPED TO ITS OWN KNEE rather than driven at one shared depth. The rotation still
	// interleaves, so anything that drifts during a run lands on every arm rather than on whichever
	// went last.
	const rows: Record<string, unknown>[] = [];
	for (let round = 1; round <= ROUNDS; round++) {
		const order = ARMS.map((_, i) => ARMS[(i + round) % ARMS.length]!);
		for (const arm of order) {
			const jar = jars.get(arm.base) ?? '';
			const out = await rampArm(arm, jar, SHARD_REQUESTS);
			// PER-OBJECT THROUGHPUT IS `routed / (lanes + 1)` and needs no separate drive. The solo
			// ramp doubled every arm's runtime and could not be trusted on a low-content arm anyway:
			// `pathsForBucket()` finds one or two paths there, so it repeats them and measures a warm
			// cache rather than a render. `--solo=1` brings it back where an arm has the content.
			const solo = SOLO ? await rampSolo(arm, jar, SHARD_REQUESTS) : null;
			if (out === null) {
				console.log(JSON.stringify({ round, lanes: arm.lanes, unreachable: true }));
				continue;
			}
			const row = {
				round,
				...out,
				soloReqPerSec: solo?.['reqPerSec'] ?? 0,
				soloDepth: solo?.['depth'] ?? null
			};
			rows.push(row);
			console.log(JSON.stringify(row));
		}
	}

	const byLanes = new Map<number, number[]>();
	const soloBy = new Map<number, number[]>();
	const depths = new Map<number, number>();
	const sheds = new Map<number, number>();
	const objects = new Map<number, number>();
	const errs = new Map<number, number>();
	const short = new Map<number, number>();
	for (const r of rows) {
		const l = Number(r['lanes']);
		byLanes.set(l, [...(byLanes.get(l) ?? []), Number(r['reqPerSec'])]);
		soloBy.set(l, [...(soloBy.get(l) ?? []), Number(r['soloReqPerSec'])]);
		objects.set(l, Math.max(objects.get(l) ?? 0, Number(r['objects'])));
		errs.set(l, (errs.get(l) ?? 0) + Number(r['errors']));
		short.set(l, (short.get(l) ?? 0) + Number(r['exhaustedShards']));
		depths.set(l, Math.max(depths.get(l) ?? 0, Number(r['depth'])));
		sheds.set(l, Math.max(sheds.get(l) ?? 0, Number(r['shedShare'])));
	}
	const base = median(byLanes.get(1) ?? [0]);
	// solo x (lanes+1) is the perfect-distribution ceiling; routed/ceiling is what routing costs
	console.log(
		'\nlanes  clients   routed    solo   ceiling  routed/ceiling  vs 1 lane  objects   shed'
	);
	for (const [lanes, xs] of [...byLanes.entries()].sort((x, y) => x[0] - y[0])) {
		const rps = median(xs);
		const solo = median(soloBy.get(lanes) ?? [0]);
		const ceiling = solo * (lanes + 1);
		const ratio = base > 0 ? rps / base : 0;
		const clients = (depths.get(lanes) ?? 0) * (lanes + 1);
		console.log(
			`${String(lanes).padStart(5)} ${String(clients).padStart(8)} ${rps.toFixed(1).padStart(8)} ` +
				`${solo.toFixed(1).padStart(7)} ${ceiling.toFixed(1).padStart(9)} ` +
				`${(ceiling > 0 ? (rps / ceiling) * 100 : 0).toFixed(0).padStart(14)}% ${ratio.toFixed(2).padStart(9)}x ` +
				`${String(objects.get(lanes) ?? 0).padStart(8)} ${((sheds.get(lanes) ?? 0) * 100).toFixed(1).padStart(6)}%`
		);
	}

	const under = [...objects.entries()].filter(([l, seen]) => seen < l + 1);
	if (under.length > 0) {
		console.error(
			'\nUNUSABLE: ' + under.map(([l, s]) => `${l} lanes reached ${s}/${l + 1}`).join('; ')
		);
		process.exit(1);
	}
}
