/**
 * The reachability gate for the e2e lane, modelled on a Drupal project's `E2ETestBase`.
 *
 * The rule worth copying from there is the asymmetry: **skip locally, fail in CI.** A developer
 * without a worker running should not see red, but a CI run that quietly skipped the whole lane
 * is indistinguishable from one that passed, and that is how a lane stops running for months
 * without anyone noticing.
 */

/** where the worker under test is; `bun run dev` serves here by default */
export const ENDPOINT = (process.env.CFW_E2E_ENDPOINT ?? 'http://127.0.0.1:8787').replace(
	/\/+$/,
	''
);

/** the site name the specs migrate into and render from */
export const SITE = process.env.CFW_E2E_SITE ?? 'e2e';

/**
 * Whether the endpoint answers at all.
 *
 * Does NOT require a 200: an un-migrated worker answers 503 or 404 and is still
 * reachable, and telling those apart is the specs' job rather than the gate's.
 */
export async function endpointReachable(timeoutMs = 3000): Promise<boolean> {
	try {
		// `/stats` is the cheapest real route; it is aliased to `/__stats` and does not boot PHP
		const res = await fetch(`${ENDPOINT}/stats?site=${encodeURIComponent(SITE)}`, {
			signal: AbortSignal.timeout(timeoutMs)
		});
		// any HTTP answer proves something is listening
		return res.status > 0;
	} catch {
		return false;
	}
}

/**
 * How long the gate waits for the endpoint before deciding it is absent.
 *
 * A SINGLE PROBE TURNED ONE DURABLE OBJECT RESET INTO A WHOLE RED LANE. Measured on `wrangler dev`:
 * the object resets under memory pressure, the proxy worker's in-flight fetch rejects with an Error
 * carrying no name, message or stack, and wrangler's ProxyController treats that as fatal and exits
 * the process -- while the worker itself is still serving, which `/stats` answering straight
 * afterwards proves. With the session supervised, the gap is a restart rather than an absence, and a
 * probe that gives up after 3 s reports every remaining spec as "no worker reachable" instead of
 * naming the one that failed.
 */
export const GATE_WAIT_MS = Number(process.env.CFW_E2E_GATE_WAIT_MS ?? 90_000);

/**
 * Resolves to whether the suite should skip itself.
 *
 * Throws instead of returning when `CI` is set, so a CI run cannot pass by skipping.
 */
export async function e2eGate(): Promise<boolean> {
	// the wait is for CI, where a missing worker is a failure worth being patient about. On a laptop
	// with no worker running the answer is "skip", and waiting 90 s to say so helps nobody
	const until = Date.now() + (process.env.CI ? GATE_WAIT_MS : 0);
	for (;;) {
		if (await endpointReachable()) return false;
		if (Date.now() >= until) break;
		await new Promise((r) => setTimeout(r, 2000));
	}
	if (process.env.CI) {
		throw new Error(
			`e2e: no worker reachable at ${ENDPOINT} after ${GATE_WAIT_MS} ms (required in CI). ` +
				`Start one with \`bun run dev\`, or point CFW_E2E_ENDPOINT at a deployed worker.`
		);
	}
	return true;
}

/** GET a path on the worker under test, following the site convention the routes use */
export function serve(path: string, params: Record<string, string> = {}): Promise<Response> {
	const url = new URL(`${ENDPOINT}/serve`);
	url.searchParams.set('site', SITE);
	url.searchParams.set('path', path);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return fetch(url, { signal: AbortSignal.timeout(45000) });
}
