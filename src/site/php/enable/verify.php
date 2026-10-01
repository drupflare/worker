<?php
$out = ['ok' => true];

try {
	$list = array_keys(Drupal::configFactory()->get('core.extension')->get('module') ?? []);
	$out['enabled'] = in_array('drupflare', $list, true);
	$out['moduleCount'] = count($list);
} catch (Throwable $e) {
	$out['configError'] = $e->getMessage();
}

// the four services that were unreached. has() rather than get(), so a construction failure is
// told apart from an absent definition.
foreach (['logger.cfw', 'drupflare.http_deferred', 'drupflare.request_resetter'] as $id) {
	try {
		$out['has'][$id] = Drupal::hasService($id);
	} catch (Throwable $e) {
		$out['has'][$id] = 'error: ' . $e->getMessage();
	}
}

// the real test: does a Drupal::logger() call reach CfwLogger. A registered service that nothing
// routes to is still dead, and the logger channel is exactly where that distinction hides.
try {
	$marker = 'cfw-enable-' . substr(sha1((string) mt_rand()), 0, 8);
	Drupal::logger('cfw-enable')->warning('reached @m', ['@m' => $marker]);
	$seen = false;
	if (function_exists('vrzno_env')) {
		$probe = vrzno_env('cfwLogTail');
		if (is_object($probe) || is_callable($probe)) {
			$seen = true;
		}
	}
	$out['loggerMarker'] = $marker;
	$out['loggerCalled'] = true;
	$out['loggerTailAvailable'] = $seen;
} catch (Throwable $e) {
	$out['loggerError'] = $e->getMessage();
	$out['ok'] = false;
}

// which class answers path.matcher, and whether it can be reset. A services.yml override that did
// not take leaves core's PathMatcher in place, method_exists() finds no reset(), and the front-page
// memo keeps leaking with every symptom intact -- so this has to be read rather than assumed.
try {
	$matcher = Drupal::service('path.matcher');
	$out['pathMatcherClass'] = get_class($matcher);
	$out['pathMatcherResettable'] = method_exists($matcher, 'reset');
	$out['isFrontPageNow'] = $matcher->isFrontPage();
} catch (Throwable $e) {
	$out['pathMatcherError'] = $e->getMessage();
}

try {
	$out['routerRoutes'] = (int) Drupal::database()
		->query('SELECT COUNT(*) FROM {router}')
		->fetchField();
} catch (Throwable $e) {
	$out['routerError'] = $e->getMessage();
}

echo json_encode($out);
