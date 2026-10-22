import {
	AUDIT_ACTOR_PROOF,
	AUDIT_RING,
	appendAudit,
	auditedRoute,
	noteFailedAttempt,
	readAudit,
	verifyAuditChain
} from '../../ops/owner-audit';
import { sha256Hex } from '../../ops/owner-recovery';
import {
	OWNER_HASH_KEY,
	bearerToken,
	ownerTokenMatches,
	tokenMatches,
	type SealedStore
} from '../../ops/site-secrets';
import type { SitePhpDurableObject } from '../../site-do';
import { jsonError } from '../../util/reply';

/** the object paths whose public route is not the same name without the `/__` prefix */
const PUBLIC_NAME: Record<string, string> = {
	'/__cfoauth': '/setup/cf',
	'/__mailonboard': '/setup/mail',
	'/__oidcsetup': '/setup/oidc'
};

/** the rotation route, which has no front-worker `DO_ROUTE` entry */
const RECOVER_ROUTE = '/__recover-token';

const handles = new WeakMap<object, SealedStore>();

/**
 * The sealed handle the log lives in, one per object so appends and the failure count share state.
 */
export function auditStore(site: SitePhpDurableObject): SealedStore {
	let store = handles.get(site);
	if (!store) {
		store = site.secretStore().sealed;
		handles.set(site, store);
	}
	return store;
}

/** the first 8 hex characters of the SHA-256 of the owner token the request proved, if it did */
async function ownerActor(
	site: SitePhpDurableObject,
	request: Request
): Promise<string | undefined> {
	const presented = bearerToken(request.headers.get('authorization'));
	if (!presented) return undefined;
	const hash = await sha256Hex(presented);
	const stored = auditStore(site).get(OWNER_HASH_KEY);
	return stored !== undefined && tokenMatches(hash, stored) ? hash.slice(0, 8) : undefined;
}

/**
 * Records an owner call after it answered, at the one point every request to the object passes.
 *
 * A call is an owner call when it carries the owner token the front worker already checked, which
 * the object checks again here; the internal calls that carry none (provisioning, the claim) and
 * a diagnostics-only call are not recorded. A rotation presents no token, so its actor is `proof`.
 * Never throws: a failed append must not turn an owner call into an error.
 */
export async function auditOwnerCall(
	site: SitePhpDurableObject,
	request: Request,
	status: number
): Promise<void> {
	try {
		const url = new URL(request.url);
		if (!url.pathname.startsWith('/__') || site.isReplica()) return;
		const label = auditedRoute(url.pathname, request.method, url.searchParams);
		if (label === undefined) return;
		let actor: string | undefined;
		if (url.pathname === RECOVER_ROUTE) {
			// a refused proof is a failed attempt, which is counted and not recorded
			if (status !== 200) {
				noteFailedAttempt(auditStore(site), site.nowMs());
				return;
			}
			actor = AUDIT_ACTOR_PROOF;
		} else {
			actor = await ownerActor(site, request);
		}
		if (actor === undefined) return;
		const route =
			(PUBLIC_NAME[url.pathname] ?? url.pathname.replace('/__', '/')) +
			label.slice(url.pathname.length);
		await appendAudit(auditStore(site), {
			at: site.nowMs(),
			route,
			method: request.method,
			status,
			actor
		});
	} catch (e) {
		console.warn(`owner audit: append failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * `GET /audit` returns the retained entries, whether the chain holds and the first sequence
 * number where it does not. `POST /audit` records a change the front worker made itself (a
 * `/settings` write lives in `CONFIG_KV`, which the object cannot see).
 */
export async function audit(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const store = site.secretStore();
	if (!(await ownerTokenMatches(store, bearerToken(request.headers.get('authorization')))))
		return jsonError('owner token required', 401);
	if (request.method === 'POST') {
		let body: { route?: unknown; status?: unknown } = {};
		try {
			body = (await request.json()) as typeof body;
		} catch {
			// the check below refuses an empty body
		}
		if (body.route !== '/settings' || !Number.isSafeInteger(body.status)) {
			return jsonError('only a /settings write with a status can be recorded', 400);
		}
		const actor = await ownerActor(site, request);
		const entry = await appendAudit(auditStore(site), {
			at: site.nowMs(),
			route: '/settings',
			method: 'PUT',
			status: body.status as number,
			actor: actor ?? ''
		});
		return Response.json({ ok: true, seq: entry.seq });
	}
	if (request.method !== 'GET') return jsonError('use GET to read the log', 405);
	const log = readAudit(auditStore(site));
	const verdict = await verifyAuditChain(log.entries, log.floor, log.head);
	return Response.json(
		{
			ok: true,
			verified: verdict.verified,
			...(verdict.firstBad === undefined ? {} : { firstBadSeq: verdict.firstBad }),
			ring: AUDIT_RING,
			head: log.head ?? null,
			floor: log.floor ?? null,
			failedAttempts: log.failedAttempts,
			entries: log.entries
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
}
