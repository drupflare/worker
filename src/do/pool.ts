import { dailyLimit, REDUCE_AT } from '../ops/degrade';
import {
	type DemandWindow,
	laneFitsRows,
	nextLaneToProvision,
	recordWindow,
	type RowBudget
} from '../ops/replica-demand';
import {
	planRestore,
	type ProvisionCursor,
	type ProvisionOutcome,
	type RestoreChunk
} from '../ops/replica-restore';
import {
	formatLanesPointer,
	LANES_EPOCH_HEADER,
	LANES_HEADER,
	lanesKvKey,
	replicaName
} from '../ops/replica-routing';
import { ensureHashSalt } from '../ops/site-secrets';
import { firstRow } from '../util/sql';
import type { PoolHost, SiteStore } from './host';
import {
	DEMAND_WINDOWS_KEY,
	LANE_CURSOR_KEY,
	LANE_IN_FLIGHT_KEY,
	LANE_REPAIR_KEY,
	LANES_EPOCH_KEY,
	LANES_PROVISIONED_KEY
} from './keys';
import { refusesPoolOwner } from './role';
import type { Payload, Row } from './types';

/**
 * Grows the pool when the site has been contended for several windows running, or repairs a
 * withdrawn lane. The copy runs a chunk per alarm, so no firing owns a whole table copy.
 */
export async function autoScaleStep(host: PoolHost): Promise<Payload | undefined> {
	if (refusesPoolOwner(host)) return undefined;
	const peak = host.inflightPeak ?? 0;
	host.inflightPeak = host.inflight ?? 0;
	const pending = host.metaGet(LANE_CURSOR_KEY);
	const stored = host.metaGet(DEMAND_WINDOWS_KEY) || '';
	// read before the idle return: a repair must also run on a quiet site
	const repairs = host.laneRepairQueue();

	// an idle tick writes nothing (it would cost a row per warming firing); a quiet window
	// clears the run, so only contended windows accumulate
	if (peak < 2) {
		if (stored !== '' && (pending === null || pending === '')) {
			host.metaSet(DEMAND_WINDOWS_KEY, '');
		}
		if ((pending === null || pending === '') && repairs.length === 0) return undefined;
	}
	let windows = JSON.parse(stored || '[]') as DemandWindow[];
	if (!Array.isArray(windows)) windows = [];
	if (peak >= 2) {
		// queueing from `laneTimings`, the quantity a lane removes
		const timings = host.laneTimings ?? [];
		const waiters = timings.filter((t) => t.ahead > 0);
		windows = recordWindow(windows, {
			peakInflight: peak,
			at: host.nowMs(),
			queued: waiters.length,
			// a floor (the clock is frozen across synchronous PHP); summed so `meanWaitMs()`
			// weights by waiters
			waitedMs: waiters.reduce((n, t) => n + t.queueMs, 0)
		});
		host.metaSet(DEMAND_WINDOWS_KEY, JSON.stringify(windows));
	}

	// a copy already in flight owns the decision until it finishes
	const provisioned = Number(host.metaGet(LANES_PROVISIONED_KEY) ?? 0) || 0;
	// a repair outranks growth, and the row budget below gates growth only (a repaired lane is
	// already paid for)
	const now = host.nowMs();
	const rows: RowBudget = {
		today: host.dailyRows(now),
		replicatedToday: replicatedRowsSince(host, now - (now % 86_400_000)),
		limit: dailyLimit('rows-written', host.env),
		dayFraction: (now % 86_400_000) / 86_400_000
	};
	const lane =
		pending !== null && pending !== ''
			? Number(host.metaGet(LANE_IN_FLIGHT_KEY) ?? 0) || undefined
			: (repairs[0] ??
				nextLaneToProvision({ windows, provisioned, env: host.env, rows }) ??
				undefined);
	// whatever demand says: another lane would not fit today's rows
	host.laneRowsCap =
		repairs.length === 0 && !laneFitsRows(rows, provisioned + 1, REDUCE_AT)
			? { at: now, lanes: provisioned + 1, ...rows }
			: undefined;
	if (lane === undefined || lane < 1) return undefined;
	const repairing = repairs.includes(lane);

	const cursor =
		pending === null || pending === '' ? undefined : (JSON.parse(pending) as ProvisionCursor);
	const out = await host.provisionLane(lane, cursor);
	if (!out.ok) {
		host.metaSet(LANE_CURSOR_KEY, '');
		return {
			autoScale: { lane, refused: out.reason, ...(repairing ? { repair: true } : {}) }
		};
	}
	if (out.done) {
		host.metaSet(LANE_CURSOR_KEY, '');
		// dequeued only on a completed copy; a refused repair is still owed
		if (repairing) host.dequeueLaneRepair(lane);
		return {
			autoScale: {
				lane,
				done: true,
				copied: out.copied,
				...(repairing ? { repair: true } : {})
			}
		};
	}
	host.metaSet(LANE_IN_FLIGHT_KEY, String(lane));
	host.metaSet(LANE_CURSOR_KEY, JSON.stringify(out.cursor));
	return { autoScale: { lane, stage: out.stage, copied: out.copied } };
}

/**
 * Copies this primary into one lane, a bounded amount per invocation. The cursor is returned,
 * not stored, so an abandoned copy leaves nothing to clean up.
 *
 * @param budget - rows to copy before handing control back; per invocation, not a total
 */
export async function provisionLane(
	host: PoolHost,
	lane: number,
	cursor: ProvisionCursor | undefined,
	budget = 4_000
): Promise<ProvisionOutcome> {
	const ns = host.env?.SITE;
	const site = host.ctx.id.name;
	if (refusesPoolOwner(host) || site === undefined) {
		return { ok: false, reason: 'a lane is provisioned from the primary', done: false };
	}
	if (!ns) return { ok: false, reason: 'the namespace is not bound', done: false };
	if (!Number.isInteger(lane) || lane < 1) {
		return { ok: false, reason: 'a lane number starts at 1', done: false };
	}
	const gap = host.mandatoryGap();
	if (gap.length > 0) {
		// refused once here rather than on every chunk
		return { ok: false, reason: `the primary is missing ${gap.join(', ')}`, done: false };
	}

	// seal first, then copy at the last sealed record (not `commitSeq()`), or the next record
	// chains from below the lane's position
	await host.sealGeneration();
	const generation = host.copyableGeneration();
	if (cursor !== undefined && cursor.generation !== generation) {
		return {
			ok: false,
			torn: true,
			reason: `the primary committed during the copy: began at ${cursor.generation}, now ${generation}`,
			done: false
		};
	}

	const tables = planRestore(host.tableNames())
		.filter((t) => t.copy)
		.map((t) => t.table);
	const target = ns.get(ns.idFromName(replicaName(site, lane)));
	let at = cursor ?? { generation, index: 0, offset: 0 };
	let copied = 0;

	// a fresh copy sends `restart=1`: an interrupted attempt leaves `RESTORE_GENERATION_KEY`
	// behind, and every later chunk would be refused as torn
	let fresh = at.index === 0 && at.offset === 0;
	if (fresh) {
		// a new object reports no schema, and the restore refuses one it cannot match
		await target.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	}

	const PAGE = 400;
	while (at.index < tables.length && copied < budget) {
		const table = tables[at.index]!;
		const page = host.snapshotRows(table, at.offset, PAGE);
		const last = at.index === tables.length - 1 && page.rows.length < PAGE;
		const chunk: RestoreChunk = {
			generation,
			schemaVersion: host.packGeneration() ?? '',
			table,
			// a table with no rows still has to land, or the lane keeps whatever it had there
			columns: page.columns.length > 0 ? page.columns : ['x'],
			rows: page.rows,
			ddl: host.tableDdl(table),
			first: at.offset === 0,
			// origin and salt ride the first chunk, or the lane pins its own and sees no session
			...(at.index === 0 && at.offset === 0
				? {
						expect: tables,
						origin: host.canonicalOrigin(),
						hashSalt: ensureHashSalt(host.secretStore())
					}
				: {}),
			...(last ? { done: true } : {})
		};
		const res = await target.fetch(
			new Request(
				// only the first chunk: a later restart would drop this copy's own markers
				fresh
					? 'https://do.local/__replica?action=restore&restart=1'
					: 'https://do.local/__replica?action=restore',
				{
					method: 'POST',
					body: JSON.stringify(chunk),
					headers: { 'content-type': 'application/json' }
				}
			)
		);
		fresh = false;
		const outcome = (await res.json()) as { ok: boolean; reason: string; stage: string };
		if (!outcome.ok) {
			return { ok: false, reason: outcome.reason, done: false, cursor: at, copied };
		}
		copied += page.rows.length;
		at =
			page.rows.length < PAGE
				? { generation, index: at.index + 1, offset: 0 }
				: { generation, index: at.index, offset: at.offset + page.rows.length };
		if (last) {
			host.noteLaneServing(lane);
			return { ok: true, reason: '', done: true, copied, stage: outcome.stage };
		}
	}

	const done = at.index >= tables.length;
	if (done) host.noteLaneServing(lane);
	return { ok: true, reason: '', done, cursor: at, copied };
}

/** lane numbers waiting to be copied again, lowest first; read on the primary */
export function laneRepairQueue(host: SiteStore): number[] {
	const raw = host.metaGet(LANE_REPAIR_KEY) ?? '';
	const seen = new Set<number>();
	for (const part of raw.split(',')) {
		const lane = Number(part.trim());
		if (Number.isInteger(lane) && lane >= 1) seen.add(lane);
	}
	return [...seen].sort((a, b) => a - b);
}

/** records a lane as needing a fresh copy; idempotent, since a lane re-asks every firing */
export function enqueueLaneRepair(host: PoolHost, lane: number): number[] {
	if (!Number.isInteger(lane) || lane < 1) return host.laneRepairQueue();
	const queue = [...new Set([...host.laneRepairQueue(), lane])].sort((a, b) => a - b);
	host.metaSet(LANE_REPAIR_KEY, queue.join(','));
	return queue;
}

/** removes a lane from the repair queue and returns what remains */
export function dequeueLaneRepair(host: PoolHost, lane: number): number[] {
	const queue = host.laneRepairQueue().filter((n) => n !== lane);
	host.metaSet(LANE_REPAIR_KEY, queue.join(','));
	return queue;
}

/**
 * Records that a lane finished copying; the key puts `x-cfw-lanes` on responses, so every
 * provisioning path must call this (one writer).
 */
export function noteLaneServing(host: PoolHost, lane: number): void {
	const provisioned = host.lanesProvisioned();
	if (lane > provisioned) {
		const epoch = lanesEpoch(host) + 1;
		host.metaSet(LANES_PROVISIONED_KEY, String(lane));
		host.metaSet(LANES_EPOCH_KEY, String(epoch));
		host.lanesMemo = lane;
		host.pool.epochMemo = epoch;
		// once per epoch, so a colo that has never answered for this site still finds the pool
		const kv = (host.env as { CONFIG_KV?: KVNamespace } | undefined)?.CONFIG_KV;
		const site = host.ctx.id.name;
		if (kv && site) {
			host.lanesPublished = kv
				.put(lanesKvKey(site), formatLanesPointer(lane, epoch))
				.catch(() => undefined);
		}
	}
}

/** statements sealed for replication since `sinceMs`, each at least one row on every lane */
function replicatedRowsSince(host: SiteStore, sinceMs: number): number {
	try {
		const row = firstRow(
			host.sql.exec<Row<{ n: number }>>(
				'SELECT COALESCE(SUM(json_array_length(statements)), 0) AS n FROM cfw_repl_log WHERE sealed_at >= ?',
				sinceMs
			)
		);
		return Number(row?.n ?? 0);
	} catch {
		// no log yet means nothing has been sealed for a lane to replay
		return 0;
	}
}

/** the pool epoch, bumped whenever the lane count grows */
function lanesEpoch(host: PoolHost): number {
	if (host.pool.epochMemo === undefined) {
		host.pool.epochMemo = Number(host.metaGet(LANES_EPOCH_KEY) ?? 0) || 0;
	}
	return host.pool.epochMemo;
}

/** the pool advertisement every primary response carries, or nothing without a pool */
export function laneHeaders(host: PoolHost): Record<string, string> {
	const lanes = host.isPoolLane() ? 0 : host.lanesProvisioned();
	if (lanes <= 0) return {};
	return { [LANES_HEADER]: String(lanes), [LANES_EPOCH_HEADER]: String(lanesEpoch(host)) };
}

/**
 * How many lanes this primary has built; memoised for the storage fast lane, which must
 * advertise the pool on cache hits.
 */
export function lanesProvisioned(host: PoolHost): number {
	if (host.lanesMemo === undefined) {
		host.lanesMemo = Number(host.metaGet(LANES_PROVISIONED_KEY) ?? 0) || 0;
	}
	return host.lanesMemo;
}
