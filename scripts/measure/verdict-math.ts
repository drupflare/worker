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

export interface Verdict {
	viable: boolean;
	/** cells where drupflare is materially worse; a non-empty list is what fails the verdict */
	regressions: string[];
	/** traffic-weighted p50, per arm, in ms */
	weighted: { vps: number; edge: number };
	weightedRatio: number;
	notes: string[];
}

/** a ratio that does not divide by zero, and says which direction Infinity means */
export function ratio(vps: number, edge: number): number {
	if (edge === 0) return vps === 0 ? 1 : Infinity;
	return vps / edge;
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
 *   2. is no worse than 2x on p95 in any cell the generator did not bound, and
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
export function decide(cells: Cell[], rttMs = 0, notes: string[] = [], mix = TRAFFIC_MIX): Verdict {
	const regressions: string[] = [];
	for (const c of cells) {
		const label = `${c.workload} c=${c.concurrency}`;
		if (c.edge.errors > c.vps.errors) {
			regressions.push(
				`${label}: drupflare errored ${c.edge.errors}x against ${c.vps.errors}`
			);
		}
		if (!c.generatorBound && c.p95Ratio < 0.5) {
			regressions.push(
				`${label}: p95 ${c.edge.p95}ms against ${withRtt(c.vps.p95, rttMs)}ms, worse than 2x`
			);
		}
	}

	const weighted = {
		vps: weightedP50(cells, (c) => withRtt(c.vps.p50, rttMs), mix),
		edge: weightedP50(cells, (c) => c.edge.p50, mix)
	};

	return {
		viable: cells.length > 0 && regressions.length === 0 && weighted.edge <= weighted.vps,
		regressions,
		weighted,
		weightedRatio: ratio(weighted.vps, weighted.edge),
		notes
	};
}
