/**
 * The generator's ceiling against the REAL arm, which is the control every pool reading needs.
 *
 * `fanout-probe.ts` established that a Worker sustains 512 concurrent subrequests, but it measured a
 * target that only slept. The arm under test is reached through a SERVICE BINDING into a front
 * worker that hops to a Durable Object, and nothing had measured what that path sustains -- so a
 * flat pool curve could not be attributed. This drives a route that reaches the object and returns
 * without rendering, so what it measures is the PATH rather than Drupal.
 *
 *   POST /ceiling  {binding, site, concurrency, durationMs, path}
 */

export type CeilingRequest = {
	binding: string;
	site: string;
	/** the arm's own `scheme://host`; the object pins it and renders against it */
	origin: string;
	concurrency: number;
	durationMs: number;
	/** a route that reaches the object and does no render; `/serve-stats` is the cheap one */
	path: string;
};

export default {
	async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/health') return new Response('ok');
		if (url.pathname !== '/ceiling') return new Response('not found', { status: 404 });

		const spec = (await request.json()) as CeilingRequest;
		const svc = (env as Record<string, { fetch: typeof fetch } | undefined>)[spec.binding];
		if (!svc) return Response.json({ error: `no binding ${spec.binding}` }, { status: 400 });

		const statuses = new Map<string, number>();
		const latencies: number[] = [];
		let done = 0;
		let threw: string | undefined;
		const t0 = Date.now();
		const deadline = t0 + Math.max(1_000, spec.durationMs);

		const client = async () => {
			while (Date.now() < deadline) {
				const started = Date.now();
				try {
					const res = await svc.fetch(
						// the arm's own host, never a placeholder: the object pins the first origin it
						// observes and Drupal keys the session cookie name on it
						`${spec.origin}${spec.path}?site=${encodeURIComponent(spec.site)}`,
						{ signal: AbortSignal.timeout(60_000) }
					);
					await res.text();
					latencies.push(Date.now() - started);
					statuses.set(String(res.status), (statuses.get(String(res.status)) ?? 0) + 1);
					done += 1;
				} catch (e) {
					threw ??= String((e as Error)?.message ?? e);
					statuses.set('threw', (statuses.get('threw') ?? 0) + 1);
				}
			}
		};

		await Promise.all(
			Array.from({ length: Math.max(1, Math.min(spec.concurrency, 512)) }, () => client())
		);
		const elapsedMs = Date.now() - t0;
		const sorted = [...latencies].sort((a, b) => a - b);
		return Response.json({
			concurrency: spec.concurrency,
			requests: done,
			elapsedMs,
			rps: Number(((done / elapsedMs) * 1000).toFixed(1)),
			p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
			statuses: Object.fromEntries(statuses),
			...(threw === undefined ? {} : { threw })
		});
	}
};
