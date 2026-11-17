<?php

// a fresh process, so init runs with the permalink structure set and every permastruct registers
require_once getenv('WP_ROOT') . '/wp-load.php';

if (!is_blog_installed()) {
	fwrite(STDERR, "not installed\n");
	exit(3);
}

flush_rewrite_rules(false);

// event times are the clock of the process that scheduled them; the bake stamps them to one base
// so two bakes agree, and this is the last process to schedule any
$cron = get_option('cron');
if (is_array($cron)) {
	$base = (int) getenv('WP_STAMP_EPOCH');
	$events = [];
	foreach ($cron as $time => $hooks) {
		if (is_array($hooks)) {
			foreach ($hooks as $hook => $entries) {
				$events[$hook] = [$time, $entries];
			}
		}
	}
	ksort($events);
	$stamped = [];
	foreach ($events as $hook => [$time, $entries]) {
		$stamped[$base][$hook] = $entries;
	}
	$stamped['version'] = $cron['version'] ?? 2;
	update_option('cron', $stamped);
}

$rules = get_option('rewrite_rules');
echo json_encode(['rules' => is_array($rules) ? count($rules) : 0]) . "\n";
