import { describe, expect, it } from 'vitest';
import { type ClaimWarmDeps, claimWarmStep } from '../../../../src/ops/warm/claim';

/**
 * CLAIM_WARM_STEPS: the claim's warm phase is a cursor kept in the object, one unit per call.
 *
 * The fake keeps the stored text and records each unit it is asked to run, so a spec can read the
 * order of work and the state the next call will resume from.
 */

function fake(plugins: string[] = []) {
	const ran: Array<[string, string[]]> = [];
	const store: { text: string | null } = { text: null };
	let fail: string | undefined;
	const deps = (context = 'gen-1/mods'): ClaimWarmDeps => ({
		context,
		read: () => store.text,
		write: (value) => {
			store.text = value;
		},
		run: async (step, units) => {
			ran.push([step, units]);
			if (step === fail) return { ok: false, error: 'boom' };
			if (step === 'plan') return { ok: true, plugins };
			return { ok: true };
		}
	});
	return { deps, ran, store, failOn: (step: string) => (fail = step) };
}

async function drain(deps: ClaimWarmDeps) {
	const replies: Record<string, unknown>[] = [];
	for (let i = 0; i < 20; i++) {
		const reply = await claimWarmStep(deps);
		replies.push(reply);
		if (reply.complete === true) break;
	}
	return replies;
}

describe('the claim warm cursor', () => {
	it('plans on the first call and runs nothing else', async () => {
		const { deps, ran, store } = fake(['plugin.manager.a', 'plugin.manager.b']);
		const reply = await claimWarmStep(deps('gen-1/mods'));
		expect(reply).toEqual({ ok: true, complete: false, completed: 1, total: 5 });
		expect(ran).toEqual([['plan', []]]);
		expect(JSON.parse(store.text!).units).toEqual([
			{ step: 'entity' },
			{ step: 'typed' },
			{ step: 'plugins', plugins: ['plugin.manager.a', 'plugin.manager.b'] },
			{ step: 'router' }
		]);
	});

	it('runs one unit per call, in order, and completes after the last', async () => {
		const { deps, ran } = fake(['plugin.manager.a']);
		const replies = await drain(deps('gen-1/mods'));
		expect(ran.map(([step]) => step)).toEqual(['plan', 'entity', 'typed', 'plugins', 'router']);
		expect(replies.at(-1)).toEqual({ ok: true, complete: true, completed: 5, total: 5 });
	});

	it('batches plugins four to a unit', async () => {
		const names = Array.from({ length: 9 }, (_, i) => `plugin.manager.p${i}`);
		const { deps, store } = fake(names);
		await claimWarmStep(deps('gen-1/mods'));
		const sizes = JSON.parse(store.text!).units.map(
			(unit: { plugins?: string[] }) => unit.plugins?.length ?? 0
		);
		expect(sizes).toEqual([0, 0, 4, 4, 1, 0]);
	});

	it('resumes a cursor written for the same context and plans again for another', async () => {
		const { deps, ran, store } = fake(['plugin.manager.a']);
		await claimWarmStep(deps('gen-1/mods'));
		await claimWarmStep(deps('gen-1/mods'));
		expect(ran.map(([step]) => step)).toEqual(['plan', 'entity']);
		const other = fake(['plugin.manager.a']);
		other.store.text = store.text;
		await claimWarmStep(other.deps('gen-2/mods'));
		expect(other.ran.map(([step]) => step)).toEqual(['plan']);
	});

	it('keeps the cursor where it was when a unit fails, so the next call retries it', async () => {
		const { deps, ran, store, failOn } = fake(['plugin.manager.a']);
		await claimWarmStep(deps('gen-1/mods'));
		await claimWarmStep(deps('gen-1/mods'));
		const before = store.text;
		failOn('typed');
		const reply = await claimWarmStep(deps('gen-1/mods'));
		expect(reply).toEqual({ ok: false, error: 'boom', complete: false });
		expect(store.text).toBe(before);
		failOn('');
		await claimWarmStep(deps('gen-1/mods'));
		expect(ran.at(-1)?.[0]).toBe('typed');
	});

	it('refuses a stored cursor whose shape is wrong', async () => {
		const { deps, store } = fake();
		store.text = JSON.stringify({ version: 2, context: 'gen-1/mods', next: 0, units: [] });
		await expect(claimWarmStep(deps('gen-1/mods'))).rejects.toThrow(
			'invalid claim warm cursor'
		);
	});

	it('refuses a plan that names a service outside the plugin managers', async () => {
		const { deps } = fake(['core.entity_type.manager']);
		await expect(claimWarmStep(deps('gen-1/mods'))).rejects.toThrow('invalid plugin warm plan');
	});
});
