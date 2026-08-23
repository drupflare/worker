import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	DO_GB_ALLOCATED,
	FREE_QUOTAS,
	IDLE_GB_S_PER_DAY
} from '../../scripts/measure/free-envelope';
import { runFillWindow } from '../../src/site';
import {
	freshSite,
	inObject,
	namedSite,
	pageFor,
	queuePath,
	statsOf,
	stubRender
} from '../helpers/serve-do';

/**
 * Ported from the `the warm window` region of `scripts/test-serve-chain.mjs`.
 *
 * One boot, then one fill per incoming WebSocket message. Each incoming message resets the
 * Durable Object's remaining CPU time (documented on the DO limits page), so N messages buy N
 * budgets inside ONE object lifetime. The alarm chain cannot do that: it hibernates between
 * firings and discards the interpreter, so every alarm-driven fill pays boot -- 3,754 ms of edge
 * cpuTime against a 40 ms render.
 *
 * What is asserted is the mechanism, not the saving, carried across from the original
 * unchanged: the saving is boot amortisation, and boot only costs what it costs on the edge.
 * Locally the object stays warm either way, so a timing comparison here would measure nothing.
 *
 * What changed from the original:
 *
 *   - **The driver is called as a function.** The original drove `/fillwindow` over HTTP against
 *     `wrangler dev`; `runFillWindow()` is exported, so the same code path runs with no server.
 *   - **The two bounds are now tested.** `maxFills` and `wallBudgetMs` bound DO requests and
 *     billed duration respectively; neither was reachable from the original's fixed query string.
 *   - **The gate label is asserted.** Each fill runs inside `gate.run(..., 'window')`, so the
 *     gate's own order log shows the window entries -- which is how "the window does not race the
 *     alarm chain for the interpreter" is stated without timing.
 */

/**
 * Opens a window and narrows the result.
 *
 * `runFillWindow()` returns a discriminated union -- a window that never opened has no outcomes
 * rather than an empty list of them -- so the failure case is asserted away here once instead of
 * being carried through every assertion below as an optional field.
 */
async function openWindow(site: string, opts: { maxFills?: number; wallBudgetMs?: number } = {}) {
	const win = await runFillWindow(env, site, opts);
	expect(win.ok).toBe(true);
	if (!win.ok) throw new Error(win.error);
	return win;
}

describe('a warm window drives fills over one socket', () => {
	it('fills every queued path, one per message, against an already-booted interpreter', async () => {
		const site = 'window-drain';
		const paths = ['/', '/node', '/user/login'];
		await inObject(namedSite(site), (obj) => {
			stubRender(obj, ({ path }) => pageFor(path));
			for (const path of paths) queuePath(obj, path, { arm: false });
		});

		const win = await openWindow(site, { maxFills: 8 });
		const outcomes = win.outcomes;

		expect(win.drained).toBe(true);
		expect(win.fills).toBe(paths.length);
		expect(win.stopped).toBeNull();
		expect(typeof win.wallMs).toBe('number');

		// only the fill replies carry `booted`; the trailing drained signal does not
		const fillReplies = outcomes.filter((o) => o.ok && Object.hasOwn(o, 'booted'));
		expect(fillReplies).toHaveLength(paths.length);
		// every fill after the first shares one booted interpreter
		expect(fillReplies.every((o) => o.booted === true)).toBe(true);
		// `booted` and `bootedInFill` are NEAR-OPPOSITES on a warm fill and must stay distinct.
		// The reply spreads the fill outcome over its own fields, so a fill outcome that reused
		// the name `booted` silently inverted this one -- which is how it was found
		expect(fillReplies.every((o) => o.bootedInFill === false)).toBe(true);
		// exactly one fill per message: batching inside a message would spend one budget on many
		expect(fillReplies.map((o) => o.filled)).toEqual(paths);

		const stats = await inObject(namedSite(site), (obj) => statsOf(obj));
		expect(stats.queue).toHaveLength(0);
		expect(stats.cached.map((r) => r.path).sort()).toEqual([...paths].sort());
		// the window and the alarm chain share one queue and must not double-fill it
		expect(stats.cached).toHaveLength(paths.length);
	});

	it('runs each fill inside the PHP gate, labelled as the window', async () => {
		const site = 'window-gate';
		await inObject(namedSite(site), (obj) => {
			stubRender(obj, ({ path }) => pageFor(path));
			queuePath(obj, '/', { arm: false });
		});
		await runFillWindow(env, site, { maxFills: 4 });
		const stats = await inObject(namedSite(site), (obj) => statsOf(obj));
		expect(stats.gate.order).toContain('window');
		expect(stats.gate.maxConcurrent).toBe(1);
	});

	it('reports drained on a queue that was already empty, rather than hanging', async () => {
		const site = 'window-empty';
		await inObject(namedSite(site), (obj) => {
			stubRender(obj, ({ path }) => pageFor(path));
			obj.ensureServeTables();
		});
		const win = await openWindow(site, { maxFills: 4 });
		expect(win.drained).toBe(true);
		expect(win.fills).toBe(0);
	});
});

describe('a window is bounded three ways, because it spends three budgets', () => {
	it('stops at maxFills, which bounds DO requests and rows written', async () => {
		const site = 'window-max';
		await inObject(namedSite(site), (obj) => {
			stubRender(obj, ({ path }) => pageFor(path));
			for (const path of ['/a', '/b', '/c', '/d', '/e']) queuePath(obj, path, { arm: false });
		});
		const win = await openWindow(site, { maxFills: 2 });
		expect(win.fills).toBe(2);
		expect(win.drained).toBe(false);
		const depth = await inObject(namedSite(site), (obj) => obj.queueDepth());
		expect(depth).toBe(3);
	});

	it('stops on the wall budget, because a held socket is billed for duration', async () => {
		const site = 'window-wall';
		await inObject(namedSite(site), (obj) => {
			stubRender(obj, ({ path }) => pageFor(path));
			queuePath(obj, '/', { arm: false });
		});
		const win = await openWindow(site, { maxFills: 8, wallBudgetMs: 0 });
		expect(win.stopped).toBe('wall-budget');
		expect(win.fills).toBe(0);
		// nothing was filled, so the path is still queued for the alarm chain
		const depth = await inObject(namedSite(site), (obj) => obj.queueDepth());
		expect(depth).toBe(1);
	});

	it('reads its bounds off the environment when the caller gives none', async () => {
		const site = 'window-env';
		await inObject(namedSite(site), (obj) => {
			stubRender(obj, ({ path }) => pageFor(path));
			for (const path of ['/a', '/b', '/c']) queuePath(obj, path, { arm: false });
		});
		const win = await runFillWindow({ ...env, WINDOW_MAX_FILLS: '1' }, site);
		expect(win.ok).toBe(true);
		if (!win.ok) throw new Error(win.error);
		expect(win.fills).toBe(1);
		expect(win.drained).toBe(false);
	});

	/**
	 * THE SOCKET IS THE ONLY THING IN THIS OBJECT THAT CAN BLOCK HIBERNATION, so its default bound
	 * is a duration-meter number rather than a comfort setting.
	 *
	 * `openFillWindow()` calls `server.accept()`, not `ctx.acceptWebSocket()`, so the object stays
	 * alive and BILLED for the socket's whole lifetime -- and an object idle-but-unable-to-hibernate
	 * bills `86,400 x 0.125` = 10,800 GB-s for a day, 83% of the free allowance, which no request or
	 * row count would show. The client bounds it; this asserts the bound is small against the meter
	 * rather than merely present.
	 */
	it('costs a bounded, small share of the daily duration allowance', () => {
		const defaultWallMs = 60_000;
		// the platform caps a connection keeping an object alive at 15 minutes, which is the worst
		// case when a client opens a window and then dies without sending `close`
		const platformCapMs = 15 * 60_000;
		const gbS = (ms: number) => (ms / 1000) * DO_GB_ALLOCATED;

		expect(gbS(defaultWallMs)).toBeCloseTo(7.68, 5);
		expect(gbS(defaultWallMs) / FREE_QUOTAS.durationGbSPerDay).toBeLessThan(0.001);
		// even the abandoned-window worst case is under 1% of the day
		expect(gbS(platformCapMs) / FREE_QUOTAS.durationGbSPerDay).toBeLessThan(0.01);
		// and it is nowhere near the always-warm case, which is the thing that would eat the meter
		expect(gbS(platformCapMs)).toBeLessThan(IDLE_GB_S_PER_DAY / 50);
	});
});

describe('a failing fill stops the window instead of spinning', () => {
	it('reports the error and leaves the path queued for the retry count', async () => {
		const site = 'window-fail';
		await inObject(namedSite(site), (obj) => {
			stubRender(obj, () => {
				throw new Error('interpreter is gone');
			});
			queuePath(obj, '/', { arm: false });
		});
		const win = await openWindow(site, { maxFills: 4 });
		const outcomes = win.outcomes;
		expect(win.stopped).toBe('error');
		expect(outcomes[0]?.ok).toBe(false);
		expect(String(outcomes[0]?.error)).toContain('interpreter is gone');
		// the row survives, so the three-strike count still governs the path
		const depth = await inObject(namedSite(site), (obj) => obj.queueDepth());
		expect(depth).toBe(1);
	});
});

// #region TEMPORARY assertion counter
import { afterAll as __afterAll, afterEach as __afterEach } from 'vitest';
let __asserts = 0;
__afterEach(() => {
	__asserts += expect.getState().assertionCalls ?? 0;
});
__afterAll(() => {
	console.log(`ASSERTIONS tests/integration/warm-window.spec.ts ${__asserts}`);
});
// #endregion

/**
 * The daily rows meter, which is the only meter on the Limits page with a real counter.
 *
 * Two things make this correct rather than merely present, and both are load-bearing: the flush
 * happens ONCE PER ALARM (per-write would double the number it measures, since persisting costs a
 * row), and the total is keyed by UTC DATE (an object is evicted whenever Cloudflare likes, so an
 * in-memory lifetime counter reports a fraction of the day and reads as healthy).
 */
describe('the daily rows-written meter', () => {
	it('accumulates writes and folds them in on flush', async () => {
		const got = await inObject(freshSite(), (site) => {
			site.ensureServeTables();
			const before = site.dailyRows();
			site.sql.exec("INSERT INTO cfw_meta (k, v) VALUES ('probe', '1')");
			const pending = site.dailyRows();
			const flushed = site.flushDailyRows();
			return { before, pending, flushed };
		});
		// the write is visible before the flush, because dailyRows() adds what has not landed yet
		expect(got.pending).toBeGreaterThan(got.before);
		expect(got.flushed).toBeGreaterThanOrEqual(got.pending);
	});

	it('COUNTS ITS OWN FLUSH, so the meter does not exclude itself', async () => {
		const got = await inObject(freshSite(), (site) => {
			site.ensureServeTables();
			site.flushDailyRows();
			const afterFirst = site.dailyRows();
			// no other write between these two flushes; the only thing that happened is the
			// first flush's own row
			site.flushDailyRows();
			return { afterFirst, afterSecond: site.dailyRows() };
		});
		expect(got.afterSecond).toBeGreaterThan(got.afterFirst);
	});

	it('is a NO-OP when nothing was written, so a quiet alarm costs no row', async () => {
		const got = await inObject(freshSite(), (site) => {
			site.ensureServeTables();
			// zero the accumulator FIRST, so the two flushes below have genuinely nothing
			// between them. Flushing to read a baseline would not work: the flush's own
			// metaSet is a write, so it refills the accumulator it just drained.
			site.rowsSinceFlush = 0;
			const settled = site.flushDailyRows();
			site.rowsSinceFlush = 0;
			const again = site.flushDailyRows();
			return { settled, again };
		});
		// a firing that wrote nothing must not spend a row to say so
		expect(got.again).toBe(got.settled);
	});

	it('keys the total by UTC DATE, so an eviction cannot lose the day', async () => {
		const day = Date.UTC(2026, 7, 13, 12, 0, 0);
		const nextDay = Date.UTC(2026, 7, 14, 12, 0, 0);
		const got = await inObject(freshSite(), (site) => {
			site.ensureServeTables();
			site.rowsSinceFlush = 100;
			const today = site.flushDailyRows(day);
			site.rowsSinceFlush = 5;
			const tomorrow = site.flushDailyRows(nextDay);
			return { today, tomorrow, backToToday: site.dailyRows(day) };
		});
		expect(got.today).toBe(100);
		// a new day starts from its own total rather than inheriting yesterday's
		expect(got.tomorrow).toBe(5);
		// and yesterday's row is still there, which is what makes a trend readable
		expect(got.backToToday).toBeGreaterThanOrEqual(100);
	});

	it('survives a NEW instance for the same site, which is the eviction case', async () => {
		const site = namedSite('rows-meter-survives');
		const day = Date.UTC(2026, 7, 13, 12, 0, 0);
		await inObject(site, (s) => {
			s.ensureServeTables();
			s.rowsSinceFlush = 250;
			s.flushDailyRows(day);
		});
		// a separate JS instance reaching the same durable storage
		const seen = await inObject(site, (s) => s.dailyRows(day));
		expect(seen).toBeGreaterThanOrEqual(250);
	});
});
