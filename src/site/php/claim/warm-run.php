<?php
// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
chdir('/drupal');
$out = ['ok' => false, 'warmed' => []];
$warm = json_decode(__CFW_WARM_PAYLOAD__, true);
$step = $warm['step'] ?? 'all';
try {
	// __CFW_CLAIM_BOOT__
	if ($step === 'plan') {
		$out['plugins'] = array_values(
			array_filter(
				Drupal::getContainer()->getServiceIds(),
				static fn($id) => str_starts_with($id, 'plugin.manager.'),
			),
		);
		$out['ok'] = true;
		echo json_encode($out);
		return;
	}
	if ($step === 'all' || $step === 'entity') {
		Drupal::service('extension.list.module')->getList();
		Drupal::entityTypeManager()->getDefinitions();
		Drupal::service('entity_field.manager')->getFieldMap();
		$out['warmed'][] = 'entity';
	}
	if ($step === 'all' || $step === 'typed') {
		Drupal::service('config.typed')->getDefinitions();
		$out['warmed'][] = 'typed';
	}
	if ($step === 'all' || $step === 'plugins') {
		foreach (
			$step === 'all' ? Drupal::getContainer()->getServiceIds() : $warm['plugins']
			as $id
		) {
			if (!str_starts_with($id, 'plugin.manager.')) {
				continue;
			}
			try {
				Drupal::service($id)->getDefinitions();
			} catch (Throwable $e) {
			}
		}
		$out['warmed'][] = 'plugins';
	}
	if ($step === 'all' || $step === 'router') {
		Drupal::service('router.builder')->rebuildIfNeeded();
	}
	$out['ok'] = true;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
}
echo json_encode($out);
