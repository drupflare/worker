import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const WP_PORT = Number(process.env.CFW_WP_BROWSER_PORT ?? 8793);

/** WordPress redirects to its configured home, so the browser and `SITE_ORIGIN` must agree on this */
export const WP_ORIGIN = process.env.CFW_WP_BROWSER_URL ?? `http://localhost:${WP_PORT}`;

export const WP_ADMIN_USER = 'owner';
export const WP_ADMIN_PASS = 'wp-browser-lane-pw-1';

/** what the claim names the site, which is how a spec tells a real render from the baked one */
export const WP_SITE_NAME = 'WP Browser Lane';

/** where the global setup keeps the signed-in session */
export const WP_SESSION_FILE = join(
	tmpdir(),
	`drupflare-wordpress-browser-session-${WP_PORT}.json`
);

/** where the global setup keeps the owner token the claim returned, because a second claim answers 409 */
export const WP_OWNER_FILE = join(tmpdir(), `drupflare-wordpress-browser-owner-${WP_PORT}.json`);

/** the static files a WordPress page links to, which the asset layer answers; `.php` stays with the worker */
export const ASSET_PATH =
	/^\/(wp-includes|wp-admin|wp-content\/themes)\/.+\.(css|js|svg|png|gif|jpe?g|webp|woff2?|ttf|eot)$/i;
