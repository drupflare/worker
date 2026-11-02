/**
 * The arithmetic behind `jview-energy.ts`, separated so it can be checked without a host.
 *
 * Nothing here touches a network or a counter. Every function takes numbers and returns numbers, and
 * `tests/node/jview-math.spec.ts` drives each one.
 */

export const median = (xs: number[]): number => {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1
		? (s[mid] as number)
		: ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

export type Spread = { median: number; min: number; max: number; n: number };

export function spread(xs: number[]): Spread {
	if (xs.length === 0) return { median: 0, min: 0, max: 0, n: 0 };
	return { median: median(xs), min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
}

/**
 * A counter delta that survives one wrap.
 *
 * `energy_uj` wraps at `max_energy_range_uj`, so a negative difference is a wrap and not a reading.
 * Two wraps inside one window cannot happen at a 65.5 kJ range and tens of watts.
 */
export function counterDelta(before: number, after: number, range: number): number {
	return after >= before ? after - before : after + range - before;
}

/**
 * Joules per view for one window.
 *
 * `subtracted` removes the idle floor measured with every arm resident and undriven; `charged`
 * leaves it in. Both divide by the views that were answered, never by the views offered.
 */
export function jPerView(input: {
	windowJ: number;
	elapsedS: number;
	idleW: number;
	views: number;
}): { subtracted: number; charged: number } | null {
	if (input.views <= 0 || input.elapsedS <= 0) return null;
	return {
		subtracted: (input.windowJ - input.idleW * input.elapsedS) / input.views,
		charged: input.windowJ / input.views
	};
}

/**
 * Picks classes in exactly the stated proportion over any prefix long enough to hold one of each.
 *
 * Largest deficit first: after k picks class c has been chosen as close to `w_c * k` times as whole
 * numbers allow. A random draw would put the 3% classes anywhere from 1% to 5% of a short window and
 * move the arm's energy with the draw rather than with the arm.
 */
export function smoothPicker(weights: Record<string, number>): () => string {
	const names = Object.keys(weights);
	const total = names.reduce((n, k) => n + (weights[k] as number), 0);
	const counts: Record<string, number> = Object.fromEntries(names.map((k) => [k, 0]));
	let k = 0;
	return () => {
		k += 1;
		let best = names[0] as string;
		let bestDeficit = -Infinity;
		for (const name of names) {
			const deficit = ((weights[name] as number) / total) * k - (counts[name] as number);
			if (deficit > bestDeficit) {
				bestDeficit = deficit;
				best = name;
			}
		}
		counts[best] = (counts[best] as number) + 1;
		return best;
	};
}

/**
 * Scales a rate ladder down so its top rung stays under a fraction of the slowest arm's capacity.
 *
 * The ratios between rungs are kept, because the comparison is a curve over rate and a ladder
 * flattened against a ceiling stops being one.
 */
export function scaleRates(base: number[], capacity: number, headroom = 0.5): number[] {
	const top = Math.max(...base);
	const scale = Math.min(1, (capacity * headroom) / top);
	return base.map((r) => Math.max(1, Math.round(r * scale)));
}

/**
 * Reduces a rendered page to what two hosts must agree on.
 *
 * Asset tags differ by design (`ASSET_AGGREGATES` rewrites a page's stylesheets to a handful of
 * aggregates), the origin differs by hostname, and Views stamps a per-render DOM id. Everything else
 * in the markup is the same page, so what remains is compared byte for byte.
 */
export function normalizeBody(html: string): string {
	return html
		.replace(/<link[^>]*>/g, '')
		.replace(/<script[\s\S]*?<\/script>/g, '')
		.replace(/<style[\s\S]*?<\/style>/g, '')
		.replace(/https?:\/\/[^/"'\s]*\//g, '/')
		.replace(/js-view-dom-id-[0-9a-f]+/g, 'js-view-dom-id-X')
		.replace(/\s+/g, ' ')
		.trim();
}

/** weighted mean of per-class values; a class with no value drops out and the rest are renormalised */
export function weightedMean(
	values: Record<string, number | undefined>,
	weights: Record<string, number>
): number | null {
	let num = 0;
	let den = 0;
	for (const [name, w] of Object.entries(weights)) {
		const v = values[name];
		if (v === undefined || !Number.isFinite(v)) continue;
		num += w * v;
		den += w;
	}
	return den === 0 ? null : num / den;
}

/**
 * The 20% rule, written before the numbers existed.
 *
 * A drupflare arm beats the regular host when its idle-subtracted weighted J/view is at most 0.80 of
 * the host's at EVERY offered rate. One rate is not a result, and an arm that wins at 120 views a
 * second and loses at 30 has told the reader about the rate. Idle-charged is reported beside it and
 * does not decide: both arms sit on one package, so the charged figure is mostly the same floor.
 */
export function beatsByTwentyPercent(
	arm: number[],
	host: number[],
	threshold = 0.8
): { beats: boolean; ratios: number[] } {
	const ratios = arm.map((a, i) => a / (host[i] as number));
	return { beats: ratios.length > 0 && ratios.every((r) => r <= threshold), ratios };
}

/** A deterministic uniform generator in [0,1) (mulberry32), so a bootstrap repeats for one seed. */
export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Treatment over control for each paired block.
 *
 * Refuses a control at or below zero: an idle-subtracted reading can go negative, and a ratio
 * against it is not a ratio, so clamping would invent a number.
 */
export function pairedRatios(control: number[], treatment: number[]): number[] {
	if (control.length !== treatment.length) {
		throw new Error(
			`paired blocks differ in length: ${control.length} control, ${treatment.length} treatment`
		);
	}
	if (control.length === 0) throw new Error('no paired blocks');
	return control.map((c, i) => {
		if (!(c > 0))
			throw new Error(`control block ${i} is ${c}; a ratio needs a positive control`);
		return (treatment[i] as number) / c;
	});
}

/** Blocks present on both sides, in block order, as two arrays for {@link pairedRatios}. */
export function pairByBlock(
	control: Map<number, number>,
	treatment: Map<number, number>
): { control: number[]; treatment: number[] } {
	const blocks = [...control.keys()].filter((b) => treatment.has(b)).sort((a, b) => a - b);
	return {
		control: blocks.map((b) => control.get(b) as number),
		treatment: blocks.map((b) => treatment.get(b) as number)
	};
}

/** Median of the ratios with a percentile bootstrap interval on it. */
export function bootstrapMedianRatio(
	ratios: number[],
	opts: { iterations?: number; seed?: number; level?: number } = {}
): { median: number; lo: number; hi: number; n: number } {
	const iterations = opts.iterations ?? 10000;
	const level = opts.level ?? 0.95;
	const rand = seededRandom(opts.seed ?? 1);
	const n = ratios.length;
	const medians: number[] = [];
	for (let i = 0; i < iterations; i += 1) {
		const sample: number[] = [];
		for (let j = 0; j < n; j += 1) sample.push(ratios[Math.floor(rand() * n)] as number);
		medians.push(median(sample));
	}
	medians.sort((a, b) => a - b);
	const tail = (1 - level) / 2;
	const lo = medians[Math.floor(tail * iterations)] as number;
	const hi = medians[Math.min(iterations - 1, Math.ceil((1 - tail) * iterations) - 1)] as number;
	return { median: median(ratios), lo, hi, n };
}

/**
 * Pass only when the upper bound of the interval is at or under the threshold.
 *
 * The median alone never passes: a median under the line with an upper bound over it is noise.
 * The threshold is a product decision and the caller supplies it.
 */
export function ratioGate(
	ratios: number[],
	threshold: number,
	opts: { minBlocks?: number; seed?: number } = {}
): {
	verdict: 'pass' | 'fail' | 'insufficient';
	median: number;
	lo: number;
	hi: number;
	n: number;
	threshold: number;
} {
	const ci = bootstrapMedianRatio(ratios, { seed: opts.seed });
	const verdict =
		ci.n < (opts.minBlocks ?? 10) ? 'insufficient' : ci.hi <= threshold ? 'pass' : 'fail';
	return { verdict, ...ci, threshold };
}

/** the verdict of {@link ratioGate} */
export type GateVerdict = ReturnType<typeof ratioGate>['verdict'];

/**
 * The lowest ratio any treatment can reach, given the cost a null responder already pays.
 *
 * A floor result is a finding, not a failure to measure: it says the control is mostly wake and
 * network cost that no treatment can remove, so the threshold is out of reach by construction.
 */
export function floorBound(
	controlMj: number,
	nullResponderMj: number
): { share: number; minRatio: number; canShow(threshold: number): boolean } {
	if (!(controlMj > 0)) throw new Error(`control energy is ${controlMj}; it must be positive`);
	if (!(nullResponderMj >= 0)) throw new Error(`null responder energy is ${nullResponderMj}`);
	const minRatio = nullResponderMj / controlMj;
	return { share: minRatio, minRatio, canShow: (threshold) => minRatio < threshold };
}

/** null workerd over null nginx at or under this opens a cached-tier lever; 130 mJ is 0.75 x 176 */
export const FLOOR_OPEN = 0.75;

/** at or over this the cached tier cannot go below the nginx hit; 170-180 mJ is 0.97-1.02 x 176 */
export const FLOOR_CLOSED = 0.97;

export type FloorVerdict = 'open' | 'between' | 'closed' | 'insufficient';

/**
 * The floor ladder's verdict on one rung, from per-block ratios of null workerd over null nginx.
 *
 * Open needs the upper bound under {@link FLOOR_OPEN}, closed needs the lower bound over
 * {@link FLOOR_CLOSED}, so a median alone never decides either. Under `minBlocks` is insufficient.
 */
export function floorVerdict(
	ratios: number[],
	opts: { minBlocks?: number; seed?: number } = {}
): { verdict: FloorVerdict; median: number; lo: number; hi: number; n: number } {
	const ci = bootstrapMedianRatio(ratios, { seed: opts.seed });
	const verdict: FloorVerdict =
		ci.n < (opts.minBlocks ?? 10)
			? 'insufficient'
			: ci.hi <= FLOOR_OPEN
				? 'open'
				: ci.lo >= FLOOR_CLOSED
					? 'closed'
					: 'between';
	return { verdict, ...ci };
}

/** one verdict for the ladder: a verdict only when every rung gives it, insufficient if any rung is */
export function floorOverall(verdicts: FloorVerdict[]): FloorVerdict {
	if (verdicts.length === 0 || verdicts.includes('insufficient')) return 'insufficient';
	const first = verdicts[0] as FloorVerdict;
	return verdicts.every((v) => v === first) ? first : 'between';
}

export type FloorRow = {
	round: number;
	rate: number;
	arm: string;
	pkgJ: number;
	elapsedMs: number;
	views: number;
};

export type FloorRung = {
	rate: number;
	verdict: FloorVerdict;
	median: number;
	lo: number;
	hi: number;
	n: number;
	/** blocks dropped because either side read at or under idle once idle was subtracted */
	unreadable: number;
	controlMj: number;
	treatmentMj: number;
};

/**
 * The floor ladder over windows already screened for discards: per rung, idle-subtracted J per
 * request for each arm, paired by round, treatment over control.
 *
 * A block where either arm costs no more than idle has no ratio, so it is dropped and counted. At a
 * low rate that is the meter's resolution speaking, and the rung then reads insufficient.
 */
export function floorLadder(
	rows: FloorRow[],
	idleW: number,
	control = 'nginx-null',
	treatment = 'wd-null',
	planned: number[] = []
): FloorRung[] {
	const rates = [...new Set([...planned, ...rows.map((r) => r.rate)])].sort((a, b) => a - b);
	const perBlock = (rate: number, arm: string) =>
		new Map(
			rows
				.filter((r) => r.rate === rate && r.arm === arm)
				.flatMap((r) => {
					const j = jPerView({
						windowJ: r.pkgJ,
						elapsedS: r.elapsedMs / 1000,
						idleW,
						views: r.views
					});
					return j === null ? [] : [[r.round, j.subtracted] as const];
				})
		);
	return rates.map((rate) => {
		const c = perBlock(rate, control);
		const t = perBlock(rate, treatment);
		const both = pairByBlock(c, t);
		const keep = both.control.map((x, i) => x > 0 && (both.treatment[i] as number) > 0);
		const cs = both.control.filter((_, i) => keep[i]);
		const ts = both.treatment.filter((_, i) => keep[i]);
		const v =
			cs.length === 0
				? { verdict: 'insufficient' as const, median: 0, lo: 0, hi: 0, n: 0 }
				: floorVerdict(pairedRatios(cs, ts));
		return {
			rate,
			...v,
			unreadable: keep.filter((k) => !k).length,
			controlMj: median(cs) * 1000,
			treatmentMj: median(ts) * 1000
		};
	});
}

/** one arm's reply to the same URL, reduced to what two floor arms must agree on */
export type BodyReading = {
	arm: string;
	status: number;
	type: string | null;
	bytes: number;
	sha: string;
};

/** whether every floor arm returned the same status, type, length and bytes, and the expected length */
export function bodiesAgree(
	rows: BodyReading[],
	expectBytes?: number
): { ok: boolean; problems: string[] } {
	const problems: string[] = [];
	const first = rows[0];
	if (first === undefined) return { ok: false, problems: ['no readings'] };
	for (const r of rows) {
		if (r.status !== 200) problems.push(`${r.arm} answered ${r.status}`);
		if (r.type !== first.type) problems.push(`${r.arm} type ${r.type} against ${first.type}`);
		if (r.bytes !== first.bytes)
			problems.push(`${r.arm} ${r.bytes} bytes against ${first.bytes}`);
		else if (r.sha !== first.sha) problems.push(`${r.arm} same length, different bytes`);
		if (expectBytes !== undefined && r.bytes !== expectBytes)
			problems.push(`${r.arm} ${r.bytes} bytes, expected ${expectBytes}`);
	}
	return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

/**
 * Seconds to wait before opening a window so it does not overlap the box's hourly Wi-Fi drop.
 *
 * The drop is 10 to 20 s at about :23 (remote-machines.md); the guarded span is :22:50 to :23:40.
 */
export function waitOutWifiDrop(secondsIntoHour: number, windowS: number): number {
	const start = 22 * 60 + 50;
	const end = 23 * 60 + 40;
	return secondsIntoHour + windowS + 3 > start && secondsIntoHour < end
		? end - secondsIntoHour
		: 0;
}

/** the inputs of the derived arm, each one named so the output can print them beside the result */
export type DerivedInputs = {
	/** Cloudflare's published annual energy or the emissions it was converted from, in joules */
	cloudflareJoulesPerYear: number;
	/** every request Radar counts per second, which includes DNS and attack traffic */
	requestsPerSecond: number;
	/** Cloudflare requests charged to one drupflare view */
	requestsPerView: number;
};

const SECONDS_PER_YEAR = 31_557_600;

/**
 * Joules per drupflare view, attributed from the whole network.
 *
 * An upper bound per request, since the request count includes traffic a cached page has nothing to
 * do with, and a floor on neither side of the comparison.
 */
export function derivedJoulesPerView(i: DerivedInputs): number {
	const requestsPerYear = i.requestsPerSecond * SECONDS_PER_YEAR;
	return (i.cloudflareJoulesPerYear / requestsPerYear) * i.requestsPerView;
}

/**
 * Joules per view of a server held 24/7 and shared by `sites`, serving `viewsPerSite` a month.
 *
 * Idle is charged because it is the cost: a provisioned server draws it whether or not anyone
 * visits. `loadedFraction` interpolates between the published idle and loaded watts.
 */
export function publishedHostJoulesPerView(i: {
	idleW: number;
	loadedW: number;
	loadedFraction: number;
	sitesPerServer: number;
	viewsPerSitePerMonth: number;
	pue: number;
}): number {
	const watts = i.idleW + (i.loadedW - i.idleW) * i.loadedFraction;
	const joulesPerSecond = (watts * i.pue) / i.sitesPerServer;
	const viewsPerSecond = i.viewsPerSitePerMonth / (SECONDS_PER_YEAR / 12);
	return joulesPerSecond / viewsPerSecond;
}
