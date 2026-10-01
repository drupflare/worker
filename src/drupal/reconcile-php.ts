import {
	RECONCILE_CLOCK_PHP,
	RECONCILE_CONFIG_PHP,
	RECONCILE_DISCOVERY_PHP,
	RECONCILE_OWNER_PHP,
	RECONCILE_ROUTER_PHP,
	RECONCILE_TOOLKIT_PHP,
	RECONCILE_UNINSTALL_PHP
} from '../site/generated/assets';
import { phpRender } from '../util/php';
import { FIBER_SHIM, kernelBoot } from './cron-php';

/**
 * The reconciliation steps that have to go through Drupal's own writers.
 *
 * `ConfigFactory::save()` and `State::set()` clear every cached copy (`cache_config`,
 * `cache_bootstrap`) and invalidate `config:<name>`; a raw SQL edit leaves a cached copy that
 * shadows it. The boot preamble is `cron-php.ts`'s, so a fragment boots like the render path.
 *
 * @param origin a `scheme://host[:port]`, so URLs Drupal builds during the write are this site's
 */
export function reconcileConfigPhp(maxAge: number, origin = ''): string {
	const age = Math.max(0, Math.floor(maxAge));
	return phpRender(RECONCILE_CONFIG_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? '')))),
		AGE: String(age)
	});
}

/** stamps the site's own birthday over the one the pack was baked with */
export function reconcileClockPhp(claimedAtSeconds: number, origin = ''): string {
	const at = Math.max(0, Math.floor(claimedAtSeconds));
	return phpRender(RECONCILE_CLOCK_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? '')))),
		AT: String(at)
	});
}

/**
 * Moves a site onto the three owner tiers and gives uid 1 the owner role.
 *
 * Retired names are revoked before any save: `Role::save()` throws on an undeclared permission.
 */
export function reconcileOwnerPhp(renamed: Record<string, string>, origin = ''): string {
	return phpRender(RECONCILE_OWNER_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? '')))),
		RENAMED: JSON.stringify(JSON.stringify(renamed))
	});
}

/**
 * Fills the discovery bin the digest step emptied, without rendering anything.
 *
 * Entity types, the field map and every `plugin.manager.*` definition list. A manager that throws
 * is named and skipped; the next render rebuilds what is missing.
 */
export function reconcileDiscoveryPhp(origin = ''): string {
	return phpRender(RECONCILE_DISCOVERY_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? ''))))
	});
}

/**
 * Rebuilds the route table, so a driver module's own routes exist on an already-provisioned site.
 *
 * The pack enabled `drupflare` before its routes existed and never rebuilt `router`, and dropping
 * `cache_container` does not help (`router` is a table `RouteBuilder` writes, not a cache).
 * `setRebuildNeeded()` then `rebuildIfNeeded()` rather than `rebuild()`, which would redo the work
 * on a current site inside an alarm's CPU budget.
 */
export function reconcileRouterPhp(origin = ''): string {
	return phpRender(RECONCILE_ROUTER_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? ''))))
	});
}

/**
 * Points `system.image` at the toolkit this runtime can serve.
 *
 * A migrated site arrives set to `gd` (not compiled in) or `imagemagick` (shells out to `convert`),
 * so every image style fails until the toolkit is `cfw_images`.
 */
export function reconcileToolkitPhp(origin = ''): string {
	return phpRender(RECONCILE_TOOLKIT_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? ''))))
	});
}

/**
 * Uninstalls modules whose whole job this runtime does another way.
 *
 * `automatic_updates` and `project_browser` rewrite the codebase with composer (updates here come
 * from `drangler update` and reconciliation); `mongodb_watchdog` logs to a MongoDB the runtime
 * cannot reach.
 */
export function reconcileUninstallPhp(modules: readonly string[], origin = ''): string {
	return phpRender(RECONCILE_UNINSTALL_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? '')))),
		MODULES: JSON.stringify(JSON.stringify(modules))
	});
}
