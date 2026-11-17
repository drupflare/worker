import type { AggregateIndex } from '../ops/aggregates';
import { ATTEMPT_TTL_MS } from '../ops/attempt';
import { hasSessionCookie } from '../ops/auth-budget';
import { readTagList, tagChecksum } from '../ops/fragment-index';
import { eagerDerivativesEnabled } from '../ops/render-lane';
import type { ForwardStatement } from '../ops/write-forwarding';
import { firstRow } from '../util/sql';
import type { FillQueueHost } from './host';
import { UNSTORABLE_KEY } from './keys';
import { FILL_QUEUE_MAX } from './limits';
import type { Row } from './types';

/**
 * Queues a refill for one path and wakes the chain; await-free (the storage lane runs outside
 * the gate) and bounded by `FILL_QUEUE_MAX`.
 */
export function enqueueRefill(host: FillQueueHost, path: string): void {
	if (queueDepth(host) >= FILL_QUEUE_MAX) return;
	host.sql.exec(
		'INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING',
		path,
		host.nowMs()
	);
	host.armFillAlarm();
}

/** rows waiting in the fill queue */
export function queueDepth(host: FillQueueHost): number {
	host.ensureServeTables();
	return Number(
		firstRow(host.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_fill_queue'))
			?.c ?? 0
	);
}

/**
 * Whether this alarm firing should spend rows on garbage collection.
 *
 * Fills and GC share the rows-written meter, so a waiting page outranks reclaiming disk; the
 * interval gate exists because the measured steady state is 0 rows written.
 */
export function shouldRunGc(host: FillQueueHost): boolean {
	const everyMs = Number(host.env?.GC_INTERVAL_MS ?? 3_600_000);
	if (!host.serveTablesReady) return false;
	const queued = firstRow(
		host.sql.exec<Row<{ n: number }>>('SELECT count(*) AS n FROM cfw_fill_queue')
	)?.n;
	if (Number(queued ?? 0) > 0) return false;
	return !host.lastGcAt || Date.now() - host.lastGcAt >= everyMs;
}

/**
 * Row count for a table that may not exist yet. null rather than 0: several Drupal tables are
 * created lazily on first write, and 0 for a missing one reads as a verified invariant.
 */
export function countOrNull(host: FillQueueHost, table: string, where?: string): number | null {
	try {
		// `where` is a literal from this file only (no bind slot for a predicate)
		const sql = `SELECT count(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`;
		return firstRow(host.sql.exec<Row<{ n: number }>>(sql))?.n ?? null;
	} catch {
		return null;
	}
}

/**
 * Records whether a path can be stored at all; only an anonymous render Drupal itself refused
 * counts (a cookie, redirect or 500 is transient).
 */
export function noteStorable(
	host: FillQueueHost,
	path: string,
	cacheable: boolean,
	refused: boolean,
	anonymous: boolean
): void {
	const unstorable = !cacheable && refused && anonymous;
	const held = new Set(unstorablePaths(host));
	if (unstorable === held.has(path)) return;
	if (unstorable) held.add(path);
	else held.delete(path);
	// bounded: past this a cold boot per path is not worth it
	host.metaSet(UNSTORABLE_KEY, [...held].slice(-64).join('\n'));
}

/** the paths a render has proven cannot be stored */
export function unstorablePaths(host: FillQueueHost): string[] {
	return (host.metaGet(UNSTORABLE_KEY) || '').split('\n').filter((p) => p !== '');
}

/** whether the fill chain has already proven it cannot satisfy this path */
export function isUnstorable(host: FillQueueHost, path: string): boolean {
	return unstorablePaths(host).includes(path);
}

/** records that an attempt's PHP is about to run, dropping markers past their ttl */
export function markAttempt(host: FillQueueHost, key: string): void {
	const now = host.nowMs();
	host.ensureServeTables();
	host.sql.exec(
		"DELETE FROM cfw_meta WHERE k >= 'attempt:' AND k < 'attempt;' AND CAST(v AS INTEGER) < ?",
		now - ATTEMPT_TTL_MS
	);
	host.metaSet(key, now);
}

/**
 * Appends the disposable rows a forwarded batch carried, outside its transaction; a failure
 * drops only that row, and nothing is buffered for replication.
 */
export function appendDeferred(
	host: FillQueueHost,
	statements: readonly ForwardStatement[]
): number {
	let appended = 0;
	for (const s of statements) {
		try {
			host.sql.exec(s.sql, ...(s.params ?? []));
			appended++;
		} catch {
			// a lost log row is the whole cost
		}
	}
	return appended;
}

/**
 * Queues a public image for its styles to be rendered ahead of the first view (derivatives and
 * Drupal's styles directory are not sources).
 */
export function queueDerivatives(host: FillQueueHost, uri: string): void {
	if (!eagerDerivativesEnabled(host.env as never)) return;
	if (!/^public:\/\/.+\.(jpe?g|png|gif|webp|avif)$/i.test(uri)) return;
	if (uri.startsWith('public://styles/') || uri.startsWith('public://cfw-derivatives/')) return;
	host.sql.exec(
		'CREATE TABLE IF NOT EXISTS cfw_derive_queue (uri TEXT PRIMARY KEY, queued_at INTEGER NOT NULL)'
	);
	host.sql.exec(
		'INSERT OR REPLACE INTO cfw_derive_queue (uri, queued_at) VALUES (?, ?)',
		uri,
		host.nowMs()
	);
	void host.armFillAlarm(1000);
}

/**
 * The key N concurrent identical requests share, or undefined when they may not be coalesced.
 *
 * The cookie is in the key, so one visitor's page is never handed to another. Serving GETs
 * only.
 */
export function herdKeyFor(host: FillQueueHost, request: Request, url: URL): string | undefined {
	if (request.method !== 'GET') return undefined;
	if (url.pathname !== '/__serve') return undefined;
	if (url.searchParams.get('lane') === 'gate') return undefined;
	const path = url.searchParams.get('path') ?? '/';
	// an anonymous request is already answered by the fast lane above without entering the gate
	const cookie = request.headers.get('cookie') ?? '';
	if (!hasSessionCookie(cookie)) return undefined;
	return `${host.generation()} ${path} ${cookie}`;
}

/**
 * When this page became superseded, derived from tag state rather than written per save.
 *
 * A marked row answers at once; an unmarked one is checked against its tags' invalidation sum
 * and marked if it moved (2 rows instead of 34 per save). Undefined with no usable checksum,
 * which `bumpGeneration()` marks eagerly.
 */
export function pageStaleness(
	host: FillQueueHost,
	path: string,
	row: { stale_at?: number | null; tags?: unknown; tag_checksum?: number | null }
): number | undefined {
	if (typeof row.stale_at === 'number') return row.stale_at;
	const stored = typeof row.tag_checksum === 'number' ? row.tag_checksum : undefined;
	if (stored === undefined) return undefined;
	const tags = readTagList(row.tags);
	if (!tags || tags.length === 0) return undefined;
	if (tagChecksum(host.sql, tags) === stored) return undefined;
	const now = host.nowMs();
	// the one write, taken at the transition rather than at the save
	host.sql.exec(
		'UPDATE cfw_page SET stale_at = ? WHERE path = ? AND stale_at IS NULL',
		now,
		path
	);
	return now;
}

/**
 * The aggregate manifest from the `ASSETS` binding, or undefined; memoised per incarnation,
 * absence included.
 */
export async function aggregateIndex(host: FillQueueHost): Promise<AggregateIndex | undefined> {
	if (host.aggregates.read) return host.aggregates.index;
	host.aggregates.read = true;
	try {
		const assets = (host.env as { ASSETS?: { fetch: (r: Request) => Promise<Response> } })
			?.ASSETS;
		if (!assets) return undefined;
		const res = await assets.fetch(new Request('https://assets.local/agg/manifest.json'));
		if (!res.ok) return undefined;
		const parsed = (await res.json()) as AggregateIndex;
		if (parsed?.libraries && parsed?.files) host.aggregates.index = parsed;
	} catch {
		// an absent or unreadable manifest is "no aggregation", never a failed render
	}
	return host.aggregates.index;
}
