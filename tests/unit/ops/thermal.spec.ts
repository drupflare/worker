import { describe, expect, it } from 'vitest';
import {
	ARRIVAL_RING,
	AUTH_WARM_WINDOW_MS,
	BREAK_EVEN_RENDERS_PER_DAY,
	COLD_BOOT_MS,
	RATE_WINDOW_MS,
	WARM_FIRING_COST_MS,
	arrivalProbability,
	foldRenderWindow,
	readRenderWindow,
	recordArrival,
	renderRate,
	routeFamilies,
	warmDecision,
	windowRate,
	writeRenderWindow,
	type Arrival
} from '../../../src/ops/thermal';

/**
 * Warming decided from arrivals rather than from a constant.
 *
 * The band is measured: below about 505 renders/day the alarms cost more than the boots they save,
 * above about 8,640 the site never idles long enough to go cold. A flat 8,000 ms interval is right
 * in the middle of that band and charged at both ends -- 10,800 firings a day whatever the traffic.
 */

const now = 1_000_000_000;
const renders = (n: number, spacingMs = 1000): Arrival[] =>
	Array.from({ length: n }, (_, i) => ({ at: now - i * spacingMs, rendered: true }));

describe('the rate estimate', () => {
	it('is zero with nothing in the window', () => {
		expect(renderRate([], now)).toBe(0);
		expect(renderRate([{ at: now - RATE_WINDOW_MS - 1, rendered: true }], now)).toBe(0);
	});

	it('counts only renders, because a cached hit needs no warm object', () => {
		// a cached page answers off `ctx.storage.sql` without booting PHP, so warming cannot make
		// one faster by any amount
		const mixed: Arrival[] = [
			{ at: now, rendered: false },
			{ at: now - 10, rendered: false },
			{ at: now - 20, rendered: true }
		];
		expect(renderRate(mixed, now)).toBeCloseTo(1 / (RATE_WINDOW_MS / 1000), 8);
	});

	it('divides by the WINDOW rather than by the observed span', () => {
		// ten renders one second apart is a burst, not ten per second. Dividing by the span would
		// read it as a sustained rate, which is how a predictor talks itself into warming a site
		// that had one visitor
		const rate = renderRate(renders(10), now);
		expect(rate).toBeCloseTo(10 / (RATE_WINDOW_MS / 1000), 8);
		expect(rate).toBeLessThan(1);
	});
});

describe('the probability', () => {
	it('is zero at zero rate and rises with it', () => {
		expect(arrivalProbability(0, 10_000)).toBe(0);
		expect(arrivalProbability(0.01, 10_000)).toBeLessThan(arrivalProbability(0.1, 10_000));
	});

	it('saturates at one and never above it', () => {
		// `exp(-1000)` underflows to 0 in float64, so this reaches exactly 1 rather than
		// approaching it -- which is correct as a probability and worth pinning as the ceiling
		expect(arrivalProbability(100, 10_000)).toBe(1);
		expect(arrivalProbability(1e9, 10_000)).toBeLessThanOrEqual(1);
	});

	it('rises with the window as well as with the rate', () => {
		expect(arrivalProbability(0.05, 30_000)).toBeGreaterThan(arrivalProbability(0.05, 10_000));
	});
});

describe('the decision', () => {
	const thresholdMs = 10_000;

	it('refuses on a site with no renders at all', () => {
		const d = warmDecision([], now, { thresholdMs });
		expect(d.warm).toBe(false);
		expect(d.reason).toContain('saves nothing');
	});

	it('refuses at the bottom of the band, where firings outnumber boots', () => {
		// one render in fifteen minutes: P(render in the next 10 s) is tiny, so a firing every 8 s
		// is paying for a boot that is not going to happen
		expect(warmDecision(renders(1), now, { thresholdMs }).warm).toBe(false);
	});

	it('warms once the expected saving covers a firing', () => {
		const busy = renders(400, 2000);
		const d = warmDecision(busy, now, { thresholdMs });
		expect(d.expected).toBeGreaterThan(0);
		expect(d.warm).toBe(true);
	});

	it('is monotonic in the rate, which is what makes it a policy and not a coin', () => {
		let previous = -Infinity;
		for (const n of [0, 1, 5, 20, 60, 200, 600]) {
			const d = warmDecision(renders(n, 1000), now, { thresholdMs });
			expect(d.expected, `n=${n}`).toBeGreaterThanOrEqual(previous);
			previous = d.expected;
		}
	});

	it('crosses at the measured band edge rather than at an invented number', () => {
		// 505 renders/day is the recorded crossing; a constant that moved it would silently un-warm
		// a band the project had already measured as worth warming
		const perSecond = BREAK_EVEN_RENDERS_PER_DAY / 86_400;
		const p = arrivalProbability(perSecond, 10_000);
		expect(p * COLD_BOOT_MS).toBeCloseTo(WARM_FIRING_COST_MS, 0);
	});

	it('breaks even exactly where the two costs meet', () => {
		// the crossing is P = WARM_FIRING_COST_MS / COLD_BOOT_MS; asserted so a change to either
		// constant moves the policy rather than silently keeping it
		const crossing = WARM_FIRING_COST_MS / COLD_BOOT_MS;
		expect(crossing).toBeGreaterThan(0);
		expect(crossing).toBeLessThan(1);
		const d = warmDecision(renders(600, 1000), now, { thresholdMs });
		expect(d.warm).toBe(d.probability > crossing);
	});

	it('never overrides what an operator stated, in either direction', () => {
		expect(warmDecision([], now, { thresholdMs, forced: true }).warm).toBe(true);
		expect(warmDecision(renders(600), now, { thresholdMs, forced: false }).warm).toBe(false);
	});
});

/**
 * An active session, which the rate estimate cannot see.
 *
 * Measured on the VPS comparison rig: an authenticated page is 31 ms on a warm object and 513 ms on
 * a cold one. An editor working on a quiet site produces a render rate far below the 505/day
 * crossing while producing exactly the requests that gap applies to, so the rate is the wrong
 * predictor for them.
 */
describe('warming while somebody is signed in', () => {
	const thresholdMs = 10_000;

	it('warms on a quiet site that an editor is working on', () => {
		// the control: one render in the window, which the rate arm refuses on its own terms
		expect(warmDecision(renders(1), now, { thresholdMs }).warm).toBe(false);
		const d = warmDecision(renders(1), now, { thresholdMs, lastAuthenticatedAt: now - 60_000 });
		expect(d.warm).toBe(true);
		expect(d.reason).toContain('session is active');
	});

	it('stops paying once the window has passed, rather than latching', () => {
		const stale = now - AUTH_WARM_WINDOW_MS - 1;
		expect(
			warmDecision(renders(1), now, { thresholdMs, lastAuthenticatedAt: stale }).warm
		).toBe(false);
	});

	it('still loses to an explicit SITE_WARM=0', () => {
		// an operator who said no meant no; a predictor may never overturn that
		const d = warmDecision(renders(1), now, {
			thresholdMs,
			forced: false,
			lastAuthenticatedAt: now
		});
		expect(d.warm).toBe(false);
	});

	it('costs a bounded number of firings, which is what makes it affordable', () => {
		// 30 minutes at the 8 s re-arm is 225 firings, 225 requests and 225 rows, once per session
		const firings = AUTH_WARM_WINDOW_MS / 8_000;
		expect(firings).toBe(225);
		expect(firings).toBeLessThan(1000);
	});

	it('is never armed by a request Drupal answered as anonymous', () => {
		// the signal comes from the uid Drupal reported, so a stale cookie cannot arm it; this pins
		// the null path the caller uses for an anonymous render
		expect(warmDecision(renders(1), now, { thresholdMs, lastAuthenticatedAt: null }).warm).toBe(
			false
		);
	});
});

describe('the arrival ring', () => {
	it('keeps the newest and drops the oldest', () => {
		let ring: Arrival[] = [];
		for (let i = 0; i < ARRIVAL_RING + 10; i++) {
			ring = recordArrival(ring, { at: now + i, rendered: true });
		}
		expect(ring).toHaveLength(ARRIVAL_RING);
		expect(ring[0]?.at).toBe(now + 10);
	});

	it('costs no rows, which is why it is a ring at all', () => {
		// a `hits` column would spend the rows-written meter to decide how to save it
		expect(ARRIVAL_RING).toBeLessThanOrEqual(256);
	});
});

describe('prewarming a route family rather than a URL', () => {
	it('collapses paths to one representative per family', () => {
		// a visitor arriving on `/node/41` after a save meets a cold OBJECT even though `/node/40`
		// is in the page cache; warming one member warms the interpreter every member needs
		expect(routeFamilies(['/node/1', '/node/2', '/node/3'])).toEqual(['/node/1']);
	});

	it('keeps distinct families apart', () => {
		expect(routeFamilies(['/node/1', '/blog/x', '/node/2', '/about'])).toEqual([
			'/node/1',
			'/blog/x',
			'/about'
		]);
	});

	it('treats the front page as its own family', () => {
		expect(routeFamilies(['/'])).toEqual(['/']);
	});

	it('drops a query string, so two views of one page are one family', () => {
		expect(routeFamilies(['/node/1?page=2', '/node/1'])).toEqual(['/node/1']);
	});

	it('ignores anything that is not a path', () => {
		expect(routeFamilies(['node/1', '', 'https://x/y'])).toEqual([]);
	});

	it('is bounded, because prewarming is a cost as well as a saving', () => {
		const many = Array.from({ length: 20 }, (_, i) => `/f${i}/x`);
		expect(routeFamilies(many, 4)).toHaveLength(4);
	});
});

/**
 * The window that survives a hibernation.
 *
 * THE RATE BRANCH COULD NOT FIRE IN THE BAND IT WAS BUILT FOR. Between 505 and 8,640 renders/day the
 * object hibernates between renders, so the in-memory ring was empty on every wake, `renderRate()`
 * answered 0, and `warmDecision()` took its "no render in the window" branch every time. Above the
 * band the site never idles and does not need the branch; below it, warming is correctly declined.
 * So the one range the decision exists for was the one range it could not reach.
 */
describe('the render window that outlives an incarnation', () => {
	const NOW = 1_700_000_000_000;

	it('round trips through the packed meta value', () => {
		const window = { startedAt: NOW, renders: 12 };
		expect(readRenderWindow(writeRenderWindow(window))).toEqual(window);
	});

	it.each([null, undefined, '', 'nonsense', '123', 'a:b', '-1:4', `${NOW}:-2`])(
		'reads %p as nothing stored rather than as a rate',
		(value) => {
			// a malformed value must not become a rate; the failure mode is warming every site
			expect(readRenderWindow(value)).toBeNull();
		}
	);

	it('divides by the WINDOW, not by how long the bucket has been open', () => {
		// a bucket three seconds old holding two renders is not 0.67 renders/second, and reading it
		// that way is how a burst talks a predictor into warming a site that had one visitor
		const rate = windowRate({ startedAt: NOW - 3_000, renders: 2 }, NOW);
		expect(rate).toBeCloseTo(2 / (RATE_WINDOW_MS / 1000), 10);
	});

	it('answers zero for a window that has aged out', () => {
		expect(windowRate({ startedAt: NOW - RATE_WINDOW_MS, renders: 500 }, NOW)).toBe(0);
	});

	it('rolls the bucket rather than accumulating, so last month cannot keep a site warm', () => {
		const old = { startedAt: NOW - RATE_WINDOW_MS - 1, renders: 900 };
		expect(foldRenderWindow(old, 1, NOW)).toEqual({ startedAt: NOW, renders: 1 });
	});

	it('folds into an open bucket without moving its start', () => {
		const open = { startedAt: NOW - 1_000, renders: 4 };
		expect(foldRenderWindow(open, 3, NOW)).toEqual({ startedAt: NOW - 1_000, renders: 7 });
	});

	it('starts a bucket when nothing is stored', () => {
		expect(foldRenderWindow(null, 2, NOW)).toEqual({ startedAt: NOW, renders: 2 });
	});

	/** the pair that is the whole point: the same site, decided with and without the survivor */
	it('warms a site in the band after a hibernation, which the ring alone could not', () => {
		// a rate comfortably inside the measured band, arriving as a stored window because the ring
		// died with the previous incarnation
		const renders = Math.round((BREAK_EVEN_RENDERS_PER_DAY * 4 * RATE_WINDOW_MS) / 86_400_000);
		const stored = { startedAt: NOW - 1_000, renders };

		const withoutIt = warmDecision([], NOW, { thresholdMs: 10_000 });
		expect(withoutIt.warm, 'the empty ring must be what refused, or this proves nothing').toBe(
			false
		);
		expect(withoutIt.reason).toContain('no render in the window');

		const withIt = warmDecision([], NOW, { thresholdMs: 10_000, stored });
		expect(withIt.warm).toBe(true);
		expect(withIt.rate).toBeGreaterThan(0);
		expect(withIt.expected).toBeGreaterThan(0);
	});

	it('still declines below the crossing, so the survivor did not just turn warming on', () => {
		// a tenth of the break-even rate; the stored window must not rescue a site that idles
		const renders = Math.max(
			1,
			Math.round((BREAK_EVEN_RENDERS_PER_DAY * 0.1 * RATE_WINDOW_MS) / 86_400_000)
		);
		const decision = warmDecision([], NOW, {
			thresholdMs: 10_000,
			stored: { startedAt: NOW - 1_000, renders }
		});
		expect(decision.warm).toBe(false);
		expect(decision.expected).toBeLessThan(0);
	});

	it('takes the higher of the two, so a warm object is not held down by a stale bucket', () => {
		const busy: Arrival[] = Array.from({ length: 40 }, (_, i) => ({
			at: NOW - i * 1_000,
			rendered: true
		}));
		const fromRing = warmDecision(busy, NOW, { thresholdMs: 10_000 });
		const withStale = warmDecision(busy, NOW, {
			thresholdMs: 10_000,
			stored: { startedAt: NOW - 1_000, renders: 1 }
		});
		expect(withStale.rate).toBe(fromRing.rate);
		expect(withStale.warm).toBe(fromRing.warm);
	});

	it('leaves an explicit SITE_WARM in charge in both directions', () => {
		const stored = { startedAt: NOW - 1_000, renders: 900 };
		expect(warmDecision([], NOW, { thresholdMs: 10_000, forced: false, stored }).warm).toBe(
			false
		);
		expect(warmDecision([], NOW, { thresholdMs: 10_000, forced: true }).warm).toBe(true);
	});
});
