<?php

// seeds the posts a front page check lists, with dates the scenario chooses
// FRONT_SCENARIO: spaced (one second apart), ties (one date for all), protected (a password post
// is the newest), sticky (an older post is sticky)

require_once getenv('WP_ROOT') . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/post.php';

global $wpdb;
wp_set_current_user(1);
update_option('posts_per_page', 3);
foreach (get_posts(['numberposts' => -1, 'post_status' => 'any']) as $old) {
	wp_delete_post($old->ID, true);
}
update_option('sticky_posts', []);

$scenario = getenv('FRONT_SCENARIO') ?: 'spaced';
$base = 1_700_000_000;
$n = 0;
$make = function (string $title, string $status = 'publish', array $extra = []) use (
	&$n,
	$base,
	$scenario,
) {
	$n++;
	$date = gmdate('Y-m-d H:i:s', $scenario === 'ties' ? $base : $base + $n);
	return wp_insert_post(
		array_merge(
			[
				'post_title' => $title,
				'post_content' => 'body',
				'post_status' => $status,
				'post_author' => 1,
				'post_date' => $date,
				'post_date_gmt' => $date,
			],
			$extra,
		),
	);
};

$ids = [];
for ($i = 1; $i <= 6; $i++) {
	$ids[] = $make("Seed $i");
}
if (in_array($scenario, ['protected', 'spaced', 'ties'], true)) {
	$make('Private one', 'private');
	$make('Draft one', 'draft');
	$make('Protected one', 'publish', ['post_password' => 'x']);
}
if ($scenario === 'sticky') {
	stick_post($ids[0]);
}

echo json_encode(
	$wpdb->get_results(
		"SELECT ID, post_date, post_date_gmt, post_status, post_type, post_modified, menu_order FROM {$wpdb->posts} ORDER BY ID",
		ARRAY_A,
	),
) . "\n";
echo json_encode(get_option('sticky_posts')) . "\n";
