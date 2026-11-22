<?php

// runs the writes and queries an admin session and a theme would send, so the oracle capture
// covers more than the install and the public routes

require_once getenv('WP_ROOT') . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
require_once ABSPATH . 'wp-admin/includes/post.php';
require_once ABSPATH . 'wp-admin/includes/user.php';
require_once ABSPATH . 'wp-admin/includes/taxonomy.php';

global $wpdb;
wp_set_current_user(1);

$cat = wp_insert_term('Oracle News', 'category');
$sub = wp_insert_term('Oracle Sub', 'category', ['parent' => $cat['term_id']]);
$tagId = wp_insert_term('oracle-tag', 'post_tag');

$ids = [];
for ($i = 1; $i <= 5; $i++) {
	$ids[] = wp_insert_post([
		'post_title' => "Oracle post $i",
		'post_content' => "Body $i with \"quotes\", an apostrophe's and caf\u{e9}",
		'post_status' => $i === 5 ? 'draft' : 'publish',
		'post_author' => 1,
		'post_category' => [$cat['term_id']],
		'tags_input' => ['oracle-tag', "extra-$i"],
		'meta_input' => ['oracle_key' => "v$i", 'oracle_num' => $i * 10],
	]);
}
wp_insert_post([
	'post_title' => 'Oracle page',
	'post_content' => 'page body',
	'post_status' => 'publish',
	'post_type' => 'page',
]);

wp_insert_comment([
	'comment_post_ID' => $ids[0],
	'comment_author' => 'Oracle Commenter',
	'comment_author_email' => 'oracle@example.com',
	'comment_content' => 'First comment',
	'comment_approved' => 1,
]);
wp_insert_comment([
	'comment_post_ID' => $ids[0],
	'comment_author' => 'Spammer',
	'comment_author_email' => 'spam@example.com',
	'comment_content' => 'Buy things',
	'comment_approved' => 0,
]);

wp_update_post(['ID' => $ids[1], 'post_title' => 'Oracle post two, edited']);
update_post_meta($ids[1], 'oracle_key', 'edited');
add_post_meta($ids[2], 'oracle_multi', 'a');
add_post_meta($ids[2], 'oracle_multi', 'b');
delete_post_meta($ids[2], 'oracle_multi', 'a');
wp_set_post_terms($ids[3], [$sub['term_id']], 'category', true);
stick_post($ids[0]);
wp_trash_post($ids[3]);
wp_delete_post($ids[3], true);

$user = wp_insert_user([
	'user_login' => 'oracleauthor',
	'user_pass' => 'not-a-real-password',
	'user_email' => 'author@example.com',
	'role' => 'author',
]);
update_user_meta($user, 'oracle_pref', 'dark');
wp_update_user(['ID' => $user, 'display_name' => 'Oracle Author']);

update_option('oracle_option', ['a' => 1, 'b' => 'two']);
update_option('oracle_option', ['a' => 1, 'b' => 'two']);
add_option('oracle_autoload_off', 'x', '', false);
set_transient('oracle_transient', 'value', 3600);
get_transient('oracle_transient');
delete_transient('oracle_transient');
set_site_transient('oracle_site_transient', 'value', 60);
wp_schedule_single_event(time() + 3600, 'oracle_event', ['arg']);
wp_schedule_event(time() + 60, 'hourly', 'oracle_recurring');
wp_clear_scheduled_hook('oracle_event', ['arg']);
activate_plugin('hello.php');
deactivate_plugins('hello.php');

$queries = [
	['s' => 'oracle', 'posts_per_page' => 3],
	['category_name' => 'oracle-news', 'orderby' => 'title', 'order' => 'ASC'],
	['tag' => 'oracle-tag', 'paged' => 1, 'posts_per_page' => 2],
	['meta_key' => 'oracle_num', 'orderby' => 'meta_value_num', 'order' => 'DESC'],
	['meta_query' => [['key' => 'oracle_key', 'value' => 'v', 'compare' => 'LIKE']]],
	['date_query' => [['year' => (int) gmdate('Y'), 'month' => (int) gmdate('n')]]],
	['author' => 1, 'post_status' => ['publish', 'draft'], 'no_found_rows' => true],
	['post_type' => 'page', 'orderby' => 'menu_order title'],
	['post__in' => $ids, 'orderby' => 'post__in'],
	['posts_per_page' => 2, 'ignore_sticky_posts' => false, 'offset' => 1],
	['tax_query' => [['taxonomy' => 'category', 'field' => 'slug', 'terms' => ['oracle-sub']]]],
	['has_password' => false, 'comment_count' => 1, 'orderby' => 'comment_count'],
];
foreach ($queries as $args) {
	$q = new WP_Query($args);
	$q->get_posts();
}
get_comments(['post_id' => $ids[0], 'status' => 'all', 'orderby' => 'comment_date_gmt']);
get_comments(['count' => true, 'status' => 'hold']);
wp_count_posts();
wp_count_comments();
count_user_posts(1);
get_terms([
	'taxonomy' => 'category',
	'hide_empty' => false,
	'orderby' => 'count',
	'order' => 'DESC',
]);
get_terms(['taxonomy' => 'post_tag', 'search' => 'oracle', 'number' => 3]);
get_users([
	'search' => '*oracle*',
	'search_columns' => ['user_login'],
	'orderby' => 'display_name',
]);
get_users(['role' => 'author', 'count_total' => true]);
get_archives('monthly');
wp_get_archives(['type' => 'monthly', 'echo' => false]);
get_page_by_path('oracle-page', OBJECT, 'page');
wpdb_unusual_reads($wpdb);

wp_delete_user($user);
wp_delete_term($tagId['term_id'], 'post_tag');

function wpdb_unusual_reads(wpdb $wpdb): void
{
	$wpdb->get_var(
		$wpdb->prepare(
			"SELECT COUNT(*) FROM $wpdb->posts WHERE post_title LIKE %s",
			'%' . $wpdb->esc_like('oracle_') . '%',
		),
	);
	$wpdb->get_results(
		"SELECT post_status, COUNT(*) AS n FROM $wpdb->posts GROUP BY post_status ORDER BY n DESC, post_status ASC",
	);
	$wpdb->get_col("SELECT DISTINCT meta_key FROM $wpdb->postmeta ORDER BY meta_key LIMIT 20");
	$wpdb->get_row("SELECT * FROM $wpdb->options WHERE option_name = 'siteurl' LIMIT 1");
	$wpdb->get_var("SELECT MAX(ID) FROM $wpdb->posts");
	$wpdb->get_results(
		"SELECT YEAR(post_date) AS y, MONTH(post_date) AS m, COUNT(ID) AS c FROM $wpdb->posts WHERE post_type = 'post' AND post_status = 'publish' GROUP BY YEAR(post_date), MONTH(post_date) ORDER BY post_date DESC",
	);
	$wpdb->get_results(
		"SELECT t.name, tt.count FROM $wpdb->terms AS t INNER JOIN $wpdb->term_taxonomy AS tt ON t.term_id = tt.term_id WHERE tt.taxonomy IN ('category','post_tag') ORDER BY tt.count DESC, t.name ASC",
	);
	$wpdb->get_var("SELECT IFNULL(MAX(comment_ID), 0) FROM $wpdb->comments");
	$wpdb->query("DELETE FROM $wpdb->options WHERE option_name LIKE '\\_transient\\_oracle%'");
	$wpdb->get_results(
		"SELECT option_name, LENGTH(option_value) AS len FROM $wpdb->options WHERE autoload = 'yes' ORDER BY len DESC, option_name LIMIT 5",
	);
}

echo json_encode(['posts' => $ids, 'user' => $user]) . "\n";
