<?php

// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ok' => false];
try {
	// __CFW_KERNEL_BOOT__
	$editable = Drupal::configFactory()->getEditable('strata.settings');
	if ($editable->isNew()) {
		// a save here would create a row for a module that never installed its defaults
		$out['absent'] = true;
	} else {
		$out['before'] = (bool) $editable->get('capture.statements');
		$editable->set('capture.statements', __CFW_VALUE__);
		$editable->save();
		$out['after'] = (bool) Drupal::config('strata.settings')->get('capture.statements');
		$out['ok'] = $out['after'] === __CFW_VALUE__;
	}
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['at'] = $e->getFile() . ':' . $e->getLine();
}
echo json_encode($out);
