<?php

use Drupal\user\Entity\User;

// __CFW_FIBER_SHIM__
chdir('/drupal');

$pass = base64_decode('__CFW_PAYLOAD__');
$out = ['ok' => false];
try {
	// __CFW_KERNEL_BOOT__
	// an entity save returns SAVED_UPDATED, a constant only common.inc defines and a render never loads
	if (!defined('SAVED_UPDATED')) {
		require_once '/drupal/core/includes/common.inc';
	}
	$account = User::load(1);
	if ($account === null) {
		$out['absent'] = true;
	} else {
		$account->setPassword($pass);
		$account->save();
		$out['name'] = (string) $account->getAccountName();
		$out['blocked'] = $account->isBlocked();
		$out['ok'] = true;
	}
} catch (Throwable $e) {
	$out['error'] = get_class($e);
}
echo json_encode($out);
