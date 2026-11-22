<?php

use Symfony\Component\HttpFoundation\Request;

// __CFW_FIBER_SHIM__
chdir('/drupal');

$name = '__CFW_MODULE__';
$dryRun = __CFW_DRY__;
$out = ['ok' => false];
try {
	// __CFW_KERNEL_BOOT__
	$handler = Drupal::moduleHandler();
	$enabled = array_keys($handler->getModuleList());
	sort($enabled);
	$out['enabledModules'] = $enabled;
	if (!in_array($name, $enabled, true)) {
		$out['absent'] = true;
	} else {
		$list = Drupal::service('extension.list.module')->getList();
		$requiredBy = isset($list[$name]) ? array_keys($list[$name]->required_by ?? []) : [];
		$dependents = array_values(
			array_filter($requiredBy, function (string $m) use ($enabled): bool {
				return in_array($m, $enabled, true);
			}),
		);
		sort($dependents);
		$out['dependents'] = $dependents;
		$reasons = [];
		foreach (Drupal::service('module_installer')->validateUninstall([$name]) as $group) {
			foreach ($group as $reason) {
				$reasons[] = (string) $reason;
			}
		}
		$out['reasons'] = $reasons;
		if ($dependents === [] && $reasons === [] && !$dryRun) {
			// the installer reaches functions only a real request has loaded, as an install does
			$kernel = $GLOBALS['__pw_kernel'] ?? null;
			if ($kernel !== null && method_exists($kernel, 'loadLegacyIncludes')) {
				$kernel->loadLegacyIncludes();
			}
			$stack = Drupal::service('request_stack');
			if ($stack->getCurrentRequest() === null) {
				$stack->push(Request::create('/', 'GET'));
			}
			Drupal::moduleHandler()->loadAll();
			Drupal::service('module_installer')->uninstall([$name], false);
			$out['stillEnabled'] = Drupal::moduleHandler()->moduleExists($name);
			$out['ok'] = $out['stillEnabled'] === false;
		} else {
			$out['ok'] = true;
		}
	}
} catch (Throwable $e) {
	$out['error'] = get_class($e);
	$out['message'] = substr($e->getMessage(), 0, 300);
	$out['at'] = $e->getFile() . ':' . $e->getLine();
}
echo json_encode($out);
