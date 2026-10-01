<?php
// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ok' => false];
try {
	// __CFW_KERNEL_BOOT__
	$editable = Drupal::configFactory()->getEditable('system.image');
	$out['before'] = (string) $editable->get('toolkit');
	$editable->set('toolkit', 'cfw_images');
	$editable->save();
	$out['after'] = (string) Drupal::config('system.image')->get('toolkit');
	$out['ok'] = $out['after'] === 'cfw_images';
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['at'] = $e->getFile() . ':' . $e->getLine();
}
echo json_encode($out);
