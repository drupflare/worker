<?php
$out = ['ok' => false];
try {
	$container = Drupal::getContainer();
	if ($container === null || !$container->initialized('session_manager')) {
		$out['error'] = 'session_manager was never initialised';
	} else {
		$manager = $container->get('session_manager');
		$reflection = new ReflectionObject($manager);
		$reflection->getProperty('started')->setValue($manager, true);
		$reflection->getProperty('closed')->setValue($manager, false);
		$out['started'] = (bool) $reflection->getProperty('started')->getValue($manager);
		$out['closed'] = (bool) $reflection->getProperty('closed')->getValue($manager);
		$out['flashes'] = isset($_SESSION['_symfony_flashes'])
			? array_map('count', (array) $_SESSION['_symfony_flashes'])
			: [];
		$out['ok'] = true;
	}
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
}
echo json_encode($out);
