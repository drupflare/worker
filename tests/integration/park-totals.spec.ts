import { describe, expect, it } from 'vitest';
import { freshSite, inObject, queuePath, type ServeDo } from '../helpers/serve-do';

/**
 * The running park tally `/serve-stats` reports, which is the denominator of a cost measurement.
 *
 * ONE PARK IS UNDER THE METER. `cpuTime` is 1 ms granular, so what a park costs can only be read by
 * driving many and dividing -- and the divisor has to be a count of what HAPPENED. The first
 * version of that harness polled `lastPark.trips` once per batch of four renders, which counts one
 * render per four and would have reported a per-park cost four times too high. `parkTotals` is
 * cumulative, so two reads either side of a window subtract to the real count.
 *
 * The falsifying half is the one that matters here: on a build with no `ext/cfwpark` the totals
 * must stay at zero, because `runJsonMaybeParked` short-circuits to `runJson` before any park is
 * driven. A counter that drifted up on an interpreter that cannot park would make every cost
 * reading taken from it an artifact of the instrument.
 */

type Stats = {
	park: { state: string; armed: string[] };
	parkProbed: boolean;
	parkTotals: { runs: number; trips: number; refused: number };
	lastPark: { state: string; trips: number } | null;
};

const stats = async (site: ServeDo): Promise<Stats> =>
	(await (await site.fetch(new Request('https://do.local/__serve-stats'))).json()) as Stats;

describe('the park tally that a cost measurement divides by', () => {
	it('reports a tally from the first read, so zero never means "no such field"', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => stats(site));
		// an absent field reads as 0 through `?? 0` in any consumer, which is indistinguishable
		// from a park that ran and cost nothing -- this project has shipped that exact confusion
		expect(seen.parkTotals).toEqual({ runs: 0, trips: 0, refused: 0 });
	});

	it('stays at zero across real renders when the interpreter cannot park', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
			queuePath(site, '/', { arm: false });
			await site.fetch(new Request('https://do.local/__fill'));
			queuePath(site, '/user/login', { arm: false });
			await site.fetch(new Request('https://do.local/__fill'));
			return stats(site);
		});

		// WHICH BRANCH RAN, printed: the two assert opposite things, so a reader who cannot tell
		// them apart cannot tell a build that parked from one that could not
		console.log(
			`[park-totals] state=${seen.park.state} armed=[${seen.park.armed.join(',')}] ` +
				`runs=${seen.parkTotals.runs} trips=${seen.parkTotals.trips} ` +
				`refused=${seen.parkTotals.refused}`
		);
		if (seen.park.state === 'installed') {
			// this build CAN park, so the renders above drove it and the tally has to have moved
			// with them; `runs` counts calls and `trips` the yields inside them
			expect(seen.parkTotals.runs).toBeGreaterThan(0);
			expect(seen.parkTotals.trips).toBeGreaterThanOrEqual(0);
			expect(seen.parkTotals.refused).toBeLessThanOrEqual(seen.parkTotals.runs);
			return;
		}

		// the shipping gate interpreter today: `parkState()` answered something other than
		// `installed`, so nothing was driven and a non-zero tally could only be invented
		expect(seen.parkProbed).toBe(true);
		expect(seen.parkTotals).toEqual({ runs: 0, trips: 0, refused: 0 });
		expect(seen.lastPark).toBeNull();
	});
});
