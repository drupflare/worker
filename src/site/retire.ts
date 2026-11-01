import type { DeploymentKv } from '../ops/deployment-site';
import {
	DEPLOYMENT_KEY,
	forgetClaimed,
	parseDeployment,
	unmappedSite
} from '../ops/deployment-site';
import { forgetSite } from '../ops/fleet';
import { sha256Hex } from '../ops/owner-recovery';
import { appendRetireLog, forgetHostMappings, type RetireKv } from '../ops/retire';
import { resetHostMemo, siteStubOptions } from '../ops/site-id';
import { jsonError } from '../util/reply';
import { ownerCredential, siteFor } from './owner';
import type { FrontEntry } from './types';

/**
 * `POST /retire?site=<id>` with `{"confirm": "<id>"}`: wipes one site's object, then forgets it.
 *
 * The audit entry is written to `CONFIG_KV` first, because the object's own audit ring is in the
 * storage the wipe removes. Authority is the target's own owner token, checked here and again in
 * the object. The one exception is an object the deployment never claimed, under `force=1`: it has
 * no token to present, so the deployment primary's owner token authorizes it, and the object
 * accepts that only while it holds no owner token of its own. The deployment primary is refused
 * whatever the caller holds.
 */
export async function retireRoute(f: FrontEntry): Promise<Response> {
	const { request, url, env } = f;
	const kv = env.CONFIG_KV as (RetireKv & DeploymentKv) | undefined;
	if (!kv || typeof kv.put !== 'function') {
		return jsonError('no writable CONFIG_KV binding, so there is no deployment to edit', 501);
	}
	const site = await siteFor(url, env);
	const force = url.searchParams.get('force') === '1';
	// the entry stage does not check this route, since its credential depends on the target
	const token = f.ownerToken ?? (await ownerCredential(request, env, url));
	const doc = parseDeployment(await kv.get(DEPLOYMENT_KEY));
	const claimed = doc.claimed.includes(site);
	const primary = unmappedSite(doc);
	let proof = token;
	let byPrimary = false;
	if (proof === undefined && force && !claimed && primary?.from === 'primary') {
		const asPrimary = new URL(url);
		asPrimary.searchParams.set('site', primary.site);
		proof = await ownerCredential(request, env, asPrimary);
		byPrimary = proof !== undefined;
	}
	if (proof === undefined) {
		return new Response('owner token required\n', {
			status: 401,
			headers: {
				'www-authenticate': 'Bearer realm="drupflare"',
				'content-type': 'text/plain; charset=utf-8'
			}
		});
	}
	if (request.method !== 'POST') return jsonError('use POST', 405);

	let confirm: unknown;
	try {
		confirm = ((await request.json()) as { confirm?: unknown } | null)?.confirm;
	} catch {
		// the check below refuses a missing confirm
	}
	if (confirm !== site) {
		return jsonError(`send {"confirm": "${site}"} to retire ${site}`, 400);
	}
	if (primary?.from === 'primary' && primary.site === site) {
		return jsonError(
			`${site} is the primary of this deployment; choose another with PUT /deployment first`,
			409
		);
	}
	if (!claimed && !force) {
		return jsonError(
			`${site} is not a claimed site on this deployment; claimed: ${doc.claimed.join(', ') || 'none'}. ` +
				'add force=1 to retire an object the deployment never claimed',
			409
		);
	}

	const call = {
		at: Date.now(),
		route: `/retire?site=${site}`,
		method: 'POST',
		actor: `${byPrimary ? 'primary:' : ''}${(await sha256Hex(proof)).slice(0, 8)}`
	};
	const entry = await appendRetireLog(kv as never, { ...call, status: 200 });

	const inner = new URL(url.origin);
	inner.pathname = '/__retire';
	if (force) inner.searchParams.set('force', '1');
	const stub = env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env));
	const res = await stub.fetch(
		new Request(inner, {
			method: 'POST',
			headers: byPrimary
				? { 'x-cfw-retire-by': 'primary' }
				: { authorization: `Bearer ${proof}` },
			body: JSON.stringify({ confirm: site })
		})
	);
	if (res.status !== 200) {
		await appendRetireLog(kv as never, { ...call, status: res.status });
		return res;
	}
	const wiped = (await res.json()) as Record<string, unknown>;

	// the object is gone; each of these only stops something finding it, so a failure is reported
	const warnings: string[] = [];
	const attempt = async <T>(what: string, work: () => Promise<T>): Promise<T | undefined> => {
		try {
			return await work();
		} catch (e) {
			warnings.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
			return undefined;
		}
	};
	const deployment = await attempt('deployment document', () => forgetClaimed(kv, site));
	const fleet = env.FLEET_DB
		? await attempt('fleet row', async () => {
				await forgetSite(env.FLEET_DB as NonNullable<typeof env.FLEET_DB>, site);
				return true;
			})
		: undefined;
	const hosts = await attempt('host mappings', () => forgetHostMappings(kv, site));
	resetHostMemo();
	return Response.json({
		ok: true,
		site,
		wiped,
		audit: { seq: entry.seq, hash: entry.hash },
		deployment: deployment ?? null,
		fleetRowDeleted: fleet ?? null,
		hostsRemoved: hosts ?? null,
		warnings
	});
}
