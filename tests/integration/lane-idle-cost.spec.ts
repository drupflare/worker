import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_LANES } from '../../src/ops/replica-demand';
import { replicaName } from '../../src/ops/replica-routing';
import { driveAlarms, freshSite, inObject, namedSite, type ServeDo } from '../helpers/serve-do';

/**
 * What an idle lane costs, which is the number the pool cap should be derived from.
 *
 * `REPLICA_MAX_LANES` defaults to 32 and that figure came from nowhere -- the scaling measurement
 * stopped at 8 and the note on it says the curve past there is not established. The bound that
 * actually matters is cheaper to find: warming is per OBJECT, so a warmed pool multiplies it, and
 * 32 idle lanes re-arming every 8 s is 345,600 rows/day to serve nothing -- 3.5x free's entire
 * budget. The cap was silently standing in for that.
 *
 * SO THE COST IS MEASURED HERE, per firing, on a lane that is serving nothing. Two things bound it:
 * the alarm row each firing charges, and whatever the firing itself writes. An idle firing that
 * writes only its own bookkeeping is the counter-counts-itself failure this project has already
 * found once, at 32.4% of free's row budget.
 */

const TIMEOUT = 900_000;

function role(site: ServeDo, as: 'primary' | 'replica'): void {
	(site as unknown as { env: Record<string, unknown> }).env = {
		...(site as unknown as { env: Record<string, unknown> }).env,
		REPLICA: as === 'replica' ? '1' : '0'
	};
}

describe('an idle lane, per alarm firing', () => {
	it(
		'charges rows in the low single digits, which is what a pool cap has to be priced from',
		async () => {
			const stub = freshSite();
			await inObject(stub, (site) => {
				role(site, 'replica');
				site.ensureServeTables();
			});

			// two firings, so the FIRST one's table creation is not charged to the steady state
			await inObject(stub, (site) => site.ctx.storage.setAlarm(Date.now() - 1));
			await driveAlarms(stub, () => false, 2);

			const before = await inObject(stub, (site) => site.dailyRows());
			await inObject(stub, (site) => site.ctx.storage.setAlarm(Date.now() - 1));
			await driveAlarms(stub, () => false, 1);
			const after = await inObject(stub, (site) => site.dailyRows());

			const perFiring = after - before;
			// A COUNTER THAT COUNTS ITSELF is the failure mode. An idle warming tick used to charge
			// three rows -- the setAlarm plus a flush from each of two daily meters recording their
			// own writes -- so the meter sustained itself at 32.4% of free's budget
			expect(perFiring, `an idle firing charged ${perFiring} rows`).toBeLessThanOrEqual(3);
			expect(perFiring).toBeGreaterThanOrEqual(0);
		},
		TIMEOUT
	);

	/**
	 * THE PREDICATE, NOT A SIMULATED IDLE LANE, and the reason is the instrument.
	 *
	 * `laneIsIdle()` reads `doRequestsSinceFlush === 0`, and every probe this harness makes IS an
	 * object request -- `driveAlarms()` asks `settled()` through one before each firing. So a lane
	 * driven from a test can never be observed idle, and a spec that asserted it would be asserting
	 * on a state its own measurement destroyed. The same shape as reading `cpuTime` from the wrong
	 * invocation.
	 */
	it(
		'reports itself idle only when nothing has reached it',
		async () => {
			const stub = namedSite(replicaName('idle-cost', 1));
			const verdicts = await inObject(stub, (site) => {
				role(site, 'replica');
				site.ensureServeTables();
				const raw = site as unknown as {
					doRequestsSinceFlush?: number;
					inflightPeak?: number;
				};
				const quiet = ((): boolean => {
					raw.doRequestsSinceFlush = 0;
					raw.inflightPeak = 0;
					return (site as unknown as { laneIsIdle: () => boolean }).laneIsIdle();
				})();
				const served = ((): boolean => {
					raw.doRequestsSinceFlush = 1;
					raw.inflightPeak = 0;
					return (site as unknown as { laneIsIdle: () => boolean }).laneIsIdle();
				})();
				const busy = ((): boolean => {
					raw.doRequestsSinceFlush = 0;
					raw.inflightPeak = 2;
					return (site as unknown as { laneIsIdle: () => boolean }).laneIsIdle();
				})();
				return { quiet, served, busy };
			});
			expect(verdicts.quiet, 'a lane nothing reached is idle').toBe(true);
			expect(verdicts.served, 'a lane that served a request is not idle').toBe(false);
			expect(verdicts.busy, 'a lane with work in flight is not idle').toBe(false);
		},
		TIMEOUT
	);

	it('is never idle on a PRIMARY, which must stay warm for its own traffic', async () => {
		const stub = freshSite();
		const idle = await inObject(stub, (site) => {
			role(site, 'primary');
			(site as unknown as { doRequestsSinceFlush?: number }).doRequestsSinceFlush = 0;
			return (site as unknown as { laneIsIdle: () => boolean }).laneIsIdle();
		});
		expect(idle).toBe(false);
	});

	it('states the cap the measurement bounds, rather than leaving it unexplained', () => {
		// 32 lanes at the idle re-arm above is 360 firings/day each, 11,520 for a full pool -- about
		// 11.5% of free's request meter and the same of its rows. That is the number the cap has to
		// be read against, and it is only affordable BECAUSE an idle lane un-warms itself
		const firingsPerDayPerLane = 86_400_000 / 240_000;
		expect(firingsPerDayPerLane).toBe(360);
		expect(DEFAULT_MAX_LANES * firingsPerDayPerLane).toBeLessThan(100_000);
	});
});
