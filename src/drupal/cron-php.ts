/**
 * PHP fragments for the decomposed cron, run inside the Durable Object.
 *
 * They are eval'd through pib_run, so each script's `use` lines are lifted to the top of the
 * composed script. Each prints one JSON object and nothing else (the caller parses from the first
 * `{`). None calls `drupal_cron()`: a full run is 187 queries and 227-275 ms natively.
 * @module
 */
import {
	COLLECT_CRON_LISTENERS_PHP,
	CRON_HOOK_LIST_PHP,
	KERNEL_BOOT_PHP,
	LISTENER_SHAPE_PHP,
	RUN_ADVISORY_SCAN_PHP,
	RUN_CRON_HOOK_PHP,
	RUN_CRON_QUEUE_PHP,
	RUN_FETCH_REOPEN_PHP,
	RUN_HEALTH_SELF_TEST_PHP
} from '../site/generated/assets';
import { phpRender, phpWhen } from '../util/php';
import { renderTemplate } from '../util/template';
import { FIBER_SHIM } from './fiber-shim';

export { FIBER_SHIM };

/**
 * The `$_SERVER` block and the memoized kernel boot, matching the preamble in `site-php.ts`.
 *
 * The origin matters: cron sends mail, and `user_pass_reset_url()` builds an absolute link from
 * the request, so a `localhost` boot mails links to the recipient's own machine.
 * `Request::create()` never reads `$_SERVER`, so the URI it is given alone sets the host.
 *
 * @param origin - a `scheme://host[:port]`, already JSON-encoded as a PHP string literal
 */
export const kernelBoot = (origin: string) => renderTemplate(KERNEL_BOOT_PHP, { ORIGIN: origin });

/**
 * Collects the cron listeners the way Drupal\Core\Cron does, keyed by module.
 *
 * Uses invokeAllWith(), not invoke(): `ModuleHandler::invoke($module, 'cron')` throws
 * LogicException on a second implementation, which an unattended alarm should report, not die of.
 */
const COLLECT_CRON_LISTENERS = COLLECT_CRON_LISTENERS_PHP;

/** describes a collected listener without calling it */
const LISTENER_SHAPE = `\n${phpWhen("!function_exists('cfw_listener_shape')", LISTENER_SHAPE_PHP)}\n`;

/** lists every cron implementation the booted site has, running none (checks the skip list) */
export function cronHookList(origin = ''): string {
	return phpRender(CRON_HOOK_LIST_PHP, {
		FIBER_SHIM,
		LISTENER_SHAPE,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? '')))),
		COLLECT_CRON_LISTENERS
	});
}

/**
 * Runs one named module's cron implementation and nothing else.
 *
 * Departs from Drupal\Core\Cron::run() in two ways: no 'cron' lock (the object gate already
 * serialises, and a DatabaseLockBackend lock would outlive the invocation and then stall in
 * `Lock::wait()`), and no `system.cron_last` write (src/cron.js writes it in SQL). The switch to
 * the anonymous account is kept, since entity queries differ by user.
 *
 * @param {string} module machine name; anything else returns a refusal
 */
export function runCronHook(module: string, origin = ''): string {
	const name = String(module ?? '');
	if (!/^[a-z][a-z0-9_]*$/.test(name)) {
		return String.raw`<?php echo json_encode(['ran' => false, 'error' => 'refused module name']);`;
	}
	return phpRender(RUN_CRON_HOOK_PHP, {
		FIBER_SHIM,
		MODULE: JSON.stringify(JSON.stringify(name)),
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? '')))),
		COLLECT_CRON_LISTENERS
	});
}

/**
 * Processes at most `maxItems` items from one named queue, then stops.
 *
 * Core's `Cron::processQueue()` loops on the wall clock until the lease elapses; here the loop is
 * bounded by item count and the cursor in src/cron.js carries the chain. Exception handling
 * mirrors core case for case (each branch deletes, releases or leaves an item leased), plus a
 * catch-all break, since a failing item usually lacks a socket and would fail again.
 *
 * @param {string} name queue (and queue worker plugin) id
 * @param {number} maxItems items this invocation may process
 */
export function runCronQueue(name: string, maxItems = 5, origin = ''): string {
	const queue = String(name ?? '');
	if (!/^[a-z][a-z0-9_:.-]*$/.test(queue)) {
		return String.raw`<?php echo json_encode(['ran' => false, 'error' => 'refused queue name']);`;
	}
	const max =
		Number.isFinite(Number(maxItems)) && Number(maxItems) >= 1
			? Math.min(Math.floor(Number(maxItems)), 50)
			: 5;
	return phpRender(RUN_CRON_QUEUE_PHP, {
		FIBER_SHIM,
		NAME: JSON.stringify(JSON.stringify(queue)),
		MAX: String(max),
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? ''))))
	});
}

/**
 * Records what the update module found, without hook discovery.
 *
 * The module's own `hook_cron` is invisible on an installed site: hooks compile into the prebuilt
 * container, so `hasImplementations('cron', ['drupflare'])` answers false. The host calls the
 * scanner directly; the class stays in the module, only the invocation moves.
 */
export function runAdvisoryScan(origin = ''): string {
	return phpRender(RUN_ADVISORY_SCAN_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? ''))))
	});
}

/**
 * Reopens an update check that recorded a deferral as a failure.
 *
 * `DeferredCron` is a `#[Hook('cron')]` class, invisible on installed sites for the reason given
 * on {@link runAdvisoryScan}, so the host invokes it directly.
 */
export function runFetchReopen(origin = ''): string {
	return phpRender(RUN_FETCH_REOPEN_PHP, {
		FIBER_SHIM,
		KERNEL_BOOT: kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? ''))))
	});
}

/**
 * Runs the PHP health layer over an observation the host already holds.
 *
 * Host-driven rather than a hook, for the reason on {@link runAdvisoryScan}. No kernel boot:
 * `BootSelfTest::run()` reads only host-visible facts, so the observation is supplied.
 *
 * @param observation - the host's own view, as JSON; keys are `BootSelfTest`'s contract
 */
export function runHealthSelfTest(observation: unknown): string {
	return phpRender(RUN_HEALTH_SELF_TEST_PHP, {
		FIBER_SHIM,
		OBSERVATION: JSON.stringify(JSON.stringify(observation ?? {}))
	});
}
