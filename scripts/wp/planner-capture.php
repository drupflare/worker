<?php

// sends the reads of the pages the route capture does not reach: the REST posts and users lists,
// the admin post list, a login, a post with comments and the classic widgets; one scenario per process

require_once getenv('WP_ROOT') . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/admin.php';

global $wpdb;
$scenario = getenv('SCENARIO');

$rest = static function (string $route, array $params = []): void {
	$request = new WP_REST_Request('GET', $route);
	foreach ($params as $key => $value) {
		$request->set_param($key, $value);
	}
	rest_get_server()->dispatch($request);
};

if ($scenario === 'setup') {
	wp_set_current_user(1);
	$cat = wp_insert_term('Planner News', 'category');
	for ($i = 1; $i <= 4; $i++) {
		$id = wp_insert_post([
			'post_title' => "Planner post $i",
			'post_content' => "Body $i",
			'post_status' => $i === 4 ? 'draft' : 'publish',
			'post_author' => 1,
			'post_category' => [$cat['term_id']],
			'tags_input' => ['planner-tag'],
		]);
		wp_insert_comment([
			'comment_post_ID' => $id,
			'comment_author' => 'Planner Commenter',
			'comment_author_email' => 'planner@example.com',
			'comment_content' => 'A comment',
			'comment_approved' => 1,
		]);
	}
	exit(0);
}

if ($scenario === 'rest-posts') {
	$rest('/wp/v2/posts');
	$rest('/wp/v2/posts', ['per_page' => 10, 'page' => 1, '_embed' => '1']);
	$rest('/wp/v2/posts', ['slug' => 'hello-world']);
	$rest('/wp/v2/posts', ['search' => 'hello']);
	$rest('/wp/v2/posts', ['categories' => [1]]);
	$rest('/wp/v2/pages');
	$rest('/wp/v2/categories');
	$rest('/wp/v2/comments', ['post' => 1]);
}

if ($scenario === 'rest-users') {
	$rest('/wp/v2/users');
	$rest('/wp/v2/users/1');
	$rest('/wp/v2/users', ['slug' => 'admin']);
	wp_set_current_user(1);
	$rest('/wp/v2/users', ['context' => 'edit', 'per_page' => 20]);
}

if ($scenario === 'admin-posts') {
	wp_set_current_user(1);
	$GLOBALS['hook_suffix'] = 'edit.php';
	$_GET['post_type'] = 'post';
	set_current_screen('edit-post');
	$table = _get_list_table('WP_Posts_List_Table');
	$table->prepare_items();
	ob_start();
	$table->views();
	$table->months_dropdown('post');
	ob_end_clean();
	$_GET['post_status'] = 'draft';
	$table = _get_list_table('WP_Posts_List_Table');
	$table->prepare_items();
	$_GET['s'] = 'planner';
	$table = _get_list_table('WP_Posts_List_Table');
	$table->prepare_items();
}

if ($scenario === 'login') {
	wp_authenticate('admin', 'wrong-password');
	wp_authenticate('admin@wordpress.invalid', 'wrong-password');
	wp_set_current_user(1);
	get_user_meta(1);
	get_user_by('login', 'admin');
	wp_get_current_user();
}

if ($scenario === 'single') {
	$post = get_post(1);
	$GLOBALS['post'] = $post;
	setup_postdata($post);
	get_comments(['post_id' => 1, 'status' => 'approve', 'order' => 'ASC']);
	get_comments_number(1);
	wp_count_comments(1);
	get_adjacent_post(false, '', true);
	get_adjacent_post(false, '', false);
	get_the_terms(1, 'category');
	get_the_terms(1, 'post_tag');
	get_post_meta(1);
	get_page_by_path('sample-page');
	url_to_postid(home_url('/2026/01/01/hello-world/'));
	get_posts(['post_type' => 'post', 'numberposts' => 5]);
	get_pages();
}

if ($scenario === 'widgets') {
	wp_get_archives(['echo' => 0]);
	wp_tag_cloud(['echo' => 0]);
	wp_list_categories(['echo' => 0]);
	get_comments(['number' => 5, 'status' => 'approve', 'post_status' => 'publish']);
	$query = new WP_Query([
		'posts_per_page' => 5,
		'no_found_rows' => true,
		'post_status' => 'publish',
		'ignore_sticky_posts' => true,
	]);
	wp_count_posts('post');
	wp_list_pages(['echo' => 0]);
}

echo json_encode(['scenario' => $scenario]) . "\n";
