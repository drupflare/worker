/**
 * Which platform limit a failed invocation hit, when it hit one.
 *
 * A counter, not a handler: nothing here retries or reshapes a request. Dynamic Worker concurrency
 * is deliberately absent (no worker-loader binding or dispatch namespace, so it cannot bind); the
 * `io-context` class can appear (a long-lived interpreter holding a socket outlives a request).
 * @module
 */

/** the classes worth telling apart; anything else is `other`, a message-less throw is `silent` */
export type LimitClass =
	/** an I/O object used from a request other than the one that created it */
	| 'io-context'
	/** more outbound fetches than the invocation is allowed */
	| 'subrequest-limit'
	/** the isolate went over its memory limit between invocations, so the platform named it */
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
	 * The shape of an isolate memory kill inside one invocation (four fresh sites, cpuTime
	 * 2,213-4,944 ms); folding it into `other` would hide it.
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
 * Order matters where messages overlap: a storage reset after a memory kill mentions both and
 * counts as the memory limit (the reset is the consequence).
 */
export function classifyLimit(error: unknown): LimitClass {
	// read the message field, not `String(error)`: `String({})` is '[object Object]', not empty
	const raw =
		typeof error === 'string' ? error : (error as { message?: unknown } | null)?.message;
	const message = typeof raw === 'string' ? raw.trim() : '';
	if (message === '') return 'silent';
	for (const { kind, re } of PATTERNS) if (re.test(message)) return kind;
	return 'other';
}

/** failures counted per limit class */
export type LimitTally = Partial<Record<LimitClass, number>>;

/** counts one failure; returns the tally so a caller can keep it in a field without a null dance */
export function noteLimit(tally: LimitTally, error: unknown): LimitTally {
	const kind = classifyLimit(error);
	tally[kind] = (tally[kind] ?? 0) + 1;
	return tally;
}

/**
 * Whether a tally holds anything that indicates a platform ceiling rather than a site bug.
 *
 * `other` is excluded (ordinary exceptions would bury the rare classes); `silent` is included.
 */
export function hitAnyLimit(tally: LimitTally): boolean {
	return (Object.keys(tally) as LimitClass[]).some((k) => k !== 'other' && (tally[k] ?? 0) > 0);
}
