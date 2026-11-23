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
import { parseJsonReply } from '../ops/json-reply';
import { fetchGuarded } from '../ops/outbound-guard';
import {
	argsText,
	forgetRows,
	isReported,
	openOutbox,
	PermanentError,
	REPORTED_HINT,
	resultText,
	trimReported,
	type OutboxContext,
	type OutboxSql
} from '../ops/outbox';
import { installPark, parkEnabled, type ParkClassName, type ParkInstall } from '../ops/park';
import { drivePark } from '../ops/park-drive';
import { declaredFetches, pendingDeclared } from '../ops/prefetch';
import {
	isTcpUrl,
	outboxKindFor,
	resolveTcpEndpoint,
	runTcpExchange,
	type TcpResult
} from '../ops/tcp';
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
	const wanted: ParkClassName[] =
		parkEnabled(site.env) &&
		((SHIPPED_CAPABILITIES.blockingSocket && hasRedis) || SHIPPED_CAPABILITIES.blockingOutbound)
			? ['fetch']
			: [];
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
 * plain path. A parked run that does not finish still answers (the chain is finished without the
 * park in `drivePark` and what it printed is parsed); nothing here ever runs `code` a second time.
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
	// a refused chain was finished without the park, so it cost a trip and bought nothing
	if (driven.state !== 'done') totals.refused += 1;
	// one request runs its PHP once: never re-run `code` when the answer is hard to read, because
	// everything it did before that point is already committed
	const reply = await site.settleReply(parseJsonReply(driven.output));
	if (driven.state !== 'done' && 'raw' in reply && reply['exited'] !== true) {
		return {
			...reply,
			error: `the park ended ${driven.state}: ${driven.why ?? String(reply['error'])}`
		};
	}
	return reply;
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
	const http = await fetchGuarded(
		fetch,
		url,
		{
			method,
			signal: AbortSignal.timeout(10_000),
			...(Object.keys(headers).length ? { headers } : {}),
			...(body ? { body } : {})
		},
		(next) => site.refuseOutbound(next)
	);
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

/** what an outbox row carries for one queued request */
type HttpEnvelope = {
	key: string;
	url: string;
	method: string;
	body: string;
	headers: Record<string, string>;
	queuedAt: number;
};

/** the response an HTTP status says to ask for again: a timeout, a rate limit or a server fault */
export function isTransientStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

/** the header an HTTP effect carries its outbox key in, so the far end can drop a repeat */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Fetches everything PHP deferred, in JS, where awaiting is legal.
 *
 * Runs between PHP invocations, bounded per call so slow hosts cannot occupy the object.
 *
 * Each request runs through the http outbox (see `ops/outbox.ts`): a row keyed by the request key
 * and its queue time, claimed and flushed before the fetch. The queue row stays as PHP's record of
 * the request (`deferredStatus()` reads its attempts) until the outbox row settles. A request the
 * method makes unsafe carries `Idempotency-Key: <outbox key>`, the same on every replay. A Redis
 * command that is not safe to repeat is a `report` row: a reset in its window ends it as `failed`
 * and the caller reads a 503 from the fetch cache instead of the command running twice.
 */
export async function drainHttpQueue(site: SitePhpDurableObject, limit = 5) {
	site.ensureHttpTables();
	const outbox = openOutbox(
		site.sql as unknown as OutboxSql,
		'http',
		async (ctx: OutboxContext) => {
			const e = JSON.parse(argsText(ctx)) as HttpEnvelope;
			const method = e.method;
			const unsafe = !SAFE_METHODS.has(method.toUpperCase());
			const outbound = unsafe ? { ...e.headers, [IDEMPOTENCY_HEADER]: ctx.key } : e.headers;
			const tcp = isTcpUrl(e.url);
			// every attempt is a subrequest, answered or not
			site.countActivity('fetches', 1);
			let res: TcpResult;
			try {
				res = await site.performOutbound(e.url, method, e.body, outbound);
			} catch (error) {
				const message = errorMessage(error).slice(0, 200);
				// a command that may have landed is never sent again, whatever the budget says
				if (ctx.kind === 'redis' || ctx.attempt >= attemptBudget(method)) {
					throw new PermanentError(message, { cause: error });
				}
				throw new Error(message, { cause: error });
			}
			// a status asks for another try only on the wire; a Redis or AI exchange has answered
			if (!tcp && isTransientStatus(res.status) && ctx.attempt < attemptBudget(method)) {
				throw new Error(`HTTP ${res.status}`);
			}
			site.sql.exec(
				`INSERT INTO cfw_http_cache (key, url, status, headers, body, fetched_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             status = excluded.status, headers = excluded.headers,
             body = excluded.body, fetched_at = excluded.fetched_at,
             expires_at = excluded.expires_at`,
				e.key,
				e.url,
				res.status,
				JSON.stringify(res.headers),
				res.body,
				site.nowMs(),
				site.nowMs() + ttlFor(method, e.url)
			);
			// the answer is cached for PHP to read; a client error is final, so it is not asked again
			if (!tcp && res.status >= 400 && res.status < 500 && !isTransientStatus(res.status)) {
				throw new PermanentError(`HTTP ${res.status}`);
			}
			return JSON.stringify({ status: res.status, bytes: res.body.length });
		},
		// six at a time (the subrequest concurrency); serial would bill N round trips of wall clock
		{ flush: () => site.storage.sync(), width: 6 }
	);
	const pending = site.sql
		.exec<
			Row<{
				key: string;
				url: string;
				method: string;
				body: string;
				headers: string;
				attempts: number;
				queued_at: number;
			}>
		>(
			'SELECT key, url, method, body, headers, attempts, queued_at FROM cfw_http_queue ORDER BY queued_at LIMIT ?',
			Math.max(1, Math.min(limit, 25))
		)
		.toArray();
	const done: Payload[] = [];
	const items: { id: string; kind: string; argsJson: HttpEnvelope }[] = [];
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
		const body = String(item.body ?? '');
		// a row queued before the column existed carries '{}' (no headers)
		let headers: Record<string, string> = {};
		try {
			const parsed: unknown = JSON.parse(String(item.headers ?? '{}'));
			if (parsed && typeof parsed === 'object') {
				headers = headersToSend(parsed as Record<string, string>);
			}
		} catch {
			headers = {};
		}
		const queuedAt = Number(item.queued_at ?? 0);
		items.push({
			// the queue time is in the id so a request repeated a day later is a new request
			id: `http-${key}-${queuedAt}`,
			kind: outboxKindFor(url, body),
			argsJson: { key, url, method, body, headers, queuedAt }
		});
	}
	if (items.length > 0) await outbox.enqueue(items);
	await outbox.drain();

	// settle every finished row, including ones an earlier reset left behind
	const spent: string[] = [];
	let reported = false;
	for (const row of outbox.results()) {
		const e = JSON.parse(argsText(row)) as HttpEnvelope;
		const { key, url } = e;
		if (row.state === 'running') continue;
		// the queue row this outbox row was made from; PHP may have queued the key again since
		const live =
			site.sql
				.exec(
					'SELECT 1 FROM cfw_http_queue WHERE key = ? AND queued_at = ?',
					key,
					e.queuedAt
				)
				.toArray().length > 0;
		if (!live) {
			if (!isReported(row)) spent.push(row.id);
			continue;
		}
		if (row.state === 'queued') {
			// threw with attempts left: the queue row carries the count PHP reads
			site.sql.exec(
				'UPDATE cfw_http_queue SET attempts = ?, last_error = ? WHERE key = ?',
				row.attempt,
				row.error ?? '',
				key
			);
			done.push({ url, attempts: row.attempt, error: row.error ?? '' });
			continue;
		}
		site.sql.exec('DELETE FROM cfw_http_queue WHERE key = ?', key);
		if (row.state === 'done') {
			const result = JSON.parse(resultText(row)) as { status: number; bytes: number };
			done.push({ url, status: result.status, bytes: result.bytes });
			spent.push(row.id);
		} else if (isReported(row)) {
			// the caller reads an error from the cache rather than asking again; the row stays
			// for the operator, see `reportedRows()`
			site.sql.exec(
				`INSERT INTO cfw_http_cache (key, url, status, headers, body, fetched_at, expires_at)
           VALUES (?, ?, 503, '{}', ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             status = 503, headers = '{}', body = excluded.body,
             fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
				key,
				url,
				`delivery uncertain: ${REPORTED_HINT}`,
				site.nowMs(),
				site.nowMs() + ttlFor(e.method, url)
			);
			done.push({ url, reported: true, error: REPORTED_HINT });
			reported = true;
		} else if (/^HTTP 4\d\d$/.test(row.error ?? '')) {
			done.push({ url, status: Number(String(row.error).slice(5)) });
			spent.push(row.id);
		} else {
			done.push({ url, dropped: true, error: row.error ?? '' });
			spent.push(row.id);
		}
	}
	forgetRows(site.sql as unknown as OutboxSql, 'http', spent);
	if (reported) trimReported(site.sql as unknown as OutboxSql, 'http');
	return {
		drained: done,
		remaining: Number(
			firstRow(site.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_http_queue'))
				?.c ?? 0
		)
	};
}
