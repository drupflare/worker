<?php

$found = [];
Drupal::moduleHandler()->invokeAllWith('cron', function (callable $hook, string $m) use (&$found) {
	$found[$m][] = $hook;
});
$out['available'] = array_keys($found);
