<?php

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Drupal\node\Entity\Node;
use Drupal\node\Entity\NodeType;
use Drupal\user\Entity\User;
use Symfony\Component\HttpFoundation\Request;

// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
// __CFW_PW_SERVE_INLINE__
chdir('/drupal');

$opt = json_decode(__CFW_PAYLOAD__, true);
$out = ['ok' => false];
$clock = function () {
	return microtime(true) * 1000;
};
$statements = function () {
	return json_decode(cfw_host('cfwStats')(), true)['queryCount'] ?? 0;
};

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
	if (!isset($GLOBALS['__pw_autoloader']) || !is_object($GLOBALS['__pw_autoloader'])) {
		$GLOBALS['__pw_autoloader'] = require '/drupal/autoload.php';
	}
	$autoloader = $GLOBALS['__pw_autoloader'];

	if (!isset($GLOBALS['__pw_kernel'])) {
		$request = Request::create('/', 'GET');
		$kernel = new DrupalKernel('prod', $autoloader);
		DrupalKernel::bootEnvironment();
		$sitePath = DrupalKernel::findSitePath($request);
		$kernel->setSitePath($sitePath);
		Settings::initialize('/drupal', $sitePath, $autoloader);
		$kernel->boot();
		$GLOBALS['__pw_kernel'] = $kernel;
		$out['bootedKernel'] = 1;
	}

	// SAVED_NEW / SAVED_UPDATED live in core/includes/common.inc, which boot() does
	// not include and no render needs; EntityStorageBase::doSave() returns one
	if (!defined('SAVED_NEW')) {
		require_once '/drupal/core/includes/common.inc';
		$out['loadedCommonInc'] = true;
	}

	// __CFW_SCHEMA_REPAIR__

	// Whoever owns the content has to be the acting user for the save, or node access
	// denies the save's own reads.
	//
	// and it must be put back. The interpreter persists between requests, so a
	// current-user switch that is never undone leaks into every later render in the
	// process -- measured: the front page went from 12,296 bytes to 90,038 because the
	// alarm chain rendered it as uid 1, and that ADMIN HTML was then stored in the
	// anonymous page cache and served to visitors. A cache-poisoning bug from one
	// unrestored global.
	$previousAccount = Drupal::currentUser()->getAccount();
	$admin = User::load(1);
	if ($admin !== null) {
		Drupal::currentUser()->setAccount($admin);
		$out['actingUid'] = (int) $admin->id();
	}

	$types = array_keys(NodeType::loadMultiple());
	$out['availableTypes'] = $types;
	$type = $opt['type'] ?? null;
	if ($type === null || !in_array($type, $types, true)) {
		$type = in_array('article', $types, true) ? 'article' : $types[0] ?? null;
	}
	if ($type === null) {
		throw new RuntimeException('no node type exists in this site, so nothing can be saved');
	}
	$out['type'] = $type;

	$title = $opt['title'] ?? 'Measured save ' . date('H:i:s');
	$values = [
		'type' => $type,
		'title' => $title,
		'uid' => 1,
		'status' => 1,
		// promoted, so the FRONT PAGE changes and this measures a refresh
		'promote' => 1,
	];
	$node = Node::create($values);
	$definitions = Drupal::service('entity_field.manager')->getFieldDefinitions('node', $type);
	if (isset($definitions['body'])) {
		$node->set('body', [
			'value' => $opt['body'] ?? 'Written from inside a Durable Object.',
			'format' => 'basic_html',
		]);
		$out['bodySet'] = true;
	}

	$before = $statements();
	$t0 = $clock();
	$result = $node->save();
	$out['saveMs'] = round($clock() - $t0, 2);
	$out['saveStatements'] = $statements() - $before;
	$out['saveResult'] = (int) $result;
	$out['savedIsNew'] = defined('SAVED_NEW') && $result === SAVED_NEW;
	$out['nid'] = (int) $node->id();
	$out['vid'] = (int) $node->getRevisionId();

	// read it back through a FRESH storage handler, so this is the database answering
	// rather than the entity object that was just held in memory
	Drupal::entityTypeManager()
		->getStorage('node')
		->resetCache([$node->id()]);
	$reloaded = Node::load($node->id());
	$out['reloadedTitle'] = $reloaded === null ? null : $reloaded->getTitle();
	$out['persisted'] = $reloaded !== null && $reloaded->getTitle() === $title;

	// back to whoever was acting before, BEFORE anything renders, so these figures are
	// the anonymous page a visitor gets and comparable to every other render here
	Drupal::currentUser()->setAccount($previousAccount);
	$out['restoredUid'] = (int) Drupal::currentUser()->id();

	// and the refresh half: the node's own page, then the front page
	foreach (['/node/' . $node->id() => 'nodePage', '/' => 'frontPage'] as $path => $key) {
		foreach (['page', 'dynamic_page_cache'] as $bin) {
			try {
				Drupal::cache($bin)->deleteAll();
			} catch (Throwable $e) {
			}
		}
		try {
			$middleware = Drupal::service('http_middleware.page_cache');
			$rp = new ReflectionProperty($middleware, 'cid');
			$rp->setValue($middleware, null);
		} catch (Throwable $e) {
		}
		$b = $statements();
		$a = $clock();
		$response = cfw_serve($path);
		$body = (string) $response->getContent();
		$out[$key] = [
			'ms' => round($clock() - $a, 2),
			'status' => $response->getStatusCode(),
			'bytes' => strlen($body),
			'statements' => $statements() - $b,
			'pageCache' => $response->headers->get('x-drupal-cache'),
			'dynamicCache' => $response->headers->get('x-drupal-dynamic-cache'),
			'showsTitle' => str_contains($body, $title) ? 1 : 0,
		];
	}

	$out['ok'] = $out['persisted'] === true;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['trace'] = substr($e->getTraceAsString(), 0, 1200);
} finally {
	// a throw between the switch and the restore would poison every later render in
	// this interpreter, so the restore cannot live only on the happy path
	if (isset($previousAccount)) {
		try {
			Drupal::currentUser()->setAccount($previousAccount);
		} catch (Throwable $e2) {
		}
	}
}

echo json_encode($out);
