import { describe, expect, it } from 'vitest';
import {
	DB_NAME,
	MULTISITE_CONSTANTS,
	SALT_NAMES,
	WpConfigRefused,
	deriveSalts,
	wpConfigText
} from '../../../src/wordpress/config';
import { phpQuoted } from '../../../src/wordpress/site-php';

const salts = Object.fromEntries(SALT_NAMES.map((name, i) => [name, `salt-${i}`])) as Record<
	(typeof SALT_NAMES)[number],
	string
>;

const GOLDEN = `<?php
define( 'DB_NAME', 'wordpress' );
define( 'DB_USER', 'bridge' );
define( 'DB_PASSWORD', '' );
define( 'DB_HOST', 'bridge' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );
define( 'AUTH_KEY', 'salt-0' );
define( 'SECURE_AUTH_KEY', 'salt-1' );
define( 'LOGGED_IN_KEY', 'salt-2' );
define( 'NONCE_KEY', 'salt-3' );
define( 'AUTH_SALT', 'salt-4' );
define( 'SECURE_AUTH_SALT', 'salt-5' );
define( 'LOGGED_IN_SALT', 'salt-6' );
define( 'NONCE_SALT', 'salt-7' );
$table_prefix = 'wp_';
define( 'WP_HOME', 'https://site.example:8443' );
define( 'WP_SITEURL', 'https://site.example:8443' );
define( 'DISALLOW_FILE_MODS', true );
define( 'DISABLE_WP_CRON', true );
define( 'CONCATENATE_SCRIPTS', false );
define( 'DRUPFLARE_HTTP_BUDGET', 30 );
define( 'WP_DEBUG', false );
define( 'WP_CACHE', false );
define( 'FS_METHOD', 'direct' );
if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
`;

describe('wp-config.php', () => {
	it('is the golden text for an origin and eight salts', () => {
		expect(wpConfigText({ origin: 'https://site.example:8443', salts })).toBe(GOLDEN);
	});

	it('takes the origin and the prefix from the site, never a fixed value', () => {
		const text = wpConfigText({ origin: 'http://localhost:8787', salts, tablePrefix: 'site_' });
		expect(text).toContain("define( 'WP_HOME', 'http://localhost:8787' );");
		expect(text).toContain("define( 'WP_SITEURL', 'http://localhost:8787' );");
		expect(text).toContain("$table_prefix = 'site_';");
		expect(text).not.toContain('site.example');
	});

	it('quotes a value so it cannot close its own string', () => {
		const text = wpConfigText({ origin: "http://a'b\\c", salts });
		expect(text).toContain("define( 'WP_HOME', 'http://a\\'b\\\\c' );");
		expect(phpQuoted("it's \\ $x")).toBe("'it\\'s \\\\ $x'");
	});

	it('writes constants and the settings include only, with the file-mod and cron switches off', () => {
		const text = wpConfigText({ origin: 'https://s.example', salts });
		const lines = text.split('\n').filter((l) => l !== '' && l !== '<?php');
		for (const line of lines) {
			expect(line).toMatch(
				/^(define\( '[A-Z_]+', .* \);|\$table_prefix = '.*';|if \( ! defined\( 'ABSPATH' \) \) \{|\tdefine\( 'ABSPATH', __DIR__ \. '\/' \);|\}|require_once ABSPATH \. 'wp-settings\.php';)$/
			);
		}
		expect(text).toContain("define( 'DISALLOW_FILE_MODS', true );");
		expect(text).toContain("define( 'DISABLE_WP_CRON', true );");
		expect(text).toContain("define( 'CONCATENATE_SCRIPTS', false );");
		expect(text).toContain("define( 'WP_DEBUG', false );");
		expect(DB_NAME).toBe('wordpress');
	});

	it('does not block external requests, because the host plugin answers them', () => {
		const text = wpConfigText({ origin: 'https://s.example', salts });
		expect(text).not.toContain('BLOCK_EXTERNAL');
		expect(text).toContain("define( 'DRUPFLARE_HTTP_BUDGET', 30 );");
	});

	it('takes the request budget from the plan', () => {
		const text = wpConfigText({ origin: 'https://s.example', salts, httpBudget: 500 });
		expect(text).toContain("define( 'DRUPFLARE_HTTP_BUDGET', 500 );");
	});
});

describe('constants an owner sets', () => {
	const build = (constants: Record<string, string | number | boolean>) =>
		wpConfigText({ origin: 'https://s.example', salts, constants });

	it('are written after the platform ones and before WordPress loads', () => {
		const text = build({ WP_POST_REVISIONS: 5, WP_MEMORY_LIMIT: '256M', EMPTY_TRASH_DAYS: 0 });
		expect(text).toContain("define( 'WP_POST_REVISIONS', 5 );");
		expect(text).toContain("define( 'WP_MEMORY_LIMIT', '256M' );");
		expect(text.indexOf('WP_POST_REVISIONS')).toBeGreaterThan(text.indexOf("'FS_METHOD'"));
		expect(text.indexOf('EMPTY_TRASH_DAYS')).toBeLessThan(text.indexOf('wp-settings.php'));
	});

	it.each(MULTISITE_CONSTANTS)('refuses %s by name', (name) => {
		expect(() => build({ [name]: true })).toThrow(WpConfigRefused);
		expect(() => build({ [name]: true })).toThrow(/Multisite is not supported/);
	});

	it('refuses a Multisite name in any letter case, since PHP constants are case sensitive but a typo is not a pass', () => {
		expect(() => build({ multisite: true })).toThrow(WpConfigRefused);
		expect(() => build({ Wp_Allow_Multisite: 'true' })).toThrow(WpConfigRefused);
	});

	it('refuses a name PHP cannot define and a number it cannot write', () => {
		expect(() => build({ 'A B': 1 })).toThrow(/not a constant name/);
		expect(() => build({ X: Number.NaN })).toThrow(/finite/);
	});

	it('never names a Multisite constant unless the owner did, which is refused', () => {
		expect(wpConfigText({ origin: 'https://s.example', salts })).not.toMatch(
			/MULTISITE|SUNRISE/
		);
	});

	it('leaves the golden text alone when there are none', () => {
		expect(wpConfigText({ origin: 'https://s.example', salts, constants: {} })).toBe(
			wpConfigText({ origin: 'https://s.example', salts })
		);
	});
});

describe('the salts a site derives', () => {
	it('are eight distinct 64-digit hex values from one secret', () => {
		const derived = deriveSalts('a-per-site-secret');
		const values = SALT_NAMES.map((name) => derived[name]);
		expect(new Set(values).size).toBe(8);
		for (const value of values) expect(value).toMatch(/^[0-9a-f]{64}$/);
	});

	it('repeat for the same secret and change with it', () => {
		expect(deriveSalts('one')).toEqual(deriveSalts('one'));
		expect(deriveSalts('one').AUTH_KEY).not.toBe(deriveSalts('two').AUTH_KEY);
	});

	it('never contain the secret', () => {
		const derived = deriveSalts('plain-secret-text');
		for (const name of SALT_NAMES) expect(derived[name]).not.toContain('plain-secret-text');
	});
});
