import { beforeEach, describe, expect, it } from 'vitest';
import {
	KV_OVERRIDABLE,
	PLAN_KV_KEY,
	PLAN_MEMO_MS,
	isPaid,
	resetPlanMemo,
	resetSettingsMemo,
	resolvePlan,
	resolveSettings,
	withPlan,
	withSettings,
	type PlanKv
} from '../../../src/ops/plan';

/**
 * `PLAN` was a `vars` entry, so upgrading an account meant editing the config and redeploying -- a
 * deploy to change a fact the deploy does not control. These assert the override, and the two ways
 * it must fail SAFE: a KV outage must not take a paid site to free, and an unrecognised value must
 * not grant paid to something with a 10 ms cap.
 */

const kvOf = (value: string | null): PlanKv => ({ get: async () => value });

beforeEach(() => resetPlanMemo());

describe('resolvePlan', () => {
	it('prefers KV over the deployed var', async () => {
		const out = await resolvePlan({ PLAN: 'free' }, kvOf('paid'));
		expect(out).toEqual({ plan: 'paid', source: 'kv' });
	});

	it('lets KV downgrade too, not just upgrade', async () => {
		expect(await resolvePlan({ PLAN: 'paid' }, kvOf('free'))).toEqual({
			plan: 'free',
			source: 'kv'
		});
	});

	it('falls back to the var when KV holds nothing', async () => {
		expect(await resolvePlan({ PLAN: 'paid' }, kvOf(null))).toEqual({
			plan: 'paid',
			source: 'var'
		});
	});

	it('falls back to the var when no namespace is bound at all', async () => {
		// the shipping default: CONFIG_KV is optional, so an unprovisioned namespace is normal
		expect(await resolvePlan({ PLAN: 'paid' }, null)).toEqual({ plan: 'paid', source: 'var' });
	});

	it('SURVIVES a KV error rather than failing the request', async () => {
		// this runs on the serving path; a KV blip must not take a paid site to free, and must
		// certainly not throw
		const angry: PlanKv = {
			get: async () => {
				throw new Error('kv unavailable');
			}
		};
		expect(await resolvePlan({ PLAN: 'paid' }, angry)).toEqual({ plan: 'paid', source: 'var' });
	});

	it('ignores an unrecognised KV value instead of guessing upward', async () => {
		for (const raw of ['PRO', 'enterprise', '1', 'true', '']) {
			resetPlanMemo();
			expect((await resolvePlan({ PLAN: 'free' }, kvOf(raw))).plan, raw).toBe('free');
		}
	});

	it('accepts the value case-insensitively and trimmed, because a human types it', async () => {
		expect((await resolvePlan({ PLAN: 'free' }, kvOf('  PAID \n'))).plan).toBe('paid');
	});

	it('reports `default` when neither KV nor the var says anything', async () => {
		expect(await resolvePlan({}, null)).toEqual({ plan: 'free', source: 'default' });
	});

	it('memoises, so KV is not read once per request', async () => {
		// KV free allows 100,000 reads/day, the same order as the Worker-request ceiling: a read per
		// request would spend one binding meter to consult another
		let reads = 0;
		const counting: PlanKv = {
			get: async () => {
				reads++;
				return 'paid';
			}
		};
		await resolvePlan({ PLAN: 'free' }, counting, 1_000);
		await resolvePlan({ PLAN: 'free' }, counting, 1_000 + PLAN_MEMO_MS - 1);
		expect(reads).toBe(1);
	});

	it('re-reads once the memo expires, so an upgrade actually lands', async () => {
		let reads = 0;
		const counting: PlanKv = {
			get: async () => {
				reads++;
				return 'paid';
			}
		};
		await resolvePlan({ PLAN: 'free' }, counting, 1_000);
		await resolvePlan({ PLAN: 'free' }, counting, 1_000 + PLAN_MEMO_MS);
		expect(reads).toBe(2);
	});
});

describe('withPlan', () => {
	it('overlays the resolved plan so every existing isPaid() call site agrees', () => {
		const env = { PLAN: 'free', OTHER: 'kept' } as Record<string, string>;
		const out = withPlan(env, { plan: 'paid', source: 'kv' });
		expect(isPaid(out)).toBe(true);
		expect(out.OTHER).toBe('kept');
		// the original is not mutated: the caller may still want to report what was deployed
		expect(isPaid(env)).toBe(false);
	});
});

describe('the KV key', () => {
	it('is a stable name an operator can set by hand', () => {
		expect(PLAN_KV_KEY).toBe('plan');
	});
});

describe('the lever overrides, and the boundary they must not cross', () => {
	beforeEach(() => resetSettingsMemo());

	const kvJson = (o: unknown): PlanKv => ({ get: async () => JSON.stringify(o) });

	it('REFUSES PW_DIAGNOSTICS, which is the whole reason there is an allow-list', async () => {
		// KV is operator-writable. A blanket merge would let anyone with KV write reach /sql
		// (arbitrary SQL against the site database) and /restore (a whole-database overwrite)
		const out = await resolveSettings(
			kvJson({ PW_DIAGNOSTICS: '1', RENDER_BUDGET_MS: '9000' })
		);
		expect(out).not.toHaveProperty('PW_DIAGNOSTICS');
		expect(out.RENDER_BUDGET_MS).toBe('9000');
	});

	it('refuses PLAN too, because it has its own key and selects a whole profile', async () => {
		expect(await resolveSettings(kvJson({ PLAN: 'paid' }))).not.toHaveProperty('PLAN');
	});

	it('refuses anything not on the list, including bindings and secrets', async () => {
		const out = await resolveSettings(
			kvJson({ SITE: 'x', CONFIG_KV: 'x', OWNER_TOKEN: 'x', SQL_CHUNK_PREFIX: 'x' })
		);
		expect(Object.keys(out)).toEqual([]);
	});

	it('keeps every lever that IS on the list', async () => {
		const every = Object.fromEntries(KV_OVERRIDABLE.map((k) => [k, '1']));
		expect(Object.keys(await resolveSettings(kvJson(every))).sort()).toEqual(
			[...KV_OVERRIDABLE].sort()
		);
	});

	it('coerces to strings, because that is what a vars binding delivers', async () => {
		const out = await resolveSettings(kvJson({ FILL_BATCH_SIZE: 12, PREFILL: false }));
		expect(out.FILL_BATCH_SIZE).toBe('12');
		expect(out.PREFILL).toBe('false');
	});

	it('drops an object value rather than stringifying it to [object Object]', async () => {
		expect(await resolveSettings(kvJson({ MIRROR_LIMIT: { nope: 1 } }))).toEqual({});
	});

	it('yields nothing for malformed JSON, an array, or a KV error', async () => {
		expect(await resolveSettings({ get: async () => 'not json' })).toEqual({});
		resetSettingsMemo();
		expect(await resolveSettings(kvJson([1, 2, 3]))).toEqual({});
		resetSettingsMemo();
		expect(
			await resolveSettings({
				get: async () => {
					throw new Error('kv down');
				}
			})
		).toEqual({});
	});

	it('yields nothing when no namespace is bound', async () => {
		expect(await resolveSettings(null)).toEqual({});
	});

	it('memoises on the same clock as the plan', async () => {
		let reads = 0;
		const counting: PlanKv = {
			get: async () => {
				reads++;
				return '{"MIRROR_LIMIT":"9"}';
			}
		};
		await resolveSettings(counting, 1_000);
		await resolveSettings(counting, 1_000 + PLAN_MEMO_MS - 1);
		expect(reads).toBe(1);
		await resolveSettings(counting, 1_000 + PLAN_MEMO_MS);
		expect(reads).toBe(2);
	});
});

describe('withSettings', () => {
	it('overlays the overrides and leaves everything else alone', () => {
		const env = { PLAN: 'free', PW_DIAGNOSTICS: '0', MIRROR_LIMIT: '2' };
		const out = withSettings(env, { MIRROR_LIMIT: '9' });
		expect(out.MIRROR_LIMIT).toBe('9');
		expect(out.PW_DIAGNOSTICS).toBe('0');
		expect(env.MIRROR_LIMIT).toBe('2');
	});
});
