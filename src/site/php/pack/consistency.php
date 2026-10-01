<?php

use Symfony\Component\HttpFoundation\Request;

$fixed = [];
// loadLegacyIncludes() runs from preHandle(), not boot(), so a kernel booted to run this and
// nothing else has no module_config_sort() -- which is what ModuleInstaller::install() calls.
// Measured on a deployed free site: every firstrun reported
// 'module-failed:Call to undefined function module_config_sort()' and the driver module was
// never installed, so system_requirements() told the owner to install it by hand
try {
	$kernel = $GLOBALS['__pw_kernel'] ?? null;
	if ($kernel !== null && method_exists($kernel, 'loadLegacyIncludes')) {
		$kernel->loadLegacyIncludes();
	}
	// and the router rebuild inside install() builds a RequestContext from the current request,
	// so one has to be on the stack; the same trio the enable path already sets up
	$stack = Drupal::service('request_stack');
	if ($stack->getCurrentRequest() === null) {
		$stack->push(Request::create('/', 'GET'));
	}
	// hook_modules_installed reaches update_storage_clear(), a plain function in update.module,
	// and a bare boot has loaded no .module file at all
	Drupal::moduleHandler()->loadAll();
} catch (Throwable $e) {
	$fixed[] = 'includes-failed:' . substr($e->getMessage(), 0, 120);
}
// ONE install() for both modules: each call rebuilds the container and the router, and on a
// migrated 160-module site two rebuilds took the claim to 25 s of CPU against a 30 s limit
$want = [];
try {
	$driverModule = Drupal::database()->getProvider();
	if (
		$driverModule &&
		$driverModule !== 'core' &&
		!Drupal::moduleHandler()->moduleExists($driverModule)
	) {
		$want[$driverModule] = 'module';
	}
} catch (Throwable $e) {
	$fixed[] = 'module-failed:' . substr($e->getMessage(), 0, 120);
}
// a migrated database never had the platform module; without it core's requirements for a php.ini
// this runtime does not have stay errors, and every database update run halts on them
try {
	// the config row, as the installer itself reads it; a container can list a module config dropped
	$enabled = Drupal::config('core.extension')->get('module') ?: [];
	if (
		!isset($enabled['drupflare']) &&
		isset(Drupal::service('extension.list.module')->getList()['drupflare'])
	) {
		$want['drupflare'] = 'drupflare';
	}
} catch (Throwable $e) {
	$fixed[] = 'drupflare-failed:' . substr($e->getMessage(), 0, 120);
}
if ($want) {
	try {
		Drupal::service('module_installer')->install(array_keys($want));
		$out['packConsistencyInstalls'] = ($out['packConsistencyInstalls'] ?? 0) + 1;
		foreach (array_keys($want) as $module) {
			$fixed[] = 'module:' . $module;
		}
	} catch (Throwable $e) {
		foreach ($want as $kind) {
			$fixed[] = $kind . '-failed:' . substr($e->getMessage(), 0, 120);
		}
	}
}

try {
	$udm = Drupal::service('entity.definition_update_manager');
	$changes = $udm->getChangeList();
	foreach ($changes as $entityTypeId => $change) {
		foreach ($change['field_storage_definitions'] ?? [] as $fieldName => $op) {
			// 1 is CREATE; an UPDATE or DELETE is a schema change this must not perform silently
			if ((int) $op !== 1) {
				continue;
			}
			$definition =
				Drupal::service('entity_field.manager')->getFieldStorageDefinitions($entityTypeId)[
					$fieldName
				] ?? null;
			if ($definition === null) {
				continue;
			}
			$udm->installFieldStorageDefinition(
				$fieldName,
				$entityTypeId,
				$definition->getProvider(),
				$definition,
			);
			$fixed[] = 'field:' . $entityTypeId . '.' . $fieldName;
		}
	}
} catch (Throwable $e) {
	$fixed[] = 'field-failed:' . substr($e->getMessage(), 0, 120);
}
// THE TOOLKIT SHIPS AND WAS NEVER SELECTED. system.image says gd, which is not in this build, so
// Drupal reports "No image toolkit is configured" while cfw_images sits in the packed module
// unused. It is a real toolkit rather than a stub -- getimagesize() is ext-standard and needs no
// gd, so dimensions stay correct and resizing defers to delivery.
//
// WITH NO TOOLKIT AT ALL, /user/register AND /user/*/edit ARE A WSOD. ImageFactory resolves the
// id from the AVAILABLE toolkits, so with none it holds NULL and getSupportedExtensions() raises
// PluginNotFoundException on the empty id -- which the user picture field hits on every account
// form. Found by opening the sign-up page in a browser.
try {
	$manager = Drupal::service('image.toolkit.manager');
	// the definitions are cached from before this module was enabled, so a read without this sees
	// only gd and the branch below silently declines to fix anything
	$manager->clearCachedDefinitions();
	$defined = array_keys($manager->getDefinitions());
	$available = array_keys($manager->getAvailableToolkits());
	$imageConfig = Drupal::configFactory()->getEditable('system.image');
	$selected = $imageConfig->get('toolkit');
	if (in_array($selected, $available, true)) {
		// already usable, nothing to do
	} elseif (in_array('cfw_images', $available, true)) {
		$imageConfig->set('toolkit', 'cfw_images')->save();
		$fixed[] = 'toolkit:cfw_images';
	} else {
		// NOT silent: with no available toolkit every account form raises, so a repair that cannot
		// run has to say so rather than report an empty list
		$fixed[] =
			'toolkit-unavailable:defined=' .
			implode(',', $defined) .
			';available=' .
			implode(',', $available);
	}
} catch (Throwable $e) {
	$fixed[] = 'toolkit-failed:' . substr($e->getMessage(), 0, 120);
}
$out['packConsistency'] = $fixed;
