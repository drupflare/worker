/**
 * Counts PHP-to-host crossings, per capability.
 *
 * A `cfw*` call is a wasm import resolving to JavaScript in the same isolate: it costs CPU and is
 * not a DO request (an RPC method call on a stub is billed as one). So this prices the risk of an
 * RPC migration, not a live meter. It wraps the whole surface once, so a later capability is
 * counted without anyone remembering to.
 * @module
 */
import { recordCrossing, type CensusCall } from './statement-census';

/** what the tally hands back: total crossings and the per-capability split */
export type CrossingTally = {
	total: number;
	byName: Record<string, number>;
	/** per-statement detail, appended only when a caller arms it with an array (costly) */
	calls?: CensusCall[];
	/**
	 * string bytes crossing the bridge since the last reset, plus the largest argument and reply.
	 * The host resets it per request or alarm, which names the request that moved a large string.
	 */
	bytes?: { in: number; out: number; maxIn: number; maxOut: number; maxName: string };
};

/** an empty tally (not `emptyTally`, which `write-tally.ts` already exports) */
export function emptyCrossings(): CrossingTally {
	return { total: 0, byName: {} };
}

/**
 * Every capability name the host installs on the PHP module.
 *
 * A list, not a prefix scan: `cfwCanSuspend` is a boolean the service provider probes, and wrapping
 * it would hand PHP a callable where it expects a flag (reads true, installs a dead handler).
 */
export const CROSSING_NAMES = [
	'cfwSqlExec',
	'cfwSqlTxn',
	'cfwZlib',
	'cfwLog',
	'cfwStats',
	'cfwServeStats',
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
	'cfwFilePublicBase',
	'cfwFileRename',
	// both mutate, and the census under-counted the bridge while they were missing here
	'cfwOidcClaims',
	'cfwTcp',
	// the runtime levers, read and written from Drupal's own settings form
	'cfwSettings',
	// what code has been delivered here, read by the Modules tab
	'cfwModules'
] as const;

/** one capability name from {@link CROSSING_NAMES} */
export type CrossingName = (typeof CROSSING_NAMES)[number];

/**
 * Wraps every installed capability so each call increments the tally.
 *
 * Install after every capability: a wrapper applied first is overwritten by a later installer and
 * the tally silently reads 0.
 *
 * @param binary the instantiated PHP module
 * @param tally mutated in place
 * @returns the names that were present and wrapped
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
			if (tally.bytes) {
				const sent = typeof args[0] === 'string' ? args[0].length : 0;
				const got = typeof result === 'string' ? result.length : 0;
				tally.bytes.in += sent;
				tally.bytes.out += got;
				if (sent > tally.bytes.maxIn) tally.bytes.maxIn = sent;
				if (got > tally.bytes.maxOut) {
					tally.bytes.maxOut = got;
					tally.bytes.maxName = name;
				}
			}
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
 * Which capabilities a batching change could coalesce.
 *
 * Batchable means calls within a render do not depend on each other's replies; serial means the
 * next call's arguments come from the previous reply (`cfwSqlExec`; `cfwSqlTxn` is already its
 * batched form).
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
	// one snapshot answers a whole page; nothing asks for a second in the same render
	cfwServeStats: false,
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
	// one configured string; a render asks once and the answer cannot change under it
	cfwFilePublicBase: true,
	cfwFileRename: false,
	// one ticket, redeemed once; there is never a second call to coalesce with
	cfwOidcClaims: false,
	// syslog fires and forgets, but redis reads its reply and decides the next call from it
	cfwTcp: false,
	// one form build reads the whole lever set in a single call; there is no second to coalesce
	cfwSettings: false,
	// a read of this object's own tables; one page build asks once
	cfwModules: true
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
 * What an RPC migration would cost, in DO requests per fill.
 *
 * Measured on a deployed worker: an RPC method and a `stub.fetch()` each billed one request per
 * call (7 and 11), while 13 operations inside one invocation billed 1, so today's bridge is free
 * and a crossing moved onto RPC would bill one-for-one.
 *
 * @param crossingsPerFill measured; `tests/integration/crossings.spec.ts` produces it
 * @param baseDoRequestsPerFill what a fill costs today, from `COST_PER_VIEW.missAndFill.do`
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
		// the one-for-one billing is a deployed measurement, not a reading of the docs
		measured: true
	};
}
