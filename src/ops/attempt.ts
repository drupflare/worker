/**
 * Lets the front worker repeat an unsafe request whose object was reset, when nothing of it landed.
 *
 * The object records the attempt id before the request's PHP runs. Durable Object writes commit in
 * order, so a durable write from that request implies a durable marker, and an outbound subrequest
 * cannot leave before earlier writes are confirmed (the output gate). No marker therefore means no
 * write and no side effect, and a repeat is the first run rather than a second one. A repeat that
 * finds the marker is refused, which is what every reset POST got before this.
 *
 * Only the serve route takes part, because only its handler writes the marker; any other route
 * would run twice.
 */
export const ATTEMPT_HEADER = 'x-cfw-attempt';

/** how long a marker is kept; a repeat follows its reset within seconds */
export const ATTEMPT_TTL_MS = 10 * 60_000;

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** the `cfw_meta` key for an attempt, or null when the header is not an id the front worker mints */
export function attemptKey(id: string | null | undefined): string | null {
	return id && ATTEMPT_ID.test(id) ? `attempt:${id}` : null;
}
