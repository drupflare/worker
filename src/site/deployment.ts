import {
	censusOf,
	choosePrimary,
	type DeploymentSites,
	emptyCensus,
	readDeployment,
	resetDeploymentMemo,
	type SiteCensus
} from '../ops/deployment-site';
import {
	canWriteKv,
	KV_OVERRIDABLE,
	LEVER_DOMAINS,
	resolvePlan,
	resolveSettings,
	writePlan,
	writeSettings
} from '../ops/plan';
import { siteStubOptions } from '../ops/site-id';
import { jsonError } from '../util/reply';
import type { Stamped } from '../util/types';
import { siteFor } from './owner';
import type { SiteWorkerEnv } from './types';

const originMemo = new Map<string, Stamped<string | undefined>>();
const ORIGIN_MEMO_MS = 60_000;

/**
 * The origin a site renders against, or undefined when it has none of its own yet (the fallback) or
 * the object could not say. Asked once a minute per isolate, and only for alias traffic.
 */
export async function canonicalOriginOf(
	env: SiteWorkerEnv,
	site: string
): Promise<string | undefined> {
	const now = Date.now();
	const memo = originMemo.get(site);
	if (memo && now - memo.at < ORIGIN_MEMO_MS) return memo.value;
	let origin: string | undefined;
	try {
		const stub = env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env));
		const choice = (await (await stub.fetch('https://do.local/__origin')).json()) as {
			origin?: string;
			from?: string;
		};
		if (choice.from !== 'fallback' && typeof choice.origin === 'string') origin = choice.origin;
	} catch {
		// an alias answered with canonical links is the pre-alias behaviour, not an outage
	}
	if (originMemo.size > 64) originMemo.clear();
	originMemo.set(site, { at: now, value: origin });
	return origin;
}

/**
 * The deployment document: which sites are claimed here, which one is primary and what each holds.
 *
 * GET reports it with a live census of every claimed site. PUT `{"primary": "<site>"}` chooses the
 * primary, which no automatic choice overrides. The owner token is checked against the addressed
 * site, so an owner names their own with `?site=` and a token for it.
 */
export async function deploymentRoute(
	request: Request,
	url: URL,
	env: SiteWorkerEnv
): Promise<Response> {
	const kv = env.CONFIG_KV;
	if (!kv) {
		return jsonError('no CONFIG_KV binding, so there is no deployment document', 501);
	}
	if (request.method === 'PUT' || request.method === 'POST') {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return jsonError('the body is not JSON', 400);
		}
		const wanted = (body as { primary?: unknown } | null)?.primary;
		if (typeof wanted !== 'string' || wanted === '') {
			return jsonError('send {"primary": "<site id>"}', 400);
		}
		// the token proved ownership of the addressed site, so that is the only one it may promote
		const addressed = await siteFor(url, env);
		if (wanted !== addressed) {
			return jsonError(
				`the token was checked against ${addressed}; address the site you are promoting with ?site=${wanted}`,
				403
			);
		}
		const result = await choosePrimary(kv, wanted);
		return Response.json(result, { status: result.ok ? 200 : 409 });
	}
	if (request.method !== 'GET') {
		return jsonError('use GET or PUT', 405);
	}
	return Response.json({ ok: true, ...(await deploymentReport(env)) });
}

/** the document plus what every claimed site holds, which `/health` and GET `/deployment` report */
export async function deploymentReport(env: SiteWorkerEnv): Promise<{
	deployment: DeploymentSites;
	sites: SiteCensus[];
}> {
	resetDeploymentMemo();
	const deployment = await readDeployment(env.CONFIG_KV);
	const sites = await Promise.all(
		deployment.claimed.map((site) => censusOf(env.SITE, site).catch(() => emptyCensus(site)))
	);
	return { deployment, sites };
}

/**
 * Reads and writes the runtime levers.
 *
 * GET reports every allow-listed name with the value in force and its source (kv, var or default).
 * PUT merges a JSON object; `PLAN` is accepted only under its own top-level key, because it is a
 * different authorisation (it selects a limits profile whose quotas are account-wide, where every
 * name on `KV_OVERRIDABLE` has a worst case of a slow site). A binding with no `put` answers 501.
 */
export async function settingsRoute(
	request: Request,
	url: URL,
	env: SiteWorkerEnv
): Promise<Response> {
	// the site the owner credential was checked against, so a token for A cannot read or write B's
	// document (a deployment-wide one made one tenant's owner an operator for every tenant)
	const site = await siteFor(url, env);
	const kv = env.CONFIG_KV;
	if (!kv) {
		return jsonError('no CONFIG_KV binding, so there is nowhere to store an override', 501, {
			how: 'add the kv_namespaces binding in wrangler.jsonc; the deployed vars stay in force without it'
		});
	}

	const [plan, settings] = await Promise.all([
		resolvePlan(env, kv, Date.now(), site),
		resolveSettings(kv, Date.now(), site)
	]);
	const view = () => ({
		ok: true,
		plan,
		// every name, including the ones with no override, so a caller can render the whole surface
		// from one response rather than having to know the list
		levers: KV_OVERRIDABLE.map((name) => ({
			name,
			value: settings[name] ?? (env as unknown as Record<string, string>)[name] ?? null,
			source: settings[name] !== undefined ? 'kv' : name in env ? 'var' : 'default',
			domain: LEVER_DOMAINS[name]
		}))
	});

	if (request.method === 'GET') return Response.json(view());

	if (request.method !== 'PUT' && request.method !== 'POST') {
		return jsonError('use GET to read or PUT to write', 405);
	}

	if (!canWriteKv(kv)) {
		return jsonError('this CONFIG_KV binding is read-only', 501);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return jsonError('the body is not JSON', 400);
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return jsonError('the body must be a JSON object', 400);
	}

	const patch = body as Record<string, unknown>;
	const wantedPlan = patch['PLAN'] ?? patch['plan'];
	let planResult = plan;
	if (wantedPlan !== undefined) {
		const asked = String(wantedPlan ?? '').toLowerCase();
		if (asked !== '' && asked !== 'free' && asked !== 'paid') {
			return jsonError(`PLAN must be free, paid or empty; got ${asked}`, 400);
		}
		planResult = await writePlan(
			kv,
			asked === '' ? undefined : (asked as 'free' | 'paid'),
			site
		);
	}

	const { PLAN: _plan, plan: _lower, ...levers } = patch;
	const written = await writeSettings(kv, levers, site);
	return Response.json({ ok: true, plan: planResult, ...written });
}
