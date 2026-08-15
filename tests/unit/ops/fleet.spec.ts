import { describe, expect, it } from 'vitest';
import {
	FLEET_HEARTBEAT_MS,
	ensureFleetTable,
	fleetSummary,
	listSites,
	reportSite,
	rolloutProgress,
	shouldReport,
	type FleetDb,
	type FleetRow
} from '../../../src/ops/fleet';

/** an in-memory stand-in; the contract is the four statements, not a database */
function fakeDb(): FleetDb & { rows: Map<string, Record<string, unknown>>; queries: string[] } {
	const rows = new Map<string, Record<string, unknown>>();
	const queries: string[] = [];
	return {
		rows,
		queries,
		prepare(query: string) {
			queries.push(query.replace(/\s+/g, ' ').trim());
			return {
				bind(...v: unknown[]) {
					return {
						async run() {
							if (/^INSERT INTO cfw_fleet/.test(query.trim())) {
								rows.set(String(v[0]), {
									site: v[0],
									pack_generation: v[1],
									core_version: v[2],
									worker_version: v[3],
									plan: v[4],
									last_seen_ms: v[5]
								});
							}
							return {};
						},
						async all<T>() {
							return {
								results: [...rows.values()].sort((a, b) =>
									String(a.site).localeCompare(String(b.site))
								) as unknown as T[]
							};
						}
					};
				}
			};
		}
	};
}

const row = (over: Partial<FleetRow> = {}): FleetRow => ({
	site: 'alpha',
	packGeneration: 'gen-1',
	coreVersion: '11.4.5',
	workerVersion: 'v1',
	plan: 'free',
	lastSeenMs: 1_000,
	...over
});

describe('shouldReport, which IS the write budget', () => {
	it('reports a site that has never reported', () => {
		expect(shouldReport(null, row(), 1_000)).toBe(true);
	});

	it('stays quiet when nothing moved and the heartbeat has not elapsed', () => {
		// D1 free allows 100,000 rows written/day, the same order as the DO ceiling; a report per
		// alarm would spend a fleet-wide meter to record that nothing changed
		expect(shouldReport(row(), row(), 1_000 + FLEET_HEARTBEAT_MS - 1)).toBe(false);
	});

	it('reports on the heartbeat even with nothing changed', () => {
		expect(shouldReport(row(), row(), 1_000 + FLEET_HEARTBEAT_MS)).toBe(true);
	});

	it.each([
		['packGeneration', { packGeneration: 'gen-2' }],
		['coreVersion', { coreVersion: '11.4.6' }],
		['workerVersion', { workerVersion: 'v2' }],
		['plan', { plan: 'paid' as const }]
	])('reports IMMEDIATELY when %s moves, which is what a rollout watches', (_label, change) => {
		expect(shouldReport(row(), row(change), 1_001)).toBe(true);
	});
});

describe('the round trip', () => {
	it('creates its table, writes a row and reads it back', async () => {
		const db = fakeDb();
		await ensureFleetTable(db);
		await reportSite(db, row());
		expect(await listSites(db)).toEqual([row()]);
		expect(db.queries[0]).toContain('CREATE TABLE IF NOT EXISTS cfw_fleet');
	});

	it('upserts rather than duplicating a site', async () => {
		const db = fakeDb();
		await reportSite(db, row());
		await reportSite(db, row({ packGeneration: 'gen-2', lastSeenMs: 2_000 }));
		const sites = await listSites(db);
		expect(sites).toHaveLength(1);
		expect(sites[0]!.packGeneration).toBe('gen-2');
	});

	it('reads an unrecognised plan back as free rather than trusting the column', async () => {
		const db = fakeDb();
		await reportSite(db, row({ plan: 'nonsense' as unknown as 'free' }));
		expect((await listSites(db))[0]!.plan).toBe('free');
	});
});

describe('fleetSummary', () => {
	const rows = [
		row({ site: 'a', packGeneration: 'gen-2' }),
		row({ site: 'b', packGeneration: 'gen-2' }),
		row({ site: 'c', packGeneration: 'gen-1' })
	];

	it('counts the fleet by pack generation, busiest first', () => {
		const out = fleetSummary(rows, 1_000);
		expect(out.sites).toBe(3);
		expect(out.byPackGeneration[0]).toEqual({ version: 'gen-2', sites: 2, fraction: 0.6667 });
		expect(out.byPackGeneration[1]).toEqual({ version: 'gen-1', sites: 1, fraction: 0.3333 });
	});

	it('reports stale sites SEPARATELY rather than counting them as unpatched', () => {
		// a site that has not checked in is evidence of nothing; folding it either way would make
		// "100% patched" a claim about sites nobody has heard from
		const out = fleetSummary(
			[row({ site: 'quiet', lastSeenMs: 0 }), row({ site: 'live', lastSeenMs: 1_000 })],
			FLEET_HEARTBEAT_MS + 500
		);
		expect(out.stale).toEqual(['quiet']);
		expect(out.sites).toBe(2);
	});

	it('handles an empty fleet without dividing by zero', () => {
		expect(fleetSummary([], 1_000)).toEqual({
			sites: 0,
			byPackGeneration: [],
			byCoreVersion: [],
			stale: []
		});
	});
});

describe('rolloutProgress', () => {
	it('reports how much of the fleet reached the target pack', () => {
		const out = rolloutProgress(
			[row({ site: 'a', packGeneration: 'new' }), row({ site: 'b', packGeneration: 'old' })],
			'new'
		);
		expect(out).toEqual({ patched: 1, total: 2, fraction: 0.5 });
	});

	it('returns null for an empty fleet rather than 0, because those differ', () => {
		// "no sites are patched" and "there are no sites" mean different things and only one of
		// them means something is wrong
		expect(rolloutProgress([], 'new')).toBeNull();
	});

	it('reports a finished rollout as exactly 1', () => {
		expect(rolloutProgress([row({ packGeneration: 'new' })], 'new')?.fraction).toBe(1);
	});
});
