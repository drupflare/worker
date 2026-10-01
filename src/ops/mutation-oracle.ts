/**
 * Every authoritative effect one request produced, recorded rather than refused.
 *
 * The read-only guard in `replica.ts` is the production posture (unknown fails to the primary);
 * this is the discovery posture, running a request to completion on a primary and
 * counting its effects. A zero from an unarmed oracle reads as a clean request, so
 * {@link EffectProfile} carries what it wrapped and {@link profileIsTrustworthy} refuses an
 * uninstrumented profile.
 * @module
 */
import type { WriteTally } from '../db/write-tally';
import { authoritativeWrites, classifyCapability } from './replica';
import { classifyState } from './state-inventory';

/** what kind of thing a request did (a stale cache row is minor, a mail send irreversible) */
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

/** one observed effect: its class, what it touched, and how often */
export type Effect = { effect: EffectClass; detail: string; count: number };

/** what one request did, with enough provenance to tell a zero from an absence */
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
	cfwOidcClaims: 'security-state',
	// a lever write lands in account KV, so a replica must not repeat it
	cfwSettings: 'security-state'
};

/**
 * The effect class a write to `table` belongs to.
 * `key_value` holds both a disposable fetch queue and the private key, so it reports
 * `security-state` (over-reporting costs a request its eligibility, never the reverse).
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
 * Wraps the installed capability surface to count mutating calls instead of refusing them.
 * Walks the module rather than a list, since capabilities have drifted out of `CROSSING_NAMES`.
 *
 * @returns the names wrapped, in the order encountered
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
		// SQL is counted through the write tally (here every read would count as an effect)
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
 * @param tally the per-table write tally taken around the request
 * @param capabilityCalls what {@link recordCapabilities} collected
 * @param wrapped the names it wrapped; empty means the oracle was not installed
 */
export function buildProfile(
	tally: WriteTally,
	capabilityCalls: Map<string, number>,
	wrapped: readonly string[]
): EffectProfile {
	const effects: Effect[] = [];
	const reasons: string[] = [];

	for (const write of authoritativeWrites(tally)) {
		// a statement that wrote no rows does not disqualify by itself
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

/** whether a profile is worth believing (an unarmed oracle must not count as eligible) */
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
 * Why an ineligible path wrote: `bootstrap` (a missing precondition; fixable and re-measurable),
 * `intrinsic` (authoritative by purpose; primary only) or `unknown`.
 * Every caller treats `unknown` as `intrinsic`: calling an intrinsic write bootstrap routes a
 * mutation to a replica, the reverse only pins a shareable path.
 */
export type IneligibleKind = 'bootstrap' | 'intrinsic' | 'unknown';

/**
 * Effects a cold object writes that a warm one does not: a deferred fetch on a cold cache makes
 * Drupal log, queue and arm a drain. A hypothesis until seeding the fetch cache is tried.
 */
const BOOTSTRAP_EFFECTS: ReadonlySet<EffectClass> = new Set(['outbound-http', 'queue', 'alarm']);

/** `watchdog` is the log of the deferral, so it is bootstrap only alongside a deferred fetch */
const BOOTSTRAP_TABLES: ReadonlySet<string> = new Set(['watchdog']);

/** classifies why a profile is ineligible; `unknown` for an eligible or untrustworthy one */
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
