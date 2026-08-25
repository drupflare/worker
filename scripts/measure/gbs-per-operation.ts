/**
 * Billed duration per COMPLETED Drupal operation, one object per workload class.
 *
 * ```sh
 * CLOUDFLARE_API_TOKEN=... bun scripts/measure/gbs-per-operation.ts \
 *   --endpoint=https://cfw-dur.example.workers.dev --account=<id> --repeat=5
 * bun scripts/measure/gbs-per-operation.ts --dry   # print the plan, touch nothing
 * ```
 *
 * WHY ONE OBJECT PER CLASS. `durableObjectsPeriodicGroups` is dimensioned by `objectId` and nothing
 * finer, so two workloads driven into one object produce one row and no way to attribute it. Naming
 * the site after the class is the whole trick, and it is why this is a script rather than a query.
 *
 * WHY DURATION AND NOT cpuTime. Measured on a deployed throwaway: ten 1,000 ms holds reported
 * `activeTime` 10,026,244 us against `cpuTime` 3,838 us -- duration bills WALL CLOCK and cpuTime
 * understates it by 2,612x. Anything derived from cpuTime is a lower bound with an unbounded gap.
 *
 * INGESTION LAGS ABOUT EIGHT MINUTES. An empty result before then is not evidence, which is why
 * `--settle` exists and defaults to 600 s rather than to zero.
 */

/** GB allocated per Durable Object, confirmed from billing rather than from a docs example */
export const DO_GB_ALLOCATED = 0.128;

/** one workload class: what it is called, and how to drive it */
export type WorkloadClass = {
	id: string;
	label: string;
	/** paths to request, in order, on a site named after this class */
	drive: (site: string) => string[];
	/** what one completed unit of this operation is, for the per-operation figure */
	unit: string;
};

/**
 * The classes, and why these.
 *
 * Each spends a different mix of meters. A render is read-dominated, a node save writes, cron runs
 * with no request to answer, and a migration is the one that replays the pack. Scoring an
 * optimisation against a render alone says nothing about the other four.
 */
export const WORKLOADS: readonly WorkloadClass[] = [
	{
		id: 'migrate',
		label: 'first migration',
		unit: 'one site provisioned',
		drive: (s) => [`/migrate?site=${s}&all=1`, `/prefill?site=${s}&force=1`]
	},
	{
		id: 'render-cold',
		label: 'cold render',
		unit: 'one page rendered on a cold object',
		drive: (s) => [`/assemble?site=${s}&path=/&bins=page,dynamic_page_cache,render`]
	},
	{
		id: 'render-warm',
		label: 'warm render',
		unit: 'one page rendered with the interpreter up',
		drive: (s) => [
			`/assemble?site=${s}&path=/&bins=page`,
			`/assemble?site=${s}&path=/&bins=page`
		]
	},
	{
		id: 'serve-hit',
		label: 'stored page',
		unit: 'one page served from storage',
		drive: (s) => [`/serve?site=${s}&path=/&edge=0`]
	},
	{
		id: 'node-save',
		label: 'node save',
		unit: 'one node written',
		drive: (s) => [`/savenode?site=${s}&title=gbs&body=gbs`]
	},
	{
		id: 'cron',
		label: 'cron run',
		unit: 'one cron pass',
		drive: (s) => [`/fillwindow?site=${s}`]
	},
	{
		id: 'invalidate',
		label: 'invalidation and refill',
		unit: 'one generation bump plus the refill it forces',
		drive: (s) => [`/invalidate?site=${s}&tags=rendered`, `/serve?site=${s}&path=/&edge=0`]
	}
];

/** what GraphQL answers, per object */
export type PeriodicRow = {
	objectId: string;
	/** GB-s */
	duration: number;
	/** microseconds of wall clock */
	activeTime: number;
	/** microseconds of CPU */
	cpuTime: number;
	rowsRead: number;
	rowsWritten: number;
};

/**
 * GB-s divided by however many units were completed.
 *
 * The point of the whole script: a per-DAY figure moves with traffic and cannot be compared across
 * workloads, while a per-OPERATION one is a property of the code.
 */
export function perOperation(row: PeriodicRow, completed: number): number {
	if (completed <= 0) return 0;
	return row.duration / completed;
}

/**
 * The duration a wall-clock reading implies, so the two can be checked against each other.
 *
 * `duration` (GB-s) should equal `activeTime` (us) / 1e6 * 0.128. Measured on a deployed throwaway:
 * `10.026244 * 0.128` reproduced the reported 1.283359232 exactly. A disagreement here means the
 * allocation is not what this file assumes, and every derived figure is wrong.
 */
export function durationFromActive(
	activeTimeMicros: number,
	gbAllocated = DO_GB_ALLOCATED
): number {
	return (activeTimeMicros / 1_000_000) * gbAllocated;
}

/** how far the reported duration is from what activeTime implies, as a ratio */
export function allocationAgreement(row: PeriodicRow): number {
	const implied = durationFromActive(row.activeTime);
	if (implied === 0) return row.duration === 0 ? 1 : Infinity;
	return row.duration / implied;
}

/**
 * How badly cpuTime understates the billed meter, for this row.
 *
 * Reported rather than assumed: the 2,612x figure came from one shape of workload (a hold with no
 * PHP in it) and a render's ratio is its own measurement.
 */
export function cpuUnderstatement(row: PeriodicRow): number {
	if (row.cpuTime === 0) return Infinity;
	return row.activeTime / row.cpuTime;
}

const GQL = `query($account: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      durableObjectsPeriodicGroups(
        limit: 200
        filter: { datetime_geq: $start, datetime_leq: $end }
      ) {
        dimensions { objectId }
        sum { activeTime cpuTime duration rowsRead rowsWritten }
      }
    }
  }
}`;

/** flattens the GraphQL body; exported so the arithmetic above can be driven without a network */
export function flattenPeriodic(body: any): PeriodicRow[] {
	const groups = body?.data?.viewer?.accounts?.[0]?.durableObjectsPeriodicGroups ?? [];
	return groups.map((g: any) => ({
		objectId: String(g?.dimensions?.objectId ?? ''),
		duration: Number(g?.sum?.duration ?? 0),
		activeTime: Number(g?.sum?.activeTime ?? 0),
		cpuTime: Number(g?.sum?.cpuTime ?? 0),
		rowsRead: Number(g?.sum?.rowsRead ?? 0),
		rowsWritten: Number(g?.sum?.rowsWritten ?? 0)
	}));
}

/** the site name a class is driven into; the class id has to survive into `objectId` to attribute */
export function siteFor(prefix: string, id: string): string {
	return `${prefix}-${id}`;
}

const arg = (name: string, fallback = '') =>
	process.argv
		.find((a) => a.startsWith(`--${name}=`))
		?.split('=')
		.slice(1)
		.join('=') ?? fallback;

if (import.meta.main) {
	const dry = process.argv.includes('--dry');
	const endpoint = arg('endpoint').replace(/\/+$/, '');
	const prefix = arg('prefix', 'gbs');
	const repeat = Number(arg('repeat', '5'));
	const settle = Number(arg('settle', '600'));

	if (dry) {
		console.log(`plan: ${WORKLOADS.length} classes x ${repeat} repeats, one object each\n`);
		for (const w of WORKLOADS) {
			console.log(`  ${siteFor(prefix, w.id).padEnd(24)} ${w.label}`);
			for (const path of w.drive(siteFor(prefix, w.id))) console.log(`      ${path}`);
		}
		console.log(`\nthen wait ${settle}s for ingestion and read durableObjectsPeriodicGroups`);
		process.exit(0);
	}

	if (endpoint === '') throw new Error('--endpoint is required (or pass --dry)');
	const account = arg('account', process.env.CLOUDFLARE_ACCOUNT_ID ?? '');
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
	if (account === '') throw new Error('--account or CLOUDFLARE_ACCOUNT_ID is required');

	const startedAt = new Date().toISOString();
	const completed = new Map<string, number>();

	for (const w of WORKLOADS) {
		const site = siteFor(prefix, w.id);
		let done = 0;
		for (let i = 0; i < repeat; i++) {
			for (const path of w.drive(site)) {
				const res = await fetch(`${endpoint}${path}`);
				// a 503 is the fill queue answering, not a failure; it still spent duration
				if (res.status >= 500 && res.status !== 503) {
					console.warn(`  ${site} ${path} -> ${res.status}`);
				}
				await res.arrayBuffer();
			}
			done++;
		}
		completed.set(site, done);
		console.log(`drove ${site}: ${done} x ${w.unit}`);
	}

	console.log(`\nwaiting ${settle}s for ingestion; an empty result before then is not evidence`);
	await new Promise((r) => setTimeout(r, settle * 1000));

	const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			query: GQL,
			variables: { account, start: startedAt, end: new Date().toISOString() }
		})
	});
	const body = await res.json();
	const rows = flattenPeriodic(body);
	if (rows.length === 0) {
		console.log('no rows; either ingestion has not caught up or the account tag is wrong');
		console.log(JSON.stringify(body).slice(0, 400));
		process.exit(1);
	}

	console.log(
		'\n| class | GB-s total | GB-s per op | rows written/op | activeTime/cpuTime | alloc check |'
	);
	console.log('| --- | --- | --- | --- | --- | --- |');
	for (const w of WORKLOADS) {
		const site = siteFor(prefix, w.id);
		const row = rows.find((r) => r.objectId.includes(site));
		if (!row) {
			console.log(`| ${w.label} | (no row) | | | | |`);
			continue;
		}
		const n = completed.get(site) ?? 0;
		console.log(
			`| ${w.label} | ${row.duration.toFixed(6)} | ${perOperation(row, n).toFixed(6)} | ` +
				`${(row.rowsWritten / Math.max(1, n)).toFixed(1)} | ` +
				`${cpuUnderstatement(row).toFixed(0)}x | ${allocationAgreement(row).toFixed(3)} |`
		);
	}
	console.log(
		`\nn=${repeat} per class. An allocation check away from 1.000 invalidates the row.`
	);
}
