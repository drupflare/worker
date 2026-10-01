/**
 * The deferred tier for POSTs: queue a request, answer it on the alarm, replay it at most once.
 * @module
 */

/** methods that may be replayed without changing what the far end has done */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/**
 * The largest body that may be deferred.
 *
 * The key embeds the body verbatim and is a SQLite primary key, so the body is capped at 8 KiB
 * (a `siteverify` POST is about 200 bytes; the Durable Object record ceiling is 2,199,995).
 */
export const MAX_DEFERRED_BODY = 8192;

/** how long a deferred POST result stays usable, in ms */
export const DEFAULT_POST_TTL_MS = 120_000;

/** a GET result has no natural expiry; this is the cap so the table cannot grow without bound */
export const DEFAULT_GET_TTL_MS = 3_600_000;

/**
 * Freshness for GETs whose consumer runs on the cron chain.
 *
 * The observed cron period is hours (`announcements_feed` gaps were 8,142 to 26,033 s), so a
 * one hour TTL expired every entry before anything asked; a day outlives `update`'s own 24 hours.
 */
const CRON_FETCH_TTL_MS = 86_400_000;

const CRON_FETCH_URLS = [
	'://updates.drupal.org/release-history',
	'://www.drupal.org/announcements.json',
	'://updates.drupal.org/psa.json'
];

/**
 * How long past `expiresAt` an entry may still be handed to a caller that would otherwise throw.
 *
 * Idempotent methods only: a stale POST result is a replay window.
 */
export const STALE_SERVE_WINDOW_MS = 604_800_000;

/** thrown by `deferredKey` when the body exceeds `MAX_DEFERRED_BODY`; carries the byte count */
export class DeferredBodyTooLarge extends Error {
	constructor(readonly bytes: number) {
		super(
			`a deferred request body of ${bytes} bytes exceeds the ${MAX_DEFERRED_BODY}-byte limit; ` +
				'the body is part of the cache key and the key is an index entry'
		);
		this.name = 'DeferredBodyTooLarge';
	}
}

/**
 * The cache key for a deferred request: the exact tuple, length-prefixed, not a hash.
 *
 * A non-cryptographic hash is forgeable and `crypto.subtle.digest` is async, while the key is
 * derived inside synchronous host calls. The length prefix makes the encoding injective for any
 * field contents; a separator is not enough because a body (attacker-controlled) can contain it.
 */
export function deferredKey(
	method: string,
	url: string,
	body = '',
	headers: Record<string, string> = {}
): string {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(body).length;
	if (bytes > MAX_DEFERRED_BODY) throw new DeferredBodyTooLarge(bytes);
	const upper = method.toUpperCase();
	// byte lengths, not code-unit lengths, so the prefix describes what was encoded
	const base =
		`${encoder.encode(upper).length}:${upper}` +
		`${encoder.encode(url).length}:${url}` +
		`${bytes}:${body}`;

	// nothing appended without headers, so older keys keep naming the same entry (still injective)
	const canonical = canonicalHeaders(headers);
	if (canonical.length === 0) return base;
	let segment = `${canonical.length}:`;
	for (const [name, value] of canonical) {
		segment +=
			`${encoder.encode(name).length}:${name}` + `${encoder.encode(value).length}:${value}`;
	}
	return base + segment;
}

/** headers `fetch()` computes itself; never keyed or sent (sending one is ignored or an error) */
const TRANSPORT_OWNED = new Set([
	'host',
	'content-length',
	'connection',
	'transfer-encoding',
	'keep-alive',
	'upgrade'
]);

/**
 * Sent, but not part of the key.
 *
 * `user-agent` names the client library (Guzzle sends one, a bare `file_get_contents()` none), so
 * keying on it would split one URL into a row per client. Keep this list small: under-keying serves
 * one caller's authenticated response to another, over-keying only costs a fetch.
 */
const NOT_KEYED = new Set(['user-agent']);

/**
 * Lowercases, sorts and drops, so equivalent header sets give one key in any order.
 *
 * A duplicate name after lowercasing keeps the last value, as `Headers.set()` does.
 */
function canonicalise(
	headers: Record<string, string>,
	drop: (name: string) => boolean
): Array<[string, string]> {
	const seen = new Map<string, string>();
	for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
		const name = String(rawName).trim().toLowerCase();
		if (name === '' || drop(name)) continue;
		seen.set(name, String(rawValue ?? ''));
	}
	return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** the set the key is derived from: what the caller chose that changes who or what is asked */
export function canonicalHeaders(headers: Record<string, string>): Array<[string, string]> {
	return canonicalise(headers, (n) => TRANSPORT_OWNED.has(n) || NOT_KEYED.has(n));
}

/** the set that goes on the wire; larger than the keyed set (`user-agent` is sent, not keyed) */
export function headersToSend(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(canonicalise(headers, (n) => TRANSPORT_OWNED.has(n)));
}

/**
 * Narrows a host-call payload's `headers` member to a string map.
 *
 * PHP builds it, so anything can arrive; non-strings are stringified, never dropped, because a
 * dropped header silently changes the request.
 */
export function requestHeaders(payload: { headers?: unknown }): Record<string, string> {
	const raw = payload?.headers;
	if (!raw || typeof raw !== 'object') return {};
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (value === null || value === undefined) continue;
		// a repeated header arrives as a list; comma-join is how HTTP folds one anyway
		out[name] = Array.isArray(value) ? value.map(String).join(', ') : String(value);
	}
	return out;
}

/** whether a queued request may be attempted again after a failure */
export function isIdempotent(method: string): boolean {
	return IDEMPOTENT.has(method.toUpperCase());
}

/**
 * How many times a queued request may be attempted: 3 for idempotent methods, 1 for a POST.
 *
 * A retried POST can be rejected as already redeemed (a reCAPTCHA token is single-use) after the
 * first attempt succeeded at the far end and only failed to return.
 */
export function attemptBudget(method: string): number {
	return isIdempotent(method) ? 3 : 1;
}

/**
 * How long a result stays usable.
 *
 * A POST result is short-lived on purpose: past the token's lifetime it is a replay window, not a
 * stale page. Two minutes matches the tokens this serves.
 */
export function ttlFor(method: string, url = ''): number {
	if (!isIdempotent(method)) return DEFAULT_POST_TTL_MS;
	return CRON_FETCH_URLS.some((u) => url.includes(u)) ? CRON_FETCH_TTL_MS : DEFAULT_GET_TTL_MS;
}

/**
 * The oldest an entry may be and still be served to a caller that would otherwise throw.
 *
 * Zero for anything non-idempotent, so a POST result can never be replayed past its own TTL.
 */
export function staleWindowFor(method: string): number {
	return isIdempotent(method) ? STALE_SERVE_WINDOW_MS : 0;
}

/** whether an entry is stale but servable; false for a fresh one ({@link isFresh} owns that) */
export function isServableStale(
	entry: Pick<CacheEntry, 'expiresAt'> | undefined,
	nowMs: number,
	method = 'GET'
): boolean {
	if (entry === undefined) return false;
	if (!Number.isFinite(entry.expiresAt)) return false;
	if (entry.expiresAt > nowMs) return false;
	return entry.expiresAt + staleWindowFor(method) > nowMs;
}

/** a stored response; times are epoch ms */
export interface CacheEntry {
	status: number;
	headers: Record<string, string>;
	body: string;
	fetchedAt: number;
	expiresAt: number;
}

/** whether an entry may still be served; an absent expiry counts as expired, not forever */
export function isFresh(entry: Pick<CacheEntry, 'expiresAt'> | undefined, nowMs: number): boolean {
	if (entry === undefined) return false;
	if (!Number.isFinite(entry.expiresAt)) return false;
	return entry.expiresAt > nowMs;
}

/**
 * What a caller should do with a deferred request right now (the first request never has the
 * answer; the queue drains on an alarm).
 *
 *   - `miss`      nothing queued; queue it and come back
 *   - `pending`   queued, not yet drained; come back
 *   - `ready`     a fresh result is available; consume it
 *   - `expired`   a result existed but is too old; re-queue rather than serve it
 *   - `failed`    the attempt budget is spent; a definite no (stops a form retrying forever)
 */
export type DeferredState = 'miss' | 'pending' | 'ready' | 'expired' | 'failed';

/** the verdict `deferredStatus` returns for one request */
export interface DeferredStatus {
	state: DeferredState;
	/** ms the caller should wait before asking again; 0 when there is nothing to wait for */
	retryAfterMs: number;
	entry?: CacheEntry;
	reason: string;
}

/** the queue-table fields `deferredStatus` reads */
export interface QueueRow {
	attempts: number;
	method: string;
	lastError?: string;
}

/** decides the state from what the tables hold; pure, so testable without an object or alarm */
export function deferredStatus(
	entry: CacheEntry | undefined,
	queued: QueueRow | undefined,
	nowMs: number,
	/** how soon the alarm runs again; the drain re-arms at +1 ms while the queue is non-empty */
	alarmDelayMs = 1
): DeferredStatus {
	if (entry !== undefined && isFresh(entry, nowMs)) {
		return { state: 'ready', retryAfterMs: 0, entry, reason: 'a fresh result is cached' };
	}
	if (queued !== undefined) {
		const budget = attemptBudget(queued.method);
		if (queued.attempts >= budget) {
			return {
				state: 'failed',
				retryAfterMs: 0,
				reason:
					`the attempt budget of ${budget} for ${queued.method.toUpperCase()} is spent` +
					(queued.lastError ? `: ${queued.lastError}` : '')
			};
		}
		return {
			state: 'pending',
			retryAfterMs: alarmDelayMs,
			reason: `queued, attempt ${queued.attempts + 1} of ${budget}, draining on the next alarm`
		};
	}
	if (entry !== undefined) {
		return {
			state: 'expired',
			retryAfterMs: alarmDelayMs,
			// never served: past its TTL a verification is a replay window
			reason: 'a result exists but is past its TTL; serving it would be a replay window, so it is re-queued rather than served'
		};
	}
	return { state: 'miss', retryAfterMs: alarmDelayMs, reason: 'nothing queued yet' };
}

/**
 * The visitor experience for a form whose validator needs a deferred verification: queue it,
 * re-post the same form after `afterMs`, and the second submission finds the result cached.
 *
 * The same token must be re-posted; a new one misses the cache every time and loops forever.
 * The added latency is wall clock (one alarm cycle plus one round trip), not a CPU figure.
 */
export interface ResubmitPlan {
	/** whether the form should re-post itself rather than erroring */
	resubmit: boolean;
	/** how long to wait first */
	afterMs: number;
	/** what to tell the visitor while it happens; empty when nothing should be shown */
	message: string;
	/** how many automatic re-submissions have already happened; the cap stops a loop */
	attempt: number;
}

/** at most this many automatic re-submissions before the visitor is told something is wrong */
export const MAX_RESUBMITS = 2;

/** maps a status to a re-submit decision, giving up after `MAX_RESUBMITS` automatic posts */
export function resubmitPlan(status: DeferredStatus, alreadyResubmitted = 0): ResubmitPlan {
	if (status.state === 'ready') {
		return { resubmit: false, afterMs: 0, message: '', attempt: alreadyResubmitted };
	}
	if (status.state === 'failed') {
		return {
			resubmit: false,
			afterMs: 0,
			message: 'Verification could not be completed. Please try again.',
			attempt: alreadyResubmitted
		};
	}
	if (alreadyResubmitted >= MAX_RESUBMITS) {
		return {
			resubmit: false,
			afterMs: 0,
			// a definite answer beats a spinner: the visitor gets to act rather than wait
			message: 'Verification is taking longer than expected. Please submit again.',
			attempt: alreadyResubmitted
		};
	}
	return {
		resubmit: true,
		afterMs: Math.max(status.retryAfterMs, 1),
		message: '',
		attempt: alreadyResubmitted + 1
	};
}
