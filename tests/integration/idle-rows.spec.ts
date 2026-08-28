import { describe, expect, it } from 'vitest';
import { freshSite, inObject } from '../helpers/serve-do';

/**
 * The rows an idle site spends before it serves anything.
 *
 * The model prices an idle site at 360 rows/day and the meter reported 0, because `countingSql()`
 * wraps `ctx.storage.sql` and the KV API is not SQL. Driven through the object rather than the
 * proxy: the defect was never in the counter, it was that the writes never reached one.
 */
describe('an idle object charges the rows its alarms cost', () => {
	it('reproduces the model 360/day from the meter', async () => {
		const stub = freshSite();
		const rows = await inObject(stub, async (site) => {
			const before = site.dailyRows();
			// the keep-warm chain: 360 arms is `*/5 * * * *` for 24h at the modelled rate
			for (let i = 0; i < 360; i++) await site.storage.setAlarm(site.nowMs() + 60_000);
			return { before, after: site.dailyRows() };
		});
		expect(rows.after - rows.before).toBe(360);
	});

	it('carries the KV rows across the flush into the persisted day total', async () => {
		// paired arms on two objects, because the flush charges for its own `cfw_meta` write and a
		// bare before/after cannot separate that self-cost from what is being measured
		const arm = async (kvWrites: number) => {
			const stub = freshSite();
			return inObject(stub, async (site) => {
				site.flushDailyRows();
				const base = site.flushDailyRows();
				for (let i = 0; i < kvWrites; i++) await site.storage.setAlarm(site.nowMs() + i);
				return site.flushDailyRows() - base;
			});
		};
		const [idle, arming] = await Promise.all([arm(0), arm(50)]);
		expect(arming - idle).toBe(50);
	});

	it('charges a delete only for what was there', async () => {
		const stub = freshSite();
		const delta = await inObject(stub, async (site) => {
			await site.storage.put('present', 1);
			const before = site.dailyRows();
			await site.storage.delete('absent');
			const missed = site.dailyRows();
			await site.storage.delete('present');
			return { missed: missed - before, hit: site.dailyRows() - missed };
		});
		expect(delta.missed).toBe(0);
		expect(delta.hit).toBe(1);
	});
});
