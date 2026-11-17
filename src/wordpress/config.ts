import { createHmac } from 'node:crypto';
import { phpQuoted } from './site-php';

/** the constants WordPress reads its keys and salts from, in the order `wp-config.php` lists them */
export const SALT_NAMES = [
	'AUTH_KEY',
	'SECURE_AUTH_KEY',
	'LOGGED_IN_KEY',
	'NONCE_KEY',
	'AUTH_SALT',
	'SECURE_AUTH_SALT',
	'LOGGED_IN_SALT',
	'NONCE_SALT'
] as const;

/** the database name the translator answers for; WordPress only echoes it into messages */
export const DB_NAME = 'wordpress';

/** what `wp-config.php` is built from */
export interface WpConfigValues {
	/** the site origin, `scheme://host[:port]` */
	origin: string;
	/** one value per name in {@link SALT_NAMES} */
	salts: Readonly<Record<(typeof SALT_NAMES)[number], string>>;
	/** the table prefix the baked database uses */
	tablePrefix?: string;
}

/**
 * Eight salts from one per-site secret, one HMAC each, so the secret stays the only stored value
 * and no two constants share a value.
 */
export function deriveSalts(secret: string): WpConfigValues['salts'] {
	const out = {} as Record<(typeof SALT_NAMES)[number], string>;
	for (const name of SALT_NAMES) {
		out[name] = createHmac('sha256', secret).update(`wordpress:${name}`).digest('hex');
	}
	return out;
}

/**
 * The text of `wp-config.php`: constants and the prefix, then the settings file.
 *
 * Nothing here is read from the pack. The origin and the salts belong to the site, and the database
 * constants name the bridge: `db.php` replaces `wpdb`, so no host or password is ever used. The bridge
 * starts every session in the mode `wpdb` sets after connecting (`BRIDGE_SQL_MODE`), which is why
 * this file sends no `SET` of its own.
 */
export function wpConfigText(values: WpConfigValues): string {
	const define = (name: string, value: string | boolean): string =>
		`define( '${name}', ${typeof value === 'boolean' ? String(value) : phpQuoted(value)} );`;
	return [
		'<?php',
		define('DB_NAME', DB_NAME),
		define('DB_USER', 'bridge'),
		define('DB_PASSWORD', ''),
		define('DB_HOST', 'bridge'),
		define('DB_CHARSET', 'utf8mb4'),
		define('DB_COLLATE', ''),
		...SALT_NAMES.map((name) => define(name, values.salts[name])),
		`$table_prefix = ${phpQuoted(values.tablePrefix ?? 'wp_')};`,
		define('WP_HOME', values.origin),
		define('WP_SITEURL', values.origin),
		define('DISALLOW_FILE_MODS', true),
		define('DISABLE_WP_CRON', true),
		define('WP_HTTP_BLOCK_EXTERNAL', true),
		define('WP_DEBUG', false),
		define('WP_CACHE', false),
		define('FS_METHOD', 'direct'),
		"if ( ! defined( 'ABSPATH' ) ) {",
		"\tdefine( 'ABSPATH', __DIR__ . '/' );",
		'}',
		"require_once ABSPATH . 'wp-settings.php';",
		''
	].join('\n');
}
