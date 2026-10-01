<?php

use Drupal\drupflare\Health\BootSelfTest;
use Drupal\drupflare\Health\HealthLedger;
use Drupal\drupflare\Health\TripwireRegistry;

// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ran' => false, 'findings' => [], 'recorded' => 0, 'mayServe' => true];
$clock = function () {
	return microtime(true) * 1000;
};
$t0 = $clock();

try {
	$autoload = '/drupal/autoload.php';
	if (!is_object($GLOBALS['__pw_autoloader'] ?? null)) {
		// require, never require_once: a second include answers TRUE rather than the ClassLoader,
		// and a heap restore lands in exactly that state
		$GLOBALS['__pw_autoloader'] = require $autoload;
	}
	$loader = $GLOBALS['__pw_autoloader'];
	if (is_object($loader)) {
		$loader->addPsr4('Drupal\\drupflare\\', '/drupal/modules/custom/drupflare/src/');
	}

	$boot = BootSelfTest::class;
	$registry = TripwireRegistry::class;
	$ledger = HealthLedger::class;
	if (!class_exists($boot)) {
		$out['reason'] = 'the drupflare module is not installed';
	} else {
		$observation = json_decode(__CFW_OBSERVATION__, true);
		if (!is_array($observation)) {
			$observation = [];
		}
		$findings = $boot::run($observation);
		// the tripwires take the same bag; the ones needing a render simply find nothing in it
		$findings = array_merge($findings, (new $registry())->run($observation));

		$out['mayServe'] = $boot::mayServe($findings);
		$out['recorded'] = $ledger::recordAll($findings);
		foreach ($findings as $finding) {
			$out['findings'][] = $finding->toArray();
		}
		$out['ran'] = true;
	}
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
}

$out['ms'] = round($clock() - $t0, 2);
echo json_encode($out);
