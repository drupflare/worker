/**
 * Flags for the economic models, so a reader can put their own fleet through them.
 *
 * EVERY DEFAULT IS THE VALUE THE MODEL SHIPPED WITH, because each script's output is diffed
 * against a reference to prove the port did not move a number. A flag that changes the default
 * breaks that check, which is the point: the defaults are the published run.
 *
 *   bun scripts/economics/attributional.ts --views=25000 --decades=3
 *   bun scripts/economics/fleet.ts --sites=5000 --views=10000,250000
 *   bun scripts/economics/energy.ts --grid-us=280
 */

const ARGV = process.argv.slice(2);

function raw(name: string): string | undefined {
	const hit = ARGV.find((a) => a.startsWith(`--${name}=`));
	return hit?.slice(name.length + 3);
}

/** a single number, or the default */
export function num(name: string, fallback: number): number {
	const v = raw(name);
	if (v === undefined) return fallback;
	const parsed = Number(v.replaceAll('_', '').replaceAll(',', ''));
	if (!Number.isFinite(parsed)) throw new Error(`--${name} expects a number, got ${v}`);
	return parsed;
}

/**
 * A sweep: either an explicit comma-separated list, or one value scaled by decades.
 *
 * `--views=10000,250000` gives exactly those two. `--views=25000 --decades=3` gives
 * 25,000 / 250,000 / 2,500,000, which is the shape every table here uses.
 */
export function sweep(name: string, fallback: number[], decadesFlag = 'decades'): number[] {
	const v = raw(name);
	if (v === undefined) return fallback;
	const parts = v
		.split(',')
		.map((s) => Number(s.trim().replaceAll('_', '')))
		.filter((x) => Number.isFinite(x));
	if (!parts.length) throw new Error(`--${name} expects numbers, got ${v}`);
	if (parts.length > 1) return parts;
	const decades = num(decadesFlag, 0);
	if (decades <= 1) return parts;
	return Array.from({ length: Math.trunc(decades) }, (_, i) => parts[0]! * 10 ** i);
}

/** a flag with no value, `--flag` */
export function has(name: string): boolean {
	return ARGV.includes(`--${name}`);
}
