import { WORDPRESS_CLAIM_PHP } from '../site/generated/assets';
import { HOST_HELPERS } from '../site/shims/host-helpers';
import { phpRender } from '../util/php';

/** what the owner supplies when claiming a WordPress site */
export interface WordpressClaim {
	/** the site origin the stored `siteurl` and `home` rows are set to */
	origin: string;
	/** the administrator's password; never read back, logged or stored outside WordPress's hash */
	adminPass: string;
	/** the administrator's login; `admin` when absent */
	adminName?: string;
	/** the administrator's address, and the site's when `siteMail` is absent */
	adminMail?: string;
	/** `blogname` */
	siteName?: string;
	/** `admin_email` */
	siteMail?: string;
}

/**
 * The PHP that creates the first administrator through `wp_insert_user`, so the hash is WordPress's
 * own, and prints one JSON object that never carries the password.
 *
 * The payload is JSON inside a PHP string literal, as Drupal's claim embeds its own.
 */
export function wordpressClaim(options: WordpressClaim): string {
	const payload = JSON.stringify({
		origin: options.origin,
		adminPass: options.adminPass,
		adminName: options.adminName ?? null,
		adminMail: options.adminMail ?? null,
		siteName: options.siteName ?? null,
		siteMail: options.siteMail ?? null
	});
	return phpRender(WORDPRESS_CLAIM_PHP, { HOST_HELPERS, PAYLOAD: JSON.stringify(payload) });
}
