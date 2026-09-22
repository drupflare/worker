/**
 * Python format-spec equivalents, so a ported model prints byte-identical output.
 *
 * The conversion from Python was verified by diffing every script's stdout against the original
 * rather than by reading, which is why these exist as one shared helper: `{x:>12,.0f}` and
 * `{x:>8.3f}` are the two shapes the models use everywhere, and hand-rolling them per file is how
 * a column drifts by a space and nobody notices.
 */

/** `{x:,.Nf}` -- thousands separators, fixed decimals */
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
