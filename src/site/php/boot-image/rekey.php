<?php

use Drupal\Core\Block\BlockManager;
use Drupal\Core\Cache\CacheCollector;
use Drupal\Core\Cache\MemoryBackend;
use Drupal\Core\Config\CachedStorage;
use Drupal\Core\Config\ConfigFactory;
use Drupal\Core\Config\ImmutableConfig;
use Drupal\Core\Entity\EntityDisplayRepository;
use Drupal\Core\Entity\EntityFieldManager;
use Drupal\Core\Entity\EntityLastInstalledSchemaRepository;
use Drupal\Core\Entity\EntityTypeBundleInfo;
use Drupal\Core\Entity\EntityTypeManager;
use Drupal\Core\Menu\LocalActionManager;
use Drupal\Core\Menu\LocalTaskManager;
use Drupal\Core\Path\PathMatcher;
use Drupal\Core\Site\Settings;
use Drupal\Core\TypedData\TypedDataManager;
use Drupal\drupflare\Cache\CfwMemoryBackend;
use Symfony\Component\HttpFoundation\Request;

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
			if ($service instanceof CfwMemoryBackend || $service instanceof MemoryBackend) {
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

// the bake's last request stays on the stack and reads as a routed actor to a host run; a plain
// boot leaves the bare request a kernel boot pushes, which a restored kernel never pushes again
$step('requests', function () {
	$stack = Drupal::service('request_stack');
	while ($stack->getCurrentRequest() !== null) {
		$stack->pop();
	}
	$boot = Request::create('/', 'GET');
	$stack->push($boot);
	Drupal::service('router.request_context')->fromRequest($boot);
});

// the lists memoise what the bake found on disk, and an upload adds extensions the context
// does not key on; only the memos clear, the persisted lists stay
$step('extensions', function () {
	$container = Drupal::getContainer();
	foreach (['module', 'theme', 'profile', 'theme_engine'] as $type) {
		$id = 'extension.list.' . $type;
		if (!$container->initialized($id)) {
			continue;
		}
		$list = $container->get($id);
		foreach (['extensions', 'extensionInfo', 'pathNames', 'installedThemes'] as $name) {
			if (property_exists($list, $name)) {
				(new ReflectionProperty($list, $name))->setValue($list, null);
			}
		}
	}
});

// an image keyed without the config rows also holds the config objects and entities the bake read,
// and neither is validated against this site's database again
if (__CFW_RESET_CONFIG__) {
	// services hold the bake's config objects; each reloads in place from the active storage and
	// stays the factory's copy, so a later save reaches it (reset() orphans them)
	$step('config', function () {
		$factory = Drupal::configFactory();
		$cache = new ReflectionProperty(ConfigFactory::class, 'cache');
		$overrides = new ReflectionMethod(ConfigFactory::class, 'loadOverrides');
		$cached = Drupal::service('config.storage');
		$active = (new ReflectionProperty(CachedStorage::class, 'storage'))->getValue($cached);
		foreach ($cache->getValue($factory) as $config) {
			$name = $config->getName();
			$data = $active->read($name);
			if ($data === false) {
				$factory->reset($name);
				continue;
			}
			$config->initWithData($data);
			if ($config instanceof ImmutableConfig) {
				$config->setModuleOverride($overrides->invoke($factory, [$name])[$name] ?? []);
				$config->setSettingsOverride($GLOBALS['config'][$name] ?? []);
			}
		}
		$cached->resetListCache();
	});
	$step('entities', function () {
		Drupal::service('entity.memory_cache')->deleteAll();
	});
	// memos built from config entities and values; only the memo clears, persisted caches stay
	$step('definitions', function () {
		$memos = [
			EntityTypeBundleInfo::class => ['bundleInfo' => []],
			EntityTypeManager::class => ['handlers' => []],
			EntityFieldManager::class => [
				'baseFieldDefinitions' => [],
				'fieldDefinitions' => [],
				'fieldStorageDefinitions' => [],
				'activeFieldStorageDefinitions' => [],
				'fieldMap' => [],
				'fieldMapByFieldType' => [],
				'extraFields' => null,
				'baseFieldOverrides' => null,
			],
			EntityDisplayRepository::class => ['displayModeInfo' => []],
			EntityLastInstalledSchemaRepository::class => [
				'entityTypeDefinitions' => null,
				'entityFieldStorageDefinitions' => null,
			],
			TypedDataManager::class => ['definitions' => null, 'prototypes' => []],
			BlockManager::class => ['definitions' => null],
			LocalTaskManager::class => ['definitions' => null],
			LocalActionManager::class => ['definitions' => null],
			PathMatcher::class => [
				'frontPage' => null,
				'isCurrentFrontPage' => null,
				'regexes' => [],
			],
		];
		$container = Drupal::getContainer();
		foreach ($container->getServiceIds() as $id) {
			if (!$container->initialized($id)) {
				continue;
			}
			$service = $container->get($id);
			foreach ($memos as $class => $properties) {
				if (!($service instanceof $class)) {
					continue;
				}
				foreach ($properties as $name => $empty) {
					if (property_exists($service, $name)) {
						(new ReflectionProperty($service, $name))->setValue($service, $empty);
					}
				}
			}
		}
	});
}

echo json_encode($out);
