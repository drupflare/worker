import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/site-php';
import { DEFAULT_REPLICA_LAG_MS, replicaName } from '../../src/ops/replica-routing';
import { markInflight } from '../../src/ops/replication-log';
import { driveAlarms, inObject, namedSite, type ServeDo } from '../helpers/serve-do';

/**
 * The piece that makes a pool self-driving.
 *
 * Every other step is something an operator performs. Without catch-up a restored lane sits at
 * `VERIFIED` forever, refuses every request, and the router quietly answers everything from the
 * primary -- so the pool reads as working while it has exactly one member.
 *
 * A replica PULLS. A push would make the primary own the delivery state of every lane and retry each
 * one, so a lane that was down would cost the primary invocations it cannot recover.
 */

const TIMEOUT = 900_000;
const PASS = 'cfw-Catchup-Pass-9902';

function role(site: ServeDo, as: 'primary' | 'replica'): void {
	(site.env as Record<string, unknown>).REPLICA_READ_ONLY = as === 'replica' ? '1' : '0';
}

type CatchUp = {
	ran: boolean;
	reason: string;
	applied: number;
	advertised: number;
	records: number;
	stage: string;
	admitted: boolean;
};

/** the whole primary -> replica handover, so each case starts from a lane that has real state */
async function pairedLane(
	name: string
): Promise<{ primary: string; lane: string; armedAtRestore: number | null }> {
	const primary = `catchup.${name}`;
	const lane = replicaName(primary, 1);

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
		// a fresh install has no `system.private_key`; without it the primary refuses to be copied
		await site.runJson(
			drupalOp(`$out['k'] = strlen(\\Drupal::service('private_key')->get());`)
		);
	});

	const plan = (await inObject(namedSite(primary), async (site) => {
		role(site, 'primary');
		const res = await site.fetch(new Request('https://do.local/__replica?action=snapshot'));
		expect(res.status, await res.clone().text()).toBe(200);
		return (await res.json()) as {
			generation: number;
			schemaVersion: string;
			tables: { table: string; copy: boolean }[];
		};
	})) as {
		generation: number;
		schemaVersion: string;
		tables: { table: string; copy: boolean }[];
	};

	const copyable = plan.tables.filter((t) => t.copy).map((t) => t.table);
	const pages: unknown[] = [];
	await inObject(namedSite(primary), async (site) => {
		role(site, 'primary');
		for (const table of copyable) {
			const page = (await (
				await site.fetch(
					new Request(
						`https://do.local/__replica?action=snapshot&table=${table}&offset=0&limit=5000`
					)
				)
			).json()) as { columns: string[]; rows: unknown[][]; ddl: string[] };
			pages.push({
				generation: plan.generation,
				schemaVersion: plan.schemaVersion,
				table,
				columns: page.columns.length > 0 ? page.columns : ['x'],
				rows: page.rows,
				ddl: page.ddl,
				first: true
			});
		}
	});

	const armedAtRestore = await inObject(namedSite(lane), async (site) => {
		role(site, 'primary');
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		role(site, 'replica');
		for (const [i, page] of pages.entries()) {
			const body = {
				...(page as Record<string, unknown>),
				...(i === 0 ? { expect: copyable } : {}),
				...(i === pages.length - 1 ? { done: true } : {})
			};
			const res = await site.fetch(
				new Request('https://do.local/__replica?action=restore', {
					method: 'POST',
					body: JSON.stringify(body),
					headers: { 'content-type': 'application/json' }
				})
			);
			expect(res.status, await res.clone().text()).toBe(200);
		}
		expect(site.replicaStage()).toBe('VERIFIED');
		// read HERE, in the same invocation the copy finished in: an alarm one millisecond out has
		// fired by the time a later `inObject` opens, and a fired alarm reads exactly like one that
		// was never set
		return site.ctx.storage.getAlarm();
	});

	return { primary, lane, armedAtRestore };
}

async function catchUp(lane: string): Promise<CatchUp> {
	return inObject(namedSite(lane), async (site) => {
		role(site, 'primary');
		const res = await site.fetch(new Request('https://do.local/__replica?action=catchup'));
		return (await res.json()) as CatchUp;
	});
}

describe('a restored lane drives itself to SERVING', () => {
	it(
		'promotes VERIFIED to SERVING when it agrees with the primary',
		async () => {
			const { lane } = await pairedLane('promote');
			const out = await catchUp(lane);

			expect(out.ran, out.reason).toBe(true);
			// the promotion goes through admissionVerdict, which refuses on a null fingerprint on
			// EITHER side rather than treating an absent one as agreement
			expect(out.admitted, out.reason).toBe(true);
			expect(out.stage).toBe('SERVING');
			expect(out.applied).toBe(out.advertised);
		},
		TIMEOUT
	);

	it(
		'answers a request once it has promoted itself, without an operator',
		async () => {
			const { lane } = await pairedLane('serves');
			await catchUp(lane);
			const status = await inObject(namedSite(lane), async (site) => {
				role(site, 'primary');
				const res = await site.fetch(new Request('https://do.local/__serve?path=/'));
				return res.status;
			});
			// before catch-up this lane answered 421 on every path
			expect(status).not.toBe(421);
		},
		TIMEOUT
	);

	it(
		'applies a write the primary made after the copy',
		async () => {
			const { primary, lane } = await pairedLane('applies');
			await catchUp(lane);

			await inObject(namedSite(primary), async (site) => {
				role(site, 'primary');
				const ok = (await site.runJson(
					drupalOp(`
\\Drupal::configFactory()->getEditable('system.site')->set('slogan', 'from-the-log')->save();
$out['slogan'] = \\Drupal::config('system.site')->get('slogan');`)
				)) as { ok?: boolean };
				expect(ok?.ok, `the write did not run: ${JSON.stringify(ok).slice(0, 200)}`).toBe(
					true
				);
				// runJson reaches the object directly, so neither seal hook fires
				await site.sealGeneration();
			});

			const out = await catchUp(lane);
			expect(out.records, out.reason).toBeGreaterThan(0);
			expect(out.applied).toBe(out.advertised);
		},
		TIMEOUT
	);
});

describe('the chain that keeps a lane replicating', () => {
	it(
		'arms an alarm the moment a copy finishes, or nothing ever fires',
		async () => {
			const { armedAtRestore } = await pairedLane('armed');
			// reaching VERIFIED is what starts the chain. A lane that finished its copy and stopped
			// would be complete, refusing every request, and waiting for an alarm nobody sets
			expect(armedAtRestore).not.toBeNull();
		},
		TIMEOUT
	);

	it(
		'promotes itself off its own alarm chain, with nothing calling the route',
		async () => {
			const { lane } = await pairedLane('byalarm');
			const stub = namedSite(lane);
			// NOTHING here calls `action=catchup`. The restore armed the chain and the chain does
			// the rest; `driveAlarms` only waits for it, and returns 0 firings when the alarm has
			// already fired on its own
			await driveAlarms(stub, (site) => site.replicaStage() === 'SERVING');
			const out = await inObject(stub, (site) => ({
				stage: site.replicaStage(),
				last: site.lastCatchUp
			}));
			expect(out.stage).toBe('SERVING');
			expect(out.last, 'promoted without a catch-up round having run').toBeTruthy();
		},
		TIMEOUT
	);

	it(
		'bounds how far behind a SERVING lane may fall',
		async () => {
			const { lane } = await pairedLane('steady');
			const stub = namedSite(lane);
			await driveAlarms(stub, (site) => site.replicaStage() === 'SERVING');

			const out = await inObject(stub, async (site) => {
				// THE TEST LANE RUNS WITH `SITE_WARM` ON AND PRODUCTION DOES NOT. With warming the
				// ordinary body re-arms at 8 s and this case cannot fail whatever the guard does;
				// at the shipped default it re-arms at `KEEP_WARM_MS`, 240 s. Measuring the lane's
				// own configuration would have measured the harness
				(site.env as Record<string, unknown>).SITE_WARM = '0';
				await site.alarm();
				return {
					stage: site.replicaStage(),
					alarm: await site.ctx.storage.getAlarm(),
					now: site.nowMs()
				};
			});

			expect(out.stage).toBe('SERVING');
			expect(out.alarm).not.toBeNull();
			// NOT "an alarm exists" -- one always does, because `alarmBody()` ends in an
			// unconditional re-arm. The property is that a serving lane's next firing is inside the
			// staleness bound rather than at the 240 s idle re-arm, which would let it serve a copy
			// four minutes behind the primary and look healthy doing it
			// measured both ways: 30,000 with the tightening and 240,000 without it
			expect(out.alarm! - out.now).toBeLessThanOrEqual(DEFAULT_REPLICA_LAG_MS);
			expect(out.alarm! - out.now).toBeGreaterThan(0);
		},
		TIMEOUT
	);
});

describe('what catch-up refuses to paper over', () => {
	it(
		'withdraws on an untrusted position rather than resuming from it',
		async () => {
			const { lane } = await pairedLane('untrusted');
			const out = await inObject(namedSite(lane), async (site) => {
				role(site, 'primary');
				// the marker a chunked apply leaves behind: rows landed and the position did not
				markInflight(site.logStore(), 1, 2);
				const res = await site.fetch(
					new Request('https://do.local/__replica?action=catchup')
				);
				return {
					body: (await res.json()) as CatchUp,
					stage: site.replicaStage()
				};
			});

			// NOT resumable: the marker records which generation was being built, not which of its
			// chunks committed, so there is no safe point to continue from
			expect(out.body.ran).toBe(false);
			expect(out.body.reason).toContain('interrupted');
			// what CATCH-UP decided, read from its own answer rather than from the durable stage. An
			// armed alarm can fire across the await above, and a withdrawn lane now leaves WITHDRAWN
			// for CREATED on its next firing to ask the primary for a fresh copy -- so re-reading the
			// stage measures whether the alarm ran, not what this call did
			expect(out.body.stage).toBe('WITHDRAWN');
			expect(['WITHDRAWN', 'CREATED']).toContain(out.stage);
		},
		TIMEOUT
	);

	it(
		'does nothing on an object that is not a pool lane',
		async () => {
			const out = await inObject(namedSite('catchup.plainsite'), async (site) => {
				role(site, 'primary');
				const res = await site.fetch(
					new Request('https://do.local/__replica?action=catchup')
				);
				return (await res.json()) as CatchUp;
			});
			expect(out.ran).toBe(false);
			expect(out.reason).toBe('not a pool lane');
		},
		TIMEOUT
	);

	it(
		'refuses to treat a log as a substitute for a restore',
		async () => {
			const out = await inObject(namedSite(replicaName('catchup.empty', 2)), async (site) => {
				role(site, 'primary');
				const res = await site.fetch(
					new Request('https://do.local/__replica?action=catchup')
				);
				return (await res.json()) as CatchUp;
			});
			// CREATED means no bulk copy has landed, and the log cannot carry a beginning
			expect(out.ran).toBe(false);
			expect(out.reason).toContain('needs a restore');
			expect(out.stage).toBe('CREATED');
		},
		TIMEOUT
	);
});
