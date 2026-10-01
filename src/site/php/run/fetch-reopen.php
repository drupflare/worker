<?php

use Drupal\drupflare\Hook\DeferredCron;

// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ran' => false];
$clock = function () {
	return microtime(true) * 1000;
};
$t0 = $clock();

try {
	// __CFW_KERNEL_BOOT__

	$class = DeferredCron::class;
	if (!class_exists($class)) {
		$out['reason'] = 'the drupflare module is not installed';
	} else {
		$releases = Drupal::service('keyvalue.expirable')->get('update_available_releases');
		$before = 0;
		foreach ($releases->getAll() as $data) {
			if (is_array($data) && ($data['project_status'] ?? null) === 'not-fetched') {
				$before++;
			}
		}
		$reopen = new DeferredCron(
			Drupal::state(),
			Drupal::configFactory(),
			Drupal::service('keyvalue'),
			Drupal::service('keyvalue.expirable'),
		);
		$reopen->cron();
		$out['unanswered'] = $before;
		$out['reopened'] = $before > 0;
		$out['ran'] = true;
	}
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
}

$out['ms'] = round($clock() - $t0, 2);
echo json_encode($out);
