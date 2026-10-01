import { SETTINGS_OVERRIDE_PHP } from '../site/generated/assets';
import { renderTemplate } from '../util/template';

/** the PHP expressions the settings override embeds; each is already valid PHP source */
export interface SettingsOverrideValues {
	/** the pinned site origin as a PHP string literal */
	origin: string;
	/** `true` or `false` */
	argon2: boolean;
	/** a PHP array literal of cache bin names */
	memoryBins: string;
	/** a PHP integer literal */
	memoryItems: number;
	/** this object's rowid residue class, a PHP integer literal */
	lane: number;
	/** how many residue classes there are, a PHP integer literal */
	lanes: number;
	/** PSR-4 registrations for libraries delivered after the pack */
	packageAutoload: string;
	/** `DRUPAL_ENV_*` and `DRUPAL_CONFIG` assignments from the deployment */
	deploymentEnv: string;
}

/**
 * The text appended to the mounted `settings.php` to point the site at this driver.
 *
 * Appended rather than substituted: a later assignment wins, and settings.php is required from
 * inside `Settings::initialize()` with `$app_root`, `$site_path` and `$class_loader` in scope.
 * Core's sqlite namespace must be re-registered: our Connection extends it, and replacing the
 * default connection removes the only entry that registered it.
 */
export function settingsOverride(values: SettingsOverrideValues): string {
	return `\n\n${renderTemplate(SETTINGS_OVERRIDE_PHP, {
		LANE: String(values.lane),
		LANES: String(values.lanes),
		SITE_ORIGIN: values.origin,
		ARGON2: values.argon2 ? 'true' : 'false',
		MEMORY_BINS: values.memoryBins,
		MEMORY_ITEMS: String(values.memoryItems),
		PACKAGE_AUTOLOAD: values.packageAutoload,
		DEPLOYMENT_ENV: values.deploymentEnv
	})}`;
}

/**
 * Points Drupal's `page` bin at a null backend, and carries the file stream wrappers.
 *
 * `cache_page` duplicates bytes the object already stores in its own SQL (12 rows per front-page
 * fill, 4 of them this bin; rows written binds regeneration). `dynamic_page_cache` and `render`
 * stay: warm, they let a fill reassemble instead of render.
 *
 * A services file, not `$settings['cache']['bins']`: core registers `cache.backend.null` from a
 * compiler pass, and a bare `stream_wrapper_register()` loses to `StreamWrapperManager`.
 *
 * The filename is load-bearing: the shipped `settings.php` appends this exact path unconditionally
 * and `getContainerCacheKey()` folds in the raw setting while `addServiceFiles()` filters to files
 * that exist, so creating it changes the container without moving the cache key.
 */
export { SERVICES_YAML } from '../site/generated/assets';
