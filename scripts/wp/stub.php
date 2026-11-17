<?php

// php -S runs the router and then the script it returns false for, so this file loads twice
if (!isset($GLOBALS['__cfw'])) {
	if (getenv('CFW_TRACE')) {
		require_once __DIR__ . '/trace.php';
	}

	$cfwHelpers = getenv('CFW_HELPERS') ?: __DIR__ . '/../../src/site/php/host-helpers.php';
	$cfwCodec = getenv('CFW_CODEC');
	if ($cfwCodec === false || !is_file($cfwCodec)) {
		fwrite(STDERR, "CFW_CODEC must name the file holding the codec\n");
		exit(2);
	}
	require_once $cfwCodec;
	require_once $cfwHelpers;

	$GLOBALS['__cfw'] = ['sock' => null, 'sent' => 0, 'reconnects' => 0];

	function cfw_stub_line($line)
	{
		$state = &$GLOBALS['__cfw'];
		for ($attempt = 0; $attempt < 2; $attempt++) {
			if ($state['sock'] === null) {
				$sock = @stream_socket_client('unix://' . getenv('CFW_SOCKET'), $errno, $err, 5);
				if ($sock === false) {
					return false;
				}
				$state['sock'] = $sock;
				if ($attempt > 0 || $state['sent'] > 0) {
					$state['reconnects']++;
				}
			}
			$written = @fwrite($state['sock'], $line . "\n");
			$reply = $written === false ? false : fgets($state['sock']);
			if ($reply !== false) {
				return rtrim($reply, "\n");
			}
			fclose($state['sock']);
			$state['sock'] = null;
		}
		return false;
	}

	function vrzno_env($name)
	{
		if ($name === 'cfwWpTags') {
			return static fn($json) => cfw_stub_line('t' . $json);
		}
		if ($name !== 'cfwMysqlExec') {
			return null;
		}
		return static function ($json) {
			$GLOBALS['__cfw']['sent']++;
			return cfw_stub_line('x' . $json);
		};
	}

	$cfwLabel =
		PHP_SAPI === 'cli-server'
			? $_SERVER['REQUEST_METHOD'] . ' ' . $_SERVER['REQUEST_URI']
			: (getenv('CFW_LABEL') ?:
			'cli');
	cfw_stub_line('b' . $cfwLabel);

	// nested, so it runs after WordPress's own shutdown work, as the object's fragment does
	register_shutdown_function(static function () {
		register_shutdown_function(static function () {
			global $wpdb;
			$tags = function_exists('drupflare_tags_finish') ? drupflare_tags_finish() : null;
			$queries =
				is_object($wpdb) && is_array($wpdb->queries ?? null) ? count($wpdb->queries) : null;
			$fatal = [];
			$last = error_get_last();
			$fatals = [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR];
			if ($last !== null && in_array($last['type'], $fatals, true)) {
				$fatal[] = $last['message'];
			}
			cfw_stub_line(
				'e' .
					json_encode([
						'sent' => $GLOBALS['__cfw']['sent'],
						'reconnects' => $GLOBALS['__cfw']['reconnects'],
						'wpdbQueries' => $queries,
						'status' => PHP_SAPI === 'cli-server' ? http_response_code() : null,
						'fatal' => $fatal,
						'peakBytes' => memory_get_peak_usage(true),
						'tags' => $tags,
					]),
			);
		});
	});
}
