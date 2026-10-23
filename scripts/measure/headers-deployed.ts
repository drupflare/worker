import { appendFileSync, writeFileSync } from 'node:fs';
import { median, pairedRatios, spread, type Spread } from './jview-math';

export type CdpEvent = { method: string; params: Record<string, any> };

export type NavCounts = {
	requests: number;
	network: number;
	net200: number;
	net304: number;
	cache: number;
	other: number;
	failed: number;
	encodedBytes: number;
	urls: string[];
};

export type NavRow = NavCounts & {
	arm: string;
	round: number;
	page: string;
	kind: 'cold' | 'repeat';
	loadMs: number;
	status: number;
	headers: Record<string, string | null>;
};

const CACHED = ['HIT', 'EDGE', 'MEM'];

export const TIER_HEADERS = ['x-cfw-cache', 'x-cfw-edge', 'x-cfw-plan', 'cf-cache-status'] as const;

/** Reduces the CDP network events of one navigation to counts; `data:` URLs are not requests. */
export function reduceNavigation(events: CdpEvent[]): NavCounts {
	const urls = new Map<string, string>();
	const status = new Map<string, number>();
	const cached = new Set<string>();
	const failed = new Set<string>();
	let encodedBytes = 0;
	const order: string[] = [];
	for (const { method, params } of events) {
		const id = params.requestId as string;
		if (method === 'Network.requestWillBeSent') {
			const url = params.request.url as string;
			if (url.startsWith('data:')) continue;
			if (!urls.has(id)) order.push(id);
			urls.set(id, url);
		} else if (!urls.has(id)) {
			continue;
		} else if (method === 'Network.requestServedFromCache') {
			cached.add(id);
		} else if (method === 'Network.responseReceived') {
			status.set(id, params.response.status as number);
			if (params.response.fromDiskCache || params.response.fromServiceWorker) cached.add(id);
		} else if (method === 'Network.loadingFinished') {
			if (!cached.has(id)) encodedBytes += params.encodedDataLength as number;
		} else if (method === 'Network.loadingFailed') {
			failed.add(id);
		}
	}
	const counts: NavCounts = {
		requests: order.length,
		network: 0,
		net200: 0,
		net304: 0,
		cache: 0,
		other: 0,
		failed: 0,
		encodedBytes,
		urls: order.map((id) => urls.get(id) as string)
	};
	for (const id of order) {
		const s = status.get(id);
		if (cached.has(id)) counts.cache += 1;
		else if (failed.has(id)) {
			counts.failed += 1;
			counts.network += 1;
		} else {
			counts.network += 1;
			if (s === 200) counts.net200 += 1;
			else if (s === 304) counts.net304 += 1;
			else counts.other += 1;
		}
	}
	return counts;
}

/** The arm order for a round: the list rotated left by the round number, so every arm leads. */
export function rotation<T>(arms: T[], round: number): T[] {
	const k = round % arms.length;
	return arms.slice(k).concat(arms.slice(0, k));
}

export type CellSummary = {
	arm: string;
	page: string;
	network: Spread;
	net200: Spread;
	net304: Spread;
	cache: Spread;
	encodedBytes: Spread;
	loadMs: Spread;
	notHit: number;
};

/** Spread of each count over the repeat navigations of one arm and page. */
export function summarize(rows: NavRow[]): CellSummary[] {
	const cells = new Map<string, NavRow[]>();
	for (const r of rows) {
		if (r.kind !== 'repeat') continue;
		const key = `${r.arm}\u0000${r.page}`;
		cells.set(key, [...(cells.get(key) ?? []), r]);
	}
	return [...cells.entries()].map(([key, rs]) => {
		const [arm, page] = key.split('\u0000') as [string, string];
		const col = (f: (r: NavRow) => number) => spread(rs.map(f));
		return {
			arm,
			page,
			network: col((r) => r.network),
			net200: col((r) => r.net200),
			net304: col((r) => r.net304),
			cache: col((r) => r.cache),
			encodedBytes: col((r) => r.encodedBytes),
			loadMs: col((r) => r.loadMs),
			notHit: rs.filter((r) => !CACHED.includes(r.headers['x-cfw-cache'] ?? '')).length
		};
	});
}

/** Control over treatment, one ratio per round, from each round's median network requests. */
export function pairedRequestRatios(rows: NavRow[], treatment: string, control: string): number[] {
	const rounds = [...new Set(rows.map((r) => r.round))].sort((a, b) => a - b);
	const med = (arm: string, round: number) => {
		const xs = rows
			.filter((r) => r.kind === 'repeat' && r.arm === arm && r.round === round)
			.map((r) => r.network);
		if (xs.length === 0) throw new Error(`round ${round} has no repeat navigations for ${arm}`);
		return median(xs);
	};
	return pairedRatios(
		rounds.map((n) => med(treatment, n)),
		rounds.map((n) => med(control, n))
	);
}

const ATTR = /\b(?:href|src)=["']([^"']+)["']/g;

/** Same-origin asset paths a page references, query removed, sorted and de-duplicated. */
export function assetPaths(html: string): string[] {
	const out = new Set<string>();
	for (const m of html.matchAll(ATTR)) {
		const ref = m[1] as string;
		if (
			!/\.(css|js|woff2?|png|jpe?g|svg|ico|webp|gif)(\?|$)/.test(ref) &&
			!ref.includes('/agg/')
		)
			continue;
		if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:')) continue;
		// spool's own client tag differs between an arm that runs it and one that does not
		if (ref.startsWith('/.spool/')) continue;
		out.add(ref.split('?')[0] as string);
	}
	return [...out].sort();
}

export type PageProbe = { status: number; cache: string | null; html: string };

/** Hard stops before any counting; returns the failures, empty when the arms are comparable. */
export function guardArms(
	probes: Record<string, Record<string, PageProbe>>,
	maxLengthDiff = 0.01
): string[] {
	const arms = Object.keys(probes);
	const failures: string[] = [];
	for (const arm of arms)
		for (const [page, p] of Object.entries(probes[arm] as Record<string, PageProbe>)) {
			if (p.status !== 200) failures.push(`${arm} ${page}: status ${p.status}, want 200`);
			if (!CACHED.includes(p.cache ?? ''))
				failures.push(`${arm} ${page}: x-cfw-cache ${p.cache}, want HIT or EDGE`);
		}
	const [first, ...rest] = arms as [string, ...string[]];
	for (const arm of rest)
		for (const page of Object.keys(probes[first] as Record<string, PageProbe>)) {
			const a = probes[first]?.[page];
			const b = probes[arm]?.[page];
			if (!a || !b) {
				failures.push(`${page}: missing on ${a ? arm : first}`);
				continue;
			}
			const pa = assetPaths(a.html);
			const pb = assetPaths(b.html);
			if (pa.join('\n') !== pb.join('\n')) {
				const only = [
					...pa.filter((x) => !pb.includes(x)),
					...pb.filter((x) => !pa.includes(x))
				];
				failures.push(
					`${page}: asset sets differ between ${first} and ${arm}: ${only.slice(0, 5)}`
				);
			}
			const diff = Math.abs(a.html.length - b.html.length) / Math.max(a.html.length, 1);
			if (diff > maxLengthDiff)
				failures.push(
					`${page}: html length differs by ${(diff * 100).toFixed(2)}% (${first} ${a.html.length}, ${arm} ${b.html.length})`
				);
		}
	return failures;
}

/** Parses `--arm name=url` (repeatable), `--rounds`, `--repeats`, `--pages` and `--out`. */
export function parseArgs(argv: string[]) {
	const opts = {
		arms: [] as { name: string; url: string }[],
		rounds: 8,
		repeats: 20,
		pages: ['/', '/user/login'],
		out: '',
		settleMs: 100,
		maxLengthDiff: 0.01
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const val = argv[i + 1] as string;
		if (flag === '--arm') {
			const [name, ...url] = val.split('=');
			opts.arms.push({ name: name as string, url: url.join('=').replace(/\/$/, '') });
		} else if (flag === '--rounds') opts.rounds = Number(val);
		else if (flag === '--repeats') opts.repeats = Number(val);
		else if (flag === '--pages') {
			opts.pages = [];
			while (argv[i + 1] && !argv[i + 1]?.startsWith('--'))
				opts.pages.push(argv[++i] as string);
			continue;
		} else if (flag === '--out') opts.out = val;
		else if (flag === '--settle') opts.settleMs = Number(val);
		else if (flag === '--max-length-diff') opts.maxLengthDiff = Number(val);
		else throw new Error(`unknown flag ${flag}`);
		i += 1;
	}
	if (opts.arms.length < 2) throw new Error('need at least two --arm name=url');
	if (!opts.out) throw new Error('need --out');
	return opts;
}

async function probeArm(base: string, pages: string[]): Promise<Record<string, PageProbe>> {
	const out: Record<string, PageProbe> = {};
	for (const page of pages) {
		const res = await fetch(base + page, { headers: { accept: 'text/html' } });
		out[page] = {
			status: res.status,
			cache: res.headers.get('x-cfw-cache'),
			html: await res.text()
		};
	}
	return out;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const probes: Record<string, Record<string, PageProbe>> = {};
	for (const a of opts.arms) probes[a.name] = await probeArm(a.url, opts.pages);
	const failures = guardArms(probes, opts.maxLengthDiff);
	for (const arm of opts.arms)
		for (const page of opts.pages) {
			const p = probes[arm.name]?.[page] as PageProbe;
			console.log(
				`guard ${arm.name} ${page} status=${p.status} x-cfw-cache=${p.cache} bytes=${p.html.length} assets=${assetPaths(p.html).length}`
			);
		}
	if (failures.length) {
		console.error(`guard failed:\n${failures.join('\n')}`);
		process.exit(1);
	}
	writeFileSync(opts.out, '');
	const { chromium } = await import('playwright');
	let total = 0;
	for (let round = 0; round < opts.rounds; round++) {
		for (const arm of rotation(opts.arms, round)) {
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
			const nav = async (path: string, kind: 'cold' | 'repeat') => {
				events = [];
				const t0 = performance.now();
				const res = await page.goto(arm.url + path, { waitUntil: 'load' });
				const loadMs = performance.now() - t0;
				// a worker registers and syncs after load, so a first visit needs longer to count
				await page.waitForTimeout(kind === 'cold' ? opts.settleMs : 100);
				const h = res?.headers() ?? {};
				const row: NavRow = {
					...reduceNavigation(events),
					arm: arm.name,
					round,
					page: path,
					kind,
					loadMs,
					status: res?.status() ?? 0,
					headers: Object.fromEntries(TIER_HEADERS.map((k) => [k, h[k] ?? null]))
				};
				appendFileSync(opts.out, JSON.stringify(row) + '\n');
				total += 1;
			};
			for (const p of opts.pages) await nav(p, 'cold');
			for (let i = 0; i < opts.repeats; i++)
				await nav(opts.pages[i % opts.pages.length] as string, 'repeat');
			await browser.close();
			console.log(`round ${round} ${arm.name} done`);
		}
	}
	console.log(`navigations recorded: ${total}`);
}

if (import.meta.main) await main();
