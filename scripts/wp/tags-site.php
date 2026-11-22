<?php

// one site shape per run, named by SHAPE: a theme, a post type, widgets, a menu, comments, many posts
require_once getenv('WP_ROOT') . '/wp-load.php';

$shape = (string) getenv('SHAPE');
$result = ['shape' => $shape];

switch ($shape) {
	case 'theme':
		switch_theme((string) getenv('THEME'));
		$result['theme'] = get_stylesheet();
		break;
	case 'permalinks':
		global $wp_rewrite;
		$wp_rewrite->set_permalink_structure('/%year%/%monthnum%/%day%/%postname%/');
		flush_rewrite_rules(false);
		break;
	case 'books':
		for ($i = 1; $i <= 2; $i++) {
			$result['book' . $i] = wp_insert_post([
				'post_type' => 'book',
				'post_title' => 'Book ' . $i,
				'post_content' => 'about book ' . $i,
				'post_status' => 'publish',
			]);
		}
		break;
	case 'posts':
		update_option('posts_per_page', 3);
		$tag = wp_insert_term('Tagged', 'post_tag');
		for ($i = 1; $i <= 8; $i++) {
			$id = wp_insert_post([
				'post_title' => 'Entry ' . $i,
				'post_content' => 'entry ' . $i . "\n\n<!--more-->\n\nmore",
				'post_status' => 'publish',
				'post_date' => gmdate('Y-m-d H:i:s', strtotime('2026-01-0' . $i . ' 12:00:00')),
			]);
			if ($i % 2 === 0) {
				wp_set_post_tags($id, ['tagged']);
			}
			$result['p' . $i] = $id;
		}
		break;
	case 'comments':
		for ($i = 1; $i <= 3; $i++) {
			wp_insert_comment([
				'comment_post_ID' => 1,
				'comment_author' => 'Reader ' . $i,
				'comment_author_email' => 'r' . $i . '@example.test',
				'comment_content' => 'Comment ' . $i,
				'comment_approved' => 1,
			]);
		}
		break;
	case 'widgets':
		update_option('widget_search', [2 => ['title' => 'Find'], '_multiwidget' => 1]);
		update_option('widget_recent-posts', [
			3 => ['title' => 'Latest', 'number' => 3],
			'_multiwidget' => 1,
		]);
		update_option('widget_categories', [
			4 => ['title' => 'Cats', 'count' => 1],
			'_multiwidget' => 1,
		]);
		update_option('sidebars_widgets', [
			'sidebar-1' => ['search-2', 'recent-posts-3', 'categories-4'],
			'array_version' => 3,
		]);
		break;
	case 'menu':
		$menu = wp_create_nav_menu('Main');
		wp_update_nav_menu_item($menu, 0, [
			'menu-item-title' => 'Home',
			'menu-item-url' => home_url('/'),
			'menu-item-status' => 'publish',
		]);
		wp_update_nav_menu_item($menu, 0, [
			'menu-item-title' => 'Sample',
			'menu-item-object' => 'page',
			'menu-item-object-id' => 2,
			'menu-item-type' => 'post_type',
			'menu-item-status' => 'publish',
		]);
		$locations = get_registered_nav_menus();
		set_theme_mod('nav_menu_locations', array_fill_keys(array_keys($locations), $menu));
		$result['menu'] = $menu;
		break;
}

echo json_encode($result);
