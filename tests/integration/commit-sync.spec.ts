import { describe, expect, it, vi } from 'vitest';
import { freshSite, inObject, tick, type ServeDo } from '../helpers/serve-do';

/**
 * COMMIT_SYNC: with the flag on, the object awaits a storage sync before it returns the reply.
 *
 * `/__writemark` answers from the owner routes inside `route()`, so the request goes through the
 * same `fetchRequest()` hook the flag sits in and needs no provisioned site.
 */

const probe = (obj: ServeDo) => obj.fetch(new Request('https://do.local/__writemark'));

describe('COMMIT_SYNC', () => {
	it('leaves the reply alone when the flag is unset', async () => {
		const calls = await inObject(freshSite(), async (obj) => {
			const sync = vi.spyOn(obj.storage, 'sync');
			await probe(obj);
			return sync.mock.calls.length;
		});
		expect(calls).toBe(0);
	});

	it('leaves the reply alone for any value other than 1', async () => {
		const calls = await inObject(freshSite(), async (obj) => {
			obj.env.COMMIT_SYNC = '0';
			const sync = vi.spyOn(obj.storage, 'sync');
			await probe(obj);
			return sync.mock.calls.length;
		});
		expect(calls).toBe(0);
	});

	it('syncs once, and the reply is not returned until the sync settles', async () => {
		const order: string[] = [];
		const out = await inObject(freshSite(), async (obj) => {
			obj.env.COMMIT_SYNC = '1';
			vi.spyOn(obj.storage, 'sync').mockImplementation(async () => {
				await tick(20);
				order.push('synced');
			});
			const res = await probe(obj);
			order.push('replied');
			return res.status;
		});
		expect(out).toBe(404);
		expect(order).toEqual(['synced', 'replied']);
	});

	it('completes against the real storage sync', async () => {
		const status = await inObject(freshSite(), async (obj) => {
			obj.env.COMMIT_SYNC = '1';
			return (await probe(obj)).status;
		});
		expect(status).toBe(404);
	});

	it('does not swallow a failed sync, so the caller gets the error and no reply', async () => {
		const message = await inObject(freshSite(), async (obj) => {
			obj.env.COMMIT_SYNC = '1';
			vi.spyOn(obj.storage, 'sync').mockRejectedValueOnce(new Error('sync refused'));
			try {
				await probe(obj);
				return 'replied';
			} catch (e) {
				return (e as Error).message;
			}
		});
		expect(message).toBe('sync refused');
	});
});
