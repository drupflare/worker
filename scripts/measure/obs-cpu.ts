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

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
	const service = args.service ?? 'cfw-measure';
	const from = args.from;
	const to = args.to;
	if (!from || !to) throw new Error('--from and --to (ISO-8601 Z) are required');
	const groupKey = args.group ?? '$workers.event.request.search.tag';
	const model = args.model ?? 'durableObject';
	const limit = Number(args.limit ?? 500);

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
				view: 'calculations',
				dry: false,
				limit,
				parameters: {
					datasets: ['cloudflare-workers'],
					filterCombination: 'and',
					filters,
					calculations: [
						{
							operator: 'max',
							key: '$workers.cpuTimeMs',
							keyType: 'number',
							alias: 'cpuMs'
						}
					],
					groupBys: [{ type: 'string', value: groupKey }],
					limit
				},
				timeframe: { from, to }
			})
		}
	);
	const body: any = await res.json();
	if (body?.success === false) {
		throw new Error(`observability query failed: ${JSON.stringify(body.errors)}`);
	}
	const rows = flattenCalculations(body, 'cpuMs', groupKey);
	if (rows.length === 0) {
		console.error('# no groups returned; widen --from/--to or check --service');
	}
	for (const r of rows.sort((a, b) => b.value - a.value)) {
		console.log(`${r.group}\t${r.value}`);
	}
}

if (import.meta.main) await main();
