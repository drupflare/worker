import { describe, expect, it } from 'vitest';
import {
	CAPABILITY_GROUPS,
	refusalFor,
	scoreModule,
	vectorFor,
	VECTORS,
	vectorsIn
} from '../../../src/ops/capability-contract';

describe('the capability contract', () => {
	it('lists every vector under exactly one group', () => {
		let total = 0;
		for (const group of CAPABILITY_GROUPS) {
			const members = vectorsIn(group);
			expect(members.every((v) => v.group === group)).toBe(true);
			total += members.length;
		}
		expect(total).toBe(VECTORS.length);
	});

	it('resolves a declared id and refuses a typo', () => {
		expect(vectorFor('cache.kill_switch')?.group).toBe('CACHE');
		expect(vectorFor('cache.kill_swich')).toBeUndefined();
	});
});

describe('scoring a module', () => {
	it('is installable when every need is a satisfied vector', () => {
		const verdict = scoreModule(['cache.kill_switch', 'cache.custom_bin']);
		expect(verdict.installable).toBe(true);
		expect(verdict.satisfied).toEqual(['cache.kill_switch', 'cache.custom_bin']);
		expect(refusalFor(verdict)).toBe('');
	});

	it('counts an unknown id against the module and says so', () => {
		const verdict = scoreModule(['cache.kill_switch', 'nope.nothing']);
		expect(verdict.installable).toBe(false);
		expect(verdict.unknown).toEqual(['nope.nothing']);
		expect(refusalFor(verdict)).toBe(
			'declares 1 capability id(s) this contract does not define: nope.nothing'
		);
	});

	it('names each unsatisfied vector with its blocker in the refusal', () => {
		const blocked = VECTORS.filter((v) => !v.expected).slice(0, 2);
		expect(blocked.length).toBeGreaterThan(0);
		const verdict = scoreModule(blocked.map((v) => v.id));
		expect(verdict.installable).toBe(false);
		const reason = refusalFor(verdict);
		for (const v of blocked) {
			expect(reason).toContain(`${v.id} (${v.blocker ?? 'unsatisfied'}): ${v.claim}`);
		}
	});
});
