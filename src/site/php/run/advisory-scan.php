<?php

use Drupal\drupflare\Update\AdvisoryScan;

// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ran' => false];
$clock = function () {
	return microtime(true) * 1000;
};
$t0 = $clock();

try {
	// __CFW_KERNEL_BOOT__

	$class = AdvisoryScan::class;
	if (!class_exists($class)) {
		$out['reason'] = 'the drupflare module is not installed';
	} else {
		$scan = new AdvisoryScan(Drupal::state(), Drupal::service('keyvalue'));
		$out['record'] = $scan->scan(time());
		$out['ran'] = true;
	}
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
}

$out['ms'] = round($clock() - $t0, 2);
echo json_encode($out);
