<?php

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Session\Session;
use Symfony\Component\HttpFoundation\Session\Storage\MockArraySessionStorage;

if (!isset($GLOBALS['__pw_autoloader']) || !is_object($GLOBALS['__pw_autoloader'])) {
	$GLOBALS['__pw_autoloader'] = require '/drupal/autoload.php';
}
$autoloader = $GLOBALS['__pw_autoloader'];

if (!isset($GLOBALS['__pw_kernel'])) {
	$request = Request::create('/', 'GET');
	$kernel = new DrupalKernel('prod', $autoloader);
	DrupalKernel::bootEnvironment();
	$sitePath = DrupalKernel::findSitePath($request);
	$kernel->setSitePath($sitePath);
	Settings::initialize('/drupal', $sitePath, $autoloader);
	$kernel->boot();
	$GLOBALS['__pw_kernel'] = $kernel;
}
// A MIGRATED SITE HAS PROCEDURAL HOOKS IN .module FILES, and saving the account dispatches them
// before anything has included one: farmOS answered Class "entity_entity_type_build" does not
// exist, DrupalX a RequestContext built from no request. The enable fragment does the same two
$stack = Drupal::service('request_stack');
if ($stack->getCurrentRequest() === null) {
	$claimRequest = Request::create('/', 'GET');
	// a hook asks the request for its session (varbase: SessionNotFoundException); in memory, so
	// the claim writes no session row
	$claimRequest->setSession(new Session(new MockArraySessionStorage()));
	$stack->push($claimRequest);
}
Drupal::moduleHandler()->loadAll();
// The first WRITE path anything in this project has exercised, and it found a
// new instance of the trace-blind class immediately: SAVED_NEW / SAVED_UPDATED
// are plain constants in core/includes/common.inc, which a render never needs
// and DrupalKernel::boot() does not include. EntityStorageBase::doSave()
// returns SAVED_UPDATED, so every entity save fatals with
// "Undefined constant Drupal\\Core\\Entity\\SAVED_UPDATED" until it is loaded.
// Read paths are not evidence about write paths. Before the first config write, because a
// config save subscriber can save an entity (open y's upgrade_tool logs every change).
if (!defined('SAVED_UPDATED')) {
	require_once '/drupal/core/includes/common.inc';
	$out['loadedCommonInc'] = true;
}
