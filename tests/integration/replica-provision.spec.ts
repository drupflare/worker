import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/site-php';
import type { ProvisionOutcome } from '../../src/ops/replica-restore';
import { replicaName } from '../../src/ops/replica-routing';
import { driveAlarms, inObject, namedSite, type ServeDo } from '../helpers/serve-do';

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
	/** contended alarm windows; `laneTarget()` wants `peak - 1` lanes once three of them are in */
	async function contend(site: ServeDo, windows: number, peak = 4): Promise<void> {
		for (let i = 0; i < windows; i++) {
			(site as any).inflightPeak = peak;
			await (site as any).autoScaleStep();
		}
	}

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
