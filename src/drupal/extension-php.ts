import {
	ADMIN_PASSWORD_PHP,
	EXTENSIONS_LIST_PHP,
	THEME_DEFAULT_PHP,
	UNINSTALL_MODULE_PHP
} from '../site/generated/assets';
import { phpRender } from '../util/php';
import { FIBER_SHIM, kernelBoot } from './cron-php';

/** a module machine name, which is also the only shape the uninstall script accepts */
export const MODULE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Uninstalls one module through Drupal's installer after reading its enabled dependents and the
 * installer's own refusals. With `dry` it reads and changes nothing.
 *
 * @param name a machine name matching {@link MODULE_NAME}
 * @param origin a `scheme://host[:port]`, so URLs Drupal builds during the write are this site's
 */
export function uninstallModulePhp(name: string, dry: boolean, origin = ''): string {
	if (!MODULE_NAME.test(name)) throw new Error('not a module name');
	return phpRender(UNINSTALL_MODULE_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? '')))),
		MODULE: name,
		DRY: dry ? 'true' : 'false'
	});
}

/**
 * Lists every module, theme and install profile Drupal discovers, with the version its info file
 * states and whether `core.extension` has it enabled. Reads only.
 *
 * @param origin a `scheme://host[:port]`, so URLs Drupal builds during the read are this site's
 */
export function extensionsListPhp(origin = ''): string {
	return phpRender(EXTENSIONS_LIST_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? ''))))
	});
}

/** which theme setting a request changes */
export type ThemeTarget = 'default' | 'admin';

/** what `/theme-default` takes after validation */
export type ThemeDefaultRequest = { project: string; target: ThemeTarget };

/**
 * Reads `system.theme` and the installed themes, and when `want` is given sets that one key through
 * `ConfigFactory`, so the config cache is cleared with the row.
 *
 * @param origin a `scheme://host[:port]`, so URLs Drupal builds during the write are this site's
 */
export function themeDefaultPhp(want: ThemeDefaultRequest | undefined, origin = ''): string {
	return phpRender(THEME_DEFAULT_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? '')))),
		PAYLOAD: btoa(JSON.stringify(want ?? null))
	});
}

/**
 * Sets the password of user 1 through the entity API, so Drupal hashes it and ends that user's
 * other sessions.
 *
 * @param password the new password, carried base64 so no character reaches the PHP source
 * @param origin a `scheme://host[:port]`, so URLs Drupal builds during the write are this site's
 */
export function adminPasswordPhp(password: string, origin = ''): string {
	return phpRender(ADMIN_PASSWORD_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? '')))),
		PAYLOAD: btoa(password)
	});
}
