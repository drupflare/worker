<?php

require_once getenv('WP_ROOT') . '/wp-load.php';

$out = [];
foreach ($wpdb->tables('all') as $table) {
	$row = $wpdb->get_row("SHOW CREATE TABLE `$table`", ARRAY_N);
	$out[$table] = $row[1] ?? 'ERROR ' . $wpdb->last_error;
}
echo json_encode($out) . "\n";
