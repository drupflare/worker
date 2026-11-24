import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
	addDays,
	appendRecords,
	certificationState,
	HISTORY_PER_FIXTURE,
	statusFile,
	type CertRecord
} from '../../scripts/e2e/certification';
import {
	certName,
	cpuLimitProblem,
	meterReading,
	nativeFixtureOf,
	ownedBy,
	selectDay,
	triggerOf,
	unreached
} from '../../scripts/e2e/certify';
import {
	rotationPeriodDays,
	runCost,
	runsPerDay,
	type RotationConfig
} from '../../scripts/e2e/rotation';

const ROWS = ['install', 'file rw', 'queue cron'];
const SHA = 'a'.repeat(40);

const record = (date: string, over: Partial<CertRecord> = {}): CertRecord => ({
	cms: 'drupal',
	fixture: 'alpha',
	sha: SHA,
	release: 'v1',
	plan: 'free',
	rows: Object.fromEntries(ROWS.map((r) => [r, { state: 'inline' }])),
	date,
	trigger: 'schedule',
	run: `github:${date}`,
	...over
});

const failing = (date: string, row = 'file rw', over: Partial<CertRecord> = {}) =>
	record(date, {
		rows: {
			install: { state: 'inline' },
			'file rw': { state: row === 'file rw' ? 'unsupported' : 'inline' },
			'queue cron': { state: row === 'queue cron' ? 'unknown' : 'inline' }
		},
		...over
	});

const judge = (history: CertRecord[], now: string, intervalDays = 7) =>
	certificationState(history, { fixture: 'alpha', sha: SHA, rows: ROWS, now, intervalDays });

describe('the Certified rule', () => {
	const run = (d: string) => record(d);
	const three = [run('2026-12-01'), run('2026-12-02'), run('2026-12-03')];

	it('has no state for a fixture with no run at the pin', () => {
		expect(judge([], '2026-12-01').state).toBe('none');
		expect(judge([record('2026-12-01', { sha: 'b'.repeat(40) })], '2026-12-01').state).toBe(
			'none'
		);
	});

	it('moves from none to deployed on the first pass and to certified on the third in a row', () => {
		expect(judge(three.slice(0, 1), '2026-12-01')).toMatchObject({
			state: 'deployed',
			streak: 1
		});
		expect(judge(three.slice(0, 2), '2026-12-02')).toMatchObject({
			state: 'deployed',
			streak: 2
		});
		expect(judge(three, '2026-12-03')).toMatchObject({
			state: 'certified',
			streak: 3,
			date: '2026-12-03',
			release: 'v1',
			plan: 'free',
			expires: '2026-12-17'
		});
	});

	it('does not count passes with a failure between them', () => {
		const history = [
			run('2026-12-01'),
			run('2026-12-02'),
			failing('2026-12-03'),
			run('2026-12-04'),
			run('2026-12-05')
		];
		expect(judge(history, '2026-12-05')).toMatchObject({ state: 'deployed', streak: 2 });
	});

	it('replays runs of one day in the order they finished, whatever order they arrive in', () => {
		const at = (time: string) => ({ at: `2026-12-01T${time}Z` });
		const day = [
			record('2026-12-01', at('01:00:00.000')),
			failing('2026-12-01', 'file rw', at('02:00:00.000')),
			record('2026-12-01', at('03:00:00.000')),
			record('2026-12-01', at('04:00:00.000')),
			record('2026-12-01', at('05:00:00.000'))
		];
		const shuffled = [day[3]!, day[0]!, day[4]!, day[1]!, day[2]!];
		const kept = appendRecords([], shuffled);
		expect(judge(kept, '2026-12-01')).toMatchObject({ state: 'certified', streak: 3 });
		expect(judge(shuffled, '2026-12-01')).toMatchObject({ state: 'certified', streak: 3 });
		const lastFails = [
			...day.slice(0, 1),
			day[2]!,
			day[3]!,
			failing('2026-12-01', 'file rw', at('06:00:00.000'))
		];
		expect(judge(appendRecords([], lastFails.reverse()), '2026-12-01')).toMatchObject({
			state: 'deployed',
			streak: 0
		});
	});

	it('shows deployed after one failed run and is certified again after the next pass', () => {
		const history = [...three, failing('2026-12-04')];
		expect(judge(history, '2026-12-04')).toMatchObject({
			state: 'deployed',
			streak: 0,
			failing: ['file rw']
		});
		// three of the newest four passed and the newest one did
		expect(judge([...history, run('2026-12-05')], '2026-12-05')).toMatchObject({
			state: 'certified',
			streak: 1
		});
	});

	it('needs two passes after a second failure close to the first', () => {
		const history = [...three, failing('2026-12-04'), run('2026-12-05')];
		expect(judge(history, '2026-12-05').state).toBe('certified');
		// the window is now pass, failure, pass: two of three passes and one more pass to come
		const second = [...history, failing('2026-12-06', 'queue cron')];
		expect(judge(second, '2026-12-06').state).toBe('deployed');
		expect(judge([...second, run('2026-12-07')], '2026-12-07').state).toBe('deployed');
		expect(judge([...second, run('2026-12-07'), run('2026-12-08')], '2026-12-08').state).toBe(
			'certified'
		);
	});

	it('is not certified by a window with two failures, whatever row they were on', () => {
		const history = [...three, failing('2026-12-10'), failing('2026-12-12', 'queue cron')];
		expect(judge(history, '2026-12-12').state).toBe('deployed');
		const sameRow = [...three, failing('2026-12-10'), run('2026-12-11'), failing('2026-12-12')];
		expect(judge([...sameRow, run('2026-12-13')], '2026-12-13').state).toBe('deployed');
	});

	it('never earns it from three of four, only from three in a row', () => {
		const history = [
			run('2026-12-01'),
			failing('2026-12-02'),
			run('2026-12-03'),
			run('2026-12-04')
		];
		expect(judge(history, '2026-12-04')).toMatchObject({ state: 'deployed', streak: 2 });
	});

	it('drops to deployed fourteen days after the last pass, and the day before it holds', () => {
		expect(judge(three, '2026-12-17').state).toBe('certified');
		expect(judge(three, '2026-12-18').state).toBe('deployed');
	});

	it('has to earn the three passes again after it has lapsed', () => {
		const lapsed = [...three, run('2027-01-10')];
		expect(judge(lapsed, '2027-01-10')).toMatchObject({ state: 'deployed', streak: 1 });
		const earned = [...lapsed, run('2027-01-11'), run('2027-01-12')];
		expect(judge(earned, '2027-01-12').state).toBe('certified');
	});

	it('doubles the lapse with the window', () => {
		const opts = { fixture: 'alpha', sha: SHA, rows: ROWS, intervalDays: 14, windowDays: 14 };
		expect(certificationState(three, { ...opts, now: '2026-12-31' }).state).toBe('certified');
		expect(certificationState(three, { ...opts, now: '2027-01-01' }).state).toBe('deployed');
	});

	it('counts a row the run did not record as failing', () => {
		const partial = record('2026-12-15', { rows: { install: { state: 'inline' } } });
		expect(judge([partial], '2026-12-15').failing).toEqual(['file rw', 'queue cron']);
	});

	it('counts parked and degraded rows as passing, and unknown as not', () => {
		const mixed = record('2026-12-15', {
			rows: {
				install: { state: 'parked' },
				'file rw': { state: 'degraded' },
				'queue cron': { state: 'unknown' }
			}
		});
		expect(judge([mixed], '2026-12-15').failing).toEqual(['queue cron']);
	});

	it('carries the anachron version of the latest run', () => {
		expect(judge([record('2026-12-01', { anachron: 'd0bc4a5' })], '2026-12-01').anachron).toBe(
			'd0bc4a5'
		);
	});
});

describe('the plan a fixture is certified on', () => {
	it('does not count a pass on paid toward free, and reports the plan it certified on', () => {
		const paid = ['2026-12-01', '2026-12-08', '2026-12-15'].map((d) =>
			record(d, { plan: 'paid' })
		);
		const mixed = [
			record('2026-12-01'),
			record('2026-12-08', { plan: 'paid' }),
			record('2026-12-15')
		];
		expect(judge(paid, '2026-12-15')).toMatchObject({ state: 'certified', plan: 'paid' });
		expect(judge(mixed, '2026-12-15')).toMatchObject({
			state: 'deployed',
			plan: 'free',
			streak: 2
		});
	});

	it('prefers free when both plans qualify', () => {
		const days = ['2026-12-01', '2026-12-08', '2026-12-15'];
		const both = days.flatMap((d) => [record(d), record(d, { plan: 'paid' })]);
		expect(judge(both, '2026-12-15')).toMatchObject({ state: 'certified', plan: 'free' });
	});

	it('keeps a paid certification when the free runs fail on CPU', () => {
		const days = ['2026-12-01', '2026-12-08', '2026-12-15'];
		const history = [
			...days.map((d) => record(d, { plan: 'paid' })),
			failing('2026-12-15', 'file rw', { plan: 'free' })
		];
		expect(judge(history, '2026-12-15')).toMatchObject({ state: 'certified', plan: 'paid' });
	});
});

describe('manual and scheduled histories', () => {
	it('judges three manual runs and three scheduled runs by the same function', () => {
		const days = ['2026-12-01', '2026-12-08', '2026-12-15'];
		const manual = days.map((d) => record(d, { trigger: 'dispatch', at: `${d}T10:00:00Z` }));
		const scheduled = days.map((d) => record(d, { trigger: 'schedule', at: `${d}T06:17:00Z` }));
		expect(judge(manual, '2026-12-15')).toMatchObject({
			state: 'certified',
			source: 'manual',
			at: '2026-12-15T10:00:00Z'
		});
		expect(judge(scheduled, '2026-12-15')).toMatchObject({
			state: 'certified',
			source: 'scheduled',
			at: '2026-12-15T06:17:00Z'
		});
	});

	it('lets scheduled runs maintain a history three manual runs started', () => {
		const history = [
			record('2026-12-01', { trigger: 'dispatch' }),
			record('2026-12-02', { trigger: 'dispatch' }),
			record('2026-12-03', { trigger: 'dispatch' }),
			record('2026-12-10', { trigger: 'schedule' })
		];
		expect(judge(history, '2026-12-10')).toMatchObject({
			state: 'certified',
			source: 'scheduled'
		});
	});
});

describe('the history and the status file', () => {
	it('keeps the newest records per fixture', () => {
		const old = Array.from({ length: HISTORY_PER_FIXTURE }, (_, i) =>
			record(addDays('2026-01-01', i))
		);
		const kept = appendRecords(old, [
			record('2026-12-01'),
			record('2026-12-02', { fixture: 'b' })
		]);
		expect(kept.filter((r) => r.fixture === 'alpha')).toHaveLength(HISTORY_PER_FIXTURE);
		expect(kept.some((r) => r.date === '2026-01-01')).toBe(false);
		expect(kept.some((r) => r.fixture === 'b')).toBe(true);
	});

	it('lists a status for each pinned fixture that has a record', () => {
		const corpus = {
			rows: ROWS,
			repos: [
				{ id: 'alpha', sha: SHA },
				{ id: 'b', sha: 'd'.repeat(40) }
			]
		};
		const file = statusFile([record('2026-12-01')], corpus, '2026-12-01', 7);
		expect(Object.keys(file.fixtures)).toEqual(['alpha']);
		expect(file).toMatchObject({ generated: '2026-12-01', intervalDays: 7 });
	});
});

describe('the certify driver helpers', () => {
	it('names the throwaway so teardown accepts it and the name stays short', () => {
		expect(certName('simple_oauth_21')).toBe('cfw-e2e-cert-simple-oauth-21');
		expect(certName('x'.repeat(80)).length).toBeLessThanOrEqual(54);
		expect(certName('Farmos')).toMatch(/^cfw-e2e-/);
	});

	it('counts only a scheduled workflow run as scheduled', () => {
		expect(triggerOf({ GITHUB_EVENT_NAME: 'schedule' })).toBe('schedule');
		expect(triggerOf({ GITHUB_EVENT_NAME: 'workflow_dispatch' })).toBe('dispatch');
		expect(triggerOf({})).toBe('dispatch');
	});

	it('records every row unknown, with the reason, for a run that never started', () => {
		expect(unreached(ROWS, 'no deploy')).toEqual({
			install: { state: 'unknown', note: 'no deploy' },
			'file rw': { state: 'unknown', note: 'no deploy' },
			'queue cron': { state: 'unknown', note: 'no deploy' }
		});
	});
});

describe('the residue check', () => {
	it('counts only entries named for this throwaway, so a sibling job is not residue', () => {
		const inv = {
			workers: ['cfw-e2e-cert-a', 'cfw-e2e-cert-b'],
			durableObjects: ['id1 cfw-e2e-cert-a_SiteDO', 'id2 cfw-e2e-cert-b_SiteDO'],
			kv: ['k1 other'],
			d1: ['d1 cfw-e2e-cert-a-fleet']
		};
		expect(ownedBy(inv, 'cfw-e2e-cert-a')).toEqual({
			workers: ['cfw-e2e-cert-a'],
			durableObjects: ['id1 cfw-e2e-cert-a_SiteDO'],
			kv: [],
			d1: ['d1 cfw-e2e-cert-a-fleet']
		});
	});
});

describe('choosing the day', () => {
	const cfg = {
		rowsPerDay: 100_000,
		reserve: 0.3,
		margin: 1,
		baseRows: 10_000,
		defaultDelivery: 0,
		delivery: {},
		fixtures: ['alpha', 'big', 'cheap'],
		profileFixtures: ['big'],
		paidFixtures: ['big']
	};

	it('leaves a paid fixture out unless paid runs are on, and tags the plan and timeout', () => {
		const off = selectDay(cfg, [], ROWS);
		expect(off.include.map((e) => e.fixture)).toEqual(['alpha', 'cheap']);
		const on = selectDay(cfg, [], ROWS, true);
		expect(on.include.find((e) => e.fixture === 'big')).toEqual({
			fixture: 'big',
			timeout: 150,
			plan: 'paid',
			anachron: false
		});
		expect(off.include.every((e) => e.plan === 'free' && e.timeout === 90)).toBe(true);
	});

	it('marks the fixtures that run with the anachron arm', () => {
		const day = selectDay({ ...cfg, anachronFixtures: ['alpha'] }, [], ROWS);
		expect(day.include.find((e) => e.fixture === 'alpha')?.anachron).toBe(true);
		expect(day.include.find((e) => e.fixture === 'cheap')?.anachron).toBe(false);
	});

	it('puts the fixture run least recently first, and a failed one before it', () => {
		const history = [
			record('2026-12-01', { fixture: 'alpha' }),
			failing('2026-12-09', 'file rw', { fixture: 'cheap' })
		];
		expect(selectDay({ ...cfg, rowsPerDay: 20_000 }, history, ROWS).include[0]?.fixture).toBe(
			'cheap'
		);
	});
});

describe('the registered pool', () => {
	const cfg = parse(
		readFileSync(join(import.meta.dirname, '../../config/corpus-certify.yml'), 'utf8')
	) as RotationConfig & {
		fixtures: string[];
	};

	it('holds only fixtures that earned Certified in a local pass, six in all', () => {
		expect(cfg.fixtures).toHaveLength(6);
		expect(cfg.fixtures).toContain('simple_oauth_21');
		expect(cfg.fixtures).toContain('lagoon_cachebackend');
	});

	it('runs two a day over a three day rotation at that size', () => {
		expect(runsPerDay(cfg.fixtures.length)).toBe(2);
		expect(rotationPeriodDays(cfg.fixtures.length)).toBe(3);
	});

	it('prices simple_oauth_21 at the 20,420 rows its first free run measured', () => {
		const raw = cfg.baseRows + (cfg.delivery['simple_oauth_21'] ?? cfg.defaultDelivery);
		expect(raw).toBe(20_420);
		expect(runCost(cfg, 'simple_oauth_21')).toBe(Math.ceil(20_420 * cfg.margin));
	});
});

describe('the deployed CPU ceiling check', () => {
	it('passes when no raised ceiling was asked for, whatever is deployed', () => {
		expect(cpuLimitProblem(0, undefined)).toBeUndefined();
		expect(cpuLimitProblem(0, 30_000)).toBeUndefined();
	});

	it('passes when the deployed ceiling is the one asked for', () => {
		expect(cpuLimitProblem(300_000, 300_000)).toBeUndefined();
	});

	it('stops a run whose raised ceiling was not applied, naming both figures', () => {
		expect(cpuLimitProblem(300_000, undefined)).toBe(
			'a CPU ceiling of 300000 ms was asked for and the deployed script holds the default'
		);
		expect(cpuLimitProblem(300_000, 30_000)).toContain('holds 30000');
	});
});

describe('whose database a run lands', () => {
	it('is the database of the base distribution for a sub-project, and its own otherwise', () => {
		expect(nativeFixtureOf({ id: 'activity_finder', base: 'yusaopeny' })).toBe('yusaopeny');
		expect(nativeFixtureOf({ id: 'farmos' })).toBe('farmos');
	});
});

describe('the meters read before teardown', () => {
	it('keeps the day rows and, when the governor acted, its counts and last refusal', () => {
		expect(meterReading({ rowsToday: 10 })).toEqual({ rowsToday: 10 });
		expect(meterReading({ rowsToday: 10, growthRefusals: 0, governedRuns: 0 })).toEqual({
			rowsToday: 10
		});
		const last = { at: 5, fromBytes: 1, toBytes: 2, capBytes: 3 };
		expect(
			meterReading({ rowsToday: 10, growthRefusals: 2, governedRuns: 4, lastGoverned: last })
		).toEqual({ rowsToday: 10, growth: { refusals: 2, governedRuns: 4, lastGoverned: last } });
	});

	it('keeps the durable refusal log and the isolate bytes as read', () => {
		const log = [{ at: 1, from_bytes: 2, to_bytes: 3, cap_bytes: 4, route: '/x' }];
		const out = meterReading({
			rowsToday: 1,
			growthRefusalLog: log,
			isolateBytes: { total: 7 }
		});
		expect(out).toEqual({ rowsToday: 1, growthRefusalLog: log, isolateBytes: { total: 7 } });
		expect(meterReading({ rowsToday: 1, growthRefusalLog: [] })).toEqual({ rowsToday: 1 });
		expect(meterReading({ rowsToday: 1, freshFirst: { count: 2, last: null } })).toEqual({
			rowsToday: 1,
			freshFirst: { count: 2, last: null }
		});
	});

	it('reads nothing from an answer with no day rows', () => {
		expect(meterReading({})).toBeUndefined();
	});
});

describe('a diagnostic run', () => {
	it('never counts toward Certified, whatever it recorded', () => {
		const three = ['2026-12-01', '2026-12-02', '2026-12-03'].map((d) =>
			record(d, { experiment: 'ff4-always' })
		);
		expect(judge(three, '2026-12-03').state).toBe('none');
		const mixed = [
			record('2026-12-01'),
			record('2026-12-02'),
			record('2026-12-03', { experiment: 'x' })
		];
		expect(judge(mixed, '2026-12-03')).toMatchObject({ state: 'deployed', streak: 2 });
	});
});
