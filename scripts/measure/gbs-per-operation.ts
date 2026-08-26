/**
 * Billed duration per COMPLETED Drupal operation, one object per workload class.
 *
 * ```sh
 * CLOUDFLARE_API_TOKEN=... bun scripts/measure/gbs-per-operation.ts \
 *   --endpoint=https://cfw-dur.example.workers.dev --account=<id> --repeat=5
 * bun scripts/measure/gbs-per-operation.ts --dry   # print the plan, touch nothing
 * ```
 *
 * one object per class, because the dataset attributes no finer than an object. attribution is by
 * the `name` dimension: `objectId` is a hex id sharing no substring with the site name.
 *
 * duration bills wall clock, so a cpuTime-derived figure is a lower bound. provisioning runs before
 * the window and the window opens on a minute boundary, or a migration is charged to a render.
 * ingestion lags ~8 minutes, which is why `--settle` defaults to 600 s rather than zero
 */

/** GB allocated per Durable Object, confirmed from billing rather than from a docs example */
export const DO_GB_ALLOCATED = 0.128;

/** one workload class: what it is called, and how to drive it */
export type WorkloadClass = {
	id: string;
	label: string;
	/** paths to request, in order, for repeat `i` of this class */
	drive: (site: string, i: number) => string[];
	/** what one completed unit of this operation is, for the per-operation figure */
	unit: string;
	// this class IS the provisioning: never provisioned first, one fresh object per repeat
	// (a migration happens once per object), and its sites are summed on the way out
	provisions?: boolean;
};

/** one class per meter mix; a render reads, a save writes, cron answers no request */
export const WORKLOADS: readonly WorkloadClass[] = [
	{
		id: 'migrate',
		label: 'first migration',
		unit: 'one site provisioned',
		provisions: true,
		// `/prefill` is not a route; the prefill is a parameter on `/migrate`
		drive: (s, i) => [`/migrate?site=${s}-${i}&all=1&prefill=1`]
	},
	{
		id: 'render-binsempty',
		label: 'render, page+dpc+render emptied',
		unit: 'one page rendered with three bins emptied',
		drive: (s) => [`/assemble?site=${s}&path=/&bins=page,dynamic_page_cache,render`]
	},
	{
		id: 'render-warm',
		label: 'render, page bin emptied',
		unit: 'one page rendered with only the page bin emptied',
		drive: (s) => [`/assemble?site=${s}&path=/&bins=page`]
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
		drive: (s, i) => [`/savenode?site=${s}&title=gbs-${i}&body=gbs`]
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

/** every site name a class occupies; a provisioning class needs one per repeat */
export function sitesFor(prefix: string, w: WorkloadClass, repeat: number): string[] {
	const base = siteFor(prefix, w.id);
	return w.provisions ? Array.from({ length: repeat }, (_, i) => `${base}-${i}`) : [base];
}

/** what GraphQL answers, per object */
export type PeriodicRow = {
	objectId: string;
	/** the string passed to `idFromName()`; the only dimension a site name can be matched against */
	name: string;
	/** GB-s */
	duration: number;
	/** microseconds of wall clock */
	activeTime: number;
	/** microseconds of CPU */
	cpuTime: number;
	rowsRead: number;
	rowsWritten: number;
};

/** GB-s per completed unit; a per-day figure moves with traffic, a per-operation one does not */
export function perOperation(row: PeriodicRow, completed: number): number {
	if (completed <= 0) return 0;
	return row.duration / completed;
}

/** the zero row, so a class with several objects can be summed without a special case */
export function emptyRow(name = ''): PeriodicRow {
	return {
		objectId: '',
		name,
		duration: 0,
		activeTime: 0,
		cpuTime: 0,
		rowsRead: 0,
		rowsWritten: 0
	};
}

/** sums a class across every object it occupies; null means not ingested, never cost zero */
export function sumRows(
	rows: readonly PeriodicRow[],
	names: readonly string[]
): PeriodicRow | null {
	const wanted = new Set(names);
	const mine = rows.filter((r) => wanted.has(r.name));
	if (mine.length === 0) return null;
	return mine.reduce(
		(acc, r) => {
			acc.duration += r.duration;
			acc.activeTime += r.activeTime;
			acc.cpuTime += r.cpuTime;
			acc.rowsRead += r.rowsRead;
			acc.rowsWritten += r.rowsWritten;
			return acc;
		},
		emptyRow(names.join(','))
	);
}

/** the GB-s an activeTime implies; a disagreement means the allocation is wrong and so is the row */
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

/** how far cpuTime understates the billed meter here; the ratio is per workload, not a constant */
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
        dimensions { objectId name }
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
		name: String(g?.dimensions?.name ?? ''),
		duration: Number(g?.sum?.duration ?? 0),
		activeTime: Number(g?.sum?.activeTime ?? 0),
		cpuTime: Number(g?.sum?.cpuTime ?? 0),
		rowsRead: Number(g?.sum?.rowsRead ?? 0),
		rowsWritten: Number(g?.sum?.rowsWritten ?? 0)
	}));
}

/** the site name a class is driven into; the class id has to survive into `name` to attribute */
export function siteFor(prefix: string, id: string): string {
	return `${prefix}-${id}`;
}

const arg = (name: string, fallback = '') =>
	process.argv
		.find((a: string) => a.startsWith(`--${name}=`))
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
		console.log(`plan: ${WORKLOADS.length} classes x ${repeat} repeats\n`);
		for (const w of WORKLOADS) {
			const sites = sitesFor(prefix, w, repeat);
			console.log(`  ${sites.join(', ').padEnd(40)} ${w.label}`);
			const base = w.provisions ? siteFor(prefix, w.id) : (sites[0] as string);
			for (const path of w.drive(base, 0)) console.log(`      ${path}`);
		}
		console.log(`\nthen wait ${settle}s for ingestion and read durableObjectsPeriodicGroups`);
		process.exit(0);
	}

	if (endpoint === '') throw new Error('--endpoint is required (or pass --dry)');
	const account = arg('account', process.env.CLOUDFLARE_ACCOUNT_ID ?? '');
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
	if (account === '') throw new Error('--account or CLOUDFLARE_ACCOUNT_ID is required');

	const get = async (path: string) => {
		const res = await fetch(`${endpoint}${path}`);
		const text = await res.text();
		return { status: res.status, text };
	};

	// phase 1: provision outside the window, or a migration is charged to a render class
	for (const w of WORKLOADS) {
		if (w.provisions) continue;
		const site = siteFor(prefix, w.id);
		const m = await get(`/migrate?site=${site}&all=1&prefill=1`);
		let ready = false;
		for (let i = 0; i < 60 && !ready; i++) {
			const r = await get(`/serve?site=${site}&path=/&edge=0`);
			ready = r.status === 200;
			if (!ready) await new Promise((r) => setTimeout(r, 2000));
		}
		console.log(`provisioned ${site}: migrate ${m.status}, serving ${ready ? 'yes' : 'NO'}`);
		if (!ready)
			throw new Error(`${site} never served a 200; measuring it would measure warming`);
	}

	// phase 2: the dataset buckets by minute, so a mid-minute open pulls in phase 1
	const boundary = (Math.floor(Date.now() / 60_000) + 1) * 60_000 + 3_000;
	console.log(`\nwaiting ${Math.round((boundary - Date.now()) / 1000)}s for the minute boundary`);
	await new Promise((r) => setTimeout(r, Math.max(0, boundary - Date.now())));

	const startedAt = new Date().toISOString();
	const completed = new Map<string, number>();

	for (const w of WORKLOADS) {
		const sites = sitesFor(prefix, w, repeat);
		let done = 0;
		for (let i = 0; i < repeat; i++) {
			const site = (w.provisions ? sites[i] : sites[0]) as string;
			for (const path of w.drive(w.provisions ? siteFor(prefix, w.id) : site, i)) {
				const res = await get(path);
				// a 503 is the fill queue answering, not a failure; it still spent duration
				if (res.status >= 500 && res.status !== 503) {
					console.warn(`  ${site} ${path} -> ${res.status}`);
				}
			}
			done++;
		}
		completed.set(w.id, done);
		console.log(`drove ${sites.join(', ')}: ${done} x ${w.unit}`);
	}
	const endedAt = new Date().toISOString();

	console.log(`\nwaiting ${settle}s for ingestion; an empty result before then is not evidence`);
	await new Promise((r) => setTimeout(r, settle * 1000));

	const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			query: GQL,
			variables: { account, start: startedAt, end: endedAt }
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
		`\n${rows.length} objects in the window; names: ${rows.map((r) => r.name || '(unnamed)').join(', ')}`
	);

	console.log(
		'\n| class | objects | GB-s total | GB-s per op | rows written/op | activeTime/cpuTime | alloc check |'
	);
	console.log('| --- | --- | --- | --- | --- | --- | --- |');
	for (const w of WORKLOADS) {
		const names = sitesFor(prefix, w, repeat);
		const row = sumRows(rows, names);
		if (!row) {
			console.log(`| ${w.label} | ${names.length} | (no row) | | | | |`);
			continue;
		}
		const n = completed.get(w.id) ?? 0;
		console.log(
			`| ${w.label} | ${names.length} | ${row.duration.toFixed(6)} | ${perOperation(row, n).toFixed(6)} | ` +
				`${(row.rowsWritten / Math.max(1, n)).toFixed(1)} | ` +
				`${cpuUnderstatement(row).toFixed(0)}x | ${allocationAgreement(row).toFixed(3)} |`
		);
	}
	console.log(
		`\nn=${repeat} per class. An allocation check away from 1.000 invalidates the row.`
	);
	console.log(`window ${startedAt} .. ${endedAt}`);
}
