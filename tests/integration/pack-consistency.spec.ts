import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The three repairs first-run makes to the shipped pack, asserted on their own report.
 *
 * `packConsistency` had NO coverage, and the driver-module repair inside it had never once
 * succeeded: `ModuleInstaller::install()` calls `module_config_sort()`, which
 * `DrupalKernel::loadLegacyIncludes()` supplies from `preHandle()` rather than from `boot()`. A
 * kernel booted to run this and nothing else has none of those functions, so every firstrun
 * reported `module-failed:` and `cfw_do_sqlite` stayed out of `core.extension` -- which is exactly
 * what `system_requirements()` tells the owner to fix by hand. Measured on a deployed free site;
 * the enable path had already been fixed the same way and the fix was never mirrored here.
 */

const TIMEOUT = 900_000;

let onceCached: Promise<Record<string, unknown>> | null = null;

function firstrun(): Promise<Record<string, unknown>> {
	onceCached ??= inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		const res = await site.fetch(
			new Request('https://do.local/__firstrun', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ adminPass: 'cfw-Pack-6612-pass', siteName: 'Pack' })
			})
		);
		expect(res.status, await res.clone().text()).toBe(200);
		return (await res.json()) as Record<string, unknown>;
	});
	return onceCached;
}

describe('first-run pack consistency', () => {
	it(
		'installs the database driver module rather than reporting why it could not',
		async () => {
			const out = await firstrun();
			const fixed = (out['packConsistency'] ?? []) as string[];
			console.log(`[pack-consistency] ${JSON.stringify(fixed)}`);

			// the failure this file exists for: a `*-failed:` entry is the repair reporting that it
			// did nothing, and it went green for the whole life of the feature
			expect(fixed.filter((f) => f.includes('-failed:'))).toEqual([]);
			expect(fixed).toContain('module:cfw_do_sqlite');
		},
		TIMEOUT
	);

	it(
		'installs the platform module on a site that never had it, the shape a migrated database has',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				await site.runJson(
					drupalOp(`\\Drupal::configFactory()->getEditable('core.extension')->clear('module.drupflare')->save();
						$out['ok'] = true;`)
				);
				const res = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							adminPass: 'cfw-Pack-6614-pass',
							siteName: 'Migrated'
						})
					})
				);
				expect(res.status, await res.clone().text()).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const probe = (await site.runJson(
					drupalOp(
						`$out['on'] = array_key_exists('drupflare', \\Drupal::config('core.extension')->get('module') ?: []);`
					)
				)) as Record<string, unknown>;
				return {
					fixed: (body['packConsistency'] ?? []) as string[],
					installs: body['packConsistencyInstalls'],
					on: probe['on']
				};
			});
			expect(out.fixed).toContain('module:drupflare');
			// both modules in ONE install(): each call is a container and router rebuild, and two of
			// them took a migrated farmOS claim to 25 s of CPU against the 30 s limit
			expect(out.fixed).toContain('module:cfw_do_sqlite');
			expect(out.installs).toBe(1);
			expect(out.on).toBe(true);
		},
		TIMEOUT
	);

	it(
		'warms, then installs, each in its own invocation before the claim, so the claim installs nothing',
		async () => {
			// the CPU limit is per invocation and a reset rolls the whole one back, so a claim that
			// installed on a ~150-module site (Thunder) was reset at 32 s and reinstalled every retry
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				// the shape a migrated database has: a module set the pack never baked, so the split runs
				await site.runJson(
					drupalOp(`\\Drupal::configFactory()->getEditable('core.extension')->clear('module.drupflare')->save();
						$out['ok'] = true;`)
				);
				const warmed = await site.fetch(
					new Request('https://do.local/__firstrun?phase=warm', {
						method: 'POST',
						body: '{}'
					})
				);
				const warmBody = { status: warmed.status, ...((await warmed.json()) as object) };
				const claimedAfterWarm = site.metaGet('first_run_at');
				const prepared = await site.fetch(
					new Request('https://do.local/__firstrun?phase=consistency', {
						method: 'POST',
						body: '{}'
					})
				);
				const prepareBody = (await prepared.json()) as Record<string, unknown>;
				const claimedAfterPrepare = site.metaGet('first_run_at');
				// a claim reset for CPU rolls back only its own invocation, so its retry prepares
				// again over a prepared site; that has to be a clean no-op, never a 409
				const again = await site.fetch(
					new Request('https://do.local/__firstrun?phase=consistency', {
						method: 'POST',
						body: '{}'
					})
				);
				const againBody = { status: again.status, ...((await again.json()) as object) };
				const claim = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ adminPass: 'cfw-Pack-6615-pass', siteName: 'Split' })
					})
				);
				return {
					status: prepared.status,
					prepareBody,
					claimedAfterPrepare,
					warmBody,
					claimedAfterWarm,
					againBody,
					claim: (await claim.json()) as Record<string, unknown>
				};
			});
			const warm = out.warmBody as Record<string, unknown>;
			expect(warm['status'], JSON.stringify(warm).slice(0, 600)).toBe(200);
			expect(warm['warmed']).toEqual(['entity', 'typed', 'plugins']);
			expect(warm['packConsistencyInstalls']).toBeUndefined();
			expect(out.claimedAfterWarm).toBeNull();
			expect(out.status, JSON.stringify(out.prepareBody)).toBe(200);
			expect(out.prepareBody['packConsistencyInstalls']).toBe(1);
			expect(out.prepareBody['packConsistency']).toContain('module:cfw_do_sqlite');
			expect(out.prepareBody['packConsistency']).toContain('module:drupflare');
			// preparing is not claiming: the trust-on-first-use window stays open
			expect(out.claimedAfterPrepare).toBeNull();
			const again = out.againBody as Record<string, unknown>;
			expect(again['status'], JSON.stringify(again).slice(0, 600)).toBe(200);
			expect(again['packConsistencyInstalls']).toBeUndefined();
			expect(out.claim['ok'], JSON.stringify(out.claim).slice(0, 600)).toBe(true);
			expect(out.claim['packConsistencyInstalls']).toBeUndefined();
			expect(out.claim['packConsistency'] as string[]).not.toContain('module:cfw_do_sqlite');
		},
		TIMEOUT
	);

	it(
		'skips both phases on a site still on the pack module set, whose claim fits one invocation',
		async () => {
			// measured on three stock deploys: the claim took 5.5-8.4 s of CPU as one invocation and
			// 25 s as three, because each phase boots and the warm fills every plugin cache
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const phases: Record<string, unknown>[] = [];
				for (const phase of ['warm', 'consistency']) {
					const res = await site.fetch(
						new Request(`https://do.local/__firstrun?phase=${phase}`, {
							method: 'POST',
							body: '{}'
						})
					);
					phases.push({ status: res.status, ...((await res.json()) as object) });
				}
				const claim = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ adminPass: 'cfw-Pack-6617-pass', siteName: 'Pack' })
					})
				);
				return { phases, claim: (await claim.json()) as Record<string, unknown> };
			});
			for (const p of out.phases) {
				expect(p['status'], JSON.stringify(p).slice(0, 400)).toBe(200);
				expect(p['skipped']).toBeTruthy();
				expect(p['warmed']).toBeUndefined();
				expect(p['packConsistencyInstalls']).toBeUndefined();
			}
			// the claim still makes the install the phases left to it
			expect(out.claim['ok'], JSON.stringify(out.claim).slice(0, 600)).toBe(true);
			expect(out.claim['packConsistency'] as string[]).toContain('module:cfw_do_sqlite');
		},
		TIMEOUT
	);

	it(
		'leaves the driver module enabled in core.extension, which is what the status page reads',
		async () => {
			await firstrun();
			// the OBSERVABLE rather than the repair's own report: `system_requirements()` calls
			// `moduleExists()`, so the config row is what decides whether a site owner is told to
			// install a module by hand
			const enabled = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const res = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							adminPass: 'cfw-Pack-6613-pass',
							siteName: 'PackTwo'
						})
					})
				);
				expect(res.status, await res.clone().text()).toBe(200);
				// `drupalOp` rather than a bare fragment: provisioning drops the interpreter, so
				// there is no resident container to reach `\Drupal::` through
				const probe = (await site.runJson(
					drupalOp(`$m = \\Drupal::config('core.extension')->get('module') ?: [];
						$out['driver'] = \\Drupal::database()->getProvider();
						$out['installed'] = array_key_exists(\\Drupal::database()->getProvider(), $m);`)
				)) as Record<string, unknown>;
				return probe;
			});

			console.log(`[pack-consistency extension] ${JSON.stringify(enabled)}`);
			expect(enabled['driver']).toBe('cfw_do_sqlite');
			expect(enabled['installed'], 'the driver module is not in core.extension').toBe(true);
		},
		TIMEOUT
	);

	it(
		'leaves an image toolkit that resolves, or every account form is a WSOD',
		async () => {
			await firstrun();
			// GD is not compiled into this build, so the shipped `system.image` value names a toolkit
			// that is defined and never AVAILABLE. `ImageFactory` then holds a null id and the user
			// picture widget raises `PluginNotFoundException` on it -- which takes out
			// `/user/register` and `/user/*/edit` for every visitor. Found in a browser, not here
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const res = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							adminPass: 'cfw-Pack-6614-pass',
							siteName: 'PackThree'
						})
					})
				);
				expect(res.status, await res.clone().text()).toBe(200);
				const fixed = ((await res.json()) as Record<string, unknown>)['packConsistency'];
				const probe = (await site.runJson(
					drupalOp(`$m = \\Drupal::service('image.toolkit.manager');
						$f = \\Drupal::service('image.factory');
						$out['configured'] = \\Drupal::config('system.image')->get('toolkit');
						$out['available'] = array_keys($m->getAvailableToolkits());
						$out['resolved'] = $f->getToolkitId();`)
				)) as Record<string, unknown>;
				return { fixed, probe };
			});

			console.log(`[pack-consistency toolkit] ${JSON.stringify(out)}`);
			const probe = out.probe as Record<string, unknown>;
			// the id `ImageFactory` hands the widget; null is the WSOD
			expect(
				probe['resolved'],
				'no image toolkit resolves, so account forms raise'
			).toBeTruthy();
			expect(probe['available'] as string[]).toContain(probe['configured']);
		},
		TIMEOUT
	);

	it(
		'carries the directory CKEditor 5 lists for its langcodes',
		async () => {
			// the listing warned on every editor render and mapped no language while the pack
			// carried none of the translations; a cached list cannot stand in, it sits in discovery
			const probe = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				return (await site.runJson(
					drupalOp(`\\Drupal::cache('discovery')->delete('ckeditor5.langcodes');
						$warned = [];
						set_error_handler(function ($no, $msg) use (&$warned) { $warned[] = $msg; return true; });
						$map = \\Drupal::service(\\Drupal\\ckeditor5\\LanguageMapper::class)->getMappings();
						restore_error_handler();
						$out['langcodes'] = count($map);
						$out['de'] = $map['de'] ?? null;
						$out['warned'] = $warned;`)
				)) as Record<string, unknown>;
			});
			console.log(`[pack-consistency ckeditor5] ${JSON.stringify(probe)}`);
			expect(probe['warned']).toEqual([]);
			expect(probe['langcodes'] as number).toBeGreaterThan(0);
			expect(probe['de']).toBe('de');
		},
		TIMEOUT
	);
});
