<?php

// a plugin the way a site adds a post type: registered on init, listed by its own archive
add_action('init', function () {
	register_post_type('book', [
		'label' => 'Books',
		'public' => true,
		'has_archive' => true,
		'rewrite' => ['slug' => 'books'],
		'supports' => ['title', 'editor', 'comments'],
	]);
});
