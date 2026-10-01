<?php
// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ok' => false];
try {
	// __CFW_KERNEL_BOOT__
	$wanted = json_decode(__CFW_MODULES__, true);
	$present = array_values(
		array_filter($wanted, function (string $m): bool {
			return Drupal::moduleHandler()->moduleExists($m);
		}),
	);
	$out['before'] = $present;
	if ($present) {
		Drupal::service('module_installer')->uninstall($present, false);
	}
	$out['after'] = array_values(
		array_filter($wanted, function (string $m): bool {
			return Drupal::moduleHandler()->moduleExists($m);
		}),
	);
	$out['ok'] = $out['after'] === [];
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['at'] = $e->getFile() . ':' . $e->getLine();
}
echo json_encode($out);
