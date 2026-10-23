import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { reduceNavigation, rotation, type CdpEvent } from './headers-deployed';
import { counterDelta, jPerView, median, pairedRatios } from './jview-math';

export type EnergyRow = {
	arm: string;
	round: number;
	navs: number;
	requests: number;
	errors: number;
	elapsedMs: number;
	/** encoded bytes that crossed the network over the window; present in cold mode */
	bytes?: number;
	pkgJ: number;
	coreJ: number;
	load0: number;
	load1: number;
};

/** Idle-subtracted package joules per navigation for each arm, one value per round. */
export function perNavByRound(rows: EnergyRow[]): Record<string, number[]> {
	const rounds = [...new Set(rows.map((r) => r.round))].sort((a, b) => a - b);
	const out: Record<string, number[]> = {};
	for (const round of rounds) {
		const idle = rows.find((r) => r.round === round && r.arm === 'idle');
		if (!idle) throw new Error(`round ${round} has no idle window`);
		const idleW = idle.pkgJ / (idle.elapsedMs / 1000);
		for (const r of rows.filter((x) => x.round === round && x.arm !== 'idle')) {
			const j = jPerView({
				windowJ: r.pkgJ,
				elapsedS: r.elapsedMs / 1000,
				idleW,
				views: r.navs - r.errors
			});
			if (!j) throw new Error(`round ${round} ${r.arm} answered no navigations`);
			(out[r.arm] ??= []).push(j.subtracted);
		}
	}
	return out;
}

/** Median of the per-round control over treatment ratios, with the ratios themselves. */
export function pairedEnergy(rows: EnergyRow[], treatment: string, control: string) {
	const by = perNavByRound(rows);
	const ratios = pairedRatios(by[treatment] ?? [], by[control] ?? []);
	return { ratios, median: median(ratios) };
}

/** Reads a RAPL counter pair (package, core) and returns a closer that yields the deltas. */
export function raplReader(dir: string) {
	const uj = (p: string) => Number(readFileSync(p, 'utf8'));
	const range = uj(`${dir}/max_energy_range_uj`);
	return () => {
		const p0 = uj(`${dir}/energy_uj`);
		const c0 = uj(`${dir}/intel-rapl:0:0/energy_uj`);
		return () => ({
			pkgJ: counterDelta(p0, uj(`${dir}/energy_uj`), range) / 1e6,
			coreJ: counterDelta(c0, uj(`${dir}/intel-rapl:0:0/energy_uj`), range) / 1e6
		});
	};
}

const loadavg = (path: string) => {
	try {
		return Number(readFileSync(path, 'utf8').split(' ')[0]);
	} catch {
		return -1;
	}
};

async function main() {
	const env = process.env;
	const arms = [
		{ name: 'on', url: (env.ON_URL ?? '').replace(/\/$/, '') },
		{ name: 'off', url: (env.OFF_URL ?? '').replace(/\/$/, '') }
	];
	if (!arms[0]?.url || !arms[1]?.url) throw new Error('set ON_URL and OFF_URL');
	const N = Number(env.N ?? 300);
	const ROUNDS = Number(env.ROUNDS ?? 8);
	const IDLE_S = Number(env.IDLE_S ?? 30);
	const OUT = env.OUT ?? 'headers-energy.jsonl';
	const pages = (env.PAGES ?? '/,/user/login').split(',');
	const open = raplReader(env.RAPL ?? '/sys/class/powercap/intel-rapl:0');
	const { chromium } = await import('playwright');
	writeFileSync(OUT, '');

	const emit = (row: EnergyRow) => {
		appendFileSync(OUT, JSON.stringify(row) + '\n');
		console.log(
			row.arm,
			row.round,
			row.elapsedMs.toFixed(0),
			'ms',
			row.pkgJ.toFixed(2),
			'J pkg'
		);
	};

	// `cold` opens a fresh browser context for every navigation, so each is a first view with an empty
	// cache and no worker; `repeat` keeps one context, which is what a returning visitor has
	const MODE = env.MODE ?? 'repeat';
	const SETTLE_MS = Number(env.SETTLE_MS ?? 1500);
	const coldWindow = async (arm: { name: string; url: string }, round: number) => {
		const browser = await chromium.launch();
		const close = open();
		const load0 = loadavg('/proc/loadavg');
		const t0 = process.hrtime.bigint();
		let errors = 0;
		let requests = 0;
		let bytes = 0;
		for (let i = 0; i < N; i++) {
			const ctx = await browser.newContext();
			const page = await ctx.newPage();
			const cdp = await ctx.newCDPSession(page);
			await cdp.send('Network.enable');
			const events: CdpEvent[] = [];
			for (const method of [
				'Network.requestWillBeSent',
				'Network.responseReceived',
				'Network.requestServedFromCache',
				'Network.loadingFinished',
				'Network.loadingFailed'
			])
				cdp.on(method as any, (params: any) => events.push({ method, params }));
			try {
				await page.goto(arm.url + pages[i % pages.length], { waitUntil: 'load' });
				// a first view also registers and syncs a worker, which runs after load
				await page.waitForTimeout(SETTLE_MS);
			} catch {
				errors += 1;
			}
			const counts = reduceNavigation(events);
			requests += counts.network;
			bytes += counts.encodedBytes;
			await ctx.close();
		}
		const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
		const j = close();
		emit({
			arm: arm.name,
			round,
			navs: N,
			requests,
			errors,
			elapsedMs,
			bytes,
			...j,
			load0,
			load1: loadavg('/proc/loadavg')
		});
		await browser.close();
	};

	const armWindow = async (arm: { name: string; url: string }, round: number) => {
		if (MODE === 'cold') return coldWindow(arm, round);
		const browser = await chromium.launch();
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		const cdp = await ctx.newCDPSession(page);
		await cdp.send('Network.enable');
		let events: CdpEvent[] = [];
		for (const method of [
			'Network.requestWillBeSent',
			'Network.responseReceived',
			'Network.requestServedFromCache',
			'Network.loadingFinished',
			'Network.loadingFailed'
		])
			cdp.on(method as any, (params: any) => events.push({ method, params }));
		for (let i = 0; i < pages.length * 2; i++)
			await page.goto(arm.url + pages[i % pages.length]);
		await page.waitForTimeout(2000);
		events = [];
		const close = open();
		const load0 = loadavg('/proc/loadavg');
		const t0 = process.hrtime.bigint();
		let errors = 0;
		for (let i = 0; i < N; i++) {
			try {
				await page.goto(arm.url + pages[i % pages.length], { waitUntil: 'load' });
			} catch {
				errors += 1;
			}
		}
		const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
		const j = close();
		const requests = reduceNavigation(events).network;
		emit({
			arm: arm.name,
			round,
			navs: N,
			requests,
			errors,
			elapsedMs,
			...j,
			load0,
			load1: loadavg('/proc/loadavg')
		});
		await browser.close();
	};

	const idleWindow = async (round: number) => {
		await new Promise((r) => setTimeout(r, 2000));
		const close = open();
		const load0 = loadavg('/proc/loadavg');
		const t0 = process.hrtime.bigint();
		await new Promise((r) => setTimeout(r, IDLE_S * 1000));
		const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
		emit({
			arm: 'idle',
			round,
			navs: 0,
			requests: 0,
			errors: 0,
			elapsedMs,
			...close(),
			load0,
			load1: loadavg('/proc/loadavg')
		});
	};

	for (let round = 0; round < ROUNDS; round++)
		for (const name of rotation(['on', 'off', 'idle'], round)) {
			if (name === 'idle') await idleWindow(round);
			else await armWindow(arms.find((a) => a.name === name) as (typeof arms)[number], round);
		}
}

if (import.meta.main) await main();
