/**
 * Counts PHP-to-host crossings, per capability.
 *
 * WHY IT EXISTS: the docs say an RPC method call on a Durable Object stub is its own RPC session
 * and is BILLED AS A DO REQUEST. This project reaches the object through `stub.fetch()`, so one
 * request is one billed request today -- but the PHP-to-host bridge INSIDE the object is a
 * different surface, and nobody had counted it. That number has to exist before any RPC migration,
 * or the migration silently converts a free inner call into a charged request.
 *
 * WHAT A CROSSING IS AND IS NOT. A `cfw*` call is a wasm import resolving to a JavaScript function
 * in the same isolate. It costs CPU and it is NOT a DO request. So this instrument prices a
 * REFACTOR RISK, not a live meter, and anything it reports should be read that way until a build
 * actually moves a capability onto RPC.
 *
 * Wrapping rather than editing each installer, for the reason `countingSql()` gives about the
 * storage handle: an instrument attached to one capability measures that capability, and the
 * question is about the surface. Wrapping the whole surface once means a capability added later is
 * counted without anybody remembering to.
 */

import { recordCrossing, type CensusCall } from './statement-census.js';

/** what the tally hands back: total crossings and the per-capability split */
export type CrossingTally = {
	total: number;
	byName: Record<string, number>;
	/**
	 * per-statement detail, appended only when a caller has armed it with an array.
	 *
	 * Off by default and deliberately not a route: a cold fill crosses 233 times and each record
	 * decodes both sides of the payload, so leaving it on would put a diagnostic's allocation on
	 * every render. `tests/integration/statement-census.spec.ts` is what arms it.
	 */
	calls?: CensusCall[];
};

/** an empty tally; NOT named `emptyTally`, which `write-tally.ts` already exports */
export function emptyCrossings(): CrossingTally {
	return { total: 0, byName: {} };
}

/**
 * Every capability name the host installs on the PHP module.
 *
 * A LIST RATHER THAN A PREFIX SCAN, and the difference is load-bearing: `cfwCanSuspend` is a
 * BOOLEAN the service provider probes, not a function, and wrapping it would hand PHP a callable
 * where it expects a flag -- which reads true and silently installs a handler that cannot work.
 * `wrapCrossings()` skips non-functions anyway; the list is what makes a new capability show up in
 * the reachability check rather than being counted by accident.
 */
export const CROSSING_NAMES = [
	'cfwSqlExec',
	'cfwSqlTxn',
	'cfwZlib',
	'cfwLog',
	'cfwStats',
	'cfwFetch',
	'cfwHttpCacheGet',
	'cfwQueueFetch',
	'cfwMail',
	'cfwImageUrl',
	'cfwFileRead',
	'cfwFileWrite',
	'cfwFileDelete',
	'cfwFileList',
	'cfwFileStat',
	'cfwFileRename',
	// both were installed on the module and absent here, which is the drift this list exists to
	// prevent: the census under-reported the bridge by two capabilities, and both of them mutate
	'cfwOidcClaims',
	'cfwTcp'
] as const;

export type CrossingName = (typeof CROSSING_NAMES)[number];

/**
 * Wraps every installed capability so each call increments the tally.
 *
 * Installed AFTER every capability, because a wrapper applied first is overwritten by the
 * installer that runs after it -- silently, and the tally then reads 0 for a capability that is
 * being called constantly. That failure mode is the reason this returns the names it actually
 * wrapped rather than assuming.
 *
 * @param binary
 *   The instantiated PHP module.
 * @param tally
 *   Mutated in place, so a caller can read it after a run without re-fetching it.
 *
 * @returns the names that were present and wrapped.
 */
export function wrapCrossings(
	binary: Record<string, unknown>,
	tally: CrossingTally
): CrossingName[] {
	const wrapped: CrossingName[] = [];
	for (const name of CROSSING_NAMES) {
		const fn = binary[name];
		if (typeof fn !== 'function') continue;
		const inner = fn as (...args: unknown[]) => unknown;
		binary[name] = (...args: unknown[]) => {
			tally.total += 1;
			tally.byName[name] = (tally.byName[name] ?? 0) + 1;
			const result = inner(...args);
			if (tally.calls) recordCrossing(tally.calls, name, args[0], result);
			return result;
		};
		wrapped.push(name);
	}
	return wrapped;
}

/** the tally between two readings, which is what "per render" means */
export function crossingsSince(before: CrossingTally, after: CrossingTally): CrossingTally {
	const byName: Record<string, number> = {};
	for (const [name, count] of Object.entries(after.byName)) {
		const delta = count - (before.byName[name] ?? 0);
		if (delta !== 0) byName[name] = delta;
	}
	return { total: after.total - before.total, byName };
}

/** a snapshot that later arithmetic cannot mutate by accident */
export function snapshotCrossings(tally: CrossingTally): CrossingTally {
	return { total: tally.total, byName: { ...tally.byName } };
}

/**
 * Which capabilities a batching change could coalesce, and which it could not.
 *
 * A capability is BATCHABLE when its calls are independent of each other's replies within one
 * render -- the caller can issue N and read N answers afterwards. It is SERIAL when the next call's
 * arguments depend on the previous reply, which is what makes `cfwSqlExec` unbatchable in general:
 * Drupal reads a row and decides what to ask next from it. `cfwSqlTxn` already IS the batched form
 * of `cfwSqlExec`, which is the precedent this classification follows.
 */
export const BATCHABLE: Record<CrossingName, boolean> = {
	// the write path already batches through `cfwSqlTxn`; reads are read-decide-read
	cfwSqlExec: false,
	cfwSqlTxn: false,
	// a compress call's output is the caller's next input
	cfwZlib: false,
	// fire and forget; a render could hand over an array of entries at the end
	cfwLog: true,
	cfwStats: false,
	cfwFetch: false,
	cfwHttpCacheGet: false,
	// already deferred by construction, so N queue entries could cross once
	cfwQueueFetch: true,
	cfwMail: true,
	// a pure URL builder over its arguments; N urls could be built in one crossing
	cfwImageUrl: true,
	cfwFileRead: false,
	cfwFileWrite: false,
	cfwFileDelete: true,
	cfwFileList: false,
	cfwFileStat: true,
	cfwFileRename: false,
	// one ticket, redeemed once; there is never a second call to coalesce with
	cfwOidcClaims: false,
	// syslog fires and forgets, but redis reads its reply and decides the next call from it
	cfwTcp: false
};

/** how many of a tally's crossings a batching change could remove, at best */
export function batchableShare(tally: CrossingTally): {
	batchable: number;
	serial: number;
	fraction: number;
} {
	let batchable = 0;
	let serial = 0;
	for (const [name, count] of Object.entries(tally.byName)) {
		if (BATCHABLE[name as CrossingName]) batchable += count;
		else serial += count;
	}
	const total = batchable + serial;
	return { batchable, serial, fraction: total > 0 ? batchable / total : 0 };
}

/**
 * What an RPC migration would cost, in DO requests per fill. **MEASURED ON A DEPLOYED WORKER.**
 *
 * This was asserted, then withdrawn as an unestablished inference, then settled properly. The
 * experiment: a throwaway worker with a Durable Object exposing an RPC method, a `fetch()`, and a
 * loop that does the same work INSIDE one invocation. Each arm driven a distinct number of times
 * against a fresh object, then read from `durableObjectsInvocationsAdaptiveGroups`, which is the
 * billing-facing dataset:
 *
 * | arm                                  | driven | requests billed |
 * | ------------------------------------ | -----: | --------------: |
 * | `stub.ping()`, an RPC method         |      7 |           **7** |
 * | `stub.fetch()`                       |     11 |          **11** |
 * | N loops inside ONE invocation        |     13 |           **1** |
 *
 * Confirmed at n=25 on a first run, where both boundary arms billed 25.
 *
 * **The third row is the one that matters and it is why today's bridge is free.** `Host::call()` is
 * a wasm import resolving to JavaScript inside the already-running object, on the far side of a
 * boundary the `stub.fetch()` already crossed -- the same shape as the `inner` arm, which billed
 * one request for thirteen operations. The first row is why the guard is real: a crossing
 * re-expressed as an RPC method on a stub would be billed one-for-one.
 *
 * @param crossingsPerFill
 *   Measured; `tests/integration/crossings.spec.ts` produces it.
 * @param baseDoRequestsPerFill
 *   What a fill costs today, from `COST_PER_VIEW.missAndFill.do` in the envelope model.
 */
export function rpcMigrationCost(
	crossingsPerFill: number,
	baseDoRequestsPerFill = 3
): { today: number; overRpc: number; factor: number; measured: true } {
	const overRpc = baseDoRequestsPerFill + Math.max(0, crossingsPerFill);
	return {
		today: baseDoRequestsPerFill,
		overRpc,
		factor: overRpc / baseDoRequestsPerFill,
		// the one-for-one billing this multiplies by is a deployed measurement, not a reading of
		// the docs; see the table above
		measured: true
	};
}
