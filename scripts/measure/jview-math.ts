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
