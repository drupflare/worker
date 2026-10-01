<?php

use Drupal\Core\Cache\Cache;

// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ok' => false];
try {
	// __CFW_KERNEL_BOOT__
	$editable = Drupal::configFactory()->getEditable('system.performance');
	$out['before'] = (int) $editable->get('cache.page.max_age');
	$editable->set('cache.page.max_age', __CFW_AGE__);
	$editable->save();
	$out['after'] = (int) Drupal::config('system.performance')->get('cache.page.max_age');
	$out['ok'] = $out['after'] === __CFW_AGE__;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['at'] = $e->getFile() . ':' . $e->getLine();
}
// SEPARATELY, because the write is what has to land. Config::save() already invalidates
// config:system.performance; this is the render tier downstream of it, and a subscriber that throws
// here must not make a successful write report as a failure
try {
	Cache::invalidateTags(['config:system.performance', 'rendered']);
	$out['invalidated'] = true;
} catch (Throwable $e) {
	$out['invalidateError'] = get_class($e) . ': ' . $e->getMessage();
}
echo json_encode($out);
