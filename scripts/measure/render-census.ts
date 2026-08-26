/**
 * What a render's SQL actually IS, and which ceiling each proposed lever moves.
 *
 *   bun scripts/measure/render-census.ts [--runs=3] [--json] [--top=12]
 *
 * Drives `statement-census.spec.ts` and does the cross-run arithmetic here, since "the same number
 * every run" is a relationship BETWEEN runs. Two paths, three arms each -- `first` pays every
 * per-path bin as a miss, `repeat` is still warming, `steady` is what a regeneration re-does.
 * Counts and bytes only: a millisecond is not the same number on the edge.
 */
import { spawnSync } from 'node:child_process';
import {
	CENSUS_CATEGORIES,
	SUBSYSTEMS,
	type Census,
	type CensusCategory,
	type Subsystem
} from '../../src/ops/statement-census.js';
import {
	DEFAULT_MIX,
	envelope,
	FREE_QUOTAS,
	ROWS_PER_FILL,
	type Envelope,
	type TrafficMix
} from './free-envelope.js';

const SPEC = 'tests/integration/statement-census.spec.ts';
const CASE = 'decomposes every crossing';
const MARKER = '[render-census]';
const CASE_DPC = 'measures what a fill';
const MARKER_DPC = '[render-census-dpc]';

/** the `bins` A/B, measured rather than subtracted off the census */
export type DpcArms = {
	rendered: Assembly;
	reassembled: Assembly;
	afterInvalidation: Assembly;
	expiries: Array<{ expire: number; count: number }>;
};

export type Assembly = {
	dynamicCache: string | null;
	hostStatements: number;
	rowsWritten: number;
	bytes: number;
};

/** the whole fill's writes, from `countingSql()`; the census sees Drupal's half only */
export type FillWrites = {
	statements: number;
	rowsWritten: number;
	byTable: Record<string, number>;
};

export type Arm = Census & {
	path: string;
	arm: string;
	crossings: number;
	/** whether `fillOne()` stored a `cfw_page` row, which is what makes an arm a REGENERATION */
	stored: boolean;
	dynamicCache: string | null;
	fill: FillWrites;
};

/**
 * Charged rows a `cfw_page` upsert costs, derived from the schema rather than measured.
 *
 * `path TEXT PRIMARY KEY` is NOT the rowid, so sqlite keeps a separate index for it and one stored
 * row is charged twice; the table declares no other index. Labelled as derived because it is: on the
 * shipped pack a fill stores no page at all -- every arm reports `stored: false` -- so there is
 * nothing to read this off, and `chargePerInsertedRow()` in `index-audit.ts` is the model it follows.
 */
export const CFW_PAGE_CHARGED_ROWS = 2;

/** what a lever would remove from ONE fill */
export type Removal = {
	statements: number;
	rowsRead: number;
	/** CHARGED rows written, the only column of the four that touches a ceiling */
	rowsWritten: number;
	resultBytes: number;
};

export const NOTHING: Removal = { statements: 0, rowsRead: 0, rowsWritten: 0, resultBytes: 0 };

export type LeverScore = {
	lever: string;
	removal: Removal;
	rowsPerFill: { before: number; after: number };
	serving: { before: number; after: number; boundBy: Envelope['servingBoundBy'] };
	regeneration: {
		before: number;
		after: number;
		boundBy: Envelope['regenerationBoundBy'];
	};
	/** the headline, and `neither` is the common answer */
	moves: 'serving' | 'regeneration' | 'both' | 'neither';
};

/**
 * Scores one lever against BOTH ceilings.
 *
 * Three of a `Removal`'s four columns are not meters: statements ride inside an invocation already
 * paid for, rows READ have a 50x allowance, and bytes are CPU. Only `rowsWritten` binds.
 *
 * @param rowsPerFill what a fill pays today, TOTAL: the census's Drupal half plus the host's.
 */
export function scoreLever(
	lever: string,
	removal: Removal,
	rowsPerFill: number,
	mix: TrafficMix = DEFAULT_MIX,
	opts: Parameters<typeof envelope>[1] = { windowed: true }
): LeverScore {
	const after = Math.max(1, rowsPerFill - Math.max(0, removal.rowsWritten));
	const before = envelope(mix, { ...opts, rowsPerFill });
	const relieved = envelope(mix, { ...opts, rowsPerFill: after });
	const movesServing = relieved.servingViewsPerDay > before.servingViewsPerDay;
	const movesRegen = relieved.regenerationsPerDay > before.regenerationsPerDay;
	return {
		lever,
		removal,
		rowsPerFill: { before: rowsPerFill, after },
		serving: {
			before: before.servingViewsPerDay,
			after: relieved.servingViewsPerDay,
			boundBy: relieved.servingBoundBy
		},
		regeneration: {
			before: before.regenerationsPerDay,
			after: relieved.regenerationsPerDay,
			boundBy: relieved.regenerationBoundBy
		},
		moves:
			movesServing && movesRegen
				? 'both'
				: movesServing
					? 'serving'
					: movesRegen
						? 'regeneration'
						: 'neither'
	};
}

/** what the census rows matching a predicate cost, which is what a lever proposes to remove */
export function removalFor(
	census: Census,
	keep: (row: Census['rows'][number]) => boolean
): Removal {
	return census.rows.filter(keep).reduce<Removal>(
		(acc, row) => ({
			statements: acc.statements + row.count,
			rowsRead: acc.rowsRead + row.rowsRead,
			rowsWritten: acc.rowsWritten + row.rowsWritten,
			resultBytes: acc.resultBytes + row.resultBytes
		}),
		{ ...NOTHING }
	);
}

/**
 * Repeats of one statement SHAPE over DIFFERENT cids, which can be batched and cannot be removed.
 *
 * The census fingerprint collapses `IN (?)` arity on purpose, so six `getMultiple()` calls for six
 * different cids read as one fingerprint run six times. Scoring that as six removable queries is the
 * over-claim this function exists to prevent: batching them into one `getMultiple` still reads the
 * same rows and still returns the same bytes, so ONLY the statement column moves.
 */
export function shapeRepeats(census: Census): Removal {
	return census.rows.reduce<Removal>(
		(acc, row) => {
			if (row.count <= 1) return acc;
			// a fingerprint with no cid at all (a bare DELETE, a router lookup bound on an integer)
			// cannot be split into shape and key repeats, so all of its repeats are counted here
			const batchable = row.distinctKeys > 0 ? row.distinctKeys - 1 : row.count - 1;
			return { ...acc, statements: acc.statements + Math.max(0, batchable) };
		},
		{ ...NOTHING }
	);
}

/**
 * Repeats of one statement with the SAME cid, which are genuinely redundant.
 *
 * These are the only repeats a deduplication could remove outright, so they are the only ones whose
 * rows and bytes come off. Prorated by the redundant share rather than attributed whole -- the first
 * execution still happens.
 */
export function keyRepeats(census: Census): Removal {
	return census.rows.reduce<Removal>(
		(acc, row) => {
			const redundant = row.distinctKeys > 0 ? row.count - row.distinctKeys : 0;
			if (redundant <= 0) return acc;
			const share = redundant / row.count;
			return {
				statements: acc.statements + redundant,
				rowsRead: acc.rowsRead + Math.round(row.rowsRead * share),
				rowsWritten: acc.rowsWritten + Math.round(row.rowsWritten * share),
				resultBytes: acc.resultBytes + Math.round(row.resultBytes * share)
			};
		},
		{ ...NOTHING }
	);
}

/** min and max across runs, so a figure is never quoted without its spread */
export type Spread = { min: number; max: number; n: number };

export function spread(values: number[]): Spread {
	return { min: Math.min(...values), max: Math.max(...values), n: values.length };
}

const show = (s: Spread) => (s.min === s.max ? String(s.min) : `${s.min}-${s.max}`);

/** one vitest case, returning every record it printed under `marker` */
function drive<T>(testCase: string, marker: string): T[] {
	const proc = spawnSync(
		'bunx',
		['vitest', 'run', '--project=workers', SPEC, '-t', testCase, '--disable-console-intercept'],
		{ encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
	);
	const text = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
	const found = text
		.split('\n')
		.filter((line) => line.includes(marker))
		.map((line) => JSON.parse(line.slice(line.indexOf('{'))) as T);
	if (found.length === 0) {
		throw new Error(
			`no ${marker} line in ${text.split('\n').length} captured lines; the arm did not run.\n` +
				`last 20:\n${text.split('\n').slice(-20).join('\n')}`
		);
	}
	return found;
}

/** one census run, returning every arm it printed */
export const runOnce = (): Arm[] => drive<Arm>(CASE, MARKER);

/** the `bins` A/B; a separate case, so a separate run */
export const runDpcArms = (): DpcArms => drive<DpcArms>(CASE_DPC, MARKER_DPC)[0]!;

const key = (a: Arm) => `${a.path} ${a.arm}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

if (import.meta.main) {
	const flag = (name: string, fallback: number): number => {
		const hit = process.argv.find((a: string) => a.startsWith(`--${name}=`));
		return hit ? Number(hit.slice(name.length + 3)) : fallback;
	};
	const runs = Math.max(1, flag('runs', 3));
	const top = Math.max(1, flag('top', 12));

	const all: Arm[][] = [];
	for (let i = 0; i < runs; i++) all.push(runOnce());

	const order = all[0]!.map(key);
	const byKey = new Map<string, Arm[]>();
	for (const run of all)
		for (const arm of run) byKey.set(key(arm), [...(byKey.get(key(arm)) ?? []), arm]);

	if (process.argv.includes('--json')) {
		console.log(JSON.stringify({ runs, arms: Object.fromEntries(byKey) }, null, 2));
		process.exit(0);
	}

	console.log(`runs              ${runs} (every figure below is min-max across them)`);
	console.log('\n=== the arms ===');
	console.log(
		'path         arm     stored  bridge stmts  distinct  fill stmts  fill rows  rows read  reply bytes'
	);
	for (const k of order) {
		const arms = byKey.get(k)!;
		const a = arms[0]!;
		console.log(
			`${a.path.padEnd(12)} ${a.arm.padEnd(7)} ${String(a.stored).padEnd(7)} ` +
				`${show(spread(arms.map((x) => x.statements))).padStart(12)}  ` +
				`${show(spread(arms.map((x) => x.distinct))).padStart(8)}  ` +
				`${show(spread(arms.map((x) => x.fill.statements))).padStart(10)}  ` +
				`${show(spread(arms.map((x) => x.fill.rowsWritten))).padStart(9)}  ` +
				`${show(spread(arms.map((x) => x.totals.rowsRead))).padStart(9)}  ` +
				`${show(spread(arms.map((x) => x.totals.resultBytes))).padStart(11)}`
		);
	}

	// the STEADY arm of the cacheable path is what a regeneration re-does, so every lever below is
	// scored against it rather than against the 48, which is a first render of a path
	const steady = byKey.get('/ steady')?.[0] ?? byKey.get(order[order.length - 1]!)![0]!;
	const first = byKey.get('/ first')?.[0] ?? steady;

	for (const [label, arm] of [
		['FIRST render of a path', first],
		['STEADY render, what a regeneration re-does', steady]
	] as const) {
		console.log(`\n=== ${label}: ${arm.path} (${arm.statements} statements) ===`);
		console.log('cnt  rows  read  written    bytes  subsystem      category        table');
		for (const row of [...arm.rows].sort((a, b) => b.count - a.count).slice(0, top)) {
			console.log(
				`${String(row.count).padStart(3)}  ${String(row.rows).padStart(4)}  ` +
					`${String(row.rowsRead).padStart(4)}  ${String(row.rowsWritten).padStart(7)}  ` +
					`${String(row.resultBytes).padStart(7)}  ${row.subsystem.padEnd(13)}  ` +
					`${row.category.padEnd(14)}  ${row.table ?? '-'}`
			);
			if (row.keys.length > 0) console.log(`     ${row.keys[0]!.slice(0, 96)}`);
		}
		console.log('\nby subsystem   stmts  read  written    bytes  share of bytes');
		for (const s of SUBSYSTEMS as Subsystem[]) {
			const v = arm.bySubsystem[s];
			if (v.statements === 0) continue;
			console.log(
				`${s.padEnd(14)} ${String(v.statements).padStart(5)}  ${String(v.rowsRead).padStart(4)}  ` +
					`${String(v.rowsWritten).padStart(7)}  ${String(v.resultBytes).padStart(7)}  ` +
					`${pct(v.resultBytes / Math.max(1, arm.totals.resultBytes)).padStart(6)}`
			);
		}
		console.log(
			`by category    ${CENSUS_CATEGORIES.map((c: CensusCategory) => `${c}=${arm.byCategory[c]}`).join(' ')}`
		);
	}

	// TOTAL rows, both halves. The census sees `cfwSqlExec` and never `this.sql`, so `fill.rowsWritten`
	// is the number a ceiling is computed from and `totals.rowsWritten` is Drupal's share of it.
	const rowsToday = steady.fill.rowsWritten;
	const rowsIfStored = rowsToday + CFW_PAGE_CHARGED_ROWS;
	console.log(`\n=== levers, scored against a fill of ${rowsIfStored} charged rows ===`);
	console.log(
		`measured today    ${rowsToday} charged rows, and the fill stored NO page ` +
			`(stored=${steady.stored}); +${CFW_PAGE_CHARGED_ROWS} is the cfw_page upsert it would pay if it did`
	);
	console.log(`the model says    ${ROWS_PER_FILL.realRender} (ROWS_PER_FILL.realRender)`);

	// a batched read still reads the same rows and returns the same bytes, so only the statement
	// column comes off; a read that is not issued at all takes its rows and bytes with it
	const batched = (r: Removal): Removal => ({
		...r,
		rowsRead: 0,
		rowsWritten: 0,
		resultBytes: 0
	});
	const dpc = removalFor(steady, (r) => r.table === 'cache_dynamic_page_cache');
	const assets = removalFor(steady, (r) => r.subsystem === 'assets');
	const renderBin = removalFor(steady, (r) => r.table === 'cache_render');
	const misses = removalFor(steady, (r) => r.category === 'cache-miss');
	const levers: Array<[string, Removal]> = [
		['empty no dynamic_page_cache', dpc],
		['asset-library payload off the bridge', { ...assets, rowsWritten: 0 }],
		['cache_render reads -> one getMultiple', batched(renderBin)],
		['fewer queries: batch every shape repeat', shapeRepeats(steady)],
		['fewer queries: drop every same-cid repeat', keyRepeats(steady)],
		['fewer rows read: read none at all', { ...NOTHING, rowsRead: steady.totals.rowsRead }],
		['Drupal cache-miss reduction', misses],
		['prepared-statement reuse', { ...NOTHING }]
	];

	console.log(
		'\nlever                                       stmts  read  written    bytes  regen/day     moves'
	);
	for (const [name, removal] of levers) {
		const s = scoreLever(name, removal, rowsIfStored);
		console.log(
			`${name.padEnd(43)} ${String(removal.statements).padStart(5)}  ` +
				`${String(removal.rowsRead).padStart(4)}  ${String(removal.rowsWritten).padStart(7)}  ` +
				`${String(removal.resultBytes).padStart(7)}  ` +
				`${String(s.regeneration.before).padStart(5)}->${String(s.regeneration.after).padEnd(6)}  ${s.moves}`
		);
	}

	// lever 1 MEASURED rather than subtracted, on one object, three assemblies back to back
	const dpcArms = runDpcArms();
	console.log('\n=== lever 1, the bins A/B: what leaving the bin warm actually costs ===');
	console.log('arm                                    dpc    host stmts  charged rows  bytes');
	for (const [label, a] of [
		['both bins emptied (what ships)', dpcArms.rendered],
		['page only, bin left warm', dpcArms.reassembled],
		['page only, after invalidateTags', dpcArms.afterInvalidation]
	] as const) {
		console.log(
			`${label.padEnd(38)} ${String(a.dynamicCache).padEnd(6)} ${String(a.hostStatements).padStart(10)}  ` +
				`${String(a.rowsWritten).padStart(12)}  ${a.bytes}`
		);
	}
	console.log(
		`stored entries: ${dpcArms.expiries.map((e) => `${e.count} at expire=${e.expire}`).join(', ')}` +
			' (-1 is CACHE_PERMANENT, and no cron rule collects this bin)'
	);

	// the read meter, stated rather than assumed away. It is 50x the write allowance and no lever
	// above comes near it, which is why every `fewer rows read` proposal scores `neither`
	const ceiling = envelope(DEFAULT_MIX, { windowed: true, rowsPerFill: rowsIfStored });
	const readsPerDay = steady.totals.rowsRead * ceiling.regenerationsPerDay;
	console.log(
		`\nrows read at the ceiling: ${steady.totals.rowsRead} per fill x ` +
			`${ceiling.regenerationsPerDay.toLocaleString()} fills = ${readsPerDay.toLocaleString()}/day, ` +
			`${pct(readsPerDay / FREE_QUOTAS.rowsReadPerDay)} of the read allowance`
	);
}
