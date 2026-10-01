import { isAiUrl, runAiExchange } from '../ops/ai';
import { SHIPPED_CAPABILITIES } from '../ops/catalog';
import {
	attemptBudget,
	deferredKey,
	headersToSend,
	isFresh,
	isServableStale,
	ttlFor
} from '../ops/deferred-post';
import { installPark, type ParkClassName, parkEnabled, type ParkInstall } from '../ops/park';
import { drivePark } from '../ops/park-drive';
import { declaredFetches, pendingDeclared } from '../ops/prefetch';
import { isTcpUrl, resolveTcpEndpoint, runTcpExchange, type TcpResult } from '../ops/tcp';
import type { SitePhpDurableObject } from '../site-do';
import { errorMessage } from '../util/errors';
import { columnText, firstRow } from '../util/sql';
import { boundedText } from './helpers';
import { DECLARED_WARMED_KEY } from './keys';
import { httpDrainEnabled, sleepBudgetMs } from './levers';
import type { Payload, Row } from './types';

/**
 * The fetch cache and the deferred queue; durable, so a drain survives eviction.
 *
 * Keyed by method, URL and body (see {@link deferredKey}), not by URL alone: two deferred fetches
 * to one endpoint would share a row and a caller could be handed a response fetched for somebody
 * else (one visitor's captcha verdict for another's).
 */
export function ensureHttpTables(site: SitePhpDurableObject): void {
	if (site.httpTablesReady) return;
	// older url-keyed tables are dropped (`IF NOT EXISTS` would keep them); both are caches, and
	// PHP re-queues on the next miss, so this costs a round trip, not data
	for (const table of ['cfw_http_cache', 'cfw_http_queue']) {
		const columns = site.sql
			.exec<Row<{ name: string }>>('SELECT name FROM pragma_table_info(?)', table)
			.toArray()
			.map((r) => String(r.name));
		if (columns.length > 0 && !columns.includes('key')) {
			site.sql.exec(`DROP TABLE ${table}`);
		}
	}
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_http_cache (
        key TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        status INTEGER NOT NULL,
        headers TEXT NOT NULL,
        body TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`
	);
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_http_queue (
        key TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        method TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        headers TEXT NOT NULL DEFAULT '{}',
        queued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      )`
	);
	// an older queue lacks the headers column; `ADD COLUMN` keeps what is queued
	const queueColumns = site.sql
		.exec<Row<{ name: string }>>('SELECT name FROM pragma_table_info(?)', 'cfw_http_queue')
		.toArray()
		.map((r) => String(r.name));
	if (!queueColumns.includes('headers')) {
		site.sql.exec("ALTER TABLE cfw_http_queue ADD COLUMN headers TEXT NOT NULL DEFAULT '{}'");
	}
	site.httpTablesReady = true;
}

/** a fresh cached response, or with `allowStale` a servable stale one below 500; else undefined */
export function httpCacheGet(
	site: SitePhpDurableObject,
	url: string,
	method = 'GET',
	body = '',
	headers: Record<string, string> = {},
	opts: { allowStale?: boolean } = {}
): { status: number; headers: Payload; body: string; stale: boolean } | undefined {
	site.ensureHttpTables();
	const row = firstRow(
		site.sql.exec<Row<{ status: number; headers: string; body: string; expires_at: number }>>(
			'SELECT status, headers, body, expires_at FROM cfw_http_cache WHERE key = ?',
			deferredKey(method, url, body, headers)
		)
	);
	if (!row) return undefined;
	// an expired entry is never served (a stale verification is a replay window); a missing or
	// non-finite expiry counts as expired
	const expiry = { expiresAt: Number(row.expires_at) };
	const fresh = isFresh(expiry, site.nowMs());
	// except when the alternative is an exception (`staleWindowFor()` is 0 for non-idempotent)
	const stale =
		!fresh &&
		opts.allowStale === true &&
		isServableStale(expiry, site.nowMs(), method) &&
		Number(row.status) < 500;
	if (!fresh && !stale) return undefined;
	let responseHeaders: Payload = {};
	try {
		responseHeaders = JSON.parse(String(row.headers));
	} catch {
		responseHeaders = {};
	}
	return {
		status: Number(row.status),
		headers: responseHeaders,
		body: String(row.body),
		stale
	};
}

/** queues an outbound request for the drain unless the SSRF guard refuses; a repeat is a no-op */
export function queueHttp(
	site: SitePhpDurableObject,
	url: string,
	method = 'GET',
	body = '',
	headers: Record<string, string> = {}
): void {
	if (!url) return;
	const refusal = site.refuseOutbound(url);
	if (refusal !== undefined) {
		site.lastOutboundRefusal = refusal;
		return;
	}
	site.ensureHttpTables();
	site.sql.exec(
		`INSERT INTO cfw_http_queue (key, url, method, body, headers, queued_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`,
		deferredKey(method, url, body, headers),
		url,
		method,
		body,
		JSON.stringify(headersToSend(headers)),
		site.nowMs()
	);
	// wake the drain: an idle site's alarm re-arms at 240 s, so a queued request waited minutes
	if (httpDrainEnabled(site.env)) site.armFillAlarm();
}

/**
 * Whether this interpreter can park, probed once and memoized.
 *
 * Lazy, because the probe runs PHP and the interpreter cannot execute yet when the other shims
 * are wired (a probe there reports `failed` on a build that parks fine).
 *
 * Two classes arm independently, each gated on its capability (arming one the park cannot serve
 * sends every render through `cfw_park_run` for a yield that always falls back):
 * `socket` (`drupal/redis`) waits for a Redis endpoint, since its read/write traps divert every
 * file write in a parked run; `fetch` needs no endpoint (the SSRF guard bounds the destination).
 */
export async function parkState(site: SitePhpDurableObject): Promise<ParkInstall> {
	if (site.parkInstall) return site.parkInstall;
	const hasRedis = !('refusal' in resolveTcpEndpoint(site.env, 'redis'));
	const wanted: ParkClassName[] = !parkEnabled(site.env)
		? []
		: [
				...(SHIPPED_CAPABILITIES.blockingSocket && hasRedis ? (['socket'] as const) : []),
				...(SHIPPED_CAPABILITIES.blockingOutbound ? (['fetch'] as const) : [])
			];
	site.parkInstall = await installPark(
		{
			// `run()` collects the output event; `_run`'s return value is not the printed text
			runText: (code: string) => site.run(code)
		},
		wanted
	);
	return site.parkInstall;
}

/**
 * Renders through the park when the traps are armed, and plainly when they are not.
 *
 * A parked render costs an extra `_run` per blocking call, so a site with no armed traps takes the
 * plain path. A parked run that does not finish still answers (the chain is unwound in
 * `drivePark` and what it printed is parsed); only an unparseable answer re-renders unparked.
 *
 * Every shell-tier run goes through here: a bare `runJson` leaves a `cache_*` read inside
 * `renderPlaceholder()` unparked, it fails on the real socket, and a Redis site never assembles.
 */
export async function runJsonMaybeParked(
	site: SitePhpDurableObject,
	code: string
): Promise<Payload> {
	const park = await site.parkState();
	if (park.state !== 'installed') return site.runJson(code);

	const driven = await drivePark(
		{ runText: (c: string) => site.run(c) },
		site.parkSocketTable(),
		site.env,
		code,
		site.parkFetchDep ?? fetch,
		(site.sleepBudget ??= { remainingMs: sleepBudgetMs(site.env, 'request') })
	);
	site.lastPark = {
		state: driven.state,
		trips: driven.trips.length,
		...(driven.why ? { why: driven.why } : {})
	};
	const totals = (site.parkTotals ??= { runs: 0, trips: 0, refused: 0 });
	totals.runs += 1;
	totals.trips += driven.trips.length;
	// a refused chain fell back to the real function, so it cost a run and bought nothing
	if (driven.state !== 'done') totals.refused += 1;
	const start = driven.output.indexOf('{');
	if (start >= 0) {
		try {
			return JSON.parse(driven.output.slice(start)) as Payload;
		} catch {
			// fall through to the unparked render below
		}
	}
	return site.runJson(code);
}

/**
 * One outbound exchange, with no SQL in it.
 *
 * Split out so the drain can hold several open at once. The TCP and AI tiers share this queue,
 * cache and budget on purpose, so dedup, TTL and attempt budget live in one place.
 */
export async function performOutbound(
	site: SitePhpDurableObject,
	url: string,
	method: string,
	body: string,
	headers: Record<string, string>
): Promise<TcpResult> {
	if (isTcpUrl(url)) return runTcpExchange(url, body, site.env ?? {});
	if (isAiUrl(url)) return runAiExchange(url, body, site.env ?? {});
	// bounded at 10 s: this runs on the alarm, and a host that never answers would hold the firing
	// open and leave the fill queue undrained (a permanent 503 for visitors)
	const http = await fetch(url, {
		method,
		signal: AbortSignal.timeout(10_000),
		...(Object.keys(headers).length ? { headers } : {}),
		...(body ? { body } : {})
	});
	const received: Record<string, string> = {};
	for (const [k, v] of http.headers) received[k.toLowerCase()] = v;
	return { status: http.status, headers: received, body: await boundedText(http) };
}

/**
 * Queues the outbound answers the host can name without running Drupal.
 *
 * The project list comes from `core.extension` (one row read, no kernel boot).
 */
export function queueDeclaredFetches(site: SitePhpDurableObject): string[] {
	try {
		site.ensureHttpTables();
		// at most once an hour: every firing wrote a row per declared URL on a site whose fetch
		// never lands (rows per fill went 9 to 10)
		const last = Number(site.metaGet(DECLARED_WARMED_KEY) ?? 0);
		const now = site.nowMs();
		if (Number.isFinite(last) && now - last < 3_600_000) return [];
		const declared = declaredFetches(installedProjects(site), site.env?.UPDATE_FETCH_URL);
		const queued = pendingDeclared(declared, (url) => site.httpCacheGet(url) !== undefined);
		if (queued.length === 0) return [];
		site.metaSet(DECLARED_WARMED_KEY, String(now));
		for (const url of queued) site.queueHttp(url, 'GET', '', {});
		return queued;
	} catch {
		// a site with no config table has no projects to warm, and this must not break the alarm
		return [];
	}
}

/**
 * The contrib project names this site has installed.
 *
 * Read out of `core.extension` (a serialised PHP array); the names are matched by pattern rather
 * than parsing the structure with a second PHP unserialiser.
 */
export function installedProjects(site: SitePhpDurableObject): string[] {
	const row = firstRow(
		site.sql.exec<Row<{ data: unknown }>>(
			'SELECT data FROM config WHERE collection = ? AND name = ?',
			'',
			'core.extension'
		)
	);
	const data = row?.data;
	const text = columnText(data);
	const names = new Set<string>();
	for (const m of text.matchAll(/s:\d+:"([a-z][a-z0-9_]*)";i:\d+;/g)) {
		names.add(m[1] as string);
	}
	return [...names];
}

/**
 * Fetches everything PHP deferred, in JS, where awaiting is legal.
 *
 * Runs between PHP invocations, bounded per call so slow hosts cannot occupy the object.
 */
export async function drainHttpQueue(site: SitePhpDurableObject, limit = 5) {
	site.ensureHttpTables();
	const pending = site.sql
		.exec<
			Row<{
				key: string;
				url: string;
				method: string;
				body: string;
				headers: string;
				attempts: number;
			}>
		>(
			'SELECT key, url, method, body, headers, attempts FROM cfw_http_queue ORDER BY queued_at LIMIT ?',
			Math.max(1, Math.min(limit, 25))
		)
		.toArray();
	const done: Payload[] = [];
	// prepared, not started: opening every URL at once buffers up to 15-25 whole responses on the
	// JS heap against ~4 MiB of net isolate headroom
	const prepared: Array<{
		key: string;
		url: string;
		method: string;
		sent: string;
		outbound: Record<string, string>;
		attempts: number;
	}> = [];
	for (const item of pending) {
		const key = String(item.key);
		const url = String(item.url);
		// checked again here, where the connection opens; a row can arrive without `queueHttp()`
		const refusal = site.refuseOutbound(url);
		if (refusal !== undefined) {
			site.lastOutboundRefusal = refusal;
			site.sql.exec('DELETE FROM cfw_http_queue WHERE key = ?', key);
			done.push({ url, refused: refusal.reason });
			continue;
		}
		const method = String(item.method || 'GET');
		const sent = String(item.body ?? '');
		// a row queued before the column existed carries '{}' (no headers)
		let outbound: Record<string, string> = {};
		try {
			const parsed: unknown = JSON.parse(String(item.headers ?? '{}'));
			if (parsed && typeof parsed === 'object') {
				outbound = headersToSend(parsed as Record<string, string>);
			}
		} catch {
			outbound = {};
		}
		prepared.push({
			key,
			url,
			method,
			sent,
			outbound,
			attempts: Number(item.attempts ?? 0)
		});
	}
	// six at a time (the subrequest concurrency); serial would bill N round trips of wall clock.
	// `performOutbound` touches no SQL, which makes this safe
	for (let i = 0; i < prepared.length; i += 6) {
		const batch = prepared.slice(i, i + 6);
		const settled = await Promise.allSettled(
			batch.map((b) => site.performOutbound(b.url, b.method, b.sent, b.outbound))
		);
		// every attempt is a subrequest, answered or not
		site.countActivity('fetches', batch.length);
		for (let j = 0; j < batch.length; j++) {
			const entry = batch[j];
			const outcome = settled[j];
			if (!entry || !outcome) continue;
			const { key, url, method } = entry;
			if (outcome.status === 'fulfilled') {
				const res = outcome.value;
				site.sql.exec(
					`INSERT INTO cfw_http_cache (key, url, status, headers, body, fetched_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             status = excluded.status, headers = excluded.headers,
             body = excluded.body, fetched_at = excluded.fetched_at,
             expires_at = excluded.expires_at`,
					key,
					url,
					res.status,
					JSON.stringify(res.headers),
					res.body,
					site.nowMs(),
					site.nowMs() + ttlFor(method, url)
				);
				site.sql.exec('DELETE FROM cfw_http_queue WHERE key = ?', key);
				done.push({ url, status: res.status, bytes: res.body.length });
				continue;
			}
			const attempts = entry.attempts + 1;
			const reason = outcome.reason as { message?: unknown } | undefined;
			const error = errorMessage(reason).slice(0, 200);
			// the budget comes from the method: a retried POST can be refused as already redeemed
			// after the first attempt succeeded at the far end
			if (attempts >= attemptBudget(method)) {
				site.sql.exec('DELETE FROM cfw_http_queue WHERE key = ?', key);
				done.push({ url, dropped: true, error });
			} else {
				site.sql.exec(
					'UPDATE cfw_http_queue SET attempts = ?, last_error = ? WHERE key = ?',
					attempts,
					error,
					key
				);
				done.push({ url, attempts, error });
			}
		}
	}
	return {
		drained: done,
		remaining: Number(
			firstRow(site.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_http_queue'))
				?.c ?? 0
		)
	};
}
