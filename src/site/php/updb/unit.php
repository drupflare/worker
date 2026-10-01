<?php

use Drupal\Core\Cache\Cache;
use Drupal\Core\Cache\CacheTagsPurgeInterface;

// __CFW_FIBER_SHIM__
chdir('/drupal');

$u = json_decode(__CFW_PAYLOAD__, true);
$out = ['ok' => false, 'kind' => $u['kind'], 'seq' => $u['seq'], 'finished' => 0];

try {
	// __CFW_UPDB_PREAMBLE__

	// The sandbox is the only mid-hook state there is. Refuse a malformed one rather
	// than start a hook from scratch that already ran half of itself.
	$sandbox = [];
	if (is_string($u['sandbox']) && $u['sandbox'] !== '') {
		$raw = base64_decode($u['sandbox'], true);
		if ($raw === false) {
			throw new RuntimeException('stored sandbox is not valid base64');
		}
		$restored = @unserialize($raw);
		if (!is_array($restored)) {
			throw new RuntimeException('stored sandbox did not unserialize to an array');
		}
		$sandbox = $restored;
		$out['sandboxRestored'] = count($sandbox);
	}

	$results = [];
	if (!empty($u['abortList'])) {
		$results['#abort'] = array_values($u['abortList']);
	}
	// finished defaults to 1, exactly as _batch_process() seeds it (batch.inc:286);
	// without that update_do_one() never records the schema version.
	$context = ['sandbox' => $sandbox, 'results' => $results, 'finished' => 1, 'message' => ''];

	$kind = $u['kind'];

	if ($kind === 'maint_on' || $kind === 'maint_off') {
		// maint_off restores the PRE-RUN value rather than forcing FALSE, which is what
		// DbUpdateController::batchFinished() does via the session. Here the pre-run
		// value lives in the run row, so it survives an eviction that a session would
		// not.
		$want = $kind === 'maint_on' ? true : $u['maintTarget'] === true;
		Drupal::state()->set('system.maintenance_mode', $want);
		$out['maintenanceMode'] = Drupal::state()->get('system.maintenance_mode') ? 1 : 0;
		$out['wanted'] = $want ? 1 : 0;
		$out['finished'] = 1;
		$out['ok'] = $out['maintenanceMode'] === ($want ? 1 : 0);
		if (!$out['ok']) {
			$out['error'] =
				'maintenance_mode did not take: state read back as ' . $out['maintenanceMode'];
		}
	} elseif ($kind === 'update') {
		// indivisible unless the hook cooperates, which is core's design rather than a
		// limitation here. A batch-aware hook_update_N() takes $sandbox by reference and
		// sets $sandbox['#finished'] below 1 to ask to be re-entered, which is exactly the
		// seam this chain rides: one invocation per pass, sandbox persisted between them.
		// A hook that is NOT batch-aware runs to completion in one call and nothing can
		// interrupt it -- measured: a setTimeout(1) raced against a 119 ms synchronous
		// wasm call LOST, because the timer cannot fire until the call returns. So a
		// single non-batch-aware hook is the one place this design cannot guarantee a
		// 10 ms slice, and the run records what it actually cost instead of pretending.
		$module = (string) $u['module'];
		$number = (int) $u['number'];
		$fn = $module . '_update_' . $number;
		$reg = Drupal::service('update.update_hook_registry');
		$out['installedBefore'] = $reg->getInstalledVersion($module);

		if ($u['seedSchema'] !== null) {
			$reg->setInstalledVersion($module, (int) $u['seedSchema']);
			$out['seededTo'] = (int) $u['seedSchema'];
		}

		$equivalent = null;
		try {
			$equivalent = $reg->getEquivalentUpdate($module, $number);
		} catch (Throwable $e) {
		}

		if (!function_exists($fn) && $equivalent === null) {
			// The plan named a function this tree does not define. That is a stale plan,
			// not a failed update, so it must not be retried and must not advance.
			$out['refused'] = 'missing-function';
			$out['error'] =
				$fn .
				' is not defined and has no equivalent-update record; the plan was built against a different code tree';
		} else {
			$escaped = null;
			try {
				update_do_one($module, (string) $number, array_values($u['depMap']), $context);
			} catch (Throwable $e) {
				// update.inc:191 catches Exception, not Throwable, so an Error inside the
				// hook lands here with the schema version unmoved and whatever the hook
				// already wrote still written.
				$escaped = get_class($e) . ': ' . $e->getMessage();
			}
			$out['finished'] =
				isset($context['finished']) && is_numeric($context['finished'])
					? (float) $context['finished']
					: 1.0;
			$out['abort'] = array_values($context['results']['#abort'] ?? []);
			$ret = $context['results'][$module][$number] ?? [];
			if (isset($ret['results']['query'])) {
				$out['message'] = substr((string) $ret['results']['query'], 0, 400);
			}
			if (!empty($ret['#abort']['query'])) {
				$out['abortMessage'] = substr((string) $ret['#abort']['query'], 0, 400);
			}
			$out['success'] = !empty($ret['results']['success']);
			$out['installedAfter'] = $reg->getInstalledVersion($module);
			if ($escaped !== null) {
				$out['escaped'] = $escaped;
				$out['finished'] = 0;
				if (!in_array($fn, $out['abort'], true)) {
					$out['abort'][] = $fn;
				}
			}
			$serialized = null;
			try {
				$serialized = serialize($context['sandbox'] ?? []);
			} catch (Throwable $e) {
				$out['sandboxError'] = get_class($e) . ': ' . $e->getMessage();
			}
			if ($serialized !== null) {
				$out['sandbox'] = base64_encode($serialized);
			}
			$out['ok'] = empty($out['abort']) && $escaped === null && !isset($out['sandboxError']);
		}
	} elseif ($kind === 'post_update') {
		$fn = (string) $u['fn'];
		if (strpos($fn, '_post_update_') === false) {
			$out['refused'] = 'not-a-post-update';
			$out['error'] = $fn . ' does not contain _post_update_';
		} else {
			$parts = explode('_post_update_', $fn, 2);
			$extension = $parts[0];
			$postReg = Drupal::service('update.post_update_registry');
			// Loads <extension>.post_update.php. update_invoke_post_update() does this
			// itself, but it then silently does nothing when the function is absent --
			// leaving the unit "finished" without having run or registered anything. So
			// the file is loaded here and function_exists() is checked first.
			try {
				$postReg->getUpdateFunctions($extension);
			} catch (Throwable $e) {
				$out['loadError'] = get_class($e) . ': ' . $e->getMessage();
			}
			if (!function_exists($fn)) {
				$out['refused'] = 'missing-function';
				$out['error'] =
					$fn .
					' is not defined after loading ' .
					$extension .
					'.post_update.php; the plan was built against a different code tree';
			} else {
				$escaped = null;
				try {
					update_invoke_post_update($fn, $context);
				} catch (Throwable $e) {
					$escaped = get_class($e) . ': ' . $e->getMessage();
				}
				$out['finished'] =
					isset($context['finished']) && is_numeric($context['finished'])
						? (float) $context['finished']
						: 1.0;
				$out['abort'] = array_values($context['results']['#abort'] ?? []);
				$name = $parts[1];
				$ret = $context['results'][$extension][$name] ?? [];
				if (isset($ret['results']['query'])) {
					$out['message'] = substr((string) $ret['results']['query'], 0, 400);
				}
				if (!empty($ret['#abort']['query'])) {
					$out['abortMessage'] = substr((string) $ret['#abort']['query'], 0, 400);
				}
				$out['success'] = !empty($ret['results']['success']);
				if ($escaped !== null) {
					$out['escaped'] = $escaped;
					$out['finished'] = 0;
					if (!in_array($fn, $out['abort'], true)) {
						$out['abort'][] = $fn;
					}
				}
				$serialized = null;
				try {
					$serialized = serialize($context['sandbox'] ?? []);
				} catch (Throwable $e) {
					$out['sandboxError'] = get_class($e) . ': ' . $e->getMessage();
				}
				if ($serialized !== null) {
					$out['sandbox'] = base64_encode($serialized);
				}
				// update_invoke_post_update() registers the function itself once finished,
				// so the caller reads the registry rather than being told.
				$out['ok'] =
					empty($out['abort']) && $escaped === null && !isset($out['sandboxError']);
			}
		}
	} elseif ($kind === 'flush') {
		$step = (string) ($u['step'] ?? 'all');
		$did = [];
		if ($step === 'all') {
			// the one unbounded call in this file, and it is unreachable unless the caller
			// asked for it twice: buildPlanUnits() throws without allowUnbounded, and this
			// refuses without the flag on the unit itself. Measured cost: 282.9 ms in wasm
			// / 268.8 ms native with a 78.5 MB peak, against a 10 ms free-plan invocation
			// cap. It exists for paid plans, where one invocation has 30 s.
			if ($u['unbounded'] !== true) {
				$out['refused'] = 'unbounded-flush';
				$out['error'] =
					'drupal_flush_all_caches() is 282.9 ms in wasm against a 10 ms free-plan cap; run the eleven split steps instead, or set allowUnbounded';
			} else {
				drupal_flush_all_caches();
				$did[] = 'all';
			}
		} elseif ($step === 'cache_flush') {
			// hook_cache_flush across installed modules. Bounded by module count, and each
			// implementation is a handful of deletes. NOT split further: a per-module split
			// would need the module list in the plan, and core makes no ordering promise
			// between implementations.
			Drupal::moduleHandler()->invokeAll('cache_flush');
			$did[] = $step;
		} elseif ($step === 'purge_tags') {
			$invalidator = Drupal::service('cache_tags.invalidator');
			if ($invalidator instanceof CacheTagsPurgeInterface) {
				$invalidator->purge();
				$did[] = $step;
			} else {
				$did[] = $step . ':not-purgeable';
			}
		} elseif ($step === 'bins') {
			// unbounded in the worst case: deleteAll() on cache_render or cache_data is one
			// DELETE
			// whose row count is the bin's size, and rows written is the binding free-plan
			// meter. src/cron.js caps cache_data at 5,000 rows for exactly this reason, so
			// on a site whose GC is running this is bounded in practice; on one whose is
			// not, it is not. It is ALSO not splittable per bin without the bin list in the
			// plan, which would then be stale after the container rebuild two steps later.
			// Reported per run in the unit's rows_written so the real cost arrives as a
			// measurement rather than an assumption.
			$bins = 0;
			foreach (Cache::getBins() as $bin) {
				$bin->deleteAll();
				$bins++;
			}
			$out['bins'] = $bins;
			$did[] = $step;
		} elseif ($step === 'assets') {
			Drupal::service('asset.css.collection_optimizer')->deleteAll();
			Drupal::service('asset.js.collection_optimizer')->deleteAll();
			Drupal::service('asset.query_string')->reset();
			$did[] = $step;
		} elseif ($step === 'statics') {
			drupal_static_reset();
			$did[] = $step;
		} elseif ($step === 'twig') {
			Drupal::service('twig')->invalidate();
			$did[] = $step;
		} elseif ($step === 'extension_lists') {
			Drupal::service('extension.list.profile')->reset();
			Drupal::service('extension.list.theme_engine')->reset();
			Drupal::service('theme_handler')->refreshInfo();
			Drupal::theme()->resetActiveTheme();
			$did[] = $step;
		} elseif ($step === 'container') {
			// indivisible, and the most expensive step after the bins delete. Compiling the
			// container is one pass over every service definition and every compiler pass;
			// there is no seam inside it. The two calls stay together: between
			// them Drupal::service() would resolve against a container marked dead and not
			// yet replaced.
			//
			// No wasm measurement exists for this step alone. What IS measured is the whole
			// flush at 282.9 ms, and cold boot -- which includes one container build -- at
			// 3,754 ms of edge cpuTime, so this step is plausibly the largest single piece
			// of the flush. DERIVED, not measured: it is the first thing to instrument.
			$kernel = $GLOBALS['__pw_kernel'];
			$kernel->invalidateContainer();
			$kernel->rebuildContainer();
			$did[] = $step;
		} elseif ($step === 'module_data') {
			Drupal::service('extension.list.module')->reset();
			Drupal::moduleHandler()->reload();
			$did[] = $step;
		} elseif ($step === 'rebuild_hooks') {
			// hook_rebuild across installed modules; same bound and same reason as
			// cache_flush above.
			Drupal::moduleHandler()->invokeAll('rebuild');
			$did[] = $step;
		} elseif ($step === 'router') {
			// INDIVISIBLE. RouteBuilder::rebuild() collects every route from every module,
			// runs the alter events and writes the dumped router tables in one pass, and
			// core's own comment requires it to be LAST so the router reflects everything
			// above it. It also acquires a lock, which on a persistent interpreter is the
			// hazard src/site-php.js documents: nothing calls releaseAll() at process
			// shutdown here, which is why alarm() sweeps expired semaphore rows.
			Drupal::service('router.builder')->rebuild();
			$did[] = $step;
		} else {
			$out['refused'] = 'unknown-flush-step';
			$out['error'] = 'unknown flush step: ' . $step;
		}
		if (!isset($out['refused'])) {
			$out['flushed'] = $did;
			$out['finished'] = 1;
			$out['ok'] = true;
		}
	} else {
		$out['refused'] = 'unknown-kind';
		$out['error'] = 'unknown unit kind: ' . $kind;
	}
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['trace'] = substr($e->getTraceAsString(), 0, 900);
	$out['ok'] = false;
}

echo json_encode($out);
