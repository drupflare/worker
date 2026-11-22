import { describe, expect, it } from 'vitest';
import { ensureUpdbTables } from '../../src/ops/updb';
import {
	inObject,
	markProvisioned,
	pageFor,
	provisionedSite,
	queuePath,
	type ServeDo,
	stubRender
} from '../helpers/serve-do';

const REQUEST_TIMEOUT = 300_000;

/** a clean slate: no alarm set and no memo of one */
async function clearAlarm(site: ServeDo): Promise<void> {
	await site.ctx.storage.deleteAlarm();
	site.alarmDueMs = undefined;
}

/**
 * `armFillAlarm()` inside an event waits for the event's last await.
 *
 * A fire-and-forget +1 ms `setAlarm()` ahead of an await, on an event with a large unconfirmed
 * write batch, is the shape the storage layer answers with a reset. The status and config pages
 * hit it: the advisories fetch queues a deferred call, which arms the alarm, and the page then
 * parks on the network.
 */
describe('arming the fill alarm inside an event', () => {
	it(
		'sets no alarm while an event holds arming, then sets the soonest one on release',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				await clearAlarm(site);

				site.holdArming();
				site.armFillAlarm(5_000);
				site.armFillAlarm(1);
				site.armFillAlarm(250);
				const during = await site.ctx.storage.getAlarm();
				const memoDuring = site.alarmDueMs;
				const before = Date.now();
				site.releaseArming();
				const after = await site.ctx.storage.getAlarm();
				await clearAlarm(site);
				return { during, memoDuring, after, before, holds: site.armHolds };
			});

			expect(seen.during).toBeNull();
			expect(seen.memoDuring).toBeUndefined();
			// the soonest of the three asks, which is the +1 ms one
			expect(seen.after).not.toBeNull();
			expect(seen.after as number).toBeLessThan(seen.before + 5_000);
			expect(seen.holds).toBe(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'waits for the last of two overlapping events',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				await clearAlarm(site);

				site.holdArming();
				site.holdArming();
				site.armFillAlarm();
				site.releaseArming();
				const afterFirst = await site.ctx.storage.getAlarm();
				site.releaseArming();
				const afterSecond = await site.ctx.storage.getAlarm();
				await clearAlarm(site);
				return { afterFirst, afterSecond };
			});

			expect(seen.afterFirst).toBeNull();
			expect(seen.afterSecond).not.toBeNull();
		},
		REQUEST_TIMEOUT
	);

	it(
		'keeps a sooner alarm another path set while the event ran',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				await clearAlarm(site);

				site.holdArming();
				site.armFillAlarm(60_000);
				const soon = site.nowMs() + 10;
				await site.setAlarmAt(soon);
				site.releaseArming();
				const alarm = await site.ctx.storage.getAlarm();
				await clearAlarm(site);
				return { alarm, soon };
			});

			expect(seen.alarm).toBe(seen.soon);
		},
		REQUEST_TIMEOUT
	);

	it(
		'arms at once when no event is running, as it did before',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				await clearAlarm(site);

				site.armFillAlarm();
				const alarm = await site.ctx.storage.getAlarm();
				await clearAlarm(site);
				return { alarm };
			});

			expect(seen.alarm).not.toBeNull();
		},
		REQUEST_TIMEOUT
	);

	it(
		'releases the hold when a request ends, including one that throws',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				await clearAlarm(site);

				await site.fetch(new Request('https://example.test/no-such-route-here'));
				const afterOk = site.armHolds;

				try {
					await site.fetch(new Request('https://example.test/', { method: 'BREW' }));
				} catch {
					// a throwing route is the case under test; what matters is the count after
				}
				return { afterOk, afterAny: site.armHolds };
			});

			expect(seen.afterOk).toBe(0);
			expect(seen.afterAny).toBe(0);
		},
		REQUEST_TIMEOUT
	);
});

type Stubs = Record<string, unknown>;

/** makes the firing ask for a +1 ms alarm before any phase runs, the way a queued refill does */
function parkSoonerArm(site: ServeDo): void {
	const stubs = site as unknown as Stubs & { adoptSettings: () => Promise<void> };
	const adopt = stubs.adoptSettings.bind(site);
	stubs.adoptSettings = async () => {
		await adopt();
		site.armFillAlarm();
	};
}

/** runs one alarm firing and reads the alarm the object holds afterwards */
async function fireOnce(
	site: ServeDo,
	arrange: (stubs: Stubs) => void
): Promise<{ alarm: number | null; before: number; holds: number }> {
	markProvisioned(site);
	await clearAlarm(site);
	parkSoonerArm(site);
	arrange(site as unknown as Stubs);
	const before = site.nowMs();
	await site.alarm();
	const alarm = await site.ctx.storage.getAlarm();
	const holds = site.armHolds;
	await clearAlarm(site);
	return { alarm, before, holds };
}

/**
 * A gate that ends the firing sets its own alarm, and a sooner arm made earlier in the firing is
 * replaced by it. Before arms were held, the earlier arm landed at once and the gate's own alarm
 * overwrote it; releasing the hold afterwards must not bring it back.
 */
describe('a firing that ends at a gate', () => {
	const CASES: Array<{
		gate: string;
		ownMs: number;
		arrange: (site: ServeDo) => void;
	}> = [
		{
			gate: 'a pool lane catching up',
			ownMs: 2_000,
			arrange: (site) => {
				const s = site as unknown as Stubs;
				s.isPoolLane = () => true;
				s.replicaStage = () => 'CATCHING_UP';
				s.catchUpOnce = async () => ({ ran: true });
			}
		},
		{
			gate: 'a migration step',
			ownMs: 240_000,
			arrange: (site) => {
				(site as unknown as Stubs).migrateStepIfPending = async () => ({
					migrate: { done: true, ok: true }
				});
			}
		},
		{
			gate: 'a database update step',
			ownMs: 200_000,
			arrange: (site) => {
				ensureUpdbTables(site.sql as never);
				site.sql.exec(
					`INSERT INTO cfw_updb_run (id, schema_version, phase, started_at, updated_at)
					 VALUES ('run', 1, 'running', 0, 0)`
				);
				(site as unknown as Stubs).updbStepOnce = async () => ({ updb: { more: false } });
			}
		},
		{
			gate: 'a stepped job that has finished',
			ownMs: 1_000,
			arrange: (site) => {
				let active = true;
				const s = site as unknown as Stubs;
				s.opsJobActive = () => active;
				s.opsJobBeat = async () => {
					active = false;
					return { opsJob: {} };
				};
			}
		},
		{
			gate: 'a quarantined site',
			ownMs: 60_000,
			arrange: (site) => {
				site.metaSet(
					'repair_state',
					JSON.stringify({
						rung: 'quarantine',
						code: 'test',
						strikes: 3,
						quarantinedAt: site.nowMs(),
						lastRollbackAt: null
					})
				);
			}
		},
		{
			gate: 'an incomplete migration',
			ownMs: 1_000,
			arrange: (site) => {
				(site as unknown as Stubs).migratePartial = () => ({ state: 'running' });
			}
		},
		{
			gate: 'pool growth',
			ownMs: 1_000,
			arrange: (site) => {
				(site as unknown as Stubs).autoScaleStep = async () => ({ grew: true });
			}
		},
		{
			gate: 'a reconcile step',
			ownMs: 1_000,
			arrange: (site) => {
				(site as unknown as Stubs).reconcileStepOnce = async () => ({
					reconcile: { ran: true }
				});
			}
		},
		{
			gate: 'the heap image',
			ownMs: 1_000,
			arrange: (site) => {
				(site as unknown as Stubs).snapshotStep = async () => ({ imaged: true });
			}
		}
	];

	for (const { gate, ownMs, arrange } of CASES) {
		it(
			`keeps its own alarm over an arm made earlier in the firing: ${gate}`,
			async () => {
				const seen = await inObject(await provisionedSite(), (site: ServeDo) =>
					fireOnce(site, () => arrange(site))
				);

				expect(seen.holds).toBe(0);
				expect(seen.alarm).not.toBeNull();
				expect(seen.alarm as number).toBeGreaterThanOrEqual(seen.before + ownMs);
			},
			REQUEST_TIMEOUT
		);
	}

	it(
		'keeps the idle re-arm over an arm made earlier in a firing that reaches the end',
		async () => {
			const seen = await inObject(await provisionedSite(), (site: ServeDo) =>
				fireOnce(site, () => {})
			);

			expect(seen.alarm).not.toBeNull();
			expect(seen.alarm as number).toBeGreaterThanOrEqual(seen.before + 10_000);
		},
		REQUEST_TIMEOUT
	);

	it(
		'keeps an earlier arm when the gate ends the firing without setting an alarm',
		async () => {
			const seen = await inObject(await provisionedSite(), (site: ServeDo) =>
				fireOnce(site, () => {
					const s = site as unknown as Stubs;
					// a lane that neither ran a catch-up nor waits on a copy re-arms nothing itself
					s.isPoolLane = () => true;
					s.replicaStage = () => 'CATCHING_UP';
					s.catchUpOnce = async () => ({ ran: false });
				})
			);

			expect(seen.alarm).not.toBeNull();
			expect(seen.alarm as number).toBeLessThan(seen.before + 1_000);
		},
		REQUEST_TIMEOUT
	);

	it(
		'keeps an arm made in the final block on a serving lane that pulls its next firing in',
		async () => {
			const seen = await inObject(await provisionedSite(), (site: ServeDo) =>
				fireOnce(site, () => {
					const s = site as unknown as Stubs & {
						sealGeneration: () => Promise<unknown>;
					};
					const seal = s.sealGeneration.bind(site);
					s.sealGeneration = async () => {
						site.armFillAlarm();
						return seal();
					};
					s.isPoolLane = () => true;
					s.replicaStage = () => 'SERVING';
					s.catchUpOnce = async () => ({ ran: false });
				})
			);

			expect(seen.alarm).not.toBeNull();
			expect(seen.alarm as number).toBeLessThan(seen.before + 1_000);
		},
		REQUEST_TIMEOUT
	);

	it(
		'keeps an arm made after the gate set its own alarm',
		async () => {
			const seen = await inObject(await provisionedSite(), (site: ServeDo) =>
				fireOnce(site, () => {
					// the seal runs in the firing's final block, after every phase has set its alarm
					const s = site as unknown as Stubs & {
						sealGeneration: () => Promise<unknown>;
					};
					const seal = s.sealGeneration.bind(site);
					s.sealGeneration = async () => {
						site.armFillAlarm();
						return seal();
					};
					s.migratePartial = () => ({ state: 'running' });
				})
			);

			expect(seen.alarm).not.toBeNull();
			expect(seen.alarm as number).toBeLessThan(seen.before + 1_000);
		},
		REQUEST_TIMEOUT
	);
});

/**
 * A fill batch holds the object for as many renders as it runs, and a request that reached the
 * object meanwhile is delivered only when the chain awaits something. After a publish that left a
 * dozen pages queued, a visitor's reads waited out the whole queue (11 to 39 s for six routes in the
 * WordPress page cache soak); with the batch yielding between fills and standing aside for a visitor
 * the same six reads took 3.4 to 5.3 s.
 */
describe('the fill batch and a visitor', () => {
	const PATHS = ['/a/', '/b/', '/c/', '/d/'];

	/** queues four pages, stubs the render to log its path, fires one alarm, reports what ran */
	async function batch(arrange: (site: ServeDo, log: string[]) => void, cms = 'wordpress') {
		return inObject(await provisionedSite(), async (site: ServeDo) => {
			markProvisioned(site);
			await clearAlarm(site);
			(site.env as Record<string, unknown>).CMS = cms;
			const log: string[] = [];
			// the WordPress fragment names no path the stub can read, so the fill reports it
			stubRender(site, () => pageFor('/stub/'));
			const fill = site.fillOne.bind(site);
			site.fillOne = async (...args: Parameters<typeof fill>) => {
				const outcome = await fill(...args);
				log.push(String(outcome.filled ?? outcome.failed));
				return outcome;
			};
			for (const p of PATHS) queuePath(site, p, { arm: false });
			arrange(site, log);
			const before = site.nowMs();
			await site.alarm();
			const alarm = await site.ctx.storage.getAlarm();
			const queued = site.queueDepth();
			await clearAlarm(site);
			return { log, alarm, before, queued };
		});
	}

	it(
		'lets a request that arrived during a render run before the next fill',
		async () => {
			const seen = await batch((_site, log) => {
				setTimeout(() => log.push('visitor'), 0);
			});
			expect(seen.log.slice(0, 3)).toEqual([PATHS[0], 'visitor', PATHS[1]]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'fills nothing and wakes after the window when a visitor was just served',
		async () => {
			const seen = await batch((site) => {
				site.lastVisitorAt = site.nowMs();
			});
			expect(seen.log).toEqual([]);
			expect(seen.queued).toBe(PATHS.length);
			expect(seen.alarm).not.toBeNull();
			expect((seen.alarm as number) - seen.before).toBeGreaterThan(300);
			expect((seen.alarm as number) - seen.before).toBeLessThanOrEqual(600);
		},
		REQUEST_TIMEOUT
	);

	it(
		'stops the batch when a visitor arrives during a render, and keeps the rest queued',
		async () => {
			const seen = await batch((site) => {
				const render = site.runJson;
				site.runJson = async (code) => {
					site.lastVisitorAt = site.nowMs();
					return render(code);
				};
			});
			expect(seen.log).toEqual([PATHS[0]]);
			expect(seen.queued).toBe(PATHS.length - 1);
			expect((seen.alarm as number) - seen.before).toBeGreaterThan(300);
		},
		REQUEST_TIMEOUT
	);

	it(
		'does not wait for a visitor whose own page is the one queued',
		async () => {
			const seen = await batch((site) => {
				site.lastVisitorAt = site.nowMs();
				site.sql.exec('UPDATE cfw_fill_queue SET priority = 0 WHERE path = ?', PATHS[2]);
			});
			expect(seen.log[0]).toBe(PATHS[2]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'leaves a Drupal batch alone: no pause for a visitor, every page in one firing',
		async () => {
			const seen = await batch((site) => {
				site.lastVisitorAt = site.nowMs();
			}, 'drupal');
			expect(seen.log).toEqual(PATHS);
			expect(seen.queued).toBe(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'fills anyway once none has run for ten windows, and with the lever at 0',
		async () => {
			const starved = await batch((site) => {
				site.lastVisitorAt = site.nowMs();
				site.lastAlarmFillAt = site.nowMs() - 6_000;
			});
			expect(starved.log.length).toBeGreaterThan(0);
			const off = await batch((site) => {
				(site.env as unknown as Record<string, string>).VISITOR_QUIET_MS = '0';
				site.lastVisitorAt = site.nowMs();
			});
			expect(off.log.length).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);
});
