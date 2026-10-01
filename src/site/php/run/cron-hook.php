<?php

use Drupal\Core\Session\AnonymousUserSession;

// __CFW_FIBER_SHIM__
chdir('/drupal');

$module = json_decode(__CFW_MODULE__);
$out = ['module' => $module, 'ran' => false];
$clock = function () {
	return microtime(true) * 1000;
};
$t0 = $clock();

try {
	// __CFW_KERNEL_BOOT__
	// __CFW_COLLECT_CRON_LISTENERS__

	if (!isset($found[$module])) {
		$out['reason'] = 'no cron implementation';
	} elseif (count($found[$module]) > 1) {
		// core's own invariant; ModuleHandler::invoke() raises LogicException here
		$out['reason'] = 'more than one implementation';
		$out['count'] = count($found[$module]);
	} else {
		$switcher = null;
		try {
			$switcher = Drupal::service('account_switcher');
			$switcher->switchTo(new AnonymousUserSession());
		} catch (Throwable $e) {
			$out['switchError'] = $e->getMessage();
			$switcher = null;
		}
		$fn = $found[$module][0];
		$a = $clock();
		try {
			call_user_func($fn);
			$out['ran'] = true;
		} catch (Throwable $e) {
			$out['error'] = get_class($e) . ': ' . $e->getMessage();
			$out['trace'] = substr($e->getTraceAsString(), 0, 800);
		}
		$out['hookMs'] = round($clock() - $a, 2);
		if ($switcher !== null) {
			try {
				$switcher->switchBack();
			} catch (Throwable $e) {
			}
		}
	}
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
}

$out['ms'] = round($clock() - $t0, 2);
echo json_encode($out);
