<?php
$fn = function_exists('vrzno_env') ? vrzno_env('cfwStats') : null;
if ($fn === null) {
	echo json_encode(['bridge' => 'vrzno_env absent']);
	return;
}
$raw = $fn();
$decoded = json_decode((string) $raw, true);
echo json_encode([
	'bridge' => is_array($decoded) ? 'round-tripped' : 'returned nothing usable',
	'sawQueryCount' => is_array($decoded) && array_key_exists('queryCount', $decoded),
	'raw' => is_string($raw) ? substr($raw, 0, 120) : gettype($raw),
]);
