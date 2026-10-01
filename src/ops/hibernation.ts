/**
 * Whether a Durable Object is eligible to hibernate, which decides whether it is billed for
 * duration while idle (eligibility, not hibernation itself, is the billing boundary).
 *
 * Cloudflare's conditions: no `setTimeout`/`setInterval`, no awaited `fetch()` in flight, no
 * standard WebSocket API, no request in progress and no outbound TCP socket or WebSocket. A pending
 * alarm is not on the list, so a waiting object accrues no duration (warming costs requests, rows).
 *
 * Arming does not warm; the firing does, and only under the threshold: re-armed every 8 s one
 * incarnation survived 71 alarms, while at 12, 20, 30 and 45 s the constructor ran again on every
 * probe (each firing resets the 10 s idle clock). See `HIBERNATION_IDLE_MS` in `./cron.ts`.
 * @module
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
	/** an armed alarm; present here and not disqualifying */
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

/** how long each outbound connection can defer eviction, per Cloudflare's lifecycle page */
export const OUTBOUND_PIN_SECONDS = 15 * 60;

/** idle wait before a non-eligible object is evicted (a range, so both ends are carried) */
export const EVICT_AFTER_SECONDS = { min: 70, max: 140 };

/** whether an idle object may hibernate, and what blocks it */
export type Eligibility = {
	eligible: boolean;
	/** why not, in Cloudflare's terms; empty when eligible */
	blockedBy: string[];
};

/**
 * Score one idle moment.
 *
 * Absent keys read as false (the common case is an object that left nothing open).
 */
export function hibernationEligible(state: ResidencyState = {}): Eligibility {
	const blockedBy = DISQUALIFIERS.filter(([key]) => state[key] === true).map(([, why]) => why);
	return { eligible: blockedBy.length === 0, blockedBy };
}

/**
 * Seconds of billed duration one idle period costs, given what was left open.
 *
 * The platform's rule applied to a state, never a wall-clock reading; the deployed number comes
 * from `duration` on `durableObjectsPeriodicGroups`.
 *
 * @param state what the object left open.
 * @param outboundHeldSeconds how long an outbound socket stayed open, if one did.
 */
export function idleBilledSeconds(state: ResidencyState, outboundHeldSeconds = 0): number {
	// zero, not the ~10 s wait: an eligible idle object is not billed
	if (hibernationEligible(state).eligible) return 0;
	// an outbound connection defers eviction until it closes and the idle window passes (15 min)
	const pinned = Math.min(outboundHeldSeconds, OUTBOUND_PIN_SECONDS);
	return pinned + EVICT_AFTER_SECONDS.min;
}
