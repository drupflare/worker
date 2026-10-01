import { hasSessionCookie } from '../ops/auth-budget';
import type { CacheTier } from '../ops/cache-tiers';
import { ABSORBED_HEADER, foldAbsorbed, recordEncounter } from '../ops/cold-encounter';
import { KV_GRANT_HEADER, kvWriteBudget, pageKvEnabled } from '../ops/page-store';
import { ReplicaRequiresPrimary } from '../ops/replica';
import { FIRST_RUN_KEY, needsSetup } from '../ops/setup-page';
import { recordArrival } from '../ops/thermal';
import type { SitePhpDurableObject } from '../site-do';
import { firstRow } from '../util/sql';
import { openFillWindow } from './fill';
import { noteResident } from './isolate';
import { agedServeAllowed, agedServeMaxMs } from './levers';
import { CFW_HEADER_VERSION, SERVE_REQUESTS_FLUSH } from './limits';
import { noteLaneTiming } from './stats';
import type { PageRow } from './types';

/**
 * One stored page, as an HTTP response. `x-cfw-generation` rides on every serve response so the
 * Worker learns the generation without a Durable Object request.
 */
export function pageResponse(
	site: SitePhpDurableObject,
	row: PageRow,
	tier: CacheTier,
	serveMs: number,
	extra: Record<string, string> = {}
): Response {
	const headers: Record<string, string> = {
		...extra,
		'content-type': String(row.content_type ?? 'text/html; charset=utf-8'),
		// the edge copy has its own longer max-age; clients revalidate so a bump wins
		'cache-control': 'public, max-age=0, must-revalidate',
		// header contract version: tells an old worker from a renamed header
		'x-cfw-v': CFW_HEADER_VERSION,
		'x-cfw-cache': tier,
		'x-cfw-generation': String(site.generation()),
		'x-cfw-rendered-at': String(row.rendered_at),
		'x-cfw-render-ms': String(row.render_ms),
		'x-cfw-serve-ms': String(serveMs),
		'x-cfw-php-booted': site.php ? '1' : '0'
	};
	if (tier === 'HIT') headers['x-cfw-hit-ms'] = String(serveMs);
	else headers['x-cfw-inline'] = '1';
	return new Response(String(row.html), {
		status: Number(row.status),
		headers
	});
}

/**
 * Turns a replica's refusal into an answer the caller can act on. The retry is safe because the
 * refusal throws before the inner capability runs; `didMutate()` is checked, and a true reading
 * downgrades to a 500. 421 not 503: this object will refuse the request forever.
 *
 * @param neverRan - the refusal precedes any interpreter, so nothing could have mutated
 */
export function replicaHandoff(
	site: SitePhpDurableObject,
	refusal: ReplicaRequiresPrimary,
	neverRan = false
): Response {
	const clean = neverRan || site.replicaGuard?.didMutate() === false;
	if (!clean) {
		// fail closed: a refusal precedes the inner call, but that is not taken on trust
		return Response.json(
			{
				error: 'a replica refused after reaching a mutating call',
				capability: refusal.capability
			},
			{ status: 500, headers: { 'x-cfw-retry-safe': '0' } }
		);
	}
	return Response.json(
		{
			requiresPrimary: true,
			capability: refusal.capability,
			detail: refusal.detail,
			refusals: site.replicaRefusalsTotal
		},
		{
			status: 421,
			headers: {
				'x-cfw-requires-primary': refusal.capability,
				'x-cfw-retry-safe': '1',
				'x-cfw-cache': 'REFUSED',
				// every response naming a tier carries the generation (`cache-tiers.spec.ts`)
				'x-cfw-generation': String(site.generation())
			}
		}
	);
}

/**
 * Lets the front worker store this page in `PAGE_KV`, or not.
 *
 * The object holds the durable daily counter and the front worker writes KV only on a grant. Only
 * the primary grants, so a pool cannot multiply the budget; a skipped grant still counts.
 */
export function withKvGrant(site: SitePhpDurableObject, request: Request, res: Response): Response {
	try {
		if (res.status !== 200 || res.webSocket || request.method !== 'GET') return res;
		if (new URL(request.url).pathname !== '/__serve') return res;
		const cache = res.headers.get('x-cfw-cache');
		if (cache !== 'HIT' && cache !== 'RENDER') return res;
		if (res.headers.has('set-cookie') || hasSessionCookie(request.headers.get('cookie'))) {
			return res;
		}
		if (site.isReplica() || !pageKvEnabled(site.env as never)) return res;
		if (site.dailyKvWrites() >= kvWriteBudget(site.env)) return res;
		site.kvGrantsSinceFlush = (site.kvGrantsSinceFlush ?? 0) + 1;
		const headers = new Headers(res.headers);
		headers.set(KV_GRANT_HEADER, '1');
		return new Response(res.body, {
			status: res.status,
			statusText: res.statusText,
			headers
		});
	} catch {
		// an unreadable meter grants nothing; the page still answers
		return res;
	}
}

/**
 * Two lanes: a `cfw_page` HIT answers off `ctx.storage.sql` without entering the gate, so it is
 * not queued behind a render (`lane=gate` forces the gated path). The fast lane runs no DDL (it
 * dirties `sqlite_master` under an open replay), never awaits and never touches PHP.
 */
export async function route(site: SitePhpDurableObject, request: Request): Promise<Response> {
	const url = new URL(request.url);
	// counted before the lanes split: both are one billed invocation
	site.doRequestsSinceFlush = (site.doRequestsSinceFlush ?? 0) + 1;
	// what the front worker answered itself since its last hop; read where both lanes converge
	site.encounters = foldAbsorbed(site.encounters, request.headers.get(ABSORBED_HEADER));

	// the warm window, before the gate: accepting the socket inside a gate entry deadlocks the
	// per-message work queued behind it
	if (
		url.pathname === '/__fillsocket' &&
		request.headers.get('upgrade')?.toLowerCase() === 'websocket'
	) {
		return openFillWindow(site);
	}

	if (
		url.pathname === '/__serve' &&
		request.method === 'GET' &&
		url.searchParams.get('lane') !== 'gate' &&
		// condition 1: no DDL from this lane, so it only runs once the tables exist
		site.serveTablesReady === true &&
		// the stored row is an anonymous render; `fillOne()` refuses to store one for a session
		!hasSessionCookie(request.headers.get('cookie')) &&
		// a restore writes this cursor too: without the check a warm site answers 200 from
		// `cfw_page` while a rollback overwrites the database (one indexed read, no DDL, no await)
		site.migratePartial() === undefined &&
		// the claim page is the gated lane's decision (the pack prefills `/`)
		!needsSetup(request, site.metaGet(FIRST_RUN_KEY) !== null)
	) {
		const fast = site.serveFromStorage(url);
		if (fast) return fast;
	}

	// #region the herd, collapsed at the object (the front worker's map is per-isolate)
	// before the gate, or the waiters each take a slot and queue behind the leader
	const herdKey = site.herdKeyFor(request, url);
	if (herdKey !== undefined) {
		const waiting = site.renderFlights.get(herdKey);
		if (waiting !== undefined) {
			const shared = await waiting;
			if (shared !== undefined) {
				return new Response(shared.body, {
					status: shared.status,
					headers: { ...Object.fromEntries(shared.headers), 'x-cfw-herd': 'joined' }
				});
			}
		}
	}
	// #endregion

	site.phpLaneEntries = (site.phpLaneEntries ?? 0) + 1;
	// no await from the herd check to `gate.run()` (waiters would all miss `renderFlights` and read
	// `ahead` as 0), so `adoptSettings()` stays inside the gate
	const arrivedAt = site.nowMs();
	const ahead = site.gate.stats().active + site.gate.stats().queued;
	// one gate entry for the whole request; handle() must never re-enter it
	const entered = site.gate.run(async () => {
		const enteredAt = site.nowMs();
		const response = await site.handle(request, url);
		// a lane's writes ran speculatively and rolled back; this is the only place they land
		// (before the seal: a lane seals nothing and a primary's buffer is empty)
		const forwarded = await site.flushForward();
		if (forwarded !== undefined) site.lastForward = forwarded;
		// after `handle()` (the tag set is complete only then); assign only on a non-empty flush
		// or the next request erases the field
		site.settlePendingIfOwed();
		const invalidated = site.flushTagPurge();
		if (invalidated.length > 0) site.lastInvalidatedTags = invalidated;
		const settled = site.settlePlans(invalidated);
		if (settled.cleared)
			site.lastPlanPurge = { purged: settled.purged, tags: invalidated.length };
		// seal after `handle()` and before the recycle
		await site.sealGeneration();
		site.recycleIfOversized('request');
		site.recycleAfterUpload();
		site.traceMemory('request-end');
		noteResident(site.ctx.id.toString(), site.php);
		site.retainInterpreter();
		// the response claims the write succeeded and the primary kept none of it
		if (forwarded !== undefined && forwarded.action !== 'commit') {
			throw new ReplicaRequiresPrimary('forward', `${forwarded.action}: ${forwarded.reason}`);
		}
		return noteLaneTiming(site, response, ahead, arrivedAt, enteredAt);
	});
	if (herdKey === undefined) return entered;
	const key = herdKey;
	// the leader publishes a shareable copy; an unshareable one resolves undefined and waiters
	// take their own gate entry
	const shareable = entered
		.then(async (r) => {
			// a rotated session is per visitor and a non-200 is not worth fanning out
			if (r.status !== 200 || r.headers.has('set-cookie')) return undefined;
			return {
				body: await r.clone().arrayBuffer(),
				status: r.status,
				headers: [...r.headers] as [string, string][]
			};
		})
		.catch(() => undefined);
	site.renderFlights.set(key, shareable);
	try {
		// await the buffering before dropping the entry, or the next sequential request joins a
		// settled flight and gets the previous answer (`shell.spec.ts`)
		const shared = await shareable;
		if (shared === undefined) return await entered;
		return new Response(shared.body, {
			status: shared.status,
			headers: Object.fromEntries(shared.headers)
		});
	} finally {
		site.renderFlights.delete(key);
	}
}

/**
 * A cached page, or undefined for "not mine". Synchronous: an await would break the fast lane's
 * no-await rule. The serve counter moves only on the answering path, so each request counts once.
 */
export function serveFromStorage(site: SitePhpDurableObject, url: URL): Response | undefined {
	const path = url.searchParams.get('path') ?? '/';
	const t0 = Date.now();
	let row:
		| (PageRow & { stale_at?: number | null; tags?: unknown; tag_checksum?: number | null })
		| undefined;
	try {
		row = firstRow(
			site.sql.exec<
				PageRow & {
					stale_at?: number | null;
					tags?: unknown;
					tag_checksum?: number | null;
				}
			>(
				'SELECT status, content_type, html, rendered_at, render_ms, stale_at, tags, tag_checksum FROM cfw_page WHERE path = ?',
				path
			)
		);
	} catch {
		// a missing table means the memo lied; let the gated lane sort it out
		site.serveTablesReady = false;
		return undefined;
	}
	if (!row) return undefined;

	// #region the superseded row
	// a bump marks rather than deletes: the content is one save old and its refill is queued; the
	// window is bounded so a stopped alarm chain degrades to a 503, not last week's page
	const staleAt = site.pageStaleness(path, row);
	let aged = false;
	if (staleAt !== undefined) {
		const age = site.nowMs() - staleAt;
		if (age >= agedServeMaxMs(site.env) || !agedServeAllowed(path, site.env)) {
			// past the window or an excluded path: drop it and let the gated lane answer
			site.sql.exec('DELETE FROM cfw_page WHERE path = ?', path);
			site.enqueueRefill(path);
			return undefined;
		}
		aged = true;
		// `PREFILL_ON_SAVE_LIMIT` caps the re-queue, so the long tail self-heals on first visit
		site.enqueueRefill(path);
	}
	// #endregion

	site.serveRequestsPending = (site.serveRequestsPending ?? 0) + 1;
	if (site.serveRequestsPending >= SERVE_REQUESTS_FLUSH) site.flushServeRequests();
	site.storageLaneServes = (site.storageLaneServes ?? 0) + 1;
	// the no-php arm of the cold-encounter rate: no interpreter entered
	site.encounters = recordEncounter(site.encounters, 'no-php');
	// in memory, never a row (a `hits` column would spend the rows meter); lost on eviction
	site.pageHits.set(path, (site.pageHits.get(path) ?? 0) + 1);
	// `rendered: false`: a stored page boots no PHP, so warming cannot speed it up
	site.arrivals = recordArrival(site.arrivals ?? [], { at: site.nowMs(), rendered: false });
	const gate = site.gate.stats();
	// advertise the pool from the fast lane too, or `believedLanes()` drops it 60 s after the last
	// gated response (memoised: one indexed read, no await)
	return site.pageResponse(row, aged ? 'AGED' : 'HIT', Date.now() - t0, {
		'x-cfw-lane': 'storage',
		...(aged ? { 'x-cfw-aged-ms': String(site.nowMs() - (staleAt ?? 0)) } : {}),
		...site.laneHeaders(),
		// `active` counts callbacks in the PHP lane; 1 means this HIT overlapped a render
		'x-cfw-gate-active': String(gate.active),
		'x-cfw-gate-queued': String(gate.queued),
		'x-cfw-queue-depth': String(site.queueDepth())
	});
}
