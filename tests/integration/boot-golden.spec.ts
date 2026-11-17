import { describe, expect, it } from 'vitest';
import golden from '../fixtures/boot-golden.json';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What a booted site holds at the two paths boot writes, against bytes captured from the code
 * before the Drupal half of the boot moved to `src/drupal/`.
 *
 * The salt is random per site, so its value is masked and its line is still compared.
 */

const LIVE = (
	golden as unknown as { live?: Record<string, { settings: string; services: string }> }
).live;

const CASES: Record<string, Record<string, string>> = {
	defaults: { SITE_ORIGIN: 'https://golden.example' },
	tuned: {
		SITE_ORIGIN: 'https://golden-two.example:8443',
		ARGON2: '1',
		MEMORY_CACHE_BINS: 'none',
		DRUPAL_ENV_GREETING: "it's $HOME",
		PW_DIAGNOSTICS: '1'
	}
};

async function bootFiles(vars: Record<string, string>) {
	return inObject(freshSite(), async (site: ServeDo) => {
		Object.assign(site.env, vars);
		const out = (await site.runJson(`<?php
echo json_encode([
	'settings' => file_get_contents('/drupal/sites/default/settings.php'),
	'services' => file_get_contents('/drupal/sites/default/services.yml'),
]);`)) as { settings: string; services: string };
		return {
			settings: out.settings.replace(
				/\$settings\['hash_salt'\] = '[^']+';/,
				"$settings['hash_salt'] = '<salt>';"
			),
			services: out.services
		};
	});
}

describe('the files a boot writes', () => {
	for (const [name, vars] of Object.entries(CASES)) {
		it(`writes settings.php and services.yml byte for byte as before: ${name}`, async () => {
			const got = await bootFiles(vars);
			if (LIVE === undefined) {
				console.log(`GOLDEN ${name} ${JSON.stringify(got)}`);
				return;
			}
			expect(got.settings).toBe(LIVE[name]!.settings);
			expect(got.services).toBe(LIVE[name]!.services);
		}, 900_000);
	}
});
