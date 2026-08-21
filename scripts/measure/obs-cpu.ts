/**
 * Pulls per-invocation `cpuTime` out of Workers Observability as `tag<TAB>cpuMs`.
 *
 * RULE 0 says an absolute CPU figure comes only from a deployed worker's own meter, and the meter
 * meters an INVOCATION. `scripts/measure/bootphase-drive.ts` therefore tags every measured request
 * with a unique `&tag=`, and the observability dataset auto-extracts query parameters as
 * `$workers.event.request.search.tag` -- so the join back from an invocation to what it measured is
 * exact rather than a timestamp guess.
 *
 * `--model durableObject` is the default and it matters: a Durable Object invocation and the Worker
 * that dispatched it are two different budgets and both arrive in the same dataset. The same reason
 * `wrangler tail` needs asking for DO events before a tail proves anything.
 *
 * Output is the TSV `scripts/measure/bootphase-attribute.ts` reads.
 *
 *   CLOUDFLARE_API_TOKEN=... bun scripts/measure/obs-cpu.ts \
 *     --service cfw-measure --from 2026-08-15T01:00:00Z --to 2026-08-15T02:00:00Z
 */

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? '2bba2ae752a5bb611580fdccbce6d200';

type Args = Record<string, string | undefined>;

function parseArgs(argv: string[]): Args {
	const out: Args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith('--')) {
			out[key] = next;
			i++;
		} else out[key] = '1';
	}
	return out;
}

export type GroupRow = { group: string; value: number };

/**
 * One invocation, as the `events` view returns it.
 *
 * THE CALCULATIONS VIEW OMITS ZERO-VALUED GROUPS, and that is why this exists. Measured 2026-08-20
 * against `cfw-bench`: 360 tagged invocations were driven, 347 of them cost `cpuTimeMs: 0`, and a
 * `max` calculation grouped by tag returned **13 groups** -- the 3 that cost 1 ms and the 10 that
 * cost 2 ms. The query succeeded, returned no error, and reported a median of 2 ms built from 3.6%
 * of the data. The true median is 0.
 *
 * A serving path that costs under the meter's 1 ms resolution is the NORMAL case here, so an
 * instrument that can only see the tail is an instrument that inverts the answer. The events view
 * returns every invocation, zeros included.
 */
export type InvocationRow = { tag: string | null; cpuMs: number; wallMs: number; outcome: string };

/** flattens the events response, keeping every invocation including the zero-cost ones */
export function flattenEvents(body: any, groupParam = 'tag'): InvocationRow[] {
	const events = body?.result?.events?.events ?? [];
	const out: InvocationRow[] = [];
	for (const e of events) {
		const w = e?.$workers;
		if (!w) continue;
		const cpuMs = w.cpuTimeMs;
		// a dropped event carries no cpuTimeMs at all; that is absent, not zero
		if (typeof cpuMs !== 'number') continue;
		const search = w.event?.request?.search ?? {};
		const raw = search[groupParam];
		out.push({
			tag: raw === undefined || raw === null ? null : String(raw),
			cpuMs,
			wallMs: typeof w.wallTimeMs === 'number' ? w.wallTimeMs : 0,
			outcome: String(w.outcome ?? 'unknown')
		});
	}
	return out;
}

/**
 * Flattens the calculations response into `group -> value` pairs.
 *
 * The API answers a grouped calculation as one entry per group with the aggregate under the
 * calculation's alias, alongside a `series` the caller here never wants: a per-invocation figure
 * grouped by a unique tag has exactly one member per group, so the time buckets only dilute it.
 */
export function flattenCalculations(body: any, alias: string, groupKey: string): GroupRow[] {
	const calcs = body?.result?.calculations ?? [];
	const out: GroupRow[] = [];
	for (const calc of calcs) {
		if (calc?.alias !== alias) continue;
		for (const agg of calc?.aggregates ?? []) {
			const group = String(agg?.groups?.[0]?.value ?? agg?.[groupKey] ?? '');
			const value = Number(agg?.value);
			if (!group || !Number.isFinite(value)) continue;
			out.push({ group, value });
		}
	}
	return out;
}

/**
 * A timeframe bound as the API wants it, which is epoch MILLISECONDS.
 *
 * It used to send the ISO-8601 string straight through and the endpoint answers
 * `ZodError: expected number` -- so the repo's only tool for reading the one CPU figure RULE 0
 * accepts had been failing on every call. ISO in is still accepted here and converted.
 */
export function epochMillis(value: string, flag: string): number {
	const raw = value.trim();
	if (/^\d+$/.test(raw)) return Number(raw);
	const parsed = Date.parse(raw);
	if (Number.isNaN(parsed)) throw new Error(`${flag} is not ISO-8601 or epoch millis: ${value}`);
	return parsed;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
	const service = args.service ?? 'cfw-measure';
	const from = args.from;
	const to = args.to;
	if (!from || !to) throw new Error('--from and --to (ISO-8601 Z, or epoch millis) are required');
	const groupKey = args.group ?? '$workers.event.request.search.tag';
	const groupParam = groupKey.split('.').pop() ?? 'tag';
	const model = args.model ?? 'durableObject';
	const limit = Number(args.limit ?? 1000);
	// the calculations view drops zero-cost groups, so it is opt-in and never the default
	const view = args.view === 'calculations' ? 'calculations' : 'events';

	const filters: unknown[] = [
		{ key: '$metadata.service', operation: 'eq', type: 'string', value: service }
	];
	if (model !== 'any') {
		filters.push({
			key: '$workers.executionModel',
			operation: 'eq',
			type: 'string',
			value: model
		});
	}

	const parameters: Record<string, unknown> = {
		datasets: ['cloudflare-workers'],
		filterCombination: 'and',
		filters,
		limit
	};
	if (view === 'calculations') {
		parameters.calculations = [
			{ operator: 'max', key: '$workers.cpuTimeMs', keyType: 'number', alias: 'cpuMs' }
		];
		parameters.groupBys = [{ type: 'string', value: groupKey }];
	}

	const res = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				queryId: 'obs-cpu',
				view,
				dry: false,
				limit,
				parameters,
				timeframe: { from: epochMillis(from, '--from'), to: epochMillis(to, '--to') }
			})
		}
	);
	const body: any = await res.json();
	if (body?.success === false) {
		// the payload carries its validation errors under `_c`, not `errors`, so reporting
		// `body.errors` printed "undefined" for every rejected query
		const detail = body.errors?.length ? body.errors : (body._c ?? body);
		throw new Error(`observability query failed: ${JSON.stringify(detail)}`);
	}

	if (view === 'calculations') {
		const rows = flattenCalculations(body, 'cpuMs', groupKey);
		if (rows.length === 0)
			console.error('# no groups returned; widen --from/--to or check --service');
		console.error('# calculations view: groups costing 0 ms are ABSENT, not zero');
		for (const r of rows.sort((a, b) => b.value - a.value)) {
			console.log(`${r.group}\t${r.value}`);
		}
		return;
	}

	const rows = flattenEvents(body, groupParam);
	if (rows.length === 0) {
		console.error('# no invocations returned; widen --from/--to or check --service');
	}
	const untagged = rows.filter((r) => r.tag === null).length;
	if (untagged > 0) console.error(`# ${untagged} invocations carried no ?${groupParam}=`);
	for (const r of rows) {
		if (r.tag === null) continue;
		console.log(`${r.tag}\t${r.cpuMs}`);
	}
}

if (import.meta.main) await main();
