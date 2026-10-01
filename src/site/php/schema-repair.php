<?php

use Drupal\Core\Batch\BatchStorage;
use Drupal\Core\Flood\DatabaseBackend;
use Drupal\Core\KeyValueStore\DatabaseStorageExpirable;
use Drupal\Core\Lock\DatabaseLockBackend;
use Drupal\Core\Queue\DatabaseQueue;

$db = Drupal::database();
$moduleHandler = Drupal::moduleHandler();
$moduleHandler->loadAllIncludes('install');
$created = [];
$failed = [];
$walked = 0;
$defined = 0;
foreach (array_keys($moduleHandler->getModuleList()) as $module) {
	$walked++;
	$fn = $module . '_schema';
	if (!function_exists($fn)) {
		continue;
	}
	$defined++;
	$schema = $fn();
	if (!is_array($schema)) {
		continue;
	}
	foreach ($schema as $table => $spec) {
		try {
			if (!$db->schema()->tableExists($table)) {
				$db->schema()->createTable($table, $spec);
				$created[] = $table;
			}
		} catch (Throwable $e) {
			$failed[$table] = substr($e->getMessage(), 0, 140);
		}
	}
}
// The other half, and the reason the hook walk found nothing. Drupal's database
// backends for flood, queue, semaphore, batch and expirable key-value do NOT
// declare hook_schema. Each keeps its schema in a class method and creates the
// table ON DEMAND by catching a failed query -- which cannot work here, because
// the failure surfaces inside a transaction replay where the catch-and-create
// path is exactly what the replay refuses. So they are pre-created.
//
// Mapped explicitly rather than discovered, because there is nothing to discover
// from: a class method is not registered anywhere a hook system can see.
$classTables = [
	'flood' => DatabaseBackend::class,
	'queue' => DatabaseQueue::class,
	'semaphore' => DatabaseLockBackend::class,
	'batch' => BatchStorage::class,
	'key_value_expire' => DatabaseStorageExpirable::class,
];
foreach ($classTables as $table => $class) {
	try {
		if ($db->schema()->tableExists($table)) {
			continue;
		}
		if (!class_exists($class)) {
			$failed[$table] = 'class absent: ' . $class;
			continue;
		}
		$rm = new ReflectionMethod($class, 'schemaDefinition');
		$spec = $rm->isStatic()
			? $rm->invoke(null)
			: $rm->invoke($rm->getDeclaringClass()->newInstanceWithoutConstructor());
		// some return one table spec, some a map of them
		$specs = isset($spec['fields']) ? [$table => $spec] : $spec;
		foreach ($specs as $name => $definition) {
			if (
				is_array($definition) &&
				isset($definition['fields']) &&
				!$db->schema()->tableExists($name)
			) {
				$db->schema()->createTable($name, $definition);
				$created[] = $name;
			}
		}
	} catch (Throwable $e) {
		$failed[$table] = substr($e->getMessage(), 0, 140);
	}
}

$out['schemaRepair'] = [
	'modulesWalked' => $walked,
	'withSchemaHook' => $defined,
	'created' => $created,
];
if ($failed) {
	$out['schemaRepair']['failed'] = $failed;
}
