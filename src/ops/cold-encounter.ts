/**
 * How often a request meets an evicted PHP runtime (the metric that replaces cold boot cost).
 *
 * A cold render floors at 1,264 ms of `cpuTime` on a deployed free worker (n=4, 1,113-1,343).
 * The front worker answers plan, memo, `caches.default` and KV hits itself, so `absorbed` carries
 * that count in on the next hop.
 * @module
 */

/** one request's outcome, from the object's point of view */
export type Encounter =
	/** answered without entering the interpreter: a stored page, a plan hit, a refusal */
	| 'no-php'
	/** needed the interpreter and found it resident */
	| 'warm'
	/** needed the interpreter and had to construct one */
	| 'cold';

/** per-outcome request counts for one object */
export type EncounterCounts = {
	noPhp: number;
	warm: number;
	cold: number;
	/** answered by the front worker, so this object never saw the request; see `foldAbsorbed()` */
	absorbed: number;
};

/** all-zero counts */
export const ZERO_ENCOUNTERS: EncounterCounts = { noPhp: 0, warm: 0, cold: 0, absorbed: 0 };

/**
 * Counters plus three cold shares: `coldOfPhp` (thermal policy), `coldOfObject` (page and plan
 * tiers inside the object) and `coldOfTraffic` (every request made for the site).
 *
 * A share is null on an empty denominator, so an unused site does not read as well tuned.
 * `coldOfTraffic` is also null while `absorbed` is 0: a front worker too old to report looks the
 * same as one that absorbed nothing, and the wrong figure reads about 5x too high.
 */
export type EncounterReport = EncounterCounts & {
	total: number;
	php: number;
	/** requests made for the site, including the ones the front worker answered by itself */
	traffic: number;
	coldOfPhp: number | null;
	coldOfObject: number | null;
	coldOfTraffic: number | null;
};

/** derives the totals and the three cold shares from one object's counters */
export function encounterReport(counts: EncounterCounts): EncounterReport {
	const php = counts.warm + counts.cold;
	const total = php + counts.noPhp;
	const traffic = total + counts.absorbed;
	return {
		...counts,
		total,
		php,
		traffic,
		coldOfPhp: php === 0 ? null : Number((counts.cold / php).toFixed(4)),
		coldOfObject: total === 0 ? null : Number((counts.cold / total).toFixed(4)),
		coldOfTraffic: counts.absorbed === 0 ? null : Number((counts.cold / traffic).toFixed(4))
	};
}

/** returns the counts with the outcome added */
export function recordEncounter(counts: EncounterCounts, outcome: Encounter): EncounterCounts {
	if (outcome === 'cold') return { ...counts, cold: counts.cold + 1 };
	if (outcome === 'warm') return { ...counts, warm: counts.warm + 1 };
	return { ...counts, noPhp: counts.noPhp + 1 };
}

/** per-report cap on a claimed absorbed count (the header is client-reachable, so it is clamped) */
export const ABSORBED_REPORT_MAX = 100_000;

/** what the front worker reports its own absorbed count under */
export const ABSORBED_HEADER = 'x-cfw-absorbed';

/** adds the front worker's absorbed count; a missing, non-integer or over-cap value adds nothing */
export function foldAbsorbed(counts: EncounterCounts, raw: string | null): EncounterCounts {
	if (raw === null) return counts;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0 || n > ABSORBED_REPORT_MAX) return counts;
	return { ...counts, absorbed: counts.absorbed + n };
}

/** serialises for `cfw_meta`, which is TEXT */
export function serialiseEncounters(counts: EncounterCounts): string {
	return `${counts.noPhp},${counts.warm},${counts.cold},${counts.absorbed}`;
}

/**
 * Reads the counters back; anything unexpected becomes zero (a lost count beats a wrong share).
 * A three-field row predates `absorbed` and reads as `absorbed: 0`.
 */
export function parseEncounters(raw: string | null | undefined): EncounterCounts {
	if (!raw) return { ...ZERO_ENCOUNTERS };
	const parts = raw.split(',').map((n) => Number(n));
	if (parts.length < 3 || parts.length > 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
		return { ...ZERO_ENCOUNTERS };
	}
	return {
		noPhp: parts[0] as number,
		warm: parts[1] as number,
		cold: parts[2] as number,
		absorbed: (parts[3] as number | undefined) ?? 0
	};
}

/** sums two sets of counts field by field */
export function addEncounters(a: EncounterCounts, b: EncounterCounts): EncounterCounts {
	return {
		noPhp: a.noPhp + b.noPhp,
		warm: a.warm + b.warm,
		cold: a.cold + b.cold,
		absorbed: a.absorbed + b.absorbed
	};
}
