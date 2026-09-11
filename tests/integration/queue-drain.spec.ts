import { describe, expect, it } from 'vitest';
import { freshSite, inObject, queuePath, type ServeDo } from '../helpers/serve-do';

/**
 * The fill queue's only recovery lever.
 *
 * A queue deeper than one batch can survive resets the isolate INSIDE the alarm. The reset does not
 * shrink the queue, so the next alarm attempts the same batch and the object never serves again --
 * measured on a deployed free worker at 103 entries and 70 stored pages, every render answering 500
 * across three redeploys. `recycleIfOversized()` cannot reach it, because it runs BETWEEN
 * invocations and the death is inside one.
 *
 * Until this route existed an operator had nothing: `queue-list` reports the depth and no host
 * surface could change it.
 */

const queue = async (site: ServeDo, query: string) =>
	(await (await site.fetch(new Request(`https://do.local/__queue${query}`))).json()) as {
		ok: boolean;
		depth?: number;
		before?: number;
		dropped?: number;
		after?: number;
		error?: string;
		queue?: Array<{ path: string }>;
	};

describe('draining the fill queue', () => {
	it('lists what is queued and how deep it is', async () => {
		const out = await inObject(freshSite(), async (site) => {
			for (const path of ['/a', '/b', '/c']) queuePath(site, path, { arm: false });
			return queue(site, '?action=list');
		});
		expect(out.ok).toBe(true);
		expect(out.depth).toBe(3);
		expect(out.queue?.map((r) => r.path).sort()).toEqual(['/a', '/b', '/c']);
	});

	it('drops the whole queue when no count is given, and reports the before and after', async () => {
		const out = await inObject(freshSite(), async (site) => {
			for (const path of ['/a', '/b', '/c']) queuePath(site, path, { arm: false });
			const dropped = await queue(site, '?action=drop');
			return { dropped, depth: site.queueDepth() };
		});
		expect(out.dropped.before).toBe(3);
		expect(out.dropped.dropped).toBe(3);
		expect(out.dropped.after).toBe(0);
		// the route's report and the object's own count agree; a report that drifted from the table
		// would be the operator's only signal and would be wrong at the moment it mattered most
		expect(out.depth).toBe(0);
	});

	it('sheds only the count it is given, so the rest of the work stays queued', async () => {
		// the case this serves: get under the batch size without discarding a site's whole backlog
		const out = await inObject(freshSite(), async (site) => {
			for (const path of ['/a', '/b', '/c', '/d']) queuePath(site, path, { arm: false });
			const dropped = await queue(site, '?action=drop&n=2');
			return { dropped, remaining: (await queue(site, '?action=list')).queue ?? [] };
		});
		expect(out.dropped.dropped).toBe(2);
		expect(out.dropped.after).toBe(2);
		expect(out.remaining).toHaveLength(2);
	});

	it('refuses an action it does not know rather than doing the destructive one', async () => {
		// `drop` is the only mutating action here and an unknown string must never reach it
		const out = await inObject(freshSite(), async (site) => {
			for (const path of ['/a', '/b']) queuePath(site, path, { arm: false });
			const refused = await queue(site, '?action=clear');
			return { refused, depth: site.queueDepth() };
		});
		expect(out.refused.ok).toBe(false);
		expect(out.refused.error).toContain('unknown action');
		expect(out.depth).toBe(2);
	});

	it('drops nothing and reports zero on an empty queue', async () => {
		const out = await inObject(freshSite(), async (site) => queue(site, '?action=drop'));
		expect(out.ok).toBe(true);
		expect(out.before).toBe(0);
		expect(out.dropped).toBe(0);
	});
});
