<?php
// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ok' => false, 'managers' => 0, 'failed' => []];
try {
	// __CFW_KERNEL_BOOT__
	$container = Drupal::getContainer();
	Drupal::entityTypeManager()->getDefinitions();
	Drupal::service('entity_field.manager')->getFieldMap();
	foreach ($container->getServiceIds() as $id) {
		if (strpos($id, 'plugin.manager.') !== 0) {
			continue;
		}
		try {
			$manager = $container->get($id);
			if (method_exists($manager, 'getDefinitions')) {
				$manager->getDefinitions();
				$out['managers']++;
			}
		} catch (Throwable $e) {
			$out['failed'][] = $id;
		}
	}
	$out['rows'] = (int) Drupal::database()
		->query('SELECT COUNT(*) FROM {cache_discovery}')
		->fetchField();
	$out['ok'] = $out['rows'] > 0;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['at'] = $e->getFile() . ':' . $e->getLine();
}
echo json_encode($out);
