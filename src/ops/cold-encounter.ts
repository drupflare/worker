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
 *
 * ## The front worker's share has to be carried in
 *
 * A plan hit, an isolate memo hit, a `caches.default` hit and a KV page read all return from the
 * front worker, so the object cannot see any of them -- and they are most of the traffic. `absorbed`
 * is that count, reported by the front worker on the next request that hops anyway, which is why
 * `coldOfObject` and `coldOfTraffic` are separate fields rather than one number that means whichever
 * the reader assumes. The field this replaced was called `coldOfAll` and counted neither.
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
	/** answered by the front worker, so this object never saw the request; see `foldAbsorbed()` */
	absorbed: number;
};

export const ZERO_ENCOUNTERS: EncounterCounts = { noPhp: 0, warm: 0, cold: 0, absorbed: 0 };

/**
 * What an object's own counters say, plus the three shares worth reporting.
 *
 * `coldOfPhp` scores the THERMAL POLICY: of the requests that needed PHP, how many found none. That
 * is the number a residency change moves. `coldOfObject` scores what the page and plan tiers move
 * INSIDE the object. `coldOfTraffic` is the visitor-facing one, and it is the only one of the three
 * whose denominator is every request made for the site.
 *
 * The three are `null` rather than 0 on an empty denominator. A site that has served nothing has not
 * demonstrated a 0% cold rate, and reporting one would make an unused site look like a well-tuned
 * one -- the same distinction `rolloutProgress()` draws for a fleet nobody has heard from.
 *
 * `coldOfTraffic` is additionally null while `absorbed` is 0, because a site whose front worker has
 * reported nothing has not demonstrated that nothing was absorbed: it is indistinguishable from one
 * running a worker too old to report. An absent reading is visibly absent; a plausible wrong one is
 * not, and this field's whole purpose is that the wrong one reads about 5x too high.
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

export function recordEncounter(counts: EncounterCounts, outcome: Encounter): EncounterCounts {
	if (outcome === 'cold') return { ...counts, cold: counts.cold + 1 };
	if (outcome === 'warm') return { ...counts, warm: counts.warm + 1 };
	return { ...counts, noPhp: counts.noPhp + 1 };
}

/**
 * Folds in what the front worker says it answered without hopping.
 *
 * Attacker-supplied in the sense that every inbound header is, so the value is clamped and a
 * nonsense one folds in nothing rather than poisoning the denominator. The cap is per report and
 * generous: one isolate cannot absorb more than this between two hops to the same site without the
 * hop it is riding on being long gone.
 */
export const ABSORBED_REPORT_MAX = 100_000;

/** what the front worker reports its own absorbed count under */
export const ABSORBED_HEADER = 'x-cfw-absorbed';

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
 * Reads the counters back, defaulting to zero on anything unexpected.
 *
 * A corrupt row loses a day of counting rather than reporting a wrong share, which is the safe
 * direction: an absent reading is visibly absent, and a plausible wrong one is not.
 *
 * Three fields is a row written before `absorbed` existed, and it reads as `absorbed: 0` -- which is
 * exactly what it means, and what makes `coldOfTraffic` null on it rather than wrong.
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

export function addEncounters(a: EncounterCounts, b: EncounterCounts): EncounterCounts {
	return {
		noPhp: a.noPhp + b.noPhp,
		warm: a.warm + b.warm,
		cold: a.cold + b.cold,
		absorbed: a.absorbed + b.absorbed
	};
}
