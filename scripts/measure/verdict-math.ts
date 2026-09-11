import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { Summary } from './vps-compare';

/**
 * The viability predicate, separated from the benchmark that feeds it.
 *
 * WHY IT IS ITS OWN MODULE. The decision is real logic -- a weighted mean, two refusal rules and a
 * generator-bound exclusion -- and inside `host-verdict.ts` it could only be exercised by bringing
 * up two hosts and driving them for several minutes. That is not a check anything runs, so it is not
 * a check. `tests/node/host-verdict.spec.ts` drives every branch over fixtures instead, including
 * the ones a real run is unlikely to produce.
 *
 * The predicate is stated here rather than in the runner for a second reason: it has to be readable
 * without the numbers beside it, so it cannot be quietly fitted to a result.
 */

/**
 * What the verdict weighs each workload by, from `config/traffic.yml`.
 *
 * Read rather than generated: this is a build-lane instrument and never reaches a Worker, so it can
 * open the file the edge cannot. The weights sum to 1 and the reader refuses if they do not, since a
 * mix that does not is a weighted mean of nothing.
 */
export const TRAFFIC_MIX: Record<string, { weight: number; why: string }> = readTrafficMix();

function readTrafficMix(): Record<string, { weight: number; why: string }> {
	const path = resolve(import.meta.dirname, '..', '..', 'config', 'traffic.yml');
	const doc = parse(readFileSync(path, 'utf8')) as {
		mix?: Record<string, { weight: number; why: string }>;
	};
	const mix = doc?.mix;
	if (!mix || Object.keys(mix).length === 0) throw new Error(`${path} declares no mix`);
	const total = Object.values(mix).reduce((n, e) => n + e.weight, 0);
	if (Math.abs(total - 1) > 1e-9) {
		throw new Error(`config/traffic.yml weights sum to ${total}, not 1`);
	}
	return mix;
}

/** one workload at one concurrency, measured on both arms */
export interface Cell {
	workload: string;
	concurrency: number;
	vps: Summary;
	edge: Summary;
	/** VPS p50 divided by drupflare p50; above 1 means drupflare is faster */
	p50Ratio: number;
	p95Ratio: number;
	rpsRatio: number;
	/** within 20% of the generator's own ceiling, so the cell measures the generator */
	generatorBound: boolean;
}

/**
 * Which quantity a verdict was decided on.
 *
 * `total-p50` is what a visitor's clock reads and is the right answer when both arms are the same
 * distance from the generator. `service-time` is the host's own contribution -- the VPS's p50 on
 * localhost against the edge arm's `x-worker-ms` -- and is the only honest comparison when they are
 * NOT: a local VPS carries no network at all while a deployed worker driven from one laptop carries
 * 30-42 ms of round trip to a single colo that no real visitor pays, because a real visitor is
 * answered from their own.
 */
export type DecidedOn = 'total-p50' | 'service-time';

export interface Verdict {
	viable: boolean;
	/** cells where drupflare is materially worse; a non-empty list is what fails the verdict */
	regressions: string[];
	/** traffic-weighted mean of {@link DecidedOn}, per arm, in ms */
	weighted: { vps: number; edge: number };
	weightedRatio: number;
	/** which quantity the verdict above is about; never inferred by a reader */
	decidedOn: DecidedOn;
	/**
	 * What the run can and cannot conclude, in one sentence.
	 *
	 * Written here rather than left to the reader because a ratio with no quantity attached is how
	 * this project produced "225x": two workloads, two instruments, one division.
	 */
	because: string;
	notes: string[];
}

/** a ratio that does not divide by zero, and says which direction Infinity means */
export function ratio(vps: number, edge: number): number {
	if (edge === 0) return vps === 0 ? 1 : Infinity;
	return vps / edge;
}

/** within 20% of the generator's ceiling AT ITS OWN WIDTH, so the cell measures the generator */
export const GENERATOR_BOUND_FRACTION = 0.8;

/**
 * Whether a cell is measuring the generator rather than either host.
 *
 * THE CEILING HAS TO BE THE ONE FOR THIS CONCURRENCY. A single ceiling taken at a fixed width
 * cannot bound a matrix that varies width: a c=1 cell can never approach a c=8 reading, so it
 * could not be flagged at all, and a c=16 cell clears it legitimately. Measured 2026-09-11 with
 * one ceiling for every level, `anon-cached` on the VPS read 5,932 req/s at c=4 against an
 * asserted ceiling of 2,639 -- 2.2x its own bound, which is not a result a bound can produce.
 *
 * A missing ceiling answers false rather than throwing: an absent measurement must not silently
 * exclude a cell from the p95 rule, which is what `generatorBound` does downstream.
 */
export function generatorBound(
	concurrency: number,
	rps: { vps: number; edge: number },
	ceilings: { vps?: Record<number, number>; edge?: Record<number, number> }
): boolean {
	const over = (seen: number, ceiling: number | undefined): boolean =>
		ceiling !== undefined && ceiling > 0 && seen > GENERATOR_BOUND_FRACTION * ceiling;
	return (
		over(rps.vps, ceilings.vps?.[concurrency]) || over(rps.edge, ceilings.edge?.[concurrency])
	);
}

/**
 * VPS latency with a stated network round trip added back to each request.
 *
 * ONE round trip per request, which is the conservative direction: a real first visit also pays a
 * TCP handshake and a TLS one, so a single RTT understates the term rather than inflating it. The
 * verdict never uses it; `--rtt` exists to show how much further the gap moves once the missing
 * network cost is priced, and understating that is the safe error.
 */
export function withRtt(ms: number, rttMs: number): number {
	return rttMs > 0 ? ms + rttMs : ms;
}

/**
 * The traffic-weighted mean of one arm's p50 across the workloads that were actually measured.
 *
 * Renormalised over the workloads PRESENT rather than over the full mix, so a partial run reports a
 * mean of what it measured instead of one silently deflated by the slices it skipped. A run that
 * omits `anon-cached` is a different question, not a better answer to this one.
 */
export function weightedP50(cells: Cell[], pick: (c: Cell) => number, mix = TRAFFIC_MIX): number {
	const present = [...new Set(cells.map((c) => c.workload))].filter((w) => mix[w] !== undefined);
	const total = present.reduce((n, w) => n + (mix[w]?.weight ?? 0), 0);
	if (total === 0) return 0;
	let sum = 0;
	for (const workload of present) {
		const seen = cells.filter((c) => c.workload === workload);
		const mean = seen.reduce((n, c) => n + pick(c), 0) / seen.length;
		sum += mean * ((mix[workload]?.weight ?? 0) / total);
	}
	return sum;
}

/**
 * Whether the measured cells support calling drupflare a viable host.
 *
 * A host is VIABLE when, with the VPS given its best case on the same machine, drupflare
 *
 *   1. serves every workload without errors the VPS does not also produce,
 *   2. is no worse than 2x on p95 in any cell the generator did not bound, where the two arms are
 *      further apart than the rig's own resolution, and
 *   3. is at or below the VPS on TRAFFIC-WEIGHTED p50.
 *
 * Rule 2 rather than "wins every cell": a host that regenerates asynchronously is expected to lose
 * the uncached-tail cell, and one cell of a 9.5% slice does not decide a host. Rule 3 is what keeps
 * that honest, because a slice large enough to matter cannot lose without moving the weighted mean.
 *
 * A generator-bound cell is excluded from rule 2 and kept in rule 3. Excluded because a cell at the
 * generator's ceiling measures the generator, so a p95 taken there is not the host's. Kept in the
 * mean because dropping it would let a fast arm remove its own strongest evidence.
 */
/**
 * The error fraction past which a cell measures a broken server rather than a slow one.
 *
 * A DEAD ARM IS NOT A FAST ARM. When the local worker crashed mid-run every later request returned
 * status 0 in about a millisecond, so the cell read `p50 0ms` and -- before `rps` was computed over
 * successful requests only -- 45,279 req/s. Both are the numbers a reader would quote. The `ERRORS`
 * flag fired on those cells and the verdict still folded their p50 into the weighted mean, which is
 * how a crash could read as a win.
 *
 * A tenth, because a healthy cell here errors zero times: every non-zero reading this rig has ever
 * produced was either a refusal it was measuring on purpose or a server that had stopped.
 */
export const UNUSABLE_ERROR_FRACTION = 0.1;

/** whether a cell's error rate means it measured nothing about latency */
export function unusable(c: Cell): boolean {
	for (const arm of [c.edge, c.vps]) {
		if (arm.n > 0 && arm.errors / arm.n > UNUSABLE_ERROR_FRACTION) return true;
	}
	return false;
}

/**
 * The smallest p95 gap that can be a finding: the sample clock's own quantum.
 *
 * Every sample is a `Date.now()` delta, so it is an integer count of milliseconds. Rule 2 is a
 * RATIO, and a ratio over one or two quanta reports the quantisation rather than either host: a
 * 3ms-against-1ms cell is "3x worse" and 2ms apart. Callers pass the rig's own measured resolution
 * where they have one; this is the floor under which even that cannot go.
 */
export const P95_CLOCK_QUANTUM_MS = 1;

export function decide(
	cells: Cell[],
	rttMs = 0,
	notes: string[] = [],
	mix = TRAFFIC_MIX,
	decidedOn: DecidedOn = 'total-p50',
	p95FloorMs = P95_CLOCK_QUANTUM_MS
): Verdict {
	const regressions: string[] = [];
	// EXCLUDED FROM THE WEIGHTED MEAN, not just flagged. A cell that measured a stopped server
	// carries a p50 of 0, which pulls the mean toward the arm that failed
	const broken = cells.filter(unusable);
	const usable = cells.filter((c) => !unusable(c));
	for (const c of broken) {
		regressions.push(
			`${c.workload} c=${c.concurrency}: unusable, ` +
				`${c.edge.errors}/${c.edge.n} edge and ${c.vps.errors}/${c.vps.n} vps errors`
		);
	}
	for (const c of cells) {
		const label = `${c.workload} c=${c.concurrency}`;
		if (c.edge.errors > c.vps.errors) {
			regressions.push(
				`${label}: drupflare errored ${c.edge.errors}x against ${c.vps.errors}`
			);
		}
		if (!c.generatorBound && c.p95Ratio < 0.5) {
			const gap = Math.abs(c.edge.p95 - withRtt(c.vps.p95, rttMs));
			if (gap <= p95FloorMs) {
				notes.push(
					`${label}: p95 ${c.edge.p95}ms against ${withRtt(c.vps.p95, rttMs)}ms is ` +
						`${gap}ms apart, at or under the rig's own ${p95FloorMs}ms floor, so the ` +
						'ratio is arithmetic on the clock quantum and not a finding'
				);
				continue;
			}
			regressions.push(
				`${label}: p95 ${c.edge.p95}ms against ${withRtt(c.vps.p95, rttMs)}ms, worse than 2x`
			);
		}
	}

	// SERVICE TIME USES THE EDGE ARM'S OWN CLOCK, and the VPS's p50 is already service time when it
	// is on localhost. `x-worker-ms` brackets the stub call, which is a `Date.now()` delta spanning
	// I/O -- the shape RULE 0 permits, and it tracked the platform's own `wallTimeMs` to within 1 ms
	// on a deployed run. A cell whose arm stamped none falls back to its p50 rather than to 0, which
	// would flatter the arm that reported nothing.
	const edgeQuantity = (c: Cell): number =>
		decidedOn === 'service-time' && typeof c.edge.workerMs === 'number'
			? c.edge.workerMs
			: c.edge.p50;
	const weighted = {
		vps: weightedP50(usable, (c) => withRtt(c.vps.p50, rttMs), mix),
		edge: weightedP50(usable, edgeQuantity, mix)
	};
	const because =
		decidedOn === 'service-time'
			? 'decided on SERVICE TIME: the arms are not the same distance from the generator, so ' +
				"the edge arm's `x-worker-ms` is compared against the VPS's localhost p50. This says " +
				'which host does less work per request; it says NOTHING about what a visitor waits, ' +
				"because neither arm carries that visitor's network."
			: 'decided on TOTAL p50: both arms are the same distance from the generator, so the ' +
				'number is what a client on this machine actually waited. Add `--rtt` to price the ' +
				'network a real visitor pays to a single-region VPS.';

	return {
		// a run carrying an unusable cell cannot answer either way: the weighted mean is taken over
		// a workload mix the run did not actually complete
		viable:
			usable.length === cells.length &&
			cells.length > 0 &&
			regressions.length === 0 &&
			weighted.edge <= weighted.vps,
		regressions,
		weighted,
		weightedRatio: ratio(weighted.vps, weighted.edge),
		decidedOn,
		because,
		notes
	};
}
