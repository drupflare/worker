<?php

// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ok' => false];
try {
	// __CFW_KERNEL_BOOT__
	$core = Drupal::config('core.extension');
	$profile = (string) $core->get('profile');
	$on = [
		'module' => $core->get('module') ?? [],
		'theme' => $core->get('theme') ?? [],
	];
	$rows = [];
	$profiles = [];
	foreach (Drupal::service('extension.list.profile')->getList() as $name => $extension) {
		$profiles[$name] = true;
		$rows[] = [
			'name' => (string) $name,
			'kind' => 'profile',
			'version' => $extension->info['version'] ?? null,
			'enabled' => $name === $profile,
		];
	}
	foreach (['module', 'theme'] as $kind) {
		foreach (Drupal::service('extension.list.' . $kind)->getList() as $name => $extension) {
			if ($kind === 'module' && isset($profiles[$name])) {
				continue;
			}
			$rows[] = [
				'name' => (string) $name,
				'kind' => $kind,
				'version' => $extension->info['version'] ?? null,
				'enabled' => isset($on[$kind][$name]),
			];
		}
	}
	$out['extensions'] = $rows;
	$out['ok'] = true;
} catch (Throwable $e) {
	$out['error'] = get_class($e);
	$out['at'] = $e->getFile() . ':' . $e->getLine();
}
echo json_encode($out);
