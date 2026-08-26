import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The point-in-time recovery route.
 *
 * MEASURED 2026-08-24, and it is why the detection is by VALUE. All three methods EXIST in the local
 * runtime: `getBookmarkForTime()` throws "does not implement point-in-time recovery", but
 * `getCurrentBookmark()` answers an ALL-ZERO bookmark instead. A feature-detect on the method passes
 * and a caller would schedule a restore to bookmark zero.
 */

const call = (site: DurableObjectStub, path: string, init?: RequestInit) =>
	site.fetch(new Request(`https://do.local${path}`, init));

const ZERO = '00000000-00000000-00000000-00000000000000000000000000000000';

/** the surface the real platform exposes, so the supported half is reachable from the gate */
function withPitr(obj: ServeDo, bookmarks: Record<string, string> = {}): void {
	const storage = (obj.ctx as unknown as { storage: Record<string, unknown> }).storage;
	storage.getCurrentBookmark = async () => bookmarks.current ?? '0000007b-0000b26e-00001538-0c3e';
	storage.getBookmarkForTime = async (at: Date) => `at-${at.getTime()}`;
	storage.onNextSessionRestoreBookmark = async (b: string) => `undo-of-${b}`;
}

describe('the local runtime, which answers rather than refuses', () => {
	// the whole point: the method is present, so only the VALUE says the log is missing
	it('refuses an all-zero bookmark and reports it', async () => {
		const site = freshSite();
		const body = (await (await call(site, '/__pitr')).json()) as Record<string, unknown>;
		expect(body.ok).toBe(false);
		expect(body.supported).toBe(false);
		expect(body.current, 'the local back end stopped answering zero').toBe(ZERO);
		expect(String(body.error)).toContain('change log');
	});

	it('carries the platform sentence through when the API does throw', async () => {
		const site = freshSite();
		const at = Date.now() - 3_600_000;
		const body = (await (await call(site, `/__pitr?at=${at}`)).json()) as Record<
			string,
			unknown
		>;
		expect(body.supported).toBe(false);
		expect(String(body.error)).toContain('point-in-time recovery');
	});

	it('never schedules a restore against a bookmark it could not have got from here', async () => {
		const site = freshSite();
		const res = await call(site, `/__pitr?bookmark=${ZERO}`, { method: 'POST' });
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok, 'an all-zero bookmark was accepted as a restore point').toBeFalsy();
	});
});

describe('when it is offered', () => {
	it('reports the current bookmark and the window', async () => {
		const site = freshSite();
		const body = await inObject(site, async (obj) => {
			withPitr(obj);
			return (await (
				await obj.fetch(new Request('https://do.local/__pitr'))
			).json()) as Record<string, unknown>;
		});
		expect(body).toMatchObject({ ok: true, supported: true, windowDays: 30 });
		expect(String(body.current)).toMatch(/^[0-9a-f-]+$/);
	});

	it('takes epoch ms and an ISO string alike', async () => {
		const site = freshSite();
		const when = Date.now() - 3_600_000;
		const both = await inObject(site, async (obj) => {
			withPitr(obj);
			const ms = await (
				await obj.fetch(new Request(`https://do.local/__pitr?at=${when}`))
			).json();
			const iso = await (
				await obj.fetch(
					new Request(`https://do.local/__pitr?at=${new Date(when).toISOString()}`)
				)
			).json();
			return { ms, iso };
		});
		expect((both.ms as { bookmark: string }).bookmark).toBe(`at-${when}`);
		expect((both.iso as { bookmark: string }).bookmark).toBe(`at-${when}`);
	});

	// the window is checked HERE rather than by the platform, so the refusal names the reason
	it('refuses a time outside the 30-day window, in both directions', async () => {
		const site = freshSite();
		const out = await inObject(site, async (obj) => {
			withPitr(obj);
			const old = await obj.fetch(
				new Request(`https://do.local/__pitr?at=${Date.now() - 31 * 86_400_000}`)
			);
			const future = await obj.fetch(
				new Request(`https://do.local/__pitr?at=${Date.now() + 86_400_000}`)
			);
			return { old: old.status, future: future.status, body: await old.json() };
		});
		expect(out.old).toBe(400);
		expect(out.future).toBe(400);
		expect(String((out.body as { error: string }).error)).toContain('30-day');
	});

	it('refuses a time it cannot read', async () => {
		const site = freshSite();
		const status = await inObject(site, async (obj) => {
			withPitr(obj);
			const res = await obj.fetch(new Request('https://do.local/__pitr?at=not-a-time'));
			return res.status;
		});
		expect(status).toBe(400);
	});

	// the undo bookmark is obtainable only from the call that schedules the restore
	it('schedules a restore and hands back the undo', async () => {
		const site = freshSite();
		const body = await inObject(site, async (obj) => {
			withPitr(obj);
			const res = await obj.fetch(
				new Request('https://do.local/__pitr?bookmark=0000007b-0000b26e-00001538-0c3e', {
					method: 'POST'
				})
			);
			return (await res.json()) as Record<string, unknown>;
		});
		expect(body.ok).toBe(true);
		expect(body.scheduled).toBe('0000007b-0000b26e-00001538-0c3e');
		expect(body.undo).toBe('undo-of-0000007b-0000b26e-00001538-0c3e');
		expect(String(body.note)).toContain('next start');
	});

	it('refuses a POST that names nothing bookmark-shaped', async () => {
		const site = freshSite();
		const statuses = await inObject(site, async (obj) => {
			withPitr(obj);
			const out: number[] = [];
			for (const q of ['', '?bookmark=', '?bookmark=yesterday', '?bookmark=../../etc']) {
				out.push(
					(
						await obj.fetch(
							new Request(`https://do.local/__pitr${q}`, { method: 'POST' })
						)
					).status
				);
			}
			return out;
		});
		expect(statuses).toEqual([400, 400, 400, 400]);
	});
});
