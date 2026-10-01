<?php

use Drupal\drupflare\Ops\OpsRegistry;

$path = '/drupal/modules/custom/drupflare/src/Ops/OpsRegistry.php';
if (!is_file($path)) {
	echo json_encode(['ok' => false, 'error' => 'OpsRegistry is not in the mount at ' . $path]);
	return;
}
require_once $path;
$cls = OpsRegistry::class;
if (!class_exists($cls, false)) {
	echo json_encode(['ok' => false, 'error' => 'OpsRegistry did not declare its class']);
	return;
}
$ops = $cls::operations();
echo json_encode([
	'ok' => true,
	'count' => count($ops),
	'operations' => $ops,
	// the fail-closed pair, reported rather than assumed: an unknown name must read as writing and
	// sliced, so a caller that forgets has() cannot expose a mutation as a read
	'failsClosed' => [
		'writes' => $cls::writes('not-a-command'),
		'sliced' => $cls::sliced('not-a-command'),
	],
	'readOnlyUnsliced' => $cls::readOnlyUnsliced(),
]);
