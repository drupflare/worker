/**
 * What a site's energy and bill look like in each state it can be in, and how far the per-view
 * comparison moves when its inputs do.
 *
 *   bun scripts/economics/states.ts
 *   bun scripts/economics/states.ts --md
 *
 * The headline in perview.ts is the sleeping state: a site that holds nothing between requests. This
 * prices the others, so the document can say where each ceiling and each floor sits. Every figure is
 * `derived (modelled)`; the cold-encounter rate and the memory share are assumptions, not readings.
 */
import { WARM_INTERVAL_MS, keepWarmFleetCost } from '../measure/free-envelope';
import { TRAFFIC_MIX } from '../measure/verdict-math';
import { account } from './bill';
import {
	FLOOR_KWH_YEAR,
	HOST_MEMORY_GIB,
	HOURS_YEAR,
	IDLE_W,
	PRODUCTION_SHAPES,
	PUE_HYPER,
	W_PER_CORE,
	linearUnderstatement,
	productionKwhYear,
	wattsPerBusyCore
} from './energy';
import { drupflareMix, sharedHostingPublished } from './fleet';
import { f, n, sfx } from './fmt';
import {
	BOOTED_FOOTPRINT_MIB,
	COLD_BOOT_MS,
	JVIEW_CPU_MS,
	OBJECT_MEMORY_MIB,
	RENDER_COLD_BINS_MS,
	RENDER_WARM_BIN_MS,
	WARM_FIRING_WALL_MS
} from './measured';
import {
	COST,
	HOST_SHAPES,
	WASM_RENDER_RATIO,
	drupflareKwhYearOnMix,
	drupflareRenderRate,
	renderRate,
	type HostShape
} from './perview';

const MD = process.argv.includes('--md');
const WH_PER_J = 1 / 3600;

/** firings a day of the 8 s warming chain */
export const WARM_FIRINGS_PER_DAY = keepWarmFleetCost(1, WARM_INTERVAL_MS).armsPerSitePerDay;

/** a cold interpreter boot followed by the first render with the cache bins empty, in ms of CPU */
export const COLD_ENCOUNTER_MS = COLD_BOOT_MS + RENDER_COLD_BINS_MS;

const whOfCpuMs = (ms: number): number => ms * 1e-3 * W_PER_CORE * PUE_HYPER * WH_PER_J;

/** Wh a year of the warming chain if its CPU time were `cpuShareOfWall` of the billed wall time */
export function warmAlarmWhYear(cpuShareOfWall = 1): number {
	return whOfCpuMs(WARM_FIRINGS_PER_DAY * 365 * WARM_FIRING_WALL_MS * cpuShareOfWall);
}

/**
 * Wh a year of an object holding `mib` of memory for `resident` of the year, charged its share of the
 * host's idle draw; the defaults are the full object budget held all year
 */
export function residencyWhYear(mib = OBJECT_MEMORY_MIB, resident = 1): number {
	const share = mib / (HOST_MEMORY_GIB * 1024);
	return share * IDLE_W * HOURS_YEAR * PUE_HYPER * resident;
}

/** the shares of the year a site can hold its memory, from always to nearly never */
export const RESIDENT_SHARES = [1, 0.5, 0.25, 0.1, 0.01];

/** Wh a year of `perDay` cold interpreter encounters, each a boot plus a first render */
export function coldEncounterWhYear(perDay: number): number {
	return whOfCpuMs(perDay * 365 * COLD_ENCOUNTER_MS);
}

export interface StateRow {
	name: string;
	whYear: number;
	/** saving against the production deployment, percent */
	vsProduction: number;
	/** saving against the worst case, one small VPS, percent */
	vsVps: number;
}

/** the states a site can be in, with the whole-year energy of each at a traffic level */
export function states(viewsMonth: number): StateRow[] {
	const base = drupflareKwhYearOnMix(viewsMonth) * 1000;
	const production = productionKwhYear(PRODUCTION_SHAPES[0]!) * 1000;
	const vps = FLOOR_KWH_YEAR * 1000;
	const row = (name: string, whYear: number): StateRow => ({
		name,
		whYear,
		vsProduction: (1 - whYear / production) * 100,
		vsVps: (1 - whYear / vps) * 100
	});
	return [
		row('asleep, no cold encounters (the headline)', base),
		row('asleep, 1 cold encounter a day', base + coldEncounterWhYear(1)),
		row('asleep, 5 cold encounters a day', base + coldEncounterWhYear(5)),
		row('kept warm, warming CPU at the billed wall time', base + warmAlarmWhYear()),
		row('kept warm, a tenth of that', base + warmAlarmWhYear(0.1)),
		row(
			"kept warm, charged a booted interpreter's measured 170 MiB",
			base + residencyWhYear(BOOTED_FOOTPRINT_MIB)
		),
		row('kept warm, large-site stress: the full 195 MiB budget', base + residencyWhYear()),
		row(
			'compound adversarial bound',
			base + residencyWhYear() + warmAlarmWhYear() + coldEncounterWhYear(5)
		)
	];
}

/** the Wh a year each warm site adds in the compound adversarial bound, on top of the sleeping figure */
export const COMPOUND_EXTRA_WH_YEAR =
	residencyWhYear() + warmAlarmWhYear() + coldEncounterWhYear(5);

/**
 * Saving of `sites` drupflare sites against the published shared-hosting arm, percent, with
 * `extraWhYear` added to every site's energy; the fleet table's sleeping figure is `extraWhYear` 0
 */
export function fleetSaving(viewsMonth: number, extraWhYear = 0, sites = 1_000): number {
	const shared = sharedHostingPublished(sites, viewsMonth).kwh;
	const drupflare = drupflareMix(sites, viewsMonth) + (sites * extraWhYear) / 1000;
	return (1 - drupflare / shared) * 100;
}

// #region per-view sweep
const W = TRAFFIC_MIX;
const SC = RENDER_WARM_BIN_MS / JVIEW_CPU_MS.bastion.anonMiss;
const mj = (ms: number): number => ms * W_PER_CORE * PUE_HYPER;
const authWeights = [
	['authFront', W['auth-front']!.weight],
	['authAdmin', W['auth-admin']!.weight],
	['authAccount', W['auth-account']!.weight]
] as const;
const authTotal = authWeights.reduce((s, [, w]) => s + w, 0);
const authAvg = (ms: (k: 'authFront' | 'authAdmin' | 'authAccount') => number): number =>
	authWeights.reduce((s, [k, w]) => s + w * ms(k), 0) / authTotal;

/** logged-in CPU per view on drupflare with the compiled plan holding, `/user/1` charged the admin plan, ms */
const PLAN_MS = authAvg((k) => SC * JVIEW_CPU_MS.bastion[k === 'authAccount' ? 'authAdmin' : k]);
/** the same views when the plan does not hold and the page renders, native CPU times the wasm ratio, ms */
const RENDER_AUTH_MS = authAvg((k) => SC * WASM_RENDER_RATIO * JVIEW_CPU_MS.vps[k]);
/** a conventional host renders every logged-in view, ms */
const NATIVE_AUTH_MS = authAvg((k) => SC * JVIEW_CPU_MS.vps[k]);

/** drupflare's mJ per view when `authShare` of views are logged in and the plan holds on `hold` of them */
export function drupflareMj(viewsMonth: number, authShare: number, hold: number): number {
	const p = drupflareRenderRate(viewsMonth);
	const anon = p * COST.drupflareRender + (1 - p) * COST.drupflareHit;
	return (1 - authShare) * anon + authShare * mj(hold * PLAN_MS + (1 - hold) * RENDER_AUTH_MS);
}

/** an opponent's mJ per view at the same logged-in share, given the cost of one of its cache hits in ms */
export function opponentMj(
	shape: HostShape,
	viewsMonth: number,
	authShare: number,
	hitMs: number
): number {
	const p = renderRate(shape, viewsMonth);
	const nativeRender = SC * JVIEW_CPU_MS.vps.anonMiss;
	const anon = p * mj(nativeRender) + (1 - p) * mj(hitMs);
	return (1 - authShare) * anon + authShare * mj(NATIVE_AUTH_MS);
}

const NGINX_HIT_MS = SC * JVIEW_CPU_MS.vps.anonCached;
/** the shielded 24 h tag-purged cache, the longest lifetime Pantheon does not call excessive */
const SHIELD = HOST_SHAPES[3]!;

/** the opponent over drupflare, energy per view, so above 1 is drupflare ahead */
export function shieldRatio(
	viewsMonth: number,
	authShare: number,
	hold: number,
	hitMs: number
): number {
	return (
		opponentMj(SHIELD, viewsMonth, authShare, hitMs) / drupflareMj(viewsMonth, authShare, hold)
	);
}

/** the plan-hold share below which the shield uses less energy per view, at the model's logged-in share */
export function breakEvenHold(viewsMonth: number, hitMs: number): number {
	const auth = authTotal;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 50; i += 1) {
		const mid = (lo + hi) / 2;
		if (shieldRatio(viewsMonth, auth, mid, hitMs) < 1) lo = mid;
		else hi = mid;
	}
	return hi;
}

/** the logged-in share of views at which a shield and drupflare use equal energy, plan holding */
export function breakEvenAuthShare(viewsMonth: number, hitMs: number): number {
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 50; i += 1) {
		const mid = (lo + hi) / 2;
		if (shieldRatio(viewsMonth, mid, 1, hitMs) < 1) lo = mid;
		else hi = mid;
	}
	return hi;
}

/** logged-in share of the model's traffic mix */
export const MODEL_AUTH_SHARE = authTotal;
/** CPU of one native nginx cache hit on the deployed render's hardware, ms */
export const NGINX_HIT = NGINX_HIT_MS;
// #endregion

function table(title: string, headers: string[], rows: string[][]): void {
	if (MD) {
		console.log(`\n**${title}**\n`);
		console.log(`| ${headers.join(' | ')} |`);
		console.log(`| ${headers.map(() => '---').join(' | ')} |`);
		for (const row of rows) console.log(`| ${row.join(' | ')} |`);
		return;
	}
	console.log(`\n${title}`);
	console.log(headers.join('  '));
	for (const row of rows) console.log(row.join('  '));
}

if (import.meta.main) {
	const SHOWN = [10_000, 1_000_000, 10_000_000];
	const wh = (x: number): string =>
		x >= 1000 ? `${f(x / 1000, 2)} kWh` : `${f(x, x < 10 ? 2 : 1)} Wh`;
	const pct = (x: number): string => `${f(x, x > 99.9 ? 4 : 2)}%`;

	table(
		'energy a year of one site by state, saving against production and against one small VPS',
		[
			'state',
			...SHOWN.flatMap((v) => [`${sfx(v, 0)} views, energy`, 'vs production', 'vs VPS'])
		],
		states(SHOWN[0]!).map((s, i) => [
			s.name,
			...SHOWN.flatMap((v) => {
				const s = states(v)[i]!;
				return [wh(s.whYear), pct(s.vsProduction), pct(s.vsVps)];
			})
		])
	);

	const sites = 1_000;
	const views = 10_000;
	const asleep = account(sites, views).total;
	const warm = account(sites, views, 'always').total;
	table(
		`${n(sites, 0)} sites at ${n(views, 0)} views each, the bill`,
		['state', 'a month', 'a site a month'],
		[
			[
				'asleep (free plan default, or SITE_WARM=0)',
				`$${f(asleep, 2)}`,
				`$${f(asleep / sites, 4)}`
			],
			['kept warm (paid plan default)', `$${f(warm, 2)}`, `$${f(warm / sites, 3)}`]
		]
	);

	table(
		'1,000 sites against shared hosting: the fleet saving with each warm bound charged to every site',
		[
			'views/site/month',
			'sleeping',
			'warming CPU',
			'170 MiB held all year',
			'195 MiB held all year',
			'compound bound'
		],
		[10_000, 1_000_000, 20_000_000].map((v) => [
			n(v, 0),
			`${f(fleetSaving(v), 2)}%`,
			`${f(fleetSaving(v, warmAlarmWhYear()), 2)}%`,
			`${f(fleetSaving(v, residencyWhYear(BOOTED_FOOTPRINT_MIB)), 2)}%`,
			`${f(fleetSaving(v, residencyWhYear()), 2)}%`,
			`${f(fleetSaving(v, COMPOUND_EXTRA_WH_YEAR), 2)}%`
		])
	);

	for (const v of [10_000, 1_000_000]) {
		table(
			`${n(v, 0)} views a site: the fleet saving by the memory a site holds and the share of the year it holds it`,
			['memory held', ...RESIDENT_SHARES.map((s) => `held ${f(s * 100, 0)}% of the year`)],
			[BOOTED_FOOTPRINT_MIB, OBJECT_MEMORY_MIB].map((mib) => [
				`${mib} MiB`,
				...RESIDENT_SHARES.map((s) => `${f(fleetSaving(v, residencyWhYear(mib, s)), 2)}%`)
			])
		);
	}

	const AUTH = [0, 0.01, 0.05, 0.085, 0.2, 0.5];
	for (const v of [1_000_000, 10_000_000]) {
		table(
			`${sfx(v, 0)} views a month: the 24 h shield's energy per view over drupflare's, plan holding on all logged-in views`,
			['logged-in share', 'drupflare mJ', 'shield, nginx hit', 'shield, free hit'],
			AUTH.map((a) => [
				`${f(a * 100, 1)}%`,
				f(drupflareMj(v, a, 1), 2),
				`${f(shieldRatio(v, a, 1, NGINX_HIT_MS), 2)}x`,
				`${f(shieldRatio(v, a, 1, 0), 2)}x`
			])
		);
		table(
			`${sfx(v, 0)} views a month, the model's logged-in share: the same ratio as the plan holds on less`,
			['plan holds on', 'drupflare mJ', 'shield, nginx hit', 'shield, free hit'],
			[1, 0.9, 0.75, 0.5, 0].map((h) => [
				`${f(h * 100, 0)}%`,
				f(drupflareMj(v, authTotal, h), 2),
				`${f(shieldRatio(v, authTotal, h, NGINX_HIT_MS), 2)}x`,
				`${f(shieldRatio(v, authTotal, h, 0), 2)}x`
			])
		);
		console.log(
			`\nbreak-even at ${sfx(v, 0)} views: logged-in share ${f(breakEvenAuthShare(v, NGINX_HIT_MS) * 100, 1)}% (nginx hit), plan hold ${f(breakEvenHold(v, NGINX_HIT_MS) * 100, 0)}% (nginx hit) and ${f(breakEvenHold(v, 0) * 100, 0)}% (free hit)`
		);
	}

	table(
		'watts charged to one busy core-second, by how busy the whole host runs',
		[
			'host load',
			'watts per busy core',
			'against the model',
			'linear model understates the draw by'
		],
		[1, 0.5, 0.3, 0.15, 0.1].map((u) => [
			`${f(u * 100, 0)}%`,
			f(wattsPerBusyCore(u), 2),
			`${f(wattsPerBusyCore(u) / W_PER_CORE, 2)}x`,
			`${f(linearUnderstatement(u), 2)}x`
		])
	);
	console.log(
		`\ninputs: ${n(WARM_FIRINGS_PER_DAY, 0)} warming firings a day of ${WARM_FIRING_WALL_MS} ms wall time, a cold encounter is ${f(COLD_ENCOUNTER_MS, 0)} ms of CPU, an object holds ${OBJECT_MEMORY_MIB} MiB of a ${HOST_MEMORY_GIB} GiB host (${f((OBJECT_MEMORY_MIB / (HOST_MEMORY_GIB * 1024)) * 100, 4)}%)`
	);
}
