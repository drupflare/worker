<?php
// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
chdir('/drupal');
$out = ['ok' => false, 'warmed' => []];
try {
	// __CFW_CLAIM_BOOT__
	Drupal::service('extension.list.module')->getList();
	Drupal::entityTypeManager()->getDefinitions();
	Drupal::service('entity_field.manager')->getFieldMap();
	$out['warmed'][] = 'entity';
	Drupal::service('config.typed')->getDefinitions();
	$out['warmed'][] = 'typed';
	foreach (Drupal::getContainer()->getServiceIds() as $id) {
		if (!str_starts_with($id, 'plugin.manager.')) {
			continue;
		}
		try {
			Drupal::service($id)->getDefinitions();
		} catch (Throwable $e) {
		}
	}
	$out['warmed'][] = 'plugins';
	Drupal::service('router.builder')->rebuildIfNeeded();
	$out['ok'] = true;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
}
echo json_encode($out);
