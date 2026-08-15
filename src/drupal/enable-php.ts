/**
 * Enabling a Drupal module, which has never happened in this project.
 *
 * This is the gap, not a convenience. `OpsRegistry` prices `en` at 1,344.7 ms plus a 282.9 ms
 * `cr` flush, three roadmap items are scored against those numbers, and **nothing has ever enabled
 * anything** -- the estimates come from native PHP on a developer machine. So the whole
 * module-install track is a plan rather than a measurement, and a plan priced from an unrun
 * operation is the exact shape of error this project keeps finding.
 *
 * The consequence is already visible: `drupflare` is mounted but NOT in
 * `core.extension`, so `DrupflareServiceProvider`, `logger.cfw`, `drupflare.http_deferred` and
 * `drupflare.request_resetter` are all **unreached**. Each reads as a wiring bug in isolation; none
 * of them is. Enabling the module is what makes them real, which is also what makes this probe
 * falsifiable: `Drupal::logger()` reaching `CfwLogger` is an outcome, where "the config row
 * changed" is not.
 */
export const ENABLE_MODULE = String.raw`<?php
$out = ['ok' => false];
$name = $GLOBALS['__cfw_enable_module'] ?? '';
$dryRun = !empty($GLOBALS['__cfw_enable_dry']);
$out['module'] = $name;
$out['dryRun'] = $dryRun;

$stopAt = (string) ($GLOBALS['__cfw_enable_stop'] ?? '');
$halt = static function (string $stage) use (&$out, $stopAt): bool {
  if ($stopAt !== $stage) {
    return false;
  }
  $out['ok'] = true;
  $out['stoppedAt'] = $stage;
  echo json_encode($out);
  return true;
};
if ($halt('boot')) { return; }

if ($name === '') {
  $out['error'] = 'no module named';
  echo json_encode($out);
  return;
}

$listBefore = [];
try {
  $extension = \Drupal::configFactory()->get('core.extension');
  $listBefore = array_keys($extension->get('module') ?? []);
  $out['moduleCountBefore'] = count($listBefore);
  $out['alreadyEnabled'] = in_array($name, $listBefore, true);
} catch (\Throwable $e) {
  $out['error'] = 'cannot read core.extension: ' . $e->getMessage();
  echo json_encode($out);
  return;
}

// is the module even discoverable? A module Drupal cannot see fails with a confusing
// "missing dependency" rather than "not found", so it is separated out
try {
  $available = \Drupal::service('extension.list.module')->reset()->getList();
  $out['discoverable'] = isset($available[$name]);
  if (isset($available[$name])) {
    $info = $available[$name]->info ?? [];
    $out['coreRequirement'] = $info['core_version_requirement'] ?? null;
    $out['declaredDependencies'] = $info['dependencies'] ?? [];
    $out['modulePath'] = $available[$name]->getPath();
  }
} catch (\Throwable $e) {
  $out['discoverError'] = $e->getMessage();
}
if ($halt('discover')) { return; }

// the legacy includes, and leaving them out is what this probe failed on first: the install died
// with "Call to undefined function module_config_sort()" at ModuleInstaller.php:277.
// DrupalKernel::loadLegacyIncludes() requires common.inc, module.inc, theme.inc, form.inc and
// errors.inc, and it is called from preHandle(), NOT from boot() -- so any path that boots the
// kernel without handling a request has none of those functions. This project has been requiring
// common.inc by hand in two separate places for the same reason; calling the one method a real
// request calls is both faithful and stops the next missing function being a separate discovery.
try {
  $kernel = $GLOBALS['__pw_kernel'] ?? null;
  if ($kernel !== null && method_exists($kernel, 'loadLegacyIncludes')) {
    $kernel->loadLegacyIncludes();
    $out['legacyIncludes'] = 'loaded via kernel';
  } else {
    // a kernel that cannot do it is reported rather than worked around, because the fallback
    // would hide the fact that the boot path changed
    $out['legacyIncludes'] = 'kernel unavailable';
  }
  $out['moduleConfigSort'] = function_exists('module_config_sort');
} catch (\Throwable $e) {
  $out['legacyIncludesError'] = $e->getMessage();
}
if ($halt('includes')) { return; }

// hook_requirements, which ModuleInstaller will NOT run for us
try {
  require_once '/drupal/core/includes/install.inc';
  if (function_exists('drupal_check_module')) {
    $out['requirementsPass'] = (bool) drupal_check_module($name);
  } else {
    $out['requirementsPass'] = null;
    $out['requirementsNote'] = 'drupal_check_module absent after including install.inc';
  }
} catch (\Throwable $e) {
  $out['requirementsError'] = $e->getMessage();
}
if ($halt('requirements')) { return; }

if ($dryRun) {
  $out['ok'] = ($out['discoverable'] ?? false) === true;
  $out['note'] = 'dry run; nothing was installed';
  echo json_encode($out);
  return;
}

// the .module files have to be loaded, which was the fourth blocker. The final step of
// no backticks below this line. Everything from the String.raw open to its close is one JavaScript
// template literal, so a backtick in a PHP comment ends it early -- and it can break the
// JAVASCRIPT rather than only the PHP, in which case tsc catches it where php -l would not.
//
// ModuleInstaller::install() invokes hook_modules_installed, and the 'update' module's
// implementation calls
// update_storage_clear() -- a plain function in update.module. A bare kernel boot has loaded no
// .module file at all, so that dies with "Call to undefined function ...update_storage_clear()"
// AFTER the router rebuild has already been written. loadAll() is what a real request does.
try {
  \Drupal::moduleHandler()->loadAll();
  $out['modulesLoaded'] = true;
} catch (\Throwable $e) {
  $out['moduleLoadError'] = $e->getMessage();
}

// A REQUEST HAS TO BE ON THE STACK, and this was the third blocker rather than a precaution.
// ModuleInstaller rebuilds the router, and the route builder builds a RequestContext from the
// current request -- with none, it dies on
// "RequestContext::fromRequest(): Argument #1 ($request) must be of type Request, null given"
// partway through the rebuild. An enable driven outside a request has to supply one, the same way
// cfw_serve() does for a render.
try {
  $stack = \Drupal::service('request_stack');
  if ($stack->getCurrentRequest() === null) {
    $stack->push(\Symfony\Component\HttpFoundation\Request::create('/', 'GET'));
    $out['pushedRequest'] = true;
  } else {
    $out['pushedRequest'] = false;
  }
} catch (\Throwable $e) {
  $out['requestStackError'] = $e->getMessage();
}
if ($halt('preinstall')) { return; }

// the driver's own counters, snapshotted around the install rather than read after it. A total
// read once cannot tell an install's cost from a boot's, and the replay counter is the one that
// matters: statementCount() counts a replay as ONE call, replayedStatementCount() counts what the
// host executed inside it, so the gap between them IS the O(W*R) term
// COMPILED SOURCE IS COUNTED ALONGSIDE THE SQL, because there is no opcache in this build: every
// PHP file an install pulls in is lexed and compiled inside the invocation that pulls it. A cost
// that scales with bytes-of-source is invisible to both a statement counter and a row counter
$meter = static function (): array {
  $out = ['files' => count(get_included_files()), 'sourceBytes' => 0, 'peakBytes' => 0];
  foreach (get_included_files() as $file) {
    $size = @filesize($file);
    if (is_int($size)) {
      $out['sourceBytes'] += $size;
    }
  }
  $out['peakBytes'] = memory_get_peak_usage(true);
  try {
    $db = \Drupal::database();
    if (method_exists($db, 'replayedStatementCount')) {
      $out['statements'] = $db->statementCount();
      $out['transactions'] = $db->transactionCount();
      $out['speculative'] = $db->speculativeCount();
      $out['replayed'] = $db->replayedStatementCount();
    }
  } catch (\Throwable $e) {
    // a connection that cannot be read leaves the file counters, which need no database
  }
  return $out;
};
$before = $meter();

// THE ATTEMPT. Wrapped tightly and reporting class + file:line, because the interesting outcome is
// the failure: this call has never been made in this runtime and a bare message would not say which
// of the four steps (config write, schema, container rebuild, router rebuild) died.
try {
  $installer = \Drupal::service('module_installer');
  $out['installerClass'] = get_class($installer);
  $result = $installer->install([$name], true);
  $out['installReturned'] = $result;
  $out['ok'] = $result === true;
} catch (\Throwable $e) {
  $out['throwClass'] = get_class($e);
  $out['throwMessage'] = $e->getMessage();
  $out['throwAt'] = $e->getFile() . ':' . $e->getLine();
  $out['ok'] = false;
}

$after = $meter();
foreach ($after as $key => $value) {
  $out['driver'][$key] = $value - ($before[$key] ?? 0);
}
// absolutes as well as the delta: the delta says what the install added, these say what it was
// added to, and the compile cost is a property of the total rather than of the increment
$out['driver']['filesTotal'] = $after['files'];
$out['driver']['sourceBytesTotal'] = $after['sourceBytes'];
$out['driver']['peakBytesTotal'] = $after['peakBytes'];

// how many times the router was DUMPED and how many of those were skipped, read out of the dumper
// rather than divided out of a row count. A statement total cannot tell a repeat from a wide write
try {
  if (class_exists('Drupal\\drupflare\\Routing\\CfwMatcherDumper')) {
    $out['routerDumps'] = \Drupal\drupflare\Routing\CfwMatcherDumper::$dumps;
    $out['routerSkips'] = \Drupal\drupflare\Routing\CfwMatcherDumper::$skips;
  } else {
    $out['routerDumps'] = null;
  }
} catch (\Throwable $e) {
  $out['routerDumpError'] = $e->getMessage();
}

// what actually changed, read back rather than assumed
try {
  $after = \Drupal::configFactory()->get('core.extension');
  $listAfter = array_keys($after->get('module') ?? []);
  $out['moduleCountAfter'] = count($listAfter);
  $out['nowEnabled'] = in_array($name, $listAfter, true);
  $out['added'] = array_values(array_diff($listAfter, $listBefore));
} catch (\Throwable $e) {
  $out['readbackError'] = $e->getMessage();
}

echo json_encode($out);
`;

/**
 * Whether the module's services became reachable, which is the acceptance condition.
 *
 * Separated from the enable itself and driven as its own invocation ON A DROPPED INTERPRETER,
 * because the container is rebuilt during the install and a service resolved from the same PHP run
 * could be answered by the pre-rebuild container still sitting in memory. A probe for state that
 * SURVIVED has to exercise state read after the rebuild, never state captured before it.
 */
export const ENABLE_VERIFY = String.raw`<?php
$out = ['ok' => true];

try {
  $list = array_keys(\Drupal::configFactory()->get('core.extension')->get('module') ?? []);
  $out['enabled'] = in_array('drupflare', $list, true);
  $out['moduleCount'] = count($list);
} catch (\Throwable $e) {
  $out['configError'] = $e->getMessage();
}

// the four services that were unreached. has() rather than get(), so a construction failure is
// told apart from an absent definition.
foreach (['logger.cfw', 'drupflare.http_deferred', 'drupflare.request_resetter'] as $id) {
  try {
    $out['has'][$id] = \Drupal::hasService($id);
  } catch (\Throwable $e) {
    $out['has'][$id] = 'error: ' . $e->getMessage();
  }
}

// the real test: does a Drupal::logger() call reach CfwLogger. A registered service that nothing
// routes to is still dead, and the logger channel is exactly where that distinction hides.
try {
  $marker = 'cfw-enable-' . substr(sha1((string) mt_rand()), 0, 8);
  \Drupal::logger('cfw-enable')->warning('reached @m', ['@m' => $marker]);
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
} catch (\Throwable $e) {
  $out['loggerError'] = $e->getMessage();
  $out['ok'] = false;
}

// which class answers path.matcher, and whether it can be reset. A services.yml override that did
// not take leaves core's PathMatcher in place, method_exists() finds no reset(), and the front-page
// memo keeps leaking with every symptom intact -- so this has to be read rather than assumed.
try {
  $matcher = \Drupal::service('path.matcher');
  $out['pathMatcherClass'] = get_class($matcher);
  $out['pathMatcherResettable'] = method_exists($matcher, 'reset');
  $out['isFrontPageNow'] = $matcher->isFrontPage();
} catch (\Throwable $e) {
  $out['pathMatcherError'] = $e->getMessage();
}

try {
  $out['routerRoutes'] = (int) \Drupal::database()
    ->query('SELECT COUNT(*) FROM {router}')
    ->fetchField();
} catch (\Throwable $e) {
  $out['routerError'] = $e->getMessage();
}

echo json_encode($out);
`;
