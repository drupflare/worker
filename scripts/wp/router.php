<?php

$root = getenv('WP_ROOT');
$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/');
if ($path === '/__ping') {
	header('Content-Type: text/plain');
	echo 'pong';
	return true;
}
$file = $root . $path;
if ($path !== '/' && is_file($file)) {
	return false;
}
if ($path !== '/' && is_dir($file) && is_file(rtrim($file, '/') . '/index.php')) {
	return false;
}
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = $root . '/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
chdir($root);
require $root . '/index.php';
