<?php

use Drupal\drupflare\Network\CfwTcp;

// __CFW_HOST_HELPERS__
chdir('/drupal');

$opt = json_decode(__CFW_PAYLOAD__, true);
$out = ['protocol' => $opt['protocol']];

try {
	// require rather than require_once: the latter returns TRUE on a second call, and a heap restore
	// reaches that state; see the note in site-php.ts
	if (!isset($GLOBALS['__pw_autoloader']) || !is_object($GLOBALS['__pw_autoloader'])) {
		$GLOBALS['__pw_autoloader'] = require '/drupal/autoload.php';
	}
	// the pack does not enable this module, so nothing else registers its namespace
	$GLOBALS['__pw_autoloader']->addPsr4(
		'Drupal\\drupflare\\',
		'/drupal/modules/custom/drupflare/src/',
	);

	$out['available'] = CfwTcp::available();
	if ($opt['protocol'] === 'redis') {
		$reply = CfwTcp::redis($opt['args']);
		$out['ok'] = $reply['ok'] ?? false;
		$out['value'] = $reply['value'] ?? null;
		$out['error'] = $reply['error'] ?? null;
		$out['queued'] = $reply['queued'] ?? false;
	} else {
		$out['ok'] = CfwTcp::syslog($opt['message'], 'info', ['msgId' => 'cfwtcp']);
	}
} catch (Throwable $e) {
	$out['throw'] = get_class($e) . ': ' . $e->getMessage();
}

echo json_encode($out);
