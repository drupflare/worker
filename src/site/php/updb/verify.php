<?php
// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ok' => false];

try {
	// __CFW_UPDB_PREAMBLE__

	$reg = Drupal::service('update.update_hook_registry');
	$postReg = Drupal::service('update.post_update_registry');
	$out['installedVersions'] = $reg->getAllInstalledVersions();
	$out['pendingUpdates'] = [];
	foreach (update_get_update_list() as $module => $info) {
		$out['pendingUpdates'][$module] = array_keys($info['pending'] ?? []);
	}
	$pendingPost = [];
	try {
		foreach ($postReg->getPendingUpdateFunctions() as $fn) {
			$pendingPost[] = $fn;
		}
	} catch (Throwable $e) {
		$out['postUpdateError'] = get_class($e) . ': ' . $e->getMessage();
	}
	$out['pendingPostUpdates'] = $pendingPost;
	$out['maintenanceMode'] = Drupal::state()->get('system.maintenance_mode') ? 1 : 0;
	$out['equivalentUpdates'] = $reg->getAllEquivalentUpdates();
	$out['clean'] = empty($pendingPost);
	foreach ($out['pendingUpdates'] as $module => $numbers) {
		if (!empty($numbers)) {
			$out['clean'] = false;
		}
	}
	$out['ok'] = true;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['trace'] = substr($e->getTraceAsString(), 0, 900);
}

echo json_encode($out);
