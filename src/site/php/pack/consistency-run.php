<?php
// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
chdir('/drupal');
$out = ['ok' => false];
try {
	// __CFW_CLAIM_BOOT__
	// __CFW_SCHEMA_REPAIR__
	// __CFW_PACK_CONSISTENCY__
	$out['ok'] = true;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
}
echo json_encode($out);
