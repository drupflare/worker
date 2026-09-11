import { describe, expect, it } from 'vitest';
import { DAILY_ROWS_QUOTA, ROWS_PER_AUTH_RENDER } from '../../../src/ops/auth-budget';
import { REDUCE_AT } from '../../../src/ops/degrade';
import {
	SWEEP_MAX_FRACTION,
	SWEEP_QUEUE_ROWS,
	SWEEP_ROWS_FRACTION,
	SWEEP_ROWS_PER_FILL,
	SWEEP_ROWS_PER_PAGE,
	SWEEP_START_FLOOR,
	UNASKED_ROWS_FRACTION,
	enqueueSweep,
	enumerateAddressable,
	freshCursor,
	isSweepable,
	orderCandidates,
	pagesWithinRows,
	pendingCandidates,
	planSweep,
	readCovered,
	readSweepCursor,
	sweepCost,
	sweepCoverage,
	sweepDue,
	sweepEnabled,
	sweepRowsFraction,
	sweepStep,
	writeSweepCursor,
	type SweepCandidate,
	type SweepMeters,
	type SweepSql
} from '../../../src/ops/sweep';

/**
 * The governor, and the enumeration that feeds it.
 *
 * The sweep is the easy half. Every assertion here that matters is about a bound: the floor it will
 * not start below, the share of the day it may spend, the share of what is left it may take at once,
 * and the fact that it queues rather than renders.
 */

/**
 * A stand-in for the object's SQL surface.
 *
 * Tables are plain arrays and the six statements the module issues are matched by prefix, which is
 * the same trade `page-mirror.spec.ts` takes: the contract is the statements, not the engine.
 * `tests/node/sweep-enumerate.spec.ts` drives the identical calls against real SQLite, so a SQL
 * mistake this cannot see fails there.
 */
type Row = Record<string, unknown>;

/** the three `cfw_*` tables are always present, so a spec may read them back without a guard */
type FakeTables = {
	cfw_page: Row[];
	cfw_fill_queue: Row[];
	cfw_meta: Row[];
	[table: string]: Row[] | undefined;
};

function fakeSql(tables: FakeTables): SweepSql & { tables: FakeTables } {
	return {
		tables,
		exec(query: string, ...b: unknown[]) {
			const q = query.replace(/\s+/g, ' ').trim();
			if (q.startsWith('SELECT name FROM sqlite_master')) {
				const name = String(b[0]);
				return { toArray: () => (tables[name] ? [{ name }] : []) };
			}
			if (q.startsWith('SELECT path, alias FROM path_alias')) {
				return { toArray: () => (tables.path_alias ?? []).filter((r) => r.status === 1) };
			}
			if (q.startsWith('SELECT path FROM router')) {
				return { toArray: () => tables.router ?? [] };
			}
			if (q.startsWith('SELECT path FROM ')) {
				const table = q.slice('SELECT path FROM '.length);
				return { toArray: () => tables[table] ?? [] };
			}
			if (q.startsWith('SELECT v FROM cfw_meta')) {
				const held = (tables.cfw_meta ?? []).filter((r) => r.k === String(b[0]));
				return { toArray: () => held };
			}
			if (q.startsWith('INSERT INTO cfw_meta')) {
				const rows = (tables.cfw_meta ??= []);
				const held = rows.find((r) => r.k === String(b[0]));
				if (held) held.v = String(b[1]);
				else rows.push({ k: String(b[0]), v: String(b[1]) });
				return { toArray: () => [] };
			}
			if (q.startsWith('INSERT INTO cfw_fill_queue')) {
				const rows = (tables.cfw_fill_queue ??= []);
				if (!rows.some((r) => r.path === String(b[0]))) {
					rows.push({ path: String(b[0]), queued_at: Number(b[1]) });
				}
				return { toArray: () => [] };
			}
			// the entity reads, which all share one shape
			const entity = /FROM (\w+) WHERE status = 1/.exec(q)?.[1];
			if (entity) {
				const limit = Number(b[0]);
				const id = q.startsWith('SELECT nid')
					? 'nid'
					: q.startsWith('SELECT tid')
						? 'tid'
						: 'uid';
				const rows = (tables[entity] ?? [])
					.filter((r) => r.status === 1 && r.default_langcode === 1)
					.filter((r) => (id === 'uid' ? Number(r.uid) > 0 : true))
					.sort((x, y) => Number(y.changed) - Number(x.changed))
					.slice(0, limit)
					.map((r) => ({ id: r[id], clock: r.changed }));
				return { toArray: () => rows };
			}
			throw new Error(`unexpected query: ${q}`);
		}
	};
}

const candidate = (over: Partial<SweepCandidate> = {}): SweepCandidate => ({
	path: '/a',
	source: 'node',
	changedMs: 0,
	depth: 1,
	...over
});

const meters = (over: Partial<SweepMeters> = {}): SweepMeters => ({
	rowsToday: 0,
	rowsLimit: DAILY_ROWS_QUOTA,
	doToday: 0,
	doLimit: DAILY_ROWS_QUOTA,
	...over
});

const site = () =>
	fakeSql({
		router: [
			{ path: '/' },
			{ path: '/contact' },
			{ path: '/node/{node}' },
			{ path: '/admin/content' },
			{ path: '/user/login' },
			{ path: '/node/{node}/edit' }
		],
		path_alias: [{ path: '/node/2', alias: '/about', status: 1 }],
		node_field_data: [
			{ nid: 1, changed: 1_000, status: 1, default_langcode: 1 },
			{ nid: 2, changed: 2_000, status: 1, default_langcode: 1 },
			{ nid: 3, changed: 3_000, status: 0, default_langcode: 1 }
		],
		cfw_page: [],
		cfw_fill_queue: [],
		cfw_meta: []
	});

describe('the constants carry their provenance', () => {
	it('prices a swept page as a first-ever fill plus its two queue rows', () => {
		// `ROWS_PER_FILL.firstEverForPath`; the audit calls fillOne() directly, so it charges
		// neither the INSERT a sweep pays nor the DELETE the fill then matches
		expect(SWEEP_ROWS_PER_FILL).toBe(14);
		expect(SWEEP_QUEUE_ROWS).toBe(2);
		expect(SWEEP_ROWS_PER_PAGE).toBe(16);
	});

	it('takes the floor from the ladder rather than restating one', () => {
		expect(SWEEP_START_FLOOR).toBe(REDUCE_AT);
	});

	it('leaves the demand-driven anonymous need covered at its declared share', () => {
		// the derivation the docblock states, recomputed rather than quoted: at 25% for
		// authenticated and 25% for the sweep, what is left still clears the measured need
		const authReserved = DAILY_ROWS_QUOTA * 0.25;
		const sweepReserved = DAILY_ROWS_QUOTA * SWEEP_ROWS_FRACTION;
		const fills = Math.floor(
			(DAILY_ROWS_QUOTA - authReserved - sweepReserved) / ROWS_PER_AUTH_RENDER
		);
		// 1,000 regenerations/day is what a 3M-visit month at 1% dynamic needs
		expect(fills / 1000).toBeGreaterThan(5);
	});

	it('caps a declared share where the remaining headroom would fall under 3x', () => {
		const fills = Math.floor(
			(DAILY_ROWS_QUOTA - DAILY_ROWS_QUOTA * 0.25 - DAILY_ROWS_QUOTA * SWEEP_MAX_FRACTION) /
				ROWS_PER_AUTH_RENDER
		);
		expect(fills / 1000).toBeGreaterThan(2);
		expect(fills / 1000).toBeLessThan(3);
	});
});

describe('isSweepable', () => {
	it('refuses a pager or a facet, which is the whole reason enumeration is not a crawl', () => {
		expect(isSweepable('/blog?page=2')).toBe(false);
		expect(isSweepable('/search?f[0]=type:article')).toBe(false);
		expect(isSweepable('/blog&page=2')).toBe(false);
		expect(isSweepable('/blog#anchor')).toBe(false);
	});

	it('refuses an unfilled route placeholder', () => {
		expect(isSweepable('/node/{node}')).toBe(false);
	});

	it('refuses the pages a visitor acts on and the ones anonymous cannot see', () => {
		for (const path of [
			'/admin',
			'/admin/content',
			'/user/login',
			'/user/password',
			'/user/reset/1/2/3',
			'/node/add/page',
			'/node/1/edit',
			'/node/1/delete',
			'/cart',
			'/checkout'
		]) {
			expect(isSweepable(path), path).toBe(false);
		}
	});

	it('accepts the pages a sweep exists for', () => {
		for (const path of ['/', '/about', '/node/12', '/taxonomy/term/4', '/blog/a-post']) {
			expect(isSweepable(path), path).toBe(true);
		}
	});

	it('refuses anything that is not an absolute path', () => {
		expect(isSweepable('about')).toBe(false);
		expect(isSweepable('')).toBe(false);
		expect(isSweepable(undefined as unknown as string)).toBe(false);
	});
});

describe('enumerateAddressable', () => {
	it('never produces a pager, a facet or a placeholder', () => {
		const paths = enumerateAddressable(site()).map((c) => c.path);
		for (const p of paths) {
			expect(p).not.toContain('?');
			expect(p).not.toContain('&');
			expect(p).not.toContain('{');
		}
	});

	it('prefers the alias, because that is the URL a visitor requests', () => {
		const paths = enumerateAddressable(site()).map((c) => c.path);
		expect(paths).toContain('/about');
		expect(paths).not.toContain('/node/2');
	});

	it('drops the routes and entities a sweep may not render', () => {
		const paths = enumerateAddressable(site()).map((c) => c.path);
		expect(paths).toEqual(expect.arrayContaining(['/', '/contact', '/node/1']));
		expect(paths).not.toContain('/admin/content');
		expect(paths).not.toContain('/user/login');
		// unpublished
		expect(paths).not.toContain('/node/3');
	});

	it('carries the entity clock in ms and the path depth', () => {
		const found = enumerateAddressable(site()).find((c) => c.path === '/node/1');
		expect(found?.changedMs).toBe(1_000_000);
		expect(found?.depth).toBe(2);
		expect(enumerateAddressable(site()).find((c) => c.path === '/')?.depth).toBe(0);
	});

	it('survives a site with no taxonomy or users table', () => {
		const paths = enumerateAddressable(site()).map((c) => c.path);
		expect(paths.length).toBeGreaterThan(0);
	});

	it('bounds what it reads per kind', () => {
		const many = fakeSql({
			cfw_page: [],
			cfw_fill_queue: [],
			cfw_meta: [],
			node_field_data: Array.from({ length: 50 }, (_, i) => ({
				nid: i + 1,
				changed: i,
				status: 1,
				default_langcode: 1
			}))
		});
		expect(enumerateAddressable(many, { maxPerKind: 4 })).toHaveLength(4);
	});
});

describe('orderCandidates', () => {
	it('puts a high-view-count path before a recent-but-unviewed one', () => {
		const viewed = candidate({ path: '/old-but-popular', changedMs: 1 });
		const recent = candidate({ path: '/new-and-unread', changedMs: 9_999_999 });
		const ordered = orderCandidates([recent, viewed], new Map([['/old-but-popular', 12]]));
		expect(ordered.map((c) => c.path)).toEqual(['/old-but-popular', '/new-and-unread']);
	});

	it('falls back to recency when nothing has been viewed', () => {
		const older = candidate({ path: '/older', changedMs: 1 });
		const newer = candidate({ path: '/newer', changedMs: 2 });
		expect(orderCandidates([older, newer], null).map((c) => c.path)).toEqual([
			'/newer',
			'/older'
		]);
	});

	it('breaks a recency tie by depth, so the front page precedes a deep one', () => {
		const deep = candidate({ path: '/a/b/c', depth: 3 });
		const front = candidate({ path: '/', depth: 0 });
		expect(orderCandidates([deep, front], null).map((c) => c.path)).toEqual(['/', '/a/b/c']);
	});

	it('is deterministic when everything ties', () => {
		const all = [candidate({ path: '/b' }), candidate({ path: '/a' })];
		expect(orderCandidates(all, null).map((c) => c.path)).toEqual(['/a', '/b']);
	});
});

describe('pendingCandidates', () => {
	it('drops what is stored, what is queued and what cannot be stored at all', () => {
		const all = [
			candidate({ path: '/stored' }),
			candidate({ path: '/queued' }),
			candidate({ path: '/user/password' }),
			candidate({ path: '/open' })
		];
		const left = pendingCandidates(
			all,
			{ stored: new Set(['/stored']), queued: new Set(['/queued']) },
			(p) => p === '/user/password'
		);
		expect(left.map((c) => c.path)).toEqual(['/open']);
	});
});

describe('sweepCost', () => {
	it('charges the pages per page and the re-arm per firing', () => {
		// 5 pages in one batch of 5: 80 page rows + 1 setAlarm + 1 cursor
		expect(sweepCost(5, 5)).toEqual({ rows: 82, doRequests: 1 });
		// the same 5 pages at a batch of 1 is five firings
		expect(sweepCost(5, 1)).toEqual({ rows: 86, doRequests: 5 });
	});

	it('charges nothing for nothing', () => {
		expect(sweepCost(0, 5)).toEqual({ rows: 0, doRequests: 0 });
	});

	it('inverts', () => {
		const pages = pagesWithinRows(1_000, 50);
		expect(sweepCost(pages, 50).rows).toBeLessThanOrEqual(1_000);
		expect(sweepCost(pages + 1, 50).rows).toBeGreaterThan(1_000);
	});
});

describe('the governor', () => {
	const pending = Array.from({ length: 500 }, (_, i) => candidate({ path: `/p${i}` }));

	it('refuses below the floor, naming the meter and the fraction', () => {
		const plan = planSweep(
			pending,
			meters({ rowsToday: DAILY_ROWS_QUOTA * SWEEP_START_FLOOR }),
			freshCursor(0),
			{ batch: 50 }
		);
		expect(plan.ok).toBe(false);
		expect(plan.pages).toBe(0);
		expect(plan.boundBy).toBe('floor');
		expect(plan.reason).toContain('rows');
		expect(plan.reason).toContain('80%');
	});

	it('refuses on the DO meter too, not only on rows', () => {
		const plan = planSweep(
			pending,
			meters({ doToday: DAILY_ROWS_QUOTA * 0.9 }),
			freshCursor(0),
			{ batch: 50 }
		);
		expect(plan.boundBy).toBe('floor');
		expect(plan.reason).toContain('do');
	});

	it('runs just under the floor', () => {
		const plan = planSweep(
			pending,
			meters({ rowsToday: DAILY_ROWS_QUOTA * SWEEP_START_FLOOR - 1 }),
			freshCursor(0),
			{ batch: 50 }
		);
		expect(plan.ok).toBe(true);
	});

	it('queues at most one fill batch, so the queue never outruns the drain', () => {
		const plan = planSweep(pending, meters(), freshCursor(0), { batch: 50 });
		expect(plan.pages).toBe(50);
		expect(plan.boundBy).toBe('batch');
	});

	it('stops when its own share of the day is spent, and says when it resumes', () => {
		const spent = { ...freshCursor(0), rowsSpent: DAILY_ROWS_QUOTA * SWEEP_ROWS_FRACTION };
		const plan = planSweep(pending, meters({ rowsToday: 30_000 }), spent, { batch: 50 });
		expect(plan.ok).toBe(false);
		expect(plan.boundBy).toBe('daily-cap');
		expect(plan.reason).toContain('00:00 UTC');
	});

	it('cannot walk the site to the floor one quarter at a time', () => {
		// the daily cap is what stops it: without it a share of a shrinking remainder converges on
		// the floor rather than on a bound, which is the self-inflicted spike this exists to prevent
		let cursor = freshCursor(0);
		let rowsToday = 0;
		for (let step = 0; step < 200; step++) {
			const plan = planSweep(pending, meters({ rowsToday }), cursor, { batch: 50 });
			if (!plan.ok) break;
			rowsToday += plan.cost.rows;
			cursor = { ...cursor, rowsSpent: cursor.rowsSpent + plan.cost.rows };
		}
		expect(cursor.rowsSpent).toBeLessThanOrEqual(DAILY_ROWS_QUOTA * SWEEP_ROWS_FRACTION);
		expect(rowsToday / DAILY_ROWS_QUOTA).toBeLessThan(SWEEP_START_FLOOR);
	});

	it('takes a smaller step as the day is spent', () => {
		const early = planSweep(pending, meters({ rowsToday: 0 }), freshCursor(0), {
			batch: 5_000
		});
		const late = planSweep(pending, meters({ rowsToday: 79_000 }), freshCursor(0), {
			batch: 5_000
		});
		expect(late.pages).toBeLessThan(early.pages);
	});

	it('reports nothing to do rather than a refusal when everything is covered', () => {
		const plan = planSweep([], meters(), freshCursor(0), { batch: 50 });
		expect(plan.ok).toBe(false);
		expect(plan.boundBy).toBe('covered');
	});

	it('clamps a declared fraction into the range its derivation covers', () => {
		const greedy = planSweep(pending, meters(), freshCursor(0), {
			batch: 100_000,
			rowsFraction: 5
		});
		const capped = planSweep(pending, meters(), freshCursor(0), {
			batch: 100_000,
			rowsFraction: SWEEP_MAX_FRACTION
		});
		expect(greedy.pages).toBe(capped.pages);
	});

	it('is unbounded on a plan with no metered limits', () => {
		const plan = planSweep(pending, meters({ rowsLimit: 0, doLimit: 0 }), freshCursor(0), {
			batch: 50
		});
		expect(plan.ok).toBe(true);
		expect(plan.pages).toBe(50);
	});
});

describe('the cursor', () => {
	it('discards a record from another UTC day, because the quota refilled', () => {
		const sql = site();
		writeSweepCursor(sql, {
			day: '2020-01-01',
			rowsSpent: 25_000,
			doSpent: 40,
			pages: 1_500,
			generation: 3,
			lastRunMs: 5,
			done: true
		});
		const read = readSweepCursor(sql, Date.parse('2026-09-08T10:00:00Z'), 3);
		expect(read.day).toBe('2026-09-08');
		expect(read.rowsSpent).toBe(0);
		expect(read.pages).toBe(0);
		// the run clock survives the day boundary; the interval is not a daily quota
		expect(read.lastRunMs).toBe(5);
	});

	it('clears `done` when the generation moves, because the tail did', () => {
		const sql = site();
		const now = Date.parse('2026-09-08T10:00:00Z');
		writeSweepCursor(sql, { ...freshCursor(now, 3), done: true });
		expect(readSweepCursor(sql, now, 3).done).toBe(true);
		expect(readSweepCursor(sql, now, 4).done).toBe(false);
	});

	it('reads a fresh cursor through unparseable state rather than throwing', () => {
		const sql = site();
		sql.tables.cfw_meta.push({ k: 'sweep_cursor', v: 'not json' });
		expect(readSweepCursor(sql, 0).rowsSpent).toBe(0);
	});

	it('is due immediately when it has never run, and on the interval after', () => {
		const cursor = freshCursor(0);
		expect(sweepDue(cursor, 1_000)).toBe(true);
		expect(sweepDue({ ...cursor, lastRunMs: 1_000 }, 1_001, 60_000)).toBe(false);
		expect(sweepDue({ ...cursor, lastRunMs: 1_000 }, 62_000, 60_000)).toBe(true);
	});
});

describe('sweepEnabled', () => {
	it('is ON by default, because a path nobody swept is the one profile a render cannot win', () => {
		// it was off, and the reason was the account-wide quota rather than caution. That is priced
		// now rather than overridden: an unasked sweep takes a fifth of the share, so it takes 20
		// sweeping sites to saturate the account where it took 4
		expect(sweepEnabled(null)).toBe(true);
		expect(sweepEnabled({})).toBe(true);
		expect(sweepEnabled({ SWEEP: '' })).toBe(true);
		expect(sweepEnabled({ SWEEP: '1' })).toBe(true);
		// and the off switch still works, which is what makes the default reversible
		expect(sweepEnabled({ SWEEP: '0' })).toBe(false);
	});

	it('spends less when nobody asked for it than when an operator did', () => {
		// the whole safety argument is this asymmetry, so assert BOTH sides rather than the default
		// alone: a default that matched the asked-for share would reintroduce the refusal's cause
		expect(sweepRowsFraction(null)).toBe(UNASKED_ROWS_FRACTION);
		expect(sweepRowsFraction({})).toBe(UNASKED_ROWS_FRACTION);
		expect(sweepRowsFraction({ SWEEP: '1' })).toBe(SWEEP_ROWS_FRACTION);
		expect(UNASKED_ROWS_FRACTION).toBeLessThan(SWEEP_ROWS_FRACTION);
	});

	it('takes the declared share, clamped to the range its derivation covers', () => {
		expect(sweepRowsFraction({ SWEEP_ROWS_FRACTION: '0.1' })).toBe(0.1);
		expect(sweepRowsFraction({ SWEEP_ROWS_FRACTION: 9 })).toBe(SWEEP_MAX_FRACTION);
		// an unparseable value falls to the share this site would have used anyway
		expect(sweepRowsFraction({ SWEEP: '1', SWEEP_ROWS_FRACTION: -1 })).toBe(
			SWEEP_ROWS_FRACTION
		);
		expect(sweepRowsFraction({ SWEEP_ROWS_FRACTION: -1 })).toBe(UNASKED_ROWS_FRACTION);
	});
});

describe('sweepStep', () => {
	const deps = (sql: SweepSql, over: Record<string, unknown> = {}) => ({
		sql,
		meters: meters(),
		hits: null,
		isUnstorable: () => false,
		batch: 3,
		generation: 1,
		nowMs: Date.parse('2026-09-08T10:00:00Z'),
		...over
	});

	it('queues rather than renders, and charges the queue', () => {
		const sql = site();
		const out = sweepStep(deps(sql));
		expect(out.ok).toBe(true);
		expect(out.queued).toBe(3);
		expect(sql.tables.cfw_fill_queue).toHaveLength(3);
		expect(out.cost.rows).toBe(sweepCost(3, 3).rows);
	});

	it('resumes exactly where it stopped and does not repeat work', () => {
		const sql = site();
		const first = sweepStep(deps(sql));
		const queued = sql.tables.cfw_fill_queue.map((r) => String(r.path));

		// the fill batch drains what was queued, which is what makes those paths covered
		sql.tables.cfw_page = queued.map((path) => ({ path }));
		sql.tables.cfw_fill_queue = [];

		const second = sweepStep(deps(sql, { nowMs: Date.parse('2026-09-08T11:00:00Z') }));
		const again = sql.tables.cfw_fill_queue.map((r) => String(r.path));
		expect(again).not.toEqual(expect.arrayContaining(queued));
		expect(second.cursor.pages).toBe(first.queued + second.queued);
		expect(second.coverage.covered).toBe(queued.length);
	});

	it('yields to a fill backlog rather than adding to it', () => {
		const sql = site();
		sql.tables.cfw_fill_queue.push({ path: '/already', queued_at: 0 });
		const out = sweepStep(deps(sql));
		expect(out.ok).toBe(false);
		expect(out.boundBy).toBe('backlog');
		expect(sql.tables.cfw_fill_queue).toHaveLength(1);
	});

	it('writes no cursor row when it refuses, so the meter does not count itself', () => {
		const sql = site();
		const out = sweepStep(
			deps(sql, { meters: meters({ rowsToday: DAILY_ROWS_QUOTA * 0.95 }) })
		);
		expect(out.ok).toBe(false);
		expect(out.boundBy).toBe('floor');
		expect(sql.tables.cfw_meta).toHaveLength(0);
		expect(sql.tables.cfw_fill_queue).toHaveLength(0);
	});

	it('never re-queues a path the fill chain proved it cannot store', () => {
		const sql = site();
		const out = sweepStep(deps(sql, { isUnstorable: (p: string) => p !== '/' }));
		expect(out.queued).toBe(1);
		expect(sql.tables.cfw_fill_queue.map((r) => r.path)).toEqual(['/']);
	});

	it('reports coverage, which is the number nothing measured before', () => {
		const sql = site();
		const all = enumerateAddressable(sql);
		sql.tables.cfw_page = [{ path: '/' }];
		const out = sweepStep(deps(sql));
		expect(out.coverage.addressable).toBe(all.length);
		expect(out.coverage.covered).toBe(1);
		expect(out.coverage.fraction).toBeCloseTo(1 / all.length, 4);
	});

	it('reports `done` once nothing addressable is left', () => {
		const sql = site();
		const out = sweepStep(deps(sql, { batch: 500 }));
		expect(out.cursor.done).toBe(true);
		expect(out.boundBy).toBe('covered');
	});
});

describe('sweepCoverage', () => {
	it('calls an empty site covered rather than uncovered', () => {
		expect(sweepCoverage([], new Set())).toEqual({
			addressable: 0,
			covered: 0,
			pending: 0,
			fraction: 1
		});
	});
});

describe('enqueueSweep and readCovered', () => {
	it('round-trips a queued path', () => {
		const sql = site();
		expect(enqueueSweep(sql, ['/a', '/b'], 7)).toBe(2);
		expect(readCovered(sql).queued).toEqual(new Set(['/a', '/b']));
	});
});
