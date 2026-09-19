/**
 * The replica scaling curve, driven INTERLEAVED across arms rather than ascending on one pool.
 *
 * **Why not one pool grown step by step.** A pool only grows: `replicas` is
 * `max(replicaCount(env), believedLanes(site))`, so once a site has provisioned N lanes the router
 * cannot be asked to use fewer. An ascending sweep is therefore the only shape a one-pool rig can
 * take, and it is the shape that cannot separate a scaling limit from a time-dependent decay in the
 * thing being scaled -- the error behind this project's superseded `5.72x at 8`. Each arm here is a
 * pool of its own, so the order is free and every round samples every arm.
 *
 * **Why the paths are computed.** `affinityKey()` keys a session-carrying request on the path and
 * the router takes `hash(key) % (lanes + 1)`, so a fixed path list reaches whatever buckets it
 * happens to land in. `coveringSpread()` picks one path per bucket and the run refuses if any
 * bucket would receive no load, because idle lanes read exactly like a pool that will not scale.
 *
 * Offered load is held constant PER LANE, so the curve measures the pool rather than the generator.
 * Wall clock is legal here: the narrowed rule permits a `Date.now()` delta spanning I/O, which is
 * what an HTTP round trip is.
 *
 * Deploy the arms with `EDGE_PLAN=0`, or the compiled-plan tier answers from the front worker's
 * isolate and the request never reaches an object at all -- measured at 2,569 of 2,643 samples.
 *
 *   bun scripts/measure/lane-sweep.ts --workers=1@a.workers.dev,32@b.workers.dev --rounds=3
 */

import { coveringSpread } from './v101-arms';

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
const ROUNDS = Number(a['rounds'] ?? 3);
const SECONDS = Number(a['seconds'] ?? 10);
const PER_LANE = Number(a['perLane'] ?? 6);
const PASS = a['pass'] ?? 'cfw-Measure-2260';

/**
 * One WORKER per arm, not one site.
 *
 * `REPLICA_COUNT` is a worker-level var and `chooseTarget()` takes `max(it, believedLanes)`, so six
 * pools behind one worker cannot each be told their own size: a single value is wrong for five of
 * them, and routing a 4-lane site over 33 buckets sends most requests to objects that do not exist.
 * Leaving it unset is worse -- the spread then rests on `believedLanes()`, a per-isolate memo with a
 * 60 s trust window that a fresh isolate has not learned, so a burst lands on the primary. Measured
 * that way a 32-lane arm answered `{primary: 396}` with half the requests erroring.
 *
 * A worker per arm makes `REPLICA_COUNT` exact and deterministic from the first request in any
 * isolate, at the cost of one deploy each.
 */
const ARMS: { base: string; lanes: number }[] = (a['workers'] ?? '')
	.split(',')
	.filter((s) => s !== '')
	.map((pair) => {
		const [lanes, host] = pair.split('@');
		return { base: `https://${host}`, lanes: Number(lanes) };
	});

const SITE = a['site'] ?? 'm';

const url = (base: string, path: string, q: Record<string, string | number> = {}) => {
	const u = new URL(base + path);
	u.searchParams.set('site', SITE);
	for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
	return u.toString();
};

/** retried, because a primary still settling a freshly provisioned pool answers 500 intermittently */
async function signInRetrying(base: string, tries = 6): Promise<string> {
	for (let i = 0; i < tries; i++) {
		const jar = await signIn(base);
		if (jar !== '') return jar;
		await new Promise((r) => setTimeout(r, 3000));
	}
	return '';
}

async function signIn(base: string): Promise<string> {
	// MANUAL, because a successful login is a 303 and fetch follows it by default -- the redirect
	// carries the Set-Cookie and the hop after it answers 403, so a followed login reads as a
	// failed one and the drive falls back to anonymous, which never reaches a lane
	const res = await fetch(url(base, '/serve', { path: '/user/login' }), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: `name=admin&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`,
		redirect: 'manual',
		signal: AbortSignal.timeout(240_000)
	});
	const set = res.headers.getSetCookie?.() ?? [];
	const line = set.find((l) => /^S?SESS/.test(l));
	return line ? (line.split(';')[0] ?? '') : '';
}

const median = (xs: number[]): number => {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((x, y) => x - y);
	return s[Math.floor(s.length / 2)] ?? 0;
};

async function drive(
	base: string,
	lanes: number,
	cookie: string
): Promise<Record<string, unknown>> {
	const cover = coveringSpread(lanes, [
		'/',
		'/node',
		...Array.from({ length: 220 }, (_, i) => `/node/${i + 1}`)
	]);
	if (cover.missing.length > 0) {
		throw new Error(
			`${base}: spread covers ${cover.covered}/${cover.buckets}; ${cover.missing.length} lanes idle`
		);
	}
	const paths = cover.paths;
	const until = Date.now() + SECONDS * 1000;
	let done = 0;
	let errors = 0;
	const lat: number[] = [];
	const answered = new Map<string, number>();
	const tiers = new Map<string, number>();
	const worker = async (slot: number) => {
		let i = slot;
		while (Date.now() < until) {
			// round-robin rather than random, so every lane gets the same offered count
			const path = paths[i % paths.length] as string;
			i += 1;
			const t0 = Date.now();
			try {
				const r = await fetch(url(base, '/serve', { path, edge: 0 }), {
					headers: { cookie },
					signal: AbortSignal.timeout(60_000)
				});
				await r.arrayBuffer();
				lat.push(Date.now() - t0);
				if (r.status !== 200) errors++;
				const who = r.headers.get('x-cfw-replica') ?? 'primary';
				answered.set(who, (answered.get(who) ?? 0) + 1);
				const t = r.headers.get('x-cfw-cache') ?? 'none';
				tiers.set(t, (tiers.get(t) ?? 0) + 1);
			} catch {
				errors++;
			}
			done++;
		}
	};
	const t0 = Date.now();
	await Promise.all(Array.from({ length: PER_LANE * (lanes + 1) }, (_, slot) => worker(slot)));
	const elapsed = (Date.now() - t0) / 1000;
	return {
		base,
		lanes,
		requests: done,
		errors,
		reqPerSec: Number((done / elapsed).toFixed(2)),
		p50: median(lat),
		objects: answered.size,
		answeredBy: Object.fromEntries(answered),
		tiers: Object.fromEntries(tiers)
	};
}

if (import.meta.main) {
	if (ARMS.length === 0) {
		console.error('--workers=<lanes>@<host>,<lanes>@<host>,... is required');
		process.exit(1);
	}
	const jars = new Map<string, string>();
	for (const arm of ARMS) jars.set(arm.base, await signInRetrying(arm.base));
	for (const arm of ARMS) {
		if ((jars.get(arm.base) ?? '') === '') {
			console.error(`${arm.base}: no session, an anonymous drive never reaches a lane`);
			process.exit(1);
		}
	}

	// ROUND 0 IS DISCARDED. Every lane is its own Durable Object and a freshly provisioned one has
	// no interpreter, so the first drive of each arm prices a cold boot per lane rather than the
	// pool. It is run rather than skipped because the boots have to happen somewhere.
	const results: Record<string, unknown>[] = [];
	for (let round = 0; round < ROUNDS + 1; round++) {
		// rotate the order every round so no arm is always first or always last
		const order = ARMS.map((_, i) => ARMS[(i + round) % ARMS.length]!);
		for (const arm of order) {
			const out = await drive(arm.base, arm.lanes, jars.get(arm.base) ?? '');
			results.push({ round, ...out });
			console.log(JSON.stringify({ round, ...out }));
		}
	}

	// the curve, taken as the median across rounds so one slow round cannot set it
	const byLanes = new Map<number, number[]>();
	const objectsSeen = new Map<number, number>();
	const errorsSeen = new Map<number, number>();
	for (const r of results) {
		if (Number(r['round']) === 0) continue;
		const l = Number(r['lanes']);
		byLanes.set(l, [...(byLanes.get(l) ?? []), Number(r['reqPerSec'])]);
		objectsSeen.set(l, Math.max(objectsSeen.get(l) ?? 0, Number(r['objects'])));
		errorsSeen.set(l, (errorsSeen.get(l) ?? 0) + Number(r['errors']));
	}
	const base = median(byLanes.get(1) ?? [0]);
	console.log('\nlanes  req/s   vs 1 lane  efficiency  objects  errors');
	for (const [lanes, xs] of [...byLanes.entries()].sort((x, y) => x[0] - y[0])) {
		const rps = median(xs);
		const ratio = base > 0 ? rps / base : 0;
		const eff = lanes > 0 ? (ratio / lanes) * 100 : 0;
		const objects = objectsSeen.get(lanes) ?? 0;
		console.log(
			`${String(lanes).padStart(5)}  ${rps.toFixed(1).padStart(6)}  ${ratio.toFixed(2).padStart(8)}x  ${eff.toFixed(0).padStart(9)}%  ${String(objects).padStart(7)}  ${String(errorsSeen.get(lanes) ?? 0).padStart(6)}`
		);
	}

	// AN ARM THAT DID NOT REACH ITS WHOLE POOL HAS NOT MEASURED IT. Every defect this rig has had
	// presents the same way -- lanes that received no load, reported as a pool that will not scale.
	const short = [...objectsSeen.entries()].filter(([lanes, seen]) => seen < lanes + 1);
	if (short.length > 0) {
		console.error(
			'\nUNUSABLE: ' +
				short
					.map(([l, seen]) => `${l} lanes reached ${seen} of ${l + 1} objects`)
					.join('; ')
		);
		process.exit(1);
	}
}
