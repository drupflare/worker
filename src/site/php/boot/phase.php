<?php
// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
// __CFW_PW_SERVE_INLINE__
chdir('/drupal');

$mark = ['phase' => __CFW_PHASE__];
$clock = function () {
	return microtime(true) * 1000;
};
$t0 = $clock();

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

try {
	// a warm object would make every phase past this one free, and a free phase reads as a cheap one
	$mark['alreadyBooted'] = isset($GLOBALS['__pw_site_booted']) ? 1 : 0;

	$autoloader = require '/drupal/autoload.php';
	$mark['autoloadDone'] = true;
	// __CFW_KERNEL_NEW__
	// __CFW_CONTAINER_READ__
	// __CFW_CONTAINER_UNSERIALIZE__
	// __CFW_KERNEL_BOOT__
	// __CFW_PRE_HANDLE__
	// __CFW_RENDER__
	// a LOCAL figure, kept only so a local run is orderable; it reads 0 on the edge, where the real
	// number is cpuTime from wrangler tail
	$mark['localMs'] = round($clock() - $t0, 2);
	$mark['ok'] = true;
	echo json_encode($mark);
} catch (Throwable $e) {
	$mark['ok'] = false;
	$mark['error'] = get_class($e) . ': ' . $e->getMessage();
	echo json_encode($mark);
}
