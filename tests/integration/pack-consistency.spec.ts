import { describe, expect, it } from 'vitest';
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
				const probe = (await site.runJson(
					`<?php
						$m = \\Drupal::config('core.extension')->get('module') ?: [];
						echo json_encode([
							'driver' => \\Drupal::database()->getProvider(),
							'installed' => array_key_exists(\\Drupal::database()->getProvider(), $m),
						]);`
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
					`<?php
						$m = \\Drupal::service('image.toolkit.manager');
						$f = \\Drupal::service('image.factory');
						echo json_encode([
							'configured' => \\Drupal::config('system.image')->get('toolkit'),
							'available' => array_keys($m->getAvailableToolkits()),
							'resolved' => $f->getToolkitId(),
						]);`
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
});
