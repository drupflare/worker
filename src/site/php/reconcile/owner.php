<?php

use Drupal\drupflare\Hook\OwnerTier;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;

// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ok' => false, 'moved' => []];
try {
	// __CFW_KERNEL_BOOT__
	// an entity save returns SAVED_NEW or SAVED_UPDATED, which live in an include a boot never loads
	if (!defined('SAVED_UPDATED')) {
		require_once '/drupal/core/includes/common.inc';
	}
	$renamed = json_decode(__CFW_RENAMED__, true);
	foreach (Role::loadMultiple() as $role) {
		$held = array_values(array_intersect(array_keys($renamed), $role->getPermissions()));
		if ($held === []) {
			continue;
		}
		foreach ($held as $old) {
			$role->revokePermission($old);
		}
		foreach ($held as $old) {
			$role->grantPermission($renamed[$old]);
		}
		$role->save();
		$out['moved'][$role->id()] = $held;
	}
	$admin = User::load(1);
	$out['established'] = $admin === null ? [] : OwnerTier::establish($admin);
	$out['ok'] = $admin !== null && $admin->hasRole(OwnerTier::ROLE);
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['at'] = $e->getFile() . ':' . $e->getLine();
}
echo json_encode($out);
