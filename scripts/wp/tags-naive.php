<?php

// a plugin that reads and writes posts through $wpdb the way a careless one does; each is switched on
// by a query string, so one site serves the clean and the naive page side by side
add_action('wp_footer', static function () {
	global $wpdb;
	if (isset($_GET['naive'])) {
		$wpdb->get_results("SELECT ID FROM {$wpdb->posts} WHERE post_type = 'event' LIMIT 3");
	}
	if (isset($_GET['plugin_setting'])) {
		get_option('my_plugin_setting');
	}
	if (isset($_GET['adjacent_term'])) {
		get_adjacent_post(true);
	}
	if (isset($_GET['adjacent_excluded'])) {
		get_adjacent_post(false, '1');
	}
	if (isset($_GET['adjacent_sorted'])) {
		add_filter('get_previous_post_sort', static fn() => 'ORDER BY p.post_title DESC LIMIT 1');
		get_adjacent_post();
	}
	if (isset($_GET['naive_table'])) {
		$wpdb->get_results("SELECT 1 FROM {$wpdb->prefix}naive_votes LIMIT 1");
	}
});
add_action('template_redirect', static function () {
	global $wpdb;
	if (isset($_GET['naive_write'])) {
		$wpdb->query("UPDATE {$wpdb->posts} SET post_title = post_title WHERE ID = 0");
	}
});
