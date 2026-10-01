import { deploymentReport } from './deployment';
import type { FrontContext } from './types';

/** The site's own health, plus every other site claimed on this deployment. */
export async function healthRoute(f: FrontContext): Promise<Response | undefined> {
	const { request, url, env, site, stubOf } = f;
	// the site's own health, plus every other site claimed on this deployment: a site that is
	// not primary is unreachable from an unmapped host, and this is where its owner sees it
	if (url.pathname === '/health' && request.method === 'GET' && !url.searchParams.has('clear')) {
		const probe = new URL(request.url);
		probe.pathname = '/__health';
		probe.searchParams.set('site', site);
		const res = await stubOf().fetch(new Request(probe, { headers: request.headers }));
		if (!res.ok) return res;
		const body = (await res.json()) as Record<string, unknown>;
		const report = await deploymentReport(env).catch(() => null);
		return Response.json(
			{
				...body,
				deployment: report && {
					...report.deployment,
					serving: site,
					otherSites: report.sites.filter((one) => one.site !== site)
				}
			},
			{ status: res.status }
		);
	}
	return undefined;
}

/** Runs the claim's two preparatory object invocations before the claim itself. */
export async function claimPhases(f: FrontContext): Promise<void> {
	const { request, url, site, stubOf } = f;
	// a claim is three invocations (a reset rolls one back whole): caches, install, claim; the
	// first two answers go unread since the claim repeats their idempotent repairs
	if (
		url.pathname === '/firstrun' &&
		request.method === 'POST' &&
		!url.searchParams.has('force') &&
		!url.searchParams.has('pass')
	) {
		for (const phase of ['warm', 'consistency']) {
			const prepare = new URL(request.url);
			prepare.pathname = '/__firstrun';
			prepare.search = '';
			prepare.searchParams.set('site', site);
			prepare.searchParams.set('phase', phase);
			await stubOf()
				.fetch(new Request(prepare, { method: 'POST', body: '{}' }))
				.then((res) => res.body?.cancel())
				.catch(() => undefined);
		}
	}
}
