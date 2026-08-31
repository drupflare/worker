import { describe, expect, it } from 'vitest';
import {
	freshSite,
	inObject,
	markProvisioned,
	stubRender,
	tick,
	type ServeDo
} from '../helpers/serve-do';

/**
 * The queueing signal a replica pool is sized from.
 *
 * A Durable Object is single-threaded, so every gated request either runs immediately or waits on
 * another. `ahead` counts the ones it waits behind, at arrival, with no clock in it. That count is
 * what a second execution lane removes, and it is the input to
 * `arrival rate x service time / target utilisation`.
 *
 * **The two durations beside it are floors and the spec asserts them as floors.** The wall clock
 * only advances during I/O, so a `Date.now()` delta around a synchronous `php._run()` reads zero:
 * a deployed cold fill once reported 117 ms for 1,398 ms of `cpuTime`. A test that asserted
 * `serviceMs > 0` would therefore be asserting that the render did I/O, not that it took time, and
 * would pass or fail for the wrong reason. So the durations are only checked for coherence
 * (non-negative, ordered) and the load-bearing assertions are all on the counts.
 *
 * Driven with a STUBBED renderer: the subject is the gate, not Drupal, and a stub makes the
 * concurrency deterministic instead of dependent on how long a real render happens to take.
 */

const TIMEOUT = 120_000;

type Lane = {
	samples: number;
	aheadMean: number;
	aheadMax: number;
	queuedFraction: number;
	queueMsFloorMean: number;
	serviceMsFloorMean: number;
};

async function laneOf(site: ServeDo): Promise<Lane> {
	const res = await site.fetch(new Request('https://do.local/__serve-stats'));
	return ((await res.json()) as Record<string, unknown>).lane as Lane;
}

/** the gated lane, forced: `lane=gate` refuses the storage fast path */
const gated = (path: string) =>
	new Request(`https://do.local/__serve?lane=gate&path=${encodeURIComponent(path)}`);

describe('the gated lane reports what it queued behind', () => {
	it(
		'counts nothing ahead when requests arrive one at a time',
		async () => {
			const lane = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				stubRender(site, ({ path }) => ({ status: 200, html: `<p>${path}</p>` }));
				for (const path of ['/a', '/b', '/c']) await site.fetch(gated(path));
				return laneOf(site);
			});

			expect(lane.samples).toBeGreaterThanOrEqual(3);
			expect(lane.aheadMax).toBe(0);
			expect(lane.queuedFraction).toBe(0);
		},
		TIMEOUT
	);

	it(
		'counts the ones a concurrent request waited behind',
		async () => {
			const lane = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				// a renderer that yields, so the gate holds the later arrivals rather than
				// completing each before the next is issued
				stubRender(site, async ({ path }) => {
					await tick(3);
					return { status: 200, html: `<p>${path}</p>` };
				});
				await Promise.all(['/p', '/q', '/r', '/s'].map((path) => site.fetch(gated(path))));
				return laneOf(site);
			});

			// FOUR AT ONCE ON A SINGLE-THREADED OBJECT: the first finds nothing ahead and the rest
			// find someone. Asserted as "someone waited" rather than an exact 0,1,2,3, because the
			// scheduler decides how much of the batch is issued before the first completes
			expect(lane.aheadMax).toBeGreaterThan(0);
			expect(lane.queuedFraction).toBeGreaterThan(0);
			expect(lane.aheadMean).toBeGreaterThan(0);
		},
		TIMEOUT
	);

	it(
		'reports durations as coherent floors rather than as service times',
		async () => {
			const lane = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				stubRender(site, ({ path }) => ({ status: 200, html: `<p>${path}</p>` }));
				await site.fetch(gated('/only'));
				return laneOf(site);
			});

			// never negative and never NaN, which is all a frozen clock lets anyone claim. A
			// `toBeGreaterThan(0)` here would be asserting that the render did I/O
			expect(lane.queueMsFloorMean).toBeGreaterThanOrEqual(0);
			expect(lane.serviceMsFloorMean).toBeGreaterThanOrEqual(0);
			expect(Number.isFinite(lane.queueMsFloorMean)).toBe(true);
			expect(Number.isFinite(lane.serviceMsFloorMean)).toBe(true);
		},
		TIMEOUT
	);

	it(
		'stamps the split on the response so a client can aggregate it',
		async () => {
			const headers = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				stubRender(site, ({ path }) => ({ status: 200, html: `<p>${path}</p>` }));
				const res = await site.fetch(gated('/stamped'));
				return {
					ahead: res.headers.get('x-cfw-gate-ahead'),
					queue: res.headers.get('x-cfw-queue-ms-floor'),
					service: res.headers.get('x-cfw-service-ms-floor'),
					status: res.status
				};
			});

			// the stamping must not have cost the response its status or body path
			expect(headers.status).toBe(200);
			expect(headers.ahead).toBe('0');
			expect(headers.queue).not.toBeNull();
			expect(headers.service).not.toBeNull();
		},
		TIMEOUT
	);
});
