<?php

// __CFW_FIBER_SHIM__
chdir('/drupal');

$want = json_decode(base64_decode('__CFW_PAYLOAD__'), true);
$out = ['ok' => false];
$made = null;
try {
	// __CFW_KERNEL_BOOT__
	$editable = Drupal::configFactory()->getEditable('strata.settings');
	if ($editable->isNew()) {
		// a save here would create a row for a module that never installed its defaults
		$out['absent'] = true;
	} elseif (!Drupal::moduleHandler()->moduleExists('strata_s3')) {
		$out['s3absent'] = true;
	} else {
		$out['keyCreated'] = false;
		if (trim((string) $editable->get('key')) === '') {
			// strata's own maker, so the key is the entity strata:new-key would have made
			$made = Drupal::service('strata.key_maker')->create();
			$editable->set('key', $made);
			$out['keyCreated'] = true;
		}
		$editable
			->set('provider', 's3')
			->set('s3.endpoint', $want['endpoint'])
			->set('s3.bucket', $want['bucket'])
			->set('s3.region', $want['region'])
			->set('s3.access_key_id', $want['accessKeyId'])
			->set('s3.secret_access_key', $want['secretAccessKey'])
			->set('s3.path_style', $want['pathStyle']);
		if ($want['enable'] === true) {
			// only ever turned on here; false or absent leaves the stored value alone
			$editable->set('enabled', true);
		}
		$editable->save();
		$made = null;
		$out['ok'] = true;
	}
} catch (Throwable $e) {
	// the class and the line only: a message or trace can carry an argument, and an argument is a secret
	$out['ok'] = false;
	$out['keyCreated'] = false;
	$out['class'] = get_class($e);
	$out['at'] = basename($e->getFile()) . ':' . $e->getLine();
	if ($made !== null) {
		try {
			$orphan = Drupal::entityTypeManager()->getStorage('key')->load($made);
			if ($orphan !== null) {
				$orphan->delete();
			}
		} catch (Throwable $ignored) {
		}
	}
}
echo json_encode($out);
