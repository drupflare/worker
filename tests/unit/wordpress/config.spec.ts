import { describe, expect, it } from 'vitest';
import { DB_NAME, SALT_NAMES, deriveSalts, wpConfigText } from '../../../src/wordpress/config';
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
define( 'WP_HTTP_BLOCK_EXTERNAL', true );
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
		// the curl shim lacks the constants WordPress's transport test reads, so a request would fatal
		expect(text).toContain("define( 'WP_HTTP_BLOCK_EXTERNAL', true );");
		expect(text).toContain("define( 'WP_DEBUG', false );");
		expect(DB_NAME).toBe('wordpress');
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
