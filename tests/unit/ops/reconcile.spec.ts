import { describe, expect, it } from 'vitest';
import {
	CLEAN_RECONCILE,
	PACK_VERSION,
	RECONCILE_STEPS,
	SHIPPED_PAGE_MAX_AGE,
	STEP_ATTEMPT_LIMIT,
	configMaxAge,
	parseReconcileState,
	planReconcile,
	reconcileReport,
	reconciled,
	recordStep,
	serialiseReconcileState,
	serialisedInt,
	versionReached,
	type ReconcileHost,
	type ReconcileSql,
	type ReconcileState,
	type ReconcileStep
} from '../../../src/ops/reconcile';

/**
 * The delivery path for a fix the pack cannot carry backwards.
 *
 * Everything here is about one property: a step's success condition is the site's END STATE, never
 * that the step ran. Two Outstanding Bugs closed on the weaker assertion and neither site converged.
 */

/** a sql seam over plain maps, so a step's observation is drivable without a database */
function fakeSql(tables: Record<string, Record<string, unknown>[]>): ReconcileSql & {
	deleted: string[];
} {
	const deleted: string[] = [];
	return {
		deleted,
		exec(sql: string, ...bindings: unknown[]) {
			const from = /FROM\s+([a-z_]+)/i.exec(sql)?.[1] ?? '';
			if (/^\s*DELETE/i.test(sql)) {
				const target = /DELETE FROM\s+([a-z_]+)/i.exec(sql)?.[1] ?? '';
				deleted.push(target);
				const rows = tables[target];
				if (rows) {
					const before = Number(bindings[0] ?? Infinity);
					tables[target] = rows.filter((r) => Number(r.timestamp ?? -Infinity) >= before);
				}
				return { toArray: () => [] };
			}
			const rows = tables[from];
			if (rows === undefined) throw new Error(`no such table: ${from}`);
			if (/COUNT\(/i.test(sql)) {
				const before = Number(bindings[0] ?? Infinity);
				const n = /timestamp <\s*\?/.test(sql)
					? rows.filter((r) => Number(r.timestamp) < before).length
					: rows.length;
				return { toArray: () => [{ n }] };
			}
			if (/WHERE (name|cid) = \?/.test(sql)) {
				const key = /WHERE (name|cid)/.exec(sql)?.[1] as string;
				const hit = rows.find((r) => r[key] === bindings[0]);
				return { toArray: () => (hit ? [hit] : []) };
			}
			return { toArray: () => rows };
		}
	};
}

function fakeHost(claimedAtMs: number | null, meta: Record<string, string> = {}): ReconcileHost {
	return {
		claimedAtMs: () => claimedAtMs,
		meta: (k) => meta[k] ?? null,
		setMeta: (k, v) => {
			meta[k] = v;
		},
		origin: () => 'https://site.example'
	};
}

/** a serialized `system.performance` carrying one max_age, which is what the row really holds */
function performanceRow(maxAge: number): string {
	return `a:1:{s:5:"cache";a:1:{s:4:"page";a:1:{s:7:"max_age";i:${maxAge};}}}`;
}

describe('reading the two copies of a config object', () => {
	it('reads the row and the cache bin that shadows it', () => {
		const sql = fakeSql({
			config: [{ name: 'system.performance', data: performanceRow(300) }],
			cache_config: [{ cid: 'system.performance', data: performanceRow(0) }]
		});
		expect(configMaxAge(sql)).toEqual({ config: 300, cached: 0 });
	});

	it('reports an absent cache bin as null rather than as zero', () => {
		const sql = fakeSql({
			config: [{ name: 'system.performance', data: performanceRow(300) }],
			cache_config: []
		});
		expect(configMaxAge(sql)).toEqual({ config: 300, cached: null });
	});

	/**
	 * The defect this whole step exists for. `config` said 300 and `cache_config` kept its own 0,
	 * Drupal reads the bin first, so every render on every site answered `no-store` and `cfw_page`
	 * stayed empty while the fix was believed shipped.
	 */
	it('calls a site with disagreeing copies owed, not satisfied', () => {
		const step = RECONCILE_STEPS.find((s) => s.id === 'page-max-age') as ReconcileStep;
		const sql = fakeSql({
			config: [{ name: 'system.performance', data: performanceRow(300) }],
			cache_config: [{ cid: 'system.performance', data: performanceRow(0) }]
		});
		expect(step.verdict(sql, fakeHost(1_000)).state).toBe('owed');
	});

	it('calls a site whose copies agree satisfied', () => {
		const step = RECONCILE_STEPS.find((s) => s.id === 'page-max-age') as ReconcileStep;
		const sql = fakeSql({
			config: [{ name: 'system.performance', data: performanceRow(300) }],
			cache_config: [{ cid: 'system.performance', data: performanceRow(300) }]
		});
		expect(step.verdict(sql, fakeHost(1_000)).state).toBe('satisfied');
	});

	it('emits a fragment that writes the shipped value through the config factory', () => {
		const step = RECONCILE_STEPS.find((s) => s.id === 'page-max-age') as ReconcileStep;
		const php = step.php?.(fakeHost(1_000)) ?? '';
		expect(php).toContain("getEditable('system.performance')");
		expect(php).toContain(`set('cache.page.max_age', ${SHIPPED_PAGE_MAX_AGE})`);
		// a SQL update would be the inert fix again; the whole reason for PHP is that ConfigFactory
		// already clears the bin and invalidates the tag
		expect(php).not.toContain('UPDATE config');
	});
});

describe('a serialized integer is parsed, not cast', () => {
	it('reads an int', () => {
		expect(serialisedInt('i:1786258127;')).toBe(1786258127);
	});

	it('refuses a serialized STRING that a REPLACE-based cast would read as a number', () => {
		expect(serialisedInt('s:10:"1786258127";')).toBeNull();
	});
});

describe("the bake's own history", () => {
	const step = RECONCILE_STEPS.find((s) => s.id === 'bake-watchdog') as ReconcileStep;

	it('defers on an unclaimed site, because no row can be shown to be foreign', () => {
		const sql = fakeSql({ watchdog: [{ timestamp: 1_000 }] });
		expect(step.verdict(sql, fakeHost(null)).state).toBe('deferred');
	});

	it('owes a claimed site whose log predates it', () => {
		const sql = fakeSql({ watchdog: [{ timestamp: 1_000 }, { timestamp: 9_000 }] });
		const verdict = step.verdict(sql, fakeHost(5_000_000));
		expect(verdict.state).toBe('owed');
	});

	it("deletes only what predates the claim, so the site's own log survives", () => {
		const tables = { watchdog: [{ timestamp: 1_000 }, { timestamp: 9_000 }] };
		const sql = fakeSql(tables);
		const host = fakeHost(5_000_000);
		step.sql?.(sql, host);
		expect(tables.watchdog).toEqual([{ timestamp: 9_000 }]);
		expect(step.verdict(sql, host).state).toBe('satisfied');
	});

	it('is satisfied on a pack with no dblog rather than failing on the missing table', () => {
		expect(step.verdict(fakeSql({}), fakeHost(5_000_000)).state).toBe('satisfied');
	});
});

describe('the container step, which is the general close for a hook added after the bake', () => {
	const step = RECONCILE_STEPS.find((s) => s.id === 'container-driver-digest') as ReconcileStep;

	it('owes a site whose recorded digest does not match the pack', () => {
		const sql = fakeSql({ cache_container: [{ cid: 'x' }] });
		expect(step.verdict(sql, fakeHost(1_000, { driver_digest: 'stale' })).state).toBe('owed');
	});

	/**
	 * The apply writes its own marker, and it has to.
	 *
	 * The verdict runs immediately after the apply, so a step whose end state IS a recorded value
	 * would read the old one and be filed as failed on the run that succeeded.
	 */
	it('drops the container and records the digest in the same apply', () => {
		const tables = { cache_container: [{ cid: 'x' }] };
		const sql = fakeSql(tables);
		const meta: Record<string, string> = { driver_digest: 'stale' };
		const host = fakeHost(1_000, meta);
		step.sql?.(sql, host);
		expect(sql.deleted).toContain('cache_container');
		expect(step.verdict(sql, host).state).toBe('satisfied');
	});
});

describe('planning, which is what makes the chain sliceable', () => {
	const alwaysOwed: ReconcileStep = {
		id: 'owed',
		since: 1,
		describe: 'never converges',
		verdict: () => ({ state: 'owed', detail: 'still owed' }),
		sql: () => {}
	};
	const alwaysSatisfied: ReconcileStep = {
		id: 'fine',
		since: 1,
		describe: 'already true',
		verdict: () => ({ state: 'satisfied' })
	};
	const alwaysDeferred: ReconcileStep = {
		id: 'later',
		since: 1,
		describe: 'not yet',
		verdict: () => ({ state: 'deferred', detail: 'waiting' })
	};

	it('marks a step the site already satisfies without running it', () => {
		const planned = planReconcile(CLEAN_RECONCILE, fakeSql({}), fakeHost(1), [alwaysSatisfied]);
		expect(planned.action).toBe('mark');
	});

	it('waits on a deferred step rather than calling it a failure', () => {
		const planned = planReconcile(CLEAN_RECONCILE, fakeSql({}), fakeHost(null), [
			alwaysDeferred
		]);
		expect(planned).toMatchObject({ action: 'wait', reason: 'waiting' });
	});

	it('reports done once every step is applied', () => {
		const state = { version: 0, applied: ['fine'], failed: {} };
		expect(planReconcile(state, fakeSql({}), fakeHost(1), [alwaysSatisfied]).action).toBe(
			'done'
		);
	});

	it('stops asking a step that has spent its attempts, so it cannot own the chain', () => {
		let state: ReconcileState = { version: 0, applied: [], failed: {} };
		for (let i = 0; i < STEP_ATTEMPT_LIMIT; i++) {
			state = recordStep(state, alwaysOwed, { state: 'owed', detail: 'still owed' }, [
				alwaysOwed
			]);
		}
		expect(state.failed['owed']?.attempts).toBe(STEP_ATTEMPT_LIMIT);
		expect(planReconcile(state, fakeSql({}), fakeHost(1), [alwaysOwed]).action).toBe('done');
	});

	it('resumes exactly where it stopped rather than repeating an applied step', () => {
		const first = planReconcile(CLEAN_RECONCILE, fakeSql({}), fakeHost(1), [
			alwaysSatisfied,
			alwaysOwed
		]);
		expect(first).toMatchObject({ action: 'mark' });
		const after = recordStep(CLEAN_RECONCILE, alwaysSatisfied, { state: 'satisfied' }, [
			alwaysSatisfied,
			alwaysOwed
		]);
		expect(
			planReconcile(after, fakeSql({}), fakeHost(1), [alwaysSatisfied, alwaysOwed])
		).toMatchObject({ action: 'run' });
	});

	it('records a step that ran and did not converge as failed, not applied', () => {
		const state = recordStep(CLEAN_RECONCILE, alwaysOwed, {
			state: 'owed',
			detail: 'still owed'
		});
		expect(state.applied).not.toContain('owed');
		expect(state.failed['owed']).toEqual({ attempts: 1, reason: 'still owed' });
	});
});

describe('the version is monotonic, which is what a rollout counts against', () => {
	const v1a: ReconcileStep = {
		id: 'a',
		since: 1,
		describe: '',
		verdict: () => ({ state: 'satisfied' })
	};
	const v1b: ReconcileStep = {
		id: 'b',
		since: 1,
		describe: '',
		verdict: () => ({ state: 'satisfied' })
	};
	const v2: ReconcileStep = {
		id: 'c',
		since: 2,
		describe: '',
		verdict: () => ({ state: 'satisfied' })
	};
	const steps = [v1a, v1b, v2];

	it('does not claim a version while one of its steps is outstanding', () => {
		expect(versionReached(['a'], steps)).toBe(0);
		expect(versionReached(['a', 'b'], steps)).toBe(1);
	});

	it('does not skip a version even when a later step is done', () => {
		expect(versionReached(['a', 'c'], steps)).toBe(0);
		expect(versionReached(['a', 'b', 'c'], steps)).toBe(2);
	});

	it('is the highest since across the shipping list', () => {
		expect(PACK_VERSION).toBe(Math.max(...RECONCILE_STEPS.map((s) => s.since)));
		expect(PACK_VERSION).toBeGreaterThan(0);
	});
});

describe('state round-trips, and a corrupt row re-reconciles rather than skipping', () => {
	it('survives serialise and parse', () => {
		const state = { version: 2, applied: ['a'], failed: { b: { attempts: 2, reason: 'no' } } };
		expect(parseReconcileState(serialiseReconcileState(state))).toEqual(state);
	});

	it('defaults to clean on unparseable text', () => {
		expect(parseReconcileState('{oh no')).toEqual({ version: 0, applied: [], failed: {} });
	});

	it('defaults to clean on an absent row', () => {
		expect(parseReconcileState(null)).toEqual({ version: 0, applied: [], failed: {} });
	});

	it('reads an old failure recorded before attempts were counted', () => {
		const parsed = parseReconcileState(
			'{"version":1,"applied":[],"failed":{"x":{"reason":"r"}}}'
		);
		expect(parsed.failed['x']).toEqual({ attempts: 1, reason: 'r' });
	});
});

describe('the steady state costs one comparison', () => {
	it('is reconciled at the shipping version with nothing failed', () => {
		expect(reconciled({ version: PACK_VERSION, applied: [], failed: {} })).toBe(true);
	});

	it('is NOT reconciled while a step is failed, even at the right version', () => {
		expect(
			reconciled({
				version: PACK_VERSION,
				applied: [],
				failed: { x: { attempts: 1, reason: '' } }
			})
		).toBe(false);
	});

	it('is not reconciled below the shipping version', () => {
		expect(reconciled(CLEAN_RECONCILE)).toBe(false);
	});
});

describe('the status report', () => {
	it('names every step and what this site owes on it', () => {
		const sql = fakeSql({
			config: [{ name: 'system.performance', data: performanceRow(0) }],
			cache_config: [],
			watchdog: [],
			cache_container: [{ cid: 'x' }]
		});
		const report = reconcileReport(CLEAN_RECONCILE, sql, fakeHost(null));
		expect(report.packVersion).toBe(PACK_VERSION);
		expect(report.steps.map((s) => s.id)).toEqual(RECONCILE_STEPS.map((s) => s.id));
		expect(report.steps.find((s) => s.id === 'page-max-age')?.state).toBe('owed');
		expect(report.steps.find((s) => s.id === 'bake-clock')?.state).toBe('deferred');
	});

	it('shows an attempt count on a failed step rather than only its reason', () => {
		const state = {
			version: 0,
			applied: [],
			failed: { 'page-max-age': { attempts: 2, reason: 'x' } }
		};
		const report = reconcileReport(state, fakeSql({}), fakeHost(null));
		expect(report.steps.find((s) => s.id === 'page-max-age')?.detail).toContain('attempt 2');
	});
});

describe('the list itself', () => {
	it('has no duplicate ids, which the applied set is keyed on', () => {
		const ids = RECONCILE_STEPS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('gives every step something to do', () => {
		for (const step of RECONCILE_STEPS) {
			expect(Boolean(step.sql) || Boolean(step.php), step.id).toBe(true);
		}
	});

	/**
	 * A config or state write goes through PHP, and this is the check that keeps it that way.
	 *
	 * The inert fix was a correct SQL update to `config` with `cache_config` still holding the old
	 * value. Drupal's own writers know about every copy; a host re-deriving that list gets it wrong.
	 */
	it('never writes config or state over SQL', () => {
		for (const step of RECONCILE_STEPS) {
			const source = String(step.sql ?? '');
			expect(source, step.id).not.toMatch(/(UPDATE|INSERT INTO)\s+(config|key_value)/i);
		}
	});
});
