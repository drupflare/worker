import {
	censusOf,
	choosePrimary,
	type DeploymentSites,
	emptyCensus,
	readDeploymentState,
	resetDeploymentMemo,
	type SiteCensus
} from '../ops/deployment-site';
import { discoveryDocument, discoveryLimits } from '../ops/discovery';
import { sha256Hex } from '../ops/owner/recovery';
import {
	canWriteKv,
	KV_OVERRIDABLE,
	LEVER_DOMAINS,
	leverRefusal,
	type PlanKv,
	resetPlanMemo,
	resetSettingsMemo,
	resolvePlan,
	resolveSettings,
	writePlan,
	writeSettings
} from '../ops/plan';
import { siteStubOptions } from '../ops/site/id';
import { cmsOf } from '../util/cms';
import { jsonError } from '../util/reply';
import type { Stamped } from '../util/types';
import { bodyLimitFor } from './guards';
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
	degraded?: 'kv_read_failed' | 'kv_read_timeout';
}> {
	resetDeploymentMemo();
	const { value: deployment, degraded } = await readDeploymentState(env.CONFIG_KV);
	const sites = await Promise.all(
		deployment.claimed.map((site) => censusOf(env.SITE, site).catch(() => emptyCensus(site)))
	);
	return { deployment, sites, ...(degraded === undefined ? {} : { degraded }) };
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

	const read = () => settingsView(env, kv, site);
	const view = await read();
	const etag = await settingsEtag(view);

	if (request.method === 'GET') return Response.json(view, { headers: { etag } });

	if (request.method !== 'PUT' && request.method !== 'POST') {
		return jsonError('use GET to read or PUT to write', 405);
	}

	if (!canWriteKv(kv)) {
		return jsonError('this CONFIG_KV binding is read-only', 501);
	}

	const ifMatch = request.headers.get('if-match');
	if (ifMatch !== null && !etagMatches(ifMatch, etag)) {
		return jsonError('the settings changed since they were read', 412, {
			code: 'stale_settings',
			etag
		});
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
	// a window that does not parse would otherwise be dropped and read as unset, so say so up front
	const window = patch['WARM_WINDOW'];
	if (window !== undefined && window !== null && String(window).trim() !== '') {
		const reason = leverRefusal('WARM_WINDOW', window);
		if (reason !== undefined)
			return jsonError(reason, 400, { code: 'invalid_lever', name: 'WARM_WINDOW' });
	}
	const wantedPlan = patch['PLAN'] ?? patch['plan'];
	let planResult = view.plan;
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
	await recordSettingsWrite(request, url, env, site);
	const after = await settingsEtag(await read());
	return Response.json({ ok: true, plan: planResult, ...written }, { headers: { etag: after } });
}

/**
 * The plan and every lever with its value and source, read fresh. The memos are dropped first, so
 * the tag taken from it describes what is stored now.
 */
async function settingsView(env: SiteWorkerEnv, kv: PlanKv | undefined, site: string) {
	resetPlanMemo();
	resetSettingsMemo();
	const [plan, settings] = await Promise.all([
		resolvePlan(env, kv, Date.now(), site),
		resolveSettings(kv, Date.now(), site)
	]);
	return {
		ok: true,
		plan,
		// every name, including the ones with no override, so a caller can render the whole surface
		// from one response rather than having to know the list
		levers: KV_OVERRIDABLE.map((name) => ({
			name,
			value: settings[name] ?? (env as unknown as Record<string, string>)[name] ?? null,
			source: (settings[name] !== undefined ? 'kv' : name in env ? 'var' : 'default') as
				'kv' | 'var' | 'default',
			domain: LEVER_DOMAINS[name]
		}))
	};
}

/**
 * The discovery document: the settings, the callable routes and the limits, for the dashboard.
 * `GET` only, owner token only (checked before it reaches here), never cached. A CMS the document
 * has no kind for answers 404, which the dashboard reads as "this site publishes none".
 */
export async function discoveryRoute(
	request: Request,
	url: URL,
	env: SiteWorkerEnv
): Promise<Response> {
	if (cmsOf(env) !== 'drupal') return new Response('not found\n', { status: 404 });
	if (request.method !== 'GET') return jsonError('use GET', 405, { allow: 'GET' });
	const kv = env.CONFIG_KV;
	const view = await settingsView(env, kv, await siteFor(url, env));
	const upload = bodyLimitFor(
		new Request(url, { method: 'POST', headers: { 'content-type': 'multipart/form-data' } }),
		env
	);
	return Response.json(
		discoveryDocument({
			levers: view.levers,
			etag: await settingsEtag(view),
			releaseId: env.CF_VERSION_METADATA?.id || 'unknown',
			limits: discoveryLimits(upload),
			writable: kv !== undefined && canWriteKv(kv)
		}),
		{ headers: { 'cache-control': 'no-store' } }
	);
}

/** a strong tag over the plan and every lever with its value and source, as GET reports them */
async function settingsEtag(view: { plan: unknown; levers: unknown }): Promise<string> {
	const digest = await sha256Hex(JSON.stringify([view.plan, view.levers]));
	return `"${digest.slice(0, 32)}"`;
}

/** whether an If-Match list names the current tag; weak prefixes are ignored and `*` matches */
function etagMatches(header: string, current: string): boolean {
	return header
		.split(',')
		.map((tag) => tag.trim().replace(/^W\//, ''))
		.some((tag) => tag === '*' || tag === current);
}

/**
 * Notes a settings write in the object's owner audit log. The write lives in `CONFIG_KV`, which
 * the object cannot see, so the object learns of it from here; it checks the token itself, so a
 * note it did not authorize is refused. A failure here never fails the write.
 */
async function recordSettingsWrite(
	request: Request,
	url: URL,
	env: SiteWorkerEnv,
	site: string
): Promise<void> {
	const authorization = request.headers.get('authorization');
	if (!authorization) return;
	try {
		const inner = new URL(url.origin);
		inner.pathname = '/__audit';
		await env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env)).fetch(
			new Request(inner, {
				method: 'POST',
				headers: { authorization },
				body: JSON.stringify({ route: '/settings', status: 200 })
			})
		);
	} catch {
		// the write stands; an unreachable object has nothing to record it in
	}
}
