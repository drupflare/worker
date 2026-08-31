import { describe, expect, it } from 'vitest';
import { freshSite, inObject, markProvisioned, type ServeDo } from '../helpers/serve-do';

/**
 * That the limit counter is actually reached by the request path.
 *
 * The unit spec covers the classification; this covers the wiring, which is the half a passing unit
 * spec says nothing about. A classifier imported by its own test and by nothing under `src/` counts
 * every limit correctly and is absent from every deployed site.
 *
 * What it cannot do is make a real ceiling fire. A subrequest limit or an isolate memory kill is not
 * reproducible in this lane, so the assertion is that an ordinary throw reaches the tally and is
 * counted as ORDINARY -- an instrument that reported a platform ceiling for every application bug
 * would be worse than none on a site with a broken module.
 */

const TIMEOUT = 120_000;

type Stats = {
	limits: { tally: Record<string, number>; hitAny: boolean };
};

async function stats(site: ServeDo): Promise<Stats> {
	const res = await site.fetch(new Request('https://do.local/__serve-stats'));
	expect(res.status, await res.clone().text()).toBe(200);
	return (await res.json()) as Stats;
}

describe('a failed request reaches the limit tally', () => {
	it(
		'counts a throw out of the gated lane and calls it ordinary',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				const before = await stats(site);

				// a body that is not JSON, so `request.json()` throws inside handle()
				let threw = '';
				try {
					await site.fetch(
						new Request('https://do.local/__replica?action=apply', {
							method: 'POST',
							body: 'not json at all',
							headers: { 'content-type': 'application/json' }
						})
					);
				} catch (e) {
					threw = String((e as Error)?.message ?? e);
				}
				return { before, threw, after: await stats(site) };
			});

			// the control: a request that did not throw would leave the tally still for the right
			// reason and the wrong one at the same time
			expect(out.threw).not.toBe('');
			expect(out.before.limits.tally.other ?? 0).toBe(0);
			expect(out.after.limits.tally.other).toBe(1);
			// an application exception is not a platform ceiling
			expect(out.after.limits.hitAny).toBe(false);
		},
		TIMEOUT
	);

	it(
		'reports an empty tally on an object that has not failed',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				await site.fetch(new Request('https://do.local/__replica'));
				return stats(site);
			});

			// an empty tally is the answer to "does a ceiling appear in the request path", and it is
			// only an answer because the case above proves the counter can move
			expect(out.limits.tally).toEqual({});
			expect(out.limits.hitAny).toBe(false);
		},
		TIMEOUT
	);
});
