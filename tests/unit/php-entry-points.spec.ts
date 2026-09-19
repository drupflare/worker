import { describe, expect, it } from 'vitest';
import { isNeverDrupal, phpEntryRedirect } from '../../src/site';

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
			expect(phpEntryRedirect(probe), probe).toBe(null);
			// still denied, so the redirect did not widen what reaches the object
			expect(isNeverDrupal(probe), probe).toBe(true);
		}
	});

	it('does not redirect a path that was never denied in the first place', () => {
		expect(phpEntryRedirect('/node/1')).toBe(null);
		expect(phpEntryRedirect('/admin/modules')).toBe(null);
	});
});
