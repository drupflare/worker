import { describe, expect, it } from 'vitest';
import { isNeverDrupal, phpEntryRedirect } from '../../src/site';
import { denyProbe } from '../../src/site/screen';
import type { FrontContext } from '../../src/site/types';

/**
 * Core links to `/update.php`, and this platform answered it with plain text.
 *
 * The Extend page renders "Always run the update script each time you update software" with a link
 * to `/update.php`. That path is matched by the `\.php$` deny pattern along with every scanner
 * probe, so a site administrator following a link Drupal itself rendered got `not found` in
 * plain text -- not even the site's own 404.
 *
 * The deny is still right for everything else: it exists because `PageCache` writes one PERMANENT
 * `cache_data` row per distinct URL, so a scanner walking `.php` paths is unbounded growth against
 * an account-wide storage cap. What was wrong is that three of those paths are links rather than
 * probes.
 */
describe('the core PHP entry points', () => {
	it('redirects the paths core actually links', () => {
		expect(phpEntryRedirect('/update.php')).toBe('/admin/config/drupflare/status');
		expect(phpEntryRedirect('/install.php')).toBe('/');
		expect(phpEntryRedirect('/cron.php')).toBe('/admin/config/drupflare/status');
	});

	it('covers the /core/ spellings, which are the ones core builds', () => {
		expect(phpEntryRedirect('/core/update.php')).toBe('/admin/config/drupflare/status');
		expect(phpEntryRedirect('/core/install.php')).toBe('/');
	});

	it('is case-insensitive, because a link is typed as often as it is clicked', () => {
		expect(phpEntryRedirect('/Update.php')).toBe('/admin/config/drupflare/status');
	});

	it('leaves every other .php path to the deny, which is what bounds the storage', () => {
		for (const probe of [
			'/wp-login.php',
			'/phpmyadmin/index.php',
			'/xmlrpc.php',
			'/admin.php',
			'/shell.php'
		]) {
			expect(phpEntryRedirect(probe), probe).toBeUndefined();
			// still denied, so the redirect did not widen what reaches the object
			expect(isNeverDrupal(probe), probe).toBe(true);
		}
	});

	it('does not redirect a path that was never denied in the first place', () => {
		expect(phpEntryRedirect('/node/1')).toBeUndefined();
		expect(phpEntryRedirect('/admin/modules')).toBeUndefined();
	});
});

describe('the front worker deny stage', () => {
	const at = (path: string, serving = true) => ({ serving, path }) as FrontContext;

	it('redirects a linked entry point before it denies', () => {
		const res = denyProbe(at('/update.php?x=1'), true);
		expect(res?.status).toBe(302);
		expect(res?.headers.get('location')).toBe('/admin/config/drupflare/status');
		expect(res?.headers.get('x-cfw-deny')).toBe('php-entry-point');
	});

	it('answers a scanner probe with the cheap 404', () => {
		const res = denyProbe(at('/wp-login.php'), true);
		expect(res?.status).toBe(404);
		expect(res?.headers.get('x-cfw-deny')).toBe('never-drupal');
		expect(res?.headers.get('x-cfw-cache')).toBe('DENY');
	});

	it('passes an ordinary page and anything off the serving path', () => {
		expect(denyProbe(at('/node/1'), false)).toBeUndefined();
		expect(denyProbe(at('/wp-login.php', false), true)).toBeUndefined();
	});
});
