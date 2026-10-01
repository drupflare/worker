<?php

use Drupal\cfw_do_sqlite\Driver\Database\cfw_do_sqlite\Connection;
use Drupal\Core\Extension\ExtensionDiscovery;
use Drupal\drupflare\Routing\CfwMatcherDumper;
use Symfony\Component\HttpFoundation\Request;

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
if ($halt('boot')) {
	return;
}

if ($name === '') {
	$out['error'] = 'no module named';
	echo json_encode($out);
	return;
}

// THE FILE SCAN IS A STATIC AND THIS SAPI NEVER TEARS ONE DOWN, so it is cleared first: the theme
// check below reads it too, and a theme /install delivered after the first render was never found.
// No public reset exists in Drupal 11 and the property is protected, so reflection is the only way
// in. Guarded: a core that drops the property must not take the enable down with it
try {
	$prop = new ReflectionProperty(ExtensionDiscovery::class, 'files');
	$prop->setAccessible(true);
	$prop->setValue(null, []);
	$out['discoveryScanCleared'] = true;
} catch (Throwable $e) {
	$out['discoveryScanCleared'] = false;
}

// A THEME IS A DIFFERENT INSTALLER, and it was not reachable at all.
// composer/installers puts a drupal-theme under themes/contrib, extension.list.module does not
// list themes and module_installer cannot install one -- so a contrib theme had no route in and
// could not be verified however well it would have worked. Handled here and returned, so the
// module path below is untouched.
try {
	$themes = Drupal::service('extension.list.theme')->reset()->getList();
} catch (Throwable $e) {
	$themes = [];
}
if (isset($themes[$name])) {
	$out['kind'] = 'theme';
	$out['modulePath'] = $themes[$name]->getPath();
	$enabledThemes = array_keys(Drupal::config('core.extension')->get('theme') ?? []);
	$out['alreadyEnabled'] = in_array($name, $enabledThemes, true);
	if ($dryRun) {
		$out['ok'] = true;
		echo json_encode($out);
		return;
	}
	try {
		// the same three the module path needs: install() rebuilds the router, which builds a request
		// context from the current request and reaches functions only a real request has loaded
		$kernel = $GLOBALS['__pw_kernel'] ?? null;
		if ($kernel !== null && method_exists($kernel, 'loadLegacyIncludes')) {
			$kernel->loadLegacyIncludes();
		}
		$stack = Drupal::service('request_stack');
		if ($stack->getCurrentRequest() === null) {
			$stack->push(Request::create('/', 'GET'));
		}
		Drupal::moduleHandler()->loadAll();
		$result = Drupal::service('theme_installer')->install([$name], true);
		$out['installReturned'] = $result;
		$nowThemes = array_keys(
			Drupal::configFactory()->getEditable('core.extension')->get('theme') ?? [],
		);
		$out['nowEnabled'] = in_array($name, $nowThemes, true);
		$out['ok'] = $out['nowEnabled'];
	} catch (Throwable $e) {
		$out['throwClass'] = get_class($e);
		$out['throwMessage'] = $e->getMessage();
		$out['throwAt'] = $e->getFile() . ':' . $e->getLine();
		$out['ok'] = false;
	}
	echo json_encode($out);
	return;
}

$listBefore = [];
try {
	$extension = Drupal::configFactory()->get('core.extension');
	$listBefore = array_keys($extension->get('module') ?? []);
	$out['moduleCountBefore'] = count($listBefore);
	$out['alreadyEnabled'] = in_array($name, $listBefore, true);
} catch (Throwable $e) {
	$out['error'] = 'cannot read core.extension: ' . $e->getMessage();
	echo json_encode($out);
	return;
}

// is the module even discoverable? A module Drupal cannot see fails with a confusing
// "missing dependency" rather than "not found", so it is separated out
try {
	// THE FILE SCAN IS A STATIC AND THIS SAPI NEVER TEARS ONE DOWN. pib_run performs no
	// php_request_startup/shutdown, so ExtensionDiscovery keeps its scanned file list for the life of
	// the interpreter. A site that rendered anything before the install therefore holds a scan taken
	// without the new module, and extension.list.module's own reset() does not reach it. Measured:
	// /install wrote 27 files, the boot mounted them, and discoverable stayed false forever.
	// (the scan itself is cleared above, before the theme check reads it)
	// whether the module is on disk at all, which separates a mount failure from a stale scan. Without
	// it both read as "discoverable: false" and the two have completely different fixes
	$out['filesMounted'] = is_dir('/drupal/modules/contrib/' . $name);
	$available = Drupal::service('extension.list.module')->reset()->getList();
	$out['discoverable'] = isset($available[$name]);
	if (isset($available[$name])) {
		$info = $available[$name]->info ?? [];
		$out['coreRequirement'] = $info['core_version_requirement'] ?? null;
		$out['declaredDependencies'] = $info['dependencies'] ?? [];
		$out['modulePath'] = $available[$name]->getPath();
	}
} catch (Throwable $e) {
	$out['discoverError'] = $e->getMessage();
}
if ($halt('discover')) {
	return;
}

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
} catch (Throwable $e) {
	$out['legacyIncludesError'] = $e->getMessage();
}
if ($halt('includes')) {
	return;
}

// hook_requirements, which ModuleInstaller will NOT run for us
try {
	require_once '/drupal/core/includes/install.inc';
	if (function_exists('drupal_check_module')) {
		$out['requirementsPass'] = (bool) drupal_check_module($name);
	} else {
		$out['requirementsPass'] = null;
		$out['requirementsNote'] = 'drupal_check_module absent after including install.inc';
	}
} catch (Throwable $e) {
	$out['requirementsError'] = $e->getMessage();
}
if ($halt('requirements')) {
	return;
}

if ($dryRun) {
	$out['ok'] = ($out['discoverable'] ?? false) === true;
	$out['note'] = 'dry run; nothing was installed';
	echo json_encode($out);
	return;
}

// the .module files have to be loaded, which was the fourth blocker. The final step of
// ModuleInstaller::install() invokes hook_modules_installed, and the 'update' module's
// implementation calls
// update_storage_clear() -- a plain function in update.module. A bare kernel boot has loaded no
// .module file at all, so that dies with "Call to undefined function ...update_storage_clear()"
// AFTER the router rebuild has already been written. loadAll() is what a real request does.
try {
	Drupal::moduleHandler()->loadAll();
	$out['modulesLoaded'] = true;
} catch (Throwable $e) {
	$out['moduleLoadError'] = $e->getMessage();
}

// A REQUEST HAS TO BE ON THE STACK, and this was the third blocker rather than a precaution.
// ModuleInstaller rebuilds the router, and the route builder builds a RequestContext from the
// current request -- with none, it dies on
// "RequestContext::fromRequest(): Argument #1 ($request) must be of type Request, null given"
// partway through the rebuild. An enable driven outside a request has to supply one, the same way
// cfw_serve() does for a render.
try {
	$stack = Drupal::service('request_stack');
	if ($stack->getCurrentRequest() === null) {
		$stack->push(Request::create('/', 'GET'));
		$out['pushedRequest'] = true;
	} else {
		$out['pushedRequest'] = false;
	}
} catch (Throwable $e) {
	$out['requestStackError'] = $e->getMessage();
}
if ($halt('preinstall')) {
	return;
}

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
		$db = Drupal::database();
		if ($db instanceof Connection) {
			$out['statements'] = $db->statementCount();
			$out['transactions'] = $db->transactionCount();
			$out['speculative'] = $db->speculativeCount();
			$out['replayed'] = $db->replayedStatementCount();
		}
	} catch (Throwable $e) {
		// a connection that cannot be read leaves the file counters, which need no database
	}
	return $out;
};
$before = $meter();

// THE ATTEMPT. Wrapped tightly and reporting class + file:line, because the interesting outcome is
// the failure: this call has never been made in this runtime and a bare message would not say which
// of the four steps (config write, schema, container rebuild, router rebuild) died.
try {
	$installer = Drupal::service('module_installer');
	$out['installerClass'] = get_class($installer);
	$with = array_values(array_diff((array) ($GLOBALS['__cfw_enable_with'] ?? []), [$name]));
	$result = $installer->install(array_merge([$name], $with), true);
	$out['installReturned'] = $result;
	$out['ok'] = $result === true;
} catch (Throwable $e) {
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
	if (class_exists(CfwMatcherDumper::class)) {
		$out['routerDumps'] = CfwMatcherDumper::$dumps;
		$out['routerSkips'] = CfwMatcherDumper::$skips;
	} else {
		$out['routerDumps'] = null;
	}
} catch (Throwable $e) {
	$out['routerDumpError'] = $e->getMessage();
}

// what actually changed, read back rather than assumed
try {
	$after = Drupal::configFactory()->get('core.extension');
	$listAfter = array_keys($after->get('module') ?? []);
	$out['moduleCountAfter'] = count($listAfter);
	$out['nowEnabled'] = in_array($name, $listAfter, true);
	$out['added'] = array_values(array_diff($listAfter, $listBefore));
} catch (Throwable $e) {
	$out['readbackError'] = $e->getMessage();
}

echo json_encode($out);
