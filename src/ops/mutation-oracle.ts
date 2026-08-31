/**
 * Every authoritative effect one request produced, recorded rather than refused.
 *
 * The read-only guard in `replica.ts` is the PRODUCTION posture: unknown fails closed to the
 * primary. This is the DISCOVERY posture, and the two differ because a replica must not learn what
 * a request does while serving it to a user. Here a request runs to completion on a
 * primary and its effects are counted, which is what turns "these four paths happened not to write"
 * into a measured eligibility rate.
 *
 * A ZERO FROM AN UNARMED ORACLE IS INDISTINGUISHABLE FROM A CLEAN REQUEST, which is the failure this
 * project has hit repeatedly -- a probe nobody wired reporting 0 route matches, a decorator the
 * container held and never called. So {@link EffectProfile} carries what it WRAPPED, and
 * {@link profileIsTrustworthy} refuses a profile whose instrumentation was not installed.
 */

import type { WriteTally } from '../db/write-tally.js';
import { authoritativeWrites, classifyCapability } from './replica.js';
import { classifyState } from './state-inventory.js';

/**
 * What kind of thing a request did.
 *
 * Separated because they carry different consequences: a stale cache row is a nuisance, a sequence
 * allocated on two objects is silent data corruption, and a mail send cannot be taken back at all.
 */
export type EffectClass =
	| 'authoritative-sql'
	| 'sequence'
	| 'session'
	| 'security-state'
	| 'file'
	| 'mail'
	| 'outbound-http'
	| 'queue'
	| 'alarm'
	| 'unclassified-capability';

export type Effect = { effect: EffectClass; detail: string; count: number };

export type EffectProfile = {
	/** every authoritative effect observed, most frequent first */
	effects: Effect[];
	/** capability names the oracle wrapped, so a zero can be told from an absence */
	wrapped: string[];
	/** false when nothing was instrumented; see {@link profileIsTrustworthy} */
	armed: boolean;
	/** true when the request produced no authoritative effect at all */
	replicaEligible: boolean;
	/** one sentence per reason it is not, empty when it is */
	reasons: string[];
};

/** the tables whose effect class is narrower than "authoritative" */
const TABLE_EFFECT: Record<string, EffectClass> = {
	sequences: 'sequence',
	sessions: 'session',
	watchdog: 'queue',
	cfw_http_queue: 'outbound-http',
	cfw_mail_queue: 'mail',
	cfw_file: 'file',
	cfw_file_chunk: 'file',
	cfw_page_mirror_queue: 'queue',
	cfw_file_mirror_queue: 'queue'
};

/** capability names to the effect they commit */
const CAPABILITY_EFFECT: Record<string, EffectClass> = {
	cfwMail: 'mail',
	cfwFetch: 'outbound-http',
	cfwQueueFetch: 'outbound-http',
	cfwTcp: 'outbound-http',
	cfwFileWrite: 'file',
	cfwFileDelete: 'file',
	cfwFileRename: 'file',
	cfwOidcClaims: 'security-state'
};

/**
 * The effect class a write to `table` belongs to.
 *
 * `key_value` cannot be judged from the table alone -- it holds a disposable fetch queue and the
 * private key -- so a write to it is reported as `security-state` conservatively. That over-reports
 * an update-check row as security-relevant, which costs a request its eligibility and never the
 * reverse.
 */
export function tableEffect(table: string): EffectClass {
	if (TABLE_EFFECT[table] !== undefined) return TABLE_EFFECT[table] as EffectClass;
	if (table === 'key_value' || table === 'key_value_expire') return 'security-state';
	if (table.startsWith('users') || table.startsWith('user__')) return 'session';
	return 'authoritative-sql';
}

/** an empty profile, armed false, so an un-run oracle cannot read as a clean request */
export function emptyProfile(): EffectProfile {
	return { effects: [], wrapped: [], armed: false, replicaEligible: false, reasons: [] };
}

/**
 * Wraps the installed capability surface to COUNT mutating calls instead of refusing them.
 *
 * Walks what is on the module rather than a list, for the same reason the guard does: two
 * capabilities have already drifted out of `CROSSING_NAMES`, and a census that inherits that gap
 * under-reports exactly the calls it exists to find.
 *
 * @returns the names wrapped, in the order encountered.
 */
export function recordCapabilities(
	binary: Record<string, unknown>,
	sink: Map<string, number>
): string[] {
	const wrapped: string[] = [];
	for (const name of Object.keys(binary)) {
		if (!name.startsWith('cfw')) continue;
		const fn = binary[name];
		if (typeof fn !== 'function') continue;
		if (classifyCapability(name) === 'safe') continue;
		// the SQL capabilities are counted through the write tally instead; counting them here
		// would report every read as an effect
		if (name === 'cfwSqlExec' || name === 'cfwSqlTxn') continue;
		const inner = fn as (...args: unknown[]) => unknown;
		binary[name] = (...args: unknown[]) => {
			sink.set(name, (sink.get(name) ?? 0) + 1);
			return inner(...args);
		};
		wrapped.push(name);
	}
	return wrapped;
}

/** the storage operations that are an authoritative effect rather than replica-local bookkeeping */
const STORAGE_EFFECT: Record<string, EffectClass> = {
	'?storage.setAlarm': 'alarm',
	'?storage.deleteAlarm': 'alarm'
};

/**
 * Folds a request's write tally and capability calls into one profile.
 *
 * @param tally
 *   The per-table write tally taken around the request.
 * @param capabilityCalls
 *   What {@link recordCapabilities} collected.
 * @param wrapped
 *   The names it wrapped; an empty list means the oracle was not installed.
 */
export function buildProfile(
	tally: WriteTally,
	capabilityCalls: Map<string, number>,
	wrapped: readonly string[]
): EffectProfile {
	const effects: Effect[] = [];
	const reasons: string[] = [];

	for (const write of authoritativeWrites(tally)) {
		// a statement that wrote no rows attempted nothing durable here, but it would on an object
		// whose state differs, so it is reported and does not by itself disqualify
		if (write.rows === 0) continue;
		const effect = tableEffect(write.table);
		effects.push({ effect, detail: write.table, count: write.rows });
		reasons.push(`${effect}: ${write.rows} rows in ${write.table}`);
	}

	for (const [op, klass] of Object.entries(STORAGE_EFFECT)) {
		const rows = tally.byTable[op] ?? 0;
		if (rows > 0) {
			effects.push({ effect: klass, detail: op, count: rows });
			reasons.push(`${klass}: ${op}`);
		}
	}

	for (const [name, count] of capabilityCalls) {
		const effect = CAPABILITY_EFFECT[name] ?? 'unclassified-capability';
		effects.push({ effect, detail: name, count });
		reasons.push(`${effect}: ${count} call(s) to ${name}`);
	}

	effects.sort((a, b) => b.count - a.count || a.detail.localeCompare(b.detail));
	return {
		effects,
		wrapped: [...wrapped],
		armed: wrapped.length > 0,
		replicaEligible: effects.length === 0,
		reasons
	};
}

/**
 * Whether a profile is worth believing.
 *
 * An unarmed oracle observes nothing and reports nothing, which reads exactly like a clean request.
 * A census must refuse those rather than count them as eligible.
 */
export function profileIsTrustworthy(profile: EffectProfile): boolean {
	return profile.armed;
}

/** the eligibility rate over a set of profiles, refusing to score any that were not armed */
export function eligibilityRate(profiles: readonly EffectProfile[]): {
	eligible: number;
	total: number;
	rate: number;
	untrustworthy: number;
} {
	const usable = profiles.filter(profileIsTrustworthy);
	const eligible = usable.filter((p) => p.replicaEligible).length;
	return {
		eligible,
		total: usable.length,
		rate: usable.length === 0 ? 0 : eligible / usable.length,
		untrustworthy: profiles.length - usable.length
	};
}

/**
 * Why an ineligible path wrote, which decides whether it is routable at all.
 *
 * `bootstrap` writes only because a precondition has not been established yet, so establishing it
 * and re-measuring can move the path into the eligible set. `intrinsic` writes authoritative state
 * as its purpose and belongs on the primary permanently.
 *
 * **`unknown` is the default and is treated as `intrinsic` by every caller**, because the failure
 * directions are not symmetric: calling an intrinsic write "bootstrap" routes an authoritative
 * mutation to a replica, and calling a bootstrap write "intrinsic" only pins a path that could have
 * been shared. This function decides nothing on its own; it labels a measurement so the label can be
 * argued with.
 */
export type IneligibleKind = 'bootstrap' | 'intrinsic' | 'unknown';

/**
 * Effects a COLD object writes that a warm one does not, keyed by the state that is missing.
 *
 * Only `outbound-http` and what it drags with it. A deferred fetch on a cold cache makes Drupal log
 * the failure, queue the request and arm a drain, so one missing precondition produces three effect
 * classes and none of them is the request's purpose. Seeding the fetch cache at admission is the
 * experiment that would settle it; until that runs, this is a HYPOTHESIS with a name, not a verdict.
 */
const BOOTSTRAP_EFFECTS: ReadonlySet<EffectClass> = new Set(['outbound-http', 'queue', 'alarm']);

/** `watchdog` is the log of the deferral, so it is bootstrap only alongside a deferred fetch */
const BOOTSTRAP_TABLES: ReadonlySet<string> = new Set(['watchdog']);

/**
 * Classifies why a profile is ineligible.
 *
 * Returns `unknown` for an eligible or untrustworthy profile: there is nothing to explain, and an
 * unarmed oracle observed nothing at all.
 */
export function ineligibleKind(profile: EffectProfile): IneligibleKind {
	if (!profileIsTrustworthy(profile) || profile.replicaEligible) return 'unknown';
	// one dangerous effect is enough; the kinds do not average
	const deferredFetch = profile.effects.some((e) => e.effect === 'outbound-http');
	for (const effect of profile.effects) {
		if (BOOTSTRAP_EFFECTS.has(effect.effect)) continue;
		if (deferredFetch && BOOTSTRAP_TABLES.has(effect.detail)) continue;
		return 'intrinsic';
	}
	// a queue or alarm with no fetch behind it is something else arming work, not a cold cache
	return deferredFetch ? 'bootstrap' : 'intrinsic';
}

/** the ineligible profiles split by kind, which is what decides routable from primary-only */
export function ineligibleSplit(profiles: readonly EffectProfile[]): {
	bootstrap: number;
	intrinsic: number;
} {
	let bootstrap = 0;
	let intrinsic = 0;
	for (const profile of profiles) {
		const kind = ineligibleKind(profile);
		if (kind === 'bootstrap') bootstrap++;
		else if (kind === 'intrinsic') intrinsic++;
	}
	return { bootstrap, intrinsic };
}

/** every effect class seen across a set of profiles, with totals; what a census reports */
export function effectCensus(profiles: readonly EffectProfile[]): Record<EffectClass, number> {
	const out = {} as Record<EffectClass, number>;
	for (const profile of profiles) {
		if (!profileIsTrustworthy(profile)) continue;
		for (const effect of profile.effects) {
			out[effect.effect] = (out[effect.effect] ?? 0) + effect.count;
		}
	}
	return out;
}

/** the classifier the census shares with the runtime, so the two cannot drift apart */
export { classifyState };
