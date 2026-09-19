import { beforeEach, describe, expect, it } from 'vitest';
import {
	PLAN_KV_KEY,
	SETTINGS_KV_KEY,
	resetPlanMemo,
	resetSettingsMemo,
	resolvePlan,
	resolveSettings,
	siteScopedKey,
	writePlan,
	writeSettings
} from '../../../src/ops/plan';

/**
 * One tenant must not be able to configure another.
 *
 * Both KV documents were deployment-wide literals, `plan` and `settings`. The credential that
 * reaches them is per SITE -- an owner token resolved against one object, or, once the Drupal
 * settings form landed, a `administer drupflare settings` permission a level below that. So the
 * owner of one site could set `REPLICA_COUNT`, `SITE_WARM` or `EDGE_PLAN` for every other site on
 * the deployment, and `PLAN` on top of it.
 *
 * `KV_OVERRIDABLE`'s safety argument is that every lever's worst case is a slow site. That is an
 * argument about the writer's OWN site and does not survive being applied across tenants.
 */

class FakeKv {
	store = new Map<string, string>();
	reads: string[] = [];

	async get(key: string): Promise<string | null> {
		this.reads.push(key);
		return this.store.get(key) ?? null;
	}

	async put(key: string, value: string): Promise<void> {
		this.store.set(key, value);
	}
}

describe('the KV documents are per site', () => {
	beforeEach(() => {
		resetPlanMemo();
		resetSettingsMemo();
	});

	it('scopes a key by site, and leaves it alone when there is no site', () => {
		expect(siteScopedKey(SETTINGS_KV_KEY, 'alpha')).toBe('settings:alpha');
		expect(siteScopedKey(PLAN_KV_KEY, 'beta')).toBe('plan:beta');
		expect(siteScopedKey(SETTINGS_KV_KEY, '')).toBe(SETTINGS_KV_KEY);
		expect(siteScopedKey(SETTINGS_KV_KEY, null)).toBe(SETTINGS_KV_KEY);
	});

	it('does not let one site write another site levers', async () => {
		const kv = new FakeKv();
		await writeSettings(kv, { REPLICA_COUNT: '32', SITE_WARM: '0' }, 'alpha');

		// alpha sees what alpha wrote
		resetSettingsMemo();
		expect(await resolveSettings(kv, Date.now(), 'alpha')).toMatchObject({
			REPLICA_COUNT: '32',
			SITE_WARM: '0'
		});

		// beta sees NOTHING of it, which is the whole property
		resetSettingsMemo();
		expect(await resolveSettings(kv, Date.now(), 'beta')).toEqual({});
		expect(kv.store.has(SETTINGS_KV_KEY)).toBe(false);
	});

	it('does not let one site write another site plan', async () => {
		const kv = new FakeKv();
		await writePlan(kv, 'paid', 'alpha');

		resetPlanMemo();
		expect(await resolvePlan({ PLAN: 'free' }, kv, Date.now(), 'alpha')).toMatchObject({
			plan: 'paid',
			source: 'kv'
		});

		// beta stays on the plan its own configuration says, so one tenant cannot move an
		// account-wide limits profile on behalf of every other one
		resetPlanMemo();
		expect(await resolvePlan({ PLAN: 'free' }, kv, Date.now(), 'beta')).toMatchObject({
			plan: 'free'
		});
		expect(kv.store.has(PLAN_KV_KEY)).toBe(false);
	});

	it('still reads a deployment-wide default, with the site document winning', async () => {
		const kv = new FakeKv();
		// an operator's fleet-wide default, set in the dashboard rather than through the route
		kv.store.set(SETTINGS_KV_KEY, JSON.stringify({ REPLICA_COUNT: '2', SITE_WARM: '1' }));
		await writeSettings(kv, { REPLICA_COUNT: '8' }, 'alpha');

		resetSettingsMemo();
		const alpha = await resolveSettings(kv, Date.now(), 'alpha');
		expect(alpha.REPLICA_COUNT).toBe('8');
		// inherited, not lost: a per-site document overlays the default rather than replacing it
		expect(alpha.SITE_WARM).toBe('1');

		resetSettingsMemo();
		expect(await resolveSettings(kv, Date.now(), 'beta')).toMatchObject({
			REPLICA_COUNT: '2',
			SITE_WARM: '1'
		});
	});

	it('memoises per site, so the first site asked does not answer for the rest', async () => {
		const kv = new FakeKv();
		await writeSettings(kv, { REPLICA_COUNT: '16' }, 'alpha');
		resetSettingsMemo();

		const at = Date.now();
		// same instant, so both calls are inside the memo window; a single shared memo would hand
		// alpha's document to beta
		expect(await resolveSettings(kv, at, 'alpha')).toMatchObject({ REPLICA_COUNT: '16' });
		expect(await resolveSettings(kv, at, 'beta')).toEqual({});
	});
});
