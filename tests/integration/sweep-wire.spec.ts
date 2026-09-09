import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The sweep, driven through the real object rather than through its planner.
 *
 * `tests/unit/ops/sweep.spec.ts` owns the governor and the ordering as pure logic. This owns the
 * question a unit test cannot ask: does anything call it, and does it survive contact with a real
 * database. `sweepBeat()` swallows its own failure into `lastSweep.error` so a sweep cannot take down
 * the alarm that serves the site, which means a broken sweep and a disabled one report the same
 * silence. This is what separates them.
 *
 * The site is migrated first because enumeration reads `router` and the entity tables, and on an
 * unmigrated site there are none. Without that the assertions would pass on an empty candidate set.
 */

type Payload = Record<string, unknown>;
const ORIGIN = 'https://do.local';
const TIMEOUT = 900_000;

function queueDepth(site: ServeDo): number {
	try {
		return Number(
			site.sql.exec('SELECT COUNT(*) AS n FROM cfw_fill_queue').toArray()[0]?.n ?? 0
		);
	} catch {
		return -1;
	}
}

async function sweepReport(site: ServeDo, run: boolean): Promise<Payload> {
	const url = `${ORIGIN}/__sweep${run ? '?run=1' : ''}`;
	return (await (await site.fetch(new Request(url))).json()) as Payload;
}

describe('the addressable sweep, wired', () => {
	it(
		'is off by default and reports nothing rather than erroring',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
				return await sweepReport(site, true);
			});
			// off is a report of nothing, never an error: an operator who has not opted in must not
			// see a failure on a surface they did not enable
			expect(out.sweep).toBeNull();
			// and it has to SAY it is off. Without this a switched-off sweep and one that found
			// nothing are the same response
			expect(out.ran).toBe(false);
			expect(out.enabled).toBe(false);
			expect(out.skipped).toBe('SWEEP is off');
		},
		TIMEOUT
	);

	it(
		'enumerates and queues real paths when it is turned on',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
				(site.env as Record<string, unknown>).SWEEP = '1';
				const before = queueDepth(site);
				const report = await sweepReport(site, true);
				// a SECOND forced call inside the interval, which must still take a step: `?run=1`
				// is the operator path and waiting out 30 minutes to see one is the wrong answer
				const forced = await sweepReport(site, true);
				return { before, after: queueDepth(site), report, forced };
			});

			// THE CONTROL: a site with no fill-queue table makes the delta meaningless
			expect(
				out.before,
				'no cfw_fill_queue table, so the queue delta says nothing'
			).toBeGreaterThanOrEqual(0);

			const sweep = (out.report as Payload).sweep as Payload | null;
			expect(sweep, 'the sweep reported nothing with SWEEP=1').not.toBeNull();
			// the failure this file exists for: swallowed into `lastSweep.error` and otherwise silent
			expect(sweep?.error ?? null, JSON.stringify(sweep)).toBeNull();

			// it QUEUES, never renders. Whether it queued anything on this pack depends on the
			// governor and the candidate set, so the assertion is that it did not render and did not
			// throw, plus a coverage figure that exists
			expect(typeof sweep?.queued).toBe('number');
			expect(Number(sweep?.queued)).toBeGreaterThanOrEqual(0);
			expect(out.after).toBeGreaterThanOrEqual(out.before as number);
			expect((out.report as Payload).ran).toBe(true);
			expect(
				(out.forced as Payload).ran,
				'a forced call inside the interval did nothing'
			).toBe(true);
		},
		TIMEOUT
	);

	it(
		'reports a refusal with its reason rather than looking like an empty sweep',
		async () => {
			const sweep = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
				const env = site.env as Record<string, unknown>;
				env.SWEEP = '1';
				// spend the day, so the governor's floor is the thing under test rather than an empty
				// candidate set
				const today = new Date(Date.now()).toISOString().slice(0, 10);
				site.sql.exec(
					'INSERT INTO cfw_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
					`rows_written_${today}`,
					'99000'
				);
				const report = await sweepReport(site, true);
				return (report.sweep ?? null) as Payload | null;
			});

			expect(sweep, 'the sweep reported nothing at all').not.toBeNull();
			expect(sweep?.error ?? null).toBeNull();
			// a refusal has to be legible: "it queued nothing" and "it refused because the day is
			// nearly spent" must not read the same
			expect(Number(sweep?.queued ?? 0)).toBe(0);
			expect(String(sweep?.reason ?? ''), JSON.stringify(sweep)).not.toBe('');
		},
		TIMEOUT
	);
});
