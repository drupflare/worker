import { readFileSync } from 'node:fs';

/** one line of probes.jsonl as scripts/measure/warm-curve.ts writes it */
export type ProbeRow = {
	run?: string;
	arm: string;
	gap: number;
	t0?: number;
	t1?: number;
	error?: string;
	status?: number;
	wallMs?: number;
	cache?: string | null;
	inlineBoot?: string | null;
	phpBooted?: string | null;
	workerMs?: string | null;
	edge?: string | null;
	cronInGap?: boolean;
	gapActualS?: number;
};

export type Stat = { n: number; median: number | null };
export type Share = { n: number; cold: number; share: number | null; ci: [number, number] | null };
export type Cell = {
	arm: string;
	gap: number;
	all: Share;
	noCron: Share;
	wallCold: Stat;
	wallWarm: Stat;
	workerCold: Stat;
	workerWarm: Stat;
	netWarm: Stat;
};
export type Analysis = {
	rows: number;
	usable: number;
	excluded: { error: number; status: number; cache: number };
	cells: Cell[];
};

const ARM_ORDER = ['off', 'dflt', 'on8'];
const Z = 1.96;

// wilson score interval: unlike the normal approximation it stays inside [0, 1] at k = 0 and k = n.
export function wilson(k: number, n: number): [number, number] | null {
	if (n === 0) return null;
	const z2 = Z * Z;
	const p = k / n;
	const d = 1 + z2 / n;
	const c = (p + z2 / (2 * n)) / d;
	const h = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
	return [c - h, c + h];
}

export function median(xs: number[]): number | null {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	if (s.length % 2) return s[mid] ?? null;
	return ((s[mid - 1] ?? NaN) + (s[mid] ?? NaN)) / 2;
}

const isCold = (r: ProbeRow): boolean => r.inlineBoot === '1';
const num = (v: string | number | null | undefined): number =>
	v === null || v === undefined || v === '' ? NaN : Number(v);

function stat(xs: number[]): Stat {
	const v = xs.filter(Number.isFinite);
	return { n: v.length, median: median(v) };
}

function share(rows: ProbeRow[]): Share {
	const cold = rows.filter(isCold).length;
	return {
		n: rows.length,
		cold,
		share: rows.length === 0 ? null : cold / rows.length,
		ci: wilson(cold, rows.length)
	};
}

export function analyze(rows: ProbeRow[]): Analysis {
	const excluded = { error: 0, status: 0, cache: 0 };
	const groups = new Map<string, { arm: string; gap: number; rows: ProbeRow[] }>();
	let usable = 0;
	for (const r of rows) {
		if (r.error) excluded.error++;
		else if (r.status !== 200) excluded.status++;
		else if (r.cache !== 'RENDER') excluded.cache++;
		else {
			usable++;
			const key = `${r.arm}|${r.gap}`;
			const g = groups.get(key) ?? { arm: r.arm, gap: r.gap, rows: [] };
			g.rows.push(r);
			groups.set(key, g);
		}
	}
	const cells: Cell[] = [...groups.values()].map(({ arm, gap, rows: cell }) => {
		const cold = cell.filter(isCold);
		const warm = cell.filter((r) => !isCold(r));
		return {
			arm,
			gap,
			all: share(cell),
			noCron: share(cell.filter((r) => !r.cronInGap)),
			wallCold: stat(cold.map((r) => num(r.wallMs))),
			wallWarm: stat(warm.map((r) => num(r.wallMs))),
			workerCold: stat(cold.map((r) => num(r.workerMs))),
			workerWarm: stat(warm.map((r) => num(r.workerMs))),
			netWarm: stat(warm.map((r) => num(r.wallMs) - num(r.workerMs)))
		};
	});
	const armRank = (a: string): number => {
		const i = ARM_ORDER.indexOf(a);
		return i === -1 ? ARM_ORDER.length : i;
	};
	cells.sort(
		(a, b) => armRank(a.arm) - armRank(b.arm) || a.arm.localeCompare(b.arm) || a.gap - b.gap
	);
	return { rows: rows.length, usable, excluded, cells };
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
const interval = (ci: [number, number] | null): string =>
	ci === null ? 'n/a' : `[${pct(ci[0])}, ${pct(ci[1])}]`;
const ms = (s: Stat): string => `${s.median === null ? 'n/a' : Math.round(s.median)} (n=${s.n})`;

function table(header: string[], body: string[][]): string {
	const all = [header, ...body];
	const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
	return all
		.map((r) =>
			r
				.map((c, i) => c.padEnd(widths[i] ?? 0))
				.join('  ')
				.trimEnd()
		)
		.join('\n');
}

export function format(a: Analysis): string {
	const e = a.excluded;
	const head = `rows ${a.rows}, usable ${a.usable}, excluded: error ${e.error}, status ${e.status}, cache not RENDER ${e.cache}`;
	const shares = table(
		[
			'arm',
			'gap',
			'cold/n',
			'share',
			'95% CI',
			'no-cron cold/n',
			'no-cron share',
			'no-cron 95% CI'
		],
		a.cells.map((c) => [
			c.arm,
			String(c.gap),
			`${c.all.cold}/${c.all.n}`,
			pct(c.all.share),
			interval(c.all.ci),
			`${c.noCron.cold}/${c.noCron.n}`,
			pct(c.noCron.share),
			interval(c.noCron.ci)
		])
	);
	const timings = table(
		[
			'arm',
			'gap',
			'wall cold ms',
			'wall warm ms',
			'worker cold ms',
			'worker warm ms',
			'warm wall-worker ms'
		],
		a.cells.map((c) => [
			c.arm,
			String(c.gap),
			ms(c.wallCold),
			ms(c.wallWarm),
			ms(c.workerCold),
			ms(c.workerWarm),
			ms(c.netWarm)
		])
	);
	return `${head}\n\n${shares}\n\n${timings}`;
}

if (import.meta.main) {
	const path = process.argv.slice(2).find((a) => !a.startsWith('--'));
	if (!path) {
		console.error('usage: bun scripts/measure/warm-curve-analyze.ts <probes.jsonl>');
		process.exit(2);
	}
	const rows = readFileSync(path, 'utf8')
		.split('\n')
		.filter((l) => l.trim() !== '')
		.map((l) => JSON.parse(l) as ProbeRow);
	console.log(format(analyze(rows)));
}
