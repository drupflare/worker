import { sessionCookieValue } from '../ops/auth-budget';
import { dailyLimit, REDUCE_AT } from '../ops/degrade';
import { drupalSessionRowId } from '../ops/replica';
import type { ReplicaStage } from '../ops/replica-admission';
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
import { replicaName, replicaOf } from '../ops/replica-routing';
import { ensureHashSalt } from '../ops/site-secrets';
import type { SitePhpDurableObject } from '../site-do';
import {
	DEMAND_WINDOWS_KEY,
	LANE_CURSOR_KEY,
	LANE_IN_FLIGHT_KEY,
	LANES_PROVISIONED_KEY,
	READMIT_ASKS_KEY
} from './keys';
import { SESSION_CATCHUP_MS } from './limits';
import type { Payload } from './types';

/**
 * Grows the pool when the site has been contended for several windows running, or repairs a
 * withdrawn lane. The copy runs a chunk per alarm, so no firing owns a whole table copy.
 */
export async function autoScaleStep(site: SitePhpDurableObject): Promise<Payload | undefined> {
	if (site.isPoolLane()) return undefined;
	const peak = site.inflightPeak ?? 0;
	site.inflightPeak = site.inflight ?? 0;
	const pending = site.metaGet(LANE_CURSOR_KEY);
	const stored = site.metaGet(DEMAND_WINDOWS_KEY) || '';
	// read before the idle return: a repair must also run on a quiet site
	const repairs = site.laneRepairQueue();

	// an idle tick writes nothing (it would cost a row per warming firing); a quiet window
	// clears the run, so only contended windows accumulate
	if (peak < 2) {
		if (stored !== '' && (pending === null || pending === '')) {
			site.metaSet(DEMAND_WINDOWS_KEY, '');
		}
		if ((pending === null || pending === '') && repairs.length === 0) return undefined;
	}
	let windows = JSON.parse(stored || '[]') as DemandWindow[];
	if (!Array.isArray(windows)) windows = [];
	if (peak >= 2) {
		// queueing from `laneTimings`, the quantity a lane removes
		const timings = site.laneTimings ?? [];
		const waiters = timings.filter((t) => t.ahead > 0);
		windows = recordWindow(windows, {
			peakInflight: peak,
			at: site.nowMs(),
			queued: waiters.length,
			// a floor (the clock is frozen across synchronous PHP); summed so `meanWaitMs()`
			// weights by waiters
			waitedMs: waiters.reduce((n, t) => n + t.queueMs, 0)
		});
		site.metaSet(DEMAND_WINDOWS_KEY, JSON.stringify(windows));
	}

	// a copy already in flight owns the decision until it finishes
	const provisioned = Number(site.metaGet(LANES_PROVISIONED_KEY) ?? 0) || 0;
	// a repair outranks growth, and the row budget below gates growth only (a repaired lane is
	// already paid for)
	const now = site.nowMs();
	const rows: RowBudget = {
		today: site.dailyRows(now),
		replicatedToday: site.replicatedRowsSince(now - (now % 86_400_000)),
		limit: dailyLimit('rows-written', site.env),
		dayFraction: (now % 86_400_000) / 86_400_000
	};
	const lane =
		pending !== null && pending !== ''
			? Number(site.metaGet(LANE_IN_FLIGHT_KEY) ?? 0) || undefined
			: (repairs[0] ??
				nextLaneToProvision({ windows, provisioned, env: site.env, rows }) ??
				undefined);
	// whatever demand says: another lane would not fit today's rows
	site.laneRowsCap =
		repairs.length === 0 && !laneFitsRows(rows, provisioned + 1, REDUCE_AT)
			? { at: now, lanes: provisioned + 1, ...rows }
			: undefined;
	if (lane === undefined || lane < 1) return undefined;
	const repairing = repairs.includes(lane);

	const cursor =
		pending === null || pending === '' ? undefined : (JSON.parse(pending) as ProvisionCursor);
	const out = await site.provisionLane(lane, cursor);
	if (!out.ok) {
		site.metaSet(LANE_CURSOR_KEY, '');
		return {
			autoScale: { lane, refused: out.reason, ...(repairing ? { repair: true } : {}) }
		};
	}
	if (out.done) {
		site.metaSet(LANE_CURSOR_KEY, '');
		// dequeued only on a completed copy; a refused repair is still owed
		if (repairing) site.dequeueLaneRepair(lane);
		return {
			autoScale: {
				lane,
				done: true,
				copied: out.copied,
				...(repairing ? { repair: true } : {})
			}
		};
	}
	site.metaSet(LANE_IN_FLIGHT_KEY, String(lane));
	site.metaSet(LANE_CURSOR_KEY, JSON.stringify(out.cursor));
	return { autoScale: { lane, stage: out.stage, copied: out.copied } };
}

/**
 * Puts a withdrawn lane back to `CREATED` and asks the primary for a whole re-copy: its state is
 * untrusted, so it never resumes. The ask repeats each firing until the copy lands.
 */
export async function requestReadmission(
	site: SitePhpDurableObject
): Promise<{ asked: boolean; reason: string; stage: ReplicaStage }> {
	const lane = replicaOf(site.ctx.id.name ?? '');
	if (lane === undefined) {
		return { asked: false, reason: 'not a pool lane', stage: site.replicaStage() };
	}
	if (site.replicaStage() !== 'WITHDRAWN') {
		return { asked: false, reason: 'not withdrawn', stage: site.replicaStage() };
	}
	const ns = site.env?.SITE;
	if (!ns) return { asked: false, reason: 'the namespace is not bound', stage: 'WITHDRAWN' };

	site.clearRestore();
	site.setReplicaStage('CREATED');
	// set before the hop, so a lane whose ask throws still reads as waiting
	const asks = (Number(site.metaGet(READMIT_ASKS_KEY) ?? '0') || 0) + 1;
	site.metaSet(READMIT_ASKS_KEY, String(asks));
	const res = await ns.get(ns.idFromName(lane.site)).fetch(
		new Request(`https://do.local/__replica?action=readmit&lane=${lane.lane}`, {
			method: 'POST'
		})
	);
	if (!res.ok) {
		// stays `CREATED` (it is empty now); the ask retries next firing
		return { asked: false, reason: `the primary answered ${res.status}`, stage: 'CREATED' };
	}
	return { asked: true, reason: '', stage: site.replicaStage() };
}

/**
 * Copies this primary into one lane, a bounded amount per invocation. The cursor is returned,
 * not stored, so an abandoned copy leaves nothing to clean up.
 *
 * @param budget - rows to copy before handing control back; per invocation, not a total
 */
export async function provisionLane(
	self: SitePhpDurableObject,
	lane: number,
	cursor: ProvisionCursor | undefined,
	budget = 4_000
): Promise<ProvisionOutcome> {
	const ns = self.env?.SITE;
	const site = self.ctx.id.name;
	if (self.isPoolLane() || site === undefined) {
		return { ok: false, reason: 'a lane is provisioned from the primary', done: false };
	}
	if (!ns) return { ok: false, reason: 'the namespace is not bound', done: false };
	if (!Number.isInteger(lane) || lane < 1) {
		return { ok: false, reason: 'a lane number starts at 1', done: false };
	}
	const gap = self.mandatoryGap();
	if (gap.length > 0) {
		// refused once here rather than on every chunk
		return { ok: false, reason: `the primary is missing ${gap.join(', ')}`, done: false };
	}

	// seal first, then copy at the last sealed record (not `commitSeq()`), or the next record
	// chains from below the lane's position
	await self.sealGeneration();
	const generation = self.copyableGeneration();
	if (cursor !== undefined && cursor.generation !== generation) {
		return {
			ok: false,
			torn: true,
			reason: `the primary committed during the copy: began at ${cursor.generation}, now ${generation}`,
			done: false
		};
	}

	const tables = planRestore(self.tableNames())
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
		const page = self.snapshotRows(table, at.offset, PAGE);
		const last = at.index === tables.length - 1 && page.rows.length < PAGE;
		const chunk: RestoreChunk = {
			generation,
			schemaVersion: self.packGeneration() ?? '',
			table,
			// a table with no rows still has to land, or the lane keeps whatever it had there
			columns: page.columns.length > 0 ? page.columns : ['x'],
			rows: page.rows,
			ddl: self.tableDdl(table),
			first: at.offset === 0,
			// origin and salt ride the first chunk, or the lane pins its own and sees no session
			...(at.index === 0 && at.offset === 0
				? {
						expect: tables,
						origin: self.canonicalOrigin(),
						hashSalt: ensureHashSalt(self.secretStore())
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
			self.noteLaneServing(lane);
			return { ok: true, reason: '', done: true, copied, stage: outcome.stage };
		}
	}

	const done = at.index >= tables.length;
	if (done) self.noteLaneServing(lane);
	return { ok: true, reason: '', done, cursor: at, copied };
}

/**
 * Whether this lane holds the session the cookie names, asked before the render. A miss nudges a
 * rate-limited catch-up that is not awaited (awaiting it queued lanes behind the primary).
 */
export async function sessionReach(
	site: SitePhpDurableObject,
	cookie: string
): Promise<'held' | 'absent' | 'unknown'> {
	// `unknown` defers to the render: no table or no cookie value is not evidence of no session
	if (!site.hasTable('sessions')) return 'unknown';
	const value = sessionCookieValue(cookie);
	if (value === undefined || value === '') return 'unknown';
	const id = await drupalSessionRowId(value);
	const present = () =>
		site.sql.exec(`SELECT 1 FROM sessions WHERE sid = ? LIMIT 1`, id).toArray().length > 0;
	if (present()) return 'held';
	const now = site.nowMs();
	if (now - (site.lastSessionCatchUpAt ?? 0) >= SESSION_CATCHUP_MS) {
		site.lastSessionCatchUpAt = now;
		const tally = (site.sessionCatchUps ??= { tried: 0, found: 0 });
		tally.tried += 1;
		site.ctx.waitUntil(
			site
				.catchUpOnce()
				.then((caught) => {
					if (caught.ran && caught.records > 0 && present()) tally.found += 1;
				})
				// this request hands back either way
				.catch(() => {})
		);
	}
	return 'absent';
}
