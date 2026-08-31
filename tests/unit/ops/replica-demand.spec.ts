import { describe, expect, it } from 'vitest';
import {
	autoScaleEnabled,
	DEFAULT_MAX_LANES,
	DEMAND_HISTORY,
	laneTarget,
	maxLanes,
	nextLaneToProvision,
	recordWindow,
	SUSTAIN_WINDOWS
} from '../../../src/ops/replica-demand';

const w = (peakInflight: number, at = 0) => ({ peakInflight, at });
const flat = (peak: number, n = SUSTAIN_WINDOWS) => Array.from({ length: n }, () => w(peak));

describe('how many lanes the demand justifies', () => {
	it('wants none while the object is answering one request at a time', () => {
		expect(laneTarget(flat(1), 3)).toBe(0);
		expect(laneTarget(flat(0), 3)).toBe(0);
	});

	it('wants one lane per concurrent request past the first', () => {
		expect(laneTarget(flat(2), 3)).toBe(1);
		expect(laneTarget(flat(3), 3)).toBe(2);
		expect(laneTarget(flat(4), 3)).toBe(3);
	});

	it('never exceeds the cap', () => {
		expect(laneTarget(flat(30), 3)).toBe(3);
		expect(laneTarget(flat(30), 0)).toBe(0);
	});

	it('refuses a burst, because a lane provisioned by a spike stays warm forever', () => {
		// the minimum across the window, so every window has to have been contended
		expect(laneTarget([w(1), w(1), w(9)], 3)).toBe(0);
		expect(laneTarget([w(9), w(1), w(9)], 3)).toBe(0);
		expect(laneTarget([w(3), w(9), w(3)], 3)).toBe(2);
	});

	it('waits for enough history rather than acting on one window', () => {
		expect(laneTarget([w(8)], 3)).toBe(0);
		expect(laneTarget(flat(8, SUSTAIN_WINDOWS - 1), 3)).toBe(0);
		expect(laneTarget(flat(8, SUSTAIN_WINDOWS), 3)).toBe(3);
	});

	it('reads only the most recent windows, so a site that quietens down stops growing', () => {
		const cooled = [w(9), w(9), w(9), w(1), w(1), w(1)];
		expect(laneTarget(cooled, 3)).toBe(0);
	});

	it('answers 0 for a malformed sample rather than guessing', () => {
		expect(laneTarget([w(3), { peakInflight: NaN, at: 0 }, w(3)], 3)).toBe(0);
	});
});

describe('the history stays bounded', () => {
	it('keeps the newest and drops the oldest', () => {
		let windows = [] as ReturnType<typeof recordWindow>;
		for (let i = 0; i < DEMAND_HISTORY + 4; i++) windows = recordWindow(windows, w(i, i));
		expect(windows).toHaveLength(DEMAND_HISTORY);
		expect(windows.at(-1)?.peakInflight).toBe(DEMAND_HISTORY + 3);
	});
});

describe('the switches', () => {
	it('autoscales unless explicitly off', () => {
		expect(autoScaleEnabled(undefined)).toBe(true);
		expect(autoScaleEnabled({})).toBe(true);
		expect(autoScaleEnabled({ REPLICA_AUTOSCALE: '1' })).toBe(true);
		expect(autoScaleEnabled({ REPLICA_AUTOSCALE: '0' })).toBe(false);
	});

	it('defaults to the routing clamp rather than an invented number', () => {
		// the old default of 3 was standing in for a warming bug, not for a throughput limit:
		// efficiency declines a flat ~5 points per doubling through 48 with no knee
		expect(maxLanes(undefined)).toBe(DEFAULT_MAX_LANES);
		expect(maxLanes({ REPLICA_MAX_LANES: '' })).toBe(DEFAULT_MAX_LANES);
		expect(maxLanes({ REPLICA_MAX_LANES: '1' })).toBe(1);
		expect(maxLanes({ REPLICA_MAX_LANES: '0' })).toBe(0);
		// the router clamps at 32 and so does this, or they would disagree about the same pool
		expect(maxLanes({ REPLICA_MAX_LANES: '99' })).toBe(32);
		expect(DEFAULT_MAX_LANES).toBe(32);
	});
});

describe('which lane to provision next', () => {
	it('asks for the next one up when demand is ahead of the pool', () => {
		expect(nextLaneToProvision({ windows: flat(4), provisioned: 0 })).toBe(1);
		expect(nextLaneToProvision({ windows: flat(4), provisioned: 1 })).toBe(2);
		expect(nextLaneToProvision({ windows: flat(4), provisioned: 2 })).toBe(3);
	});

	it('stops once the pool has caught up with the demand', () => {
		expect(nextLaneToProvision({ windows: flat(4), provisioned: 3 })).toBe(null);
		expect(nextLaneToProvision({ windows: flat(2), provisioned: 1 })).toBe(null);
	});

	it('provisions one lane at a time, so a copy is never started in parallel with itself', () => {
		// demand for 3 with none provisioned still asks for lane 1 only
		expect(nextLaneToProvision({ windows: flat(9), provisioned: 0 })).toBe(1);
	});

	it('does nothing at all when autoscaling is off', () => {
		expect(
			nextLaneToProvision({
				windows: flat(9),
				provisioned: 0,
				env: { REPLICA_AUTOSCALE: '0' }
			})
		).toBe(null);
	});

	it('honours a lowered cap', () => {
		const env = { REPLICA_MAX_LANES: '1' };
		expect(nextLaneToProvision({ windows: flat(9), provisioned: 0, env })).toBe(1);
		expect(nextLaneToProvision({ windows: flat(9), provisioned: 1, env })).toBe(null);
	});

	it('never asks for a lane on a quiet site, which is every site most of the time', () => {
		expect(nextLaneToProvision({ windows: flat(1, DEMAND_HISTORY), provisioned: 0 })).toBe(
			null
		);
		expect(nextLaneToProvision({ windows: [], provisioned: 0 })).toBe(null);
	});
});
