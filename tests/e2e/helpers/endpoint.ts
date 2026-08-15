/**
 * The reachability gate for the e2e lane, modelled on `mantle2`'s `E2ETestBase`.
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
 * Deliberately does NOT require a 200: an un-migrated worker answers 503 or 404 and is still
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
 * Resolves to whether the suite should skip itself.
 *
 * Throws instead of returning when `CI` is set, so a CI run cannot pass by skipping.
 */
export async function e2eGate(): Promise<boolean> {
	if (await endpointReachable()) return false;
	if (process.env.CI) {
		throw new Error(
			`e2e: no worker reachable at ${ENDPOINT} (required in CI). ` +
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
