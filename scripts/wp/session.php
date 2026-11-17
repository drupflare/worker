<?php

require_once getenv('WP_ROOT') . '/wp-load.php';

$wpdb->suppress_errors(true);
echo json_encode(['ready' => true]) . "\n";

while (($line = fgets(STDIN)) !== false) {
	$command = trim($line);
	$out = ['command' => $command];
	if ($command === 'title') {
		$out['value'] = $wpdb->get_var(
			"SELECT option_value FROM {$wpdb->options} WHERE option_name = 'blogname'",
		);
	} elseif ($command === 'setup') {
		$out['result'] = $wpdb->query(
			"CREATE TABLE {$wpdb->prefix}strict_probe (id bigint(20) unsigned NOT NULL AUTO_INCREMENT, a varchar(10) NOT NULL, d datetime NOT NULL default '0000-00-00 00:00:00', PRIMARY KEY  (id))",
		);
	} elseif ($command === 'strict') {
		$out['result'] = $wpdb->query("INSERT INTO {$wpdb->prefix}strict_probe (id) VALUES (NULL)");
	} elseif ($command === 'zerodate') {
		$out['result'] = $wpdb->query(
			"INSERT INTO {$wpdb->prefix}strict_probe (a, d) VALUES ('x', '0000-00-00 00:00:00')",
		);
	} elseif ($command === 'quit') {
		break;
	}
	$out['error'] = $wpdb->last_error;
	echo json_encode($out) . "\n";
}
