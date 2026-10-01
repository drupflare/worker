/**
 * PHP fragments for the database-update chain (`updb`).
 *
 * `update_do_one()` catches `Exception`, not `Throwable` (update.inc:191), so a `TypeError` in a
 * `hook_update_N()` escapes with the schema version unset and its writes kept. Every core runner
 * below is wrapped in `catch (\Throwable)` so an escaped Error becomes a structured abort.
 * @module
 */
import {
	UPDB_PLAN_PHP,
	UPDB_PREAMBLE_PHP,
	UPDB_UNIT_PHP,
	UPDB_VERIFY_PHP
} from '../site/generated/assets';
import { phpRender } from '../util/php';
import { FIBER_SHIM } from './fiber-shim';

/**
 * Boots (or reuses) the kernel and loads what the update runners need, as plain PHP so a stack
 * trace names real lines. Load-bearing: a request on `request_stack` (`t()` and
 * `\Drupal::messenger()` expect one; nothing pushes one for an alarm unit); `common.inc` (the
 * `SAVED_*` constants entity saves need); and `drupal_load_updates()` every time (discovery is
 * `get_defined_functions()`, so an unloaded `.install` hides a pending update silently).
 */
const UPDB_PREAMBLE = UPDB_PREAMBLE_PHP;

/**
 * The eleven steps of `drupal_flush_all_caches()`, in core's own order (core/includes/common.inc).
 *
 * The whole call is 282.9 ms in wasm at a 78.5 MB peak, so it is split into units. The order is
 * fixed: the router rebuild goes last, and the tag purge precedes the bin deletes. `container`
 * keeps `invalidateContainer()` and `rebuildContainer()` together (between them the service
 * container is dead). Not run as eleven invocations in wasm yet; `flushSplit: false` runs the
 * single call instead.
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
 * Mirrors `DbUpdateController::triggerBatch()` (update list, per-module start, dependency
 * resolution, `setInstalledVersion($module, $number-1)` for each module's first update,
 * `update_do_one()` per update, then a cache flush and the post-updates). The unit list is built
 * by `buildPlanUnits()` in src/updb.js, testable without an interpreter.
 *
 * `codeId` digests every `*_update_<n>` and `*_post_update_*` function name plus
 * `\Drupal::VERSION`: a deploy can swap the code under a half-finished cursor. It covers names,
 * not bodies, since a body change leaves the plan valid.
 *
 * @param {boolean} checkRequirements runs `hook_requirements('update')` (on by default; own unit)
 */
export function updbPlan(checkRequirements = true): string {
	return phpRender(UPDB_PLAN_PHP, {
		FIBER_SHIM,
		UPDB_PREAMBLE,
		CHECK_REQUIREMENTS: checkRequirements ? 'true' : 'false'
	});
}

/**
 * One unit of a sliced database update, as the JavaScript side describes it.
 * Every field is optional (built incrementally, read per `kind`); `updbUnit()` validates them all.
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
 * Runs exactly one unit and returns everything the cursor needs to advance.
 *
 * - `finished` is core's `$context['finished']`, seeded to 1; under 1 the unit asked to be
 *   re-entered and its schema version has not moved.
 * - `sandbox` is base64 of `serialize($context['sandbox'])` (core's own batch contract); one that
 *   will not serialize is an error, not truncated.
 * - `abort` is `$context['results']['#abort']`; the caller must carry it across units or a
 *   dependent of a failed update would run.
 *
 * @param unit see {@link UpdbUnitSpec}; every field is validated here rather than trusted
 */
export function updbUnit(unit: UpdbUnitSpec = {}): string {
	const kind = String(unit.kind ?? '');
	// allowlisted: a step name is a closed set, so the PHP side rejects an unknown name
	// instead of echoing an attacker's string in a refusal
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
	return phpRender(UPDB_UNIT_PHP, {
		FIBER_SHIM,
		PAYLOAD: JSON.stringify(payload),
		UPDB_PREAMBLE
	});
}

/** reads back what the run changed for the completion report (runs after a halt; never writes) */
export const UPDB_VERIFY = phpRender(UPDB_VERIFY_PHP, { FIBER_SHIM, UPDB_PREAMBLE });
