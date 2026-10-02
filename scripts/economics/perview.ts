/**
 * Energy per view: how often each host shape renders, and what a view costs on the traffic mix.
 *
 *   bun scripts/economics/perview.ts
 *
 * Both tables are `derived (modelled)`. The render rate comes from the render-fraction model and the
 * energy per view charges one instrument to both sides: CPU time at the modelled watts per core and
 * PUE, with the opponent's CPU scaled to the deployed render so the two sit on one hardware basis.
 */
import { model, pageStoreFraction } from '../measure/render-fraction';
import { TRAFFIC_MIX } from '../measure/verdict-math';
import { PUE_HYPER, W_PER_CORE } from './energy';
import { fr, l, r, sfx } from './fmt';
import { CACHED_SERVE_TOTAL_MS, JVIEW_CPU_MS, RENDER_WARM_BIN_MS } from './measured';

export const VIEWS = [10_000, 100_000, 1_000_000, 10_000_000, 30_000_000];

/** a host's cache shape: how long it keeps a page, how many places keep one, what a save purges */
export interface HostShape {
	name: string;
	ttlS: number;
	colos: number;
	pagesPerSave: number;
}

/** the opponents, in the order the document prints them */
export const HOST_SHAPES: HostShape[] = [
	{ name: 'stock nginx, 5 min, no purge', ttlS: 300, colos: 1, pagesPerSave: 0 },
	{ name: 'Pantheon recommended, 1 h, one shield', ttlS: 3600, colos: 1, pagesPerSave: 5 },
	{ name: '8-location CDN, 24 h, tag purge', ttlS: 86_400, colos: 8, pagesPerSave: 5 },
	{ name: 'one shield, 24 h, tag purge', ttlS: 86_400, colos: 1, pagesPerSave: 5 }
];

/** share of views that render on an opponent shape; 100 paths, Zipf 1, 5 saves a day */
export function renderRate(shape: HostShape, viewsMonth: number): number {
	return model({
		paths: 100,
		colos: shape.colos,
		viewsPerMonth: viewsMonth,
		savesPerDay: 5,
		pagesPerSave: shape.pagesPerSave,
		zipf: 1,
		ttlS: shape.ttlS
	}).fraction;
}

/** share of views that render on drupflare's page store: saves times pages a save, never a clock */
export const drupflareRenderRate = (viewsMonth: number): number => pageStoreFraction(viewsMonth);

/** millijoules for a CPU time on the shared basis */
const mj = (ms: number): number => ms * W_PER_CORE * PUE_HYPER;

// the rig's render on the deployed render's hardware: the same render, 60.2 ms deployed, 32.5 ms here
const SCALE = RENDER_WARM_BIN_MS / JVIEW_CPU_MS.bastion.anonMiss;
const SC = (rigMs: number): number => rigMs * SCALE;

const W = TRAFFIC_MIX;
const anonShare = W['anon-cached']!.weight + W['anon-miss']!.weight;

/** per-view energy of one served class, in mJ */
export const COST = {
	drupflareRender: mj(RENDER_WARM_BIN_MS),
	drupflareHit: mj(CACHED_SERVE_TOTAL_MS),
	nativeRender: mj(SC(JVIEW_CPU_MS.vps.anonMiss)),
	nginxHit: mj(SC(JVIEW_CPU_MS.vps.anonCached)),
	fpmHit: mj(SC(JVIEW_CPU_MS.vpsFpm.anonCached))
};

/** wasm render CPU over native render CPU, same rig, same page */
export const WASM_RENDER_RATIO = JVIEW_CPU_MS.bastion.anonMiss / JVIEW_CPU_MS.vps.anonMiss;

/** logged-in share of the mix, in mJ per view; the opponent renders every one of them */
const authMj = (cpu: { authFront: number; authAdmin: number; authAccount: number }): number =>
	W['auth-front']!.weight * mj(SC(cpu.authFront)) +
	W['auth-admin']!.weight * mj(SC(cpu.authAdmin)) +
	W['auth-account']!.weight * mj(SC(cpu.authAccount));

const AUTH_OPPONENT = authMj(JVIEW_CPU_MS.vps);
// `/user/1` takes the compiled plan like `/admin/content`, so it is charged the admin plan cost
const AUTH_DRUPFLARE_PLANNED = authMj({
	...JVIEW_CPU_MS.bastion,
	authAccount: JVIEW_CPU_MS.bastion.authAdmin
});

/** drupflare, `/user/1` planned, mJ per view on the mix */
export function drupflareMjPerView(viewsMonth: number): number {
	const p = drupflareRenderRate(viewsMonth);
	return (
		anonShare * (p * COST.drupflareRender + (1 - p) * COST.drupflareHit) +
		AUTH_DRUPFLARE_PLANNED
	);
}

export interface Opponent {
	name: string;
	/** share of anonymous views that render */
	rate: (viewsMonth: number) => number;
	/** what an anonymous view that does not render costs, in mJ */
	hit: number;
}

/** the opponents scored on the mix; the last row prices a CDN hit at zero, a floor */
export const OPPONENTS: Opponent[] = [
	{ name: 'stock VPS, Drupal page cache only', rate: drupflareRenderRate, hit: COST.fpmHit },
	{
		name: 'stock nginx, 5 min, no purge',
		rate: (v) => renderRate(HOST_SHAPES[0]!, v),
		hit: COST.nginxHit
	},
	{
		name: 'Pantheon 1 h shield, origin nginx hit',
		rate: (v) => renderRate(HOST_SHAPES[1]!, v),
		hit: COST.nginxHit
	},
	{
		name: 'one shield, 24 h, tag purge, nginx hit',
		rate: (v) => renderRate(HOST_SHAPES[3]!, v),
		hit: COST.nginxHit
	},
	{
		name: 'same, CDN hit costed at 0 (a floor)',
		rate: (v) => renderRate(HOST_SHAPES[3]!, v),
		hit: 0
	}
];

/** an opponent's mJ per anonymous view */
export function opponentAnonMj(o: Opponent, viewsMonth: number): number {
	const p = o.rate(viewsMonth);
	return p * COST.nativeRender + (1 - p) * o.hit;
}

/** drupflare's mJ per anonymous view */
export function drupflareAnonMj(viewsMonth: number): number {
	const p = drupflareRenderRate(viewsMonth);
	return p * COST.drupflareRender + (1 - p) * COST.drupflareHit;
}

/** an opponent's mJ per view on the mix */
export function opponentMjPerView(o: Opponent, viewsMonth: number): number {
	return anonShare * opponentAnonMj(o, viewsMonth) + AUTH_OPPONENT;
}

/**
 * The render rate above which an nginx-hit opponent costs more per anonymous view than drupflare
 * would if it never rendered: where the hit gap (7.4 against 3.0 mJ) is paid back by renders.
 */
export const BREAK_EVEN_RENDER_RATE =
	(COST.drupflareHit - COST.nginxHit) / (COST.nativeRender - COST.nginxHit);

if (import.meta.main) {
	const head = `${l('', 42)} ${VIEWS.map((v) => r(sfx(v, 0), 9)).join(' ')}`;

	console.log('table 1: share of views that render, % (derived (modelled))\n');
	console.log(head);
	for (const s of HOST_SHAPES) {
		console.log(
			`${l(s.name, 42)} ${VIEWS.map((v) => fr(renderRate(s, v) * 100, 9, 3)).join(' ')}`
		);
	}
	console.log(
		`${l('drupflare page store', 42)} ${VIEWS.map((v) => fr(drupflareRenderRate(v) * 100, 9, 3)).join(' ')}`
	);
	console.log('\nhow many times less often drupflare renders (opponent rate / drupflare rate)');
	for (const s of HOST_SHAPES) {
		console.log(
			`${l(s.name, 42)} ${VIEWS.map((v) => fr(renderRate(s, v) / drupflareRenderRate(v), 9, 1)).join(' ')}`
		);
	}

	console.log(
		'\ntable 2: mJ per view on config/traffic.yml, opponent over drupflare (derived (modelled))\n'
	);
	console.log(head);
	console.log(
		`${l('drupflare, /user/1 planned', 42)} ${VIEWS.map((v) => fr(drupflareMjPerView(v), 9, 1)).join(' ')}`
	);
	for (const o of OPPONENTS) {
		console.log(
			`${l(o.name, 42)} ${VIEWS.map((v) => `${fr(opponentMjPerView(o, v), 5, 1)} ${fr(opponentMjPerView(o, v) / drupflareMjPerView(v), 3, 2)}x`.padStart(9 + 5)).join(' ')}`
		);
	}

	console.log('\nanonymous views only, mJ per view, and the logged-in share of the mix');
	console.log(head);
	console.log(
		`${l('drupflare', 42)} ${VIEWS.map((v) => fr(drupflareAnonMj(v), 9, 2)).join(' ')}`
	);
	for (const o of OPPONENTS) {
		console.log(
			`${l(o.name, 42)} ${VIEWS.map((v) => fr(opponentAnonMj(o, v), 9, 2)).join(' ')}`
		);
	}
	console.log(
		`  logged-in share, mJ per view on the mix: opponent ${AUTH_OPPONENT.toFixed(1)}, drupflare planned ${AUTH_DRUPFLARE_PLANNED.toFixed(1)}`
	);
	console.log(
		`  an nginx-hit opponent costs more per anonymous view once it renders on more than ${(BREAK_EVEN_RENDER_RATE * 100).toFixed(1)}% of views`
	);

	console.log('\nthe penalties');
	console.log(
		`  wasm render CPU over native: ${WASM_RENDER_RATIO.toFixed(2)}x (${JVIEW_CPU_MS.bastion.anonMiss} ms against ${JVIEW_CPU_MS.vps.anonMiss} ms on the rig, measured)`
	);
	console.log(
		`  cached hit: drupflare ${COST.drupflareHit.toFixed(1)} mJ against an nginx hit ${COST.nginxHit.toFixed(1)} mJ (derived)`
	);
	console.log(
		`  render: drupflare ${COST.drupflareRender.toFixed(1)} mJ against native ${COST.nativeRender.toFixed(1)} mJ`
	);
	console.log(
		`  logged-in share of the mix, mJ per view: opponent ${AUTH_OPPONENT.toFixed(1)}, drupflare planned ${AUTH_DRUPFLARE_PLANNED.toFixed(1)}`
	);
}
