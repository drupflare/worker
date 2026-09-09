/**
 * How often a request meets an evicted PHP runtime, which is the metric that replaces "how long is a
 * cold boot".
 *
 * A VPS wins the startup comparison by keeping a PHP-FPM process resident, not by booting quickly. A
 * Durable Object can hold its interpreter for as long as it stays resident, so the honest question is
 * not the cost of one cold boot but how often a user-visible request is allowed to encounter one.
 *
 * The measured floor is 1,264 ms of `cpuTime` for an unimaged cold render on a deployed free worker
 * (n=4, 1,113-1,343), taken with warming forced off. That figure is a TAIL RISK rather than a
 * systemic cost, and nothing reported the share of requests exposed to it.
 *
 * ## The denominator is the whole design
 *
 * A cached page never reaches the object at all, so counting cold boots against DO invocations
 * flatters the number, and counting them against every request the front worker sees is the figure a
 * visitor actually experiences. Both are kept, because the two answer different questions: the first
 * scores the thermal policy, the second scores the architecture.
 */

/** one request's outcome, from the object's point of view */
export type Encounter =
	/** answered without entering the interpreter: a stored page, a plan hit, a refusal */
	| 'no-php'
	/** needed the interpreter and found it resident */
	| 'warm'
	/** needed the interpreter and had to construct one */
	| 'cold';

export type EncounterCounts = {
	noPhp: number;
	warm: number;
	cold: number;
};

export const ZERO_ENCOUNTERS: EncounterCounts = { noPhp: 0, warm: 0, cold: 0 };

/**
 * What an object's own counters say, plus the two shares worth reporting.
 *
 * `coldOfPhp` scores the THERMAL POLICY: of the requests that needed PHP, how many found none. That
 * is the number a residency change moves. `coldOfAll` scores the ARCHITECTURE: of every request that
 * reached the object, how many paid a boot, which is what the page and plan tiers move.
 *
 * Both are `null` rather than 0 on an empty denominator. A site that has served nothing has not
 * demonstrated a 0% cold rate, and reporting one would make an unused site look like a well-tuned
 * one -- the same distinction `rolloutProgress()` draws for a fleet nobody has heard from.
 */
export type EncounterReport = EncounterCounts & {
	total: number;
	php: number;
	coldOfPhp: number | null;
	coldOfAll: number | null;
};

export function encounterReport(counts: EncounterCounts): EncounterReport {
	const php = counts.warm + counts.cold;
	const total = php + counts.noPhp;
	return {
		...counts,
		total,
		php,
		coldOfPhp: php === 0 ? null : Number((counts.cold / php).toFixed(4)),
		coldOfAll: total === 0 ? null : Number((counts.cold / total).toFixed(4))
	};
}

export function recordEncounter(counts: EncounterCounts, outcome: Encounter): EncounterCounts {
	if (outcome === 'cold') return { ...counts, cold: counts.cold + 1 };
	if (outcome === 'warm') return { ...counts, warm: counts.warm + 1 };
	return { ...counts, noPhp: counts.noPhp + 1 };
}

/** serialises for `cfw_meta`, which is TEXT */
export function serialiseEncounters(counts: EncounterCounts): string {
	return `${counts.noPhp},${counts.warm},${counts.cold}`;
}

/**
 * Reads the counters back, defaulting to zero on anything unexpected.
 *
 * A corrupt row loses a day of counting rather than reporting a wrong share, which is the safe
 * direction: an absent reading is visibly absent, and a plausible wrong one is not.
 */
export function parseEncounters(raw: string | null | undefined): EncounterCounts {
	if (!raw) return { ...ZERO_ENCOUNTERS };
	const parts = raw.split(',').map((n) => Number(n));
	if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
		return { ...ZERO_ENCOUNTERS };
	}
	return { noPhp: parts[0] as number, warm: parts[1] as number, cold: parts[2] as number };
}

export function addEncounters(a: EncounterCounts, b: EncounterCounts): EncounterCounts {
	return { noPhp: a.noPhp + b.noPhp, warm: a.warm + b.warm, cold: a.cold + b.cold };
}
