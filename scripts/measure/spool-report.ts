/**
 * Reduces the spool rig's `.jsonl` files to the rows `docs/impact.md` quotes.
 *
 *   bun scripts/measure/spool-report.ts results/repeat.jsonl results/cold-media.jsonl
 *
 * Each file is one `headers-energy.ts` run: per round, one window for each arm and one idle window.
 * A round is dropped when its idle draw sits more than a quarter away from the run's median idle
 * draw, the same rule spool's own rig uses for a window another process disturbed. Joules are idle
 * subtracted per navigation. The ratio is the off arm over the on arm per round, so a value above 1
 * means the site draws less with spool on.
 */
import { readFileSync } from 'node:fs';
import { perNavByRound, type EnergyRow } from './headers-energy';
import { median, spread, type Spread } from './jview-math';

/** the rows of one run, in the order the driver wrote them */
export function readRows(path: string): EnergyRow[] {
	return readFileSync(path, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as EnergyRow);
}

/** watts of each round's idle window */
export function idleWatts(rows: EnergyRow[]): Map<number, number> {
	const out = new Map<number, number>();
	for (const r of rows) if (r.arm === 'idle') out.set(r.round, r.pkgJ / (r.elapsedMs / 1000));
	return out;
}

/** rounds whose idle draw is more than `tolerance` away from the median idle draw of the run */
export function disagreeingRounds(rows: EnergyRow[], tolerance = 0.25): number[] {
	const watts = idleWatts(rows);
	if (watts.size === 0) return [];
	const mid = median([...watts.values()]);
	return [...watts]
		.filter(([, w]) => Math.abs(w - mid) / mid > tolerance)
		.map(([round]) => round);
}

export type Summary = {
	rounds: number;
	droppedRounds: number[];
	joulesPerNav: Record<string, Spread>;
	/** off over on, one value per kept round */
	ratio: Spread;
	requestsPerNav: Record<string, number>;
	bytesPerNav: Record<string, number> | undefined;
};

/** One run reduced: kept rounds, joules per navigation for each arm, the paired ratio and the counts. */
export function summarize(rows: EnergyRow[], on = 'on', off = 'off'): Summary {
	const droppedRounds = disagreeingRounds(rows);
	const kept = rows.filter((r) => !droppedRounds.includes(r.round));
	const by = perNavByRound(kept);
	const onJ = by[on] ?? [];
	const offJ = by[off] ?? [];
	if (onJ.length === 0 || onJ.length !== offJ.length)
		throw new Error('arms have no common rounds');
	const arms = [on, off];
	const total = (arm: string, key: 'requests' | 'bytes' | 'navs') =>
		kept.filter((r) => r.arm === arm).reduce((n, r) => n + (r[key] ?? 0), 0);
	const perNav = (key: 'requests' | 'bytes') =>
		Object.fromEntries(arms.map((a) => [a, total(a, key) / total(a, 'navs')]));
	return {
		rounds: onJ.length,
		droppedRounds,
		joulesPerNav: { [on]: spread(onJ), [off]: spread(offJ) },
		ratio: spread(offJ.map((j, i) => j / (onJ[i] as number))),
		requestsPerNav: perNav('requests'),
		bytesPerNav: kept.some((r) => r.bytes !== undefined) ? perNav('bytes') : undefined
	};
}

if (import.meta.main) {
	for (const path of process.argv.slice(2)) {
		const s = summarize(readRows(path));
		const f = (x: number) => x.toFixed(3);
		console.log(`${path}`);
		console.log(`  rounds kept ${s.rounds}, dropped ${JSON.stringify(s.droppedRounds)}`);
		for (const [arm, j] of Object.entries(s.joulesPerNav))
			console.log(
				`  ${arm.padEnd(4)} ${f(j.median)} J a navigation (${f(j.min)}-${f(j.max)}, n=${j.n})`
			);
		console.log(`  off over on ${f(s.ratio.median)} (${f(s.ratio.min)}-${f(s.ratio.max)})`);
		console.log(`  requests a navigation ${JSON.stringify(s.requestsPerNav)}`);
		if (s.bytesPerNav) console.log(`  bytes a navigation ${JSON.stringify(s.bytesPerNav)}`);
	}
}
