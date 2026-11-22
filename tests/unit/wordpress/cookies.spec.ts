import { beforeEach, describe, expect, it } from 'vitest';
import {
	MAX_NAMED_COOKIES,
	noteUnclassifiedCookies,
	resetUnclassifiedCookies,
	unclassifiedCookieStats,
	withoutTrackingCookies
} from '../../../src/wordpress/cookies';
import { freshSite, inObject } from '../../helpers/serve-do';

const WP = { CMS: 'wordpress' };
const H = 'a'.repeat(32);

const ask = (cookie: string | undefined, env: unknown = WP, extra: Record<string, string> = {}) =>
	withoutTrackingCookies(
		new Request('https://x.test/hello/', {
			headers: cookie === undefined ? extra : { cookie, ...extra }
		}),
		env
	);

describe('dropping analytics and consent cookies before a page is read', () => {
	it('gives a visitor with only those cookies the request a visitor with none would send', () => {
		for (const cookie of [
			'_ga=GA1.2.3',
			'_ga=1; _gid=2; _fbp=fb.1.2; cookielawinfo-checkbox-necessary=yes',
			'_ga_ABC123XYZ9=GS1.1; CookieConsent={stamp:%27x%27}',
			''
		]) {
			expect(ask(cookie).headers.has('cookie'), cookie).toBe(false);
		}
	});

	it('keeps wordpress_test_cookie, which wp-login.php needs, and drops the rest', () => {
		const res = ask('_ga=1; wordpress_test_cookie=WP%20Cookie%20check; _gid=2');
		expect(res.headers.get('cookie')).toBe('wordpress_test_cookie=WP%20Cookie%20check');
	});

	it('leaves the request as it came when anything else identifies the visitor', () => {
		for (const cookie of [
			`_ga=1; wordpress_logged_in_${H}=x`,
			`wordpress_sec_${H}=x; _gid=2`,
			`comment_author_${H}=x; _ga=1`,
			'_ga=1; wp-settings-1=x',
			'_ga=1; plugin_cart=3',
			'_ga=1; _ga_session_admin=1'
		]) {
			const asked = new Request('https://x.test/', { headers: { cookie } });
			expect(withoutTrackingCookies(asked, WP), cookie).toBe(asked);
		}
	});

	it('returns the same request when there is nothing to drop', () => {
		const none = new Request('https://x.test/');
		expect(withoutTrackingCookies(none, WP)).toBe(none);
		const test = new Request('https://x.test/', {
			headers: { cookie: 'wordpress_test_cookie=1' }
		});
		expect(withoutTrackingCookies(test, WP)).toBe(test);
	});

	it('does nothing for Drupal or an unknown CMS, whose cookie handling is its own', () => {
		for (const env of [{}, { CMS: 'drupal' }, { CMS: 'joomla' }, undefined]) {
			const asked = new Request('https://x.test/', { headers: { cookie: '_ga=1' } });
			expect(withoutTrackingCookies(asked, env), JSON.stringify(env)).toBe(asked);
		}
	});

	it('keeps the method, the other headers and a body', async () => {
		const posted = new Request('https://x.test/wp-comments-post.php', {
			method: 'POST',
			headers: { cookie: '_ga=1', 'content-type': 'application/x-www-form-urlencoded' },
			body: 'comment=hi'
		});
		const res = withoutTrackingCookies(posted, WP);
		expect(res.method).toBe('POST');
		expect(res.headers.has('cookie')).toBe(false);
		expect(res.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
		expect(await res.text()).toBe('comment=hi');
	});
});

describe('counting a request identified only by an unclassified cookie', () => {
	beforeEach(resetUnclassifiedCookies);

	const note = (cookie: string, extra: Record<string, string> = {}) =>
		noteUnclassifiedCookies(new Request('https://x.test/', { headers: { cookie, ...extra } }));

	it('counts each name once per request and reads no value', () => {
		note('plugin_cart=secret-value; other=1; plugin_cart=again');
		note('plugin_cart=3');
		const stats = unclassifiedCookieStats();
		expect(stats.requests).toBe(2);
		expect(stats.names).toEqual({ plugin_cart: 2, other: 1 });
		expect(JSON.stringify(stats)).not.toContain('secret-value');
	});

	it('does not count a request a login, a personal cookie or an Authorization header explains', () => {
		note(`plugin_cart=1; wordpress_logged_in_${H}=x`);
		note('plugin_cart=1; wp-settings-1=x');
		note('plugin_cart=1', { authorization: 'Basic YTpi' });
		note('_ga=1; _gid=2');
		expect(unclassifiedCookieStats()).toEqual({ requests: 0, names: {}, other: 0 });
	});

	it('cuts a name to a log-safe form and bounds how many names it keeps', () => {
		note(`${'n'.repeat(100)}=1`);
		expect(Object.keys(unclassifiedCookieStats().names)[0]).toHaveLength(48);
		resetUnclassifiedCookies();
		for (let i = 0; i < MAX_NAMED_COOKIES + 5; i++) note(`c${i}=1`);
		const stats = unclassifiedCookieStats();
		expect(Object.keys(stats.names)).toHaveLength(MAX_NAMED_COOKIES);
		expect(stats.requests).toBe(MAX_NAMED_COOKIES + 5);
		expect(stats.other).toBe(5);
	});

	it('hands out a copy, so a reader cannot change the counts', () => {
		note('plugin_cart=1');
		unclassifiedCookieStats().names['plugin_cart'] = 99;
		expect(unclassifiedCookieStats().names['plugin_cart']).toBe(1);
	});

	it('reaches /serve-stats on a WordPress object and not on a Drupal one', async () => {
		note('plugin_cart=1');
		const read = (cms: string) =>
			inObject(freshSite(), (site) => {
				site.env['CMS'] = cms;
				return (
					site as unknown as { serveStatsSync(): Record<string, unknown> }
				).serveStatsSync();
			});
		expect((await read('wordpress'))['unclassifiedCookies']).toEqual({
			requests: 1,
			names: { plugin_cart: 1 },
			other: 0
		});
		expect(await read('drupal')).not.toHaveProperty('unclassifiedCookies');
	});
});
