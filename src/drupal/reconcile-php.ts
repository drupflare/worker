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
