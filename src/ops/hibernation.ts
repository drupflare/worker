/**
 * Whether a Durable Object is eligible to hibernate, which is what decides whether it is billed for
 * duration while idle.
 *
 * "Durable Objects that are idle and eligible for hibernation are not billed for duration, even
 * before the runtime has hibernated them." So eligibility -- not hibernation itself -- is the
 * billing boundary, and it is a property of what the code left open rather than of how long the
 * object sat there.
 *
 * WHY THIS IS A MODULE AND NOT A COMMENT. Replicas were closed on "two always-warm objects exceed
 * the free duration allowance", which is true and which closed them entirely. A replica that
 * HIBERNATES accrues no idle duration at all, so the arithmetic never applied to it -- and nothing
 * in the codebase could say which of the two a given design was, because the conditions lived in a
 * document. {@link hibernationEligible} makes it answerable.
 *
 * THE CONDITIONS ARE CLOUDFLARE'S, quoted from the lifecycle page rather than inferred:
 * hibernation requires ALL of no `setTimeout`/`setInterval`, no in-progress awaited `fetch()`, no
 * standard WebSocket API, no request still being processed, and no active outbound TCP socket
 * (`connect()`) or outbound WebSocket.
 *
 * A PENDING ALARM IS NOT ON THAT LIST, which is the reading that matters here. The keep-warm chain
 * arms an alarm and nothing else, so it does NOT hold the object resident and does NOT accrue
 * duration -- it costs a row per arm and buys no warmth. That is the opposite of what "keep-warm"
 * suggests and it was worth measuring before designing around it.
 */

/** what a caller left open at the moment the object went idle */
export type ResidencyState = {
	/** a `setTimeout` or `setInterval` callback that has not fired */
	pendingTimer?: boolean;
	/** an awaited `fetch()` still in flight */
	inflightFetch?: boolean;
	/** the standard WebSocket API, as opposed to the hibernatable one */
	standardWebSocket?: boolean;
	/** a request or event whose handler has not returned */
	requestInFlight?: boolean;
	/** an outbound TCP socket from `connect()`, or an outbound WebSocket */
	outboundSocket?: boolean;
	/** an armed alarm; deliberately present and deliberately not disqualifying */
	pendingAlarm?: boolean;
};

/** every condition that disqualifies, in Cloudflare's own terms */
const DISQUALIFIERS = [
	['pendingTimer', 'a setTimeout/setInterval callback cannot be recreated after hibernating'],
	['inflightFetch', 'an awaited fetch() counts as waiting for I/O'],
	[
		'standardWebSocket',
		'the standard WebSocket API blocks hibernation; the hibernatable one does not'
	],
	['requestInFlight', 'hibernating would lose the async function owing a response'],
	['outboundSocket', 'an outbound TCP socket or WebSocket keeps the object resident']
] as const satisfies ReadonlyArray<readonly [keyof ResidencyState, string]>;

/** each outbound connection defers eviction for at most this long, per Cloudflare's lifecycle page */
export const OUTBOUND_PIN_SECONDS = 15 * 60;

/** idle wait before a NON-eligible object is evicted outright; a range, so both ends are carried */
export const EVICT_AFTER_SECONDS = { min: 70, max: 140 };

export type Eligibility = {
	eligible: boolean;
	/** why not, in Cloudflare's terms; empty when eligible */
	blockedBy: string[];
};

/**
 * Score one idle moment.
 *
 * Absent keys read as false: the common case is an object that finished a request and left nothing
 * open, and requiring every field to be spelled out would make the default the wrong answer.
 */
export function hibernationEligible(state: ResidencyState = {}): Eligibility {
	const blockedBy = DISQUALIFIERS.filter(([key]) => state[key] === true).map(([, why]) => why);
	return { eligible: blockedBy.length === 0, blockedBy };
}

/**
 * Seconds of billed duration one idle period costs, given what was left open.
 *
 * NOT a wall-clock reading and never derived from one -- RULE 0. This is the PLATFORM's rule applied
 * to a state, so it answers "what does this design cost" rather than "what did this run cost". The
 * deployed number comes from `duration` on `durableObjectsPeriodicGroups`.
 *
 * @param state what the object left open.
 * @param outboundHeldSeconds how long an outbound socket stayed open, if one did.
 */
export function idleBilledSeconds(state: ResidencyState, outboundHeldSeconds = 0): number {
	// zero, not the ~10 s wait before it actually hibernates: Cloudflare does not bill an idle
	// object that is ELIGIBLE, so the wait is not a billing input
	if (hibernationEligible(state).eligible) return 0;
	// an outbound connection defers eviction until it closes AND the inactivity window elapses,
	// capped at 15 minutes of pinning per connection
	const pinned = Math.min(outboundHeldSeconds, OUTBOUND_PIN_SECONDS);
	return pinned + EVICT_AFTER_SECONDS.min;
}
