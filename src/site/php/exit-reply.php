<?php

/**
 * What PHP had set up for the response when the script ended in exit(), read from its header
 * state; the keys are the ones the render harness answers.
 *
 * @return array
 *   The page-shaped fields. `html` stays empty: the host takes the body from what PHP printed.
 */
function cfw_exit_fields(): array
{
	$status = http_response_code();
	$headers = [];
	$cookies = [];
	foreach (headers_list() as $line) {
		$at = strpos($line, ':');
		if ($at === false) {
			continue;
		}
		$name = strtolower(substr($line, 0, $at));
		$value = trim(substr($line, $at + 1));
		if ($name === 'set-cookie') {
			$cookies[] = $value;
		} elseif ($name !== 'x-powered-by' && $name !== 'content-length') {
			$headers[$name] = isset($headers[$name]) ? $headers[$name] . ', ' . $value : $value;
		}
	}
	return [
		'status' => is_int($status) ? $status : 200,
		'html' => '',
		'bytes' => 0,
		'pageCache' => null,
		'dynamicCache' => null,
		'cacheTags' => [],
		'contentType' => $headers['content-type'] ?? null,
		'location' => $headers['location'] ?? null,
		'cacheControl' => $headers['cache-control'] ?? null,
		'vary' => $headers['vary'] ?? '',
		'passHeaders' => $headers,
		'setCookie' => array_values(array_unique($cookies)),
	];
}

/**
 * The first shutdown function a harness registers. It only queues the one that prints, because
 * a function registered while the shutdown functions run goes to the end of the list, after
 * every other one.
 */
function cfw_reply_hook(): void
{
	$GLOBALS['__cfw_reply_hook'] = 0;
	register_shutdown_function('cfw_reply_exit');
}

function cfw_reply_exit(): void
{
	$emit = $GLOBALS['__cfw_reply'] ?? null;
	if ($emit !== null) {
		$emit(true);
	}
}

/**
 * Arms the reply a harness prints once, whether the script returns or PHP ends it with exit().
 *
 * An exit leaves the harness no chance to echo, so the reply comes from a shutdown function
 * that runs after every other one. Output buffers are flushed first (their callbacks fire, and
 * the reply would otherwise land inside them), and a mark before the reply tells the host
 * where the page PHP printed stops.
 *
 * The hook is a named function and the closure sits in a global, so a render that returns
 * normally leaves no closure behind for the next one. The hook is registered again every 16th
 * arm until one has run: a shutdown function that itself calls exit() skips the rest of the
 * list, this hook included, and without that the hook would stay lost.
 *
 * @param Closure $build
 *   Takes true when PHP ended in exit() and returns the reply array.
 *
 * @return Closure
 *   Call it as the last statement of the script; it prints nothing if the exit hook did.
 */
function cfw_reply_arm(Closure $build): Closure
{
	$base = ob_get_level();
	// the headers and the response code outlive the run, and an earlier request's are not this one's
	if (!headers_sent()) {
		header_remove();
		http_response_code(200);
	}
	$printed = false;
	$emit = function (bool $exited = false) use (&$printed, $build, $base): void {
		if ($printed) {
			return;
		}
		$printed = true;
		unset($GLOBALS['__cfw_reply']);
		if ($exited) {
			while (ob_get_level() > $base) {
				ob_end_flush();
			}
		}
		try {
			$reply = $build($exited);
		} catch (Throwable $e) {
			$reply = ['error' => get_class($e) . ': ' . $e->getMessage()];
		}
		if ($exited) {
			$reply['phpExit'] = true;
			echo "\x1ecfw-reply\x1e";
		}
		echo json_encode($reply);
	};
	$GLOBALS['__cfw_reply'] = $emit;
	$left = $GLOBALS['__cfw_reply_hook'] ?? 0;
	if ($left <= 0) {
		register_shutdown_function('cfw_reply_hook');
		$left = 16;
	}
	$GLOBALS['__cfw_reply_hook'] = $left - 1;
	return $emit;
}
