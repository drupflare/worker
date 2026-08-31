import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/site-php';
import { replicaName } from '../../src/ops/replica-routing';
import { markInflight } from '../../src/ops/replication-log';
import { inObject, namedSite, type ServeDo } from '../helpers/serve-do';

/**
 * How a lane that withdrew becomes a lane again.
 *
 * Withdrawal is correct and reachable: an untrusted position or a record that cannot be applied both
 * land here. What was missing is the way out. The stage machine has allowed `WITHDRAWN -> CREATED`
 * since it shipped and nothing performed the move, the lane's alarm stopped re-arming, and the
 * primary picks lanes above its `lanes_provisioned` high-water mark so a number it has already copied
 * is never chosen again. Measured on a deployed 7-lane pool: every lane withdrew and not one run
 * produced a number.
 */

const TIMEOUT = 900_000;
const PASS = 'cfw-Readmit-Pass-4471';

function role(site: ServeDo, as: 'primary' | 'replica'): void {
	(site.env as Record<string, unknown>).REPLICA_READ_ONLY = as === 'replica' ? '1' : '0';
}

/** a primary holding the values a replica cannot mint, so it may legally be copied from */
async function installed(name: string): Promise<string> {
	const primary = `readmit.${name}`;
	await inObject(namedSite(primary), async (site) => {
		role(site, 'primary');
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		await site.fetch(
			new Request('https://do.local/__firstrun', {
				method: 'POST',
				body: JSON.stringify({ adminPass: PASS, siteName: name }),
				headers: { 'content-type': 'application/json' }
			})
		);
		await site.runJson(
			drupalOp(`$out['k'] = strlen(\\Drupal::service('private_key')->get());`)
		);
	});
	return primary;
}

/**
 * A lane parked at WITHDRAWN, carrying the torn-copy markers a real withdrawal leaves.
 *
 * The ENTRY is covered by `replica-catchup.spec.ts` against a fully restored lane; what this file
 * tests is the EXIT, so the stage is set rather than earned. `WITHDRAWN` is reachable from every
 * stage by construction, which is why the shortcut is faithful.
 */
async function withdrawn(primary: string, lane: number): Promise<string> {
	const name = replicaName(primary, lane);
	await inObject(namedSite(name), async (site) => {
		role(site, 'primary');
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		markInflight(site.logStore(), 1, 2);
		site.metaSet('restore_generation', '2');
		site.metaSet('restore_expect', 'users,node');
		site.metaSet('restore_seen', 'users');
		expect(site.setReplicaStage('WITHDRAWN').moved).toBe(true);
	});
	return name;
}

describe('a withdrawn lane asks for a fresh copy', () => {
	it(
		'leaves WITHDRAWN for CREATED and tells the primary',
		async () => {
			const primary = await installed('asks');
			const lane = await withdrawn(primary, 1);

			const out = await inObject(namedSite(lane), async (site) => {
				const answer = await site.requestReadmission();
				return { answer, stage: site.replicaStage() };
			});

			expect(out.answer.asked).toBe(true);
			// CREATED and not RESTORING: what the lane holds is untrusted rather than partial, so the
			// exit is a whole re-copy and never a resume
			expect(out.stage).toBe('CREATED');

			const queue = await inObject(namedSite(primary), async (site) =>
				site.laneRepairQueue()
			);
			expect(queue).toEqual([1]);
		},
		TIMEOUT
	);

	it(
		'clears the torn-copy markers, or every chunk of the new attempt is refused',
		async () => {
			const primary = await installed('markers');
			const lane = await withdrawn(primary, 1);

			const out = await inObject(namedSite(lane), async (site) => {
				await site.requestReadmission();
				return {
					generation: site.metaGet('restore_generation'),
					expect: site.metaGet('restore_expect'),
					seen: site.metaGet('restore_seen')
				};
			});

			for (const value of [out.generation, out.expect, out.seen]) {
				expect(value === '' || value === null).toBe(true);
			}
		},
		TIMEOUT
	);

	it(
		'is idempotent, because the lane re-asks until the copy lands',
		async () => {
			const primary = await installed('idempotent');
			const lane = await withdrawn(primary, 1);

			await inObject(namedSite(lane), async (site) => {
				await site.requestReadmission();
			});
			// the second ask is from CREATED, so it declines rather than re-queueing
			const second = await inObject(namedSite(lane), async (site) =>
				site.requestReadmission()
			);
			expect(second.asked).toBe(false);
			expect(second.reason).toBe('not withdrawn');

			const queue = await inObject(namedSite(primary), async (site) => {
				site.enqueueLaneRepair(1);
				site.enqueueLaneRepair(1);
				return site.laneRepairQueue();
			});
			expect(queue).toEqual([1]);
		},
		TIMEOUT
	);

	/**
	 * A unit test of `requestReadmission()` passes against an alarm that never calls it, which IS the
	 * original defect: the exit existed in the stage machine and nothing performed it.
	 */
	it(
		'is driven by the ALARM, and the lane re-arms while it waits',
		async () => {
			const primary = await installed('alarmdriven');
			const lane = await withdrawn(primary, 1);
			const stub = namedSite(lane);

			// armed here because `runDurableObjectAlarm()` is a no-op with nothing scheduled, and a
			// handler that never ran reads exactly like a handler that did nothing
			await inObject(stub, async (site) => {
				await site.ctx.storage.setAlarm(site.nowMs() + 60_000);
			});
			expect(await runDurableObjectAlarm(stub)).toBe(true);

			const out = await inObject(stub, async (site) => ({
				stage: site.replicaStage(),
				alarm: await site.ctx.storage.getAlarm()
			}));
			expect(out.stage).toBe('CREATED');
			// re-armed rather than parked: the primary may have been mid-copy on another lane when the
			// ask arrived, so the lane repeats it until the copy lands
			expect(out.alarm).not.toBeNull();

			const queue = await inObject(namedSite(primary), async (site) =>
				site.laneRepairQueue()
			);
			expect(queue).toEqual([1]);
		},
		TIMEOUT
	);

	/**
	 * A lane whose primary never answers would otherwise re-ask at the catch-up interval forever:
	 * 43,200 firings a day, most of free's row budget spent waiting for a copy.
	 */
	it(
		'backs off rather than re-asking at the catch-up interval forever',
		async () => {
			const primary = await installed('backoff');
			const lane = await withdrawn(primary, 1);

			const waits = await inObject(namedSite(lane), async (site) => {
				const out: number[] = [];
				await site.requestReadmission();
				out.push(site.copyBackoffMs());
				for (let i = 0; i < 7; i++) {
					site.setReplicaStage('WITHDRAWN');
					await site.requestReadmission();
					out.push(site.copyBackoffMs());
				}
				return { waits: out, waiting: site.awaitingCopy() };
			});

			expect(waits.waiting).toBe(true);
			// monotonic and capped, so the chain neither spins nor stops
			for (let i = 1; i < waits.waits.length; i++) {
				expect(waits.waits[i]!).toBeGreaterThanOrEqual(waits.waits[i - 1]!);
			}
			expect(waits.waits[0]).toBeLessThan(waits.waits[waits.waits.length - 1]!);
			expect(Math.max(...waits.waits)).toBeLessThanOrEqual(60_000);
		},
		TIMEOUT
	);

	it(
		'refuses to readmit an object that is not a pool lane',
		async () => {
			const primary = await installed('notalane');
			const out = await inObject(namedSite(primary), async (site) => {
				const res = await site.fetch(
					new Request('https://do.local/__replica?action=readmit&lane=1', {
						method: 'POST'
					})
				);
				return { status: res.status, body: await res.json() };
			});
			expect(out.status).toBe(200);

			// and a lane may not readmit another lane
			const laneName = replicaName(primary, 2);
			const refused = await inObject(namedSite(laneName), async (site) => {
				const res = await site.fetch(
					new Request('https://do.local/__replica?action=readmit&lane=1', {
						method: 'POST'
					})
				);
				return res.status;
			});
			expect(refused).toBe(409);
		},
		TIMEOUT
	);
});

describe('the primary acts on a repair', () => {
	it(
		'copies a withdrawn lane again on a QUIET site',
		async () => {
			// the load that made the lane withdraw goes to the primary the moment it does, so waiting
			// for contention to rebuild is waiting for the outage the repair exists to end
			const primary = await installed('quietrepair');
			await inObject(namedSite(primary), async (site) => {
				role(site, 'primary');
				site.metaSet('lanes_provisioned', '1');
				site.enqueueLaneRepair(1);
			});

			const out = await inObject(namedSite(primary), async (site) => {
				role(site, 'primary');
				const steps: unknown[] = [];
				for (let i = 0; i < 40; i++) {
					(site as unknown as { inflightPeak: number }).inflightPeak = 0;
					const step = (await (
						site as unknown as { autoScaleStep(): Promise<unknown> }
					).autoScaleStep()) as {
						autoScale?: { refused?: string; done?: boolean };
					} | null;
					steps.push(step);
					if (step?.autoScale?.refused) return { refused: step.autoScale.refused };
					if (step?.autoScale?.done) break;
				}
				return { queue: site.laneRepairQueue(), steps: steps.length };
			});

			expect(
				(out as { refused?: string }).refused,
				`the repair was refused: ${(out as { refused?: string }).refused}`
			).toBe(undefined);
			// dequeued only on a COMPLETED copy
			expect((out as { queue: number[] }).queue).toEqual([]);

			// and the lane's ask backoff is spent, so a second withdrawal asks promptly rather than
			// resuming at the ceiling the previous wait reached
			const settled = await inObject(namedSite(replicaName(primary, 1)), (lane) => ({
				asks: lane.metaGet('readmit_asks'),
				waiting: lane.awaitingCopy()
			}));
			expect(settled.asks === '' || settled.asks === null).toBe(true);
			expect(settled.waiting).toBe(false);
		},
		TIMEOUT
	);

	it(
		'takes the repair before growing the pool',
		async () => {
			const primary = await installed('repairfirst');
			const chosen = await inObject(namedSite(primary), async (site) => {
				role(site, 'primary');
				// contended enough that growth WOULD fire, so the two candidates are both live and the
				// assertion is about which one wins rather than about only one existing
				site.metaSet('lanes_provisioned', '2');
				site.enqueueLaneRepair(2);
				const lanes: number[] = [];
				for (let i = 0; i < 4; i++) {
					(site as unknown as { inflightPeak: number }).inflightPeak = 6;
					const step = (await (
						site as unknown as { autoScaleStep(): Promise<unknown> }
					).autoScaleStep()) as { autoScale?: { lane?: number } } | null;
					if (typeof step?.autoScale?.lane === 'number') lanes.push(step.autoScale.lane);
				}
				return lanes;
			});
			// lane 2 rather than lane 3: a withdrawn lane is capacity already paid for, and growing
			// past it just adds a second cold lane while the first stays dead
			expect(chosen.length).toBeGreaterThan(0);
			expect(chosen[0]).toBe(2);
		},
		TIMEOUT
	);

	it(
		'keeps the repair queued when the copy did not finish',
		async () => {
			const primary = await installed('unfinished');
			const queue = await inObject(namedSite(primary), async (site) => {
				role(site, 'primary');
				site.enqueueLaneRepair(3);
				// a budget of one row cannot finish, so the repair is still owed
				await site.provisionLane(3, null, 1);
				return site.laneRepairQueue();
			});
			expect(queue).toEqual([3]);
		},
		TIMEOUT
	);
});
