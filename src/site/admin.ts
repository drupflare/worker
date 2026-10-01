import {
	adminSessionCookie,
	clearedAdminCookie,
	clearOwnerFailures,
	noteOwnerFailure,
	ownerFailKey,
	ownerRefusedForNow,
	secureOrigin
} from '../ops/admin-session';
import { ensureFleetTable, fleetSummary, listSites, rolloutProgress } from '../ops/fleet';
import { callbackUri } from '../ops/oidc';
import { resolvePlan } from '../ops/plan';
import {
	type CfAccountStatus,
	LOGIN_PATH,
	LOGOUT_PATH,
	type OidcSetupRow,
	type OpsEntry,
	parseDrush,
	type RemoteRow,
	renderAccess,
	renderCommands,
	renderDeploy,
	renderExtend,
	renderGit,
	renderLogin,
	renderOperate,
	renderShell,
	renderThresholds,
	SURFACE_PREFIX
} from '../ui/admin';
import { errorMessage } from '../util/errors';
import { jsonError } from '../util/reply';
import { settingsRoute } from './deployment';
import type { SiteWorkerEnv } from './types';

/**
 * A `?next=` that can only send the browser back into this surface; anything else is discarded
 * (a sign-in page forwarding to an attacker's origin harvests what the operator types next).
 */
function safeNext(value: string | null): string | undefined {
	if (value === null || !value.startsWith(SURFACE_PREFIX)) return undefined;
	// `//evil.example` and `/\evil.example` are both origin-relative to a browser
	if (value.startsWith('//') || value.includes('\\')) return undefined;
	return value;
}

/** renders one product surface; kept out of `fetch` as the only branch that returns HTML */
export async function renderAdmin(
	request: Request,
	url: URL,
	env: SiteWorkerEnv,
	stub: { fetch: (input: RequestInfo | URL) => Promise<Response> },
	ownerToken?: string
): Promise<Response> {
	const html = (body: string, extra?: Record<string, string>, status = 200) =>
		new Response(body, {
			status,
			headers: {
				...extra,
				'content-type': 'text/html; charset=utf-8',
				// an admin page is per-operator and privileged; nothing may store it
				'cache-control': 'private, no-store',
				// `script-src` and `connect-src` are required (`default-src 'none'` blocks every
				// inline handler); no third-party origin anywhere
				'content-security-policy':
					"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
					"connect-src 'self'; form-action 'self'"
			}
		});

	// #region sign in and out, the two surface paths that take no credential
	const secure = secureOrigin(url);
	/** the object's `/__ownercheck` is the only judge; nothing here compares a token itself */
	if (url.pathname === LOGIN_PATH) {
		const next = safeNext(url.searchParams.get('next'));
		if (request.method !== 'POST') {
			return html(renderLogin(next, undefined));
		}
		const form = new URLSearchParams(await request.text());
		const presented = (form.get('token') ?? '').trim();
		const wanted = safeNext(form.get('next')) ?? SURFACE_PREFIX;
		if (presented === '') {
			return html(renderLogin(wanted, 'Enter the owner token.'), {}, 400);
		}
		// the same failure budget as `ownerCredential()`: `LOGIN_PATH` is public, so unbounded it
		// hit `/__ownercheck` per request (the risk is the object's request meter, not guessing)
		const failKey = ownerFailKey(request);
		const now = Date.now();
		if (ownerRefusedForNow(failKey, now)) {
			return html(renderLogin(wanted, 'Too many attempts. Wait a minute.'), {}, 429);
		}
		const inner = new URL(url);
		inner.pathname = '/__ownercheck';
		inner.search = '';
		const checked = await stub.fetch(
			new Request(inner, { headers: { authorization: `Bearer ${presented}` } })
		);
		if (checked.status !== 200) {
			noteOwnerFailure(failKey, now);
			return html(renderLogin(wanted, 'That is not the owner token for this site.'), {}, 401);
		}
		clearOwnerFailures(failKey);
		return new Response(null, {
			status: 303,
			headers: {
				location: wanted,
				'set-cookie': adminSessionCookie(presented, secure),
				'cache-control': 'no-store'
			}
		});
	}

	if (url.pathname === LOGOUT_PATH) {
		return new Response(null, {
			status: 303,
			headers: {
				location: LOGIN_PATH,
				'set-cookie': clearedAdminCookie(secure),
				'cache-control': 'no-store'
			}
		});
	}
	// #endregion

	/** where the object should be asked as the owner; every surface page has a token by now */
	const asOwner = (target: URL): Request =>
		new Request(
			target,
			ownerToken === undefined
				? undefined
				: { headers: { authorization: `Bearer ${ownerToken}` } }
		);

	if (url.pathname === `${SURFACE_PREFIX}/operate`) {
		// every control on this page drives an owner route directly from the browser, so there is
		// nothing to fetch here; the page IS the wiring that was missing
		return html(renderShell('operate', renderOperate(), env));
	}

	if (url.pathname === `${SURFACE_PREFIX}/deploy`) {
		// one status read, which is what makes Disconnect reachable
		let status: CfAccountStatus | undefined;
		try {
			const inner = new URL(url);
			inner.pathname = '/__cfoauth';
			inner.search = '?action=status';
			const res = await stub.fetch(asOwner(inner));
			const body = (await res.json()) as CfAccountStatus & { ok?: boolean };
			if (body?.ok !== false) status = body;
		} catch {
			// an unreadable status still renders the connect flow (no error banner)
			status = undefined;
		}
		// the OAuth return leg lands here with the outcome, because a JSON body was a dead end
		const notice = url.searchParams.has('connected')
			? 'Connected.'
			: (url.searchParams.get('error') ?? undefined);
		return html(renderShell('deploy', renderDeploy(status, notice), env));
	}

	if (url.pathname === `${SURFACE_PREFIX}/git`) {
		// the remotes live in the object, so this is the second page that reaches it
		const inner = new URL(url);
		inner.pathname = '/__git';
		inner.search = '?action=list';
		let remotes: RemoteRow[] = [];
		try {
			const reply = (await (await stub.fetch(asOwner(inner))).json()) as {
				remotes?: RemoteRow[];
			};
			remotes = Array.isArray(reply.remotes) ? reply.remotes : [];
		} catch {
			remotes = [];
		}
		return html(renderShell('git', renderGit(remotes, Date.now()), env));
	}

	if (url.pathname === `${SURFACE_PREFIX}/access`) {
		// read only from here; the write goes to `/setup/oidc`, which takes the owner token
		const inner = new URL(url);
		inner.pathname = '/__oidcsetup';
		inner.search = '?action=status';
		let row: OidcSetupRow = {
			issuer: '',
			clientId: '',
			secretPresent: false,
			redirectUri: callbackUri(url.origin)
		};
		try {
			row = {
				...row,
				...((await (await stub.fetch(asOwner(inner))).json()) as Partial<OidcSetupRow>)
			};
		} catch (e: unknown) {
			row.error = `the object did not answer: ${errorMessage(e).slice(0, 160)}`;
		}
		return html(renderShell('access', renderAccess(row), env));
	}

	if (url.pathname === `${SURFACE_PREFIX}/extend`) {
		const q = url.searchParams.get('q');
		if (!q)
			return html(renderShell('extend', renderExtend(undefined, [], undefined, env), env));
		// proxies to `/__installable` (catalog, packagist and oracle live there)
		const inner = new URL(url);
		inner.pathname = '/__installable';
		// the route reads `module`, not `name`; `InstallVerdict` names its field `version`
		inner.searchParams.set('module', q);
		let entries: Parameters<typeof renderExtend>[1] = [];
		let note: string | undefined;
		try {
			const res = await stub.fetch(asOwner(inner));
			const body = (await res.json()) as {
				name?: string;
				version?: string | null;
				verdict?: string | null;
				reason?: string | null;
				conflicts?: { reason?: string }[];
			};
			entries = [
				{
					name: body.name || q,
					version: body.version ?? undefined,
					verdict: (body.verdict ?? undefined) as never,
					reason:
						body.reason ??
						body.conflicts
							?.map((c) => c.reason)
							.filter(Boolean)
							.join('; ') ??
						undefined
				}
			];
		} catch (e: unknown) {
			// reported, not swallowed (a check that could not run is not an uninstallable module)
			note = `the installability check could not run: ${errorMessage(e).slice(0, 200)}`;
		}
		return html(renderShell('extend', renderExtend(q, entries, note, env), env));
	}

	if (url.pathname === `${SURFACE_PREFIX}/commands`) {
		const op = url.searchParams.get('op');
		const parsed = parseDrush(op ?? undefined);
		let result: string | undefined;
		const entries: OpsEntry[] = [];
		try {
			const inner = new URL(url);
			inner.pathname = '/__ops';
			// the registry always answers, so the table renders even when the typed command goes
			// somewhere else
			const res = await stub.fetch(asOwner(inner));
			// an object by name, not an array (`OpsRegistry::operations()` is string-keyed, so
			// `for...of` over it throws and the catch below empties `entries`)
			const body = (await res.json()) as {
				operations?: Record<
					string,
					{ label?: string; driver?: string | null; cost?: string | null }
				>;
			};
			for (const [op, o] of Object.entries(body.operations ?? {})) {
				entries.push({
					op,
					label: o.label ?? '',
					driver: o.driver ?? undefined,
					cost: o.cost ?? undefined
				});
			}
			if (parsed?.kind === 'run') {
				const run = new URL(url);
				run.pathname = parsed.route;
				run.searchParams.delete('op');
				for (const [k, v] of Object.entries(parsed.params)) run.searchParams.set(k, v);
				const ran = await stub.fetch(asOwner(run));
				result = (await ran.text()).slice(0, 4000);
			}
		} catch (e: unknown) {
			result = `the operation registry could not be read: ${errorMessage(e).slice(0, 200)}`;
		}
		return html(
			renderShell(
				'commands',
				renderCommands(
					entries,
					result,
					op ?? undefined,
					parsed?.kind === 'error' ? parsed.message : undefined
				),
				env
			)
		);
	}

	if (url.pathname === '/settings') return await settingsRoute(request, url, env);

	// fleet inventory from D1, no object touched (`?target=<generation>` scores a rollout)
	if (url.pathname === '/fleet') {
		if (!env.FLEET_DB) {
			return jsonError('no FLEET_DB binding, so no inventory exists', 501, {
				how: 'provision the d1_databases binding in wrangler.jsonc; a single site does not need one'
			});
		}
		// the object's write path creates the table, so a bound but unreported database would
		// throw `no such table: cfw_fleet` (a 500 where the answer is "none yet")
		await ensureFleetTable(env.FLEET_DB);
		const sites = await listSites(env.FLEET_DB);
		const target = url.searchParams.get('target');
		return Response.json({
			ok: true,
			...fleetSummary(sites, Date.now()),
			...(target ? { rollout: rolloutProgress(sites, target), target } : {}),
			sitesList: url.searchParams.get('list') === '1' ? sites : undefined
		});
	}

	// /admin: the limits
	const images = Number(url.searchParams.get('images'));
	const styles = Number(url.searchParams.get('styles'));
	const plan =
		Number.isFinite(images) && images > 0 && Number.isFinite(styles) && styles > 0
			? { images, styles, alreadyUsed: Number(url.searchParams.get('used')) || 0 }
			: undefined;

	// `worker-requests` stays blank (an edge-cache hit never enters an isolate to be counted)
	const resolvedPlan = await resolvePlan(env, env.CONFIG_KV);

	const used: Record<string, number> = {};
	try {
		const inner = new URL(url);
		inner.pathname = '/__serve-stats';
		const res = await stub.fetch(new Request(inner));
		const body = (await res.json()) as {
			rowsToday?: number;
			doRequestsToday?: number;
			imageStyles?: number | null;
			managedImages?: number | null;
		};
		if (typeof body.rowsToday === 'number') used['rows-written'] = body.rowsToday;
		if (typeof body.doRequestsToday === 'number') used['do-requests'] = body.doRequestsToday;
		if (typeof body.imageStyles === 'number' && typeof body.managedImages === 'number') {
			used['image-transforms'] = body.imageStyles * body.managedImages;
		}
	} catch {
		// a stats read that failed leaves the meter unmeasured, which is what it is; the page
		// distinguishes that from zero
	}
	return html(renderShell('thresholds', renderThresholds(used, plan, env, resolvedPlan), env));
}
