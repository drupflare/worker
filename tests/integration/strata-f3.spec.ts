import { describe, expect, it } from 'vitest';
import { BOOT_KERNEL } from '../../src/drupal/site-php';
import { enable, migrate, packedContrib, REQUEST_TIMEOUT } from '../helpers/contrib-pack';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

const PROBE = String.raw`<?php
if (!defined('CSS_COMPONENT')) { require_once '/drupal/core/includes/common.inc'; }
\Drupal::service('request_stack')->push(\Symfony\Component\HttpFoundation\Request::create('/', 'GET'));
\Drupal::moduleHandler()->loadAll();
$s = \Drupal::service('Drupal\strata\Capture\CaptureScope');
echo json_encode(['config' => (bool) \Drupal::config('strata.settings')->get('enabled'), 'isEnabled' => $s->isEnabled(), 'coversUser' => $s->coversEntityType('user')]);`;

const ENABLE_SAVE = String.raw`<?php
\Drupal::configFactory()->getEditable('strata.settings')->set('enabled', TRUE)->save();
echo json_encode(['saved' => true]);`;

const RESET = String.raw`<?php
\Drupal::service('strata.capture_scope')->reset();
echo json_encode(['reset' => true]);`;

async function arm(withReset: boolean) {
	return inObject(freshSite(), async (site: ServeDo) => {
		await migrate(site);
		await enable(site, 'strata');
		await enable(site, 'strata_s3');
		await site.runJson(BOOT_KERNEL);
		// the packed container predates the driver change; reconciliation drops it on a real site
		await site.runJson(
			`<?php\n\\Drupal::database()->delete('cache_container')->execute();\necho json_encode(['dropped' => true]);`
		);
		await site.runJson(BOOT_KERNEL);
		const resettable = await site.runJson(
			`<?php\nif (!defined('CSS_COMPONENT')) { require_once '/drupal/core/includes/common.inc'; }\n$r = \\Drupal::getContainer()->get('drupflare.request_resetter');\n$p = new \\ReflectionProperty($r, 'resettable'); $p->setAccessible(TRUE);\necho json_encode(['has' => in_array('strata.capture_scope', $p->getValue($r), TRUE), 'count' => count($p->getValue($r))]);`
		);
		console.log(`[f3] resettable ${JSON.stringify(resettable)}`);
		await site.fetch(new Request('https://do.local/__serve?path=/&edge=0'));
		await site.runJson(BOOT_KERNEL);
		const before = await site.runJson(PROBE);
		await site.runJson(ENABLE_SAVE);
		if (withReset) await site.runJson(RESET);
		const served = await site.fetch(
			new Request(
				`https://do.local/__serve?path=${encodeURIComponent('/?rig=' + Math.random())}&edge=0`
			)
		);
		const servedStatus = served.status;
		await site.runJson(BOOT_KERNEL);
		const after = await site.runJson(PROBE);
		return { before, servedStatus, after };
	});
}

describe('strata capture scope across a persistent interpreter', () => {
	it(
		'keeps the stale scope after a settings save, and the reset clears it',
		async (ctx) => {
			if (!(await packedContrib()).has('strata')) {
				ctx.skip('strata not in pack');
				return;
			}
			const stale = await arm(false);
			const control = await arm(true);
			console.log(`[f3] stale ${JSON.stringify(stale)}`);
			console.log(`[f3] control ${JSON.stringify(control)}`);
			expect(stale.after['isEnabled']).toBe(true);
			expect(control.after['isEnabled']).toBe(true);
		},
		REQUEST_TIMEOUT
	);
});
