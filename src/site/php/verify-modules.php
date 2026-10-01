<?php

use Drupal\Core\Extension\ExtensionDiscovery;

try {
	$kernel = $GLOBALS['__pw_kernel'] ?? null;
	if ($kernel === null || !Drupal::hasContainer()) {
		echo json_encode(['ok' => false, 'error' => 'no kernel to verify against']);
	} else {
		// delivered code can add an extension, so the scan and every list rediscover, as a cache
		// rebuild would (a profile uploaded after the claim read as not installed)
		try {
			$prop = new ReflectionProperty(ExtensionDiscovery::class, 'files');
			$prop->setValue(null, []);
		} catch (Throwable $e) {
		}
		foreach (['module', 'theme', 'profile'] as $type) {
			Drupal::service('extension.list.' . $type)->reset();
		}
		$handler = Drupal::service('module_handler');
		$handler->loadAll();
		$modules = array_keys($handler->getModuleList());
		sort($modules);
		echo json_encode(['ok' => true, 'modules' => count($modules)]);
	}
} catch (Throwable $e) {
	echo json_encode(['ok' => false, 'error' => get_class($e) . ': ' . $e->getMessage()]);
}
