<?php

use Drupal\Core\Extension\Requirement\RequirementSeverity;

// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ok' => false, 'updates' => [], 'postUpdates' => []];

try {
	// __CFW_UPDB_PREAMBLE__

	$reg = Drupal::service('update.update_hook_registry');
	$postReg = Drupal::service('update.post_update_registry');

	$out['drupalVersion'] = Drupal::VERSION;
	$out['minimumSchemaVersion'] = Drupal::CORE_MINIMUM_SCHEMA_VERSION;

	// The digest: names only, sorted, so it is stable across two boots of the same
	// tree and changes the moment an update is added or removed.
	$defined = get_defined_functions()['user'];
	$updateFns = [];
	foreach ($defined as $f) {
		if (preg_match('/_update_\d+$/', $f) || strpos($f, '_post_update_') !== false) {
			$updateFns[] = $f;
		}
	}
	sort($updateFns);
	$out['codeId'] = sha1(Drupal::VERSION . '|' . implode(',', $updateFns));
	$out['codeFunctionCount'] = count($updateFns);

	if (__CFW_CHECK_REQUIREMENTS__) {
		try {
			$reqs = update_check_requirements();
			$worst = RequirementSeverity::maxSeverityFromRequirements($reqs);
			$out['severity'] = $worst->value;
			$out['severityName'] = $worst->name;
			$errors = [];
			$warnings = [];
			foreach ($reqs as $key => $r) {
				$s = $r['severity'] ?? null;
				if (!($s instanceof RequirementSeverity)) {
					continue;
				}
				$text = strip_tags((string) ($r['description'] ?? ($r['value'] ?? '')));
				if ($s === RequirementSeverity::Error) {
					$errors[$key] = substr($text, 0, 300);
				} elseif ($s === RequirementSeverity::Warning) {
					$warnings[$key] = substr($text, 0, 300);
				}
			}
			$out['requirementErrors'] = $errors;
			$out['requirementWarnings'] = $warnings;
		} catch (Throwable $e) {
			// Reported, never swallowed: a plan built without a requirements check is a
			// different plan and the caller has to be able to refuse it.
			$out['requirementsError'] = get_class($e) . ': ' . $e->getMessage();
		}
	} else {
		$out['requirementsSkipped'] = true;
	}

	$list = update_get_update_list();
	$start = [];
	$listWarnings = [];
	foreach ($list as $module => $info) {
		if (isset($info['warning'])) {
			$listWarnings[$module] = strip_tags((string) $info['warning']);
		}
		if (isset($info['start'])) {
			$start[$module] = $info['start'];
		}
	}
	$out['warnings'] = $listWarnings;
	$out['startingUpdates'] = $start;

	$resolved = update_resolve_dependencies($start);

	$depMap = [];
	foreach ($resolved as $fn => $data) {
		$depMap[$fn] = !empty($data['reverse_paths']) ? array_keys($data['reverse_paths']) : [];
	}

	// seedSchema reproduces DbUpdateController line 636 exactly: the first update of
	// each module forces the installed version to number-1 so the run starts where
	// the plan says, whatever the recorded version happens to be. Later updates of
	// the same module instead carry expectSchema, the previous update's number, which
	// is the value setInstalledVersion() left behind -- and which the JS precondition
	// gate refuses to proceed without.
	$pendingSeed = $start;
	$lastNumber = [];
	$disallowed = [];
	foreach ($resolved as $fn => $data) {
		$module = $data['module'];
		$number = (int) $data['number'];
		if (empty($data['allowed'])) {
			$disallowed[$fn] = array_values($data['missing_dependencies'] ?? []);
			continue;
		}
		$unit = [
			'kind' => 'update',
			'fn' => $fn,
			'module' => $module,
			'number' => $number,
			'depMap' => $depMap[$fn] ?? [],
			'seedSchema' => null,
			'expectSchema' => null,
		];
		if (isset($pendingSeed[$module])) {
			$unit['seedSchema'] = $number - 1;
			unset($pendingSeed[$module]);
		} else {
			$unit['expectSchema'] = $lastNumber[$module] ?? null;
		}
		$lastNumber[$module] = $number;
		$out['updates'][] = $unit;
	}
	$out['disallowed'] = $disallowed;

	$post = [];
	try {
		foreach ($postReg->getPendingUpdateFunctions() as $fn) {
			$post[] = $fn;
		}
	} catch (Throwable $e) {
		// RemovedPostUpdateNameException is thrown when a module declares an update
		// removed in hook_removed_post_updates() while the function still exists. That
		// is a broken code tree, not a transient error, and it must stop the plan.
		$out['postUpdateError'] = get_class($e) . ': ' . $e->getMessage();
	}
	$out['postUpdates'] = $post;

	$out['installedVersions'] = $reg->getAllInstalledVersions();
	$out['counts'] = ['updates' => count($out['updates']), 'postUpdates' => count($post)];
	$out['ok'] = !isset($out['postUpdateError']);
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['trace'] = substr($e->getTraceAsString(), 0, 900);
}

echo json_encode($out);
