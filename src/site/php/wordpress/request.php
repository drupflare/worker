<?php

// __CFW_HOST_HELPERS__

// WordPress declares ABSPATH and every function once, so an interpreter serves one request
if (defined('ABSPATH')) {
	echo json_encode(['error' => 'this interpreter already served a WordPress request']);
	return;
}

final class CfwWpStop extends Exception {}

// the curl shim answers curl_version() with no features but declares no CURL_VERSION_* constants,
// and WordPress's transport test reads one, so any capability check would be a fatal
if (!defined('CURL_VERSION_SSL')) {
	define('CURL_VERSION_SSL', 4);
}

$cfwReq = json_decode(__CFW_REQUEST__, true);
// only the owner token puts this header in the request, and an unknown value is ignored
$cfwPhase = (string) ($cfwReq['headers']['x-cfw-phase'] ?? '');
if ($cfwPhase === 'boot-only') {
	echo json_encode([
		'status' => 200,
		'html' => '',
		'bytes' => 0,
		'contentType' => 'text/plain',
		'location' => null,
		'cacheControl' => null,
		'vary' => 'X-Cfw-Untaggable',
		'untaggable' => 'phase',
		'tagReasons' => [],
		'tagReaders' => [],
		'passHeaders' => [],
		'setCookie' => [],
		'cacheTags' => [],
		'uid' => 0,
		'renderMs' => 0,
		'entry' => 'boot-only',
	]);
	return;
}
$GLOBALS['cfwPhase'] = $cfwPhase;
$cfwRoot = '/wordpress';
$cfwOrigin = (string) $cfwReq['origin'];
$cfwPath = (string) $cfwReq['path'];
$cfwMethod = strtoupper((string) ($cfwReq['method'] ?: 'GET'));
$cfwParts = parse_url($cfwPath) ?: [];
$cfwUri = (string) ($cfwParts['path'] ?? '/');
$cfwQuery = (string) ($cfwParts['query'] ?? '');
$cfwHost = (string) (parse_url($cfwOrigin, PHP_URL_HOST) ?: 'localhost');
$cfwHttps = strncmp($cfwOrigin, 'https:', 6) === 0;
$cfwPort = (int) (parse_url($cfwOrigin, PHP_URL_PORT) ?: ($cfwHttps ? 443 : 80));

// what a web server's rewrite does: a script WordPress ships answers for itself, anything else is
// the front controller
$cfwScript = '/index.php';
if (
	preg_match('#^/(wp-login|wp-cron|wp-comments-post)\.php$#', $cfwUri) ||
	preg_match('#^/wp-admin/[\w-]+\.php$#', $cfwUri)
) {
	if (is_file($cfwRoot . $cfwUri)) {
		$cfwScript = $cfwUri;
	}
} elseif ($cfwUri === '/wp-admin/' || $cfwUri === '/wp-admin') {
	$cfwScript = '/wp-admin/index.php';
}

$_SERVER['HTTP_HOST'] = $cfwPort === 80 || $cfwPort === 443 ? $cfwHost : $cfwHost . ':' . $cfwPort;
$_SERVER['SERVER_NAME'] = $cfwHost;
$_SERVER['SERVER_PORT'] = (string) $cfwPort;
if ($cfwHttps) {
	$_SERVER['HTTPS'] = 'on';
} else {
	unset($_SERVER['HTTPS']);
}
$_SERVER['REQUEST_URI'] = $cfwPath;
$_SERVER['QUERY_STRING'] = $cfwQuery;
$_SERVER['REQUEST_METHOD'] = $cfwMethod;
$_SERVER['SCRIPT_NAME'] = $cfwScript;
$_SERVER['PHP_SELF'] = $cfwScript;
$_SERVER['SCRIPT_FILENAME'] = $cfwRoot . $cfwScript;
$_SERVER['DOCUMENT_ROOT'] = $cfwRoot;
$_SERVER['REMOTE_ADDR'] = $cfwReq['clientIp'] !== '' ? (string) $cfwReq['clientIp'] : '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';
$_SERVER['REQUEST_TIME'] = time();
$_SERVER['REQUEST_TIME_FLOAT'] = microtime(true);
if ($cfwReq['accept'] !== '') {
	$_SERVER['HTTP_ACCEPT'] = (string) $cfwReq['accept'];
}
if ($cfwReq['cookie'] !== '') {
	$_SERVER['HTTP_COOKIE'] = (string) $cfwReq['cookie'];
}
foreach ((array) $cfwReq['headers'] as $cfwName => $cfwValue) {
	$_SERVER['HTTP_' . strtoupper(str_replace('-', '_', (string) $cfwName))] = (string) $cfwValue;
}
if ($cfwReq['contentType'] !== '') {
	$_SERVER['CONTENT_TYPE'] = (string) $cfwReq['contentType'];
}
// what a web server's SAPI does with Basic credentials, which application passwords read
if (
	preg_match(
		'/^Basic\s+(\S+)$/i',
		(string) ($cfwReq['headers']['authorization'] ?? ''),
		$cfwBasic,
	)
) {
	$cfwPair = explode(':', (string) base64_decode($cfwBasic[1]), 2);
	if (count($cfwPair) === 2) {
		$_SERVER['PHP_AUTH_USER'] = $cfwPair[0];
		$_SERVER['PHP_AUTH_PW'] = $cfwPair[1];
	}
}

$_GET = [];
parse_str($cfwQuery, $_GET);
$_POST = [];
$_COOKIE = [];
foreach (explode(';', (string) $cfwReq['cookie']) as $cfwPair) {
	$cfwPair = trim($cfwPair);
	if ($cfwPair === '') {
		continue;
	}
	$cfwKv = explode('=', $cfwPair, 2) + [1 => ''];
	$_COOKIE[urldecode($cfwKv[0])] = urldecode($cfwKv[1]);
}
$cfwBody = base64_decode((string) $cfwReq['bodyBase64']);
if (
	$cfwMethod !== 'GET' &&
	$cfwMethod !== 'HEAD' &&
	$cfwBody !== '' &&
	stripos((string) $cfwReq['contentType'], 'application/x-www-form-urlencoded') !== false
) {
	parse_str($cfwBody, $_POST);
}

// no POST SAPI fills $_POST and $_FILES for a multipart body, so it is read here. Each file part is
// written to a temp path and listed in $GLOBALS['__cfw_uploads'], which is what the host plugin
// accepts in place of is_uploaded_file(). A part over the size limit gets UPLOAD_ERR_INI_SIZE and
// no file, which is the error WordPress words for it.
$_FILES = [];
$GLOBALS['__cfw_uploads'] = [];
$cfwBoundary = '';
if (
	$cfwMethod !== 'GET' &&
	$cfwMethod !== 'HEAD' &&
	$cfwBody !== '' &&
	preg_match(
		'/^multipart\/form-data;.*boundary="?([^";]+)"?/i',
		(string) $cfwReq['contentType'],
		$cfwMatch,
	)
) {
	$cfwBoundary = $cfwMatch[1];
}
if ($cfwBoundary !== '') {
	$cfwPairs = [];
	foreach (explode('--' . $cfwBoundary, $cfwBody) as $cfwPart) {
		$cfwSplit = strpos($cfwPart, "\r\n\r\n");
		if ($cfwSplit === false) {
			continue;
		}
		$cfwHead = substr($cfwPart, 0, $cfwSplit);
		$cfwValue = substr($cfwPart, $cfwSplit + 4);
		if (substr($cfwValue, -2) === "\r\n") {
			$cfwValue = substr($cfwValue, 0, -2);
		}
		if (!preg_match('/content-disposition:[^\r\n]*\sname="([^"]*)"/i', $cfwHead, $cfwName)) {
			continue;
		}
		if (!preg_match('/\sfilename="([^"]*)"/i', $cfwHead, $cfwFile)) {
			$cfwPairs[] = urlencode($cfwName[1]) . '=' . urlencode($cfwValue);
			continue;
		}
		// a file field left empty arrives as filename="" and is no upload
		if ($cfwFile[1] === '') {
			$_FILES[$cfwName[1]] = [
				'name' => '',
				'type' => '',
				'tmp_name' => '',
				'error' => UPLOAD_ERR_NO_FILE,
				'size' => 0,
			];
			continue;
		}
		$cfwType = preg_match('/content-type:\s*([^\r\n;]+)/i', $cfwHead, $cfwKind)
			? trim($cfwKind[1])
			: 'application/octet-stream';
		$cfwEntry = [
			'name' => $cfwFile[1],
			'type' => $cfwType,
			'tmp_name' => '',
			'error' => UPLOAD_ERR_OK,
			'size' => strlen($cfwValue),
		];
		// the host plugin buffers an upload whole, so this is also the most it will store
		if (strlen($cfwValue) > 10485760) {
			$cfwEntry['error'] = UPLOAD_ERR_INI_SIZE;
			$cfwEntry['size'] = 0;
		} else {
			$cfwTmp = tempnam(sys_get_temp_dir(), 'cfwup');
			if ($cfwTmp === false || file_put_contents($cfwTmp, $cfwValue) === false) {
				$cfwEntry['error'] = UPLOAD_ERR_CANT_WRITE;
			} else {
				$cfwTmp = realpath($cfwTmp) ?: $cfwTmp;
				$GLOBALS['__cfw_uploads'][$cfwTmp] = true;
				$cfwEntry['tmp_name'] = $cfwTmp;
			}
		}
		$_FILES[$cfwName[1]] = $cfwEntry;
	}
	if ($cfwPairs !== []) {
		parse_str(implode('&', $cfwPairs), $_POST);
	}
}
// wp_handle_upload asks is_uploaded_file(), which only a POST SAPI answers true for, and core has
// no filter on that call. The one occurrence in core is pointed at a function that also accepts the
// files parsed above; the copy in this interpreter's filesystem is the only one changed, and only
// on a request that carries an upload.
if ($GLOBALS['__cfw_uploads'] !== []) {
	function cfw_is_uploaded_file($path)
	{
		return isset($GLOBALS['__cfw_uploads'][$path]) || is_uploaded_file($path);
	}

	$cfwUploadsFile = $cfwRoot . '/wp-admin/includes/file.php';
	$cfwSource = (string) file_get_contents($cfwUploadsFile);
	if (substr_count($cfwSource, 'is_uploaded_file(') === 1) {
		file_put_contents(
			$cfwUploadsFile,
			str_replace('is_uploaded_file(', 'cfw_is_uploaded_file(', $cfwSource),
		);
	}
}
// a plugin's own settings page (options-general.php?page=...) is drawn by admin.php, which ends with
// exit once the footer is out. That one exit becomes a stop, in this interpreter's copy and only on
// a request that names a page.
if (str_starts_with($cfwScript, '/wp-admin/') && isset($_GET['page'])) {
	$cfwAdminFile = $cfwRoot . '/wp-admin/admin.php';
	$cfwAdminSource = (string) file_get_contents($cfwAdminFile);
	$cfwFooter = "require_once ABSPATH . 'wp-admin/admin-footer.php';\n\n\t";
	$cfwNext = "\n} elseif ( isset( \$_GET['import'] ) ) {";
	if (substr_count($cfwAdminSource, $cfwFooter . 'exit;' . $cfwNext) === 1) {
		file_put_contents(
			$cfwAdminFile,
			str_replace(
				$cfwFooter . 'exit;' . $cfwNext,
				$cfwFooter . "throw new CfwWpStop('exit');" . $cfwNext,
				$cfwAdminSource,
			),
		);
	}
}
$_REQUEST = array_merge($_GET, $_POST);
// php://input is empty here, and the REST server reads this global before it reads the stream
$GLOBALS['HTTP_RAW_POST_DATA'] = $cfwBody;

// WordPress ends a request with exit() or die() in places, and an exit leaves nothing to read, so
// the four places a GET reaches are turned into a stop. Hooks go in before plugin.php loads, which
// WordPress allows through a preinitialised $wp_filter. x_redirect_by runs after the status is set
// and before the Location header goes out, so the redirect is read from its arguments.
$GLOBALS['wp_filter'] = [
	'x_redirect_by' => [
		0 => [
			[
				'function' => static function ($by, $status, $location) {
					$GLOBALS['cfwWp']['redirect'] = [(int) $status, (string) $location];
					// activate_plugin() sends this one before it includes the plugin and replaces it after
					if (str_contains((string) $location, '_error_nonce=')) {
						return $by;
					}
					throw new CfwWpStop('redirect');
				},
				'accepted_args' => 3,
			],
		],
	],
	// admin-ajax.php?action=rest-nonce is the one core action that ends with a bare exit($nonce)
	'wp_ajax_rest-nonce' => [
		0 => [
			[
				'function' => static function () {
					echo wp_create_nonce('wp_rest');
					throw new CfwWpStop('exit');
				},
				'accepted_args' => 0,
			],
		],
	],
	// the sitemap routes print and then exit: the stylesheet inside its own method, the index and
	// the pages right after the renderer returns, so the renderer is swapped for one that stops
	'template_redirect' => [
		9 => [
			[
				'function' => static function () {
					$type = sanitize_text_field((string) get_query_var('sitemap-stylesheet'));
					if ($type === '' && !get_query_var('sitemap')) {
						return;
					}
					$server = wp_sitemaps_get_server();
					if (!$server->sitemaps_enabled()) {
						return;
					}
					if ($type === 'sitemap' || $type === 'index') {
						$sheet = new WP_Sitemaps_Stylesheet();
						header('Content-Type: application/xml; charset=UTF-8');
						echo $type === 'sitemap'
							? $sheet->get_sitemap_stylesheet()
							: $sheet->get_sitemap_index_stylesheet();
						throw new CfwWpStop('sitemap');
					}
					$server->renderer = new class extends WP_Sitemaps_Renderer {
						public function render_index($sitemaps)
						{
							parent::render_index($sitemaps);
							throw new CfwWpStop('sitemap');
						}

						public function render_sitemap($url_list)
						{
							parent::render_sitemap($url_list);
							throw new CfwWpStop('sitemap');
						}
					};
				},
				'accepted_args' => 0,
			],
		],
	],
	'parse_request' => [
		0 => [
			[
				'function' => static function ($wp) {
					if (empty($wp->query_vars['rest_route'])) {
						return;
					}
					define('REST_REQUEST', true);
					$route = untrailingslashit($wp->query_vars['rest_route']);
					rest_get_server()->serve_request($route === '' ? '/' : $route);
					throw new CfwWpStop('rest');
				},
				'accepted_args' => 1,
			],
		],
	],
];
// wp_die ends with an exit unless its handler is told not to, and each response format has its own
// handler: the page, ajax, json, jsonp and xml ones all print and then stop here instead
foreach (
	[
		'wp_die_handler' => '_default_wp_die_handler',
		'wp_die_ajax_handler' => '_ajax_wp_die_handler',
		'wp_die_json_handler' => '_json_wp_die_handler',
		'wp_die_jsonp_handler' => '_jsonp_wp_die_handler',
		'wp_die_xml_handler' => '_xml_wp_die_handler',
	]
	as $cfwHook => $cfwHandler
) {
	$GLOBALS['wp_filter'][$cfwHook] = [
		0 => [
			[
				'function' => static function () use ($cfwHandler) {
					return static function ($message, $title = '', $args = []) use ($cfwHandler) {
						$cfwHandler(
							$message,
							$title,
							array_merge((array) $args, ['exit' => false]),
						);
						throw new CfwWpStop('die');
					};
				},
				'accepted_args' => 1,
			],
		],
	];
}
$GLOBALS['cfwWp'] = ['redirect' => null];

$cfwOut = [];
$cfwStart = microtime(true) * 1000;
$cfwDepth = ob_get_level();
ob_start();
chdir($cfwRoot);
try {
	if ($cfwPhase === 'load') {
		require $cfwRoot . '/wp-load.php';
		throw new CfwWpStop('load');
	}
	if ($cfwScript === '/wp-cron.php') {
		// cron ends with die() in three places and a die leaves nothing to read, so each is a stop;
		// the lock and the event loop stay WordPress's own
		$cfwCron = (string) file_get_contents($cfwRoot . $cfwScript);
		$cfwCron = str_replace('die();', "throw new CfwWpStop('cron');", $cfwCron);
		$cfwCron = str_replace('__DIR__', var_export($cfwRoot, true), $cfwCron);
		eval('?>' . $cfwCron);
	} else {
		require $cfwRoot . $cfwScript;
	}
} catch (CfwWpStop $e) {
	$cfwOut['stop'] = $e->getMessage();
} catch (Throwable $e) {
	$cfwOut['error'] = get_class($e) . ': ' . $e->getMessage();
	$cfwOut['at'] = $e->getFile() . ':' . $e->getLine();
}
try {
	if (function_exists('shutdown_action_hook')) {
		// it flushes every output level, this fragment's included, so the loop below does it instead
		remove_action('shutdown', 'wp_ob_end_flush_all', 1);
		shutdown_action_hook();
	}
} catch (Throwable $e) {
	$cfwOut['shutdownError'] = get_class($e) . ': ' . $e->getMessage();
}
// the page's tags, and the end of the run for the host: a write nobody announced is judged here
$cfwTags = ['tags' => [], 'untaggable' => 'no-tag-emitter'];
try {
	if (function_exists('drupflare_tags_finish')) {
		$cfwTags = drupflare_tags_finish();
	}
} catch (Throwable $e) {
	$cfwTags = ['tags' => [], 'untaggable' => 'tags-failed'];
}
while (ob_get_level() > $cfwDepth + 1) {
	ob_end_flush();
}
$cfwHtml = (string) ob_get_clean();

$cfwStatus = http_response_code();
$cfwStatus = is_int($cfwStatus) ? $cfwStatus : 200;
$cfwRedirect = $GLOBALS['cfwWp']['redirect'];
if ($cfwRedirect !== null) {
	$cfwStatus = $cfwRedirect[0];
}
$cfwCookies = [];
$cfwPass = [];
$cfwType = 'text/html; charset=UTF-8';
$cfwLocation = $cfwRedirect !== null ? $cfwRedirect[1] : null;
foreach (headers_list() as $cfwLine) {
	$cfwAt = strpos($cfwLine, ':');
	if ($cfwAt === false) {
		continue;
	}
	$cfwName = strtolower(substr($cfwLine, 0, $cfwAt));
	$cfwValue = trim(substr($cfwLine, $cfwAt + 1));
	if ($cfwName === 'set-cookie') {
		$cfwCookies[] = $cfwValue;
	} elseif ($cfwName === 'content-type') {
		$cfwType = $cfwValue;
	} elseif ($cfwName === 'location') {
		$cfwLocation = $cfwValue;
	} elseif ($cfwName !== 'x-powered-by' && $cfwName !== 'content-length') {
		$cfwPass[$cfwName] = isset($cfwPass[$cfwName])
			? $cfwPass[$cfwName] . ', ' . $cfwValue
			: $cfwValue;
	}
}

// the stop reads the redirect from its arguments, and a Location header sent earlier (activate_plugin
// sends a provisional one) must not replace it
if ($cfwRedirect !== null) {
	$cfwLocation = $cfwRedirect[1];
}
$cfwOut['status'] = $cfwStatus;
$cfwOut['html'] = $cfwHtml;
$cfwOut['bytes'] = strlen($cfwHtml);
$cfwOut['contentType'] = $cfwType;
$cfwOut['location'] = $cfwLocation;
$cfwOut['cacheControl'] = $cfwPass['cache-control'] ?? null;
$cfwOut['vary'] = $cfwPass['vary'] ?? '';
// a page whose tags cannot be named says it varies by something the page key lacks, which the
// shared checks never store; the marker header is not passed on (only x-drupal-* and policy headers are)
if ($cfwTags['untaggable'] !== null || $cfwTags['tags'] === []) {
	$cfwOut['vary'] = trim($cfwOut['vary'] . ', X-Cfw-Untaggable', ', ');
}
$cfwOut['untaggable'] = $cfwTags['untaggable'];
$cfwOut['tagReasons'] = $cfwTags['reasons'] ?? [];
$cfwOut['tagReaders'] = $cfwTags['readers'] ?? [];
$cfwOut['passHeaders'] = $cfwPass;
$cfwOut['setCookie'] = array_values(array_unique($cfwCookies));
$cfwOut['cacheTags'] = $cfwTags['untaggable'] === null ? $cfwTags['tags'] : [];
$cfwOut['uid'] = function_exists('get_current_user_id') ? (int) get_current_user_id() : 0;
$cfwOut['renderMs'] = round(microtime(true) * 1000 - $cfwStart, 2);
$cfwOut['entry'] = $cfwScript;
echo json_encode($cfwOut, JSON_INVALID_UTF8_SUBSTITUTE);
