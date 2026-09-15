import { beforeEach, describe, expect, it } from 'vitest';
import {
	KV_OVERRIDABLE,
	PLAN_KV_KEY,
	PLAN_MEMO_MS,
	SETTINGS_KV_KEY,
	canWriteKv,
	isPaid,
	resetPlanMemo,
	resetSettingsMemo,
	resolvePlan,
	resolveSettings,
	withPlan,
	withSettings,
	writePlan,
	writeSettings,
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

/**
 * The WRITE half, which did not exist until v1.0.1.
 *
 * `resolvePlan()` and `resolveSettings()` had read these two keys since they shipped and nothing in
 * `src/` ever called `put()`, so every lever on the allow-list was a knob that could only be turned
 * by a redeploy. The assertions below are about the boundary rather than the plumbing: the
 * allow-list has to be enforced where the bytes are STORED, not only where they are read.
 */
describe('writing the levers', () => {
	/** a KV stand-in that remembers, so a write can be read back the way a real namespace would */
	function kvStore(seed: Record<string, string> = {}) {
		const held = new Map(Object.entries(seed));
		return {
			held,
			kv: {
				get: async (key: string) => held.get(key) ?? null,
				put: async (key: string, value: string) => void held.set(key, value)
			}
		};
	}

	const stored = (held: Map<string, string>) =>
		JSON.parse(held.get(SETTINGS_KV_KEY) ?? '{}') as Record<string, string>;

	it('stores an allow-listed lever and reports it as coming from kv', async () => {
		const { held, kv } = kvStore();
		const out = await writeSettings(kv, { MIRROR_LIMIT: '9' });

		expect(out.written.MIRROR_LIMIT).toBe('9');
		expect(out.refused).toEqual([]);
		expect(stored(held).MIRROR_LIMIT).toBe('9');
		// the memo is dropped, or the isolate serves the old value for up to PLAN_MEMO_MS and the
		// write reads as having been ignored
		expect((await resolveSettings(kv)).MIRROR_LIMIT).toBe('9');
	});

	/**
	 * THE PRIVILEGE BOUNDARY, AND IT IS ENFORCED AT THE WRITER RATHER THAN ONLY AT THE READER.
	 *
	 * A reader-side filter makes an unlisted name INERT; a writer-side filter makes it UNSTORABLE.
	 * Those differ the moment anything else grows a reader of the raw document, and
	 * `KV_OVERRIDABLE`'s own docblock says what a stored `PW_DIAGNOSTICS` would reach: `/sql`, which
	 * is arbitrary SQL against the site database, and `/restore`, which overwrites it.
	 */
	it('refuses a name that is not on the allow-list, and stores nothing under it', async () => {
		const { held, kv } = kvStore();
		const out = await writeSettings(kv, {
			PW_DIAGNOSTICS: '1',
			SMTP_HOST: 'evil.example',
			MIRROR_LIMIT: '4'
		});

		expect(out.refused.sort()).toEqual(['PW_DIAGNOSTICS', 'SMTP_HOST']);
		expect(out.written.MIRROR_LIMIT).toBe('4');
		expect(stored(held).PW_DIAGNOSTICS).toBeUndefined();
		expect(stored(held).SMTP_HOST).toBeUndefined();
	});

	/** a document that already carried something unlisted cannot survive a write either */
	it('drops an unlisted name a previous writer left in the document', async () => {
		const { held, kv } = kvStore({
			[SETTINGS_KV_KEY]: JSON.stringify({ PW_DIAGNOSTICS: '1', MIRROR_LIMIT: '2' })
		});
		await writeSettings(kv, { HTTP_DRAIN_LIMIT: '7' });

		expect(stored(held).PW_DIAGNOSTICS).toBeUndefined();
		expect(stored(held).MIRROR_LIMIT).toBe('2');
		expect(stored(held).HTTP_DRAIN_LIMIT).toBe('7');
	});

	/** an empty value means "defer to the deployed var", so it is removed rather than stored blank */
	it('clears a lever rather than storing an empty string', async () => {
		const { held, kv } = kvStore({ [SETTINGS_KV_KEY]: JSON.stringify({ MIRROR_LIMIT: '9' }) });
		const out = await writeSettings(kv, { MIRROR_LIMIT: '' });

		expect(out.cleared).toEqual(['MIRROR_LIMIT']);
		expect(stored(held).MIRROR_LIMIT).toBeUndefined();
	});

	/** `PLAN` has its own key and its own function; it must not be settable as a lever */
	it('refuses PLAN through the lever writer, because it is a different authorisation', async () => {
		const { held, kv } = kvStore();
		const out = await writeSettings(kv, { PLAN: 'paid' });

		expect(out.refused).toEqual(['PLAN']);
		expect(held.get(PLAN_KV_KEY)).toBeUndefined();
		expect(stored(held).PLAN).toBeUndefined();
	});

	it('writes the plan through its own door, and clearing it returns to the var', async () => {
		const { held, kv } = kvStore();
		expect(await writePlan(kv, 'paid')).toEqual({ plan: 'paid', source: 'kv' });
		expect(held.get(PLAN_KV_KEY)).toBe('paid');
		expect(await resolvePlan({ PLAN: 'free' }, kv)).toEqual({ plan: 'paid', source: 'kv' });

		await writePlan(kv, null);
		// an empty override is not `free`; it defers, so the deployed var comes back into force
		expect(await resolvePlan({ PLAN: 'paid' }, kv)).toEqual({ plan: 'paid', source: 'var' });
	});

	it('reports a read-only binding rather than throwing on it', () => {
		// bound to names first, because an inline literal is excess-property-checked against
		// `PlanKv` and the whole point here is that the writer carries one property more
		const readOnly: PlanKv = { get: async () => null };
		const writable = { get: async () => null, put: async () => {} };
		expect(canWriteKv(readOnly)).toBe(false);
		expect(canWriteKv(writable)).toBe(true);
		expect(canWriteKv(null)).toBe(false);
	});
});
