import { env as rawEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	KV_OVERRIDABLE,
	resetSettingsMemo,
	SETTINGS_KV_KEY,
	type KvOverridable
} from '../../src/ops/plan';
import { freshSite, inObject } from '../helpers/serve-do';

// the generated Env has no CONFIG_KV because wrangler.jsonc declares the binding without an id;
// miniflare still provisions a local namespace for it
const env = rawEnv as typeof rawEnv & {
	CONFIG_KV: KVNamespace;
	PLAN?: string;
	PW_DIAGNOSTICS?: string;
};

/**
 * Every KV lever, proved to reach a reader inside the Durable Object.
 *
 * THE CONVENTION WAS DECORATIVE FOR SEVEN OF ITS ELEVEN NAMES. `withSettings()` is applied in
 * `src/site.ts` to the FRONT worker's env; the object receives its own copy of the bindings, so
 * `RENDER_BUDGET_MS`, `FILL_BATCH_SIZE`, `FILL_BATCH_WALL_MS`, `HTTP_DRAIN_LIMIT`, `MIRROR_LIMIT`,
 * `LAZY_FS_BUDGET_BYTES` and `PREFILL` were knobs an operator could set and nothing would read.
 * Every one of them had a passing test of its RESOLVER, which is why nothing noticed: the resolvers
 * were always correct and were being handed an env the override never touched.
 *
 * So this asserts the seam rather than the resolvers, and it asserts it BY NAME COVERAGE -- a
 * twelfth entry added to `KV_OVERRIDABLE` with no wiring fails here rather than shipping as another
 * knob that configures nothing.
 */

const PROBE: Record<KvOverridable, string> = {
	RENDER_BUDGET_MS: '4321',
	FILL_BATCH_SIZE: '7',
	FILL_BATCH_WALL_MS: '12345',
	HTTP_DRAIN_LIMIT: '3',
	MIRROR_LIMIT: '9',
	LAZY_FS_BUDGET_BYTES: '1048576',
	PREFILL: '0',
	GEN_BUCKET_MS: '2500',
	MAIL_TRANSPORT: 'smtp',
	MAIL_DRAIN_LIMIT: '4',
	SHELL_ASSEMBLY: '1',
	OPCACHE_MODE: 'file',
	ARGON2: '1',
	SITE_LOCATION_HINT: 'weur'
};

async function writeSettings(doc: Record<string, string>): Promise<void> {
	await env.CONFIG_KV.put(SETTINGS_KV_KEY, JSON.stringify(doc));
	// the resolver memoises for PLAN_MEMO_MS, and the object shares this isolate's module state
	resetSettingsMemo();
}

describe('the KV lever seam inside the object', () => {
	beforeEach(async () => {
		await env.CONFIG_KV.delete(SETTINGS_KV_KEY);
		resetSettingsMemo();
	});

	it('carries a probe value for every name on the allow-list', () => {
		// the fixture itself is the coverage claim; a new lever with no probe fails here first
		expect(Object.keys(PROBE).sort()).toEqual([...KV_OVERRIDABLE].sort());
	});

	it('adopts every lever onto the object env, not just the mail pair', async () => {
		await writeSettings(PROBE);
		const site = freshSite();
		const seen = await inObject(site, async (obj) => {
			await obj.adoptSettings();
			const out: Record<string, unknown> = {};
			for (const name of KV_OVERRIDABLE)
				out[name] = (obj.env as Record<string, unknown>)[name];
			return out;
		});
		expect(seen).toEqual(PROBE);
	});

	/**
	 * The four that were already wired must not regress, and the seven that were not must now work.
	 *
	 * Listed explicitly rather than derived, because the split is the finding.
	 */
	it('reaches the seven readers that live only inside the object', async () => {
		await writeSettings(PROBE);
		const site = freshSite();
		const seen = await inObject(site, async (obj) => {
			await obj.adoptSettings();
			const e = obj.env as Record<string, unknown>;
			return {
				render: e.RENDER_BUDGET_MS,
				batch: e.FILL_BATCH_SIZE,
				wall: e.FILL_BATCH_WALL_MS,
				drain: e.HTTP_DRAIN_LIMIT,
				mirror: e.MIRROR_LIMIT,
				lazy: e.LAZY_FS_BUDGET_BYTES,
				prefill: e.PREFILL
			};
		});
		expect(seen).toEqual({
			render: '4321',
			batch: '7',
			wall: '12345',
			drain: '3',
			mirror: '9',
			lazy: '1048576',
			prefill: '0'
		});
	});

	/**
	 * THE PRIVILEGE BOUNDARY, asserted from the writing side.
	 *
	 * `KV_OVERRIDABLE` is a security control rather than tidiness: KV is operator-writable, so a name
	 * that reaches the object must never change what is REACHABLE. A KV writer who could set
	 * `SMTP_HOST` would receive every password-reset link the site sends.
	 */
	it('ignores a name that is not on the allow-list, however it is written', async () => {
		await writeSettings({
			...PROBE,
			SMTP_HOST: 'attacker.example',
			PW_DIAGNOSTICS: '1',
			PLAN: 'paid',
			SITE_ID: 'somebody-else'
		} as Record<string, string>);
		const site = freshSite();
		const seen = await inObject(site, async (obj) => {
			await obj.adoptSettings();
			const e = obj.env as Record<string, unknown>;
			return {
				smtp: e.SMTP_HOST ?? null,
				diag: e.PW_DIAGNOSTICS ?? null,
				plan: e.PLAN ?? null,
				id: e.SITE_ID ?? null
			};
		});
		expect(seen.smtp, 'a KV writer must not redirect outbound mail').toBeNull();
		expect(seen.id, 'nor point the object at another site').toBeNull();
		// PLAN and PW_DIAGNOSTICS both arrive as deployed bindings in this lane, so the claim is that
		// KV did not CHANGE them rather than that they are absent -- the weaker "is null" assertion
		// would have passed for the wrong reason on any name the config happens not to set
		expect(seen.plan, 'nor buy themselves the paid profile').toBe(env.PLAN ?? null);
		expect(seen.plan).not.toBe('paid');
		expect(seen.diag).toBe(env.PW_DIAGNOSTICS ?? null);
	});

	/**
	 * AN ALARM NEVER PASSES THROUGH `handle()`, and four of the seven are read on the fill chain.
	 *
	 * Adopting only in `handle()` would leave `FILL_BATCH_SIZE`, `FILL_BATCH_WALL_MS`,
	 * `HTTP_DRAIN_LIMIT` and `MIRROR_LIMIT` at their deployed vars however many times an operator
	 * rewrote KV -- the exact defect this whole spec exists for, one entry point along.
	 */
	it('adopts before the fill chain reads its budgets, on the alarm entry point', async () => {
		await writeSettings(PROBE);
		const site = freshSite();
		const seen = await inObject(site, async (obj) => {
			await obj.alarm();
			const e = obj.env as Record<string, unknown>;
			return { batch: e.FILL_BATCH_SIZE, wall: e.FILL_BATCH_WALL_MS, mirror: e.MIRROR_LIMIT };
		});
		expect(seen).toEqual({ batch: '7', wall: '12345', mirror: '9' });
	});

	it('leaves the deployed vars in force when KV holds nothing', async () => {
		const site = freshSite();
		const before = await inObject(site, (obj) => (obj.env as Record<string, unknown>).PLAN);
		const after = await inObject(site, async (obj) => {
			await obj.adoptSettings();
			return (obj.env as Record<string, unknown>).PLAN;
		});
		expect(after).toBe(before);
	});

	it('survives an unparseable settings document rather than throwing on the serving path', async () => {
		await env.CONFIG_KV.put(SETTINGS_KV_KEY, '{ not json');
		resetSettingsMemo();
		const site = freshSite();
		await expect(inObject(site, (obj) => obj.adoptSettings())).resolves.toBeUndefined();
	});
});
