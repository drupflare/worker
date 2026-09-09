import { describe, expect, it } from 'vitest';
import {
	SUSTAIN_WINDOWS,
	laneTarget,
	meanWaitMs,
	type DemandWindow
} from '../../../src/ops/replica-demand';

/**
 * Sizing the pool from QUEUEING rather than from concurrency.
 *
 * The replica work established the fact this rests on: replicas remove queueing, not service time.
 * A site with 100 req/s of cached traffic has requests in the object at once and nobody waiting, so
 * inflight peak provisions lanes for load that never queued; a site with 20 req/s of authenticated
 * renders may need several. `peakInflight` was only ever a proxy, and `laneTimings` was already
 * recording the real thing and being read for reporting alone.
 */

const at = 1_000_000;

const windows = (each: Partial<DemandWindow>, n = SUSTAIN_WINDOWS): DemandWindow[] =>
	Array.from({ length: n }, (_, i) => ({
		peakInflight: 0,
		at: at + i,
		...each
	}));

describe('the lane target', () => {
	it('provisions nothing on a history too short to be sustained', () => {
		expect(laneTarget(windows({ queued: 5 }, SUSTAIN_WINDOWS - 1), 8)).toBe(0);
	});

	it('provisions nothing when nothing queued, however busy the object was', () => {
		// THE WHOLE POINT. Eight concurrent cached hits are eight requests a single object serves
		// without anybody waiting, and the inflight proxy would have asked for seven lanes
		const busy = windows({ peakInflight: 8, queued: 0, waitedMs: 0 });
		expect(laneTarget(busy, 8)).toBe(0);
	});

	it('provisions a lane per sustained waiter', () => {
		expect(laneTarget(windows({ peakInflight: 3, queued: 2, waitedMs: 40 }), 8)).toBe(2);
	});

	it('takes the MINIMUM across the windows, so one burst cannot provision a lane', () => {
		const spiky: DemandWindow[] = [
			{ peakInflight: 9, at, queued: 9, waitedMs: 90 },
			{ peakInflight: 1, at: at + 1, queued: 0, waitedMs: 0 },
			{ peakInflight: 9, at: at + 2, queued: 9, waitedMs: 90 }
		];
		expect(laneTarget(spiky, 8)).toBe(0);
	});

	it('is capped, whatever the queue said', () => {
		expect(laneTarget(windows({ queued: 100 }), 4)).toBe(4);
		expect(laneTarget(windows({ queued: 100 }), 0)).toBe(0);
	});

	it('falls back to the inflight proxy on a window recorded before queueing existed', () => {
		// a window without the field is still a window; discarding it would make an upgrade look
		// like a quiet site
		const legacy = windows({ peakInflight: 4 });
		expect(laneTarget(legacy, 8)).toBe(3);
	});

	it('does not mix the two, which would double-count one window', () => {
		const mixed: DemandWindow[] = [
			{ peakInflight: 4, at, queued: 1 },
			{ peakInflight: 4, at: at + 1 },
			{ peakInflight: 4, at: at + 2, queued: 1 }
		];
		// one window lacks the measurement, so the whole decision takes the proxy
		expect(laneTarget(mixed, 8)).toBe(3);
	});

	it('refuses a non-finite queue rather than treating it as zero', () => {
		const broken = windows({ queued: Number.NaN });
		expect(laneTarget(broken, 8)).toBe(0);
	});
});

describe('the wait a lane would remove', () => {
	it('is null when nothing queued, rather than zero', () => {
		// zero would read as "a lane removes no wait", which is a different claim from "nothing has
		// waited yet"
		expect(meanWaitMs(windows({ queued: 0, waitedMs: 0 }))).toBeNull();
		expect(meanWaitMs([])).toBeNull();
	});

	it('weights by waiters rather than by windows', () => {
		const uneven: DemandWindow[] = [
			{ peakInflight: 2, at, queued: 1, waitedMs: 100 },
			{ peakInflight: 2, at: at + 1, queued: 3, waitedMs: 30 }
		];
		// 130 ms over 4 waiters, not the mean of 100 and 10
		expect(meanWaitMs(uneven)).toBeCloseTo(32.5, 6);
	});

	it('treats an absent duration as zero, because the clock is a floor here', () => {
		// the clock does not advance across synchronous PHP, so a wait that spanned no I/O reads 0
		expect(meanWaitMs([{ peakInflight: 2, at, queued: 2 }])).toBe(0);
	});
});
