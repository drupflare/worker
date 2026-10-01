<?php
// __CFW_FIBER_SHIM__
// __CFW_LISTENER_SHAPE__
chdir('/drupal');

$out = [];
$clock = function () {
	return microtime(true) * 1000;
};
$t0 = $clock();

try {
	// __CFW_KERNEL_BOOT__
	// __CFW_COLLECT_CRON_LISTENERS__
	$shapes = [];
	foreach ($found as $m => $listeners) {
		foreach ($listeners as $listener) {
			$shapes[$m][] = cfw_listener_shape($listener);
		}
	}
	$out['shapes'] = $shapes;
	$out['queues'] = [];
	foreach (Drupal::service('plugin.manager.queue_worker')->getDefinitions() as $id => $def) {
		$out['queues'][$id] = isset($def['cron']) ? $def['cron']['time'] ?? 0 : null;
	}
	$out['advisoriesEnabled'] = (bool) Drupal::config('system.advisories')->get('enabled');
	$out['dblogRowLimit'] = (int) Drupal::config('dblog.settings')->get('row_limit');
	$out['cacheDataMaxRows'] = (int) Drupal::service('cache.data')->getMaxRows();
	$out['ok'] = true;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
}

$out['ms'] = round($clock() - $t0, 2);
echo json_encode($out);
