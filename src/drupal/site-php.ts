/**
 * PHP fragments that run inside the Durable Object.
 *
 * They are eval'd through `pib_run`, so a fragment takes no `use` statement and names classes fully
 * qualified. Each prints one JSON object and nothing else (the caller parses from the first `{`).
 * @module
 */

import { bytesToBase64 } from '../db/file-store';
import {
	ABANDON_TRANSACTION_PHP,
	BOOT_KERNEL_PHP,
	BOOT_PHASE_CONTAINER_READ_PHP,
	BOOT_PHASE_CONTAINER_UNSERIALIZE_PHP,
	BOOT_PHASE_KERNEL_BOOT_PHP,
	BOOT_PHASE_KERNEL_NEW_PHP,
	BOOT_PHASE_PHP,
	BOOT_PHASE_PRE_HANDLE_PHP,
	BOOT_PHASE_RENDER_PHP,
	BOUNDARY_STATE_PHP,
	CAPABILITY_CHECK_PHP,
	CAPABILITY_VECTORS_PHP,
	CLAIM_BOOT_PHP,
	CLAIM_WARM_RUN_PHP,
	CREATE_USER_PHP,
	DRIVER_LIVE_SUITE_PHP,
	DRUPAL_OP_PHP,
	DRUPAL_REQUEST_PHP,
	EXPORT_DATABASE_PHP,
	FIRST_RUN_CONFIG_PHP,
	GUZZLE_HANDLER_CHECK_PHP,
	HARVEST_SHELL_PHP,
	HOST_HELPERS_PHP,
	INVALIDATE_TAGS_PHP,
	LEAK_OPEN_SESSION_PHP,
	LEAK_OUTPUT_BUFFER_PHP,
	MB_CHECK_PHP,
	MEMFS_CENSUS_PHP,
	MIGRATE_DB_PHP,
	OPS_REGISTRY_PHP,
	OPS_RUN_PHP,
	PACK_CONSISTENCY_PHP,
	PACK_CONSISTENCY_RUN_PHP,
	PROBE_RUNTIME_PHP,
	PW_SERVE_INLINE_PHP,
	RENDER_FRAGMENTS_PHP,
	RENDER_PAGE_PHP,
	SAVE_NODE_PHP,
	SCHEMA_REPAIR_PHP,
	SUBMISSION_PROBE_PHP,
	TRANSLATE_ENGLISH_PHP,
	VERIFY_MODULES_PHP,
	WRITE_WORKLOAD_PHP
} from '../site/generated/assets';
import { phpRender, phpScript, phpWhen } from '../util/php';
import { FIBER_SHIM } from './fiber-shim';

/**
 * The host-call helper every fragment uses to reach `ctx.storage.sql`.
 *
 * It goes through `vrzno_env('cfwSqlExec')` and the `pw_encode`/`pw_decode` codec, as the driver
 * does, so a working fragment also exercises the driver's transport.
 */
export const HOST_HELPERS = `\n${phpWhen("!function_exists('cfw_host')", HOST_HELPERS_PHP)}\n`;

/**
 * Asks the runtime questions a PDO stand-in cannot answer, one statement each.
 *
 * Each answer records the engine's own message, which says whether a feature is missing or only
 * spelled differently.
 */
export const PROBE_RUNTIME = phpRender(PROBE_RUNTIME_PHP, { HOST_HELPERS });

/**
 * Runs the `mb_*` invalid-UTF-8 cases inside wasm, where the polyfill is in use.
 *
 * Native PHP has mbstring and cannot reach the polyfill path, so the caller diffs this against the
 * native oracle. It requires `/drupal/autoload.php` for the Symfony polyfill classes.
 */
export const MB_CHECK = phpScript(MB_CHECK_PHP);

/**
 * Copies the packed SQLite file into `ctx.storage.sql`.
 *
 * Two rewrites are mandatory: `NOCASE_UTF8` becomes `NOCASE` (the host has no user-defined
 * collations; `Schema.php` makes the same substitution), and `sqlite_sequence` and
 * `sqlite_autoindex_*` are skipped (engine-owned, refuse creation).
 */
export const MIGRATE_DB = phpRender(MIGRATE_DB_PHP, { HOST_HELPERS });

/**
 * Serves one request against a persistent kernel.
 *
 * `DrupalKernel::preHandle()` is guarded by `$this->prepared` and pushes onto `request_stack` only
 * on the first `handle()`, so later calls route against the first request's path. The fragment
 * clears the flag and drains the stack.
 */
const PW_SERVE_INLINE = `\n${phpWhen("!function_exists('cfw_serve')", PW_SERVE_INLINE_PHP)}\n`;

/**
 * Boots the Drupal kernel and stops; no request is handled.
 *
 * It is the post-boot, pre-render snapshot point (a heap taken after a render carries request
 * state). The kernel is memoised in `$GLOBALS['__pw_kernel']`, which later renders reuse.
 */
export const BOOT_KERNEL = phpRender(BOOT_KERNEL_PHP, { FIBER_SHIM, HOST_HELPERS });

/**
 * Loads every enabled module's PHP, which a boot alone does not do.
 *
 * The container comes from `cache_container`, so `boot()` reads no module file;
 * `ModuleHandler::loadAll()` includes each `.module` during `preHandle()`.
 *
 * A parse error is uncatchable (`include` raises E_COMPILE_ERROR), so the verdict prints last and
 * the caller treats a missing verdict as a failure.
 */
export const VERIFY_MODULES = phpScript(VERIFY_MODULES_PHP);

/**
 * The boot phases, in the order a boot runs them.
 *
 * `container-read` and `container-unserialize` are branches off `kernel-new`, not steps before
 * `kernel-boot`; running them inline would warm what the boot reads.
 */
export const BOOT_PHASES = [
	'autoload',
	'kernel-new',
	'container-read',
	'container-unserialize',
	'kernel-boot',
	'pre-handle',
	'render'
] as const;

/** one name from {@link BOOT_PHASES} */
export type BootPhase = (typeof BOOT_PHASES)[number];

/**
 * One boot phase, cumulatively: runs every phase up to `phase` and stops.
 *
 * Use one invocation per phase and read `cpuTime` from `wrangler tail` (the clock is frozen inside
 * an invocation, so the phase cost is `cpuTime(N) - cpuTime(N-1)`). The caller must drop the
 * interpreter first: `BOOT_KERNEL` memoises the kernel, so a warm object measures nothing.
 * The elapsed figure is local-only; the byte counts (`containerBytes`) are the useful output.
 */
export function bootPhaseFragment(phase: BootPhase): string {
	const index = BOOT_PHASES.indexOf(phase);
	if (index < 0) throw new RangeError(`unknown boot phase: ${phase}`);
	const upto = (name: BootPhase): boolean => index >= BOOT_PHASES.indexOf(name);
	const branch = phase === 'container-read' || phase === 'container-unserialize';

	return phpRender(BOOT_PHASE_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		PW_SERVE_INLINE: upto('render') ? PW_SERVE_INLINE : '',
		PHASE: JSON.stringify(phase),
		KERNEL_NEW: upto('kernel-new') ? BOOT_PHASE_KERNEL_NEW_PHP.trimEnd() : '',
		CONTAINER_READ: branch ? BOOT_PHASE_CONTAINER_READ_PHP.trimEnd() : '',
		CONTAINER_UNSERIALIZE:
			phase === 'container-unserialize' ? BOOT_PHASE_CONTAINER_UNSERIALIZE_PHP.trimEnd() : '',
		KERNEL_BOOT: upto('kernel-boot') && !branch ? BOOT_PHASE_KERNEL_BOOT_PHP.trimEnd() : '',
		PRE_HANDLE: upto('pre-handle') && !branch ? BOOT_PHASE_PRE_HANDLE_PHP.trimEnd() : '',
		RENDER: phase === 'render' ? BOOT_PHASE_RENDER_PHP.trimEnd() : ''
	});
}

/**
 * The `cfw_ops` registry, read without booting a kernel.
 *
 * `OpsRegistry` has no dependencies, so the fragment requires its file by path (a ~1,400 ms boot to
 * list operations is not discovery). Autoload cannot be used: Drupal registers module namespaces
 * only during kernel boot.
 */
export const OPS_REGISTRY = phpScript(OPS_REGISTRY_PHP);

/**
 * Runs one registry operation through `OpsRunner`, with a kernel.
 *
 * Unlike {@link OPS_REGISTRY} this boots a kernel (every operation reaches a Drupal service).
 *
 * @param name - a registry operation
 * @param args - positional arguments, already stripped of flags
 * @param options - `offset`/`limit` for cex, `payload` for cim, `collections`/`budget` for steps
 */
export function opsRun(
	name: string,
	args: readonly string[] = [],
	options: {
		offset?: number;
		limit?: number;
		payload?: unknown;
		collections?: unknown;
		budget?: unknown;
	} = {}
): string {
	const encoded = JSON.stringify(
		JSON.stringify({
			name: String(name),
			args: args.map((a) => String(a)),
			options: {
				...(Number.isFinite(options.offset) ? { offset: Number(options.offset) } : {}),
				...(Number.isFinite(options.limit) ? { limit: Number(options.limit) } : {}),
				...(options.payload === undefined ? {} : { payload: options.payload }),
				...(options.collections === undefined ? {} : { collections: options.collections }),
				...(options.budget === undefined ? {} : { budget: options.budget })
			}
		})
	);
	return phpRender(OPS_RUN_PHP, { FIBER_SHIM, REQUEST: encoded });
}

/**
 * Builds the PHP for one measured Drupal request; `repeat` runs it that many times.
 *
 * Every response reports `x-drupal-cache` and `x-drupal-dynamic-cache`, and callers assert on them:
 * `Request::create()` carries no session cookie, so an unwarmed `page_cache` HIT reads as a render.
 * Timing is taken inside a closure (a backtrace walk at eval'd global scope inflates 12-24x).
 *
 * `bins` names the caches emptied first, and a render figure must name them: `[]` is a
 * `page_cache` HIT (1 ms, 1 statement), `['page']` a `dynamic_page_cache` HIT (8-15 ms, 5
 * statements), `['page','dynamic_page_cache']` a real render.
 */
export function drupalRequest(
	path = '/',
	repeat = 1,
	bins: string[] = ['page', 'dynamic_page_cache'],
	resetCid = true
): string {
	const safePath = JSON.stringify(String(path));
	const safeRepeat = Number.isInteger(repeat) && repeat > 0 ? repeat : 1;
	const safeBins = JSON.stringify(
		(Array.isArray(bins) ? bins : []).filter((b) => /^[a-z_]+$/.test(b))
	);
	return phpRender(DRUPAL_REQUEST_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		PW_SERVE_INLINE,
		PATH: JSON.stringify(safePath),
		REPEAT: String(safeRepeat),
		BINS: JSON.stringify(safeBins),
		RESET_CID: resetCid ? 'true' : 'false'
	});
}

/** the request-shaped inputs of {@link renderPage}; every field is optional */
export interface RenderRequest {
	/**
	 * The `scheme://host[:port]` Drupal renders absolute URLs against.
	 *
	 * Empty falls back to Symfony's `http://localhost`. It is a property of the site, so a forged
	 * `Host` cannot move it.
	 */
	origin?: string;
	/** HTTP method; anything other than GET makes this a submission */
	method?: string;
	/** the raw request body, forwarded verbatim */
	body?: string;
	/**
	 * The body as base64, for one that is not UTF-8; wins over `body`.
	 *
	 * The body rides in the PHP source as a JSON string, which cannot carry arbitrary bytes.
	 */
	bodyBase64?: string;
	/** the inbound content type, which decides whether the body is parsed as a form */
	contentType?: string;
	/**
	 * The raw `Cookie` header, which is what makes a request authenticated.
	 *
	 * Without it every render is uid 0 and a create-entity route is refused at routing.
	 */
	cookie?: string;
	/**
	 * The visitor's address, from `CF-Connecting-IP`.
	 *
	 * Flood control keys on `getClientIp()`; without this every visitor shares one
	 * `user.failed_login_ip` bucket (limit 50 per 3600 s). Cloudflare overwrites the header at the
	 * edge; under `wrangler dev` it is whatever the client sent.
	 */
	clientIp?: string;
	/**
	 * The raw `Accept` header, which decides the shape of every AJAX response.
	 *
	 * `AjaxResponseSubscriber` wraps the JSON in a `<textarea>` when `Accept` contains `text/html`,
	 * and `Request::create()` defaults to exactly that, so an absent header breaks every AJAX call.
	 */
	accept?: string;
}

/** a request body as the render takes it: text when it is UTF-8, base64 when it is not */
export function requestBody(bytes: Uint8Array): { body: string } | { bodyBase64: string } {
	try {
		return { body: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) };
	} catch {
		return { bodyBase64: bytesToBase64(bytes) };
	}
}

const FILE_PART = new TextEncoder().encode('filename="');

/**
 * Whether a multipart body carries a chosen file.
 *
 * `file_save_upload()` keeps a function static per field name that nothing can reset, so the next
 * upload would get the previous file (possibly another user's). The object drops the interpreter
 * after such a request; a false positive costs one boot.
 */
export function carriesUpload(contentType: string, bytes: Uint8Array): boolean {
	if (!/multipart\/form-data/i.test(contentType)) return false;
	for (
		let at = bytes.indexOf(FILE_PART[0]!);
		at >= 0;
		at = bytes.indexOf(FILE_PART[0]!, at + 1)
	) {
		if (
			FILE_PART.every((b, i) => bytes[at + i] === b) &&
			bytes[at + FILE_PART.length] !== 0x22
		) {
			return true;
		}
	}
	return false;
}

/** the PHP expression that yields a request body, byte for byte */
export function phpBodyExpression(request: Pick<RenderRequest, 'body' | 'bodyBase64'>): string {
	if (request.bodyBase64 !== undefined) {
		return `base64_decode(json_decode(${JSON.stringify(JSON.stringify(request.bodyBase64))}))`;
	}
	return `json_decode(${JSON.stringify(JSON.stringify(String(request.body ?? '')))})`;
}

/**
 * Renders one path and hands the HTML back, for the alarm to store.
 *
 * `bins` names the caches emptied first: `['page']` alone leaves `dynamic_page_cache` warm, so the
 * page is reassembled rather than rendered (4.3x cheaper), and a caller must choose which it wants.
 *
 * `destruct` defaults to false, measured: destructing the five safe services costs 17 host
 * statements against 15 for the same 15 rows, because the persistent interpreter already holds
 * the collectors in memory. Pass `true` on a write path (`router.builder` rebuilds need it); a
 * string is an allowlist of service ids to bisect with.
 */
export function renderPage(
	path = '/',
	bins: string[] = ['page', 'dynamic_page_cache'],
	destruct: boolean | string = false,
	request: RenderRequest = {}
): string {
	const safePath = JSON.stringify(String(path));
	const safeBins = JSON.stringify(
		(Array.isArray(bins) ? bins : []).filter((b) => /^[a-z_]+$/.test(b))
	);
	// true | false | an allowlist of service ids to bisect with
	const safeDestruct =
		typeof destruct === 'string'
			? JSON.stringify(
					destruct
						.split(',')
						.filter((id: string) => /^[a-z_][a-z0-9_.]*$/.test(id))
						.join(',')
				)
			: destruct
				? 'true'
				: 'false';
	// request fields are JSON-encoded, never interpolated (a quote would close the PHP literal)
	const method = String(request.method ?? 'GET').toUpperCase();
	const origin = String(request.origin ?? '');
	// a plain anonymous GET emits no extra arguments
	const clientIp = String(request.clientIp ?? '');
	const accept = String(request.accept ?? '');
	const requestArgs =
		method === 'GET' &&
		!request.body &&
		request.bodyBase64 === undefined &&
		!request.cookie &&
		origin === '' &&
		clientIp === '' &&
		accept === ''
			? ''
			: `, json_decode(${JSON.stringify(JSON.stringify(method))})` +
				`, ${phpBodyExpression(request)}` +
				`, json_decode(${JSON.stringify(JSON.stringify(String(request.contentType ?? '')))})` +
				`, json_decode(${JSON.stringify(JSON.stringify(String(request.cookie ?? '')))})` +
				`, json_decode(${JSON.stringify(JSON.stringify(origin))})` +
				`, json_decode(${JSON.stringify(JSON.stringify(clientIp))})` +
				`, json_decode(${JSON.stringify(JSON.stringify(accept))})`;

	return phpRender(RENDER_PAGE_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		PW_SERVE_INLINE,
		PATH: JSON.stringify(safePath),
		ORIGIN: JSON.stringify(JSON.stringify(origin)),
		BINS: JSON.stringify(safeBins),
		SERVE_ARGS: `${safeDestruct}${requestArgs}`
	});
}

/**
 * Invalidates cache tags through Drupal's own service, nothing else.
 *
 * It exercises the edge cache's invalidation seam without a node save: `DatabaseCacheTagsChecksum`
 * writes `cachetags`, the write crosses `execSql()`, and the object bumps its generation.
 */
export function invalidateTags(tags: string[] = ['rendered']): string {
	const safe = JSON.stringify(
		(Array.isArray(tags) ? tags : []).filter((t) => /^[A-Za-z0-9_:.-]+$/.test(t))
	);
	return phpRender(INVALIDATE_TAGS_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		TAGS: JSON.stringify(safe)
	});
}

/**
 * The driver's own assertions, run against ctx.storage.sql.
 *
 * The same shapes `tests/run-driver-suite.php` runs against a PDO host, here against the real one.
 * It boots no kernel, so a failure points at the driver rather than Drupal's container.
 */
export const DRIVER_LIVE_SUITE = phpRender(DRIVER_LIVE_SUITE_PHP, { HOST_HELPERS });

/**
 * Dumps ctx.storage.sql back out as portable SQL.
 *
 * The inverse of `MIGRATE_DB`, read through the driver's own bridge. It emits one statement per
 * line so the caller can stream chunks. `NOCASE` stays as-is; `NOCASE_UTF8` would only restore onto
 * a driver with user-defined collations.
 */
export function exportDatabase(limitPerTable = 0): string {
	const cap = Number.isInteger(limitPerTable) && limitPerTable > 0 ? limitPerTable : 0;
	return phpRender(EXPORT_DATABASE_PHP, { HOST_HELPERS, CAP: String(cap) });
}

/**
 * Creates every table a write path needs and the pack lacks (sessions, flood, ...).
 *
 * The pack is built by browsing anonymously, so no write-only table exists in it. Expects `$db`,
 * `$out` and a booted kernel in scope; writes `$out['schemaRepair']`.
 *
 * It calls `<module>_schema()` directly (via `loadAllIncludes()`) because
 * `ModuleHandler::invoke($module, 'schema')` returns nothing on Drupal 11. It runs outside any
 * transaction: DDL dirties `sqlite_master` and would turn later reads into speculative replays.
 */
const SCHEMA_REPAIR = SCHEMA_REPAIR_PHP;

/**
 * Fixes the two places the shipped pack disagrees with itself, both flagged by the status page.
 *
 * The driver module is missing from `core.extension` (`system_requirements()` checks
 * `moduleExists()`), so it is enabled through the module installer, which rebuilds the container
 * and router. `node.body` is missing from `entity.definitions.installed`, which blocks later field
 * changes; the fix is a metadata write.
 */
const PACK_CONSISTENCY = PACK_CONSISTENCY_PHP;

/** the kernel boot a claim needs, shared by its two invocations */
const CLAIM_BOOT = CLAIM_BOOT_PHP;

/**
 * The half of a claim that needs no claim data: the schema repair and the pack consistency install.
 *
 * It runs as its own invocation before the claim: the CPU limit is per invocation and a killed one
 * rolls back every write (Thunder's claim died at 32 s of CPU on each attempt). Both halves are
 * idempotent, so the claim repeats them as no-ops.
 */
export function packConsistencyRun(): string {
	return phpRender(PACK_CONSISTENCY_RUN_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		CLAIM_BOOT,
		SCHEMA_REPAIR,
		PACK_CONSISTENCY
	});
}

/**
 * The claim's first invocation: fills the discovery caches the install reads, and installs nothing.
 *
 * On Thunder the consistency install alone took 32.5 s of CPU cold and 7.1 s with these caches
 * filled; they persist in the site's tables whatever happens to the interpreter.
 */
export function claimWarmRun(): string {
	return phpRender(CLAIM_WARM_RUN_PHP, { FIBER_SHIM, HOST_HELPERS, CLAIM_BOOT });
}

/** the site identity and uid-1 account a first run establishes */
export type FirstRunOptions = {
	siteName?: string;
	siteMail?: string;
	adminName?: string;
	adminMail?: string;
	adminPass?: string;
	timezone?: string;
	/**
	 * Unix seconds to stamp on uid 1's `created`, or omitted to leave it alone.
	 *
	 * The pack's uid 1 carries the bake date. It is passed in because `time()` in wasm is the
	 * host's frozen `Date.now()`; omit it on a `force=1` reconfigure, where the account is not new.
	 */
	claimedAt?: number;
	/** claim a site that already has an administrator and a site identity, changing neither */
	migrated?: boolean;
};

/** a node to create on the write path, which is the path renders never exercise */
export type SaveNodeOptions = {
	type?: string;
	title?: string;
	body?: string;
};

/**
 * First-run configuration, against the already-migrated database.
 *
 * Every site boots from the same pack (same name, admin account, hash salt). This edits the four
 * things that differ per site through Drupal's own APIs, so caches invalidate; Drupal's installer
 * is far heavier (1,052 ms, 72.5 MB natively) and redoes what the pack holds.
 */
export function firstRunConfig(options: FirstRunOptions = {}): string {
	const payload = JSON.stringify({
		siteName: typeof options.siteName === 'string' ? options.siteName : null,
		siteMail: typeof options.siteMail === 'string' ? options.siteMail : null,
		adminName: typeof options.adminName === 'string' ? options.adminName : null,
		adminMail: typeof options.adminMail === 'string' ? options.adminMail : null,
		adminPass: typeof options.adminPass === 'string' ? options.adminPass : null,
		timezone: typeof options.timezone === 'string' ? options.timezone : null,
		claimedAt:
			typeof options.claimedAt === 'number' && Number.isFinite(options.claimedAt)
				? Math.floor(options.claimedAt)
				: null,
		migrated: options.migrated === true
	});
	return phpRender(FIRST_RUN_CONFIG_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		PAYLOAD: JSON.stringify(payload),
		CLAIM_BOOT,
		SCHEMA_REPAIR,
		PACK_CONSISTENCY
	});
}

/**
 * Saves one node and then re-renders (the write-refresh loop).
 *
 * A content save crosses the transaction replay (one transaction with reads of its own writes) and
 * the 2^53 write guard. The type is discovered, since a minimal pack ships neither `article` nor
 * `page`. `promote` is set so the front page changes.
 */
export function saveNode(options: SaveNodeOptions = {}): string {
	const payload = JSON.stringify({
		title: typeof options.title === 'string' ? options.title : null,
		type: typeof options.type === 'string' ? options.type : null,
		body: typeof options.body === 'string' ? options.body : null
	});
	return phpRender(SAVE_NODE_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		PW_SERVE_INLINE,
		PAYLOAD: JSON.stringify(payload),
		SCHEMA_REPAIR
	});
}

/**
 * Executes the `drupflare` capability plugin classes against the host contract.
 *
 * The module is not enabled (that is the installer path), so its namespace is registered in
 * settings.php and the classes are driven directly: this covers the classes and the host reply
 * shape, not `hook_install` or container wiring. Negative cases are included (an uncached URL must
 * fail, mail with no binding must return false).
 */
export const CAPABILITY_CHECK = phpRender(CAPABILITY_CHECK_PHP, { FIBER_SHIM, HOST_HELPERS });

/**
 * Checks that `Drupal::httpClient()` returns a body on the shipping binary.
 *
 * Core's `StreamHandler` fails here: `createStream()` reads `$http_response_header`, a magic local
 * only PHP's own http wrapper sets, so every call rejects. The fragment drives core's handler over
 * the same wrapper and cached row as a control and requires it to still fail. The caller seeds
 * `cfw_http_cache`, so nothing touches the network.
 */
export const GUZZLE_HANDLER_CHECK = phpRender(GUZZLE_HANDLER_CHECK_PHP, {
	FIBER_SHIM,
	HOST_HELPERS
});

/**
 * Reports which of four walls rejects a form submission, with the value Drupal saw at each.
 *
 * It builds the request the way `cfw_serve()` does, duplicated on purpose (`cfw_serve()` returns
 * only a Response); keep the two in step or the probe measures something the serve path does not.
 */
export function submissionProbe(options: {
	path?: string;
	method?: string;
	body?: string;
	contentType?: string;
}): string {
	const safe = JSON.stringify(
		JSON.stringify({
			path: options.path ?? '/node/add/page',
			method: (options.method ?? 'POST').toUpperCase(),
			body: options.body ?? '',
			contentType: options.contentType ?? 'application/x-www-form-urlencoded'
		})
	);
	return phpRender(SUBMISSION_PROBE_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		PW_SERVE_INLINE,
		OPTIONS: safe
	});
}

/**
 * Reads everything that must not survive a request boundary, without running a request.
 *
 * The named half reports the carriers a leak was found in (plus ones core suggests); the blind half
 * fingerprints every static property of every declared class, so unknown carriers show as a diff.
 *
 * It is read-only: no service is instantiated that the request did not already build (asking the
 * container would create the state being looked for). The output buffer is the exception and is
 * cleared, since an unclosed one would swallow the report.
 */
export const BOUNDARY_STATE = phpRender(BOUNDARY_STATE_PHP, { FIBER_SHIM, HOST_HELPERS });

/**
 * Leaves output buffers open the way a handler that forgot its `ob_end_clean()` would.
 *
 * A real SAPI pops every level at request shutdown; if the stack survives a `_run()` boundary,
 * every later response goes into a buffer nobody closes. The report is echoed before the buffers
 * open so the fragment can still answer.
 *
 * @param {number} depth how many levels to leave open
 */
export function leakOutputBuffer(depth = 2): string {
	const levels = Math.max(1, Math.min(8, Math.trunc(depth)));
	return phpRender(LEAK_OUTPUT_BUFFER_PHP, { LEVELS: String(levels) });
}

/**
 * Leaves the session manager open the way a request that never reached `save()` would.
 *
 * A `BigPipeResponse` keeps the session open and closes it in `sendContent()`; if that throws, the
 * request ends with `started` true and `closed` false. The next `SessionManager::start()` then
 * returns early, `loadSession()` (the only code that re-binds the session bags) never runs, and the
 * flash bag still references the previous visitor's array.
 *
 * No ordinary request reaches this state on this runtime (measured), so a probe is the only way to
 * exercise the reset.
 *
 * @returns the flags it set and the flash bag it left behind, so a vacuous run is visible
 */
export const LEAK_OPEN_SESSION = phpScript(LEAK_OPEN_SESSION_PHP);

/**
 * Leaves a Drupal transaction open the way a halted request would, so the next one can be asked.
 *
 * `cfw_do_sqlite` buffers writes while a transaction is open, on a Connection that lives as long as
 * the interpreter; the probe asks whether the next request buffers into a transaction nobody owns.
 *
 * `scope` drops the last reference at script end (a real SAPI would roll back); `global` parks the
 * object where nothing collects it, as a host-level throw does (a JavaScript exception is not a
 * `Throwable`, so no PHP handler sees it).
 *
 * @param {'scope'|'global'} mode which reference the abandoned transaction keeps
 */
export function abandonTransaction(mode: 'scope' | 'global' = 'scope'): string {
	const safeMode = mode === 'global' ? 'global' : 'scope';
	return phpRender(ABANDON_TRANSACTION_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		MODE: JSON.stringify(JSON.stringify(safeMode))
	});
}

/**
 * Turns on `locale.settings.translate_english`, so `locale` translates on an English site.
 *
 * Without it `LocaleTranslation::getStringTranslation()` returns false for `en` and no
 * `LocaleLookup` is built. `loadAll()` must run first: `LocaleConfigSubscriber` calls
 * `locale_is_translatable()` from `locale.module`, which a bare boot has not loaded, so the save
 * would write the value and then die.
 */
export const TRANSLATE_ENGLISH = phpRender(TRANSLATE_ENGLISH_PHP, { FIBER_SHIM, HOST_HELPERS });

/**
 * An arbitrary Drupal operation, with the kernel booted and `$out` printed as JSON.
 *
 * A hand-rolled boot with a wrong bootstrap path throws before any Drupal code runs, and a test
 * asserting "no effect" then passes for the wrong reason. `$out` is always echoed and a throw lands
 * in `$out['error']`, so "ran and did nothing" differs from "never ran".
 *
 * @param body
 *   PHP to run with the kernel up. Assign into `$out` to report anything back.
 */
export function drupalOp(body: string): string {
	return phpRender(DRUPAL_OP_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		SCHEMA_REPAIR,
		BODY: body
	});
}

/**
 * Creates one authenticated user with a known password, so a sequence can change identity.
 *
 * The pack ships one account, which cannot show a cross-user leak. It goes through the entity API
 * so the password hasher, presave hooks and role reference run (a hand-built row authenticates
 * against nothing).
 */
export function createUser(options: { name: string; pass: string; roles?: string[] }): string {
	const payload = JSON.stringify({
		name: String(options.name),
		pass: String(options.pass),
		roles: (Array.isArray(options.roles) ? options.roles : []).filter((r) =>
			/^[a-z0-9_]+$/.test(r)
		)
	});
	return phpRender(CREATE_USER_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		PAYLOAD: JSON.stringify(payload),
		SCHEMA_REPAIR
	});
}

/**
 * The write workloads the regeneration ceiling is not computed from.
 *
 * The `txn-` cases are not Drupal operations: one buffered insert whose id is read back, over two
 * tables identical except for `AUTOINCREMENT`.
 */
export const WRITE_WORKLOADS = [
	'node-create',
	'node-revision',
	'user-create',
	'file-create',
	'alias-create',
	'txn-autoinc',
	'txn-rowid'
] as const;

/** one name from {@link WRITE_WORKLOADS} */
export type WriteWorkload = (typeof WRITE_WORKLOADS)[number];

/** the inputs of {@link writeWorkload} */
export interface WriteWorkloadOptions {
	/** distinguishes one run from the next, so a repeat is a fresh insert rather than an update */
	seq: number;
	/** the node `node-revision` revises and `alias-create` points at */
	nid?: number;
}

/**
 * One entity write and nothing else, so the host's tally prices the operation.
 *
 * It uses the entity API, not a form (a form also writes `sessions`, the form cache and flood
 * control; `write-amplification.spec.ts` prices that wrapper separately). `SCHEMA_REPAIR` runs at
 * most once per interpreter so the first operation is not charged for DDL. The acting user is
 * switched to uid 1 and restored in `finally`; an unrestored switch would cache admin HTML as
 * anonymous.
 */
export function writeWorkload(op: WriteWorkload, options: WriteWorkloadOptions): string {
	const payload = JSON.stringify({
		op,
		seq: Math.max(0, Math.trunc(Number(options.seq) || 0)),
		nid: Math.max(0, Math.trunc(Number(options.nid) || 0))
	});
	return phpRender(WRITE_WORKLOAD_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		PAYLOAD: JSON.stringify(payload),
		SCHEMA_REPAIR
	});
}

/** what a shell harvest and a fragment fill both take */
export type ShellRequest = {
	/** the session cookie header the render runs under; empty renders anonymously */
	cookie?: string;
	/** `scheme://host[:port]`, threaded so absolute URLs are not built against localhost */
	origin?: string;
};

/**
 * Harvests a shareable shell and the recipes that fill its holes.
 *
 * Harvests a shareable shell and the recipes that fill its holes.
 *
 * Core never decodes a placeholder id back into a render array (`BigPipe::sendPlaceholders()` reads
 * the `big_pipe_placeholders` attachment), so recipes are captured here and replayed later. A
 * fill therefore never accepts a render array from a visitor, so `#lazy_builder` cannot name a
 * visitor-chosen callback.
 *
 * Both bins are emptied; `render` is the one that matters, since it gates the holes (with only
 * `dynamic_page_cache` emptied every persona comes back holeless).
 */
export function harvestShell(path = '/', request: ShellRequest = {}): string {
	const safePath = JSON.stringify(String(path));
	const cookie = String(request.cookie ?? '');
	const origin = String(request.origin ?? '');

	return phpRender(HARVEST_SHELL_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		PW_SERVE_INLINE,
		PATH: JSON.stringify(safePath),
		COOKIE: JSON.stringify(JSON.stringify(cookie)),
		ORIGIN: JSON.stringify(JSON.stringify(origin))
	});
}

/**
 * Fills a stored shell's holes for ONE session, without rendering the page.
 *
 * It pushes the request, starts the session, authenticates and matches the route, then calls
 * `Renderer::renderPlaceholder()` per recipe; `$kernel->handle()` would also render the page.
 * The route match is required: breadcrumbs, local tasks and the menu trail read
 * `current_route_match` and would otherwise render for the last matched route.
 *
 * @param recipes - the `big_pipe_placeholders` map `harvestShell()` captured; never from a visitor
 */
export function renderFragments(
	path = '/',
	recipes: Record<string, unknown> = {},
	request: ShellRequest = {}
): string {
	const safePath = JSON.stringify(String(path));
	const cookie = String(request.cookie ?? '');
	const origin = String(request.origin ?? '');
	const safeRecipes = JSON.stringify(JSON.stringify(recipes ?? {}));

	return phpRender(RENDER_FRAGMENTS_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		PW_SERVE_INLINE,
		PATH: JSON.stringify(safePath),
		COOKIE: JSON.stringify(JSON.stringify(cookie)),
		ORIGIN: JSON.stringify(JSON.stringify(origin)),
		RECIPES: safeRecipes
	});
}

/**
 * Counts the files and bytes under one in-memory filesystem directory.
 *
 * The opcache A/B needs write volume per arm (1,301 `.bin` files across 425 directories after one
 * render on the edge). A count is honest from any lane, unlike a millisecond.
 */
export function memfsCensus(root = '/tmp'): string {
	const safeRoot = JSON.stringify(String(root).replace(/[^A-Za-z0-9_/.-]/g, ''));

	return phpRender(MEMFS_CENSUS_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		ROOT: JSON.stringify(safeRoot)
	});
}

/**
 * Runs every capability vector in one interpreter and reports what each answered.
 *
 * One boot serves the whole matrix. Each probe is wrapped so a throw answers `false` (probes
 * reference symbols that may not exist).
 *
 * @param probes - `id` to a PHP expression evaluating to a boolean
 */
export function capabilityVectors(probes: Record<string, string> = {}): string {
	const cases = Object.entries(probes)
		.filter(([id]) => /^[a-z][a-z0-9_.]*$/.test(id))
		.map(
			([id, expr]) =>
				// records why a probe answered false (absent capability or a throw)
				`  $out[${JSON.stringify(id)}] = (function () use (&$why) { try { return (bool) (${expr}); } ` +
				`catch (Throwable $e) { $why[${JSON.stringify(id)}] = get_class($e) . ': ' . $e->getMessage(); return false; } })();`
		)
		.join('\n');

	return phpRender(CAPABILITY_VECTORS_PHP, {
		FIBER_SHIM,
		HOST_HELPERS,
		CASES: cases
	});
}
