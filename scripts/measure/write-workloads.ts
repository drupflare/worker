/**
 * Rows, CPU and bytes per Drupal WRITE, one object per operation class.
 *
 * ```sh
 * CLOUDFLARE_API_TOKEN=... bun scripts/measure/write-workloads.ts \
 *   --endpoint=https://cfw-writes-probe.example.workers.dev --account=<id> --repeat=5
 * ```
 *
 * The host half is exact per call; the platform half attributes no finer than an OBJECT, so each
 * class gets its own site and the two are reconciled by the allocation check.
 */

import { WRITE_WORKLOADS, type WriteWorkload } from '../../src/drupal/site-php.js';
import {
	allocationAgreement,
	cpuUnderstatement,
	DO_GB_ALLOCATED,
	flattenPeriodic,
	sumRows,
	type PeriodicRow
} from './gbs-per-operation.js';

/** what the route hands back; every field is a host-side delta around the one call */
export type WriteSample = {
	op: string;
	ok: boolean;
	wallMs: number;
	hostStatementsTotal: number;
	transactions: number;
	speculativeReplays: number;
	chargedRows: number;
	databaseSizeDelta: number;
};

/** median, because the platform is bimodal by 400-600 ms and a mean hides which mode won */
export function median(xs: readonly number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** a bare single number is not a measurement here; every absolute carries its spread */
export function spread(xs: readonly number[]): { min: number; max: number; median: number } {
	return { min: Math.min(...xs), max: Math.max(...xs), median: median(xs) };
}

/** the site each class is driven into; the class id has to survive into the `name` dimension */
export function siteForOp(prefix: string, op: string): string {
	return `${prefix}-${op}`;
}

/**
 * `node-revision` and `alias-create` need a node to point at. The pack ships NONE, so the id comes
 * from a seed write; assuming 1 reported `no node 1 to revise` as if the op had failed.
 */
export function driveUrl(site: string, op: WriteWorkload, seq: number, nid = 0): string {
	const needsNode = op === 'node-revision' || op === 'alias-create';
	return `/writeworkload?site=${site}&op=${op}&seq=${seq}${needsNode ? `&nid=${nid}` : ''}`;
}

const arg = (name: string, fallback = '') =>
	process.argv
		.find((a: string) => a.startsWith(`--${name}=`))
		?.split('=')
		.slice(1)
		.join('=') ?? fallback;

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

if (import.meta.main) {
	const dry = process.argv.includes('--dry');
	// skips provisioning and the platform read, for a run driven under `wrangler tail`. The tail is
	// what gives per-INVOCATION cpuTime; the periodic dataset attributes per object and cannot
	// separate a cold boot from the write that followed it
	const driveOnly = process.argv.includes('--drive-only');
	const endpoint = arg('endpoint').replace(/\/+$/, '');
	const prefix = arg('prefix', 'ww');
	const repeat = Number(arg('repeat', '5'));
	const settle = Number(arg('settle', '600'));

	if (dry) {
		console.log(`plan: ${WRITE_WORKLOADS.length} ops x ${repeat} repeats`);
		for (const op of WRITE_WORKLOADS) {
			const site = siteForOp(prefix, op);
			console.log(`  ${site.padEnd(28)} ${driveUrl(site, op, 0, 1)}`);
		}
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
		let json: any = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* a warming page is HTML */
		}
		return { status: res.status, text, json };
	};

	// `/firstrun` refuses a password in a query string, correctly: tail and observability log one
	const post = async (path: string, body: unknown) => {
		const res = await fetch(`${endpoint}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		return { status: res.status, text: await res.text() };
	};

	// phase 1: provision, seed and WARM every object BEFORE the window opens. Three separate
	// reasons, each of which produced a wrong reading before it was written down: a 3,900-row
	// migration charged to the operation, a missing prerequisite reported as a failed op, and a
	// first call paying for a cold cache -- which read as a 3.5x spread on node-create
	const nids = new Map<string, number>();
	for (const op of WRITE_WORKLOADS) {
		const site = siteForOp(prefix, op);
		if (driveOnly) {
			// the seeded node id is not persisted anywhere the harness can read back, so a
			// drive-only pass re-seeds one; it lands outside the measured sequence either way
			if (op === 'node-revision' || op === 'alias-create') {
				const seed = await get(`/writeworkload?site=${site}&op=node-create&seq=800`);
				nids.set(op, Number(seed.json?.id ?? 0));
			}
			continue;
		}
		const m = await get(`/migrate?site=${site}&all=1&prefill=1`);
		let ready = false;
		for (let i = 0; i < 60 && !ready; i++) {
			const r = await get(`/serve?site=${site}&path=/&edge=0`);
			ready = r.status === 200;
			if (!ready) await new Promise((r) => setTimeout(r, 2000));
		}
		if (!ready) throw new Error(`${site} never served a 200`);

		// the admin account the entity writes act as; the pack ships no uid 1
		await post(`/firstrun?site=${site}`, {
			adminPass: 'cfw-Probe-9182-pass',
			siteName: 'Write workloads'
		});
		// the A/B pair, from the HOST, so no DDL lands inside a priced call
		if (op === 'txn-autoinc' || op === 'txn-rowid') {
			const ddl =
				op === 'txn-autoinc'
					? 'CREATE TABLE IF NOT EXISTS amp_txn_auto (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)'
					: 'CREATE TABLE IF NOT EXISTS amp_txn_rowid (id INTEGER PRIMARY KEY, v TEXT)';
			await get(`/sql?site=${site}&q=${encodeURIComponent(ddl)}`);
		}
		// `node-revision` and `alias-create` need a node that exists; the pack ships none
		if (op === 'node-revision' || op === 'alias-create') {
			const seed = await get(`/writeworkload?site=${site}&op=node-create&seq=900`);
			const id = Number(seed.json?.id ?? 0);
			if (id <= 0) throw new Error(`${site}: could not seed a node to point ${op} at`);
			nids.set(op, id);
		}
		// one warm call of the op itself, so the priced ones pay for the operation
		const warm = await get(driveUrl(site, op as WriteWorkload, 900 + 1, nids.get(op)));
		console.log(
			`provisioned ${site}: migrate ${m.status}, warm ${op} ${warm.json?.ok ? 'ok' : warm.text.slice(0, 120)}`
		);
	}

	// the dataset buckets by minute, so a mid-minute open pulls phase 1 in with it
	const boundary = (Math.floor(Date.now() / 60_000) + 1) * 60_000 + 3_000;
	console.log(`\nwaiting ${Math.round((boundary - Date.now()) / 1000)}s for the minute boundary`);
	await new Promise((r) => setTimeout(r, Math.max(0, boundary - Date.now())));

	const startedAt = new Date().toISOString();
	const samples = new Map<string, WriteSample[]>();

	for (const op of WRITE_WORKLOADS) {
		const site = siteForOp(prefix, op);
		const got: WriteSample[] = [];
		for (let i = 0; i < repeat; i++) {
			const res = await get(driveUrl(site, op as WriteWorkload, i + 1, nids.get(op)));
			if (res.status !== 200 || !res.json) {
				console.warn(`  ${op} seq=${i + 1} -> ${res.status} ${res.text.slice(0, 160)}`);
				continue;
			}
			got.push({
				op,
				ok: res.json.ok !== false,
				wallMs: Number(res.json.wallMs ?? 0),
				hostStatementsTotal: Number(res.json.hostStatementsTotal ?? 0),
				transactions: Number(res.json.transactions ?? 0),
				speculativeReplays: Number(res.json.speculativeReplays ?? 0),
				chargedRows: Number(res.json.chargedRows ?? 0),
				databaseSizeDelta: Number(res.json.databaseSizeDelta ?? 0)
			});
		}
		samples.set(op, got);
		console.log(`drove ${site}: ${got.length}/${repeat} ok`);
	}
	const endedAt = new Date().toISOString();

	console.log('\n## host-side, exact per call\n');
	console.log(
		'| op | n | charged rows (min/med/max) | statements | replays | bytes/op | wall ms (med) |'
	);
	console.log('| --- | --- | --- | --- | --- | --- | --- |');
	for (const op of WRITE_WORKLOADS) {
		const got = (samples.get(op) ?? []).filter((s) => s.ok);
		if (got.length === 0) {
			console.log(`| ${op} | 0 | (no sample) | | | | |`);
			continue;
		}
		const rows = spread(got.map((s) => s.chargedRows));
		const stmts = spread(got.map((s) => s.hostStatementsTotal));
		const bytes = spread(got.map((s) => s.databaseSizeDelta));
		console.log(
			`| ${op} | ${got.length} | ${rows.min}/${rows.median}/${rows.max} | ` +
				`${stmts.median} | ${median(got.map((s) => s.speculativeReplays))} | ` +
				`${bytes.median} | ${median(got.map((s) => s.wallMs))} |`
		);
	}

	if (driveOnly) {
		console.log(`\nwindow ${startedAt} .. ${endedAt}; read the CPU off the tail capture`);
		process.exit(0);
	}

	console.log(`\nwaiting ${settle}s for ingestion; an empty result before then is not evidence`);
	await new Promise((r) => setTimeout(r, settle * 1000));

	const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ query: GQL, variables: { account, start: startedAt, end: endedAt } })
	});
	const rowsBack: PeriodicRow[] = flattenPeriodic(await res.json());
	console.log('\n## platform meter, per object\n');
	console.log(
		'| op | GB-s/op | cpuTime ms/op | activeTime ms/op | active/cpu | platform rows/op | alloc |'
	);
	console.log('| --- | --- | --- | --- | --- | --- | --- |');
	for (const op of WRITE_WORKLOADS) {
		const row = sumRows(rowsBack, [siteForOp(prefix, op)]);
		const n = (samples.get(op) ?? []).filter((s) => s.ok).length || 1;
		if (!row) {
			console.log(`| ${op} | (no row) | | | | | |`);
			continue;
		}
		console.log(
			`| ${op} | ${(row.duration / n).toFixed(6)} | ${(row.cpuTime / 1000 / n).toFixed(1)} | ` +
				`${(row.activeTime / 1000 / n).toFixed(1)} | ${cpuUnderstatement(row).toFixed(1)}x | ` +
				`${(row.rowsWritten / n).toFixed(1)} | ${allocationAgreement(row).toFixed(3)} |`
		);
	}
	console.log(`\nn=${repeat} per op, GB allocated ${DO_GB_ALLOCATED}.`);
	console.log(`window ${startedAt} .. ${endedAt}`);
}
