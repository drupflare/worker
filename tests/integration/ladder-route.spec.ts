import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { mintOwnerToken, type SecretStore } from '../../src/ops/site/secrets';
import worker from '../../src/site';
import { freshSite, inObject, namedSite, type ServeDo } from '../helpers/serve-do';

/**
 * The headroom ladder's route: one 4 MiB touched allocation per POST, owner-gated, and absent
 * unless the measurement var is set. The allocation is held for the isolate's life, so the cases
 * read a count relative to the first answer rather than from zero.
 */

type Rung = { id: string; totalMiB: number; linearMiB: number; spareMiB: number };

const call = (site: ServeDo, method: string) =>
	site.fetch(new Request('https://do.local/__ladder', { method }));

const withProbe = (site: ServeDo, value: string | undefined) => {
	site.env = { ...site.env, LADDER_PROBE: value };
};

describe('the ladder route', () => {
	it('answers 404 to every method without LADDER_PROBE', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			withProbe(site, undefined);
			return [(await call(site, 'POST')).status, (await call(site, 'GET')).status];
		});
		expect(out).toEqual([404, 404]);
	});

	it('answers 404 to LADDER_PROBE values other than 1', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			withProbe(site, 'true');
			return (await call(site, 'POST')).status;
		});
		expect(out).toBe(404);
	});

	it('answers 405 with an allow header to GET when the var is set', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			withProbe(site, '1');
			const res = await call(site, 'GET');
			return { status: res.status, allow: res.headers.get('allow') };
		});
		expect(out).toEqual({ status: 405, allow: 'POST' });
	});

	it('holds 4 MiB more per POST and reports one isolate id', async () => {
		const rungs = await inObject(freshSite(), async (site: ServeDo) => {
			withProbe(site, '1');
			const out: Rung[] = [];
			for (let i = 0; i < 3; i++) out.push((await (await call(site, 'POST')).json()) as Rung);
			return out;
		});
		const [first, second, third] = rungs as [Rung, Rung, Rung];
		expect(second.totalMiB - first.totalMiB).toBe(4);
		expect(third.totalMiB - second.totalMiB).toBe(4);
		expect(new Set(rungs.map((r) => r.id)).size).toBe(1);
		for (const rung of rungs) {
			expect(rung.linearMiB).toBeGreaterThanOrEqual(0);
			expect(rung.spareMiB).toBeGreaterThanOrEqual(0);
		}
	});
});

describe('the ladder route behind the front worker', () => {
	const ask = (site: string, headers: Record<string, string> = {}) =>
		worker.fetch(
			new Request(`https://cfw.local/ladder?site=${site}`, { method: 'POST', headers }),
			{ ...env, PW_DIAGNOSTICS: '0' }
		);

	it('refuses a caller with no owner token', async () => {
		expect((await ask('ladder-none')).status).toBe(401);
	});

	it('refuses a wrong owner token', async () => {
		expect((await ask('ladder-wrong', { authorization: 'Bearer nope' })).status).toBe(401);
	});

	it('hands the owner on to the object, which answers 404 without the var', async () => {
		const site = 'ladder-owner';
		const token = await inObject(namedSite(site), (obj) =>
			mintOwnerToken((obj as unknown as { secretStore: () => SecretStore }).secretStore())
		);
		const res = await ask(site, { authorization: `Bearer ${token}` });
		expect(res.status).toBe(404);
		expect(await res.text()).toBe('not found');
	});

	it('is not reachable at its inner path from outside', async () => {
		const res = await worker.fetch(
			new Request('https://cfw.local/__ladder?site=ladder-inner', { method: 'POST' }),
			{ ...env, PW_DIAGNOSTICS: '0' }
		);
		expect(res.status).toBe(404);
	});
});
