/**
 * A load generator that runs INSIDE Cloudflare, because a laptop is not one.
 *
 * Driving a 256-lane pool at constant per-lane load needs on the order of 1,500 concurrent HTTPS
 * connections doing real Drupal renders. One machine over a home connection is the bottleneck long
 * before the pool is, and this project has already recorded three load-generator errors that each
 * produced a confident wrong curve. Running the generator as a Worker puts it on Cloudflare's own
 * network: the laptop then holds one connection per SHARD rather than one per virtual client.
 *
 * A paid Worker allows 1,000 subrequests per invocation, so one invocation cannot drive a long run.
 * The caller therefore starts many shards, each a separate invocation with its own budget, and sums
 * what they report. `requests` is capped per shard for that reason and the cap is reported back, so
 * a run that ran out of subrequests is visible rather than silently short.
 *
 *   POST /drive  {target, cookie, paths[], concurrency, requests}
 */

export type DriveRequest = {
	/**
	 * The SERVICE BINDING name of the worker under test, e.g. `ARM_L032`.
	 *
	 * Not a URL: Cloudflare refuses a Worker subrequest to another `workers.dev` hostname on the
	 * same account with `error code: 1042`, measured at 8 of 8 requests. A service binding is the
	 * supported Worker-to-Worker path and still enters the target's own `fetch`, so the front
	 * worker's routing -- which is what a lane curve measures -- runs exactly as it does for a
	 * visitor.
	 */
	binding: string;
	/** the site query parameter every request carries */
	site: string;
	/**
	 * The arm's own `scheme://host`, which the object pins and renders against.
	 *
	 * Not cosmetic and not arbitrary: a lane that observes a host no visitor sends derives a
	 * different session cookie name and answers every authenticated request as uid 0.
	 */
	origin: string;
	/**
	 * Drive the path DIRECTLY instead of through drupflare's `/serve?site=&path=` route.
	 *
	 * A comparison arm that is not drupflare has no `/serve`: pointing this generator at the
	 * containerised VPS answered 3,854 requests with 404 because every one asked nginx for a route
	 * only the Worker has. Raw mode requests `${origin}${path}`, which is what any ordinary host
	 * serves.
	 */
	raw?: boolean;
	/** a session cookie; without one the request is anonymous and never reaches a lane */
	cookie: string;
	/** one path per lane bucket; the shard round-robins over them */
	paths: string[];
	/** virtual clients inside this shard */
	concurrency: number;
	/** subrequests this shard may spend, bounded by the platform's own per-invocation cap */
	requests: number;
	/**
	 * Wall-clock the shard may spend, which is what makes cells comparable.
	 *
	 * Sizing a drive by request COUNT is unusable against a Durable Object, because one object
	 * serves one request at a time: the same count that takes 24 s at 8 clients takes over two hours
	 * at 384, since the queue lengthens while the service rate does not. A duration bounds every cell
	 * to the same window and lets throughput fall out of it.
	 *
	 * `Date.now()` is usable here for the reason it is usable around `stub.fetch()`: the clock
	 * advances on I/O completion, and every iteration of this loop completes one.
	 */
	durationMs?: number;
	/**
	 * How long a client waits before giving up, in ms.
	 *
	 * IT HAS TO EXCEED p95 OR IT BECOMES THE MEASUREMENT. At 128 clients a 20 s cap discarded 152 of
	 * 256 requests as timeouts while the pool shed nothing, and throughput counts only completions --
	 * so the one cell where scaling would show read LOWER than the unsaturated cells below it.
	 */
	timeoutMs?: number;
};

export type DriveReply = {
	requests: number;
	errors: number;
	elapsedMs: number;
	/** latencies, so the caller can take a percentile over every shard rather than of means */
	latencies: number[];
	/** which object answered, by `x-cfw-replica` */
	answeredBy: Record<string, number>;
	tiers: Record<string, number>;
	/** true when the shard stopped because it ran out of its budget rather than out of time */
	exhausted: boolean;
	/** response status histogram, so a refused run says WHAT refused it rather than just failing */
	statuses: Record<string, number>;
	/** the first thrown error, if any; a swallowed throw is indistinguishable from a bad status */
	threw?: string;
	/** one sample body from a non-200, truncated; a 1042 or a challenge page says so in its body */
	sample?: string;
};

/** merges the shard replies of a fan-out into the shape one shard returns */
function mergeReplies(parts: DriveReply[], elapsedMs: number): DriveReply {
	const answeredBy = new Map<string, number>();
	const tiers = new Map<string, number>();
	const statuses = new Map<string, number>();
	let requests = 0;
	let errors = 0;
	let latencies: number[] = [];
	let exhausted = false;
	let threw: string | undefined;
	let sample: string | undefined;
	for (const p of parts) {
		requests += p.requests;
		errors += p.errors;
		latencies = latencies.concat(p.latencies);
		exhausted ||= p.exhausted;
		threw ??= p.threw;
		sample ??= p.sample;
		for (const [k, v] of Object.entries(p.answeredBy))
			answeredBy.set(k, (answeredBy.get(k) ?? 0) + v);
		for (const [k, v] of Object.entries(p.tiers)) tiers.set(k, (tiers.get(k) ?? 0) + v);
		for (const [k, v] of Object.entries(p.statuses ?? {}))
			statuses.set(k, (statuses.get(k) ?? 0) + v);
	}
	return {
		requests,
		errors,
		elapsedMs,
		latencies,
		answeredBy: Object.fromEntries(answeredBy),
		tiers: Object.fromEntries(tiers),
		exhausted,
		statuses: Object.fromEntries(statuses),
		...(threw === undefined ? {} : { threw }),
		...(sample === undefined ? {} : { sample })
	};
}

export default {
	async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/health') return new Response('ok');

		/**
		 * Splits one drive across several sub-invocations of this same Worker.
		 *
		 * A shard is one HTTP request the CALLER holds open, so fanning out from a laptop puts every
		 * shard back on the connection this Worker exists to replace -- measured, one shard sustains
		 * ~250 req/s against a no-work path and eight shards collapse to 15. Fanning out HERE keeps
		 * the caller at one connection however wide the drive gets, and each sub-invocation brings
		 * its own subrequest budget and its own concurrency.
		 */
		if (url.pathname === '/drive-fanout') {
			const spec = (await request.json()) as DriveRequest & { fanout?: number };
			const self = (env as Record<string, { fetch: typeof fetch } | undefined>).SELF;
			if (!self) return Response.json({ error: 'no SELF binding' }, { status: 400 });
			const n = Math.max(1, Math.min(Number(spec.fanout ?? 4), 64));
			const per = Math.max(1, Math.ceil(spec.requests / n));
			const t0 = Date.now();
			const parts = await Promise.all(
				Array.from({ length: n }, async (_, k) => {
					// Each sub-invocation starts at a different point in the path list, so the union
					// covers every bucket rather than n copies of the same prefix.
					//
					// THE OFFSET IS A FRACTION OF THE LIST, NOT `per`. Rotating by `k * per`
					// collapses whenever `per` shares a factor with the list length: at 900 requests
					// per shard over 200 paths, `900 % 200 = 100`, so 32 shards started at just TWO
					// offsets and a 128-lane pool answered from 7 objects. Spacing by
					// `length / n` gives each shard its own starting point by construction.
					const stride = Math.max(1, Math.floor(spec.paths.length / n));
					const at = (k * stride) % spec.paths.length;
					const rotated = spec.paths.slice(at).concat(spec.paths.slice(0, at));
					const res = await self.fetch('https://gen.invalid/drive', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ ...spec, paths: rotated, requests: per })
					});
					return (await res.json()) as DriveReply;
				})
			);
			return Response.json(mergeReplies(parts, Date.now() - t0));
		}

		if (url.pathname !== '/drive') return new Response('not found', { status: 404 });

		const spec = (await request.json()) as DriveRequest;
		const svc = (env as Record<string, { fetch: typeof fetch } | undefined>)[spec.binding];
		if (!svc) {
			return Response.json(
				{ error: `no service binding named ${spec.binding}` },
				{ status: 400 }
			);
		}
		// an empty list indexes to `undefined` and drives the literal path "undefined", which renders
		// a cheap 404 and reads as the pool serving very fast. Refuse rather than measure that
		if (!Array.isArray(spec.paths) || spec.paths.length === 0) {
			return Response.json({ error: 'no paths to drive' }, { status: 400 });
		}
		const budget = Math.max(1, Math.min(spec.requests, 900));
		const latencies: number[] = [];
		const answeredBy = new Map<string, number>();
		const tiers = new Map<string, number>();
		const statuses = new Map<string, number>();
		let spent = 0;
		let errors = 0;
		let threw: string | undefined;
		let sample: string | undefined;

		const t0 = Date.now();
		const deadline = spec.durationMs === undefined ? null : t0 + spec.durationMs;
		const client = async () => {
			for (;;) {
				// one shared budget, claimed before the request so shards cannot overspend
				if (spent >= budget) return;
				if (deadline !== null && Date.now() >= deadline) return;
				const ticket = spent;
				spent += 1;
				// THE TICKET IS THE PATH INDEX, so the clients of a shard between them walk the list in
				// order. Each client used to start at its own slot and step by one, so with a SHARED
				// budget the low indices were served many times over and the tail was never reached at
				// all: a 33-bucket pool driven this way answered from 23 objects, and a pool measured
				// over two thirds of itself reads as one that does not scale.
				const path = spec.paths[ticket % spec.paths.length] as string;
				const started = Date.now();
				try {
					// THE HOST IS NOT ARBITRARY, which this said for its whole life and which cost a
					// finding. A service binding accepts any host, so the URL was a placeholder --
					// but the object PINS the first origin it observes, and Drupal derives the
					// session cookie name from it. Every lane on a 32-lane pool pinned
					// `arm.invalid`, looked for a cookie no browser sends, and served every
					// authenticated request as uid 0. The generator has to present the arm's own
					// host, exactly as a visitor does
					const target = new URL(
						spec.raw === true ? `${spec.origin}${path}` : `${spec.origin}/serve`
					);
					if (spec.raw !== true) {
						target.searchParams.set('site', spec.site);
						target.searchParams.set('path', path);
						target.searchParams.set('edge', '0');
					}
					const res = await svc.fetch(target.toString(), {
						headers: { cookie: spec.cookie },
						redirect: 'manual',
						// BOUND THE DRAIN. The deadline stops new requests, but one already in
						// flight still has to finish, and against a saturated single object 384 of
						// those queue behind each other -- a 25 s cell then takes many minutes to
						// return
						signal: AbortSignal.timeout(Math.max(1_000, spec.timeoutMs ?? 60_000))
					});
					const body = await res.text();
					latencies.push(Date.now() - started);
					statuses.set(String(res.status), (statuses.get(String(res.status)) ?? 0) + 1);
					// a 3xx IS a served request: `/user/login` redirects an already-authenticated
					// session, so counting it as an error charged a quarter of every cell to failure
					// and understated throughput by the same amount
					if (res.status >= 400) {
						errors += 1;
						sample ??= body.slice(0, 300);
					}
					// `x-cfw-replica` names the object that ANSWERED; a lane that handed back reports
					// `primary` and names itself here, so the two together separate "the pool is
					// carrying traffic" from "the pool is refusing it"
					const who = res.headers.get('x-cfw-replica') ?? 'primary';
					answeredBy.set(who, (answeredBy.get(who) ?? 0) + 1);
					const over = res.headers.get('x-cfw-failover');
					if (over !== null)
						answeredBy.set(
							`failover:${over}`,
							(answeredBy.get(`failover:${over}`) ?? 0) + 1
						);
					const tier = res.headers.get('x-cfw-cache') ?? 'none';
					tiers.set(tier, (tiers.get(tier) ?? 0) + 1);
				} catch (e) {
					errors += 1;
					threw ??= String((e as Error)?.message ?? e);
				}
			}
		};

		await Promise.all(Array.from({ length: Math.max(1, spec.concurrency) }, () => client()));

		const reply: DriveReply = {
			requests: spent,
			errors,
			elapsedMs: Date.now() - t0,
			latencies,
			answeredBy: Object.fromEntries(answeredBy),
			tiers: Object.fromEntries(tiers),
			exhausted: spent >= budget,
			statuses: Object.fromEntries(statuses),
			...(threw === undefined ? {} : { threw }),
			...(sample === undefined ? {} : { sample })
		};
		return Response.json(reply);
	}
};
