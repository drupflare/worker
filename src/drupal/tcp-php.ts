import { HOST_HELPERS } from './site-php.js';

/** what one `tcpLive()` run is asked to do */
export interface TcpLiveOptions {
	protocol: 'redis' | 'syslog';
	/** redis: the command and its arguments */
	args?: string[];
	/** syslog: the record text */
	message?: string;
}

/**
 * Drives the TCP tier through `CfwTcp`, so a run exercises the module's own caller rather than
 * `Host::call()`. No kernel: `Host` needs the autoloader and nothing else, and this runs three
 * times per round trip.
 */
export function tcpLive(options: TcpLiveOptions): string {
	const payload = JSON.stringify({
		protocol: options.protocol,
		args: options.args ?? [],
		message: options.message ?? ''
	});
	return String.raw`<?php
${HOST_HELPERS}
chdir('/drupal');

$opt = json_decode(${JSON.stringify(payload)}, true);
$out = ['protocol' => $opt['protocol']];

try {
  if (!isset($GLOBALS['__pw_autoloader'])) {
    $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
  }
  // the pack does not enable this module, so nothing else registers its namespace
  $GLOBALS['__pw_autoloader']->addPsr4('Drupal\\drupflare\\', '/drupal/modules/custom/drupflare/src/');


  $out['available'] = \Drupal\drupflare\Network\CfwTcp::available();
  if ($opt['protocol'] === 'redis') {
    $reply = \Drupal\drupflare\Network\CfwTcp::redis($opt['args']);
    $out['ok'] = $reply['ok'] ?? false;
    $out['value'] = $reply['value'] ?? null;
    $out['error'] = $reply['error'] ?? null;
    $out['queued'] = $reply['queued'] ?? false;
  } else {
    $out['ok'] = \Drupal\drupflare\Network\CfwTcp::syslog($opt['message'], 'info', ['msgId' => 'cfwtcp']);
  }
} catch (\Throwable $e) {
  $out['throw'] = get_class($e) . ': ' . $e->getMessage();
}

echo json_encode($out);
`;
}
