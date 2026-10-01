<?php

use Drupal\Component\Utility\Html;
use Drupal\Core\Cache\CacheCollector;
use Drupal\Core\Database\Database;
use Drupal\Core\Entity\EntityViewBuilder;
use Drupal\Core\Form\FormState;
use Drupal\Core\Render\Renderer;

// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
chdir('/drupal');

$obFound = ob_get_level();
while (ob_get_level() > 0) {
	@ob_end_clean();
}

$out = ['obLevel' => $obFound];
$out['headers'] = function_exists('headers_list') ? count(headers_list()) : -1;
$out['sessionStatus'] = function_exists('session_status') ? session_status() : -1;
$out['sessionId'] = function_exists('session_id') ? (string) @session_id() : '';
$out['sessionKeys'] =
	isset($GLOBALS['_SESSION']) && is_array($GLOBALS['_SESSION'])
		? array_keys($GLOBALS['_SESSION'])
		: [];
$out['booted'] = isset($GLOBALS['__pw_kernel']) ? 1 : 0;
$out['post'] =
	isset($GLOBALS['_POST']) && is_array($GLOBALS['_POST']) ? array_keys($GLOBALS['_POST']) : [];
$out['cookies'] =
	isset($GLOBALS['_COOKIE']) && is_array($GLOBALS['_COOKIE'])
		? array_keys($GLOBALS['_COOKIE'])
		: [];

$ask = function (callable $fn) {
	try {
		return $fn();
	} catch (Throwable $e) {
		return 'ERR: ' . substr($e->getMessage(), 0, 120);
	}
};

// #region the named carriers
$out['uid'] = $ask(function () {
	return (int) Drupal::currentUser()->id();
});

// memoised by ThemeManager::getActiveTheme() and cleared only by resetActiveTheme(), which on a
// normal request nothing calls -- so the FIRST route to negotiate decides the theme for the object
$out['theme'] = $ask(function () {
	$container = Drupal::getContainer();
	if ($container === null || !$container->initialized('theme.manager')) {
		return null;
	}
	$manager = $container->get('theme.manager');
	return $manager->hasActiveTheme() ? $manager->getActiveTheme()->getName() : null;
});

$out['formErrors'] = $ask(function () {
	return FormState::hasAnyErrors() ? 1 : 0;
});

$out['seenIds'] = $ask(function () {
	$property = new ReflectionProperty(Html::class, 'seenIds');
	$value = $property->getValue();
	return is_array($value) ? count($value) : -1;
});

// the carrier beside it, and the one the blind half could not have caught: it only moves on an
// AJAX request and nothing in the sweep makes one. Left true it sends getUniqueId() down its
// random branch, so every id on every later render differs on every request
$out['isAjax'] = $ask(function () {
	$property = new ReflectionProperty(Html::class, 'isAjax');
	return $property->getValue() ? 1 : 0;
});

// the same shape on a SERVICE, which is why the blind half over class statics cannot see it.
// Messenger::addMessage() triggers it and core never untriggers it, so one save makes every later
// render on the incarnation private, no-store and cfw_page stops filling site-wide
$out['killSwitch'] = $ask(function () {
	$container = Drupal::getContainer();
	if ($container === null || !$container->initialized('page_cache_kill_switch')) {
		return null;
	}
	$switch = $container->get('page_cache_kill_switch');
	$property = new ReflectionProperty($switch, 'kill');
	return $property->getValue($switch) ? 1 : 0;
});

// the one that costs content: a key left behind by a render that threw makes every later build of
// that entity and view mode render EMPTY, and nothing anywhere reports it
$out['recursionKeys'] = $ask(function () {
	$property = new ReflectionProperty(EntityViewBuilder::class, 'recursionKeys');
	$value = $property->getValue();
	return is_array($value) ? count($value) : -1;
});

// the flag core resets in a catch and this SAPI can leave set, because an abort is not an
// exception: true here means every later renderRoot() answers 500
$out['renderingRoot'] = $ask(function () {
	$container = Drupal::getContainer();
	if ($container === null || !$container->initialized('renderer')) {
		return null;
	}
	$renderer = $container->get('renderer');
	$property = new ReflectionProperty($renderer, 'isRenderingRoot');
	return $property->getValue($renderer) ? 1 : 0;
});

// keyed by the Request OBJECT in a static SplObjectStorage, so every request ever served stays
// referenced; correct per request and unbounded across them
$out['renderContexts'] = $ask(function () {
	$property = new ReflectionProperty(Renderer::class, 'contextCollection');
	$value = $property->getValue();
	return $value instanceof SplObjectStorage ? $value->count() : -1;
});

$out['requestStack'] = $ask(function () {
	$container = Drupal::getContainer();
	if ($container === null || !$container->initialized('request_stack')) {
		return null;
	}
	$stack = $container->get('request_stack');
	$property = new ReflectionProperty($stack, 'requests');
	$value = $property->getValue($stack);
	return is_array($value) ? count($value) : -1;
});

// the flash bag lives on a session service that outlives the request, so a message queued for one
// visitor and never rendered is rendered to the next
$out['messages'] = $ask(function () {
	$container = Drupal::getContainer();
	if ($container === null || !$container->initialized('messenger')) {
		return null;
	}
	$counts = [];
	foreach ($container->get('messenger')->all() as $type => $list) {
		$counts[$type] = count($list);
	}
	return $counts;
});

// LocaleLookup::getCid() folds the CURRENT USER'S ROLE IDS into the key and memoises it, so the
// first request to translate anything decides the key every later one reads; null unless locale is on
$out['localeCids'] = $ask(function () {
	$container = Drupal::getContainer();
	$id = 'string_translator.locale.lookup';
	if ($container === null || !$container->has($id) || !$container->initialized($id)) {
		return null;
	}
	$service = $container->get($id);
	$held = new ReflectionProperty($service, 'translations');
	$memo = new ReflectionProperty(CacheCollector::class, 'cid');
	$cids = [];
	foreach ((array) $held->getValue($service) as $langcode => $contexts) {
		foreach ((array) $contexts as $context => $lookup) {
			$cids[$langcode . '|' . $context] = is_object($lookup)
				? $memo->getValue($lookup)
				: null;
		}
	}
	return $cids;
});

$out['db'] = $ask(function () {
	$connection = Database::getConnection();
	return [
		'buffering' => method_exists($connection, 'isBuffering')
			? (int) $connection->isBuffering()
			: -1,
		'inTransaction' => (int) $connection->inTransaction(),
		'hostTransactions' => method_exists($connection, 'transactionCount')
			? $connection->transactionCount()
			: -1,
	];
});

// which of the seeded ids the resetter can actually reset; method_exists() is the gate it applies,
// so an id with no reset() is skipped in silence
$out['resetAudit'] = $ask(function () {
	$container = Drupal::getContainer();
	if ($container === null || !$container->has('drupflare.request_resetter')) {
		return null;
	}
	$resetter = $container->get('drupflare.request_resetter');
	$property = new ReflectionProperty($resetter, 'resettable');
	$audit = [];
	foreach ((array) $property->getValue($resetter) as $id) {
		if (!$container->has($id)) {
			$audit[$id] = 'absent';
			continue;
		}
		if (!$container->initialized($id)) {
			$audit[$id] = 'uninitialized';
			continue;
		}
		$service = $container->get($id);
		$audit[$id] =
			is_object($service) && method_exists($service, 'reset') ? 'reset' : 'no-reset';
	}
	return $audit;
});
// #endregion

// #region the blind half
$fingerprint = function ($value, $depth = 0) use (&$fingerprint) {
	if ($depth > 2) {
		return 'deep';
	}
	if ($value === null) {
		return 'null';
	}
	if (is_bool($value)) {
		return $value ? 'true' : 'false';
	}
	if (is_int($value) || is_float($value)) {
		return 'n' . $value;
	}
	if (is_string($value)) {
		return 's' . strlen($value) . ':' . substr(md5($value), 0, 6);
	}
	if (is_array($value)) {
		$parts = [];
		foreach ($value as $key => $item) {
			$parts[] = $key . '=' . $fingerprint($item, $depth + 1);
		}
		return 'a' . count($value) . ':' . substr(md5(implode('|', $parts)), 0, 6);
	}
	if ($value instanceof Closure) {
		return 'fn';
	}
	if ($value instanceof Countable) {
		return 'C' . get_class($value) . ':' . count($value);
	}
	if (is_object($value)) {
		return 'o:' . get_class($value);
	}
	return 'x';
};

$statics = [];
$skipped = 0;
foreach (get_declared_classes() as $class) {
	try {
		$reflection = new ReflectionClass($class);
		foreach ($reflection->getProperties(ReflectionProperty::IS_STATIC) as $property) {
			if ($property->getDeclaringClass()->getName() !== $class) {
				continue;
			}
			try {
				$name = $class . '::' . $property->getName();
				$statics[$name] = $property->isInitialized()
					? $fingerprint($property->getValue())
					: 'uninit';
			} catch (Throwable $e) {
				$skipped++;
			}
		}
	} catch (Throwable $e) {
		$skipped++;
	}
}
ksort($statics);
$out['statics'] = $statics;
$out['staticCount'] = count($statics);
$out['staticSkipped'] = $skipped;
$out['classCount'] = count(get_declared_classes());
// #endregion

// #region the blind half over SERVICES
//
// THE HALF ABOVE CANNOT SEE A CARRIER THAT IS INSTANCE STATE ON A PERSISTENT SERVICE, and three of
// the nine named carriers are exactly that: the page-cache kill switch, the renderer's
// isRenderingRoot and the locale lookup's memoised cid. Each was found by hand and then added to
// the named list; the blind half walked static properties of declared classes and reported nothing
// for all three, so the next one would have been found by a browser again.
//
// THE initialized() GATE IS THE WHOLE SAFETY PROPERTY. Asking the container for a service it never
// built would CONSTRUCT the state this is looking for, which is the same mistake as a probe that
// warms what it reads. Every id is filtered through it, so what is walked is exactly the set the
// request itself instantiated; a service nobody touched contributes nothing rather than being made.
$services = [];
$serviceSkipped = 0;
$container = Drupal::hasContainer() ? Drupal::getContainer() : null;
if ($container !== null && method_exists($container, 'getServiceIds')) {
	foreach ((array) $container->getServiceIds() as $id) {
		try {
			if (!$container->initialized($id)) {
				continue;
			}
			$service = $container->get($id);
			if (!is_object($service)) {
				continue;
			}
			$reflection = new ReflectionObject($service);
			foreach ($reflection->getProperties() as $property) {
				if ($property->isStatic()) {
					continue;
				}
				try {
					$name = $id . '::' . $property->getName();
					$services[$name] = $property->isInitialized($service)
						? $fingerprint($property->getValue($service))
						: 'uninit';
				} catch (Throwable $e) {
					$serviceSkipped++;
				}
			}
		} catch (Throwable $e) {
			$serviceSkipped++;
		}
	}
}
ksort($services);
$out['services'] = $services;
$out['serviceCount'] = count($services);
$out['serviceSkipped'] = $serviceSkipped;
$out['servicesInitialized'] =
	$container !== null && method_exists($container, 'getServiceIds')
		? count(
			array_filter((array) $container->getServiceIds(), function ($id) use ($container) {
				try {
					return $container->initialized($id);
				} catch (Throwable $e) {
					return false;
				}
			}),
		)
		: -1;
// #endregion

echo json_encode($out);
