<?php
// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ok' => false];
try {
	// __CFW_KERNEL_BOOT__
	$state = Drupal::state();
	$out['before'] = [
		'install_time' => (int) $state->get('install_time', 0),
		'cron_last' => (int) $state->get('system.cron_last', 0),
	];
	if ((int) $state->get('install_time', 0) < __CFW_AT__) {
		$state->set('install_time', __CFW_AT__);
	}
	if ((int) $state->get('system.cron_last', 0) < __CFW_AT__) {
		$state->set('system.cron_last', __CFW_AT__);
	}
	$out['after'] = [
		'install_time' => (int) $state->get('install_time', 0),
		'cron_last' => (int) $state->get('system.cron_last', 0),
	];
	$out['ok'] =
		$out['after']['install_time'] >= __CFW_AT__ && $out['after']['cron_last'] >= __CFW_AT__;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
}
echo json_encode($out);
