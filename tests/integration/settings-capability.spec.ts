import { describe, expect, it } from 'vitest';
import { CROSSING_NAMES } from '../../src/ops/crossings';
import { KV_OVERRIDABLE } from '../../src/ops/plan';
import { classifyCapability } from '../../src/ops/replica';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The two capabilities Drupal's own admin pages read.
 *
 * `administer drupflare settings` was declared in the module's permissions and referenced by
 * NOTHING for a release: no route, no form, no PHP. A permission that guards nothing is this
 * project's signature defect class, so what is guarded here is that the host half answers at all.
 *
 * The settings writer is the half worth testing hardest, because it is the first thing in the
 * product that lets a site administrator change runtime configuration. `PLAN` must be unreachable
 * from it: every other lever's worst case is a slow site, while `PLAN` selects a limits profile
 * whose quotas are ACCOUNT-WIDE, and whoever reaches a Drupal form is one tenant's administrator
 * rather than the account holder.
 */

type Installed = Record<string, (json: string) => string>;

type LeverReply = {
	ok?: boolean;
	levers?: { name: string; value: string | null; source: string }[];
	writable?: boolean;
	accepted?: string[];
	refused?: string[];
	error?: string;
	packages?: { name: string; source: string; revisions: number; active: string }[];
};

/** drives one capability the way PHP does, through the installer rather than around it */
function call(site: ServeDo, name: string, payload: unknown): LeverReply {
	const binary = (
		site as unknown as { installCapabilities(b: Installed): Installed }
	).installCapabilities({} as Installed);
	const fn = binary[name];
	if (typeof fn !== 'function') throw new Error(`${name} is not installed`);
	return JSON.parse(fn(JSON.stringify(payload))) as LeverReply;
}

/** the deployment under test may have no writable KV; that is a skip, not a failure */
function unwritable(reply: LeverReply): boolean {
	return (
		reply.error === 'no CONFIG_KV binding on this deployment' ||
		reply.error === 'this CONFIG_KV binding is read-only'
	);
}

describe('the capabilities Drupal admin pages read', () => {
	it('registers both in the crossings census, or the bridge under-reports itself', () => {
		// the census drifted by two capabilities once already, which is why this is asserted
		// rather than maintained by hand
		expect(CROSSING_NAMES).toContain('cfwSettings');
		expect(CROSSING_NAMES).toContain('cfwModules');
	});

	it('lets a lane read the module list and refuses it the lever write', () => {
		// `cfwSettings` writes account KV, which is off this object entirely, so a lane must hand
		// back rather than write on the primary's behalf. `cfwModules` reads replicated rows this
		// lane already holds, so refusing it would break the Modules page on a pooled site
		expect(classifyCapability('cfwSettings')).toBe('mutating');
		expect(classifyCapability('cfwModules')).toBe('safe');
	});

	it('reports every allow-listed lever with a source', async () => {
		await inObject(freshSite(), async (site: ServeDo) => {
			await (site as unknown as { adoptSettings(): Promise<void> }).adoptSettings();
			const view = call(site, 'cfwSettings', { action: 'get' });
			if (unwritable(view)) return;
			expect(view.ok).toBe(true);
			// every name, including those with no override: a caller renders the whole surface
			// from one reply rather than having to know the list
			expect((view.levers ?? []).map((l) => l.name)).toEqual([...KV_OVERRIDABLE]);
			for (const lever of view.levers ?? []) {
				expect(['kv', 'var', 'default']).toContain(lever.source);
			}
		});
	});

	it('refuses PLAN at every spelling, and anything off the allow-list', async () => {
		await inObject(freshSite(), async (site: ServeDo) => {
			await (site as unknown as { adoptSettings(): Promise<void> }).adoptSettings();
			const view = call(site, 'cfwSettings', {
				action: 'set',
				patch: {
					PLAN: 'paid',
					plan: 'paid',
					Plan: 'paid',
					PW_DIAGNOSTICS: '1',
					RENDER_BUDGET_MS: '250'
				}
			});
			if (unwritable(view)) return;
			expect(view.ok).toBe(true);
			// the one legitimate lever goes through and nothing else does
			expect(view.accepted).toEqual(['RENDER_BUDGET_MS']);
			// REPORTED rather than silently dropped: a writer that merely ignored unknown keys
			// would pass the line above, and an operator would never learn their edit was void
			expect((view.refused ?? []).sort()).toEqual(
				['PLAN', 'PW_DIAGNOSTICS', 'Plan', 'plan'].sort()
			);
		});
	});

	it('answers an empty package list on a site nothing was delivered to', async () => {
		await inObject(freshSite(), async (site: ServeDo) => {
			const view = call(site, 'cfwModules', { action: 'list' });
			expect(view.ok).toBe(true);
			expect(view.packages).toEqual([]);
		});
	});
});
