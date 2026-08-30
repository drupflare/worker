import { describe, expect, it } from 'vitest';
import type { SiteEnv } from '../../../src/env';
import { shellAssemblyEnabled } from '../../../src/site-do';

/**
 * The lever's default, and the reason it is a COST split rather than a safety one.
 *
 * `assembleFor()` serves no visitor until their own uid has passed `verifyShellFor()`, which
 * re-harvests them and requires byte equality with the stored shell. The two-session harvest
 * authorises the store; the per-uid proof authorises the serve. So what separates the plans is the
 * 40-52 row toll on the first request per `(path, role set, uid)`, which free's 100,000 rows/day
 * cannot absorb.
 */
describe('shellAssemblyEnabled', () => {
	it('is on by default on either plan, because one site is the case to price for', () => {
		expect(shellAssemblyEnabled({ PLAN: 'paid' } as SiteEnv)).toBe(true);
		expect(shellAssemblyEnabled({ PLAN: 'free' } as SiteEnv)).toBe(true);
		expect(shellAssemblyEnabled(undefined)).toBe(true);
	});

	it.each([
		['an explicit 0 turns it off for a free site', 'free', '0', false],
		['an explicit 0 turns it off for a paid site', 'paid', '0', false],
		['an explicit 1 is still honoured', 'free', '1', true]
	])('%s', (_label, plan, set, want) => {
		expect(shellAssemblyEnabled({ PLAN: plan, SHELL_ASSEMBLY: set } as SiteEnv)).toBe(want);
	});

	// KV hands back '' for a key an operator cleared, and '' is not a decision
	it('treats an empty override as absent rather than as off', () => {
		expect(shellAssemblyEnabled({ PLAN: 'paid', SHELL_ASSEMBLY: '' } as SiteEnv)).toBe(true);
	});
});
