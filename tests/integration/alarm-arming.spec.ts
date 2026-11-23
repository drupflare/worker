import { describe, expect, it } from 'vitest';
import { alarmDelayMs } from '../../src/do/levers';
import { ensureUpdbTables } from '../../src/ops/updb';
import {
	asBrowser,
	inObject,
	markProvisioned,
	pageFor,
	provisionedSite,
	queuePath,
	SESSION_COOKIE,
	statsOf,
	stubRender,
	type ServeDo
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

				// the hold is shape-independent; head keeps the small asks unfloored
				return withShape(site, { shape: 'head' }, async () => {
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

				return withShape(site, { shape: 'head' }, async () => {
					site.holdArming();
					site.armFillAlarm(60_000);
					const soon = site.nowMs() + 10;
					await site.setAlarmAt(soon);
					site.releaseArming();
					const alarm = await site.ctx.storage.getAlarm();
					await clearAlarm(site);
					return { alarm, soon };
				});
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

type ShapeProbe = {
	alarmDepth: number;
	alarmMoves: number;
	alarmLastDistanceMs?: number;
	syncStorage?: () => Promise<void>;
};

type ShapeVars = { shape?: string; delayMs?: string };

/** runs `fn` with the shape vars on the shared env, then removes them for the next spec */
async function withShape<T>(site: ServeDo, vars: ShapeVars, fn: () => Promise<T>): Promise<T> {
	// an earlier describe leaves the shared env on WordPress, which has no pull-in
	site.env.CMS = 'drupal';
	if (vars.shape !== undefined) site.env.ALARM_SHAPE = vars.shape;
	if (vars.delayMs !== undefined) site.env.ALARM_DELAY_MS = vars.delayMs;
	try {
		return await fn();
	} finally {
		delete site.env.ALARM_SHAPE;
		delete site.env.ALARM_DELAY_MS;
	}
}

/** wraps the sync seam; each entry is the alarm the object held when a commit ran */
function watchSyncs(site: ServeDo): Array<number | null> {
	const probe = site as unknown as ShapeProbe;
	const sync = probe.syncStorage?.bind(site);
	const seen: Array<number | null> = [];
	probe.syncStorage = async () => {
		seen.push(await site.ctx.storage.getAlarm());
		await sync?.();
	};
	return seen;
}

/**
 * `ALARM_SHAPE` picks how a request moves the fill alarm: `delay` (the default) keeps every
 * request-path move at least `ALARM_DELAY_MS` ahead, `head` is the one-tick move the code used to
 * make, `end-sync` moves nothing during
 * the request and commits then moves once at the end. A firing keeps `head` in every shape.
 */
describe('alarm shape', () => {
	/** a logged-in admin GET against a standing alarm `standingMs` out */
	async function adminGet(vars: ShapeVars, standingMs = 3_600_000, depth = 0) {
		return inObject(await provisionedSite(), async (site: ServeDo) => {
			markProvisioned(site);
			site.metaSet('first_run_at', String(Date.now()));
			site.ensureServeTables();
			stubRender(site, (call) => pageFor(call.path));
			await clearAlarm(site);
			const standing = site.nowMs() + standingMs;
			await withShape(site, { shape: 'head' }, () => site.setAlarmAt(standing));
			const probe = site as unknown as ShapeProbe;
			const syncs = watchSyncs(site);
			return withShape(site, vars, async () => {
				const movesBefore = probe.alarmMoves;
				probe.alarmDepth = depth;
				const headers = new Headers(asBrowser(`${SESSION_COOKIE}=a-session`).headers);
				const before = site.nowMs();
				const res = await site.fetch(
					new Request(
						`https://do.local/__serve?path=${encodeURIComponent('/admin/reports/status')}`,
						{ headers }
					)
				);
				await res.text();
				probe.alarmDepth = 0;
				const alarm = await site.ctx.storage.getAlarm();
				const seen = {
					status: res.status,
					alarmHeaders: [...res.headers.keys()].filter(
						(name) => name.startsWith('x-alarm') || name.startsWith('x-earlier')
					),
					alarm,
					standing,
					before,
					syncs,
					moves: probe.alarmMoves - movesBefore,
					distance: probe.alarmLastDistanceMs
				};
				await clearAlarm(site);
				return seen;
			});
		});
	}

	it(
		'reads an unset var as delay',
		async () => {
			const seen = await adminGet({});
			expect(seen.status).toBe(200);
			expect(seen.alarmHeaders).toEqual([]);
			expect(seen.moves).toBe(1);
			expect(seen.distance as number).toBeGreaterThan(3_500);
			expect(seen.distance as number).toBeLessThanOrEqual(5_000);
			expect(seen.alarm as number).toBeGreaterThanOrEqual(seen.before + 5_000);
			expect(seen.alarm as number).toBeLessThan(seen.before + 8_000);
			expect(seen.syncs).toEqual([]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'head moves the alarm one tick out, and an unknown value reads as delay',
		async () => {
			const head = await adminGet({ shape: 'head' });
			expect(head.alarm as number).toBeLessThan(head.before + 2_000);
			expect(head.syncs).toEqual([]);
			expect(head.moves).toBe(1);
			for (const shape of ['l0', 'Delay', 'end_sync', '']) {
				const seen = await adminGet({ shape });
				expect(seen.alarm as number).toBeGreaterThanOrEqual(seen.before + 5_000);
				expect(seen.syncs).toEqual([]);
				expect(seen.moves).toBe(1);
			}
		},
		REQUEST_TIMEOUT
	);

	it(
		'delay moves the alarm to the default five seconds out in one awaited call, with no commit',
		async () => {
			const seen = await adminGet({ shape: 'delay' });
			expect(seen.status).toBe(200);
			expect(seen.alarmHeaders).toEqual([]);
			expect(seen.moves).toBe(1);
			expect(seen.distance as number).toBeGreaterThan(3_500);
			expect(seen.distance as number).toBeLessThanOrEqual(5_000);
			expect(seen.alarm as number).toBeGreaterThanOrEqual(seen.before + 5_000);
			expect(seen.alarm as number).toBeLessThan(seen.before + 8_000);
			expect(seen.syncs).toEqual([]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'an exact setAlarmAt keeps the one-tick move under delay and under end-sync',
		async () => {
			for (const shape of ['delay', 'end-sync']) {
				const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
					markProvisioned(site);
					await clearAlarm(site);
					return withShape(site, { shape }, async () => {
						const before = site.nowMs();
						await site.setAlarmAt(before + 1, true);
						const alarm = await site.ctx.storage.getAlarm();
						await clearAlarm(site);
						return { alarm, before };
					});
				});
				expect(seen.alarm).not.toBeNull();
				expect(Number(seen.alarm) - seen.before).toBeLessThan(1_000);
			}
		},
		REQUEST_TIMEOUT
	);

	it(
		'a never-migrated site starts its first migration at the next tick under the default shape',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				await clearAlarm(site);
				const before = site.nowMs();
				await site.requestProvision();
				const alarm = await site.ctx.storage.getAlarm();
				await clearAlarm(site);
				return { alarm, before };
			});
			expect(seen.alarm).not.toBeNull();
			expect(Number(seen.alarm) - seen.before).toBeLessThan(1_000);
		},
		REQUEST_TIMEOUT
	);

	it(
		'delay keeps a standing alarm when setAlarmAt asks again, so steady requests cannot starve it',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				await clearAlarm(site);
				return withShape(site, { shape: 'delay' }, async () => {
					await site.setAlarmAt(site.nowMs() + 1);
					const first = await site.ctx.storage.getAlarm();
					await new Promise((resolve) => setTimeout(resolve, 60));
					await site.setAlarmAt(site.nowMs() + 1);
					const second = await site.ctx.storage.getAlarm();
					await clearAlarm(site);
					return { first, second };
				});
			});
			expect(seen.first).not.toBeNull();
			expect(seen.second).toBe(seen.first);
		},
		REQUEST_TIMEOUT
	);

	it(
		'delay takes the floor from ALARM_DELAY_MS, and reads any other value as 5,000',
		async () => {
			const custom = await adminGet({ shape: 'delay', delayMs: '20000' });
			expect(custom.alarm as number).toBeGreaterThanOrEqual(custom.before + 20_000);
			expect(custom.alarm as number).toBeLessThan(custom.before + 23_000);

			const invalid = await adminGet({ shape: 'delay', delayMs: 'soon' });
			expect(invalid.alarm as number).toBeGreaterThanOrEqual(invalid.before + 5_000);
			expect(invalid.alarm as number).toBeLessThan(invalid.before + 8_000);

			for (const raw of ['1000', '60000', 1_000, 60_000]) {
				expect(alarmDelayMs({ ALARM_DELAY_MS: raw } as never)).toBe(Number(raw));
			}
			for (const raw of [
				'999',
				'60001',
				'1500.5',
				'-5000',
				'',
				' ',
				'abc',
				undefined,
				null
			]) {
				expect(alarmDelayMs({ ALARM_DELAY_MS: raw } as never)).toBe(5_000);
			}
		},
		REQUEST_TIMEOUT
	);

	it(
		'delay keeps a standing alarm that is already inside the floor',
		async () => {
			const seen = await adminGet({ shape: 'delay' }, 3_000);
			expect(seen.moves).toBe(0);
			expect(seen.alarm).toBe(seen.standing);
		},
		REQUEST_TIMEOUT
	);

	it(
		'delay floors every arm and move made outside a firing, and leaves longer asks alone',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				const out: Record<string, { alarm: number | null; before: number }> = {};
				await withShape(site, { shape: 'delay' }, async () => {
					const asks: Array<[string, () => Promise<void> | void]> = [
						['arm', () => site.armFillAlarm(1)],
						['move', () => site.setAlarmAt(site.nowMs() + 1)],
						['long arm', () => site.armFillAlarm(120_000)],
						['long move', () => site.setAlarmAt(site.nowMs() + 600_000)]
					];
					for (const [name, ask] of asks) {
						await clearAlarm(site);
						const before = site.nowMs();
						await ask();
						out[name] = { alarm: await site.ctx.storage.getAlarm(), before };
					}
				});
				await clearAlarm(site);
				return out;
			});

			const ahead = (name: string) =>
				(seen[name]?.alarm as number) - (seen[name]?.before as number);
			expect(ahead('arm')).toBeGreaterThanOrEqual(5_000);
			expect(ahead('arm')).toBeLessThan(6_000);
			expect(ahead('move')).toBeGreaterThanOrEqual(5_000);
			expect(ahead('move')).toBeLessThan(6_000);
			expect(ahead('long arm')).toBeGreaterThanOrEqual(120_000);
			expect(ahead('long arm')).toBeLessThan(121_000);
			expect(ahead('long move')).toBeGreaterThanOrEqual(600_000);
			expect(ahead('long move')).toBeLessThan(601_000);
		},
		REQUEST_TIMEOUT
	);

	it(
		'a firing runs head in delay and end-sync: its arm lands one tick out and is not counted',
		async () => {
			for (const shape of ['delay', 'end-sync']) {
				const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
					const probe = site as unknown as ShapeProbe;
					const syncs = watchSyncs(site);
					const movesBefore = probe.alarmMoves;
					const fired = await withShape(site, { shape }, () =>
						fireOnce(site, (stubs) => {
							// a lane that neither ran a catch-up nor waits on a copy re-arms nothing itself
							stubs.isPoolLane = () => true;
							stubs.replicaStage = () => 'CATCHING_UP';
							stubs.catchUpOnce = async () => ({ ran: false });
						})
					);
					return {
						fired,
						syncs,
						depth: probe.alarmDepth,
						moves: probe.alarmMoves - movesBefore
					};
				});

				expect(seen.fired.alarm).not.toBeNull();
				expect(seen.fired.alarm as number).toBeLessThan(seen.fired.before + 1_000);
				expect(seen.depth).toBe(0);
				expect(seen.moves).toBe(0);
				expect(seen.syncs).toEqual([]);
			}
		},
		REQUEST_TIMEOUT
	);

	it(
		'end-sync makes no move during the request, then commits and moves once one tick out',
		async () => {
			const seen = await adminGet({ shape: 'end-sync' });
			expect(seen.status).toBe(200);
			expect(seen.alarmHeaders).toEqual([]);
			// the alarm was still the standing one when the commit ran, so the move came after it
			expect(seen.syncs).toEqual([seen.standing]);
			expect(seen.moves).toBe(1);
			expect(seen.distance as number).toBeLessThan(2_000);
			expect(seen.alarm as number).toBeLessThan(seen.before + 2_000);
		},
		REQUEST_TIMEOUT
	);

	it(
		'end-sync commits but keeps an alarm that is already within 50 ms',
		async () => {
			const seen = await adminGet({ shape: 'end-sync' }, 10);
			expect(seen.syncs).toHaveLength(1);
			expect(seen.moves).toBe(0);
			expect(seen.alarm).toBe(seen.standing);
		},
		REQUEST_TIMEOUT
	);

	it(
		'end-sync does nothing at the end of a request that overlaps a firing',
		async () => {
			const seen = await adminGet({ shape: 'end-sync' }, 3_600_000, 1);
			expect(seen.syncs).toEqual([]);
			expect(seen.moves).toBe(0);
			expect(seen.alarm).toBe(seen.standing);
		},
		REQUEST_TIMEOUT
	);

	it(
		'delay holds an arm made during the request at the floor; end-sync drops it for the end move',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				const out: Record<string, { alarm: number | null; before: number; syncs: number }> =
					{};
				for (const shape of ['delay', 'end-sync']) {
					await clearAlarm(site);
					const syncs = watchSyncs(site);
					await withShape(site, { shape }, async () => {
						const before = site.nowMs();
						// a route that arms through armFillAlarm: the queue endpoint
						const res = await site.fetch(
							new Request('https://do.local/__fill?path=%2Fa%2F')
						);
						await res.text();
						out[shape] = {
							alarm: await site.ctx.storage.getAlarm(),
							before,
							syncs: syncs.length
						};
					});
				}
				await clearAlarm(site);
				return out;
			});

			const delay = seen.delay;
			const endSync = seen['end-sync'];
			expect(delay?.alarm).not.toBeNull();
			expect((delay?.alarm as number) - (delay?.before as number)).toBeGreaterThanOrEqual(
				5_000
			);
			expect(delay?.syncs).toBe(0);
			expect(endSync?.alarm).not.toBeNull();
			expect((endSync?.alarm as number) - (endSync?.before as number)).toBeLessThan(2_000);
			expect(endSync?.syncs).toBe(1);
		},
		REQUEST_TIMEOUT
	);

	it(
		'reports the shape, the moves and the last distance at /serve-stats, and no other alarm key',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				await clearAlarm(site);
				const out: Record<string, Record<string, unknown>> = {};
				out.fresh = (await statsOf(site)) as unknown as Record<string, unknown>;
				for (const shape of ['head', 'delay', 'end-sync', 'bogus']) {
					await withShape(site, { shape }, async () => {
						out[shape] = (await statsOf(site)) as unknown as Record<string, unknown>;
					});
				}
				await clearAlarm(site);
				return out;
			});
			// its own object: an end-sync stats read above ends with a move of its own
			const moved = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				await clearAlarm(site);
				return withShape(site, { shape: 'delay' }, async () => {
					await site.setAlarmAt(site.nowMs() + 1);
					return (await statsOf(site)) as unknown as Record<string, unknown>;
				});
			});

			expect(
				Object.keys(seen.fresh as object)
					.filter((k) => k.startsWith('alarm'))
					.sort()
			).toEqual(['alarmFirings', 'alarmLastDistanceMs', 'alarmMoves', 'alarmShape']);
			expect(seen.fresh?.alarmShape).toBe('delay');
			expect(seen.fresh?.alarmMoves).toBe(0);
			expect(seen.fresh?.alarmLastDistanceMs).toBeNull();
			expect(seen.head?.alarmShape).toBe('head');
			expect(seen.delay?.alarmShape).toBe('delay');
			expect(seen['end-sync']?.alarmShape).toBe('end-sync');
			expect(seen.bogus?.alarmShape).toBe('delay');
			expect(moved.alarmMoves).toBe(1);
			expect(moved.alarmLastDistanceMs as number).toBeGreaterThan(3_500);
			expect(moved.alarmLastDistanceMs as number).toBeLessThanOrEqual(5_000);
		},
		REQUEST_TIMEOUT
	);
});
