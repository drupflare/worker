<?php

// one editorial write per run, named by SCENARIO, through the WordPress API the way an admin screen would
require_once getenv('WP_ROOT') . '/wp-load.php';

global $wpdb;
$scenario = (string) getenv('SCENARIO');
$result = [];

switch ($scenario) {
	case 'publish':
		$result['id'] = wp_insert_post([
			'post_title' => 'Fresh post',
			'post_content' => 'fresh',
			'post_status' => 'publish',
		]);
		break;
	case 'draft':
		$result['id'] = wp_insert_post([
			'post_title' => 'Draft post',
			'post_content' => 'draft',
			'post_status' => 'draft',
		]);
		break;
	case 'edit':
		$result['id'] = wp_update_post(['ID' => 1, 'post_title' => 'Edited title']);
		break;
	case 'trash':
		$result['trashed'] = (bool) wp_trash_post(1);
		break;
	case 'postmeta':
		$result['id'] = add_post_meta(1, 'subtitle_' . bin2hex(random_bytes(4)), 'A subtitle');
		break;
	case 'term-create':
		$result['term'] = wp_insert_term('News', 'category');
		break;
	case 'term-edit':
		$result['term'] = wp_update_term(1, 'category', [
			'name' => 'Renamed ' . bin2hex(random_bytes(3)),
		]);
		break;
	case 'term-assign':
		$topic = wp_insert_term('Topic ' . bin2hex(random_bytes(3)), 'category');
		$result['set'] = wp_set_post_categories(1, [1, $topic['term_id']]);
		break;
	case 'comment':
		$result['id'] = wp_insert_comment([
			'comment_post_ID' => 1,
			'comment_author' => 'A Reader',
			'comment_author_email' => 'reader@example.test',
			'comment_content' => 'Nice post',
			'comment_approved' => 1,
		]);
		break;
	case 'spam-comment':
		$result['id'] = wp_insert_comment([
			'comment_post_ID' => 1,
			'comment_author' => 'A Bot',
			'comment_author_email' => 'bot@example.test',
			'comment_content' => 'Buy things',
			'comment_approved' => 'spam',
		]);
		break;
	case 'option-plain':
		$result['updated'] = update_option('my_plugin_setting', 'on-' . bin2hex(random_bytes(3)));
		break;
	case 'option-structural':
		$result['updated'] = update_option('blogdescription', 'A new tagline');
		break;
	case 'theme':
		switch_theme('twentytwentyfour');
		break;
	case 'menu':
		$menu = wp_create_nav_menu('Main menu');
		$result['item'] = wp_update_nav_menu_item($menu, 0, [
			'menu-item-title' => 'Home',
			'menu-item-url' => home_url('/'),
			'menu-item-status' => 'publish',
			'menu-item-type' => 'custom',
		]);
		break;
	case 'user':
		$result['id'] = wp_update_user(['ID' => 1, 'display_name' => 'The Boss']);
		break;
	case 'session':
		$result['id'] = update_user_meta(1, 'session_tokens', [
			'abc' => ['expiration' => time() + 60],
		]);
		break;
	case 'cron':
		$result['scheduled'] = wp_schedule_single_event(time() + 3600, 'drupflare_test_event');
		break;
	case 'naive-write':
		// a plugin that writes a content table without a WordPress API; this file is outside ABSPATH
		$result['rows'] = $wpdb->query(
			"UPDATE {$wpdb->posts} SET post_title = 'Naive' WHERE ID = 1",
		);
		break;
	case 'naive-write-unfiltered':
		// the same, from a plugin that first removes the emitter's statement filter
		remove_filter('query', 'drupflare_tags_on_query', 99999);
		$result['rows'] = $wpdb->query(
			"UPDATE {$wpdb->posts} SET post_title = 'Naive' WHERE ID = 1",
		);
		break;
	default:
		fwrite(STDERR, "unknown scenario $scenario\n");
		exit(2);
}

echo json_encode($result) . "\n";
