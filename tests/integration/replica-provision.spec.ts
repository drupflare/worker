import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/site-php';
import type { ProvisionOutcome } from '../../src/ops/replica-restore';
import { replicaName } from '../../src/ops/replica-routing';
import {
	driveAlarms,
	freshSite,
	inObject,
	namedSite,
	seedPage,
	type ServeDo
} from '../helpers/serve-do';

/**
 * Creating a lane and filling it, without anyone holding both stubs.
 *
 * `action=snapshot` and `action=restore` were two halves that nothing called in sequence, so a lane
 * could be filled by a test and by nothing else. This drives it from the PRIMARY, which is the object
 * a caller can reach -- a lane has no route into it from outside, by construction.
 */

const TIMEOUT = 900_000;
const PASS = 'cfw-Provision-Pass-3355';

function role(site: ServeDo, as: 'primary' | 'replica'): void {
	(site.env as Record<string, unknown>).REPLICA_READ_ONLY = as === 'replica' ? '1' : '0';
}

async function installed(name: string, mint = true): Promise<string> {
	await inObject(namedSite(name), async (site) => {
		role(site, 'primary');
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		await site.fetch(
			new Request('https://do.local/__firstrun', {
				method: 'POST',
				body: JSON.stringify({ adminPass: PASS, siteName: name }),
				headers: { 'content-type': 'application/json' }
			})
		);
		if (mint) {
			await site.runJson(
				drupalOp(`$out['k'] = strlen(\\Drupal::service('private_key')->get());`)
			);
		}
	});
	return name;
}

/** loops the driver the way a caller would, carrying the cursor back each time */
async function provision(
	primary: string,
	lane: number,
	budget = 4_000
): Promise<{ steps: number; last: ProvisionOutcome }> {
	let cursor = '';
	let last: ProvisionOutcome = { ok: false, reason: 'never ran', done: false };
	for (let steps = 1; steps <= 40; steps++) {
		last = await inObject(namedSite(primary), async (site) => {
			role(site, 'primary');
			const res = await site.fetch(
				new Request(
					`https://do.local/__replica?action=provision&lane=${lane}&budget=${budget}` +
						(cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`)
				)
			);
			return (await res.json()) as ProvisionOutcome;
		});
		if (!last.ok || last.done) return { steps, last };
		cursor = JSON.stringify(last.cursor);
	}
	return { steps: 40, last };
}

describe('a lane is created and filled from the primary', () => {
	it(
		'fills a lane in one pass and leaves it VERIFIED',
		async () => {
			const primary = await installed('provision.onepass');
			const { last } = await provision(primary, 1);

			expect(last.ok, last.reason).toBe(true);
			expect(last.done).toBe(true);
			expect(last.copied).toBeGreaterThan(0);
			// the lane never had a Drupal install of its own: the copy carries each table's DDL
			expect(last.stage).toBe('VERIFIED');
		},
		TIMEOUT
	);

	it(
		'resumes across invocations when the budget runs out',
		async () => {
			const primary = await installed('provision.resumed');
			// a budget far below one table's rows, so the copy cannot finish in one call
			const { steps, last } = await provision(primary, 1, 50);

			expect(last.ok, last.reason).toBe(true);
			expect(last.done).toBe(true);
			// the point of the cursor: more than one invocation, and the same end state
			expect(steps).toBeGreaterThan(1);
		},
		TIMEOUT
	);

	it(
		'drives itself to SERVING afterwards, with nothing else called',
		async () => {
			const primary = await installed('provision.serving');
			await provision(primary, 1);
			const stub = namedSite(replicaName(primary, 1));
			await driveAlarms(stub, (site) => site.replicaStage() === 'SERVING');
			const stage = await inObject(stub, (site) => site.replicaStage());
			// provision -> restore -> alarm -> catch-up -> admission -> SERVING, end to end
			expect(stage).toBe('SERVING');
		},
		TIMEOUT
	);

	it(
		'holds the primary key rather than one the lane invented',
		async () => {
			const primary = await installed('provision.identity');
			await provision(primary, 1);

			const keyOf = (name: string) =>
				inObject(namedSite(name), (site) => {
					const row = site.sql
						.exec(
							`SELECT value FROM key_value WHERE collection = 'state' AND name = ?`,
							'system.private_key'
						)
						.toArray()[0] as { value: unknown } | undefined;
					return row?.value ?? null;
				});

			const source = await keyOf(primary);
			expect(source, 'the primary minted no key').toBeTruthy();
			expect(await keyOf(replicaName(primary, 1))).toBe(source);
		},
		TIMEOUT
	);
});

describe('what the driver refuses', () => {
	it(
		'refuses a primary that has not minted its own identity',
		async () => {
			const primary = await installed('provision.unminted', false);
			const { last } = await provision(primary, 1);
			expect(last.ok).toBe(false);
			expect(last.reason).toContain('system.private_key');
		},
		TIMEOUT
	);

	it(
		'refuses to be driven from a lane',
		async () => {
			const out = await inObject(
				namedSite(replicaName('provision.fromlane', 1)),
				async (site) => {
					role(site, 'primary');
					const res = await site.fetch(
						new Request('https://do.local/__replica?action=provision&lane=2')
					);
					return (await res.json()) as ProvisionOutcome;
				}
			);
			expect(out.ok).toBe(false);
			expect(out.reason).toContain('from the primary');
		},
		TIMEOUT
	);

	it(
		'refuses a lane number that is not one',
		async () => {
			const primary = await installed('provision.lane0');
			const out = await inObject(namedSite(primary), async (site) => {
				role(site, 'primary');
				const res = await site.fetch(
					new Request('https://do.local/__replica?action=provision&lane=0')
				);
				return (await res.json()) as ProvisionOutcome;
			});
			// lane 0 IS the primary; provisioning it would copy the object over itself
			expect(out.ok).toBe(false);
			expect(out.reason).toContain('starts at 1');
		},
		TIMEOUT
	);

	it(
		'refuses to resume a copy the primary has committed over',
		async () => {
			const primary = await installed('provision.torn');
			const out = await inObject(namedSite(primary), async (site) => {
				role(site, 'primary');
				const res = await site.fetch(
					new Request(
						'https://do.local/__replica?action=provision&lane=1&cursor=' +
							encodeURIComponent(
								JSON.stringify({ generation: 999, index: 0, offset: 0 })
							)
					)
				);
				return (await res.json()) as ProvisionOutcome;
			});
			// the primary keeps serving while it copies itself, so a commit mid-copy makes every
			// later chunk torn; saying so here beats a refusal from the far end that reads like a bug
			expect(out.ok).toBe(false);
			expect(out.torn).toBe(true);
			expect(out.reason).toContain('committed during the copy');
		},
		TIMEOUT
	);
});

describe('a contended site grows its own pool', () => {
	/**
	 * Contended alarm windows.
	 *
	 * SEEDS THE WAITING, not just the concurrency. `laneTarget()` used to want `peak - 1` lanes from
	 * the inflight peak alone, and inflight is only a proxy: a site with 100 req/s of cached traffic
	 * has requests in the object at once and nobody waiting, and provisioning lanes for that is
	 * provisioning for load that never queued. It now prefers the sustained QUEUE depth, which
	 * `laneTimings` was already recording and which nothing acted on -- so a spec that simulates
	 * contention has to simulate a wait.
	 */
	async function contend(site: ServeDo, windows: number, peak = 4): Promise<void> {
		for (let i = 0; i < windows; i++) {
			(site as any).inflightPeak = peak;
			(site as any).laneTimings = Array.from({ length: peak }, (_, k) => ({
				ahead: k === 0 ? 0 : k,
				queueMs: k === 0 ? 0 : 12,
				serviceMs: 20
			}));
			await (site as any).autoScaleStep();
		}
	}

	it(
		'provisions NOTHING for concurrency that never queued',
		async () => {
			// the half the inflight proxy got wrong: eight cached hits in flight at once are eight
			// requests one object serves without anybody waiting
			const stub = freshSite();
			const provisioned = await inObject(stub, async (site) => {
				for (let i = 0; i < 4; i++) {
					(site as any).inflightPeak = 8;
					(site as any).laneTimings = Array.from({ length: 8 }, () => ({
						ahead: 0,
						queueMs: 0,
						serviceMs: 3
					}));
					await (site as any).autoScaleStep();
				}
				return Number((site as any).metaGet('lanes_provisioned') ?? 0);
			});
			expect(provisioned).toBe(0);
		},
		TIMEOUT
	);

	it(
		'provisions lane 1 off the alarm without anyone raising REPLICA_COUNT',
		async () => {
			// raising the var only tells the ROUTER lanes exist; nothing created them. This is the
			// half that creates one, and a spec that drove `provisionLane()` directly would pass
			// against an alarm that never calls it
			// peak 2 is one concurrent request past the uncontended case, so it justifies EXACTLY one
			// lane; growing to more would mean the target is not what drives the copy
			const primary = await installed('autoscale.grows');
			const out = await inObject(namedSite(primary), async (site) => {
				role(site, 'primary');
				for (let i = 0; i < 40; i++) {
					await contend(site, 1, 2);
					const step = (site as any).lastAutoScale ?? null;
					if (step?.autoScale?.refused) return { refused: step.autoScale.refused };
					if ((site as any).metaGet('lanes_provisioned') === '1') break;
				}
				return {
					provisioned: (site as any).metaGet('lanes_provisioned'),
					cursor: (site as any).metaGet('lane_cursor')
				};
			});

			expect((out as any).refused, `provisioning refused: ${(out as any).refused}`).toBe(
				undefined
			);
			expect(out.provisioned).toBe('1');
			// the copy finished, so nothing is left half-done for the next firing
			expect(out.cursor === '' || out.cursor === null).toBe(true);
		},
		TIMEOUT
	);

	it(
		'stays put on a quiet site, and writes nothing while it does',
		async () => {
			const primary = await installed('autoscale.quiet');
			const out = await inObject(namedSite(primary), async (site) => {
				role(site, 'primary');
				const steps: unknown[] = [];
				for (let i = 0; i < 6; i++) {
					(site as any).inflightPeak = 1;
					steps.push(await (site as any).autoScaleStep());
				}
				return {
					steps,
					provisioned: (site as any).metaGet('lanes_provisioned'),
					windows: (site as any).metaGet('demand_windows')
				};
			});

			expect(out.steps.every((s) => s === null)).toBe(true);
			expect(out.provisioned).toBe(null);
			// an idle tick must not charge a row to record that it was idle
			expect(out.windows === '' || out.windows === null).toBe(true);
		},
		TIMEOUT
	);

	it(
		'does nothing when autoscaling is switched off',
		async () => {
			const primary = await installed('autoscale.off');
			const out = await inObject(namedSite(primary), async (site) => {
				role(site, 'primary');
				(site.env as Record<string, unknown>).REPLICA_AUTOSCALE = '0';
				await contend(site, 6);
				return (site as any).metaGet('lanes_provisioned');
			});
			expect(out).toBe(null);
		},
		TIMEOUT
	);
});

/**
 * Whether anything can FIND a lane once it has been built.
 *
 * A copy that leaves no trace is a lane nothing addresses. `lanes_provisioned` is the only thing the
 * primary reports `x-cfw-lanes` from, and `replicaCount()` reads only `REPLICA_COUNT`, which the
 * canonical config does not set -- so with the key unwritten the router keeps serving every request
 * from the primary. Only `autoScaleStep()` wrote it, and every measurement this project took of a
 * pool drove `action=provision` by hand instead: the lanes were copied, promoted to SERVING and
 * reported ready, and never received a request.
 */
describe('a driven copy is discoverable afterwards', () => {
	it(
		'records the lane, so the primary can advertise the pool',
		async () => {
			const primary = await installed('provision.advertised');
			const before = await inObject(namedSite(primary), (site) =>
				(site as any).metaGet('lanes_provisioned')
			);
			expect(before, 'nothing is provisioned before the copy').toBe(null);

			await provision(primary, 1);
			await provision(primary, 2);

			const after = await inObject(namedSite(primary), (site) =>
				(site as any).metaGet('lanes_provisioned')
			);
			// the HIGH-WATER MARK rather than a count, which is what `nextLaneToProvision()` reads
			expect(after).toBe('2');
		},
		TIMEOUT
	);

	it(
		'puts the count on a response, which is how the router learns it',
		async () => {
			const primary = await installed('provision.reported');
			await provision(primary, 1);

			const header = await inObject(namedSite(primary), async (site) => {
				role(site, 'primary');
				const res = await site.fetch(new Request('https://do.local/__serve-stats'));
				return res.headers.get('x-cfw-lanes');
			});
			expect(header).toBe('1');
		},
		TIMEOUT
	);
});

/**
 * The pool, advertised from the lane that answers most of the traffic.
 *
 * `x-cfw-lanes` was set only inside `this.gate.run()`. A cached page never enters the gate -- that
 * is the point of the storage fast lane -- so a site answering mostly hits stopped telling the
 * router its pool existed, `believedLanes()` expired after `LANES_TRUST_MS`, and anonymous cached
 * traffic went back to the primary alone. That is the exact workload the lanes are for.
 */
describe('a cached page advertises the pool too', () => {
	it(
		'carries the lane count on a storage-lane HIT',
		async () => {
			const primary = await installed('provision.fastlane');
			await provision(primary, 1);

			const seen = await inObject(namedSite(primary), async (site) => {
				role(site, 'primary');
				seedPage(site, '/fast-advertise', '<html><body>hit</body></html>');
				const res = await site.fetch(
					new Request(
						`https://do.local/__serve?path=${encodeURIComponent('/fast-advertise')}`
					)
				);
				return {
					lane: res.headers.get('x-cfw-lane'),
					lanes: res.headers.get('x-cfw-lanes'),
					cache: res.headers.get('x-cfw-cache')
				};
			});

			// the control: this only means something if the FAST lane answered it
			expect(seen.lane, 'the gated lane answered, so this measures nothing').toBe('storage');
			expect(seen.cache).toBe('HIT');
			expect(seen.lanes, 'a cached hit did not advertise the pool').toBe('1');
		},
		TIMEOUT
	);

	it(
		'says nothing about a pool that does not exist',
		async () => {
			const primary = await installed('provision.fastlane.none');
			const seen = await inObject(namedSite(primary), async (site) => {
				role(site, 'primary');
				seedPage(site, '/fast-quiet', '<html><body>hit</body></html>');
				const res = await site.fetch(
					new Request(
						`https://do.local/__serve?path=${encodeURIComponent('/fast-quiet')}`
					)
				);
				return {
					lane: res.headers.get('x-cfw-lane'),
					lanes: res.headers.get('x-cfw-lanes')
				};
			});
			expect(seen.lane).toBe('storage');
			// absent rather than `0`, so `rememberLanes()` is never handed a pool of nothing
			expect(seen.lanes).toBe(null);
		},
		TIMEOUT
	);
});
