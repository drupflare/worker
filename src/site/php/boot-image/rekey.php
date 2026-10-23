<?php

use Drupal\Core\Cache\CacheCollector;
use Drupal\Core\Site\Settings;
use Drupal\drupflare\Cache\CfwMemoryBackend;

// a restored heap carries the bake site's settings, state cache, memory cache and random state; each
// step makes one of them this site's. A step that throws is reported and the caller drops the heap
$out = ['steps' => [], 'errors' => []];
$step = function (string $name, callable $fn) use (&$out) {
	try {
		$fn();
		$out['steps'][] = $name;
	} catch (Throwable $e) {
		$out['errors'][] = $name . ': ' . get_class($e) . ': ' . $e->getMessage();
	}
};

// reads settings.php again, which the boot wrote for this site: the salt, the origin and every
// setting the context does not key on
$step('settings', function () {
	$loader = $GLOBALS['__pw_autoloader'];
	Settings::initialize('/drupal', 'sites/default', $loader);
});

// values the bake computed from its salt and key, such as an anonymous user's permissions hash
$step('memory', function () {
	Drupal::service('cache.memory')->deleteAll();
});

// the bins kept in memory by default hold the bake's entries, and a tag counter cannot tell them from
// this site's: two sites with the same number of saves read the same count
$step('memory bins', function () {
	$container = Drupal::getContainer();
	foreach ($container->getServiceIds() as $id) {
		if (str_starts_with($id, 'cache.') && $container->initialized($id)) {
			$service = $container->get($id);
			if ($service instanceof CfwMemoryBackend) {
				$service->deleteAll();
			}
		}
	}
});

// the generator state is in the heap, so every replay would otherwise draw the bake's sequence
$step('random', function () {
	mt_srand(unpack('V', random_bytes(4))[1]);
});

// a collector holds what the bake computed, State's private key among it, and some of it is not yet
// persisted: the first request's resetter would write it into this site's cache under this site's
// current tag checksums, so it would read as valid. The bake's active trail for a route did exactly
// that
$step('collectors', function () {
	$container = Drupal::getContainer();
	foreach ($container->getServiceIds() as $id) {
		if ($container->initialized($id)) {
			$service = $container->get($id);
			if ($service instanceof CacheCollector) {
				$service->reset();
			}
		}
	}
});

// an image keyed without the config rows also holds the config objects and entities the bake read,
// and neither is validated against this site's database again
if (__CFW_RESET_CONFIG__) {
	$step('config', function () {
		Drupal::configFactory()->reset();
	});
	$step('entities', function () {
		Drupal::service('entity.memory_cache')->deleteAll();
	});
}

echo json_encode($out);
