/**
 * Python format-spec equivalents, so a ported model prints byte-identical output.
 *
 * The conversion from Python was verified by diffing every script's stdout against the original
 * rather than by reading, which is why these exist as one shared helper: `{x:>12,.0f}` and
 * `{x:>8.3f}` are the two shapes the models use everywhere, and hand-rolling them per file is how
 * a column drifts by a space and nobody notices.
 *
 * `{x:,.Nf}` -- thousands separators, fixed decimals.
 */
export function n(x: number, decimals = 0): string {
	return x.toLocaleString('en-US', {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals
	});
}

/** `{x:>W,.Nf}` -- the above, right-aligned in `width` */
export function nr(x: number, width: number, decimals = 0): string {
	return n(x, decimals).padStart(width);
}

/** `{x:.Nf}` -- fixed decimals, no separators */
export function f(x: number, decimals = 1): string {
	return x.toFixed(decimals);
}

/** `{x:>W.Nf}` -- fixed decimals, right-aligned */
export function fr(x: number, width: number, decimals = 1): string {
	return x.toFixed(decimals).padStart(width);
}

/** `{x:.N%}` -- Python multiplies by 100 and appends the sign */
export function pct(x: number, decimals = 1): string {
	return `${(x * 100).toFixed(decimals)}%`;
}

/** `{x:>W.N%}` */
export function pctr(x: number, width: number, decimals = 1): string {
	return pct(x, decimals).padStart(width);
}

/** `{s:>W}` */
export function r(s: string | number, width: number): string {
	return String(s).padStart(width);
}

/** `{s:<W}` */
export function l(s: string | number, width: number): string {
	return String(s).padEnd(width);
}

/**
 * A magnitude with a suffix and two decimals: 150988573.16 becomes `150.98M`.
 *
 * Wide tables of raw dollars are unreadable at fleet scale; the digits past the third are noise
 * against inputs that are themselves modelled to one or two figures.
 */
export function sfx(x: number, decimals = 2): string {
	const abs = Math.abs(x);
	for (const [limit, suffix] of [
		[1e12, 'T'],
		[1e9, 'B'],
		[1e6, 'M'],
		[1e3, 'K']
	] as const) {
		if (abs >= limit) return (x / limit).toFixed(decimals) + suffix;
	}
	return x.toFixed(decimals);
}

const EPS = 1e-9;

/** rounds down to `figures` significant figures, so a conservative floor never reads high */
export function floorSig(x: number, figures = 2): number {
	if (x <= 0) return 0;
	const step = 10 ** (Math.floor(Math.log10(x)) - figures + 1);
	return Math.floor(x / step + EPS) * step;
}

const UNIT_SHARES = [
	'half',
	'third',
	'quarter',
	'fifth',
	'sixth',
	'seventh',
	'eighth',
	'ninth',
	'tenth'
];

/** whole servers rounded down, or the largest unit fraction of one server that fits under the share */
export function asServers(hosts: number): string {
	const whole = Math.floor(hosts + EPS);
	if (whole >= 1) return `${n(whole)} server${whole === 1 ? '' : 's'} not built`;
	const k = Math.ceil(1 / hosts - EPS);
	const share = k <= 10 ? `a ${UNIT_SHARES[k - 2]}` : `1/${k}`;
	return `${share} of one server not built`;
}

/** whole US homes for a year, else whole days or hours of one home; always rounded down */
export function asHome(years: number): string {
	const whole = Math.floor(years + EPS);
	if (whole >= 1)
		return whole === 1 ? 'one US home for a year' : `${n(whole)} US homes for a year`;
	const days = Math.floor(years * 365.25 + EPS);
	if (days >= 1) return `one US home for ${days} day${days === 1 ? '' : 's'}`;
	const hours = Math.floor(years * 365.25 * 24 + EPS);
	return hours >= 1
		? `one US home for ${hours} hour${hours === 1 ? '' : 's'}`
		: 'under an hour of one US home';
}

/** whole cars off the road, else pounds of CO2e to two significant figures, rounded down */
export function asCar(cars: number): string {
	const whole = Math.floor(cars + EPS);
	if (whole >= 1) return `${n(whole)} car${whole === 1 ? '' : 's'} off the road`;
	return `${n(floorSig(cars * CAR_LB_CO2E_YEAR))} lb CO2e`;
}

/** EPA: a typical passenger vehicle emits 4.6 metric tons of CO2 a year */
export const CAR_LB_CO2E_YEAR = 4.6 * 2204.62;

const J_PER: Record<'mJ' | 'J' | 'kJ' | 'MJ', number> = { mJ: 1e-3, J: 1, kJ: 1e3, MJ: 1e6 };

/** joules in a named SI unit, for a table column that states its unit once in the header */
export function inUnit(joules: number, unit: keyof typeof J_PER): number {
	return joules / (J_PER[unit] as number);
}

/** three significant figures with separators and no exponent: 8.7, 25.5, 139, 13,953 */
export function sig3(x: number): string {
	if (x === 0) return '0';
	const decimals = Math.max(0, 2 - Math.floor(Math.log10(Math.abs(x))));
	return n(x, decimals);
}

/** joules with the SI prefix that makes the number read naturally: mJ, J, kJ or MJ */
export function energyJ(joules: number): string {
	const abs = Math.abs(joules);
	const unit = abs < 1 ? 'mJ' : abs < 1e3 ? 'J' : abs < 1e6 ? 'kJ' : 'MJ';
	return `${sig3(inUnit(joules, unit))} ${unit}`;
}

/** kilowatt-hours with the prefix that fits: Wh below 1 kWh, kWh below 1 MWh, otherwise MWh */
export function energyKwh(kwh: number): string {
	const abs = Math.abs(kwh);
	if (abs < 1) return `${sig3(kwh * 1e3)} Wh`;
	if (abs < 1e3) return `${sig3(kwh)} kWh`;
	return `${sig3(kwh / 1e3)} MWh`;
}
