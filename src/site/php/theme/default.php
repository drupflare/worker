<?php

// __CFW_FIBER_SHIM__
chdir('/drupal');

$want = json_decode(base64_decode('__CFW_PAYLOAD__'), true);
$out = ['ok' => false];
try {
	// __CFW_KERNEL_BOOT__
	$installed = array_keys(Drupal::config('core.extension')->get('theme') ?? []);
	$editable = Drupal::configFactory()->getEditable('system.theme');
	$out['installed'] = $installed;
	$out['previous'] = [
		'default' => (string) $editable->get('default'),
		'admin' => (string) $editable->get('admin'),
	];
	if ($want === null) {
		$out['ok'] = true;
	} elseif ($want['project'] !== '' && !in_array($want['project'], $installed, true)) {
		$out['notInstalled'] = true;
	} else {
		if ($out['previous'][$want['target']] !== $want['project']) {
			$editable->set($want['target'], $want['project']);
			$editable->save();
		} else {
			$out['unchanged'] = true;
		}
		$after = Drupal::config('system.theme');
		$out['default'] = (string) $after->get('default');
		$out['admin'] = (string) $after->get('admin');
		$out['ok'] = $out[$want['target']] === $want['project'];
	}
} catch (Throwable $e) {
	$out['error'] = get_class($e);
	$out['at'] = $e->getFile() . ':' . $e->getLine();
}
echo json_encode($out);
