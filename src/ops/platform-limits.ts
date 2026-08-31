/**
 * Which platform limit a failed invocation hit, when it hit one.
 *
 * A COUNTER, not a handler. Nothing here retries, degrades or reshapes a request; the question it
 * answers is whether a limit appears in the request path at all, and at what rate. That question was
 * previously answered by reading the platform's documentation, which says what the limits ARE and
 * nothing about which of them this workload reaches.
 *
 * **Dynamic Worker concurrency is not among these, and the reason is worth keeping.** Cloudflare
 * raised the number of distinct Dynamic Workers one Durable Object may run concurrently, which would
 * matter to a design that loaded code per request. This one has no worker-loader binding and no
 * dispatch namespace, so that limit cannot bind here no matter what the number is. The general
 * `io-context` class below is a different failure and CAN appear: it fires when an I/O object
 * outlives the request that created it, which a long-lived interpreter holding a socket is exactly
 * the shape to do.
 */

/** the classes worth telling apart; everything else is `other` and a message-less throw is `silent` */
export type LimitClass =
	/** an I/O object used from a request other than the one that created it */
	| 'io-context'
	/** more outbound fetches than the invocation is allowed */
	| 'subrequest-limit'
	/** the isolate went over its memory limit BETWEEN invocations, so the platform named it */
	| 'memory-limit'
	/** the storage layer reset the object, which follows a memory kill */
	| 'storage-reset'
	/** CPU or wall-clock */
	| 'time-limit'
	/** an output gate failure, which means a write did not commit */
	| 'output-gate'
	/**
	 * thrown with no message and no stack.
	 *
	 * NOT a catch-all. This is the observed shape of an isolate memory kill that happens INSIDE one
	 * invocation rather than between two: measured on four freshly provisioned sites, cpuTime
	 * 2,213-4,944 ms and nothing else. Folding it into `other` would hide the one class that has
	 * already taken sites down.
	 */
	| 'silent'
	| 'other';

const PATTERNS: readonly { kind: LimitClass; re: RegExp }[] = [
	{ kind: 'io-context', re: /different request|I\/O on behalf of|invalid I\/O context/i },
	{ kind: 'subrequest-limit', re: /too many subrequests/i },
	{ kind: 'memory-limit', re: /exceeded its memory limit|memory limit/i },
	{ kind: 'storage-reset', re: /storage caused object to be reset|object was reset/i },
	{ kind: 'time-limit', re: /exceeded cpu|cpu time limit|exceeded resource limits|time limit/i },
	{ kind: 'output-gate', re: /output gate/i }
];

/**
 * Names the limit an error represents.
 *
 * Order matters only where messages overlap: a storage reset that follows a memory kill mentions
 * both, and attributing it to the memory limit is the true reading -- the reset is the consequence.
 */
export function classifyLimit(error: unknown): LimitClass {
	// read the message FIELD rather than stringifying the throw: `String({})` is '[object Object]',
	// which is not empty and would read a message-less throw as an ordinary one
	const raw =
		typeof error === 'string' ? error : (error as { message?: unknown } | null)?.message;
	const message = typeof raw === 'string' ? raw.trim() : '';
	if (message === '') return 'silent';
	for (const { kind, re } of PATTERNS) if (re.test(message)) return kind;
	return 'other';
}

export type LimitTally = Partial<Record<LimitClass, number>>;

/** counts one failure; returns the tally so a caller can keep it in a field without a null dance */
export function noteLimit(tally: LimitTally, error: unknown): LimitTally {
	const kind = classifyLimit(error);
	tally[kind] = (tally[kind] ?? 0) + 1;
	return tally;
}

/**
 * Whether a tally holds anything that indicates a platform ceiling rather than a bug in the site.
 *
 * `other` is excluded: an ordinary application exception is by far the most common throw
 * and counting it here would bury the rare classes in noise. `silent` IS included, because a
 * message-less throw is not an ordinary exception.
 */
export function hitAnyLimit(tally: LimitTally): boolean {
	return (Object.keys(tally) as LimitClass[]).some((k) => k !== 'other' && (tally[k] ?? 0) > 0);
}
