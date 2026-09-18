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
 *
 * **ASSERT THE END STATE, NEVER WHICH ACTOR REACHED IT.** Two cases here raced on that and both
 * failed the same way: a lane that has reached SERVING runs `catchUpOnce()` off its own alarm
 * chain, so it can apply a record before the explicit `catchUp()` below it and leave that call
 * reporting `records: 0`. Asserting `records > 0` makes a case a race against the very liveness
 * this file exists to prove works, and it passes until the timing moves -- one of these survived
 * three runs and a full gate before a new interpreter build shifted it.
 *
 * So: compare the lane's applied generation before and after, or drive a deterministic log through
 * `transactionSync` rather than a real save. A record's REACHABILITY is a second trap in the second
 * approach -- `/__replica` answers `generation: this.commitSeq()`, so rows written past a commit
 * sequence that never advanced are invisible and the batch loop never opens.
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

/** a stored page, written straight in so a case does not have to drive a real fill to get one */
function storePage(site: ServeDo, path: string, html: string): void {
	site.ensureServeTables();
	site.sql.exec(
		'INSERT OR REPLACE INTO cfw_page (path, status, content_type, html, rendered_at, render_ms)' +
			' VALUES (?, 200, ?, ?, ?, 1.0)',
		path,
		'text/html',
		html,
		site.nowMs()
	);
}

function storedPaths(site: ServeDo): string[] {
	site.ensureServeTables();
	return site.sql
		.exec('SELECT path FROM cfw_page ORDER BY path')
		.toArray()
		.map((r) => String((r as { path: unknown }).path));
}

/** the whole primary -> replica handover, so each case starts from a lane that has real state */
async function pairedLane(
	name: string,
	seed?: (site: ServeDo) => void
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
		seed?.(site);
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
			const before = (await catchUp(lane)).applied;

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

			// THE INVARIANT IS THAT THE LANE CONVERGED, NOT THAT THIS CALL DID THE WORK. A lane
			// that has reached SERVING has an armed alarm chain running `catchUpOnce()` on its
			// own, so it can apply the record before the explicit call below and leave that call
			// reporting `records: 0` against an empty reason. Asserting `records > 0` here made
			// the case a race against the lane's own liveness, which is the property the rest of
			// this file exists to prove works.
			const out = await catchUp(lane);
			expect(out.applied).toBe(out.advertised);
			expect(out.applied, `lane did not advance past ${before}`).toBeGreaterThan(before);
		},
		TIMEOUT
	);
});

/**
 * The page store crossing the seam, and the invalidation that has to cross with it.
 *
 * A lane started with an empty `cfw_page` and rendered every anonymous request it was handed, which
 * is the one workload the pool exists to absorb. Seeding it is half the fix; the other half is that
 * `bumpGeneration()` runs only on the primary, so nothing on a lane ever dropped a stored page.
 */
describe("a lane serves the primary's pages and stops serving them when they change", () => {
	it(
		'arrives holding the pages the primary had stored',
		async () => {
			const { lane } = await pairedLane('seeded', (site) => {
				storePage(site, '/seeded-one', '<html>one</html>');
				storePage(site, '/seeded-two', '<html>two</html>');
			});

			const paths = await inObject(namedSite(lane), (site) => {
				role(site, 'primary');
				return storedPaths(site);
			});
			expect(paths).toEqual(['/seeded-one', '/seeded-two']);
		},
		TIMEOUT
	);

	it(
		'drops what it holds once the log moves it past a generation',
		async () => {
			const { primary, lane } = await pairedLane('invalidates', (site) => {
				storePage(site, '/stale', '<html>before the save</html>');
			});
			await catchUp(lane);
			// present before the write, or the assertion below passes on an empty store
			expect(
				await inObject(namedSite(lane), (site) => {
					role(site, 'primary');
					return storedPaths(site);
				})
			).toContain('/stale');

			await inObject(namedSite(primary), async (site) => {
				role(site, 'primary');
				const ok = (await site.runJson(
					drupalOp(`
\\Drupal::configFactory()->getEditable('system.site')->set('slogan', 'after-the-save')->save();
$out['slogan'] = \\Drupal::config('system.site')->get('slogan');`)
				)) as { ok?: boolean };
				expect(ok?.ok, `the write did not run: ${JSON.stringify(ok).slice(0, 200)}`).toBe(
					true
				);
				await site.sealGeneration();
			});

			const out = await catchUp(lane);
			expect(out.records, out.reason).toBeGreaterThan(0);
			const after = await inObject(namedSite(lane), (site) => {
				role(site, 'primary');
				return storedPaths(site);
			});
			// FALSIFIED by removing the `purgeAfterApply()` call in `catchUpOnce`: this reads
			// ['/stale'], which is a visitor being served content the site no longer has
			expect(after).toEqual([]);
		},
		TIMEOUT
	);

	it(
		'drops them when a later record in the same batch is refused',
		async () => {
			const { primary, lane } = await pairedLane('refused', (site) => {
				storePage(site, '/stale', '<html>before the save</html>');
			});
			await catchUp(lane);

			// One appliable record, then one the applier must refuse. An overflowed record is the
			// shape the refusal path names, and it is reachable on a real primary: a change too
			// large to log statement by statement seals as one of these.
			//
			// BOTH ROWS GO IN ONE `transactionSync`, and the first version of this drove a real
			// config save instead and was RACY. Each `sql.exec` autocommits, so a lane whose alarm
			// chain is already running could catch up in the gap between the seal and the insert,
			// apply the appliable record on its own, and leave the explicit call below pulling only
			// the refusal -- `records: 0` against a reason that already names the overflow. It
			// survived three runs and then failed, which is the signature of a race rather than a
			// defect.
			//
			// A record with NO statements still advances the generation, which `applyRecord()`
			// documents as the primary committing a generation whose whole effect was to state a
			// new fingerprint. So the appliable half needs no render at all, and the case gets
			// faster as well as deterministic. The sibling case above still covers a real save.
			// AND THE COMMIT SEQUENCE HAS TO MOVE WITH THEM. `/__replica` answers
			// `generation: this.commitSeq()` (`site-do.ts:12385`), and `catchUpOnce()` only opens
			// its batch when `applied < head.generation` -- so two rows written past a commit
			// sequence that never advanced are unreachable, the loop never runs, and the call
			// returns `records: 0` with an EMPTY reason. The real save used to advance this as a
			// side effect, which is what hid the requirement when the save was replaced.
			const startedAt = await inObject(namedSite(primary), (site) => {
				role(site, 'primary');
				site.ensureReplicationLog();
				const at = site.commitSeq();
				const schema = site.packGeneration() ?? '';
				site.ctx.storage.transactionSync(() => {
					site.sql.exec(
						`INSERT INTO cfw_repl_log (generation, parent, schema_version, fingerprint,
							overflowed, statements, sealed_at)
						 VALUES (?, ?, ?, ?, 0, '[]', ?)`,
						at + 1,
						at,
						schema,
						'appliable',
						site.nowMs()
					);
					site.sql.exec(
						`INSERT INTO cfw_repl_log (generation, parent, schema_version, fingerprint,
							overflowed, statements, sealed_at)
						 VALUES (?, ?, ?, ?, 1, '[]', ?)`,
						at + 2,
						at + 1,
						schema,
						'overflowed',
						site.nowMs()
					);
					site.advanceCommit();
					site.advanceCommit();
					site.flushCommitSeq();
				});
				return at;
			});

			// NOTHING IS ASSERTED ABOUT THIS CALL'S OWN RETURN, and an earlier version asserting
			// `records > 0` failed in the full gate twice while passing 12/12 in isolation. Making
			// the two log rows atomic fixed the WRITE race and left the READ one: the lane's alarm
			// chain can consume the whole batch before this call runs, after which the explicit
			// call pulls only the already-refused record and reports 0. The end state is identical
			// either way, which is the point -- see this file's docblock.
			await catchUp(lane);

			const after = await inObject(namedSite(lane), (site) => {
				role(site, 'primary');
				return {
					paths: storedPaths(site),
					commit: site.commitSeq(),
					stage: site.replicaStage()
				};
			});
			// FALSIFIED by removing the bookkeeping from the refusal branch in `catchUpOnce`:
			// reads ['/stale'] at a commit sequence behind the statements the lane applied
			expect(after.paths).toEqual([]);
			expect(after.commit, 'the applied record never advanced the sequence').toBeGreaterThan(
				startedAt
			);
			// the refusal is what ended the batch, wherever it was consumed
			expect(after.stage).toBe('WITHDRAWN');
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
			// NOT IN THE PAST, which is the property; `> 0` was a millisecond race and failed about
			// one run in six with `expected 0 to be greater than 0`. The clock can land on the same
			// millisecond the re-arm chose, and an alarm due immediately is the TIGHTEST possible
			// answer to "inside the staleness bound" rather than a violation of it. A genuinely
			// missed re-arm is negative, which this still catches, and the 240 s idle case is
			// caught by the bound above.
			expect(out.alarm! - out.now).toBeGreaterThanOrEqual(0);
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
