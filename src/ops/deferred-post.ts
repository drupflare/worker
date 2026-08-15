/**
 * The deferred tier for POSTs.
 *
 * A POST differs from a GET in three ways that all have to be answered, and a fourth that is really
 * the product question. Each is handled below and none is left implicit.
 */

/** methods that may be replayed without changing what the far end has done */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/**
 * The largest body that may be deferred.
 *
 * The key embeds the body verbatim (see `deferredKey`), and the key is a SQLite PRIMARY KEY, so an
 * unbounded body would put an unbounded value in an index. 8 KiB is far above any verification
 * payload -- a reCAPTCHA `siteverify` POST is about 200 bytes -- and far below the 2,199,995-byte
 * Durable Object record ceiling.
 */
export const MAX_DEFERRED_BODY = 8192;

/** how long a deferred POST result stays usable, in ms */
export const DEFAULT_POST_TTL_MS = 120_000;

/** a GET result has no natural expiry; this is the cap so the table cannot grow without bound */
export const DEFAULT_GET_TTL_MS = 3_600_000;

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
 * The cache key for a deferred request.
 *
 * **IT IS NOT A HASH, AND THAT IS THE DELIBERATE CHOICE.** The obvious design is
 * `hash(method + url + body)`, and both available hashes are wrong here:
 *
 *   - A NON-CRYPTOGRAPHIC hash (FNV-1a, djb2) is forgeable. This key decides which cached response
 *     a verification reads, so an attacker who can craft a body that collides with a known-good
 *     verification gets that success served to their own submission. A captcha bypass through a
 *     hash collision is a worse bug than the one the tier exists to fix.
 *   - A CRYPTOGRAPHIC hash cannot be computed here. `crypto.subtle.digest` is async, and this key
 *     has to be derived inside the synchronous `cfwQueueFetch` and `cfwHttpCacheGet` calls that PHP
 *     makes. Shipping a synchronous SHA-256 to avoid that is a lot of code to reintroduce a
 *     collision domain that does not have to exist.
 *
 * So the key is the exact tuple, LENGTH-PREFIXED. Collisions are impossible by construction rather
 * than improbable, the derivation is trivially synchronous, and the cost is index size -- bounded by
 * `MAX_DEFERRED_BODY`.
 *
 * **The length prefix is the security property, and a separator is not good enough.** The first
 * version joined the fields with a NUL, reasoning that a NUL cannot appear in a method or a URL. It
 * can appear in a BODY, and a body is attacker-controlled: two different (url, body) pairs can be
 * made to serialise identically by moving the separator between them. That is the
 * forgeable-collision hole this function exists to close, reintroduced by its own encoding, and the
 * spec case named for it is what caught it.
 *
 * Length prefixes make the encoding injective for ANY field contents, because nothing has to guess
 * where a field ends.
 */
export function deferredKey(method: string, url: string, body = ''): string {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(body).length;
	if (bytes > MAX_DEFERRED_BODY) throw new DeferredBodyTooLarge(bytes);
	const upper = method.toUpperCase();
	// BYTE lengths, not code-unit lengths, so the prefix describes what was actually encoded
	return (
		`${encoder.encode(upper).length}:${upper}` +
		`${encoder.encode(url).length}:${url}` +
		`${bytes}:${body}`
	);
}

/** whether a queued request may be attempted again after a failure */
export function isIdempotent(method: string): boolean {
	return IDEMPOTENT.has(method.toUpperCase());
}

/**
 * How many times a queued request may be attempted, in total.
 *
 * **A POST GETS EXACTLY ONE ATTEMPT.** The existing GET drain retries three times, which is correct
 * for a GET and is a live defect for a POST: a reCAPTCHA token is single-use, so a retried
 * verification is rejected by Google as already-redeemed and the visitor is told they failed a
 * captcha they passed. Worse, the retry is invisible -- the first attempt may well have SUCCEEDED at
 * the far end and only failed to return, so retrying converts a network blip into a definite
 * rejection.
 *
 * One attempt means a failure is reported as a failure rather than laundered into a wrong answer.
 */
export function attemptBudget(method: string): number {
	return isIdempotent(method) ? 3 : 1;
}

/**
 * How long a result stays usable.
 *
 * **A cached POST response that outlives its meaning is a security bug, not a stale page.** A
 * verification says "this token was valid a moment ago"; served an hour later it says nothing, and
 * serving it anyway is a replay window. Two minutes matches the lifetime of the tokens this is
 * built for and is short enough that a leaked cache entry is not worth harvesting.
 */
export function ttlFor(method: string): number {
	return isIdempotent(method) ? DEFAULT_GET_TTL_MS : DEFAULT_POST_TTL_MS;
}

export interface CacheEntry {
	status: number;
	headers: Record<string, string>;
	body: string;
	fetchedAt: number;
	expiresAt: number;
}

/** whether an entry may still be served; an absent expiry is treated as expired, never as forever */
export function isFresh(entry: Pick<CacheEntry, 'expiresAt'> | null, nowMs: number): boolean {
	if (entry === null) return false;
	if (!Number.isFinite(entry.expiresAt)) return false;
	return entry.expiresAt > nowMs;
}

/**
 * What a caller should do with a deferred request right now.
 *
 * This is the fourth problem and the one that decides whether the feature is usable: **the first
 * request cannot have the answer.** The queue drains on an alarm, so the synchronous read on the
 * first attempt necessarily misses.
 *
 * The states are deliberately few, because the Drupal-side shim has to act on them inside a form
 * validator with no ability to wait:
 *
 *   - `miss`      nothing queued; queue it and tell the caller to come back
 *   - `pending`   queued, not yet drained; come back
 *   - `ready`     a fresh result is available; consume it
 *   - `expired`   a result existed and is too old to mean anything; re-queue rather than serve it
 *   - `failed`    the attempt budget is spent; this is a definite no, not a "try again"
 *
 * `failed` being distinct from `pending` is what stops a form retrying forever against an endpoint
 * that is down.
 */
export type DeferredState = 'miss' | 'pending' | 'ready' | 'expired' | 'failed';

export interface DeferredStatus {
	state: DeferredState;
	/** ms the caller should wait before asking again; 0 when there is nothing to wait for */
	retryAfterMs: number;
	entry: CacheEntry | null;
	reason: string;
}

export interface QueueRow {
	attempts: number;
	method: string;
	lastError?: string | null;
}

/**
 * Decides the state from what the tables hold.
 *
 * Pure, so the whole state machine is testable without a Durable Object, an alarm or a socket --
 * which matters because the interesting cases are the ones that are awkward to reach live: an entry
 * that expired between the queue and the read, and a queue row whose budget is spent.
 */
export function deferredStatus(
	entry: CacheEntry | null,
	queued: QueueRow | null,
	nowMs: number,
	/** how soon the alarm will run again; the drain re-arms at +1 ms while the queue is non-empty */
	alarmDelayMs = 1
): DeferredStatus {
	if (entry !== null && isFresh(entry, nowMs)) {
		return { state: 'ready', retryAfterMs: 0, entry, reason: 'a fresh result is cached' };
	}
	if (queued !== null) {
		const budget = attemptBudget(queued.method);
		if (queued.attempts >= budget) {
			return {
				state: 'failed',
				retryAfterMs: 0,
				entry: null,
				reason:
					`the attempt budget of ${budget} for ${queued.method.toUpperCase()} is spent` +
					(queued.lastError ? `: ${queued.lastError}` : '')
			};
		}
		return {
			state: 'pending',
			retryAfterMs: alarmDelayMs,
			entry: null,
			reason: `queued, attempt ${queued.attempts + 1} of ${budget}, draining on the next alarm`
		};
	}
	if (entry !== null) {
		return {
			state: 'expired',
			retryAfterMs: alarmDelayMs,
			entry: null,
			// never served: a verification past its TTL is a replay window, not a stale page
			reason: 'a result exists but is past its TTL; serving it would be a replay window, so it is re-queued rather than served'
		};
	}
	return { state: 'miss', retryAfterMs: alarmDelayMs, entry: null, reason: 'nothing queued yet' };
}

/**
 * The visitor experience, named rather than left to whoever writes the shim.
 *
 * A form POST whose validator needs a deferred verification has exactly three honest options, and
 * only one of them is not broken:
 *
 *   1. **Reject the submission.** The visitor passed the captcha and is told they failed. Never.
 *   2. **Block the render until the alarm drains.** Impossible: the run is synchronous.
 *   3. **Re-submit once, automatically.** The validator queues the verification, marks the form
 *      "awaiting verification", and the response re-posts the same form after `retryAfterMs`. The
 *      second submission finds the result cached and completes.
 *
 * Three is what this returns. The visitor sees one extra round trip on submit and no error. The
 * added latency is one alarm cycle plus one HTTP round trip -- a WALL-CLOCK quantity, and per RULE 0
 * no CPU figure can be derived from it.
 *
 * The token survives the round trip because the SAME token is re-posted: the key is the exact
 * tuple, so the second submission hits the entry the first one queued. A shim that minted a new
 * token on re-submit would miss the cache every time and loop forever, which is the one way to get
 * this wrong.
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
