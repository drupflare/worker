/**
 * Visitor-device energy of a repeat navigation on a drupflare site.
 *
 *   bun scripts/economics/device.ts
 *
 * The per-navigation figures are `measured`. The annual figures are `derived (modelled)`, because the
 * share of navigations that find their assets fresh in the browser is nobody's reading for a real
 * site, and they cover those navigations alone: a cold-cache navigation has no reading here. This is
 * a desktop device figure and is not added to or divided by the server energy elsewhere in this
 * folder, whose boundary is a data-centre core at modelled watts.
 */
import { sweep } from './args';
import { energyKwh, f, fr, l, n, pct, r } from './fmt';
import { REPEAT_NAV, REPEAT_NAV_DEPLOYED } from './measured';
import { VIEWS } from './perview';

/** shares of navigations that find every asset fresh: a sweep, since none is measured */
export const FRESH_SHARES = [0.25, 0.5, 0.75];

const J_PER_KWH = 3.6e6;

/** navigations a year whose assets are still fresh */
export const freshNavs = (viewsMonth: number, share: number): number => viewsMonth * 12 * share;

/** kWh a year on visitors' desktops spent by the fresh navigations alone */
export const deviceKwhYear = (viewsMonth: number, share: number): number =>
	(freshNavs(viewsMonth, share) * REPEAT_NAV.joules) / J_PER_KWH;

if (import.meta.main) {
	const shares = sweep('share', FRESH_SHARES);
	const views = sweep('views', VIEWS);
	console.log(
		`one repeat navigation, desktop RAPL package, idle subtracted, n=${REPEAT_NAV.rounds} rounds (measured)\n`
	);
	console.log(
		`${l('setup', 28)} ${r('J', 6)} ${r('range', 11)} ${r('requests', 9)} ${r('wall ms', 8)}`
	);
	for (const [name, m] of [
		['static mirror, 40 ms emulated', REPEAT_NAV],
		['deployed worker, real network', REPEAT_NAV_DEPLOYED]
	] as const) {
		const [lo, hi] = m.joulesRange;
		console.log(
			`${l(name, 28)} ${fr(m.joules, 6, 2)} ${r(`${f(lo, 2)}-${f(hi, 2)}`, 11)} ${fr(m.requests, 9, 2)} ${fr(m.wallMs, 8, 1)}`
		);
	}

	console.log(
		'\nkWh a year on visitors desktops for the fresh navigations alone, by their share of views (derived (modelled))\n'
	);
	console.log(`${l('views a month', 14)} ${shares.map((s) => r(pct(s, 0), 12)).join(' ')}`);
	for (const v of views) {
		console.log(
			`${l(n(v), 14)} ${shares.map((s) => r(energyKwh(deviceKwhYear(v, s)), 12)).join(' ')}`
		);
	}
	console.log(
		'\nno phone reading exists, and the server figures are not added to or divided into these'
	);
}
