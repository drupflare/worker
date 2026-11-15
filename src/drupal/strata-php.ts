import type { StrataStoreRequest } from '../ops/strata-config';
import { STRATA_CONFIG_PHP, STRATA_STORE_PHP } from '../site/generated/assets';
import { phpRender } from '../util/php';
import { FIBER_SHIM, kernelBoot } from './cron-php';

/**
 * Sets `capture.statements` on `strata.settings` through `ConfigFactory`, so `cache_config` is
 * cleared with the row. Refuses to save when the object has no row.
 *
 * @param origin a `scheme://host[:port]`, so URLs Drupal builds during the write are this site's
 */
export function strataConfigPhp(captureStatements: boolean, origin = ''): string {
	return phpRender(STRATA_CONFIG_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? '')))),
		VALUE: captureStatements ? 'true' : 'false'
	});
}

/**
 * Points Strata at an S3-compatible bucket through `ConfigFactory`, and makes the encryption key
 * through Strata's own `KeyMaker` when `key` is empty. A key made before a failed save is deleted.
 * The values travel as one base64 string literal, so no quoting rule applies to them.
 *
 * @param origin a `scheme://host[:port]`, so URLs Drupal builds during the write are this site's
 */
export function strataStorePhp(want: StrataStoreRequest, origin = ''): string {
	return phpRender(STRATA_STORE_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? '')))),
		PAYLOAD: btoa(JSON.stringify(want))
	});
}
