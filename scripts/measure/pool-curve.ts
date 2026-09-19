/**
 * What a pool of N replica lanes actually serves, driven from inside Cloudflare.
 *
 * Every earlier attempt at this curve was bounded by its own generator. The reading it produced --
 * flat throughput at every pool size -- was attributed to the documented "6 simultaneous outgoing
 * connections per invocation"; `fanout-probe.ts` refutes that, measuring 512 concurrent subrequests
 * over a service binding completing in one service time. So the ceiling was the driver, and this
 * script is the driver rebuilt around what the platform actually allows.
 *
 * One arm worker hosts every arm. Lane count is a property of the SITE rather than of the worker:
 * the primary reports `lanes_provisioned` on `x-cfw-lanes` and `rememberLanes()` routes on what it
 * hears, so `p004` and `p064` on one deployment are two genuinely different pool sizes.
 *
 *   bun scripts/measure/pool-curve.ts --arm=https://cfw-pool.<sub>.workers.dev \
 *     --gen=https://cfw-gen.<sub>.workers.dev --lanes=0,4,16 --clients=8,32,128
 *
 * Read `objects` in the output before any rate: a pool reading taken without checking how many
 * distinct objects answered has measured the primary N times and called it scaling.
 */

import { coveringSpread } from './v101-arms.js';

type Reply = { status: number; text: string; json?: Record<string, unknown> };

const a = Object.fromEntries(
	process.argv
		.slice(2)
		.filter((x) => x.startsWith('--'))
		.map((x) => {
			const [k, v] = x.slice(2).split('=');
			return [k as string, v ?? '1'];
		})
);

const ARM = String(a.arm ?? '').replace(/\/+$/, '');
const GEN = String(a.gen ?? '').replace(/\/+$/, '');
const LANE_COUNTS = String(a.lanes ?? '0,4,16')
	.split(',')
	.map(Number);
const CLIENTS = String(a.clients ?? '8,32,128')
	.split(',')
	.map(Number);
const BINDING = String(a.binding ?? 'ARM');
const ADMIN_PASS = String(a.pass ?? 'cfw-Pool-7731-pass');
/**
 * Wall-clock per cell, which is the only sizing that works against a Durable Object.
 *
 * Sizing by request count stalled two attempts. One object serves one request at a time, so a fixed
 * count that takes 24 s at 8 clients takes hours at 384: the queue lengthens and the service rate
 * does not. A fixed window makes every cell comparable and lets throughput fall out of it.
 */
const WINDOW_MS = Number(a.window ?? 25_000);
/**
 * How long a client waits, and it must exceed the deepest queue the sweep creates.
 *
 * At 20 s this WAS the measurement: 152 of 256 requests at 128 clients were discarded as timeouts
 * while the pool shed nothing, and throughput counts completions only.
 */
const TIMEOUT_MS = Number(a.timeout ?? 90_000);
const SETUP_ONLY = a['setup-only'] === '1';
// a site name is a Durable Object name, so a re-run against the same one inherits whatever the last
// run left in `cfw_meta` -- including a `lanes_provisioned` autoscaling wrote before it was pinned
const TAG = String(a.tag ?? Date.now().toString(36).slice(-4));
/** warming passes before the window opens; each is one drive at two clients per path */
const WARM_ROUNDS = Number(a.warm ?? 4);
/**
 * Drive without a session.
 *
 * An authenticated request reaches a lane and is refused: the lane renders uid 0 even holding the
 * session row, so the handoff bounces it and the PRIMARY serves it. Measured by counter rather than
 * by header -- primary `serveRequests` +172 against lane r17 +0 on a 172-request drive. Anonymous
 * traffic has no such path: the same measurement reads primary +0, so this is the mode in which a
 * pool can be measured at all.
 */
const ANON = a.anon === '1';

if (!ARM || !GEN) {
	console.error('pass --arm=<worker url> and --gen=<loadgen url>');
	process.exit(1);
}

/**
 * The candidate paths, from which one per bucket is chosen.
 *
 * An authenticated request keys on the PATH, so the path list is the only thing that spreads a
 * session across a pool, and two things go wrong if it is used raw. A list of K paths reaches at
 * most K buckets, so eight paths leave nine of a 17-bucket pool's objects idle. And the paths that
 * do land distribute unevenly: these 40 put 5 paths on one bucket against an ideal of 2.4, so the
 * busiest lane takes twice its share and the pool reads like half its size.
 *
 * `coveringSpread()` picks exactly one path per bucket, which is the even distribution the router
 * would give a site whose URL space is large. These are pages a stock site renders with no content
 * seeded, so the arm needs no fixtures.
 */
const CANDIDATES = [
	'/',
	'/user/1',
	'/user/1/edit',
	'/admin',
	'/admin/content',
	'/admin/content/media',
	'/admin/structure',
	'/admin/structure/types',
	'/admin/structure/block',
	'/admin/structure/menu',
	'/admin/structure/taxonomy',
	'/admin/structure/display-modes',
	'/admin/appearance',
	'/admin/modules',
	'/admin/modules/uninstall',
	'/admin/config',
	'/admin/config/system/site-information',
	'/admin/config/system/cron',
	'/admin/config/content/formats',
	'/admin/config/development/performance',
	'/admin/config/development/logging',
	'/admin/config/media/image-styles',
	'/admin/config/media/file-system',
	'/admin/config/regional/settings',
	'/admin/config/regional/date-time',
	'/admin/config/search/pages',
	'/admin/config/user-interface/shortcut',
	'/admin/people',
	'/admin/people/permissions',
	'/admin/people/roles',
	'/admin/people/create',
	'/admin/reports',
	'/admin/reports/status',
	'/admin/reports/dblog',
	'/admin/reports/fields',
	'/node/add',
	'/admin/help',
	'/admin/structure/menu/manage/admin',
	'/admin/config/people/accounts',
	'/admin/config/search/settings'
];

async function get(path: string, timeoutMs = 240_000): Promise<Reply> {
	try {
		const res = await fetch(`${ARM}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
		const text = await res.text();
		let parsed: Record<string, unknown> | undefined;
		try {
			parsed = JSON.parse(text) as Record<string, unknown>;
		} catch {
			/* a serving page is HTML */
		}
		return { status: res.status, text, ...(parsed ? { json: parsed } : {}) };
	} catch (e) {
		return { status: 0, text: String((e as Error)?.message ?? e) };
	}
}

/** `/firstrun` refuses a password in a query string, correctly: a tail would log one */
async function claim(site: string): Promise<Reply> {
	const res = await fetch(`${ARM}/firstrun?site=${site}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			siteName: 'Pool curve',
			adminName: 'admin',
			adminMail: 'admin@example.invalid',
			adminPass: ADMIN_PASS,
			timezone: 'UTC'
		}),
		signal: AbortSignal.timeout(240_000)
	});
	return { status: res.status, text: await res.text() };
}

/**
 * A successful login is a 303 and `fetch` follows it by default.
 *
 * The redirect carries the `Set-Cookie` and the hop after it answers 403, so a followed login reads
 * as a failed one -- and every later request then drives ANONYMOUSLY, which keys on the address and
 * lands entirely on one lane.
 */
async function signIn(site: string): Promise<string> {
	const res = await fetch(`${ARM}/serve?site=${site}&path=${encodeURIComponent('/user/login')}`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: `name=admin&pass=${encodeURIComponent(ADMIN_PASS)}&form_id=user_login_form&op=Log+in`,
		redirect: 'manual',
		signal: AbortSignal.timeout(240_000)
	});
	const line = (res.headers.getSetCookie?.() ?? []).find((c) => /^S?SESS/.test(c));
	return line ? (line.split(';')[0] ?? '') : '';
}

type Cursor = { generation: number; index: number; offset: number };

/**
 * Copies one lane to completion, carrying the cursor.
 *
 * `provisionLane()` copies a bounded number of rows per invocation. A caller that drops the cursor
 * restarts at row 0 every time and never finishes; a budget high enough that the whole copy fits in
 * ONE invocation is what converges against a primary whose alarm chain keeps committing.
 */
async function provision(site: string, lane: number): Promise<boolean> {
	let cursor: Cursor | null = null;
	for (let i = 0; i < 40; i += 1) {
		const q = new URLSearchParams({
			site,
			action: 'provision',
			lane: String(lane),
			budget: '60000'
		});
		if (cursor) q.set('cursor', JSON.stringify(cursor));
		const out = (await get(`/replica?${q}`)).json ?? {};
		if (out['done'] === true) return true;
		if (out['ok'] === false) {
			cursor = null;
			continue;
		}
		cursor = (out['cursor'] as Cursor | undefined) ?? null;
		if (cursor === null) return true;
	}
	return false;
}

/** the validated candidate list, established once; every arm serves the same pack */
let validated: string[] | null = null;

/**
 * Keeps the candidates a stock install actually exposes.
 *
 * **ONLY A 404 DISQUALIFIES A PATH.** Dropping on any status at or above 400 destroyed a run: a
 * site fresh from provisioning sheds with 503 while it settles, so the second arm kept 1 of 40
 * candidates and the third kept 0. `coveringSpread()` then returned an empty list, the generator
 * drove one synthetic path, and throughput ROSE with lane count because the workload was getting
 * cheaper -- a clean-looking scaling curve made of nothing.
 *
 * Validated once and reused, because every arm is provisioned from the same pack, and validating
 * under load is what exposed the run to the shed in the first place.
 */
async function usablePaths(site: string, cookie: string): Promise<string[]> {
	if (validated !== null) return validated;
	const live: string[] = [];
	const refused: string[] = [];
	for (const path of CANDIDATES) {
		let verdict: 'serves' | 'absent' | 'unknown' = 'unknown';
		for (let attempt = 0; attempt < 3 && verdict === 'unknown'; attempt += 1) {
			const res = await fetch(
				`${ARM}/serve?site=${site}&path=${encodeURIComponent(path)}&edge=0`,
				{ headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(120_000) }
			).catch(() => null);
			if (res === null) continue;
			if (res.status === 404) verdict = 'absent';
			else if (res.status < 400) verdict = 'serves';
			else await new Promise((r) => setTimeout(r, 3000));
		}
		if (verdict === 'serves') live.push(path);
		else refused.push(path);
	}
	console.log(
		`  ${live.length}/${CANDIDATES.length} candidates serve (dropped ${refused.length})`
	);
	if (live.length < CANDIDATES.length / 2) {
		throw new Error(
			`only ${live.length} of ${CANDIDATES.length} candidates served; the site is shedding ` +
				`rather than missing routes, and a path list built now would measure the wrong workload`
		);
	}
	validated = live;
	return live;
}

/**
 * ONE path list for every arm, chosen to cover the LARGEST pool being measured.
 *
 * Choosing per arm makes the arms incomparable. `coveringSpread()` gives the 0-lane arm one path
 * and the 16-lane arm seventeen, and admin pages differ several-fold in cost -- two 0-lane runs
 * read 4.1 and 12.5 req/s at 8 clients purely because one drew `/admin/modules` and the other drew
 * a light page. Holding the workload fixed and letting only the pool size vary is the whole point
 * of the control.
 *
 * At the largest lane count this is one path per bucket. Smaller pools then spread the same paths
 * over fewer buckets, which is what a smaller pool does to real traffic.
 */
function fixedSpread(): string[] {
	const widest = Math.max(...LANE_COUNTS);
	const spread = coveringSpread(widest, validated ?? []);
	console.log(
		`  workload: ${spread.paths.length} paths, ` +
			`${spread.covered}/${spread.buckets} buckets at ${widest} lanes` +
			(spread.missing.length ? ` (missing ${spread.missing.join(',')})` : '')
	);
	if (spread.paths.length === 0) throw new Error('no paths cover any bucket');
	return spread.paths;
}

async function setup(site: string, lanes: number): Promise<string> {
	for (let i = 0; i < 200; i += 1) {
		const m = await get(`/migrate?site=${site}&all=1&prefill=1`);
		if (m.json?.['done'] === true || m.json?.['migrated'] === true) break;
		if (m.json?.['ok'] === false) throw new Error(`migrate refused: ${m.text.slice(0, 200)}`);
	}
	for (let i = 0; i < 60; i += 1) {
		if ((await get(`/serve?site=${site}&path=/&edge=0`)).status === 200) break;
		await new Promise((r) => setTimeout(r, 2000));
	}
	// ASSERT THE END STATE, never that the call was made. A claim that answered and did not take
	// leaves no admin account, so the sign-in below fails with `Unrecognized username or password`
	// and reads as a wrong password rather than as an unconfigured site
	let configured = false;
	for (let i = 0; i < 10 && !configured; i += 1) {
		await claim(site);
		configured = (await get(`/firstrun?site=${site}`)).json?.['configured'] === true;
		if (!configured) await new Promise((r) => setTimeout(r, 3000));
	}
	if (!configured) throw new Error(`${site}: /firstrun still reports configured false`);

	// a lane is refused admission until something mints `state:system.private_key`, and only a
	// render carrying a CSRF token does; a migrated-and-claimed site does not have one yet
	await get(`/serve?site=${site}&path=${encodeURIComponent('/user/login')}&edge=0`);

	/**
	 * SIGN IN BEFORE PROVISIONING, so the session is in the snapshot every lane copies.
	 *
	 * Provisioning first and signing in after produced `{"200":40,"403":556}` across five objects:
	 * the primary served and every lane denied, because the session row was written to the primary
	 * after the copy and reaches a lane only when replication catches up -- bounded by
	 * `DEFAULT_REPLICA_LAG_MS`, which is 30 s. A rig that measures inside that window measures the
	 * refusal.
	 */
	const cookie = await signIn(site);
	let ready = 0;
	for (let lane = 1; lane <= lanes; lane += 1) if (await provision(site, lane)) ready += 1;

	console.log(`  ${site}: ${ready}/${lanes} lanes, session ${cookie ? 'ok' : 'MISSING'}`);
	if (!cookie) throw new Error(`${site}: no session, every sample would drive anonymously`);
	if (ready < lanes) throw new Error(`${site}: only ${ready} of ${lanes} lanes provisioned`);
	return cookie;
}

type DriveReply = {
	requests: number;
	errors: number;
	elapsedMs: number;
	latencies: number[];
	answeredBy: Record<string, number>;
	tiers: Record<string, number>;
	statuses: Record<string, number>;
	exhausted: boolean;
	threw?: string;
};

async function drive(
	site: string,
	cookie: string,
	clients: number,
	paths: string[]
): Promise<DriveReply> {
	// one shard per 16 clients, so a shard's own subrequest budget of 900 is never the binding
	// constraint and no shard carries more clients than it can keep in flight
	const fanout = Math.max(1, Math.min(Math.ceil(clients / 16), 32));
	const res = await fetch(`${GEN}/drive-fanout`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			binding: BINDING,
			site,
			// the arm's real host, or every lane pins the generator's and serves uid 0
			origin: new URL(ARM).origin,
			cookie: ANON ? '' : cookie,
			paths,
			concurrency: Math.max(1, Math.ceil(clients / fanout)),
			requests: 900,
			durationMs: WINDOW_MS,
			timeoutMs: TIMEOUT_MS,
			fanout
		}),
		signal: AbortSignal.timeout(600_000)
	});
	return (await res.json()) as DriveReply;
}

const pct = (xs: number[], q: number) =>
	xs.length ? (([...xs].sort((x, y) => x - y)[Math.floor(xs.length * q)] ?? 0) as number) : 0;

const rows: Record<string, unknown>[] = [];
for (const lanes of LANE_COUNTS) {
	const site = `p${String(lanes).padStart(3, '0')}${TAG}`;
	console.log(`\n=== ${lanes} lanes (site ${site}) ===`);
	const cookie = await setup(site, lanes);
	await usablePaths(site, cookie);
	const paths = fixedSpread();
	if (SETUP_ONLY) continue;
	// every object in the pool boots PHP on its first render, so an unwarmed first cell measures
	// N cold boots. One client per path is what that needs; warming at the MAXIMUM concurrency
	// instead queues hundreds of requests on an object that has not booted yet, and the drain
	// afterwards took longer than every measured cell combined
	/**
	 * Warm until the pool STOPS refusing, rather than once.
	 *
	 * A lane admits an existing session only once replication has carried it, bounded by
	 * `DEFAULT_REPLICA_LAG_MS` at 30 s, and a 16-lane pool warmed immediately after provisioning
	 * still answered 13 of 106 with 403. Measuring inside that window measures the refusal; the
	 * settle is a property of the product, so it is waited out rather than subtracted.
	 */
	/**
	 * WARM EVERY LANE, not just once each.
	 *
	 * One pass per path leaves each lane rendering its page cold on every later request, and a bigger
	 * pool divides the warming traffic further -- so per-lane render cost rises roughly as fast as
	 * the pool widens and the curve reads flat. Measured that way a 21-object pool returned 5.1 req/s
	 * against one object's 4.1. Drupal's own render bins have to be hot on the object that will serve
	 * the page, which takes repeated passes, so the rig pays for them before the window opens.
	 */
	let warm = await drive(site, cookie, paths.length, paths);
	for (let i = 0; i < WARM_ROUNDS; i += 1) {
		warm = await drive(site, cookie, paths.length * 2, paths);
	}
	for (let i = 0; i < 4 && warm.requests - warm.errors < warm.requests * 0.98; i += 1) {
		await new Promise((r) => setTimeout(r, 20_000));
		warm = await drive(site, cookie, paths.length, paths);
	}

	/**
	 * THE WARMUP IS THE POOL CHECK, and a single request cannot be.
	 *
	 * `believedLanes()` is per-ISOLATE and set only after that isolate has seen the primary report
	 * `x-cfw-lanes`, so the first request any cold isolate makes routes to the primary whatever the
	 * pool size. Reading one response therefore says nothing: a 4-lane site answered `primary` on
	 * five consecutive requests and then `primary 13 / r2 1 / r3 1 / r4 5` over twenty. Counting
	 * distinct objects across a burst is the measurement; one sample is a coin toss.
	 */
	const reached = Object.keys(warm.answeredBy).length;
	console.log(`  warmup reached ${reached} object(s): ${JSON.stringify(warm.answeredBy)}`);
	if (lanes > 0 && reached < 2) {
		throw new Error(`${site}: ${lanes} lanes provisioned and only the primary answered`);
	}
	// A LANE THAT ANSWERS IS NOT A LANE THAT SERVES. Five objects answered a warmup in which 93% of
	// responses were 403, and the rate alone looked ordinary; only the status histogram said the
	// pool was denying rather than serving
	const served = warm.requests - warm.errors;
	if (served < warm.requests * 0.9) {
		throw new Error(
			`${site}: only ${served}/${warm.requests} warmup requests served: ` +
				JSON.stringify(warm.statuses)
		);
	}
	for (const clients of CLIENTS) {
		const r = await drive(site, cookie, clients, paths);
		// a 503 is the object SHEDDING, which is designed backpressure rather than a fault; it is
		// excluded from the rate and reported, because a pool that scales sheds less
		const shed = r.statuses['503'] ?? 0;
		const ok = r.requests - r.errors;
		const row = {
			lanes,
			clients,
			rps: Number(((ok / r.elapsedMs) * 1000).toFixed(1)),
			shed,
			p50: pct(r.latencies, 0.5),
			p95: pct(r.latencies, 0.95),
			requests: r.requests,
			errors: r.errors,
			// the guard against measuring the primary N times: a pool that scales answers from
			// lanes+1 distinct objects, and one that does not answers from one
			objects: Object.keys(r.answeredBy).length,
			// WHO ACTUALLY SERVED, not who was routed to. `x-cfw-replica` names the routing
			// decision, so a lane that refuses and fails over to the primary still appears here --
			// which is how a pool that served nothing read as 75% lane traffic
			primaryShare: Number(
				((r.answeredBy['primary'] ?? 0) / Math.max(1, r.requests)).toFixed(2)
			),
			// the tier is read on EVERY cell rather than where it is expected. A rate taken without
			// it cannot say whether the objects rendered or a shared tier answered before the hop
			tiers: r.tiers,
			exhausted: r.exhausted,
			...(r.threw ? { threw: r.threw } : {})
		};
		rows.push(row);
		console.log(`  ${JSON.stringify(row)}`);
		if (r.errors > 0) console.log(`    statuses ${JSON.stringify(r.statuses)}`);
	}
}

console.log(`\n${JSON.stringify(rows, null, 2)}`);
