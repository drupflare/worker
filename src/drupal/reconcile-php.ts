import { FIBER_SHIM, kernelBoot } from './cron-php.js';

/**
 * The reconciliation steps that have to go through Drupal's own writers.
 *
 * `system.performance:cache.page.max_age` was fixed correctly in the `config` table and stayed inert,
 * because `cache_config` held its own serialized copy and Drupal reads the bin first. Every render on
 * every site still answered `no-store` for the whole time the fix was believed shipped.
 *
 * `ConfigFactory::save()` writes the row, clears the bin and invalidates `config:<name>`, which is
 * what makes the render caches downstream of it stale. State keeps a static cache and a
 * `cache_bootstrap` copy and `State::set()` knows about both. A host re-deriving either list gets it
 * wrong, and the copy it forgets is the one that made the original fix inert.
 *
 * The preamble is `cron-php.ts`'s, not a copy: a fragment that booted differently from the render
 * path would be changing a site other than the one that serves.
 */

/** @param origin a `scheme://host[:port]`, so URLs Drupal builds during the write are this site's */
export function reconcileConfigPhp(maxAge: number, origin = ''): string {
	const age = Math.max(0, Math.floor(maxAge));
	return String.raw`<?php
${FIBER_SHIM}
chdir('/drupal');

$out = ['ok' => false];
try {
${kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? ''))))}
  $editable = \Drupal::configFactory()->getEditable('system.performance');
  $out['before'] = (int) $editable->get('cache.page.max_age');
  $editable->set('cache.page.max_age', ${age});
  $editable->save();
  $out['after'] = (int) \Drupal::config('system.performance')->get('cache.page.max_age');
  $out['ok'] = $out['after'] === ${age};
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
  $out['at'] = $e->getFile() . ':' . $e->getLine();
}
// SEPARATELY, because the write is what has to land. Config::save() already invalidates
// config:system.performance; this is the render tier downstream of it, and a subscriber that throws
// here must not make a successful write report as a failure
try {
  \Drupal\Core\Cache\Cache::invalidateTags(['config:system.performance', 'rendered']);
  $out['invalidated'] = true;
} catch (\Throwable $e) {
  $out['invalidateError'] = get_class($e) . ': ' . $e->getMessage();
}
echo json_encode($out);
`;
}

/** stamps the site's own birthday over the one the pack was baked with */
export function reconcileClockPhp(claimedAtSeconds: number, origin = ''): string {
	const at = Math.max(0, Math.floor(claimedAtSeconds));
	return String.raw`<?php
${FIBER_SHIM}
chdir('/drupal');

$out = ['ok' => false];
try {
${kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? ''))))}
  $state = \Drupal::state();
  $out['before'] = [
    'install_time' => (int) $state->get('install_time', 0),
    'cron_last' => (int) $state->get('system.cron_last', 0),
  ];
  if ((int) $state->get('install_time', 0) < ${at}) { $state->set('install_time', ${at}); }
  if ((int) $state->get('system.cron_last', 0) < ${at}) { $state->set('system.cron_last', ${at}); }
  $out['after'] = [
    'install_time' => (int) $state->get('install_time', 0),
    'cron_last' => (int) $state->get('system.cron_last', 0),
  ];
  $out['ok'] = $out['after']['install_time'] >= ${at} && $out['after']['cron_last'] >= ${at};
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
}
echo json_encode($out);
`;
}

/**
 * Rebuilds the route table, so a driver module's own routes exist on an already-provisioned site.
 *
 * THE SHIPPED PACK HAS `drupflare` IN `core.extension` AND NONE OF ITS ROUTES. Measured 2026-09-09
 * by rebuilding the pack database from `install-site-db.php` and diffing: the rebuilt file carries
 * `drupflare.admin`, `drupflare.status`, `drupflare.ops_terminal` and `drupflare.oidc_complete`
 * plus three menu links, and the shipped one carries zero of the seven. The module was enabled into
 * the pack before those routes existed and `router` was never rebuilt after, so the Drupflare admin
 * section, Runtime Status and the Operations Terminal answer 404 on every site.
 *
 * The container step next to this one cannot fix it: dropping `cache_container` makes the next boot
 * rediscover HOOKS, and `router` is a table `RouteBuilder` writes rather than a cache Drupal
 * rebuilds on demand.
 *
 * `setRebuildNeeded()` then `rebuildIfNeeded()` rather than `rebuild()` directly, because the
 * unconditional form does the work again on a site that is already current, and this runs inside an
 * alarm with a CPU budget.
 */
export function reconcileRouterPhp(origin = ''): string {
	return String.raw`<?php
${FIBER_SHIM}
chdir('/drupal');

$out = ['ok' => false];
try {
${kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? ''))))}
  $before = (int) \Drupal::database()->query('SELECT COUNT(*) FROM {router}')->fetchField();
  $builder = \Drupal::service('router.builder');
  $builder->setRebuildNeeded();
  $builder->rebuildIfNeeded();
  $after = (int) \Drupal::database()->query('SELECT COUNT(*) FROM {router}')->fetchField();
  // the menu links come from the same discovery and are the other half of what was missing
  \Drupal::service('plugin.manager.menu.link')->rebuild();
  $out['before'] = $before;
  $out['after'] = $after;
  $out['ok'] = $after > 0;
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
  $out['at'] = $e->getFile() . ':' . $e->getLine();
}
echo json_encode($out);
`;
}
