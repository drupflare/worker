/**
 * Lets the front worker repeat an unsafe request whose object was reset, when nothing of it landed.
 *
 * The object records the attempt id before the request's PHP runs. Durable Object writes commit in
 * order and the output gate holds subrequests, so no marker means no write and no side effect; a
 * repeat that finds the marker is refused. Only the serve route writes the marker, so only it takes
 * part (any other route would run twice).
 * @module
 */

/** the request header carrying the front worker's attempt id */
export const ATTEMPT_HEADER = 'x-cfw-attempt';

/** how long a marker is kept; a repeat follows its reset within seconds */
export const ATTEMPT_TTL_MS = 10 * 60_000;

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** the `cfw_meta` key for an attempt, or undefined when the header is not a minted id */
export function attemptKey(id: string | null | undefined): string | undefined {
	return id && ATTEMPT_ID.test(id) ? `attempt:${id}` : undefined;
}
