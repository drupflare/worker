/**
 * The statistics and reporting core for a deployed measurement, which is what turns RULE 0 from a
 * discipline into a tool.
 *
 * The parts around it already existed and stay: `tail-tags.ts` joins a `wrangler tail` capture back
 * to a tagged request and separates contended samples from uncontended ones, `obs-cpu.ts` reads
 * `$workers.cpuTimeMs` out of Workers Observability, and `scripts/probe/*-paired.sh` price things
 * natively. What none of them do is REFUSE a reading that RULE 0 does not permit, so every sweep so
 * far hand-rolled its own median and its own honesty.
 *
 * Four rules, enforced here rather than remembered:
 *
 * 1. **n >= 5 or no number.** {@link summarise} returns null below it. The platform is bimodal by
 *    400-600 ms, so an n=1 or n=3 verdict under ~500 ms is unsupportable.
 * 2. **Never a bare figure.** Every {@link Summary} carries n, min, median, max and spread, and
 *    {@link renderReport} has no format that omits them.
 * 3. **Pair on the same object.** Measured 2026-08-20: objects differ in MARGINAL RENDER COST by
 *    2.8x (45.4 to 135.8 ms/render), so bimodality is a per-object SLOPE and not only a
 *    per-invocation offset. An unpaired difference of medians read 11 ms/render against a paired
 *    4.4 -- 2.7x high, and almost entirely object assignment. {@link slopeDispersion} reports how
 *    far the objects disagreed, which is what says whether pairing mattered on that run.
 * 4. **Name the bins.** A render figure without the emptied cache bins is a claim about the cache.
 *    {@link Scenario.bins} is required; `[]` is legal and must be written.
 *
 * The orchestration around this -- deploy a `cfw-*` worker, drive the scenarios, query, tear down,
 * verify the worker list returns to baseline -- is the runbook in {@link BENCH_RUNBOOK}, kept as
 * text because it spends a real account's quota and should be read before it is run.
 */

/** RULE 0's floor: below this the platform's bimodality swamps anything under ~500 ms */
export const MIN_SAMPLES = 5;

/** how long Workers Observability took to ingest a tag that was already driven, measured once */
export const OBSERVABILITY_INGEST_LAG_MS = 4 * 60_000;

export type Scenario = {
	name: string;
	path: string;
	/**
	 * Cache bins emptied before each measured render.
	 *
	 * REQUIRED, and `[]` is a legal value that must be written out. "Warm render" and "cache hit"
	 * are different measurements even when both are warm, and a figure that does not say which is
	 * not a figure.
	 */
	bins: string[];
	/** renders in the low arm of the pair */
	lowN: number;
	/** renders in the high arm; the slope divides by `highN - lowN` */
	highN: number;
};

export type Summary = {
	n: number;
	min: number;
	median: number;
	max: number;
	/** max - min, so the reader sees the spread without computing it */
	spread: number;
};

/**
 * n, min, median, max -- or null when there are not enough samples to say anything.
 *
 * Returning null rather than a number computed from n=2 is the whole point: a caller that wants a
 * figure has to handle the refusal, and "cannot be resolved at this n" is a real answer.
 */
export function summarise(values: readonly number[]): Summary | null {
	const clean = values
		.filter((v) => Number.isFinite(v))
		.slice()
		.sort((a, b) => a - b);
	if (clean.length < MIN_SAMPLES) return null;
	const mid = Math.floor(clean.length / 2);
	const median =
		clean.length % 2 === 0
			? ((clean[mid - 1] as number) + (clean[mid] as number)) / 2
			: (clean[mid] as number);
	return {
		n: clean.length,
		min: clean[0] as number,
		max: clean[clean.length - 1] as number,
		median,
		spread: (clean[clean.length - 1] as number) - (clean[0] as number)
	};
}

/** one object measured at both arm sizes, which is what makes a comparison paired */
export type Pair = {
	/** anything that identifies the object; only equality matters */
	object: string;
	lowMs: number;
	highMs: number;
};

/**
 * Per-request cost, from the slope between two arm sizes ON THE SAME OBJECT.
 *
 * Subtracting the low arm removes the boot AND the first-render surcharge, both of which are present
 * identically in both arms -- which matters because the first render of an invocation cannot hit any
 * memo, so it does not differ between arms even when everything after it does.
 */
export function pairedSlope(pairs: readonly Pair[], lowN: number, highN: number): Summary | null {
	const span = highN - lowN;
	if (span <= 0) return null;
	return summarise(pairs.map((p) => (p.highMs - p.lowMs) / span));
}

/**
 * How far apart the objects are in per-request cost, as a max/min ratio.
 *
 * **This replaced a metric that could not fail.** The first version compared an unpaired estimate
 * against the paired one over the same paired data and reported 1.026x on a fixture built to show a
 * gap -- because within a matched set both medians land on the same object, so the comparison is
 * structurally almost always ~1. The hazard it was trying to express is real but arises when the two
 * arms are measured on DIFFERENT objects, which paired data cannot tell you.
 *
 * What paired data CAN tell you is the thing that makes an unpaired comparison dangerous: how much
 * objects disagree. Measured 2026-08-20, marginal render cost ranged 45.4 to 135.8 ms/render -- a
 * **2.8x** dispersion -- and that is why an unpaired difference of medians read 2.7x the paired
 * figure on the same run. A dispersion near 1 means the population is uniform and an unpaired
 * comparison would have been survivable; a large one means it would not.
 *
 * @returns max slope / min slope, or null below the sample floor or when the minimum is not positive
 */
export function slopeDispersion(
	pairs: readonly Pair[],
	lowN: number,
	highN: number
): number | null {
	const span = highN - lowN;
	if (span <= 0 || pairs.length < MIN_SAMPLES) return null;
	const slopes = pairs.map((p) => (p.highMs - p.lowMs) / span).filter((v) => Number.isFinite(v));
	if (slopes.length < MIN_SAMPLES) return null;
	const min = Math.min(...slopes);
	const max = Math.max(...slopes);
	if (min <= 0) return null;
	return max / min;
}

/** a scenario's reading, ready to render */
export type Reading = {
	scenario: Scenario;
	paired: Summary | null;
	/** max/min per-object slope; large means an unpaired comparison would have been wrong */
	dispersion: number | null;
	/** samples that `tail-tags.ts` classified as contended, excluded from the summary */
	discardedContended: number;
};

const ms = (v: number) => `${v.toFixed(1)} ms`;

/**
 * The markdown report, and there is no code path here that emits a bare number.
 *
 * A scenario whose samples fell below {@link MIN_SAMPLES} renders as a refusal naming the n it had,
 * because "we could not resolve it" is information and a median of three is not.
 */
export function renderReport(readings: readonly Reading[]): string {
	const lines = [
		'# Deployed measurement',
		'',
		`Every figure below is \`cpuTime\` from a deployed worker, paired on one object, n >= ${MIN_SAMPLES}.`,
		'',
		'| scenario | path | bins emptied | n | min | median | max | spread |',
		'| --- | --- | --- | --- | --- | --- | --- | --- |'
	];

	for (const r of readings) {
		const bins = r.scenario.bins.length > 0 ? r.scenario.bins.join(', ') : 'none (all warm)';
		if (!r.paired) {
			lines.push(
				`| ${r.scenario.name} | \`${r.scenario.path}\` | ${bins} | too few | - | **unresolved** | - | - |`
			);
			continue;
		}
		const p = r.paired;
		lines.push(
			`| ${r.scenario.name} | \`${r.scenario.path}\` | ${bins} | ${p.n} | ${ms(p.min)} | **${ms(p.median)}** | ${ms(p.max)} | ${ms(p.spread)} |`
		);
	}

	const spread = readings.filter((r) => r.dispersion !== null && r.dispersion > 1.5);
	if (spread.length > 0) {
		lines.push('', '## Why these had to be paired', '');
		for (const r of spread) {
			lines.push(
				`- **${r.scenario.name}**: objects disagree by ${(r.dispersion as number).toFixed(1)}x in ` +
					'per-request cost, so comparing arms across objects would have measured the assignment.'
			);
		}
	}

	const discarded = readings.reduce((n, r) => n + r.discardedContended, 0);
	if (discarded > 0) {
		lines.push(
			'',
			`${discarded} contended samples were excluded. A Durable Object is single-threaded, so an ` +
				"invocation overlapping another reports the other one's wall time; mixing the two " +
				'populations measures neither.'
		);
	}

	return lines.join('\n');
}

/**
 * How to run one, and why it is text rather than a flag.
 *
 * A deployed run spends a real account's quota and the account holds real production workers, so the
 * teardown check is not optional and is not something a script should be trusted to have done.
 */
export const BENCH_RUNBOOK = `
1. Record the worker list BEFORE anything, and keep it.
2. Deploy under a \`cfw-*\` name only. Never over an existing worker.
   \`bunx wrangler deploy --dry-run --outdir=<tmp> -c <config>\` proves the entrypoint and the
   binary alias resolve without deploying.
3. A DO-namespace deploy needs ~60 s propagation before \`stub.fetch()\` stops answering
   "Worker not found". Wait; do not debug it.
4. Stage only what is needed. Uploading the full assets/ tree fails.
5. Drive each scenario at BOTH arm sizes on the SAME object, with a unique tag per invocation.
6. Wait for ingest before querying: a tag driven seconds earlier can be absent for ~4 minutes.
7. Tear down, then verify the worker list returns to EXACTLY its prior baseline. Paste both.
`.trim();
