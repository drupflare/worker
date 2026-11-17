<?php

define('WP_INSTALLING', true);

require_once getenv('WP_ROOT') . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . WPINC . '/class-wpdb.php';

if (is_blog_installed()) {
	fwrite(STDERR, "already installed\n");
	exit(3);
}

$wpdb->show_errors();
$result = wp_install(
	getenv('WP_TITLE'),
	getenv('WP_USER'),
	getenv('WP_EMAIL'),
	true,
	'',
	wp_slash(getenv('WP_PASS')),
	'en_US',
);
echo json_encode(['userId' => $result['user_id'] ?? null, 'blogInstalled' => is_blog_installed()]) .
	"\n";
