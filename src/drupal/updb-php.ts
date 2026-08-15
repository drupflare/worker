/**
 * PHP fragments for the database-update chain (`updb`).
 *
 * One core gap changes the error handling: `update_do_one()` catches
 * `Exception`, not `Throwable` (update.inc:191). A `TypeError` or a call to an
 * undefined function inside a `hook_update_N()` therefore escapes it completely,
 * with the schema version left unset and whatever the hook already wrote still
 * written. Every invocation of core's runners below is wrapped in
 * `catch (\Throwable)` so an escaped Error becomes a structured abort instead of a
 * dead invocation with no cursor update.
 */

/**
 * The eager Fiber stand-in, guarded so it composes with the copy in
 * src/site-php.js -- whichever fragment runs first defines it.
 *
 * `scripts/patch-drupal.mjs` rewrites core's five `new \Fiber()` sites to this
 * class, so any fragment that can reach the render pipeline needs it. A cache
 * flush rebuilds the theme registry and the router, both of which can.
 */
const UPDB_FIBER_SHIM = String.raw`
if (!class_exists('PhpWasmSyncFiber', false)) { eval('
class PhpWasmSyncFiber {
  private $callable;
  private $result = null;
  private $started = false;
  public function __construct(callable $callable) { $this->callable = $callable; }
  public function start(...$args) { $this->started = true; $this->result = ($this->callable)(...$args); return null; }
  public function isStarted(): bool { return $this->started; }
  public function isSuspended(): bool { return false; }
  public function isRunning(): bool { return false; }
  public function isTerminated(): bool { return $this->started; }
  public function resume($value = null) { return null; }
  public function throw(\\Throwable $e) { throw $e; }
  public function getReturn() { return $this->result; }
  public static function getCurrent(): ?object { return null; }
  public static function suspend($value = null) { return null; }
}
'); }
`;

/**
 * Boots (or reuses) the kernel and loads everything the update runners need.
 *
 * Inlined as plain PHP rather than an eval'd helper, matching renderPage(), so a
 * stack trace names real lines.
 *
 * Three things here are load-bearing and none is tidiness:
 *
 *   1. A request on `request_stack`. `update_do_one()` calls `t()` and
 *      `_update_fix_missing_schema()` calls `\Drupal::messenger()`; both expect a
 *      current request. `cfw_serve()` pushes one for a render, and nothing does for
 *      an alarm-driven unit.
 *   2. `common.inc`. It defines `drupal_flush_all_caches()` and
 *      `drupal_static_reset()`, and also the `SAVED_*` constants that every entity
 *      save needs -- a post-update that saves an entity would otherwise fatal with
 *      "Undefined constant SAVED_UPDATED", which is the exact failure first-run
 *      config hit.
 *   3. `drupal_load_updates()` EVERY TIME. Discovery is `get_defined_functions()`,
 *      so an unloaded `.install` file makes a pending update invisible rather than
 *      failing loudly. It is cheap on repeat (ModuleHandler memoizes loaded
 *      includes) and correct after an eviction.
 */
const UPDB_PREAMBLE = String.raw`
if (!isset($GLOBALS['__pw_autoloader'])) {
  $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
}
$autoloader = $GLOBALS['__pw_autoloader'];

if (!isset($GLOBALS['__pw_kernel'])) {
  $bootRequest = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
  $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
  \Drupal\Core\DrupalKernel::bootEnvironment();
  $sitePath = \Drupal\Core\DrupalKernel::findSitePath($bootRequest);
  $kernel->setSitePath($sitePath);
  \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
  $kernel->boot();
  $GLOBALS['__pw_kernel'] = $kernel;
  $out['bootedKernel'] = 1;
}

try {
  $stack = \Drupal::service('request_stack');
  if ($stack->getCurrentRequest() === null) {
    $stack->push(\Symfony\Component\HttpFoundation\Request::create('/update.php', 'GET'));
    $out['pushedRequest'] = 1;
  }
} catch (\Throwable $e) {
  $out['requestStackError'] = get_class($e) . ': ' . $e->getMessage();
}

require_once '/drupal/core/includes/common.inc';
require_once '/drupal/core/includes/install.inc';
require_once '/drupal/core/includes/update.inc';
drupal_load_updates();
`;

/**
 * The eleven steps of `drupal_flush_all_caches()`, in core's own order.
 *
 * Read straight off core/includes/common.inc:408-475 in this tree. The whole call
 * is 282.9 ms in wasm with a 78.5 MB peak (FINDINGS "Module installation"), which
 * is 28x a free-plan invocation's 10 ms cap in one indivisible synchronous call --
 * so the only way it fits is to stop calling it as one function. Each step below
 * is a separate unit with its own budget.
 *
 * Order is NOT negotiable and core says why: the router rebuild "must happen last,
 * so the menu router is guaranteed to be based on up to date information", and the
 * tag purge must precede the bin deletes or a tag invalidated in between lands in
 * the checksum of a new item while still being valid.
 *
 * `container` keeps `invalidateContainer()` and `rebuildContainer()`
 * together: between them `\Drupal::service()` would resolve against a container
 * that has been marked dead but not replaced.
 *
 * Not executed in wasm. The decomposition is a faithful read of core, but no run of
 * these eleven steps as eleven invocations exists yet, and two of them are the kind
 * of thing this project has been bitten by: `container` re-instantiates the
 * database Connection on a persistent interpreter, and `module_data` calls
 * `ModuleHandler::reload()`. `flushSplit: false` runs the single call instead.
 */
export const UPDB_FLUSH_STEPS = [
	'cache_flush',
	'purge_tags',
	'bins',
	'assets',
	'statics',
	'twig',
	'extension_lists',
	'container',
	'module_data',
	'rebuild_hooks',
	'router'
];

/**
 * Enumerates what is pending, and hashes the code that defines it.
 *
 * Mirrors `DbUpdateController::triggerBatch()` (system/src/Controller/
 * DbUpdateController.php:597) rather than inventing an order:
 * `update_get_update_list()` -> per-module `start` -> `update_resolve_dependencies()`
 * -> the `reverse_paths` dependency map -> `setInstalledVersion($module, $number-1)`
 * for the FIRST update of each module -> `update_do_one()` per update -> then, only
 * if post-updates are pending, a full cache flush followed by each
 * `update_invoke_post_update()`.
 *
 * What it does NOT do is build the unit list. That is
 * `buildPlanUnits()` in src/updb.js, so the ordering rules are testable without an
 * interpreter.
 *
 * `codeId` is a digest of every `*_update_<n>` and `*_post_update_*` function
 * defined in the tree, plus `\Drupal::VERSION`. That set is precisely what makes a
 * plan valid or stale: on this platform the PHP tree is a versioned asset pack, so
 * a deploy can swap the code under a half-finished cursor -- something a
 * traditional host running update.php in one process cannot do. A patch that
 * changes a hook's BODY without changing the function set leaves the plan correct,
 * which is why the digest covers names and not contents.
 *
 * `checkRequirements` runs `update_check_requirements()`, which invokes
 * `hook_requirements('update')` for every installed module. That is admin-class
 * work and may well not fit a 10 ms invocation on its own; it is on by default
 * anyway, because applying schema changes without asking core whether it is safe
 * is the wrong default. It has its own unit, so it gets its own budget.
 *
 * @param {boolean} checkRequirements
 */
export function updbPlan(checkRequirements = true): string {
	return String.raw`<?php
${UPDB_FIBER_SHIM}
chdir('/drupal');

$out = ['ok' => false, 'updates' => [], 'postUpdates' => []];

try {
${UPDB_PREAMBLE}

  $reg = \Drupal::service('update.update_hook_registry');
  $postReg = \Drupal::service('update.post_update_registry');

  $out['drupalVersion'] = \Drupal::VERSION;
  $out['minimumSchemaVersion'] = \Drupal::CORE_MINIMUM_SCHEMA_VERSION;

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
  $out['codeId'] = sha1(\Drupal::VERSION . '|' . implode(',', $updateFns));
  $out['codeFunctionCount'] = count($updateFns);

  if (${checkRequirements ? 'true' : 'false'}) {
    try {
      $reqs = update_check_requirements();
      $worst = \Drupal\Core\Extension\Requirement\RequirementSeverity::maxSeverityFromRequirements($reqs);
      $out['severity'] = $worst->value;
      $out['severityName'] = $worst->name;
      $errors = [];
      $warnings = [];
      foreach ($reqs as $key => $r) {
        $s = $r['severity'] ?? null;
        if (!($s instanceof \Drupal\Core\Extension\Requirement\RequirementSeverity)) { continue; }
        $text = strip_tags((string) ($r['description'] ?? $r['value'] ?? ''));
        if ($s === \Drupal\Core\Extension\Requirement\RequirementSeverity::Error) {
          $errors[$key] = substr($text, 0, 300);
        } elseif ($s === \Drupal\Core\Extension\Requirement\RequirementSeverity::Warning) {
          $warnings[$key] = substr($text, 0, 300);
        }
      }
      $out['requirementErrors'] = $errors;
      $out['requirementWarnings'] = $warnings;
    } catch (\Throwable $e) {
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
    if (isset($info['warning'])) { $listWarnings[$module] = strip_tags((string) $info['warning']); }
    if (isset($info['start'])) { $start[$module] = $info['start']; }
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
      'depMap' => array_values($depMap[$fn] ?? []),
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
    foreach ($postReg->getPendingUpdateFunctions() as $fn) { $post[] = $fn; }
  } catch (\Throwable $e) {
    // RemovedPostUpdateNameException is thrown when a module declares an update
    // removed in hook_removed_post_updates() while the function still exists. That
    // is a broken code tree, not a transient error, and it must stop the plan.
    $out['postUpdateError'] = get_class($e) . ': ' . $e->getMessage();
  }
  $out['postUpdates'] = $post;

  $out['installedVersions'] = $reg->getAllInstalledVersions();
  $out['counts'] = ['updates' => count($out['updates']), 'postUpdates' => count($post)];
  $out['ok'] = !isset($out['postUpdateError']);
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
  $out['trace'] = substr($e->getTraceAsString(), 0, 900);
}

echo json_encode($out);
`;
}

/**
 * One unit of a sliced database update, as the JavaScript side describes it.
 *
 * Every field is optional because the dispatcher builds a unit incrementally and each PHP-side
 * consumer reads only the fields its `kind` needs. The function validates all of them anyway --
 * see the allowlist note on `step` -- so this type documents the surface rather than guarding it.
 */
export type UpdbUnitSpec = {
	seq?: number;
	kind?: string;
	fn?: string | null;
	module?: string | null;
	number?: number | null;
	step?: string | null;
	depMap?: string[];
	seedSchema?: number | null;
	sandbox?: string | null;
	abortList?: string[];
	maintTarget?: boolean;
	unbounded?: boolean;
};

/** `Number.isFinite` does not narrow, and these values arrive as `number | null | undefined` */
function finite(v: unknown): v is number {
	return Number.isFinite(v);
}

/**
 * Runs exactly ONE unit, and returns everything the cursor needs to advance.
 *
 * The contract, because the caller depends on all of it:
 *
 *   - `finished` is core's `$context['finished']`, seeded to 1 the way
 *     `_batch_process()` does (batch.inc:286). A batch-aware `hook_update_N()` sets
 *     `$sandbox['#finished']` below 1 to ask to be re-entered; `update_do_one()`
 *     copies that into `$context['finished']` and only calls
 *     `setInstalledVersion()` when it reaches 1. So a `finished` under 1 means the
 *     unit is not done and its schema version has NOT moved.
 *   - `sandbox` is base64 of `serialize($context['sandbox'])`. Core's own batch API
 *     serializes the same array into the `batch` table between HTTP requests, so
 *     "the sandbox survives a process boundary" is core's contract and not a trick
 *     played here. A sandbox that will not serialize is reported as an error rather
 *     than silently truncated.
 *   - `abort` is `$context['results']['#abort']`, the list of aborted function
 *     names. It has to be carried forward across units by the caller, because
 *     `update_do_one()` reads it to skip anything that depended on a failed update.
 *     A resumed chain that forgot it would run a dependent whose dependency failed.
 *
 * @param unit see {@link UpdbUnitSpec}; every field is validated here rather than trusted
 */
export function updbUnit(unit: UpdbUnitSpec = {}): string {
	const kind = String(unit.kind ?? '');
	// Allowlisted rather than passed through. The payload is JSON-escaped into a PHP
	// string literal so nothing here can break out of it, but an unrecognised value
	// reaching the dispatch would produce a refusal naming an attacker's string, and a
	// step name is a closed set anyway. Filtering makes the PHP side's job to reject a
	// name it does not know, not to sanitise one.
	const stepOk =
		typeof unit.step === 'string' &&
		(UPDB_FLUSH_STEPS.includes(unit.step) || unit.step === 'all');
	const payload = JSON.stringify({
		seq: finite(unit.seq) ? Math.floor(unit.seq) : 0,
		kind,
		fn: typeof unit.fn === 'string' && /^[A-Za-z0-9_:.-]+$/.test(unit.fn) ? unit.fn : null,
		module:
			typeof unit.module === 'string' && /^[a-z][a-z0-9_]*$/.test(unit.module)
				? unit.module
				: null,
		number: finite(unit.number) ? Math.floor(unit.number) : null,
		step: stepOk ? unit.step : null,
		depMap: (Array.isArray(unit.depMap) ? unit.depMap : []).filter(
			(d) => typeof d === 'string' && /^[A-Za-z0-9_]+$/.test(d)
		),
		seedSchema: finite(unit.seedSchema) ? Math.floor(unit.seedSchema) : null,
		sandbox: typeof unit.sandbox === 'string' ? unit.sandbox : null,
		abortList: (Array.isArray(unit.abortList) ? unit.abortList : []).filter(
			(d) => typeof d === 'string' && /^[A-Za-z0-9_]+$/.test(d)
		),
		maintTarget: unit.maintTarget === true,
		unbounded: unit.unbounded === true
	});
	return String.raw`<?php
${UPDB_FIBER_SHIM}
chdir('/drupal');

$u = json_decode(${JSON.stringify(payload)}, true);
$out = ['ok' => false, 'kind' => $u['kind'], 'seq' => $u['seq'], 'finished' => 0];

try {
${UPDB_PREAMBLE}

  // The sandbox is the only mid-hook state there is. Refuse a malformed one rather
  // than start a hook from scratch that already ran half of itself.
  $sandbox = [];
  if (is_string($u['sandbox']) && $u['sandbox'] !== '') {
    $raw = base64_decode($u['sandbox'], true);
    if ($raw === false) { throw new \RuntimeException('stored sandbox is not valid base64'); }
    $restored = @unserialize($raw);
    if (!is_array($restored)) { throw new \RuntimeException('stored sandbox did not unserialize to an array'); }
    $sandbox = $restored;
    $out['sandboxRestored'] = count($sandbox);
  }

  $results = [];
  if (!empty($u['abortList'])) { $results['#abort'] = array_values($u['abortList']); }
  // finished defaults to 1, exactly as _batch_process() seeds it (batch.inc:286);
  // without that update_do_one() never records the schema version.
  $context = ['sandbox' => $sandbox, 'results' => $results, 'finished' => 1, 'message' => ''];

  $kind = $u['kind'];

  if ($kind === 'maint_on' || $kind === 'maint_off') {
    // maint_off restores the PRE-RUN value rather than forcing FALSE, which is what
    // DbUpdateController::batchFinished() does via the session. Here the pre-run
    // value lives in the run row, so it survives an eviction that a session would
    // not.
    $want = ($kind === 'maint_on') ? true : ($u['maintTarget'] === true);
    \Drupal::state()->set('system.maintenance_mode', $want);
    $out['maintenanceMode'] = \Drupal::state()->get('system.maintenance_mode') ? 1 : 0;
    $out['wanted'] = $want ? 1 : 0;
    $out['finished'] = 1;
    $out['ok'] = ($out['maintenanceMode'] === ($want ? 1 : 0));
    if (!$out['ok']) { $out['error'] = 'maintenance_mode did not take: state read back as ' . $out['maintenanceMode']; }
  }

  elseif ($kind === 'update') {
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
    $reg = \Drupal::service('update.update_hook_registry');
    $out['installedBefore'] = $reg->getInstalledVersion($module);

    if ($u['seedSchema'] !== null) {
      $reg->setInstalledVersion($module, (int) $u['seedSchema']);
      $out['seededTo'] = (int) $u['seedSchema'];
    }

    $equivalent = null;
    try { $equivalent = $reg->getEquivalentUpdate($module, $number); } catch (\Throwable $e) {}

    if (!function_exists($fn) && $equivalent === null) {
      // The plan named a function this tree does not define. That is a stale plan,
      // not a failed update, so it must not be retried and must not advance.
      $out['refused'] = 'missing-function';
      $out['error'] = $fn . ' is not defined and has no equivalent-update record; the plan was built against a different code tree';
    } else {
      $escaped = null;
      try {
        update_do_one($module, $number, array_values($u['depMap']), $context);
      } catch (\Throwable $e) {
        // update.inc:191 catches Exception, not Throwable, so an Error inside the
        // hook lands here with the schema version unmoved and whatever the hook
        // already wrote still written.
        $escaped = get_class($e) . ': ' . $e->getMessage();
      }
      $out['finished'] = isset($context['finished']) && is_numeric($context['finished']) ? (float) $context['finished'] : 1.0;
      $out['abort'] = array_values($context['results']['#abort'] ?? []);
      $ret = $context['results'][$module][$number] ?? [];
      if (isset($ret['results']['query'])) { $out['message'] = substr((string) $ret['results']['query'], 0, 400); }
      if (!empty($ret['#abort']['query'])) { $out['abortMessage'] = substr((string) $ret['#abort']['query'], 0, 400); }
      $out['success'] = !empty($ret['results']['success']);
      $out['installedAfter'] = $reg->getInstalledVersion($module);
      if ($escaped !== null) {
        $out['escaped'] = $escaped;
        $out['finished'] = 0;
        if (!in_array($fn, $out['abort'], true)) { $out['abort'][] = $fn; }
      }
      $serialized = null;
      try { $serialized = serialize($context['sandbox'] ?? []); } catch (\Throwable $e) {
        $out['sandboxError'] = get_class($e) . ': ' . $e->getMessage();
      }
      if ($serialized !== null) { $out['sandbox'] = base64_encode($serialized); }
      $out['ok'] = empty($out['abort']) && $escaped === null && !isset($out['sandboxError']);
    }
  }

  elseif ($kind === 'post_update') {
    $fn = (string) $u['fn'];
    if (strpos($fn, '_post_update_') === false) {
      $out['refused'] = 'not-a-post-update';
      $out['error'] = $fn . ' does not contain _post_update_';
    } else {
      $parts = explode('_post_update_', $fn, 2);
      $extension = $parts[0];
      $postReg = \Drupal::service('update.post_update_registry');
      // Loads <extension>.post_update.php. update_invoke_post_update() does this
      // itself, but it then silently does nothing when the function is absent --
      // leaving the unit "finished" without having run or registered anything. So
      // the file is loaded here and function_exists() is checked first.
      try { $postReg->getUpdateFunctions($extension); } catch (\Throwable $e) {
        $out['loadError'] = get_class($e) . ': ' . $e->getMessage();
      }
      if (!function_exists($fn)) {
        $out['refused'] = 'missing-function';
        $out['error'] = $fn . ' is not defined after loading ' . $extension . '.post_update.php; the plan was built against a different code tree';
      } else {
        $escaped = null;
        try {
          update_invoke_post_update($fn, $context);
        } catch (\Throwable $e) {
          $escaped = get_class($e) . ': ' . $e->getMessage();
        }
        $out['finished'] = isset($context['finished']) && is_numeric($context['finished']) ? (float) $context['finished'] : 1.0;
        $out['abort'] = array_values($context['results']['#abort'] ?? []);
        $name = $parts[1];
        $ret = $context['results'][$extension][$name] ?? [];
        if (isset($ret['results']['query'])) { $out['message'] = substr((string) $ret['results']['query'], 0, 400); }
        if (!empty($ret['#abort']['query'])) { $out['abortMessage'] = substr((string) $ret['#abort']['query'], 0, 400); }
        $out['success'] = !empty($ret['results']['success']);
        if ($escaped !== null) {
          $out['escaped'] = $escaped;
          $out['finished'] = 0;
          if (!in_array($fn, $out['abort'], true)) { $out['abort'][] = $fn; }
        }
        $serialized = null;
        try { $serialized = serialize($context['sandbox'] ?? []); } catch (\Throwable $e) {
          $out['sandboxError'] = get_class($e) . ': ' . $e->getMessage();
        }
        if ($serialized !== null) { $out['sandbox'] = base64_encode($serialized); }
        // update_invoke_post_update() registers the function itself once finished,
        // so the caller reads the registry rather than being told.
        $out['ok'] = empty($out['abort']) && $escaped === null && !isset($out['sandboxError']);
      }
    }
  }

  elseif ($kind === 'flush') {
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
        $out['error'] = 'drupal_flush_all_caches() is 282.9 ms in wasm against a 10 ms free-plan cap; run the eleven split steps instead, or set allowUnbounded';
      } else {
        drupal_flush_all_caches();
        $did[] = 'all';
      }
    } elseif ($step === 'cache_flush') {
      // hook_cache_flush across installed modules. Bounded by module count, and each
      // implementation is a handful of deletes. NOT split further: a per-module split
      // would need the module list in the plan, and core makes no ordering promise
      // between implementations.
      \Drupal::moduleHandler()->invokeAll('cache_flush');
      $did[] = $step;
    } elseif ($step === 'purge_tags') {
      $invalidator = \Drupal::service('cache_tags.invalidator');
      if ($invalidator instanceof \Drupal\Core\Cache\CacheTagsPurgeInterface) {
        $invalidator->purge();
        $did[] = $step;
      } else {
        $did[] = $step . ':not-purgeable';
      }
    } elseif ($step === 'bins') {
      // genuinely unbounded in the worst case: deleteAll() on cache_render or cache_data is one
      // DELETE
      // whose row count is the bin's size, and rows written is the binding free-plan
      // meter. src/cron.js caps cache_data at 5,000 rows for exactly this reason, so
      // on a site whose GC is running this is bounded in practice; on one whose is
      // not, it is not. It is ALSO not splittable per bin without the bin list in the
      // plan, which would then be stale after the container rebuild two steps later.
      // Reported per run in the unit's rows_written so the real cost arrives as a
      // measurement rather than an assumption.
      $bins = 0;
      foreach (\Drupal\Core\Cache\Cache::getBins() as $bin) { $bin->deleteAll(); $bins++; }
      $out['bins'] = $bins;
      $did[] = $step;
    } elseif ($step === 'assets') {
      \Drupal::service('asset.css.collection_optimizer')->deleteAll();
      \Drupal::service('asset.js.collection_optimizer')->deleteAll();
      \Drupal::service('asset.query_string')->reset();
      $did[] = $step;
    } elseif ($step === 'statics') {
      drupal_static_reset();
      $did[] = $step;
    } elseif ($step === 'twig') {
      \Drupal::service('twig')->invalidate();
      $did[] = $step;
    } elseif ($step === 'extension_lists') {
      \Drupal::service('extension.list.profile')->reset();
      \Drupal::service('extension.list.theme_engine')->reset();
      \Drupal::service('theme_handler')->refreshInfo();
      \Drupal::theme()->resetActiveTheme();
      $did[] = $step;
    } elseif ($step === 'container') {
      // indivisible, and the most expensive step after the bins delete. Compiling the
      // container is one pass over every service definition and every compiler pass;
      // there is no seam inside it. The two calls stay together: between
      // them \Drupal::service() would resolve against a container marked dead and not
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
      \Drupal::service('extension.list.module')->reset();
      \Drupal::moduleHandler()->reload();
      $did[] = $step;
    } elseif ($step === 'rebuild_hooks') {
      // hook_rebuild across installed modules; same bound and same reason as
      // cache_flush above.
      \Drupal::moduleHandler()->invokeAll('rebuild');
      $did[] = $step;
    } elseif ($step === 'router') {
      // INDIVISIBLE. RouteBuilder::rebuild() collects every route from every module,
      // runs the alter events and writes the dumped router tables in one pass, and
      // core's own comment requires it to be LAST so the router reflects everything
      // above it. It also acquires a lock, which on a persistent interpreter is the
      // hazard src/site-php.js documents: nothing calls releaseAll() at process
      // shutdown here, which is why alarm() sweeps expired semaphore rows.
      \Drupal::service('router.builder')->rebuild();
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
  }

  else {
    $out['refused'] = 'unknown-kind';
    $out['error'] = 'unknown unit kind: ' . $kind;
  }
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
  $out['trace'] = substr($e->getTraceAsString(), 0, 900);
  $out['ok'] = false;
}

echo json_encode($out);
`;
}

/**
 * Reads back what the run changed, for the completion report.
 *
 * Deliberately separate from the units: it must be runnable after a halt as well
 * as after a success, and it must never write.
 */
export const UPDB_VERIFY = String.raw`<?php
${UPDB_FIBER_SHIM}
chdir('/drupal');

$out = ['ok' => false];

try {
${UPDB_PREAMBLE}

  $reg = \Drupal::service('update.update_hook_registry');
  $postReg = \Drupal::service('update.post_update_registry');
  $out['installedVersions'] = $reg->getAllInstalledVersions();
  $out['pendingUpdates'] = [];
  foreach (update_get_update_list() as $module => $info) {
    $out['pendingUpdates'][$module] = array_keys($info['pending'] ?? []);
  }
  $pendingPost = [];
  try {
    foreach ($postReg->getPendingUpdateFunctions() as $fn) { $pendingPost[] = $fn; }
  } catch (\Throwable $e) {
    $out['postUpdateError'] = get_class($e) . ': ' . $e->getMessage();
  }
  $out['pendingPostUpdates'] = $pendingPost;
  $out['maintenanceMode'] = \Drupal::state()->get('system.maintenance_mode') ? 1 : 0;
  $out['equivalentUpdates'] = $reg->getAllEquivalentUpdates();
  $out['clean'] = empty($pendingPost);
  foreach ($out['pendingUpdates'] as $module => $numbers) {
    if (!empty($numbers)) { $out['clean'] = false; }
  }
  $out['ok'] = true;
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
  $out['trace'] = substr($e->getTraceAsString(), 0, 900);
}

echo json_encode($out);
`;
