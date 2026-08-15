/**
 * Turns tagged edge `cpuTime` samples into the per-phase attribution table.
 *
 * INPUT is a TSV of `tag<TAB>cpuMs`, one line per measured invocation, as returned by a Workers
 * Observability `calculations` query grouped by `$workers.event.request.search.tag` and filtered to
 * `$workers.executionModel = durableObject`. The tag scheme is the one
 * `scripts/measure/bootphase-drive.ts` writes: `<prefix>-<phase>-s<sample>`.
 *
 * A script rather than arithmetic in a reply. The phases are CUMULATIVE, and two of them
 * are branches rather than steps: `container-read` and `container-unserialize` both run off
 * `kernel-new` and never reach `$kernel->boot()`, so subtracting them from the phase that precedes
 * them in the list would attribute the container read to the kernel boot and the kernel boot to
 * nothing. Getting that wrong is silent -- every column still adds up.
 */

const BASELINE: Record<string, string | null> = {
	'boot-only': null,
	autoload: 'boot-only',
	'kernel-new': 'autoload',
	'container-read': 'kernel-new',
	'container-unserialize': 'container-read',
	'kernel-boot': 'kernel-new',
	'pre-handle': 'kernel-boot',
	render: 'pre-handle'
};

/** Reading order, which is NOT the subtraction order; see BASELINE. */
const ORDER = [
	'boot-only',
	'autoload',
	'kernel-new',
	'container-read',
	'container-unserialize',
	'kernel-boot',
	'pre-handle',
	'render'
];

export type Sample = { phase: string; sample: number; cpuMs: number };

/**
 * Splits `<prefix>-<phase>-s<n>` into its phase and sample.
 *
 * The prefix is anchored as a single dash-free token because every phase name except `autoload` and
 * `render` contains a dash, so a greedy split on the first dash would return `kernel` for
 * `kernel-boot`.
 */
export function parseTag(tag: string): { phase: string; sample: number } | null {
	const m = /^([^-]+)-(.+)-s(\d+)$/.exec(tag.trim());
	if (!m) return null;
	return { phase: m[2] as string, sample: Number(m[3]) };
}

export function parseTsv(text: string): Sample[] {
	const out: Sample[] = [];
	for (const line of text.split('\n')) {
		const t = line.trim();
		if (!t || t.startsWith('#')) continue;
		const parts = t.split(/\s+/);
		if (parts.length < 2) continue;
		const cpuMs = Number(parts[parts.length - 1]);
		if (!Number.isFinite(cpuMs)) continue;
		const parsed = parseTag(parts.slice(0, -1).join('-'));
		if (!parsed) continue;
		out.push({ ...parsed, cpuMs });
	}
	return out;
}

export function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export type PhaseStat = {
	phase: string;
	n: number;
	median: number;
	min: number;
	max: number;
	values: number[];
};

export function summarise(samples: Sample[]): PhaseStat[] {
	const byPhase = new Map<string, number[]>();
	for (const s of samples) {
		if (!byPhase.has(s.phase)) byPhase.set(s.phase, []);
		(byPhase.get(s.phase) as number[]).push(s.cpuMs);
	}
	const stats: PhaseStat[] = [];
	for (const phase of ORDER) {
		const vs = byPhase.get(phase);
		if (!vs || vs.length === 0) continue;
		stats.push({
			phase,
			n: vs.length,
			median: median(vs),
			min: Math.min(...vs),
			max: Math.max(...vs),
			values: [...vs].sort((a, b) => a - b)
		});
	}
	// any phase the tag scheme produced that ORDER does not know about is a bug, not a row to drop
	for (const phase of byPhase.keys()) {
		if (!ORDER.includes(phase)) throw new Error(`unknown phase in input: ${phase}`);
	}
	return stats;
}

export type Attribution = {
	phase: string;
	baseline: string | null;
	cumulativeMedian: number;
	baselineMedian: number | null;
	costMs: number | null;
	cumulativeMin: number;
	baselineMin: number | null;
	costMinMs: number | null;
};

/**
 * Both estimators, because they answer different questions and neither one alone is honest.
 *
 * `costMs` subtracts MEDIANS and is what a cold visitor actually pays, platform noise included.
 * `costMinMs` subtracts MINIMA, which strips the one-sided platform warm-up this measurement is
 * swimming in: a control run of `autoload` -- a phase that writes nothing at all -- still fell
 * 1,111 -> 713 ms over five repeats on ONE object, so a large part of any single sample is isolate
 * warm-up rather than the phase. A phase whose two estimators disagree in SIGN has not been measured
 * yet, whatever the median says.
 */
export function attribute(stats: PhaseStat[]): Attribution[] {
	const med = new Map(stats.map((s) => [s.phase, s.median]));
	const mins = new Map(stats.map((s) => [s.phase, s.min]));
	return stats.map((s) => {
		const baseline = BASELINE[s.phase] ?? null;
		const baselineMedian = baseline !== null ? (med.get(baseline) ?? null) : null;
		const baselineMin = baseline !== null ? (mins.get(baseline) ?? null) : null;
		return {
			phase: s.phase,
			baseline,
			cumulativeMedian: s.median,
			baselineMedian,
			costMs: baselineMedian === null ? null : s.median - baselineMedian,
			cumulativeMin: s.min,
			baselineMin,
			costMinMs: baselineMin === null ? null : s.min - baselineMin
		};
	});
}

export type RepeatSlope = {
	lowN: number;
	highN: number;
	lowMedian: number;
	highMedian: number;
	lowMin: number;
	highMin: number;
	/** marginal cost of ONE more render in the same interpreter, from the medians */
	perRenderMedian: number;
	/** the same slope from the minima, which strips the one-sided platform warm-up */
	perRenderMin: number;
};

/**
 * Two-point slope over `/drupal?repeat=N`, which is the only way to price a WARM render on the edge.
 *
 * A warm render cannot get its own invocation -- an invocation always includes a boot -- so the
 * marginal render is read off the slope of total cpuTime against N instead. Two widely separated
 * points rather than a dense scan: the per-invocation spread here is around +/-1,500 ms, so 1 vs 3
 * cannot resolve a few hundred ms of slope and 1 vs 10 can.
 *
 * This exists to check the arithmetic behind the "~850 ms kernel boot" figure, which subtracted a
 * 41 ms warm render out of a cold path.
 */
export function repeatSlope(samples: Sample[]): RepeatSlope {
	const byN = new Map<number, number[]>();
	for (const s of samples) {
		const m = /^repeat(\d+)$/.exec(s.phase);
		if (!m) continue;
		const n = Number(m[1]);
		if (!byN.has(n)) byN.set(n, []);
		(byN.get(n) as number[]).push(s.cpuMs);
	}
	const ns = [...byN.keys()].sort((a, b) => a - b);
	if (ns.length < 2) throw new Error('repeatSlope needs at least two distinct repeat counts');
	const lowN = ns[0] as number;
	const highN = ns[ns.length - 1] as number;
	const low = byN.get(lowN) as number[];
	const high = byN.get(highN) as number[];
	const span = highN - lowN;
	return {
		lowN,
		highN,
		lowMedian: median(low),
		highMedian: median(high),
		lowMin: Math.min(...low),
		highMin: Math.min(...high),
		perRenderMedian: (median(high) - median(low)) / span,
		perRenderMin: (Math.min(...high) - Math.min(...low)) / span
	};
}

function fmt(n: number | null): string {
	return n === null ? '-' : String(Math.round(n * 10) / 10);
}

async function main(): Promise<void> {
	const file = process.argv[2];
	if (!file) {
		console.error('usage: bootphase-attribute.ts <tag-cpu.tsv> [--repeat-scan]');
		process.exit(1);
	}
	const samples = parseTsv(await Bun.file(file).text());
	if (samples.length === 0) throw new Error('no samples parsed');

	if (process.argv.includes('--repeat-scan')) {
		const s = repeatSlope(samples);
		console.log(`/drupal?repeat=N total edge cpuTime, N=${s.lowN} vs N=${s.highN}`);
		console.log(`  N=${s.lowN}   median ${fmt(s.lowMedian)} ms   min ${fmt(s.lowMin)} ms`);
		console.log(`  N=${s.highN}  median ${fmt(s.highMedian)} ms   min ${fmt(s.highMin)} ms`);
		console.log(
			`\nmarginal WARM render: ${fmt(s.perRenderMedian)} ms from medians, ` +
				`${fmt(s.perRenderMin)} ms from minima`
		);
		console.log(
			`first render + everything under it: ${fmt(s.lowMedian - s.perRenderMedian)} ms median, ` +
				`${fmt(s.lowMin - s.perRenderMin)} ms min`
		);
		return;
	}

	const stats = summarise(samples);

	console.log('CUMULATIVE edge cpuTime per phase (ms)');
	console.log('phase                  n   median     min     max   samples');
	for (const s of stats) {
		console.log(
			`${s.phase.padEnd(22)} ${String(s.n).padStart(2)} ${fmt(s.median).padStart(8)} ${fmt(
				s.min
			).padStart(7)} ${fmt(s.max).padStart(7)}   ${s.values.join(', ')}`
		);
	}

	console.log('\nSUBTRACTION: cost attributable to each phase');
	console.log('phase                  baseline                 cost(med)   cost(min)  agree');
	let cumulativeShare = 0;
	let cumulativeMinShare = 0;
	for (const a of attribute(stats)) {
		// a phase whose two estimators disagree in sign is below the noise floor, and saying so is
		// the whole reason both are printed
		const agree =
			a.costMs === null || a.costMinMs === null
				? ''
				: Math.sign(a.costMs) === Math.sign(a.costMinMs)
					? 'yes'
					: 'NO -- below noise';
		console.log(
			`${a.phase.padEnd(22)} ${String(a.baseline ?? '(floor)').padEnd(22)} ${fmt(
				a.costMs
			).padStart(10)} ${fmt(a.costMinMs).padStart(11)}  ${agree}`
		);
		// the two container BRANCHES are not on the path to a render, so they are not part of the
		// total; counting them would double-count the bytes kernel-boot reads anyway
		if (a.phase === 'container-read' || a.phase === 'container-unserialize') continue;
		if (a.costMs !== null) cumulativeShare += a.costMs;
		if (a.costMinMs !== null) cumulativeMinShare += a.costMinMs;
	}
	const floor = stats.find((s) => s.phase === 'boot-only');
	const total = stats.find((s) => s.phase === 'render');
	console.log(
		`\nfloor (interpreter + mount, no Drupal): ${fmt(floor?.median ?? null)} ms median, ${fmt(floor?.min ?? null)} ms min`
	);
	console.log(
		`attributed above the floor:             ${fmt(cumulativeShare)} ms median, ${fmt(cumulativeMinShare)} ms min`
	);
	console.log(
		`total cold render:                      ${fmt(total?.median ?? null)} ms median, ${fmt(total?.min ?? null)} ms min`
	);
}

if (import.meta.main) await main();
