import '@drupflare/cartridge/shim';
import type { SiteEnv } from './env';
import { attemptBudget, deferredKey, isFresh, ttlFor } from './ops/deferred-post.js';
import { FIRST_RUN_KEY, needsSetup, setupResponse } from './ops/setup-page.js';
import { warmingResponse } from './ops/warming-page.js';

import {
	mountDriver,
	mountDrupalLazy,
	mountDrupalStreaming,
	type DriverMountResult,
	type LazyBinary,
	type LazyFS,
	type LazyMountResult,
	type MountResult
} from '@drupflare/cartridge/fs';
import { withMask } from '@drupflare/cartridge/mask';
import { PHP_CODEC, decode, encode } from '@drupflare/durabledb/codec';
import {
	SiteDurableObject,
	type ExecSqlResult,
	type SqlBindings
} from '@drupflare/durabledb/do-sqlite';
import { PhpBase, type PhpBaseModuleFactory, type PhpRuntimeArgs } from 'php-wasm/PhpBase';
import {
	DO_MAX_RECORD_BYTES,
	DO_MAX_STATEMENT_CHARS,
	DUMP_START,
	dumpChunk,
	dumpDatabase,
	type DumpCursor
} from './db/export-sql';
import {
	base64ToBytes,
	bytesToBase64,
	deleteFile,
	drainMirrors,
	getFile,
	getFileChunk,
	listFiles,
	pendingMirrors,
	putFile,
	renameFile,
	statFile,
	type MirrorBucket
} from './db/file-store';
import {
	HeapChunkDigestError,
	captureHandles,
	captureStreams,
	ensureHeapTables,
	gcHeapSnapshots,
	latestSnapshotMeta,
	replayHandles,
	replayStreams,
	snapshotPageIndex,
	streamRestoreInto,
	toStorableBytes,
	writeHeapSnapshot,
	type HandleIndex,
	type StreamFS
} from './db/heap-store';
import { latestImport, storeImport, storedImportLoader } from './db/import-sql';
import {
	SqlMigrator,
	assetChunkLoader,
	chunksPerInvocation,
	ensureMigrateTable,
	readMigrateCursor,
	type MigrateCursor
} from './db/migrate-sql';
import {
	amplification,
	countingSql,
	emptyTally,
	overheadShare,
	rankTally,
	routerRebuilds,
	type WriteTally
} from './db/write-tally';
import { ENABLE_MODULE, ENABLE_VERIFY } from './drupal/enable-php';
import { FILES_PROBE } from './drupal/files-php';
import { ICONV_FIX } from './drupal/iconv-fix';
import { MB_FIX } from './drupal/mb-fix';
import {
	BOOT_KERNEL,
	BOOT_PHASES,
	CAPABILITY_CHECK,
	DRIVER_LIVE_SUITE,
	MB_CHECK,
	MIGRATE_DB,
	OPS_REGISTRY,
	PROBE_RUNTIME,
	bootPhaseFragment,
	drupalRequest,
	firstRunConfig,
	invalidateTags,
	renderPage,
	saveNode,
	type BootPhase,
	type RenderRequest
} from './drupal/site-php';
import { ZLIB_FIX, installZlib } from './drupal/zlib-fix';
import {
	DAILY_DO_QUOTA,
	DAILY_ROWS_QUOTA,
	authAllowance,
	authSpendHeaders,
	hasSessionCookie,
	secondsUntilUtcReset,
	spendForToday,
	type AuthSpend
} from './ops/auth-budget';
import {
	authorizeUrl,
	callbackUrl,
	createPkce,
	exchangeCode,
	isTokenError,
	pendingMatches,
	randomToken,
	resolveAccountId,
	revoke,
	type PendingAuth,
	type TokenSet
} from './ops/cf-oauth';
import {
	CORE_VERSION_KEY,
	invalidateVersionPinnedCaches,
	type InvalidationResult
} from './ops/core-version';
import { cronOptions, gcPass, writeCursor } from './ops/cron';
import {
	cronBudget,
	cronDue,
	cronIntervalMs,
	driveCron,
	drupalCronEnabled
} from './ops/cron-drive';
import {
	crossingsSince,
	emptyCrossings,
	snapshotCrossings,
	wrapCrossings,
	type CrossingTally
} from './ops/crossings';
import { dailyLimit, degradation, readOnlyResponse, type Degradation } from './ops/degrade';
import {
	ensureFleetTable,
	reportSite,
	shouldReport,
	type FleetDb,
	type FleetRow
} from './ops/fleet';
import { phpLogCeiling, phpLogPasses } from './ops/log-level';
import {
	drainMailQueue,
	mailDrainEnabled,
	mailDrainLimit,
	queueMail,
	resolveMailTransport
} from './ops/mail';
import {
	applyDnsPlan,
	createSendingSubdomain,
	dnsPlan,
	isVerified,
	listDestinations,
	listSendingSubdomains,
	onboardState,
	requiredDns,
	zoneRecords,
	type RecordAction
} from './ops/mail-onboard';
import { resolveInstallable } from './ops/oracle';
import { drainPageMirrors, queuePageMirror } from './ops/page-mirror';
import { KV_OVERRIDABLE, isFree, isPaid, planFlag, resolveSettings, type PlanKv } from './ops/plan';
import { planProfile, resolvePlanNumber } from './ops/plan-profile';
import {
	isQuarantined,
	parseState,
	recordOutcome,
	release,
	serialiseState,
	shouldRollback
} from './ops/repair';
import { shellSafety } from './ops/shell-assembly';
import { SHIPPED_CORE_VERSION, SHIPPED_LOCK_VERSIONS } from './ops/shipped-lock';
import { ORIGIN_KEY, chooseOrigin, pinnable } from './ops/site-origin';
import {
	OWNER_TOKEN_KEY,
	bearerToken,
	ensureHashSalt,
	ensureOwnerToken,
	hashSaltAssignment,
	randomKeyBase64,
	tokenMatches,
	type SecretStore
} from './ops/site-secrets';
import {
	RingBuffer,
	SEVERITY,
	ensureHealthTable,
	gcHealthLedger,
	quarantineDecision,
	recordFinding,
	runHostTripwires,
	type Finding,
	type Observation
} from './ops/supervisor';
import { projectImageTransforms } from './ops/thresholds';
import {
	ensureUpdbTables,
	readRun as readUpdbRun,
	updbAlarmDelayMs,
	updbOptions,
	updbStep,
	type UpdbDeps
} from './ops/updb';

// held in cfw_meta rather than KV: an operator-writable client id is a phishing surface, see
// the docblock in ops/cf-oauth.ts
const CF_OAUTH_CLIENT_ID_KEY = 'cf_oauth_client_id';
const CF_OAUTH_PENDING_KEY = 'cf_oauth_pending';
const CF_OAUTH_TOKEN_KEY = 'cf_oauth_token';
const CF_OAUTH_ACCOUNT_KEY = 'cf_oauth_account';
const MAIL_ZONE_KEY = 'mail_sending_zone';
// the `.js` is load-bearing: wrangler.jsonc aliases the specifier `./runtime/php-binary.js`, and
// without it esbuild resolves the default seam and bundles an 11 MB probe build over the ceiling
import { PHPFactory, wasmModule } from './runtime/php-binary.js';

/**
 * The `x-cfw-*` header contract version.
 *
 * Bumped when a header is RENAMED or REMOVED, not when one is added: a reader that knows version 1
 * can ignore fields it does not recognise, but it cannot tell a rename from an absent worker
 * without this.
 */
export const CFW_HEADER_VERSION = '1';

/**
 * Render-size history bounds for {@link SitePhpDurableObject.medianRenderBytes}.
 *
 * Three samples minimum because a median of one IS that sample, so a two-sample baseline would
 * call the second render of every path an anomaly.
 */
const RENDER_BYTES_SAMPLES = 8;
const RENDER_BYTES_MIN_SAMPLES = 3;
const RENDER_BYTES_PATHS = 200;

/**
 * How many paths may wait for a fill.
 *
 * A MISS on any distinct path queued one, with nothing bounding the table -- so an anonymous visitor
 * asking for `/a1`, `/a2`, ... grew it forever, and the chain rendered every one at ~13 rows against
 * the daily allowance. The cap is generous next to a real site's cold set and small next to the
 * quota: past it a MISS is still answered, it just is not promised a fill.
 */
const FILL_QUEUE_MAX = 500;

/** the `cfw_meta` key holding which site this object is; see {@link SitePhpDurableObject.siteName} */
const SITE_NAME_KEY = 'site_name';

/** the two globals `src/runtime/worker-shim.ts` installs; it reaches them through the same cast */
const shimGlobals = globalThis as unknown as {
	Asyncify?: { __cfwStub?: boolean };
	__cfwAsyncifyCalls?: number;
};

/**
 * A parsed-JSON payload: a PHP fragment's reply, a migrator step, a GC ledger, an updb beat.
 *
 * `any` values rather than `unknown`, with the trade named: each of these crosses a PHP or SQL
 * boundary as arbitrary JSON whose shape depends on which fragment ran, several call sites ADD
 * fields to one after the fact (`out.continuation`, `result.prefilled`), and `unknown` would turn
 * roughly forty guarded reads into casts without making one of them safer.
 */
type Payload = Record<string, any>;

/** where a chunked heap restore has got to, for the LIVE heap only; see the field's own note */
export type HeapRestoreCursor = {
	snapshotId: number;
	nextChunk: number;
	totalChunks: number;
	bytesWritten: number;
	firings: number;
};

/**
 * Thrown while a chunked restore is still in flight, so no caller can execute PHP through a heap
 * that is the right length and the wrong bytes.
 *
 * A named error rather than a boolean return because `ensurePhp()` has roughly a dozen call sites
 * and a flag only works if every one of them remembers to read it. `LAZY_MOUNT` spent its entire
 * life as unreachable code behind exactly that kind of unchecked condition.
 */
export class HeapRestoreIncomplete extends Error {
	readonly cursor: HeapRestoreCursor;
	constructor(cursor: HeapRestoreCursor) {
		super(
			`heap restore incomplete: ${cursor.nextChunk}/${cursor.totalChunks} chunks applied ` +
				`over ${cursor.firings} firing(s); this object cannot execute PHP yet`
		);
		this.name = 'HeapRestoreIncomplete';
		this.cursor = cursor;
	}
}

/**
 * How many chunks one invocation may apply, or `undefined` for all of them in one go.
 *
 * Unset is the whole snapshot at once, which is what every recorded restore measurement was taken
 * on (memcpy 14-18 ms for 22.4 MB). The budget exists because a 10 ms free-plan invocation cannot
 * be assumed to hold an arbitrary image: at 2 MiB a chunk, `HEAP_RESTORE_CHUNKS=2` is roughly 4 MB
 * of memcpy per firing.
 */
export function heapRestoreChunkBudget(env?: SiteEnv | null): number | undefined {
	const raw = Number(env?.HEAP_RESTORE_CHUNKS ?? 0);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

/**
 * Whether a boot restores a stored heap instead of booting the kernel. ON, with `HEAP_SNAPSHOT=0`
 * to turn it off.
 *
 * It shipped opt-in with a precondition written into `ensurePhp()`: the standalone restore probe ran
 * in one process with no Durable Object and no vrzno bridge in the image, so "until a host call is
 * shown to round-trip through a restored heap, this must not be on by default." That precondition is
 * now met -- `/heap?op=bridge` forces PHP to reach `cfwStats` through `vrzno_env()` on a restored
 * image and it round-trips with 3 handles replayed and the digest equal, and an install then runs on
 * that kernel and lands.
 *
 * Priced before flipping it, because the storage is not free: **31,784,960 bytes across 159 rows per
 * site**, plus a 5,993 ms one-off to take the snapshot. What it buys is **2,310 ms (fast mode) to
 * 3,578 ms (slow mode)** off every install, n=8 per arm, present in BOTH modes of a bimodal
 * population -- which is what makes it a result rather than an artefact of which mode was sampled.
 */
export function heapSnapshotEnabled(env?: SiteEnv | null): boolean {
	return env?.HEAP_SNAPSHOT !== '0';
}

/**
 * What an alarm lane actually achieved, as opposed to what it returned.
 *
 * This type exists because the same bug happened three times. Migration re-armed at +1 ms on a step
 * that ERRORED, because an error return is non-null too. The fill head re-armed at +1 ms on a render
 * that THREW, producing **196 firings in 14 seconds, every one reporting `outcome: ok`**. Both were
 * fixed case by case, and both had the same shape: a non-null return read as work done.
 *
 * The re-arm delay is now a function of this classification and of nothing else, so the fast path
 * cannot be reached without something having first said the work progressed. Queue depth is no longer
 * sufficient -- it was what made the third instance possible, since a row that failed to be struck
 * kept the queue non-empty and the chain fast forever.
 */
export type AlarmClass = 'progress' | 'transient' | 'idle' | 'failure';

/**
 * Which existing driver can actually run each sliced operation.
 *
 * Named in the refusal rather than left to the caller, because a 501 with no alternative is a 501
 * that gets retried. `null` where nothing exists yet: `cim`, `cex` and `sql-dump` are
 * declared with measured costs and have no sliced driver, and saying so beats implying a route.
 */
const OPS_DRIVERS: Record<string, string | null> = {
	cr: 'the 11 UPDB_FLUSH_STEPS units, driven by the updb alarm chain (/updb)',
	updb: '/updb -- already sliced at 28 units / 56 beats for a 1-update release',
	en: 'Cloudflare Workflows, 25,000 separately-budgeted steps (1,344.7 ms native, 78.5 MB peak)',
	pmu: 'the same Workflow path as `en`; 666-945 ms per module measured natively',
	'sql-dump': '/export, which streams the database as replayable SQL',
	cex: null,
	cim: null
};

/**
 * The floor on a failure's re-arm delay.
 *
 * A failure must never re-arm fast, whatever else is true. The alarm runs inside the reentrancy gate,
 * so a fast chain of failures does not merely waste invocations -- it starves every queued request
 * behind it and presents as a deadlock.
 */
export const FAILURE_BACKOFF_FLOOR_MS = 1_000;

/**
 * Classifies one lane's outcome, or a batch of them.
 *
 * A batch is as bad as its worst member: one failing page in five means the chain must back off, or
 * the four that worked license a fast retry of the one that did not.
 */
export function classifyAlarmOutcome(
	outcome: Payload | Array<Payload | null> | null | undefined
): AlarmClass {
	if (Array.isArray(outcome)) {
		const classes = outcome.map((o) => classifyAlarmOutcome(o));
		if (classes.includes('failure')) return 'failure';
		if (classes.includes('progress')) return 'progress';
		if (classes.includes('transient')) return 'transient';
		return 'idle';
	}
	if (!outcome) return 'idle';

	// a refusal that owns its own alarm chain and resolves itself; it may re-arm fast BECAUSE
	// something else is driving the progress
	if (outcome.restorePending === true || outcome.transient === true) return 'transient';

	// the three shapes that were each read as success at least once
	if (outcome.ok === false) return 'failure';
	if (outcome.error !== undefined) return 'failure';
	if (outcome.threw === true) return 'failure';
	if (outcome.failed !== undefined && outcome.failed !== null) return 'failure';

	if (outcome.skipped !== undefined) return 'idle';
	// `filled: null` is the lane saying there was nothing to do, which is idle and not progress
	if ('filled' in outcome && outcome.filled === null) return 'idle';
	return 'progress';
}

/**
 * How long until the next firing, derived from the CLASSIFICATION rather than from the payload.
 *
 * `queueNonEmpty` can only make an already-progressing chain fast. It cannot rescue a failure, which
 * is precisely the coupling that produced 196 firings in 14 s: the queue stayed non-empty because the
 * failing row was never struck, and the delay was read off the queue instead of off the outcome.
 */
export function alarmRearmDelayMs(
	cls: AlarmClass,
	opts: { queueNonEmpty?: boolean; idleMs?: number; fastMs?: number; failures?: number } = {}
): number {
	const idleMs = opts.idleMs ?? 240_000;
	const fastMs = opts.fastMs ?? 1;
	switch (cls) {
		case 'failure': {
			// capped exponential, floored so failure 0 still backs off
			const failures = Math.max(0, opts.failures ?? 0);
			return Math.min(60_000, FAILURE_BACKOFF_FLOOR_MS * Math.pow(2, Math.min(failures, 6)));
		}
		case 'transient':
			return fastMs;
		case 'progress':
			return opts.queueNonEmpty === false ? idleMs : fastMs;
		case 'idle':
		default:
			return idleMs;
	}
}

/**
 * What the alarm chain should do after one slice of a chunked restore.
 *
 * Extracted rather than left inline for the reason `migrateAlarmDelayMs` was extracted: the inline
 * version of that decision shipped a branch that could never be taken, and nothing noticed because
 * an inline ternary in `alarm()` has no unit test. This one carries the halt, which is the branch
 * whose absence once spun an object at 1 ms forever and starved every gated request behind it.
 *
 * @param before the cursor position at the start of the firing
 * @param after the cursor after it, or null when the restore finished or was abandoned
 */
export function restoreAlarmDecision(
	before: number,
	after: HeapRestoreCursor | null
): { action: 'continue' | 'unblocked' | 'halt'; delayMs: number } {
	// order matters: a still-open cursor that did not move is a stall, and testing "open" first
	// would re-arm it forever
	if (after && after.nextChunk <= before) return { action: 'halt', delayMs: 0 };
	if (after) return { action: 'continue', delayMs: 1 };
	// the restore closed, so migration/updb/fill are unblocked; give them their own firing rather
	// than sharing this one, since a chunked restore exists precisely because this invocation is
	// assumed not to hold much more work
	return { action: 'unblocked', delayMs: 1 };
}

/**
 * How long to wait before the next migration alarm.
 *
 * Extracted for the same reason `cronAlarmDelayMs` and `updbAlarmDelayMs` exist: this is a
 * three-branch decision that lived inline in `alarm()` as a ternary, and it was the only one of
 * the three alarm chains with no unit test.
 *
 * That is how a real bug survived in it. The ternary read `pending.done`, but the caller hands it
 * `{ migrate: out }`, so `done` was ALWAYS undefined: the idle branch was unreachable, and the
 * firing that COMPLETED a migration re-armed at 1 ms instead of 240 s. Cheap in practice, because
 * the next firing finds the cursor `done`, returns null and falls through to the fill loop -- but
 * the branch was dead and the intent defeated. Taking the step result DIRECTLY rather than the
 * wrapper is what makes that mistake unspellable here.
 *
 * @param out a migrator step result, or the `{ ok: false }` shape the catch path returns
 * @param failures consecutive failures, for the capped backoff
 */
export function migrateAlarmDelayMs(
	out?: { done?: boolean; ok?: boolean } | null,
	failures = 0,
	options: { idleMs?: number; chainMs?: number; maxBackoffMs?: number } = {}
): number {
	// order matters: a step can report done and NOT ok, and a failure must back off rather than
	// go idle for four minutes, so the failure test comes first
	if (out?.ok === false) {
		return Math.min(options.maxBackoffMs ?? 30000, 1000 * Math.min(Math.max(failures, 1), 30));
	}
	if (out?.done) return options.idleMs ?? 240000;
	return options.chainMs ?? 1;
}

/** A result row, with the index signature `exec<T>()` requires alongside the columns named. */
type Row<T> = T & Record<string, SqlStorageValue>;

/** One `cfw_page` row, which is what both serving lanes read and `pageResponse()` renders. */
type PageRow = Row<{
	status: number;
	content_type: string | null;
	html: string;
	rendered_at: number;
	render_ms: number | null;
}>;

/**
 * The php-wasm Module, as this file uses it.
 *
 * php-wasm types `PhpBinaryRuntime.FS` as bare `object`, and every `cfw*` member below is
 * installed by this file rather than declared upstream, so the shape is named here and the one
 * cast happens where `php.binary` resolves.
 */
interface SiteBinary extends LazyBinary {
	FS: LazyFS & { readFile(path: string): Uint8Array };
	[key: string]: unknown;
}

/** The interpreter, its Module and the shared output buffer, once boot has finished. */
interface PhpInstance {
	php: PhpStatic;
	binary: SiteBinary;
	out: string[];
}

/** php-wasm's `output` / `error` events; `detail` is one line or a batch of them. */
type PhpOutputEvent = Event & { detail?: string | string[] };

/** What a mount reported, plus the driver overlay written on top of it. */
type SiteMountInfo = (MountResult | LazyMountResult) & { driver?: DriverMountResult };

/**
 * The JS-SIDE half of what a booted interpreter occupies.
 *
 * MEMFS file contents are typed arrays on the JS heap, so they are invisible to a reading of wasm
 * linear memory -- and the isolate's 128 MB covers both. Reports zeros for the streaming mount,
 * which has no budget and no eviction, rather than pretending the fields exist.
 */
function lazyMountBytes(info: SiteMountInfo | null): {
	blob: number;
	budget: number;
	resident: number;
	highWater: number;
	inflated: number;
	inflatedBytes: number;
	evicted: number;
	reinflated: number;
} {
	const lazy = info !== null && 'blobBytes' in info ? info : null;
	const stats = lazy?.inflateStats;
	return {
		blob: lazy?.blobBytes ?? 0,
		budget: lazy?.budgetBytes ?? 0,
		resident: stats?.residentBytes ?? 0,
		highWater: stats?.highWaterBytes ?? 0,
		// the three that price a stage rather than the mount: how much of the tree it opened,
		// and whether the budget made it open the same file twice
		inflated: stats?.inflated ?? 0,
		inflatedBytes: stats?.inflatedBytes ?? 0,
		evicted: stats?.evicted ?? 0,
		reinflated: stats?.reinflated ?? 0
	};
}

/**
 * What one fill produced.
 *
 * `filled` is the path or null, and everything after `remaining` belongs to exactly one of the
 * three outcomes -- rendered, failed, or an empty queue.
 */
interface FillOutcome {
	filled: string | null;
	remaining: number;
	failed?: string;
	error?: string;
	attempts?: number;
	bytes?: unknown;
	renderMs?: unknown;
	pageCache?: unknown;
	dynamicCache?: unknown;
	/**
	 * whether THIS fill also paid for the interpreter boot.
	 *
	 * Measured inside the fill rather than inferred from `!this.php` at the caller, because the two
	 * disagree and the deployed tail proved it: three paid cold-object renders reported a boot and
	 * cost 55/58/77 ms of cpuTime, while the alarms beside them cost 3,200/3,608/3,623 ms. The
	 * object looked cold when the decision was taken and an alarm had booted it by the time the
	 * render ran behind the gate, so the header credited the render with a boot it never paid for.
	 *
	 * NOT `booted`, which the warm-window reply already uses for "an interpreter is up" -- the two
	 * are near-opposites on a warm fill, and spreading this outcome over that field inverted it.
	 */
	bootedInFill?: boolean;
	/**
	 * The rendered response, present ONLY when it was not cached.
	 *
	 * A GET's render is read back out of `cfw_page` by the caller, which is the shared path and stays
	 * that way. A submission is deliberately never written there, so without this the caller would
	 * look for a row that does not exist and answer a form POST with a miss. An authenticated GET
	 * takes the same route for the same reason: the row would be shared and the page is not.
	 */
	page?: {
		status: number;
		contentType: string;
		html: unknown;
		renderMs: number;
		/** `Set-Cookie` lines Drupal produced; without these a login cannot be kept */
		setCookie: string[];
		/** `Location`, so a login's redirect survives instead of rendering as an empty 302 body */
		location: string | null;
	};
}

/**
 * The interpreter, built the way prof.js builds it.
 *
 * static-free-v1 rather than static-o2: every recorded per-query and
 * bridge number in TECHNICAL_REPORT.md was taken on this build, and the first cost
 * figures for the driver have to be comparable to them.
 */
class PhpStatic extends PhpBase {
	/** the raw entry point php-wasm's published types omit; `run()` is a wrapper over it */
	declare _run: (code: string) => Promise<unknown>;

	constructor(args: PhpRuntimeArgs = {}, diag: string[] = []) {
		const t0 = Date.now();
		const note = (m: string) => diag.push(`+${Date.now() - t0}ms ${m}`);
		// php-wasm types the loader's `default` as a CONSTRUCTOR, while every real php-wasm build
		// exports an emscripten factory function -- which is what its own glue then calls. The cast
		// is over that upstream mismatch, not over anything this file does
		super(
			Promise.resolve({ default: PHPFactory }) as unknown as Promise<PhpBaseModuleFactory>,
			{
				...args,
				ini: [
					'opcache.enable=1',
					'opcache.enable_cli=1',
					// /tmp, NOT /tmp/opcache, and the ordering is the whole reason. opcache reads this
					// during PHP's MODULE STARTUP, which happens inside this constructor; the
					// `mkdirp(FS, '/tmp/opcache')` in the mount sequence runs later, so on a binary
					// that actually HAS opcache the directory does not exist yet and startup aborts
					// with exit(-2). emscripten's MEMFS always creates /tmp.
					//
					// This was dead config until 8.5. `vendor/static-o2` (8.3, shipping) contains ZERO
					// occurrences of `Zend OPcache`, so every line in this block was silently ignored
					// for the life of the project; 8.5 makes opcache mandatory and they went live.
					//
					// MEASURED ON THE EDGE, and the file cache is WRITE-ONLY: 112 `.bin` files after a
					// kernel boot and 1,301 across 425 directories after one render, and nothing ever
					// reads them back. MEMFS belongs to the interpreter instance, so every cold boot
					// starts with an empty `/tmp` and every lookup is a guaranteed miss; within one
					// instance, three entries deleted by hand did not reappear across three further
					// renders. So this buys nothing across boots and nothing within one.
					//
					// LEFT IN PLACE ANYWAY, deliberately. `file_cache_only=1` means the file cache is
					// opcache's ONLY backing store, so removing the path may disable opcache rather
					// than merely stop the writes -- and the CPU cost of the writes has not been
					// measured, so there is no figure saying the removal wins. Removing opcache ini
					// blind is exactly what produced the 8.5 exit(-2). The measurement needed is a
					// build seam with and without it; until then this is a known no-op, not a bug.
					'opcache.file_cache=/tmp',
					'opcache.file_cache_only=1',
					'opcache.validate_timestamps=0',
					'opcache.file_cache_consistency_checks=0',
					'opcache.max_accelerated_files=20011',
					'opcache.optimization_level=0x7FFEBFFF',
					// a wasm-side OOM is otherwise completely silent: PHP turns the heap
					// refusal into exit(1) with nothing on stderr (AGENT-FINDINGS A.1)
					'memory_limit=96M'
				].join('\n'),
				printErr: (t: string) => note(`err: ${t}`),
				onAbort: (what: unknown) => note(`abort: ${what}`),
				instantiateWasm(
					imports: WebAssembly.Imports,
					receiveInstance: (
						instance: WebAssembly.Instance,
						module: WebAssembly.Module
					) => void
				) {
					WebAssembly.instantiate(wasmModule, imports)
						.then((instance) => {
							receiveInstance(instance, wasmModule);
							note('instantiated');
						})
						.catch((e: any) => note(`FAILED: ${e?.message ?? e}`));
					return {};
				}
			}
		);
	}
}

/** how many pages one alarm firing may fill before re-arming; 5 on free, 25 on paid */
function fillBatchSize(env?: SiteEnv | null): number {
	return Math.max(1, resolvePlanNumber(env?.FILL_BATCH_SIZE, 'fillBatchSize', 50, env));
}

/** how long one alarm firing may occupy the object, in ms of wall clock */
function fillBatchWallMs(env?: SiteEnv | null): number {
	return resolvePlanNumber(env?.FILL_BATCH_WALL_MS, 'fillBatchWallMs', 60_000, env);
}

/** asset directory holding manifest.json plus the numbered migration chunks */
function sqlChunkPrefix(env?: SiteEnv | null): string {
	const p = String(env?.SQL_CHUNK_PREFIX ?? 'drupal-sql').replace(/^\/+|\/+$/g, '');
	return p || 'drupal-sql';
}

/**
 * Whether an alarm firing should carry the migration forward on its own.
 *
 * On by default: first-run migration is the literal first thing that happens to a
 * deployed site, and a site that needs an operator to poke `/migrate` 15 times is not a
 * product. Switchable off so a test can drive the chunks deterministically instead of
 * racing an alarm.
 */
function migrationSelfDrives(env?: SiteEnv | null): boolean {
	return String(env?.MIGRATE_SELF_DRIVE ?? '1') !== '0';
}

/**
 * Whether `alarm()` drains the deferred outbound-HTTP queue.
 *
 * On by default: before this, the only drain was the manual `/httpdrain` route, so on a real
 * site a queued request sat forever. Switchable off because a test that asserts on queue
 * depth cannot have an alarm emptying it underneath.
 */
function httpDrainEnabled(env?: SiteEnv | null): boolean {
	return String(env?.HTTP_DRAIN_ON_ALARM ?? '1') !== '0';
}

/**
 * How many queued requests one alarm firing may fetch.
 *
 * Small: each fetch is one of the 50 subrequests an invocation gets, and a fill in
 * the same firing has already spent several. Capped at 25 by `drainHttpQueue()` itself.
 * Paid gets 15 rather than 3: the subrequest ceiling is 1,000 there, so the queue can be
 * drained in one firing instead of trickling three per alarm.
 */
function httpDrainLimit(env?: SiteEnv | null): number {
	return Math.max(1, resolvePlanNumber(env?.HTTP_DRAIN_LIMIT, 'httpDrainLimit', 25, env));
}

/**
 * How many files one alarm firing may push to R2.
 *
 * Same budget as the HTTP drain and for the same reason: a put is one of the 50 subrequests an
 * invocation gets, and the fill batch in the same firing has already spent several. Deliberately
 * lower than the HTTP default because a file put also carries the whole file through memory,
 * where a queued fetch carries a request.
 */
function mirrorLimit(env?: SiteEnv | null): number {
	return Math.max(1, resolvePlanNumber(env?.MIRROR_LIMIT, 'mirrorLimit', 25, env));
}

/**
 * Whether `/migrate` seeds the serving table from `prefill.json` when nothing says otherwise.
 *
 * **ON by default for free, OFF for paid.** This is a contract change, not a
 * convenience: a prefilled path is a **HIT on its first ever request**, so the cold contract that
 * ten assertions were correctly asserting no longer holds by default. It was opt-in precisely
 * because changing that silently broke them.
 *
 * So the switch is explicit and three-way, most specific first: `?prefill=1` / `?prefill=0` on the
 * request, then a `PREFILL` env override, then the plan. Free gets it because free is where it
 * decides whether the site works at all -- a prefilled page costs no PHP on the serving path, and
 * a fill on free costs a 202 to the first visitor and rows against the binding meter. Paid can
 * afford to render, and a paid operator asking for the cold contract should get it.
 */
function prefillDefault(env?: SiteEnv | null): boolean {
	// paid default is FALSE: paid can afford to render, and an operator asking for the cold contract
	// should get it
	return planFlag(undefined, env?.PREFILL, false, env);
}

/** whether a generation bump re-queues the pages it just purged */
function prefillOnSave(env?: SiteEnv | null): boolean {
	return String(env?.PREFILL_ON_SAVE ?? '1') !== '0';
}

/**
 * How many just-purged paths a bump may re-queue.
 *
 * Capped because rows written is the free plan's binding meter -- 100k/day against roughly 8
 * rows per fill -- so a site with thousands of warm pages must not turn one save into
 * thousands of fills. The overflow is reported as `droppedFromRequeue` rather than dropped
 * silently; those paths still fill on demand, they just cost the first visitor a 202.
 */
function prefillOnSaveLimit(env?: SiteEnv | null): number {
	const n = Number(env?.PREFILL_ON_SAVE_LIMIT ?? 25);
	return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 500) : 25;
}

/**
 * Which migration engine `/migrate` uses. `sql` (JavaScript) is the default and the only
 * one that fits the free plan.
 *
 * `php` is kept reachable with `?engine=php` for exactly one purpose: it is the A side of
 * the comparison that justifies this whole change (2,272 ms minimal / 3,467 ms standard
 * of edge cpuTime against a 10 ms ceiling). It also requires a binary with `pdo_sqlite`
 * compiled in, which the SHIPPING binary does not have -- so on `static-o2` it fails, and
 * that failure is correct rather than a regression.
 */
function migrateEngine(url: URL | null, env?: SiteEnv | null): 'php' | 'sql' {
	const asked = url?.searchParams?.get('engine');
	if (asked === 'php' || asked === 'sql') return asked;
	return String(env?.MIGRATE_ENGINE ?? 'sql') === 'php' ? 'php' : 'sql';
}

/**
 * A statement that mutates Drupal's `cachetags` table.
 *
 * This is the whole automatic-invalidation seam. `DatabaseCacheTagsChecksum`
 * writes here -- and only here -- on every `invalidateTags()` call, via
 * `Connection::merge('cachetags')`, which compiles to a SELECT then an INSERT or
 * an UPDATE. Since every Drupal statement crosses `execSql()`, watching for the
 * mutating half is a content-changed signal with no Drupal-side hook to install.
 * A SELECT must not match: the checksum service reads this table on every request.
 */
const CACHETAG_WRITE =
	/^\s*(?:INSERT|UPDATE|REPLACE|DELETE|TRUNCATE)\b[\s\S]{0,400}?\bcachetags\b/i;

/**
 * How long after a module install the fill chain may start.
 *
 * Not tuning: an install holds its event for seconds, and the default +1 ms alarm fires into an
 * object that is still writing. One second is comfortably past the longest install measured
 * (6,810 ms of CPU, and the alarm is scheduled from the END of that work).
 */
const INSTALL_FILL_DELAY_MS = 1000;

/**
 * Points the mounted site at this driver.
 *
 * Appended rather than substituted: a later assignment wins, and settings.php is
 * required from inside Settings::initialize() where $app_root, $site_path and
 * $class_loader are all in scope. Re-registering core's sqlite namespace is not
 * optional -- our Connection extends it, and replacing the default connection
 * removes the only entry that would have registered it.
 */
const SETTINGS_OVERRIDE = `

// --- appended by src/site-do.js: run against ctx.storage.sql ---
$databases['default']['default'] = [
  'driver' => 'cfw_do_sqlite',
  'namespace' => 'Drupal\\\\cfw_do_sqlite\\\\Driver\\\\Database\\\\cfw_do_sqlite',
  'autoload' => 'modules/custom/cfw_do_sqlite/src/Driver/Database/cfw_do_sqlite/',
  'prefix' => '',
];
$class_loader->addPsr4('Drupal\\\\sqlite\\\\Driver\\\\Database\\\\sqlite\\\\', $app_root . '/core/modules/sqlite/src/Driver/Database/sqlite/');
// PDO, PDOException and PDOStatement in userland, for a build with no ext-pdo. Global classes,
// so no PSR-4 root can reach them and the require is the only mechanism; it has to run before
// the first statement is constructed, and Settings::initialize() is the earliest place that does
require_once $app_root . '/modules/custom/cfw_do_sqlite/src/pdo-shim.php';
// the namespace is registered here rather than by the module system: the PSR-4 root has to exist
// before Settings::initialize() returns, and the extension list is not read until after
$class_loader->addPsr4('Drupal\\\\drupflare\\\\', $app_root . '/modules/custom/drupflare/src/');
// php_mail cannot run in this runtime -- no sendmail binary, no sockets on PHP's side -- so the
// mailer is a platform substitution like the database driver above, not a site preference. Forced
// here rather than as a config row so a config import cannot revert a site into a mailer that
// silently drops every message. Which TRANSPORT cfw_mail then uses is MAIL_TRANSPORT.
// NO BACKTICKS IN THIS BLOCK: it is a template literal, and one truncates it
$config['system.mail']['interface']['default'] = 'cfw_mail';
// drupflare/stream-http, which drupflare's HttpsStreamWrapper now EXTENDS. Composer never runs
// on the edge, so the packed tree is the vendor directory and this line is the autoloader entry
// composer would otherwise have written. Without it the subclass fatals on its parent.
$class_loader->addPsr4('Drupflare\\\\StreamHttp\\\\', $app_root . '/libraries/drupflare-stream-http/src/');
// A FORGED HOST CANNOT MOVE THE SITE, so the pattern list is the origin the object already pinned
// rather than a wildcard. cfw_serve() builds every request from that same origin, so anything else
// is a request this site did not issue to itself. Empty until the origin is known, which is the one
// state where the check has nothing to compare against.
$cfw_host = (string) parse_url(CFW_SITE_ORIGIN_PLACEHOLDER, PHP_URL_HOST);
if ($cfw_host !== '') {
  $settings['trusted_host_patterns'] = ['^' . str_replace('.', '\\\\.', $cfw_host) . '$'];
}
// Drupal derives this from the hash salt and then reports that it does not exist. Nothing in this
// runtime creates it, and config import/export is the one feature that reads it.
$settings['config_sync_directory'] = $app_root . '/sites/default/files/config/sync';
// created HERE, not once at claim time: the filesystem is remounted from the pack on every boot,
// so a directory made during provisioning is gone by the next request
if (!is_dir($settings['config_sync_directory'])) {
  @mkdir($settings['config_sync_directory'], 0777, true);
}
// FALSE is what core asks for: SystemRequirementsHooks warns on TRUE *and* on NULL, and both
// messages say to set FALSE. It is the Drupal 12 default and the Drupal 13 behaviour, and it only
// adds a novalidate attribute to forms -- server-side validation is untouched
$settings['enable_html5_validation'] = false;
`;

/**
 * Points Drupal's `page` bin at a null backend, because the host already stores the served page.
 *
 * MEASURED. A fill that renders the front page writes 12 billable rows: 4 to `cache_page` and 8
 * to `cache_dynamic_page_cache`. The 4 is not a typo for 1 -- `cache_page` carries a primary-key
 * autoindex plus `cache_page_created` and `cache_page_expire`, and Cloudflare's rows-written
 * meter counts an index update as a row written. Emptying the bin before a re-render pays the
 * same 4 again on the way out, so the steady-state fill lane pays up to 8 for this bin alone.
 *
 * This bin is pure duplication and the other two are not. The served cache lives in the
 * Durable Object's own SQL and NOT in `cache_page` (see the comment on the serve
 * tables), because the hit path must not boot PHP at all to fit a 10 ms budget. So `cache_page`
 * is a second copy of bytes that are already stored, in a form only an interpreter can read, on
 * a path that refuses to start one. Rows written is the meter that binds the regeneration
 * ceiling, which makes a duplicate store not merely redundant but the scarce resource itself.
 *
 * Only this bin, against the roadmap's own 4.47x claim. That figure assumed `page`,
 * `dynamic_page_cache` and `render` could all go, because core's `DevelopmentSettingsPass` nulls
 * exactly those three as a bundle. Two of them are load-bearing here: leaving
 * `dynamic_page_cache` warm is what lets a fill REASSEMBLE instead of render, which is the cheap
 * path, so nulling it would trade 8 rows for a full render's CPU on every fill. Killing `page`
 * alone is 12 -> 8 rows, not 12 -> 2.7.
 *
 * A services file rather than `$settings['cache']['bins']`. Core registers `cache.backend.null`
 * in no yaml file at all -- only from a compiler pass and the installer -- so the settings route
 * names a service that does not exist and fails every request. Defining the factory here makes
 * the reference resolvable.
 *
 * It also carries the file wrappers, for the same reason it can carry the cache override. Drupal
 * owns `public://` -- `StreamWrapperManager` registers `PublicStream` for it during container boot,
 * so a bare `stream_wrapper_register()` from the host either loses the race or is undone the next
 * time the manager runs. Overriding `stream_wrapper.public` by tag is the supported way, and it only
 * works from inside the container. `CfwFileStreamWrapper` stores in the Durable Object's own SQL, so
 * an upload survives the eviction that used to destroy it while leaving the `file_managed` row
 * behind.
 *
 * The path itself is load-bearing. The shipped settings.php
 * already does `$settings['container_yamls'][] = $app_root . '/' . $site_path . '/services.yml'`
 * unconditionally, and that file has never existed. `getContainerCacheKey()` folds in
 * `serialize(Settings::get('container_yamls'))` -- the RAW setting -- while `addServiceFiles()`
 * loads `array_filter($yamls, 'is_file')`. So creating this file changes what the container
 * contains WITHOUT changing the container cache key by a byte. Any other filename would add a
 * path, move the key, and invalidate every figure measured against the baked container.
 */
const SERVICES_YAML = `services:
  drupflare.cache_backend.null:
    class: Drupal\\Core\\Cache\\NullBackendFactory
    public: false
  cache.page:
    class: Drupal\\Core\\Cache\\CacheBackendInterface
    tags:
      - { name: cache.bin }
    factory: ['@drupflare.cache_backend.null', 'get']
    arguments: [page]
  stream_wrapper.public:
    class: Drupal\\drupflare\\StreamWrapper\\CfwFileStreamWrapper
    tags:
      - { name: stream_wrapper, scheme: public }
  stream_wrapper.private:
    class: Drupal\\drupflare\\StreamWrapper\\CfwFileStreamWrapper
    tags:
      - { name: stream_wrapper, scheme: private }
`;

/**
 * One site: the interpreter AND the database, in the same isolate.
 *
 * This is the arrangement the whole project has been pointing at and had never
 * executed. ctx.storage.sql is synchronous only from inside the Durable Object,
 * and PHP's PDO is blocking, so the driver can only work if PHP runs HERE. Until
 * this class existed the PHP half was tested against a PDO stand-in and the JS
 * half against synthetic statements, and the two had never met.
 */
export class SitePhpDurableObject extends SiteDurableObject {
	// narrows the base class's env to the worker's own vars; `declare` emits nothing
	declare env: SiteEnv;
	php: PhpInstance | null;
	out: string[];
	bootDiag: string[];
	bootMs: number | null;
	mountInfo: SiteMountInfo | null;
	/** wall time of the last fill that ALSO booted; kept for diagnostics, never used as an estimate */
	lastBootInclusiveMs?: number;
	/** what the last heap restore attempt did, or null when it was never attempted */
	heapRestore: Payload | null;
	/**
	 * Today's authenticated spend, or undefined when nothing has been charged in this lifetime.
	 *
	 * In memory only, and read back from `ctx.storage` on each charge rather than trusted across
	 * one: an eviction between two authenticated renders must not reset the day's budget, and the
	 * durable record is the only thing that survives it.
	 */
	authSpend?: AuthSpend;
	/**
	 * Where a chunked restore has got to, or null when there is nothing in flight.
	 *
	 * In memory only, which is the safety argument. The cursor indexes into a LIVE heap, so
	 * its correct lifetime is exactly that heap's lifetime. Persisting it to `ctx.storage` would let
	 * a cursor survive an eviction that destroyed the heap it describes, and the next firing would
	 * resume at chunk 7 of a heap that is back to zeros -- a restore that reports complete over a
	 * heap that is 6 chunks of nothing. Dying with the isolate makes a resumed-onto-nothing restore
	 * unrepresentable; the cost is repeating at most one object's worth of memcpy after an eviction,
	 * which is idempotent because every chunk writes fixed bytes at fixed offsets.
	 */
	heapRestoreCursor: HeapRestoreCursor | null;

	/**
	 * Strong references to every vrzno handle value this interpreter has handed PHP.
	 *
	 * In memory only: it exists to stop the handle table's WeakRefs dying under
	 * a heap that still holds their integers, and it is meaningless once that heap is gone. See
	 * `pinHandles()`.
	 */
	pinnedHandles?: Set<object>;
	migrated: boolean;

	// #region set on first use, so `undefined` tells "never happened" apart from a zero
	logs?: Payload[];
	mails?: Array<{
		to: unknown;
		subject: unknown;
		bytes: number;
		/** the transport the message was committed to, or null when it was refused */
		transport: string | null;
		/** why it was refused; absent on a message that reached the queue */
		refusal?: string;
	}>;
	httpTablesReady?: boolean;
	serveTablesReady?: boolean;
	suppressBump?: boolean;
	/** statement counter for PW_SQL_TRACE, so the tail can be read as a sequence */
	sqlTraceSeq?: number;
	bumpCoalesced?: boolean;
	bumps?: number;
	lastRenderMs?: number;
	renderClockUnmeasurable?: boolean;
	/** PHP-to-host crossings, per capability; see `src/ops/crossings.ts` */
	crossings?: CrossingTally;
	/** which capability names were actually present to wrap, so a 0 is not read as "never called" */
	crossingNames?: string[];
	/** the tally at the start of the last render, so `/serve-stats` can report a per-render figure */
	lastRenderCrossings?: CrossingTally;
	windowOpenedAt?: number;
	windowClosedAt?: number;
	windowFills?: number;
	windowsOpened?: number;
	lastWindowFills?: number;
	_migrator?: SqlMigrator;
	lastUpdb?: Payload;
	lastUpdbAt?: number;
	lastAlarmAt?: number;
	lastAlarmOutcome?: unknown;
	alarmFirings?: number;
	alarmRearms?: number;
	migrateFailures?: number;
	pagesFilledByAlarms?: number;
	/** consecutive failing batches, for the capped backoff; reset by any batch that progressed */
	consecutiveFillFailures?: number;
	lastAlarmClass?: AlarmClass;
	/** per-table rows-written tally; only allocated when /__writes turns it on */
	writeTally?: WriteTally;
	lastGc?: Payload;
	lastGcAt?: number;
	lastHttpDrain?: Payload;
	lastHttpDrainAt?: number;
	lastMailDrain?: Payload;
	lastMailDrainAt?: number;
	lastMirrorDrain?: Payload;
	lastPageMirrorDrain?: Payload;
	lastPageMirrorDrainAt?: number;
	lastFleetError?: string;
	lastCron?: Payload;
	lastCronAt?: number;
	/** per-path serve counts, in memory only; the R2 page mirror publishes the busiest first */
	pageHits = new Map<string, number>();
	lastMirrorDrainAt?: number;
	/** writes accumulated since the last alarm folded them into the daily total */
	rowsSinceFlush?: number;
	/**
	 * Durable Object invocations since the last flush, counted in memory.
	 *
	 * Same shape as `rowsSinceFlush` and for the same reason: persisting per invocation would cost
	 * a row per invocation, so the meter would inflate the OTHER meter it sits beside. Folded into a
	 * per-UTC-day total on the alarm, where one row is already being written.
	 */
	doRequestsSinceFlush?: number;
	phpLaneEntries?: number;
	storageLaneServes?: number;
	/**
	 * Trend rings for the three signals a slope is claimed about.
	 *
	 * Held here rather than inside `src/ops/supervisor.ts`, which is not allowed to own state: a
	 * tripwire keeping its own history would keep a poisoned observation alive across the very
	 * recycle the layer exists to survive. In-memory on purpose -- an eviction should forget the
	 * trend rather than resume a stale one.
	 */
	memoryRing = new RingBuffer();
	rowsRing = new RingBuffer();
	doRing = new RingBuffer();
	/** per-path render sizes, previous renders only; the baseline `renderSizeAnomaly` compares against */
	pageBytes = new Map<string, number[]>();
	/** what the last supervised alarm found, for `/__health` */
	lastFindings?: Finding[];
	// #endregion

	constructor(ctx: DurableObjectState, env: SiteEnv) {
		super(ctx, env);
		this.php = null;
		this.out = [];
		this.bootDiag = [];
		this.bootMs = null;
		this.mountInfo = null;
		this.heapRestore = null;
		this.heapRestoreCursor = null;
		this.migrated = false;
		// counts the HOST's writes as well as Drupal's; see countingSql(). Now installed
		// UNCONDITIONALLY, where it used to be gated on PW_DIAGNOSTICS, because the daily
		// rows-written meter is a product reading rather than a diagnostic: the Limits page
		// showed "nothing measures this yet" for the one meter that binds regeneration.
		//
		// The per-table tally stays opt-in behind the routes that arm it. What is always on is
		// one addition per WRITE statement and nothing at all on a read.
		this.sql = countingSql(
			this.sql,
			() => this.writeTally,
			(rows) => {
				this.rowsSinceFlush = (this.rowsSinceFlush ?? 0) + rows;
			}
		);
	}

	/**
	 * Builds the interpreter, installs the bridge, mounts the tree. Once.
	 *
	 * Lazy rather than in the constructor so boot cost is attributable to a route
	 * and measurable on its own. /request-boot already proved a static build can
	 * be instantiated inside a request handler (bootMs 36) -- no runtime codegen,
	 * so workerd permits it.
	 */
	async ensurePhp(opts: { skipRestore?: boolean } = {}): Promise<PhpInstance> {
		if (this.php) {
			// a half-restored heap is the right LENGTH and the wrong BYTES, so it boots and then
			// renders something subtly wrong -- refuse by construction rather than by discipline
			if (this.heapRestoreCursor) throw new HeapRestoreIncomplete(this.heapRestoreCursor);
			return this.php;
		}

		const t0 = Date.now();
		const php = new PhpStatic({}, this.bootDiag);
		php.addEventListener('output', (e) =>
			this.out.push(...([] as string[]).concat((e as PhpOutputEvent).detail ?? []))
		);
		php.addEventListener('error', (e) =>
			this.out.push(...([] as string[]).concat((e as PhpOutputEvent).detail ?? []))
		);
		// the one cast: php-wasm resolves this as a loosely-typed Module, and SiteBinary names
		// both the FS surface the mounts drive and the cfw* members installed just below
		const binary = (await php.binary) as unknown as SiteBinary;

		// the bridge the driver reaches through vrzno_env(); inherited from
		// SiteDurableObject so exec/txn semantics are the verified ones
		this.installBridge(binary);
		/**
		 * Whether this binary can suspend, read by drupflare's service provider.
		 *
		 * `FetchHandler` routes \Drupal::httpClient() through the platform's fetch(), and it
		 * needs `vrzno_await()`, which is compiled against Asyncify. The shipping build sets
		 * ASYNCIFY=0 to save 42% of the bundle, so `src/runtime/worker-shim.js` installs a stub
		 * carrying `__cfwStub` to close an uncatchable-throw DoS. A stub is NOT a suspension
		 * mechanism, so it must read false here.
		 *
		 * The provider probed for this rather than taking a settings flag, because a flag drifts
		 * from the binary that is actually loaded and the binary is what decides.
		 */
		binary.cfwCanSuspend =
			typeof shimGlobals.Asyncify === 'object' &&
			shimGlobals.Asyncify !== null &&
			shimGlobals.Asyncify.__cfwStub !== true;

		binary.cfwStats = () =>
			JSON.stringify({
				queryCount: this.queryCount,
				databaseSize: Number(this.sql.databaseSize)
			});
		this.installCapabilities(binary);
		// ext-zlib over fflate, masked because a sync deflate is a long JS frame under the PHP
		// stack. Installed even on a build that HAS zlib: the PHP half checks
		// extension_loaded('zlib') and defines nothing, so an unused Module key is the whole cost
		installZlib(binary as unknown as Record<string, unknown>, withMask);
		// LAST, after every installer. A wrapper applied before one is silently overwritten by it,
		// and the tally then reads 0 for a capability being called constantly -- which is the
		// failure this instrument exists to avoid in the first place
		this.crossings = emptyCrossings();
		this.crossingNames = wrapCrossings(
			binary as unknown as Record<string, unknown>,
			this.crossings
		);
		// before any PHP runs, because a handle minted before the pin is installed cannot be
		// pinned retroactively -- see pinHandles()
		this.pinHandles(binary);

		// SITE_DB_PREFIX swaps only the database; the default pack has no node bundles,
		// so a content write needs drupal-std while every earlier read measurement was
		// taken on drupal and must stay comparable
		// LAZY_MOUNT swaps the mount strategy, not the tree. The streaming mount inflates
		// 39 MB and writes 11,421 files up front, which is 3,066 ms of the 3,754 ms edge
		// cold start; the lazy mount creates the nodes and inflates each file when PHP
		// first opens it. Both are kept because the streaming figures are what every
		// recorded boot number was taken on.
		this.mountInfo =
			this.env?.LAZY_MOUNT === '1'
				? await mountDrupalLazy(binary, this.env, {
						dbPrefix: this.env?.SITE_DB_PREFIX || undefined,
						// same condition as the streaming path below; the lazy mount used to fetch
						// the database unconditionally, which is the one boot cost LAZY_MOUNT did
						// not remove
						database: migrateEngine(null, this.env) === 'php'
					})
				: await mountDrupalStreaming(binary, this.env, {
						dbPrefix: this.env?.SITE_DB_PREFIX || undefined,
						// the packed .sqlite is only ever opened by the PHP migration engine; the
						// JS engine makes it 6.47 MB and one subrequest spent on nothing
						database: migrateEngine(null, this.env) === 'php'
					});
		this.mountInfo.driver = await mountDriver(binary, this.env);

		// point the site at this driver, and at a salt only this site has
		const settingsPath = '/drupal/sites/default/settings.php';
		const existing = new TextDecoder().decode(binary.FS.readFile(settingsPath));
		if (!existing.includes('cfw_do_sqlite')) {
			// the pack ships NO hash_salt, so this append is the only assignment: an override that
			// failed to run leaves Settings::getHashSalt() throwing rather than every site on the
			// payload signing password-reset links with one public value
			const salt = hashSaltAssignment(ensureHashSalt(this.secretStore()));
			// the PINNED origin, interpolated here because settings.php is evaluated once per boot
			// and the pin is a property of the site rather than of the request
			const override = SETTINGS_OVERRIDE.replace(
				'CFW_SITE_ORIGIN_PLACEHOLDER',
				JSON.stringify(this.canonicalOrigin(null))
			);
			binary.FS.writeFile(settingsPath, existing + override + salt);
		}
		// the path settings.php already registered but that never existed; see SERVICES_YAML
		binary.FS.writeFile('/drupal/sites/default/services.yml', SERVICES_YAML);

		this.php = { php, binary, out: this.out };
		this.bootMs = Date.now() - t0;

		// restore a stored heap if one matches this pack, AFTER the mount and after the bridge
		// and capabilities are installed -- the heap holds vrzno handles by index into the JS side
		// those installs populate, so restoring earlier leaves indices pointing at nothing.
		//
		// ON by default; see heapSnapshotEnabled() for the precondition that had to be met first and
		// what the storage buys.
		if (heapSnapshotEnabled(this.env) && !opts.skipRestore) {
			try {
				this.heapRestore = await this.tryRestoreHeap(binary, {
					maxChunks: heapRestoreChunkBudget(this.env)
				});
			} catch (e) {
				// a refusal is a boot, not an outage: fall through to the normal path
				this.heapRestoreCursor = null;
				// unless bytes already landed. A digest refusal on chunk 0 leaves this heap exactly as
				// the pack booted it, so continuing is free; a refusal on chunk N has already applied
				// N chunks, and continuing would serve a heap of the right length and the wrong bytes.
				// Telling the two apart is why `HeapChunkDigestError` carries `bytesWritten` -- the
				// untyped throw made every refusal look like the cheap one, which is how a corrupted
				// chunk 3 would have booted silently.
				const dirty = e instanceof HeapChunkDigestError && e.bytesWritten > 0;
				this.heapRestore = {
					restored: false,
					reason: String((e as Error)?.message ?? e),
					...(dirty ? { discardedHeap: true, dirtyBytes: e.bytesWritten } : {})
				};
				if (dirty) {
					// throw the poisoned instance away and boot from the pack, which is the path that
					// does not depend on the snapshot at all. `skipRestore` is what stops the retry
					// refusing the same chunk forever.
					this.php = null;
					const fresh = await this.ensurePhp({ skipRestore: true });
					this.heapRestore.rebooted = true;
					return fresh;
				}
			}
			// the restore did not finish inside this invocation. `this.php` is already assigned, so
			// the binary and its mount survive to the next firing; the cursor is what makes this
			// object unservable until the remaining chunks land.
			if (this.heapRestoreCursor) {
				await this.ctx.storage.setAlarm(this.nowMs() + 1);
				throw new HeapRestoreIncomplete(this.heapRestoreCursor);
			}
		}

		// pw_encode()/pw_decode() must exist before the driver constructs its client,
		// and the mb_* wrappers must be defined before /drupal/autoload.php force-includes
		// Symfony's polyfill bootstrap, or its function_exists() guards win
		await this.run(`<?php ${PHP_CODEC}`);
		await this.run(`<?php ${MB_FIX}`);
		// same window as MB_FIX: polyfill-iconv's bootstrap must find the name already
		// taken, since its own iconv_strrpos() is wrong whenever the match is at index 0
		await this.run(`<?php ${ICONV_FIX}`);
		// the gz* functions have to exist before AssetDumper runs, and it runs inside a render;
		// same shape as MB_FIX, and inert on a build that has the real extension
		await this.run(`<?php ${ZLIB_FIX}`);
		return this.php;
	}

	/**
	 * The host half of the `drupflare` module, packed from `../drupflare` into `assets/driver.json`.
	 *
	 * Every one of these is synchronous, which is the design constraint rather than a
	 * shortcut. `Host::call()` in PHP does `$reply = $invoke($json)` and
	 * reads the result immediately; PHP cannot await, so a host function that returned
	 * a Promise would hand PHP an object it can only stringify. So the capabilities
	 * that need the network are split in two:
	 *
	 *   - `cfwQueueFetch` records the request and returns at once (no suspension).
	 *   - `cfwHttpCacheGet` / `cfwFetch` answer from what a previous drain already
	 *     fetched (no suspension).
	 *   - the actual `fetch()` happens in `drainHttpQueue()`, in JS, between PHP runs.
	 *
	 * That is exactly the cached -> deferred -> sync layering CfwDeferredHttp
	 * documents, with the sync tier absent until a JSPI build exists. A miss is
	 * reported as a miss rather than faked.
	 */
	installCapabilities(binary: SiteBinary): SiteBinary {
		const reply = (obj: unknown) => JSON.stringify(encode(obj));
		const parse = (json: string): Payload => {
			try {
				return (decode(JSON.parse(json)) as Payload) ?? {};
			} catch {
				return {};
			}
		};

		/** structured log out of the isolate, plus a ring buffer so tests can assert */
		binary.cfwLog = (json: string) => {
			const entry = parse(json);
			this.logs = this.logs ?? [];
			this.logs.push(entry);
			if (this.logs.length > 100) this.logs.shift();
			// console.log is what `wrangler tail` and Workers Logs collect, and it
			// survives the isolate that produced it -- which a watchdog row does not.
			// the ring buffer is not gated, only the mirror: `/health` reads it back, so a quiet
			// terminal must not also be a blind diagnostic surface
			if (phpLogPasses(entry, phpLogCeiling(this.env?.PHP_LOG_LEVEL))) {
				console.log(JSON.stringify({ cfw: 'php', ...entry }));
			}
			return reply({ ok: true });
		};

		// METHOD AND BODY, not just the url. The tier is keyed `method + url + body`, so a POST
		// asking for its own answer with only a url looks up a GET that was never made -- which is
		// the reCAPTCHA shape exactly: two submissions to one endpoint differ only in the body, and
		// the second one has to be able to read what the first one's drain fetched.
		binary.cfwHttpCacheGet = (json: string) => {
			const req = parse(json);
			const row = this.httpCacheGet(
				String(req.url ?? ''),
				String(req.method ?? 'GET'),
				String(req.body ?? '')
			);
			return reply(
				row === null
					? { ok: false, error: 'not cached' }
					: { ok: true, status: row.status, headers: row.headers, body: row.body }
			);
		};

		// the stream wrapper's entry point; same cache, different caller
		binary.cfwFetch = (json: string) => {
			const req = parse(json);
			const url = String(req.url ?? '');
			const method = String(req.method ?? 'GET');
			const body = String(req.body ?? '');
			const row = this.httpCacheGet(url, method, body);
			if (row !== null) {
				return reply({
					ok: true,
					status: row.status,
					headers: row.headers,
					body: row.body
				});
			}
			// queued so the NEXT read succeeds, and the refusal names the reason rather
			// than looking like a network error
			this.queueHttp(url, method, body);
			return reply({
				ok: false,
				error: `${url} is not in the fetch cache; queued for the next drain. A Worker cannot fetch synchronously without JSPI, so this capability is cached-or-deferred by construction.`,
				queued: true
			});
		};

		// THE BODY IS THE REQUEST, for every deferred POST there is. Dropping it queued a POST that
		// would arrive at the endpoint EMPTY, so a reCAPTCHA siteverify -- the canonical deferred
		// POST -- could only ever come back "invalid-input-response". PHP was sending it all along;
		// this end was throwing it away.
		binary.cfwQueueFetch = (json: string) => {
			const req = parse(json);
			const url = String(req.url ?? '');
			if (url === '') return reply({ ok: false, error: 'no url' });
			this.queueHttp(url, String(req.method ?? 'GET'), String(req.body ?? ''));
			return reply({ ok: true, queued: url });
		};

		/**
		 * Resolves a transport and COMMITS the message; the send happens on the alarm.
		 *
		 * This used to push onto `this.mails` and answer `{ok: true}` whenever `CFW_EMAIL_BINDING`
		 * was `'1'`, which gated a return value and not a transport -- nothing was ever sent. The
		 * var is gone; see `src/ops/mail.ts` for the three transports and how one is chosen.
		 *
		 * `ok: true` now means "a transport resolved and the row is durably committed", which is
		 * what a submission server means by 250. It cannot mean more than that from here: PHP calls
		 * synchronously and the network needs an await, the same split `cfwFetch` lives under. A
		 * refusal names what is missing, and `CfwMail` logs that sentence.
		 */
		binary.cfwMail = (json: string) => {
			const msg = parse(json);
			this.mails = this.mails ?? [];
			const bytes = String(msg.text ?? '').length;
			const refuse = (refusal: string) => {
				this.mails!.push({
					to: msg.to,
					subject: msg.subject,
					bytes,
					transport: null,
					refusal
				});
				return reply({ ok: false, error: refusal });
			};

			const message = {
				to: String(msg.to ?? ''),
				from: String(msg.from ?? ''),
				replyTo: String(msg.replyTo ?? ''),
				subject: String(msg.subject ?? ''),
				text: String(msg.text ?? ''),
				html: msg.html === undefined || msg.html === null ? null : String(msg.html),
				headers: (msg.headers ?? {}) as Record<string, string>
			};

			const plan = resolveMailTransport(this.env ?? {});
			if ('refusal' in plan) return refuse(plan.refusal);

			const queued = queueMail(this.sql, message, plan.transport, this.nowMs());
			if ('refusal' in queued) return refuse(queued.refusal);

			this.mails.push({
				to: msg.to,
				subject: msg.subject,
				bytes,
				transport: plan.transport.kind
			});
			// wake the drain, or a queued message waits for the 240 s keep-warm tick; same reason
			// `queueHttp()` arms
			if (mailDrainEnabled(this.env ?? {})) this.armFillAlarm();
			return reply({ ok: true, queued: queued.id, transport: plan.transport.kind });
		};

		// Cloudflare Images resizes at delivery, so a style is a URL rather than a file
		binary.cfwImageUrl = (json: string) => {
			const req = parse(json);
			const src = String(req.url ?? req.path ?? '');
			const w = Number(req.width ?? 0);
			const h = Number(req.height ?? 0);
			const params = [w > 0 ? `width=${w}` : null, h > 0 ? `height=${h}` : null, 'fit=cover']
				.filter(Boolean)
				.join(',');
			return reply({
				ok: src !== '',
				url: src === '' ? null : `/cdn-cgi/image/${params}${src}`
			});
		};

		// #region durable files
		//
		// FULLY SYNCHRONOUS, and unlike every capability above that is not a compromise. `cfwFetch`
		// and friends are split into a queue and a drain because the network cannot be awaited from
		// PHP; `ctx.storage.sql` needs no await at all from inside the Durable Object, so a file
		// write can report a real result -- durable, committed -- in the same call. That is the whole
		// reason `src/db/file-store.ts` stores in DO SQL and treats R2 as an offload: it is the only
		// arrangement where a synchronous stream wrapper can tell PHP the truth.
		//
		// Bytes cross as base64 in a string field rather than through the codec's bytes envelope,
		// because a stream wrapper reads and writes partial buffers and an explicit field keeps the
		// boundary readable at the one place a chunk is assembled.
		binary.cfwFileWrite = (json: string) => {
			const req = parse(json);
			try {
				const written = putFile(
					this.sql,
					String(req.uri ?? ''),
					base64ToBytes(String(req.b64 ?? '')),
					{
						nowMs: this.nowMs(),
						mime: req.mime === undefined || req.mime === null ? null : String(req.mime)
					}
				);
				return reply({ ok: true, ...written });
			} catch (e: any) {
				return reply({ ok: false, error: String(e?.message ?? e) });
			}
		};

		binary.cfwFileRead = (json: string) => {
			const req = parse(json);
			const uri = String(req.uri ?? '');
			// a chunk read when `seq` is given, the whole file otherwise. The chunked form is what
			// makes a large read divisible across invocations under a 10 ms cap.
			if (req.seq !== undefined && req.seq !== null) {
				const chunk = getFileChunk(this.sql, uri, Number(req.seq));
				return reply(
					chunk === null
						? { ok: false, error: 'no such chunk' }
						: { ok: true, b64: bytesToBase64(chunk), bytes: chunk.length }
				);
			}
			const body = getFile(this.sql, uri);
			return reply(
				body === null
					? { ok: false, error: 'no such file' }
					: { ok: true, b64: bytesToBase64(body), bytes: body.length }
			);
		};

		binary.cfwFileStat = (json: string) => {
			const stat = statFile(this.sql, String(parse(json).uri ?? ''));
			return reply(
				stat === null ? { ok: false, error: 'no such file' } : { ok: true, ...stat }
			);
		};

		binary.cfwFileDelete = (json: string) => {
			const removed = deleteFile(this.sql, String(parse(json).uri ?? ''), this.nowMs());
			// `ok` reports whether anything was there; unlink() on an absent path is a PHP false,
			// not an exception, so the distinction has to survive the crossing
			return reply({ ok: removed });
		};

		binary.cfwFileRename = (json: string) => {
			const req = parse(json);
			return reply({
				ok: renameFile(
					this.sql,
					String(req.from ?? ''),
					String(req.to ?? ''),
					this.nowMs(),
					{
						overwrite: req.overwrite === true
					}
				)
			});
		};

		binary.cfwFileList = (json: string) => {
			const req = parse(json);
			return reply({
				ok: true,
				files: listFiles(this.sql, String(req.prefix ?? ''), Number(req.limit ?? 1_000))
			});
		};
		// #endregion

		return binary;
	}

	/**
	 * The fetch cache and the deferred queue; durable, so a drain survives eviction.
	 *
	 * KEYED BY METHOD+URL+BODY, NOT BY URL. Both tables were `url TEXT PRIMARY KEY`, which is a live
	 * correctness bug rather than a POST-only gap: two deferred fetches to the same endpoint are one
	 * row, so the second overwrites the first and a caller can be handed a response fetched for
	 * somebody else. For a captcha verification that is one visitor receiving another's verdict.
	 *
	 * The key is the exact tuple, LENGTH-PREFIXED, and never a hash. A non-cryptographic hash is
	 * forgeable and this key decides which cached response a request reads; a cryptographic one
	 * cannot be used because `crypto.subtle.digest` is async and the key is derived inside the
	 * synchronous call PHP makes. See {@link deferredKey}.
	 */
	ensureHttpTables(): void {
		if (this.httpTablesReady) return;
		// an existing site carries the url-keyed tables, and `CREATE TABLE IF NOT EXISTS` would leave
		// them in place. Both are caches: the queue holds deferred fetches that PHP re-queues on the
		// next miss, so dropping loses a round trip rather than data
		for (const table of ['cfw_http_cache', 'cfw_http_queue']) {
			const columns = this.sql
				.exec<Row<{ name: string }>>('SELECT name FROM pragma_table_info(?)', table)
				.toArray()
				.map((r) => String(r.name));
			if (columns.length > 0 && !columns.includes('key')) {
				this.sql.exec(`DROP TABLE ${table}`);
			}
		}
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS cfw_http_cache (
        key TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        status INTEGER NOT NULL,
        headers TEXT NOT NULL,
        body TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`
		);
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS cfw_http_queue (
        key TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        method TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        queued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      )`
		);
		this.httpTablesReady = true;
	}

	httpCacheGet(
		url: string,
		method = 'GET',
		body = ''
	): { status: number; headers: Payload; body: string } | null {
		this.ensureHttpTables();
		const row = this.sql
			.exec<Row<{ status: number; headers: string; body: string; expires_at: number }>>(
				'SELECT status, headers, body, expires_at FROM cfw_http_cache WHERE key = ?',
				deferredKey(method, url, body)
			)
			.toArray()[0];
		if (!row) return null;
		// an expired entry is NEVER served -- a cached verification that outlives its meaning is a
		// replay window rather than a stale page. A missing or non-finite expiry counts as expired
		if (!isFresh({ expiresAt: Number(row.expires_at) }, this.nowMs())) return null;
		let headers: Payload = {};
		try {
			headers = JSON.parse(String(row.headers));
		} catch {
			headers = {};
		}
		return { status: Number(row.status), headers, body: String(row.body) };
	}

	queueHttp(url: string, method = 'GET', body = ''): void {
		if (!url) return;
		this.ensureHttpTables();
		this.sql.exec(
			`INSERT INTO cfw_http_queue (key, url, method, body, queued_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`,
			deferredKey(method, url, body),
			url,
			method,
			body,
			this.nowMs()
		);
		// Wake the drain, or nothing does.
		//
		// Draining in alarm() is only half a fix: on an idle site the alarm re-arms at the
		// 240 s keep-warm interval, so a queued request waited up to four minutes. Measured --
		// a serve-chain assertion sat on a 2-entry queue for 30 s and failed. Arming here
		// makes the queue self-draining, which is the same reason the fill queue arms.
		if (httpDrainEnabled(this.env)) this.armFillAlarm();
	}

	/**
	 * Fetches everything PHP deferred, in JS, where awaiting is legal.
	 *
	 * Runs between PHP invocations rather than inside one. Bounded per call because a
	 * queue full of slow hosts would otherwise occupy the object indefinitely.
	 */
	async drainHttpQueue(limit = 5) {
		this.ensureHttpTables();
		const pending = this.sql
			.exec<
				Row<{ key: string; url: string; method: string; body: string; attempts: number }>
			>(
				'SELECT key, url, method, body, attempts FROM cfw_http_queue ORDER BY queued_at LIMIT ?',
				Math.max(1, Math.min(limit, 25))
			)
			.toArray();
		const done: Payload[] = [];
		for (const item of pending) {
			const key = String(item.key);
			const url = String(item.url);
			const method = String(item.method || 'GET');
			const sent = String(item.body ?? '');
			try {
				const res = await fetch(url, {
					method,
					...(sent ? { body: sent } : {})
				});
				const body = await res.text();
				const headers: Record<string, string> = {};
				for (const [k, v] of res.headers) headers[k.toLowerCase()] = v;
				this.sql.exec(
					`INSERT INTO cfw_http_cache (key, url, status, headers, body, fetched_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             status = excluded.status, headers = excluded.headers,
             body = excluded.body, fetched_at = excluded.fetched_at,
             expires_at = excluded.expires_at`,
					key,
					url,
					res.status,
					JSON.stringify(headers),
					body,
					this.nowMs(),
					this.nowMs() + ttlFor(method)
				);
				this.sql.exec('DELETE FROM cfw_http_queue WHERE key = ?', key);
				done.push({ url, status: res.status, bytes: body.length });
			} catch (e: any) {
				const attempts = Number(item.attempts ?? 0) + 1;
				const error = String(e?.message ?? e).slice(0, 200);
				// the budget comes from the METHOD. Retrying a POST is not a slower success, it is a
				// different outcome: a single-use captcha token replayed is refused as redeemed, so
				// the visitor is told they failed a check they passed -- and the first attempt may
				// have succeeded at the far end and only failed to return
				if (attempts >= attemptBudget(method)) {
					this.sql.exec('DELETE FROM cfw_http_queue WHERE key = ?', key);
					done.push({ url, dropped: true, error });
				} else {
					this.sql.exec(
						'UPDATE cfw_http_queue SET attempts = ?, last_error = ? WHERE key = ?',
						attempts,
						error,
						key
					);
					done.push({ url, attempts, error });
				}
			}
		}
		return {
			drained: done,
			remaining: Number(
				this.sql
					.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_http_queue')
					.toArray()[0]?.c ?? 0
			)
		};
	}

	/**
	 * The served page cache and the fill queue, in the Durable Object's own SQL.
	 *
	 * Deliberately NOT Drupal's cache_page table. The hit path must not boot PHP at
	 * all -- that is the only path that fits a 10 ms budget -- so it has to be
	 * readable by JS alone. Drupal's own bins stay where they are and serve the
	 * render path.
	 */
	/**
	 * The pack generation this object migrated from, or null.
	 *
	 * A snapshot is only valid for the pack it was booted against: a new pack means a different
	 * tree, so a heap restored across that boundary holds interned paths into files that moved.
	 * The migrate cursor already records the generation, so there is no second source of truth.
	 */
	packGeneration(): string | null {
		try {
			return readMigrateCursor(this.sql)?.generation ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * The emscripten heap, as bytes.
	 *
	 * Neither member is typed by php-wasm, and which one exists depends on the build: `HEAPU8` is
	 * the view emscripten maintains, and `wasmMemory` is the fallback for a build that does not
	 * export it. Returns null when neither is present, because a snapshot of the wrong object
	 * would be a plausible-looking heap of the wrong bytes.
	 */
	heapBytes(binary: SiteBinary): Uint8Array | null {
		const b = binary as unknown as {
			HEAPU8?: unknown;
			wasmMemory?: { buffer?: ArrayBufferLike };
		};
		if (b.HEAPU8 instanceof Uint8Array) return b.HEAPU8;
		const buf = b.wasmMemory?.buffer;
		if (buf) return new Uint8Array(buf);
		return null;
	}

	/**
	 * The vrzno handle table, `Module.targets`.
	 *
	 * Shape-checked rather than cast: the heap stores handle IDs as integers, so a restore that
	 * wrote them into the wrong object would produce a PHP side calling something else entirely --
	 * a failure with no error attached. Returns null when the build has no table, which a restore
	 * then refuses on rather than silently skipping.
	 */
	/**
	 * Keeps every vrzno handle alive for the interpreter's whole life.
	 *
	 * MEASURED, and it is why capture alone was not enough. `Module.targets.byInteger` is php-wasm's
	 * `WeakerMap` -- a `Map` of `WeakRef`s with a `FinalizationRegistry` -- and its iterator DELETES
	 * any entry whose referent has been collected. So a handle PHP acquired during the kernel boot
	 * and did not call again was gone from the table by snapshot time, while the integer was still
	 * sitting in the heap. On the edge that read as `misses: [2]` from `/heap?op=trace`: the restored
	 * heap asked for handle 2 and the table held only handle 1.
	 *
	 * A snapshot cannot fix that after the fact, so the pin goes in before any PHP runs. The strong
	 * set is per-interpreter and per-object, and a booted kernel mints a handful of handles, so this
	 * trades a few retained JS objects for a handle table that still describes the heap.
	 *
	 * `add` is defined non-writable on the index, which is why the whole object is swapped rather
	 * than the method patched; the glue re-reads `Module.targets` at every call site.
	 */
	pinHandles(binary: SiteBinary): number {
		const table = this.handleIndex(binary);
		if (!table) return 0;
		const real = table as unknown as {
			get(id: number): unknown;
			add(o: object): number;
			getId(o: object): number | undefined;
			has(o: object): number | undefined;
			hasId(id: number): unknown;
			remove(id: number): void;
		};
		const pinned = new Set<object>();
		this.pinnedHandles = pinned;
		(binary as unknown as { targets: unknown }).targets = {
			byObject: table.byObject,
			byInteger: table.byInteger,
			get id(): number {
				return table.id;
			},
			set id(v: number) {
				table.id = v;
			},
			get: (id: number) => real.get(id),
			add: (o: object) => {
				const id = real.add(o);
				pinned.add(o);
				return id;
			},
			getId: (o: object) => real.getId(o),
			has: (o: object) => real.has(o),
			hasId: (id: number) => real.hasId(id),
			remove: (id: number) => real.remove(id)
		};
		return pinned.size;
	}

	handleIndex(binary: SiteBinary): HandleIndex | null {
		const t = (binary as unknown as { targets?: unknown }).targets as HandleIndex | undefined;
		if (!t || typeof t !== 'object') return null;
		const ok =
			typeof t.id === 'number' &&
			typeof t.byObject?.set === 'function' &&
			typeof t.byInteger?.set === 'function' &&
			typeof (t.byInteger as unknown as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
				'function';
		return ok ? t : null;
	}

	/**
	 * Writes this object's booted heap into its own SQLite.
	 *
	 * Post-boot, pre-render: a rendered heap is a request-contaminated heap, and the uid-1
	 * cache-poisoning bug is what that contamination looks like when it goes wrong.
	 *
	 * The fd table travels WITH the bytes. The open descriptor table is the load-bearing
	 * part of a restore -- not inode alignment, which was tested and falsified -- so a snapshot
	 * whose descriptors were reconstructed from some other instance is not a snapshot.
	 *
	 * So does the vrzno handle table: the heap stores `Module.targets` ids as bare integers, so a
	 * render through a restored heap died with `TypeError: target is not a function` on a deployed
	 * worker. See `HandleRecord`.
	 */
	async snapshotHeap(opts: { chunkBytes?: number } = {}): Promise<Payload> {
		const { binary } = await this.ensurePhp();
		const heap = this.heapBytes(binary);
		if (!heap) return { ok: false, error: 'no reachable heap on this binary' };
		ensureHeapTables(this.sql);
		const streams = captureStreams(binary.FS as unknown as StreamFS);
		const handles = captureHandles(
			this.handleIndex(binary),
			binary as unknown as Record<string, unknown>
		);
		const t0 = Date.now();
		const written = writeHeapSnapshot(this.sql, {
			// THE LIVE VIEW, NOT A COPY. `toStorableBytes()` exists to survive a `memory.grow()`
			// invalidating a view, and nothing between here and the last chunk insert can grow the
			// heap: no PHP runs, and there is no await. Copying spent a second 64 MB at exactly
			// the moment the isolate had none -- measured `exceededMemory` on the edge
			heap,
			streams,
			handles: handles.handles,
			generation: String(this.packGeneration() ?? ''),
			nowMs: this.nowMs(),
			// the chunk size is the DIVISIBILITY knob, and it is set at write time because `seq *
			// chunkBytes` is how a streaming restore locates a chunk. Measured on the edge: one 2 MB
			// chunk costs 21-52 ms of cpuTime per firing, so the default does not fit a 10 ms cap
			chunkBytes: opts.chunkBytes
		});
		// one snapshot is all a restore needs, and an unbounded table of 40 MB images is the
		// watchdog lesson at a much worse scale
		const dropped = gcHeapSnapshots(this.sql, 1);
		return {
			ok: true,
			...written,
			droppedOlder: dropped,
			streams: streams.length,
			handles: handles.handles.length,
			// surfaced at SNAPSHOT time as well as at restore time: a handle nothing can name makes
			// this image unrestorable, and finding that out one boot later is worse
			unnameableHandles: handles.unnameable,
			heapBytes: heap.length,
			elapsedMs: Date.now() - t0
		};
	}

	/**
	 * Restores a stored heap into this instance, or explains why it refused.
	 *
	 * Called AFTER the mount and after the bridge and capabilities are installed, because those
	 * populate the JS side that the heap's vrzno handles index into. Restoring before them would
	 * leave the interpreter holding indices into an array that does not exist yet.
	 *
	 * The fd table is asserted BEFORE the memcpy and the refusal is loud. Dropping
	 * `/dev/urandom`'s descriptor alone throws `RandomException`; dropping the three sqlite
	 * descriptors gives a locking-protocol error after an **80-120 second stall**, which on the edge
	 * is a hung request rather than an error. A refusal costs one boot; proceeding costs a hang.
	 */
	async tryRestoreHeap(binary: SiteBinary, opts: { maxChunks?: number } = {}): Promise<Payload> {
		// the boot path reads these tables before anything has written them, and it is the ONLY caller
		// that can meet a table older than the code: a deployed object created `cfw_heap_snapshot`
		// before `handle_table` existed, and `CREATE TABLE IF NOT EXISTS` does not add a column, so
		// the first restore after the deploy refused with "no such column: handle_table". Measured on
		// the edge, which is the only place a pre-existing table exists.
		ensureHeapTables(this.sql);
		const meta = latestSnapshotMeta(this.sql, String(this.packGeneration() ?? ''));
		if (!meta) return { restored: false, reason: 'no snapshot for this pack generation' };

		const live = this.heapBytes(binary);
		if (!live) return { restored: false, reason: 'no reachable heap on this binary' };
		if (live.length !== meta.byteLength) {
			// a length mismatch means the snapshot came from a different INITIAL_MEMORY, and
			// writing it would produce a heap that is the wrong size rather than the wrong bytes
			return {
				restored: false,
				reason: `heap is ${live.length} bytes, snapshot is ${meta.byteLength}`
			};
		}

		const index = snapshotPageIndex(this.sql, meta.id);
		if (!index) return { restored: false, reason: 'snapshot metadata without a page index' };

		// the fd assertion, before anything touches linear memory. On the DO path this is a no-op:
		// the database is a host call rather than a file, so there are no descriptors above stdio --
		// which is why the fd contract, measured on a standalone binary with a real .sqlite open,
		// does not bind here
		const replay = replayStreams(binary.FS as unknown as StreamFS, index.streams);
		if (replay.failed.length > 0) {
			return {
				restored: false,
				reason: 'fd replay failed; refusing before any bytes land',
				failed: replay.failed
			};
		}

		// the handle assertion, and the one the fd contract was missing. The heap holds
		// `Module.targets` ids as integers, so every handle the booted kernel captured -- notably
		// `CfwSqlClient::$execFunction` -- is a dead index in a fresh instance until it is
		// re-registered at the SAME id. Without this a render dies as
		// `TypeError: target is not a function`, measured on a deployed worker.
		//
		// Same discipline as the fd table: replay first, refuse before any bytes land, and name
		// every failure at once. Restoring a heap whose handles could not be replayed is worse than
		// not restoring, because the failure surfaces as an uncatchable throw from inside a render.
		const handles = replayHandles(
			this.handleIndex(binary),
			binary as unknown as Record<string, unknown>,
			index.handles
		);
		if (handles.failed.length > 0) {
			return {
				restored: false,
				reason: 'vrzno handle replay failed; refusing before any bytes land',
				failedHandles: handles.failed
			};
		}

		const t0 = Date.now();
		// STREAMS. Nothing larger than one chunk is allocated, because the isolate ceiling is
		// non-monotone (128 MiB failed while 160 succeeded) and a materialising restore passes N
		// times before it fails in production
		const applied = streamRestoreInto(this.sql, live, {
			meta,
			pageIndex: index.pageIndex,
			limit: opts.maxChunks
		});
		this.heapRestoreCursor = applied.complete
			? null
			: {
					snapshotId: meta.id,
					nextChunk: applied.nextChunk,
					totalChunks: applied.totalChunks,
					bytesWritten: applied.bytesWritten,
					firings: 1
				};
		return {
			restored: applied.complete,
			partial: !applied.complete,
			bytes: meta.byteLength,
			digest: meta.digest,
			streamsReplayed: replay.replayed.length,
			handlesReplayed: handles.replayed.length,
			handleNextId: handles.nextId,
			memcpyMs: Date.now() - t0,
			...applied
		};
	}

	/**
	 * Flips one byte of a stored chunk and leaves its digest alone, so the next restore must refuse.
	 *
	 * This exists to make the refusal EXECUTABLE IN PRODUCTION rather than only in a test. The
	 * distinction is not pedantic here: `LAZY_MOUNT` was covered by tests and unreachable in the
	 * deployed worker for its entire life, and the failure this guards against -- a chunk that lands
	 * with the wrong bytes -- produces a heap of the right length that renders something subtly wrong
	 * with no error at all. The only convincing evidence that the guard works is watching a deployed
	 * object refuse a chunk it was actually asked to apply.
	 *
	 * Writes the DIGEST-BEARING side of the pair untouched: corrupting both would restore
	 * cleanly and prove nothing.
	 */
	corruptStoredChunk(seq: number): Payload {
		const meta = latestSnapshotMeta(this.sql, String(this.packGeneration() ?? ''));
		if (!meta) return { ok: false, reason: 'no snapshot for this pack generation' };
		const row = this.sql
			.exec(
				'SELECT bytes, digest FROM cfw_heap_chunk WHERE snapshot_id = ? AND seq = ?',
				meta.id,
				seq
			)
			.toArray()[0] as { bytes: ArrayBufferLike | Uint8Array; digest: string } | undefined;
		if (!row) return { ok: false, reason: `snapshot ${meta.id} has no chunk ${seq}` };

		const bytes = toStorableBytes(row.bytes);
		const at = Math.floor(bytes.length / 2);
		const was = bytes[at] ?? 0;
		const copy = new Uint8Array(bytes);
		copy[at] = was ^ 0xff;
		this.sql.exec(
			'UPDATE cfw_heap_chunk SET bytes = ? WHERE snapshot_id = ? AND seq = ?',
			copy,
			meta.id,
			seq
		);
		return {
			ok: true,
			snapshotId: meta.id,
			seq,
			byteOffset: at,
			was,
			now: copy[at],
			digestLeftIntact: row.digest,
			next: 'GET /heap?op=restore -- the restore must refuse with a chunk digest mismatch'
		};
	}

	/**
	 * Applies the next slice of an in-flight restore. Driven by `alarm()`, never by a request.
	 *
	 * The heap is read back out of the LIVE binary each firing rather than held in a field, because
	 * the cursor is only meaningful for the heap that is actually mounted right now -- if the isolate
	 * were replaced between firings, `this.php` would be null and there would be nothing to resume
	 * onto. That case cannot arise silently: the cursor is in-memory, so it died with the isolate,
	 * and the next boot starts a fresh restore at chunk 0.
	 */
	async restoreStepOnce(): Promise<Payload | null> {
		const cursor = this.heapRestoreCursor;
		if (!cursor) return null;
		if (!this.php) {
			// unreachable in practice (both die together) but the alternative to a named refusal is
			// resuming at chunk N onto a heap of zeros and reporting success
			this.heapRestoreCursor = null;
			return {
				heapRestore: { restored: false, reason: 'isolate replaced; restarting at chunk 0' }
			};
		}

		const meta = latestSnapshotMeta(this.sql, String(this.packGeneration() ?? ''));
		const index = meta ? snapshotPageIndex(this.sql, meta.id) : null;
		const live = this.heapBytes(this.php.binary);
		if (!meta || !index || !live || meta.id !== cursor.snapshotId) {
			this.heapRestoreCursor = null;
			return {
				heapRestore: {
					restored: false,
					reason: 'snapshot changed under an in-flight restore'
				}
			};
		}

		const t0 = Date.now();
		let applied;
		try {
			applied = streamRestoreInto(this.sql, live, {
				meta,
				pageIndex: index.pageIndex,
				from: cursor.nextChunk,
				limit: heapRestoreChunkBudget(this.env)
			});
		} catch (e) {
			// a digest refusal mid-restore. The heap is now partly overwritten and cannot be trusted,
			// so the object must not keep it: drop the interpreter and let the next request boot one
			// from the pack, which is the path that does not depend on the snapshot at all
			this.heapRestoreCursor = null;
			this.php = null;
			this.heapRestore = {
				restored: false,
				reason: String((e as Error)?.message ?? e),
				discardedHeap: true
			};
			return { heapRestore: this.heapRestore };
		}

		cursor.nextChunk = applied.nextChunk;
		cursor.bytesWritten += applied.bytesWritten;
		cursor.firings += 1;
		this.heapRestoreCursor = applied.complete ? null : cursor;
		this.heapRestore = {
			restored: applied.complete,
			partial: !applied.complete,
			bytes: meta.byteLength,
			digest: meta.digest,
			chunksApplied: cursor.nextChunk,
			totalChunks: applied.totalChunks,
			bytesWritten: cursor.bytesWritten,
			firings: cursor.firings,
			memcpyMs: Date.now() - t0
		};
		return { heapRestore: this.heapRestore };
	}

	ensureServeTables(): void {
		if (this.serveTablesReady) return;
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS cfw_page (
        path TEXT PRIMARY KEY,
        status INTEGER NOT NULL,
        content_type TEXT,
        html TEXT NOT NULL,
        rendered_at INTEGER NOT NULL,
        render_ms REAL
      )`
		);
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS cfw_fill_queue (
        path TEXT PRIMARY KEY,
        queued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      )`
		);
		// scalars the Worker needs cheaply; the generation counter lives here rather
		// than in ctx.storage.kv because a bump can fire from inside execSql(), which
		// is synchronous PHP-facing code that cannot await
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS cfw_meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      )`
		);
		// the health ledger sits with the serve tables because `repair_state` lives in cfw_meta and
		// the quarantine check reads it on every alarm; a lazily-created ledger would mean the first
		// finding is the one that cannot be recorded
		ensureHealthTable(this.sql);
		this.serveTablesReady = true;
	}

	/**
	 * Folds the writes accumulated since the last flush into a per-UTC-day total.
	 *
	 * Flushed on the alarm, never per write, and that is a correctness requirement rather than an
	 * optimisation: persisting the counter costs a row write, so a per-write flush would DOUBLE
	 * the number it is measuring. Once per firing it is one row against a batch of them, and that
	 * row is itself counted, so the meter includes its own cost.
	 *
	 * Keyed by UTC date because the limit is daily and the object is not. A Durable Object is
	 * evicted whenever Cloudflare likes, so an in-memory lifetime counter reports a fraction of
	 * the day and reads as healthy; the date key means an eviction loses at most the writes since
	 * the last alarm rather than the whole day.
	 *
	 * @returns the running total for today, after folding in whatever had accumulated.
	 */
	flushDailyRows(nowMs = this.nowMs()): number {
		const today = new Date(nowMs).toISOString().slice(0, 10);
		const key = `rows_written_${today}`;
		const pending = this.rowsSinceFlush ?? 0;
		if (pending === 0) return Number(this.metaGet(key, '0') ?? 0);
		this.rowsSinceFlush = 0;
		const total = Number(this.metaGet(key, '0') ?? 0) + pending;
		this.metaSet(key, total);
		// yesterday's key is left in place: one row per day is nothing, and a
		// history of daily totals is what makes "is this site trending over" answerable at all
		return total;
	}

	/** today's rows written, without flushing -- for a read that must not write */
	dailyRows(nowMs = this.nowMs()): number {
		const today = new Date(nowMs).toISOString().slice(0, 10);
		return Number(this.metaGet(`rows_written_${today}`, '0') ?? 0) + (this.rowsSinceFlush ?? 0);
	}

	/**
	 * Folds this firing's Durable Object invocations into a per-UTC-day total.
	 *
	 * Counted because the DO-request quota is one of the two daily ceilings the whole architecture is
	 * scored against, and the limits page reported "nothing measures this yet" for it -- an
	 * unmeasured meter beside a measured one reads as the healthy one.
	 *
	 * IT COUNTS WHAT REACHED THIS OBJECT, which is the honest scope: a request answered by the edge
	 * cache never enters the isolate, so this is the DO meter and explicitly not the Worker-request
	 * meter. Conflating them would report a confident wrong number for the serving ceiling.
	 */
	flushDailyDoRequests(nowMs = this.nowMs()): number {
		const today = new Date(nowMs).toISOString().slice(0, 10);
		const key = `do_requests_${today}`;
		const pending = this.doRequestsSinceFlush ?? 0;
		if (pending === 0) return Number(this.metaGet(key, '0') ?? 0);
		this.doRequestsSinceFlush = 0;
		const total = Number(this.metaGet(key, '0') ?? 0) + pending;
		this.metaSet(key, total);
		return total;
	}

	/**
	 * Drops the caches that embed the Drupal core version, once, when that version has moved.
	 *
	 * Guarded by an in-memory flag so a warm object pays one `cfw_meta` read per lifetime rather
	 * than one per request. The flag is deliberately NOT persisted: an object that is evicted
	 * mid-upgrade must re-check, and the version comparison is itself idempotent.
	 */
	private coreVersionChecked = false;

	invalidateOnCoreUpgrade(): InvalidationResult | null {
		if (this.coreVersionChecked) return null;
		this.coreVersionChecked = true;
		try {
			return invalidateVersionPinnedCaches(
				this.sql,
				this.metaGet(CORE_VERSION_KEY),
				SHIPPED_CORE_VERSION,
				(version) => this.metaSet(CORE_VERSION_KEY, version)
			);
		} catch {
			// never take the serving path down over a cache-busting nicety
			return null;
		}
	}

	/**
	 * How many stored pages are shareable shells, and why the rest are not.
	 *
	 * Authenticated HTML is never cached. What can be is the part identical for everyone, with the
	 * per-user regions left as BigPipe placeholders -- so the question "is that worth building here"
	 * is answerable from the pages a site has already rendered, without building it.
	 *
	 * Counted rather than assumed. A site whose theme does not auto-placeholder anything has zero
	 * candidates and gains nothing from fragment assembly however well it is implemented.
	 */
	shellCandidates(): { safe: number; unsafe: number; reasons: Record<string, number> } {
		// self-sufficient rather than relying on the caller: /__serve-stats happens to call
		// ensureServeTables() first, and nothing enforced that ordering
		this.ensureServeTables();
		const rows = this.sql.exec<{ html: string }>('SELECT html FROM cfw_page').toArray();
		let safe = 0;
		let unsafe = 0;
		const reasons: Record<string, number> = {};
		for (const row of rows) {
			const verdict = shellSafety(String(row.html ?? ''));
			if (verdict.safe) {
				safe++;
				continue;
			}
			unsafe++;
			reasons[verdict.reason] = (reasons[verdict.reason] ?? 0) + 1;
		}
		return { safe, unsafe, reasons };
	}

	/**
	 * Where this site sits on the quota ladder.
	 *
	 * Reads the two DAILY meters this object already keeps and hands them to `degradation()`. Both
	 * reset at midnight UTC, so a degraded site recovers on its own without anybody clearing a flag
	 * -- which is why nothing here is persisted.
	 *
	 * Cheap enough for the serving path: two `cfw_meta` reads that are already warm, no await.
	 */
	degradation(nowMs = this.nowMs()): Degradation {
		const rowsLimit = dailyLimit('rows-written', this.env);
		const doLimit = dailyLimit('do-requests', this.env);
		return degradation({
			rowsFraction: rowsLimit > 0 ? this.dailyRows(nowMs) / rowsLimit : 0,
			doFraction: doLimit > 0 ? this.dailyDoRequests(nowMs) / doLimit : 0
		});
	}

	/** today's DO invocations, without flushing */
	dailyDoRequests(nowMs = this.nowMs()): number {
		const today = new Date(nowMs).toISOString().slice(0, 10);
		return (
			Number(this.metaGet(`do_requests_${today}`, '0') ?? 0) +
			(this.doRequestsSinceFlush ?? 0)
		);
	}

	/**
	 * Writes this site's row into the fleet inventory, when there is anything worth writing.
	 *
	 * Silent when no D1 binding exists, which is the free-tier default and not an error: a single
	 * site does not need an inventory, and the whole point of the predicate is that the steady
	 * state costs one row per site per day.
	 */
	async reportToFleet(): Promise<void> {
		const db = (this.env as { FLEET_DB?: FleetDb | null })?.FLEET_DB;
		if (!db) return;
		try {
			const current: FleetRow = {
				// the DO is addressed by idFromName(site), so its own id carries the site name
				site: this.ctx.id.name ?? 'site',
				packGeneration: String(this.packGeneration() ?? ''),
				coreVersion: SHIPPED_CORE_VERSION,
				workerVersion: String(
					(this.env as { CF_VERSION_METADATA?: { id?: string } })?.CF_VERSION_METADATA
						?.id ?? 'unknown'
				),
				plan: isPaid(this.env) ? 'paid' : 'free',
				lastSeenMs: this.nowMs()
			};
			const raw = this.metaGet('fleet_last');
			const previous = (raw ? JSON.parse(raw) : null) as FleetRow | null;
			if (!shouldReport(previous, current, current.lastSeenMs)) return;
			await ensureFleetTable(db);
			await reportSite(db, current);
			this.metaSet('fleet_last', JSON.stringify(current));
		} catch (e: any) {
			// an inventory write that failed must never take down the alarm that serves the site
			this.lastFleetError = String(e?.message ?? e);
		}
	}

	/**
	 * What the object can see about itself at the end of an alarm.
	 *
	 * Every field is a scalar the caller already had or a ring capped at 8, so this cannot become a
	 * full-table scan on a path that runs every firing. `countOrNull()` is the one exception and it
	 * is why `semaphoreRows` is omitted on an unmigrated site rather than reported as 0: a table
	 * that does not exist is not an invariant that holds.
	 */
	observe(outcomes: (Payload | null)[]): Observation {
		const last = [...outcomes].reverse().find((o) => o?.filled) ?? null;
		const path = last ? String(last.filled) : undefined;
		const bytes = last && typeof last.bytes === 'number' ? last.bytes : undefined;

		const heap = this.php ? (this.heapBytes(this.php.binary)?.length ?? 0) : 0;
		if (heap > 0) this.memoryRing.push(heap);
		const rowsToday = this.dailyRows();
		const doToday = this.dailyDoRequests();
		this.rowsRing.push(rowsToday);
		this.doRing.push(doToday);

		const semaphore = this.countOrNull('semaphore');
		const migrate = this.migrateCursorOrNull();
		const updb = this.lastUpdb;

		const obs: Observation = {
			asyncifyCalls: shimGlobals.__cfwAsyncifyCalls ?? 0,
			memorySamples: this.memoryRing.samples(),
			rowsWritten: rowsToday,
			doRequests: doToday,
			rowsWrittenSamples: this.rowsRing.samples(),
			doRequestsSamples: this.doRing.samples(),
			ledgerRows: Number(
				this.sql
					.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_health')
					.toArray()[0]?.c ?? 0
			)
		};
		if (path !== undefined) obs.path = path;
		if (bytes !== undefined) {
			obs.status = 200;
			obs.bytes = bytes;
			// read the baseline BEFORE recording this render into it, or the render sets the median
			// it is about to be judged against
			const median = this.medianRenderBytes(path ?? '');
			if (median !== null) obs.medianBytes = median;
			this.noteRenderBytes(path ?? '', bytes);
		}
		if (semaphore !== null) obs.semaphoreRows = semaphore;
		if (migrate) {
			obs.migrateChunk = Number(migrate.chunk ?? 0);
			obs.migrateChunks = Number(migrate.chunks ?? 0);
		}
		if (updb && typeof updb.phase === 'string') obs.updbPhase = updb.phase;
		// the daily quotas are FREE's hard caps, so they are the limit only on free. On paid the
		// same meters are billed rather than capped, and a budget tripwire against a number nobody
		// enforces is exactly the decoration this layer is not allowed to be
		if (isFree(this.env)) {
			obs.rowsWrittenLimit = DAILY_ROWS_QUOTA;
			obs.doRequestsLimit = DAILY_DO_QUOTA;
		}

		// The third meter, projected from configuration rather than counted from traffic.
		//
		// `countOrNull` returns null on an unmigrated site, and null is NOT zero here: a site with no
		// `config` table has no image styles yet, and reporting 0 would read as a verified "nothing
		// to worry about" on exactly the sites that have not been configured. So the projection is
		// omitted rather than guessed, and the tripwire cannot fire on it.
		const styles = this.countOrNull('config', "name LIKE 'image.style.%'");
		const images = this.countOrNull('file_managed', "filemime LIKE 'image/%'");
		if (styles !== null && images !== null) {
			const projection = projectImageTransforms({ images, styles }, this.env);
			obs.imageTransforms = projection.uniques;
			if (projection.limit !== null) obs.imageTransformsLimit = projection.limit;
		}
		const pack = this.packGeneration();
		const db = this.metaGet('pack_generation');
		if (pack && db) {
			obs.packGeneration = pack;
			obs.dbGeneration = db;
		}
		return obs;
	}

	/**
	 * The rolling median body size for one path, over PREVIOUS renders only.
	 *
	 * Reading `cfw_page` instead would compare the render against the row it just wrote -- a ratio
	 * of exactly 1.00 every time, so `renderSizeAnomaly` could not fire at all. The 90,038-byte
	 * admin page served to an anonymous visitor is the incident that check exists for, and it is
	 * detectable only against the path's own history.
	 *
	 * In memory and capped, like `pageHits`: an eviction should forget the baseline rather than
	 * compare a fresh render against a stale one, and history in SQL would cost a row per render on
	 * the meter that binds.
	 */
	medianRenderBytes(path: string): number | null {
		const seen = this.pageBytes.get(path);
		if (!seen || seen.length < RENDER_BYTES_MIN_SAMPLES) return null;
		const sorted = [...seen].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 === 0
			? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
			: (sorted[mid] ?? null);
	}

	/** records one render's size AFTER the median for it was taken, so a render never sets its own baseline */
	noteRenderBytes(path: string, bytes: number): void {
		if (!path || !Number.isFinite(bytes) || bytes <= 0) return;
		const seen = this.pageBytes.get(path) ?? [];
		seen.push(bytes);
		if (seen.length > RENDER_BYTES_SAMPLES) seen.splice(0, seen.length - RENDER_BYTES_SAMPLES);
		this.pageBytes.set(path, seen);
		// an unbounded map is how the watchdog table got to 46% of the database; the busiest paths
		// are the ones a size anomaly matters on, so the coldest entry is the one to drop
		if (this.pageBytes.size > RENDER_BYTES_PATHS) {
			const oldest = this.pageBytes.keys().next();
			if (!oldest.done) this.pageBytes.delete(oldest.value);
		}
	}

	/**
	 * Runs the host tripwires and moves the repair ladder.
	 *
	 * ON THE ALARM AND NOWHERE ELSE. Two reasons, and neither is style: `recordFinding()` is a row
	 * write and rows written is the meter that binds the regeneration ceiling, so a per-request
	 * tripwire pass would spend the budget it exists to watch; and a waiting visitor outranks
	 * bookkeeping, which is the same rule that puts GC and cron after the fills.
	 *
	 * The state is persisted only when it CHANGES. A healthy site writes zero rows here, so the
	 * whole layer is free until something is actually wrong.
	 */
	supervise(outcomes: (Payload | null)[]): Finding[] {
		let findings: Finding[];
		try {
			findings = runHostTripwires(this.observe(outcomes));
		} catch (e: any) {
			// the health layer must never be the thing that takes the site down; a tripwire that
			// throws is a defect in the tripwire, not evidence about the site
			this.lastFindings = [
				{
					code: 'health.observe_failed',
					severity: 'warn',
					scope: 'supervisor',
					context: String(e?.message ?? e)
				}
			];
			return this.lastFindings;
		}
		this.lastFindings = findings;

		const before = parseState(this.metaGet('repair_state'));
		const decision = quarantineDecision(findings);
		// ERROR AND ABOVE IS A FAILURE, not critical-only. Keying the ladder on `quarantineDecision`
		// alone would record an error-severity finding and then advance the state as though the pass
		// were clean -- `bridge.asyncify_called` fires on a dead stream wrapper that kills the whole
		// invocation, and three of those is a durable condition whatever its severity label says.
		// `warn` is deliberately not a failure: budget pressure and a memory trend are things to
		// watch at the next quiet moment, and striking on them would quarantine a healthy busy site.
		const failing = findings.filter((f) => SEVERITY[f.severity] >= SEVERITY.error);
		const after =
			failing.length > 0
				? recordOutcome(
						before,
						{ ok: false, code: failing[0]?.code ?? 'unknown' },
						this.nowMs()
					)
				: recordOutcome(before, { ok: true }, this.nowMs());

		for (const f of findings) {
			recordFinding(this.sql, f, this.nowMs(), after.rung, decision.reason, after.strikes);
		}
		const serialised = serialiseState(after);
		if (serialised !== serialiseState(before)) this.metaSet('repair_state', serialised);
		return findings;
	}

	/** the meta table as a {@link SecretStore}, so the mint needs no Durable Object to test against */
	secretStore(): SecretStore {
		return {
			get: (key: string) => this.metaGet(key),
			set: (key: string, value: string) => this.metaSet(key, value)
		};
	}

	metaGet(key: string, fallback: string | null = null): string | null {
		this.ensureServeTables();
		const row = this.sql
			.exec<Row<{ v: string }>>('SELECT v FROM cfw_meta WHERE k = ?', key)
			.toArray()[0];
		return row === undefined ? fallback : String(row.v);
	}

	metaSet(key: string, value: unknown): void {
		this.ensureServeTables();
		this.sql.exec(
			'INSERT INTO cfw_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
			key,
			String(value)
		);
	}

	/**
	 * The `scheme://host[:port]` this site renders absolute URLs against.
	 *
	 * Reads the ladder in `src/ops/site-origin.ts` and PINS on first use, so the value stops being a
	 * function of the request as soon as one real request has arrived. The pin is one `cfw_meta`
	 * row; a local origin is never pinned, or running the suite against a persisted object would fix
	 * a real site's canonical URL to a developer's laptop.
	 *
	 * @param observed - `url.origin` of the request being served, which in production IS the
	 *   visitor's scheme and host: the Worker forwards `new URL(request.url)` with only the pathname
	 *   swapped, so the origin crosses into the object unchanged. `do.local` in the specs is a
	 *   harness artifact and is refused by {@link pinnable} for that reason.
	 */
	canonicalOrigin(observed?: string | null): string {
		const chosen = chooseOrigin({
			configured: this.env?.SITE_ORIGIN,
			pinned: this.metaGet(ORIGIN_KEY),
			observed
		});
		if (chosen.from === 'observed' && pinnable(chosen.origin)) {
			this.metaSet(ORIGIN_KEY, chosen.origin);
		}
		return chosen.origin;
	}

	/**
	 * Which site this object is, pinned the way the origin is.
	 *
	 * The object had no notion of its own identity at all, so `drainPageMirrors()` could not be
	 * given one and fell back to the literal `'site'`. On a deployment serving several sites with
	 * one bound bucket, every object wrote `p/site/<gen>/index.html` and the last one to drain won.
	 */
	siteName(observed?: string | null): string {
		const pinned = this.metaGet(SITE_NAME_KEY);
		if (pinned !== null && pinned !== '') return pinned;
		const seen = (observed ?? '').trim();
		if (seen === '') return 'site';
		this.metaSet(SITE_NAME_KEY, seen);
		return seen;
	}

	/**
	 * The site generation: one integer that every edge cache key carries.
	 *
	 * Drupal's cache tags cannot purge a URL-keyed edge cache -- tag purge is an
	 * Enterprise feature -- so invalidation is done by making every previously
	 * cached URL unreachable instead of by deleting anything. Appending this to the
	 * key means one integer write invalidates the whole site, everywhere, for free.
	 */
	generation(): number {
		const raw = this.metaGet('generation');
		if (raw === null) {
			this.metaSet('generation', 1);
			return 1;
		}
		const n = Number(raw);
		return Number.isFinite(n) && n > 0 ? n : 1;
	}

	/**
	 * Invalidates the whole site: bump the counter, drop the Durable Object's own
	 * page cache.
	 *
	 * Both halves are required. The counter orphans the edge entries; without the
	 * DELETE the next request would edge-miss, reach the DO, be served the same
	 * stale HTML out of cfw_page and be re-cached under the new generation.
	 *
	 * Deliberately coarse: one node save purges every page. That is the trade the
	 * cheap answer buys, and it is safe in the direction that matters. Purged paths
	 * are NOT requeued -- the first visitor to each one now renders inline (see
	 * /__serve), so pages come back on demand instead of the alarm chain
	 * re-rendering URLs nobody asked for.
	 */
	/**
	 * @param arm false requeues without waking the chain, leaving the caller to arm it.
	 *   A long-running write needs that: `armFillAlarm()` schedules at +1 ms and does not await
	 *   the write, so a fill starts while the caller still has seconds of work in the same event.
	 */
	bumpGeneration(reason = 'manual', { arm = true }: { arm?: boolean } = {}) {
		this.ensureServeTables();
		const next = this.generation() + 1;

		// save-triggered prefill.
		//
		// The paths have to be read BEFORE the DELETE below, which is the subtlety: a
		// bump purges every cached page, so a content editor saved and the next visitor to
		// each previously-warm URL got a 202 while the alarm chain caught up. Re-queueing
		// what was just purged means those URLs are re-rendered in the background and the
		// next visitor gets a HIT.
		//
		// Requeued rather than kept: the stored HTML is genuinely stale after a save, so
		// serving it would be wrong. This trades a 202 window for a fill, which is the
		// trade the fill queue exists to make.
		const doomed = this.sql
			.exec<Row<{ path: string }>>(
				'SELECT path FROM cfw_page ORDER BY rendered_at DESC LIMIT ?',
				prefillOnSaveLimit(this.env) + 1
			)
			.toArray()
			.map((r) => String(r.path));
		const limit = prefillOnSaveLimit(this.env);
		const requeue = doomed.slice(0, limit);
		// NOT silent: a site with more cached pages than the cap loses the tail, and rows
		// written is the free plan's binding meter, which is what the cap protects
		const droppedFromRequeue = Math.max(0, doomed.length - requeue.length);

		const purgedPages = Number(
			this.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_page').toArray()[0]
				?.c ?? 0
		);
		this.sql.exec('DELETE FROM cfw_page');
		this.metaSet('generation', next);
		this.metaSet('last_bump', `${next}:${reason}:${this.nowMs()}`);
		this.bumps = (this.bumps ?? 0) + 1;

		let requeued = 0;
		if (prefillOnSave(this.env)) {
			for (const path of requeue) {
				this.sql.exec(
					'INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING',
					path,
					this.nowMs()
				);
				requeued++;
			}
			// the chain only runs if something wakes it, and a bump is not otherwise a wake-up
			if (requeued > 0 && arm) this.armFillAlarm();
		}

		return { generation: next, reason, purgedPages, requeued, droppedFromRequeue };
	}

	/**
	 * Arms the fill alarm without disturbing one that is already sooner.
	 *
	 * Extracted because `bumpGeneration()` is synchronous and cannot await
	 * `getAlarm()`; overwriting an existing alarm here would push a pending fill
	 * chain out. Fire-and-forget is safe: the worst case is an alarm at +1 ms that
	 * finds nothing to do.
	 */
	armFillAlarm(): void {
		try {
			const armed = this.ctx.storage.setAlarm(this.nowMs() + 1);
			if (armed && typeof armed.catch === 'function') armed.catch(() => {});
		} catch {
			/* an unschedulable alarm must not fail the save that triggered it */
		}
	}

	/**
	 * Every Drupal statement, plus the automatic invalidation trigger.
	 *
	 * Suppressed during /__migrate: replaying the packed site inserts the packed
	 * cachetags rows, which is setup rather than a content change.
	 *
	 * Coalesced, because one content save invalidates many tags and each tag is its
	 * own `merge('cachetags')`. Once a bump has happened there is nothing left to
	 * invalidate, so further writes are ignored until a page is cached again --
	 * fillOne() clears the flag. Without this a node save would bump the generation
	 * dozens of times and re-run DELETE on an already-empty table for each.
	 */
	override execSql(sql: string, params?: SqlBindings): ExecSqlResult {
		// THE ONLY INSTRUMENT THAT SEES INSIDE AN INVOCATION THAT DIES. A Durable Object reset
		// rolls back every row it wrote, so a trace written to SQL is gone with the thing it was
		// tracing; console.log reaches the Tail Worker and survives the isolate that produced it.
		// Emitted BEFORE the statement runs, so the last line in the tail names the one that
		// killed the object rather than the last one that succeeded.
		if (this.env?.PW_SQL_TRACE === '1') {
			this.sqlTraceSeq = (this.sqlTraceSeq ?? 0) + 1;
			// A TAIL EVENT IS CAPPED AT 256 KB ACROSS ALL console.log OUTPUT, and a full trace of
			// an install blows it at ~1,005 statements -- the log then stops mid-run and reads
			// exactly like the object dying there. `PW_SQL_TRACE_FROM` spends the budget on the
			// end of the run instead, which is where the failure is
			const from = Number(this.env?.PW_SQL_TRACE_FROM ?? 0);
			if (this.sqlTraceSeq >= from) {
				console.log(`cfwsql ${this.sqlTraceSeq} ${sql.replace(/\s+/g, ' ').slice(0, 60)}`);
			}
		}
		const result = super.execSql(sql, params);
		// the tally used to be taken HERE, and that was the bug. This override is the PHP driver's
		// entry point, so it sees Drupal's statements and nothing else -- every write the host makes
		// on its own behalf goes through `this.sql.exec()` directly. Counting moved into
		// `countingSql()`, which wraps the storage handle itself and therefore sees both halves;
		// super.execSql() runs through that same wrapped handle, so these statements are still
		// counted, exactly once.
		if (!this.suppressBump && !this.bumpCoalesced && CACHETAG_WRITE.test(sql)) {
			this.bumpCoalesced = true;
			this.bumpGeneration('cachetags');
		}
		return result;
	}

	/**
	 * Fills one path: from the alarm chain, or inline for the visitor who missed.
	 *
	 * One page per firing, then re-arm if anything is left. Each firing is its own
	 * invocation with its own CPU budget -- measured on deployed infrastructure: 20
	 * Durable Object invocations did 142 ms of CPU for one client request with no
	 * single invocation above 10 ms. That splits a large TOTAL across invocations;
	 * it does not enlarge any one of them, so a single 20 ms render still does not
	 * fit a 10 ms free-plan cap in either an alarm or a fetch. What the chain buys
	 * is that nobody is waiting.
	 *
	 * `targetPath` renders that path instead of the queue head, which is what the
	 * inline MISS path needs: the queue is FIFO, so without it a request would
	 * render somebody else's page and still have nothing to return.
	 *
	 * `bins` is passed through to renderPage(). The default empties both, which is a
	 * real render; `['page']` leaves dynamic_page_cache warm and reassembles instead,
	 * which is what /__assemble measures.
	 *
	 * @param destruct false reproduces the pre-fix lifecycle; see renderPage()
	 */
	/**
	 * Counts a failure against the queue head when the fill THREW rather than reported.
	 *
	 * The three-strikes rule lives inside `fillOne()`, which means it only runs when the render
	 * comes back with an error to record. A JS-level throw -- an uncatchable one out of the wasm
	 * import, say -- skips it entirely, and the row it should have struck is the row the alarm
	 * re-arm reads to decide whether to fire again in 1 ms. That combination is a spin, and it was
	 * measured as one.
	 *
	 * @returns the attempts now recorded, or null when the queue was empty
	 */
	strikeFillHead(error: string): number | null {
		this.ensureServeTables();
		const head = this.sql
			.exec<Row<{ path: string; attempts: number }>>(
				'SELECT path, attempts FROM cfw_fill_queue ORDER BY queued_at LIMIT 1'
			)
			.toArray()[0];
		if (!head) return null;
		const attempts = Number(head.attempts ?? 0) + 1;
		if (attempts >= 3) {
			this.sql.exec('DELETE FROM cfw_fill_queue WHERE path = ?', String(head.path));
		} else {
			this.sql.exec(
				'UPDATE cfw_fill_queue SET attempts = ?, last_error = ? WHERE path = ?',
				attempts,
				error.slice(0, 400),
				String(head.path)
			);
		}
		return attempts;
	}

	async fillOne(
		targetPath: string | null = null,
		bins: string[] = ['page', 'dynamic_page_cache'],
		destruct: boolean | string = false,
		// the inbound method and body, so a form submission reaches Drupal AS one. Absent means GET,
		// which is what every caller did implicitly before this parameter existed
		request: RenderRequest = {}
	): Promise<FillOutcome> {
		this.ensureServeTables();
		const startedAt = Date.now();
		// whether THIS fill will also boot the interpreter. A boot-inclusive measurement is not a
		// render measurement and must never become the warm estimate -- see below
		const bootedBeforeFill = this.php !== null;
		let path: string;
		let attempts: number;
		if (targetPath === null) {
			const next = this.sql
				.exec<Row<{ path: string; attempts: number }>>(
					'SELECT path, attempts FROM cfw_fill_queue ORDER BY queued_at LIMIT 1'
				)
				.toArray()[0];
			if (!next) return { filled: null, remaining: 0 };
			path = String(next.path);
			attempts = Number(next.attempts ?? 0);
		} else {
			path = String(targetPath);
			attempts = Number(
				this.sql
					.exec<Row<{ attempts: number }>>(
						'SELECT attempts FROM cfw_fill_queue WHERE path = ?',
						path
					)
					.toArray()[0]?.attempts ?? 0
			);
		}
		// defaulted here rather than at the call sites, because the alarm chain fills most pages and
		// it has no request to read an origin from. Without this, an inline render carried the real
		// host and the alarm-filled copy of the same page carried `localhost` -- so which absolute
		// URLs a visitor got would depend on which lane happened to render their page.
		const origin = request.origin ?? this.canonicalOrigin(null);
		// bracket the render so the tally is PER RENDER rather than per object lifetime; the boot
		// crossings that precede the first render would otherwise be charged to it
		const crossingsBefore = this.crossings
			? snapshotCrossings(this.crossings)
			: emptyCrossings();
		const result = await this.runJson(renderPage(path, bins, destruct, { ...request, origin }));
		if (this.crossings) {
			this.lastRenderCrossings = crossingsSince(crossingsBefore, this.crossings);
		}
		// Wall-clock, not the in-PHP clock: neither ADVANCES on the edge.
		//
		// Not "returns 0", which is what this comment used to say and what RULE 0 still says as
		// shorthand: `microtime()` returns a real epoch (measured -- 1787454264.88 in workerd,
		// through the glue's `_emscripten_date_now = () => Date.now()`), it just does not move.
		// A DELTA taken from it is 0 and that is the part that matters here.
		//
		// and the wall clock reads 0 out there too -- measured, 16 assembly renders and
		// 6 full renders all reported wallMs 0 on a deployed worker while tail charged
		// them 27-120 ms of cpuTime. Date.now() is frozen during synchronous execution
		// and a render performs no I/O, so nothing advances it. Storing that 0 made
		// estimateRenderMs() return 0 and the inline budget guard always pass, which is
		// the opposite of what it exists for. A 0 delta means "unmeasurable here", not
		// "free", so it is refused rather than believed.
		const observedMs = Date.now() - startedAt;
		// a non-zero wall reading is not automatically a valid measurement, and believing one was
		// the defect. Measured on a deployed worker: a cold alarm fill reported an estimate of
		// **117 ms for work that cost 1,398 ms of cpuTime**. The wall clock only advances during
		// I/O, so that 117 ms was the asset-fetch time and nothing else -- the synchronous boot and
		// render contributed zero. Because it was non-zero, `renderClockUnmeasurable` never tripped,
		// so the guard that exists to refuse an over-budget inline render would wave a 1.4 s boot
		// straight through.
		//
		// So a reading is only kept as the WARM estimate when the interpreter was already up. A
		// fill that booted is a boot measurement, and it is discarded rather than averaged in.
		if (observedMs > 0 && bootedBeforeFill) {
			this.lastRenderMs = observedMs;
		} else if (observedMs <= 0) {
			this.renderClockUnmeasurable = true;
		} else {
			// booted during this fill: the number is real wall time but measures the wrong thing
			this.renderClockUnmeasurable = true;
			this.lastBootInclusiveMs = observedMs;
		}

		// A REDIRECT TO THE INSTALLER IS NOT A PAGE, it is the database saying it is not ready.
		// Reachable only since `cfw_serve()` started passing `$catch = TRUE`: before that, rendering
		// against an absent database threw and took the retry path, and now Drupal answers the way it
		// answers a browser -- 302 to /core/install.php. Storing that is how a site serves "install
		// me" to every visitor until something invalidates it, so it takes the retry path instead and
		// the path keeps answering 503 until the migration lands.
		const installerRedirect = String(result.location ?? '').includes('/core/install.php');
		if (result.error || typeof result.html !== 'string' || installerRedirect) {
			const error = installerRedirect
				? 'the site is not installed yet; Drupal redirected to the installer'
				: String(result.error ?? 'render produced no html').slice(0, 400);
			// three strikes, then drop it, so one poisoned path cannot own the alarm
			if (attempts + 1 >= 3) {
				this.sql.exec('DELETE FROM cfw_fill_queue WHERE path = ?', path);
			} else {
				this.sql.exec(
					'UPDATE cfw_fill_queue SET attempts = ?, last_error = ? WHERE path = ?',
					attempts + 1,
					error,
					path
				);
			}
			return {
				filled: null,
				failed: path,
				error,
				attempts: attempts + 1,
				remaining: this.queueDepth()
			};
		}

		// A SUBMISSION IS NEVER CACHED. `cfw_page` is keyed by PATH alone, so storing the response to
		// a POST would hand the next visitor the previous submitter's result -- their validation
		// errors, their form values, and on an authenticated form their data. The whole serving
		// story is not-rendering, which makes an unguarded write here the expensive kind of bug.
		//
		// A SESSION IS THE SAME HAZARD ON A GET. A logged-in visitor's page carries their name, their
		// contextual links and their CSRF token, and the key still has no user in it -- so a request
		// that ARRIVED with a cookie, or a response that SETS one, is refused storage for the same
		// structural reason the edge refuses it in `putPage()`. Both directions, because the login
		// POST and the authenticated GET that follows it fail differently.
		//
		// A 5xx IS NOT A PAGE EITHER, and it became reachable when `cfw_serve()` started letting
		// Drupal render its own error pages: before that an exception surfaced as `result.error` and
		// took the retry path, where now it arrives as a perfectly well-formed 500 that would be
		// stored and served to everyone until the next invalidation.
		//
		// a 3xx is not a page at all, and this one shipped: `cfw_page` has no `location` column and
		// `pageResponse()` cannot set a header it has no value for, so a stored redirect replays
		// forever as a bodyless 3xx pointing nowhere -- a dead end the visitor cannot follow and the
		// next fill cannot clear. Found on Drupal's own asset controller, which 301s an aggregate
		// whose hash does not match. The `page` branch below carries `location` through to
		// `/__serve`, so refusing storage is also what makes the redirect WORK.
		// AND THE RENDER'S OWN ANSWER TO "WHO WAS THIS FOR". Every clause above reasons about the
		// REQUEST; `uid` is what Drupal concluded, and the fragment that computes it already says why
		// -- a render that comes back as the wrong user is not distinguishable from a correct one by
		// its bytes. It was transported and read by nobody, so the one failure this project actually
		// shipped, uid 1 surviving inside the persistent interpreter with no cookie in sight, was
		// invisible to a check made on the cookie.
		const setCookie = Array.isArray(result.setCookie) ? (result.setCookie as string[]) : [];
		const status = Number(result.status ?? 200);
		const renderedFor =
			result.uid === null || result.uid === undefined ? 0 : Number(result.uid);
		// and what Drupal ASKED FOR: `page_cache_kill_switch` and every module with a reason to
		// opt out say so here, and nothing read it, so an explicitly uncacheable page was stored
		const refused = /(^|,)\s*(no-store|private)\s*(,|$)/i.test(
			String(result.cacheControl ?? '')
		);
		const cacheable =
			(request.method ?? 'GET').toUpperCase() === 'GET' &&
			!request.cookie &&
			setCookie.length === 0 &&
			renderedFor === 0 &&
			!refused &&
			status < 500 &&
			!(status >= 300 && status < 400);
		if (cacheable) {
			this.sql.exec(
				`INSERT INTO cfw_page (path, status, content_type, html, rendered_at, render_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         status = excluded.status,
         content_type = excluded.content_type,
         html = excluded.html,
         rendered_at = excluded.rendered_at,
         render_ms = excluded.render_ms`,
				path,
				status,
				String(result.contentType ?? 'text/html; charset=utf-8'),
				result.html,
				this.nowMs(),
				Number(result.renderMs ?? 0)
			);
		}
		this.sql.exec('DELETE FROM cfw_fill_queue WHERE path = ?', path);
		// something is cacheable again, so the next tag invalidation has work to do
		this.bumpCoalesced = false;

		// Queued on FILL rather than on request, so the queue depth tracks regeneration and not
		// traffic. Only when a bucket is bound: with none, this table would grow forever behind a
		// drain that can never run, and no bucket is the free-tier default rather than an error.
		//
		// and only when the page was STORED: the drain re-reads `cfw_page`, so queuing a refused
		// render publishes the previous bytes under the new generation key
		if (cacheable && this.mirrorBucket()) {
			queuePageMirror(this.sql, path, this.generation(), this.nowMs());
		}

		return {
			filled: path,
			bytes: result.bytes,
			renderMs: result.renderMs,
			pageCache: result.pageCache,
			dynamicCache: result.dynamicCache,
			// what this fill ACTUALLY paid for, not what the caller predicted
			bootedInFill: !bootedBeforeFill,
			remaining: this.queueDepth(),
			...(cacheable
				? {}
				: {
						page: {
							status,
							contentType: String(result.contentType ?? 'text/html; charset=utf-8'),
							html: result.html,
							renderMs: Number(result.renderMs ?? 0),
							setCookie,
							location: result.location == null ? null : String(result.location)
						}
					})
		};
	}

	/**
	 * Wall-clock budget a MISS may spend rendering before it gives up on the
	 * visitor and hands the path to the alarm chain.
	 *
	 * 2 s covers the whole measured first-render range -- 195 ms on minimal, 909 ms
	 * on standard, 1,636 ms observed here on a loaded machine -- and excludes the
	 * 3,754 ms cold boot, which cannot be waited out. It bounds the visitor's
	 * patience, not a billed resource: wall time is not charged against the CPU
	 * budget (4 ms of Worker CPU against 827 ms of wall, measured).
	 *
	 * `budget` on the query string overrides so the fallback is testable, and 0
	 * disables inline rendering entirely, which restores the always-202 shape.
	 *
	 * Paid defaults to 10 s rather than 2 s, which only matters once an interpreter exists: a cold
	 * object refuses on `!this.php` before this number is ever consulted. See `bootInline`.
	 */
	inlineBudgetMs(url: URL): number {
		const explicit = url.searchParams.get('budget');
		const n = Number(explicit);
		if (explicit !== null && explicit !== '' && Number.isFinite(n) && n >= 0) return n;
		return resolvePlanNumber(this.env?.RENDER_BUDGET_MS, 'inlineBudgetMs', 60_000, this.env);
	}

	/**
	 * What the next render on this instance is expected to cost, in ms.
	 *
	 * The budget has to be a prediction, because a render cannot be interrupted
	 * once it starts. `php._run()` is one synchronous call into wasm: while it
	 * executes nothing else in that thread runs, so no `setTimeout`, no
	 * `AbortSignal` and no `Promise.race` can preempt it. Measured -- a Worker
	 * racing a 1 ms timer against a `stub.fetch()` that rendered for 119 ms lost
	 * the race, because the timer could not fire until the wasm call returned.
	 *
	 * So the decision is taken before the render starts, from what this instance
	 * has already observed. The last render is the best predictor available: it was
	 * produced by the same kernel state the next one will meet.
	 *
	 * Pessimistic before any evidence exists. A Durable Object
	 * hibernates after roughly 10 s of inactivity and discards its in-memory state,
	 * which includes `this.php`, the mounted tree and the booted kernel -- so a cold
	 * instance is the common case in production, not the exception, and it must not
	 * gamble a visitor's request on a 3,754 ms boot.
	 */
	estimateRenderMs(): number {
		if (!this.php) return 4000;
		// the isolate's first render pays one-off opcache and container work: 195 ms
		// on minimal, 909 ms on standard, 1,636 ms observed under load
		//
		// On the edge this is where every render after a boot lands, because the wall
		// clock cannot measure synchronous work at all (see fillOne()). The guard is
		// therefore a boot guard out there, not a render guard, and a 1800 estimate reads
		// as "unknown, assume the first-render cost".
		if (this.lastRenderMs === undefined) return 1800;
		return this.lastRenderMs;
	}

	/**
	 * One stored page, as an HTTP response.
	 *
	 * `x-cfw-generation` is on every serve response: it is how the
	 * Worker learns the current generation without spending a Durable Object
	 * request to ask for it.
	 *
	 */
	pageResponse(
		row: PageRow,
		tier: 'HIT' | 'RENDER',
		serveMs: number,
		extra: Record<string, string> = {}
	): Response {
		const headers: Record<string, string> = {
			...extra,
			'content-type': String(row.content_type ?? 'text/html; charset=utf-8'),
			// the edge copy carries its own longer max-age; the client revalidates, so
			// a generation bump is not defeated by a browser cache
			'cache-control': 'public, max-age=0, must-revalidate',
			// the header CONTRACT version, so a probe can tell an old worker from a renamed header.
			// Without it a reader that finds nothing under a name it expects reports every field as
			// absent, which looks identical to a worker that is simply behind
			'x-cfw-v': CFW_HEADER_VERSION,
			'x-cfw-cache': tier,
			'x-cfw-generation': String(this.generation()),
			'x-cfw-rendered-at': String(row.rendered_at),
			'x-cfw-render-ms': String(row.render_ms),
			'x-cfw-serve-ms': String(serveMs),
			'x-cfw-php-booted': this.php ? '1' : '0'
		};
		if (tier === 'HIT') headers['x-cfw-hit-ms'] = String(serveMs);
		else headers['x-cfw-inline'] = '1';
		return new Response(String(row.html), {
			status: Number(row.status),
			headers
		});
	}

	queueDepth(): number {
		this.ensureServeTables();
		return Number(
			this.sql
				.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_fill_queue')
				.toArray()[0]?.c ?? 0
		);
	}

	/**
	 * Alarm handler: fill one page, then re-arm if more are waiting.
	 *
	 * Overrides the keep-warm alarm in SiteDurableObject and subsumes it -- a fill
	 * touches the database anyway. Re-arming at +1 ms rather than a delay is what
	 * makes the chain a chain: each link is a fresh invocation with a fresh budget.
	 *
	 * The fill runs INSIDE the gate. An alarm is delivered as its own event, so
	 * ctx.blockConcurrencyWhile() held by a fetch cannot protect against this
	 * direction: the alarm starts, parks in the interpreter, and a fetch arriving
	 * afterwards would enter PHP alongside it. That was latent while a MISS never
	 * rendered; now that /__serve renders inline it would happen on the first MISS,
	 * because a MISS arms the alarm at +1 ms and then renders.
	 */
	/**
	 * Opens a warm window: one boot, then one fill per incoming WebSocket message.
	 *
	 * This is what makes a fill affordable on the free plan, and it rests on a
	 * documented behaviour. From the Durable Objects limits page:
	 * "Each incoming HTTP request or WebSocket _message_ resets the remaining available
	 * CPU time." So N messages buy N budgets inside ONE object lifetime.
	 *
	 * The alarm chain cannot do this. An alarm fires, the object hibernates after ~10 s
	 * idle and DISCARDS the interpreter, so the next alarm pays boot again -- and boot is
	 * 3,754 ms of edge cpuTime against a 40 ms render. Sliced at 8 ms that is roughly 475
	 * invocations of boot to buy one fill, so 100k DO requests/day would fund about 210
	 * fills. Amortising boot across a whole window is a ~25x difference in what the free
	 * plan can actually fill, and it moves the binding meter back to rows written.
	 *
	 * `server.accept()`, NOT `ctx.acceptWebSocket()`. The Hibernation API exists to let an
	 * object evict WHILE holding connections, which is precisely the opposite of the
	 * requirement here: hibernating would discard the interpreter the window exists to
	 * keep. The cost is explicit -- a non-hibernatable object is billed for duration --
	 * which is why the window is scoped to a drain and then closed rather than held open.
	 *
	 * Cloudflare documents a 15-minute maximum for a connection keeping an object alive,
	 * so the window is bounded well inside that.
	 */
	/**
	 * Row count for a table that may not exist yet.
	 *
	 * null rather than 0, because several Drupal tables are created lazily on first write
	 * (`sessions`, `flood`, `key_value_expire`, `batch`, `queue`, `semaphore`) and
	 * reporting 0 for a missing table reads as a verified invariant when it is an absence.
	 */
	/**
	 * Whether this alarm firing should spend rows on garbage collection.
	 *
	 * Two gates, and both are about the shared meter rather than caution. Page fills and GC
	 * both spend rows written (100k/day), so GC never runs while pages are waiting -- a
	 * visitor's MISS outranks reclaiming disk. And it is interval-gated because the measured
	 * steady state is 0 rows written: running it on every firing would spend statements to
	 * discover there is nothing to do.
	 */
	shouldRunGc(): boolean {
		const everyMs = Number(this.env?.GC_INTERVAL_MS ?? 3_600_000);
		if (!this.serveTablesReady) return false;
		const queued = this.sql
			.exec<Row<{ n: number }>>('SELECT count(*) AS n FROM cfw_fill_queue')
			.toArray()[0]?.n;
		if (Number(queued ?? 0) > 0) return false;
		return !this.lastGcAt || Date.now() - this.lastGcAt >= everyMs;
	}

	countOrNull(table: string, where?: string): number | null {
		try {
			// `where` is a literal from this file only, never a caller's string: these run against
			// the site database and there is no bind slot for a predicate
			const sql = `SELECT count(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`;
			return this.sql.exec<Row<{ n: number }>>(sql).toArray()[0]?.n ?? null;
		} catch {
			return null;
		}
	}

	async openFillWindow(): Promise<Response> {
		const pair = new WebSocketPair();
		// a pair is exactly two sockets, which is what `Object.values` cannot say on its own
		const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
		server.accept();

		this.windowOpenedAt = Date.now();
		this.windowFills = 0;
		this.windowsOpened = (this.windowsOpened ?? 0) + 1;

		server.addEventListener('message', async (event) => {
			// every message is its own invocation with its own CPU budget, so exactly ONE
			// fill per message -- batching inside a message would spend one budget on many
			let payload: Payload;
			try {
				payload = JSON.parse(String(event.data ?? '{}'));
			} catch {
				payload = {};
			}

			if (payload.op === 'close') {
				server.close(1000, 'drained');
				return;
			}

			try {
				const outcome = await this.gate.run(() => this.fillOne(), 'window');
				this.windowFills = (this.windowFills ?? 0) + 1;
				server.send(
					JSON.stringify({
						ok: true,
						fills: this.windowFills,
						booted: !!this.php,
						...outcome
					})
				);
				// nothing left to do; tell the driver rather than making it guess
				if (outcome?.filled === null || (outcome?.remaining ?? 0) === 0) {
					server.send(
						JSON.stringify({ ok: true, drained: true, fills: this.windowFills })
					);
				}
			} catch (e: any) {
				server.send(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
			}
		});

		server.addEventListener('close', () => {
			this.windowClosedAt = Date.now();
			this.lastWindowFills = this.windowFills;
		});

		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * The JS-side migrator, lazily built.
	 *
	 * Lazy because the manifest is an asset fetch and most invocations never migrate;
	 * cached on the instance because a warm object re-reading it per chunk would pay 15
	 * pointless subrequests against the 50-per-invocation cap.
	 */
	migrator(): SqlMigrator {
		if (!this._migrator) {
			this._migrator = new SqlMigrator({
				sql: this.sql,
				storage: this.ctx.storage,
				now: () => this.nowMs(),
				...assetChunkLoader(this.env, sqlChunkPrefix(this.env))
			});
		}
		return this._migrator;
	}

	/**
	 * The cursor when a migration is started but unfinished, else null.
	 *
	 * Null for a site that never started one, because that is every deploy predating the
	 * chunked engine and those must keep serving. "Never started" and "half done" are
	 * genuinely different states and conflating them would take the whole existing fleet
	 * offline.
	 */
	migratePartial(): MigrateCursor | null {
		const cursor = this.migrateCursorOrNull();
		if (!cursor || cursor.state === 'done') return null;
		return cursor;
	}

	/**
	 * Whether this deployment ships migration chunks at all.
	 *
	 * The guard that lets a fresh site start itself without breaking a deploy that has no chunks to
	 * replay: an alarm that throws stops re-arming, so "no manifest" has to be a quiet null rather
	 * than an exception. One asset fetch, and only on an object that has never migrated.
	 */
	/**
	 * Whether a page request has asked this site to provision itself.
	 *
	 * Durable, because the request that asks and the alarm that acts are different invocations and
	 * an eviction sits between them. One row in `cfw_meta`, the table the serve path already writes.
	 */
	provisionRequested(): boolean {
		try {
			const rows = this.sql
				.exec(`SELECT v FROM cfw_meta WHERE k = 'provision_requested'`)
				.toArray();
			return rows.length > 0;
		} catch {
			// the table is created by the write path, so its absence means nobody has asked
			return false;
		}
	}

	/** Records that a visitor wants this site, and wakes the alarm chain to build it. */
	async requestProvision(): Promise<void> {
		this.sql.exec(`CREATE TABLE IF NOT EXISTS cfw_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
		this.sql.exec(
			`INSERT INTO cfw_meta (k, v) VALUES ('provision_requested', '1')
			 ON CONFLICT(k) DO NOTHING`
		);
		await this.ctx.storage.setAlarm(this.nowMs() + 1);
	}

	async hasMigrationManifest(): Promise<boolean> {
		try {
			await assetChunkLoader(this.env, sqlChunkPrefix(this.env)).loadManifest();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Whether this site has never been provisioned, so a page request has nothing to render from.
	 *
	 * NO CURSOR AT ALL is a different state from a half-finished one, and it was the state a fresh
	 * deploy sat in forever: `migrateStepIfPending()` returns null without a cursor, so the alarm
	 * chain never started, and `/serve` answered `warming` on every request for the life of the
	 * object. Provisioning happened only if somebody called `/migrate` by hand -- which is a
	 * DIAGNOSTIC route, so on the canonical config there was no way to do it at all.
	 */
	neverMigrated(): boolean {
		ensureMigrateTable(this.sql);
		return this.migrateCursorOrNull() === null && this.migrated !== true;
	}

	/**
	 * The R2 bucket to offload files to, or null when there is none.
	 *
	 * NULL IS A SUPPORTED STATE, not a misconfiguration, and that is the whole reason this is a
	 * method rather than a direct `this.env.FILES` read at the call site. The Durable Object is
	 * where the file durably lives (`src/db/file-store.ts` stores bytes in DO SQL precisely so an
	 * eviction cannot lose them); R2 is an offload that buys serving-ceiling headroom by answering
	 * requests without a Worker invocation. A site with no bucket bound is fully functional and
	 * simply pays a Worker request per file, which is the free-tier default.
	 *
	 * Typed structurally so the drain is drivable over a stand-in -- the cases worth testing are a
	 * put that throws and a binding that is absent, and neither needs a real bucket.
	 */
	mirrorBucket(): MirrorBucket | null {
		const bucket = (this.env as { FILES?: MirrorBucket } | null | undefined)?.FILES;
		return bucket && typeof bucket.put === 'function' ? bucket : null;
	}

	/**
	 * Whether a database-update run is in progress and owes the alarm chain work.
	 *
	 * One indexed read of one row, so an ordinary alarm on a site that has never run `updb`
	 * pays essentially nothing for this check.
	 */
	updbActive(): boolean {
		try {
			ensureUpdbTables(this.sql);
			const run = readUpdbRun(this.sql);
			if (!run) return false;
			// An ALLOWLIST of live phases, and both halves of that matter. The field is `phase`,
			// not `state` -- reading `run.state` gives undefined, which compared unequal to
			// every terminal name and made a COMPLETE run hold the alarm chain forever while
			// fills starved. And an allowlist means a phase added upstream later defaults to
			// "not active" rather than wedging the chain.
			//
			// UPDB_PHASES: planning, running, complete, halted, rolled_back, abandoned.
			return run.phase === 'planning' || run.phase === 'running';
		} catch {
			// the tables are absent on a site that never started one, which is a state
			return false;
		}
	}

	/**
	 * Advances a database-update run by one beat.
	 *
	 * `updbStep()` owns no transport, no alarm and no env, exactly like `cronStep()`, so the
	 * dependency bag is assembled here. It refuses on a cold interpreter rather than booting
	 * one, because boot is 4,019 ms of indivisible CPU and a beat that starts cold cannot fit
	 * any per-invocation budget.
	 */
	async updbStepOnce(): Promise<{ updb: Payload }> {
		try {
			const step = await this.gate.run(
				() =>
					updbStep(
						{
							sql: this.sql,
							runJson: (code: string) => this.runJson(code),
							phpReady: () => !!this.php,
							txn: (fn: () => void) => this.ctx.storage.transactionSync(fn),
							nowMs: () => this.nowMs()
						} satisfies UpdbDeps,
						updbOptions(this.env)
					),
				'alarm-updb'
			);
			this.lastUpdb = step;
			this.lastUpdbAt = Date.now();
			return { updb: step };
		} catch (e: any) {
			// recorded rather than rethrown: an alarm that throws stops re-arming, and a
			// stalled update with no way to resume itself is worse than a recorded failure
			const failure = { ok: false, error: String(e?.message ?? e) };
			this.lastUpdb = failure;
			return { updb: failure };
		}
	}

	/** the migration cursor for diagnostics, or null on a site that never started one */
	migrateCursorOrNull(): MigrateCursor | null {
		try {
			return readMigrateCursor(this.sql);
		} catch {
			// the table is absent on a pre-existing deploy; that is a state, not an error
			return null;
		}
	}

	/**
	 * The `/migrate` body for the JS engine.
	 *
	 * Shaped to answer both plans from one route. `all=1` (or a paid plan) replays every
	 * chunk in this invocation, which is what a 30 s CPU budget wants. The default replays
	 * `chunksPerInvocation()` and arms an alarm to carry the rest, which is what a 10 ms
	 * budget requires -- so a free-plan deploy self-migrates over ~15 alarm firings without
	 * an operator poking the route 15 times.
	 */
	async migrateChunks(url: URL | null): Promise<Payload> {
		const params = url?.searchParams;
		if (params?.get('reset') === '1') {
			await this.migrator().reset();
		}
		const asked = Number(params?.get('chunks') ?? 0);
		const maxChunks =
			params?.get('all') === '1'
				? Infinity
				: Number.isFinite(asked) && asked > 0
					? asked
					: chunksPerInvocation(this.env);

		let out: Payload;
		try {
			// NOT gated here: `fetch()` already runs the whole
			// router inside `this.gate.run()` (see the bottom of this class), so entering again
			// would be a nested non-reentrant acquire. The Gate is a FIFO promise chain, so the
			// inner entry awaits a release that only happens when the outer returns -- which is
			// waiting on the inner. I shipped that for an hour: every request hung past 90 s on a
			// fresh object and it read exactly like a platform fault.
			//
			// The alarm path is the one that needs an explicit acquire, because alarm() is NOT
			// gated as a whole -- it enters per fill. See migrateStepIfPending().
			out = await this.migrator().step({ maxChunks });
		} catch (e: any) {
			// `done: null` rather than an absent field: a caller branching on `done === false`
			// read undefined here and concluded "finished", which hid this very bug
			return { ok: false, done: null, engine: 'sql', error: String(e?.message ?? e) };
		}

		// arm the continuation here rather than only in alarm(), so the very first /migrate
		// call is enough to finish the job unattended
		if (!out.done && migrationSelfDrives(this.env)) {
			await this.ctx.storage.setAlarm(this.nowMs() + 1);
			out.continuation = 'alarm armed';
		}
		return { ...out, engine: 'sql' };
	}

	/**
	 * Loads the CI-rendered pages straight into the serving table.
	 *
	 * Default on for free, off for paid, overridable both ways. Pre-filling changes what a
	 * MISS means -- a prefilled path is a HIT on its first ever request -- so the switch is
	 * explicit per plan rather than implied. See `prefillDefault()`. Rendered on native PHP, where
	 * a warm page costs 5.45 ms against 46 ms of edge cpuTime, by
	 * `scripts/drupal/prefill-cache.php`. An absent `prefill.json` is normal: a site that skipped
	 * the CI step just starts cold.
	 *
	 * Extracted from the `/__migrate` route, which was a production bug rather than untidiness.
	 * Living in the route handler meant only a request-driven migration ever prefilled. A migration
	 * that completes on the ALARM chain is the default -- `migrationSelfDrives()` arms it from the
	 * first call -- and is the only path a deployed site takes, so a real deploy finished migrating
	 * with `cfw_page` empty and answered 503 on its front page until somebody happened to request a
	 * render. Both callers now share this.
	 *
	 * @param asked the `?prefill=` override: '1' forces on, '0' forces off, null defers to the plan
	 */
	async prefillServingTable(asked: string | null = null): Promise<Payload> {
		const want = asked === '1' ? true : asked === '0' ? false : prefillDefault(this.env);
		if (!want) {
			return {
				prefilled: 0,
				prefillNote: 'prefill disabled; default is on for free, off for paid'
			};
		}
		try {
			this.ensureServeTables();
			const res = await this.env.ASSETS.fetch(new URL('https://a.local/prefill.json'));
			if (!res.ok) {
				return { prefilled: 0, prefillNote: 'no prefill.json; site starts cold' };
			}
			const pages = await res.json<Record<string, Payload>>();
			let loaded = 0;
			for (const [path, page] of Object.entries(pages)) {
				if (!page || typeof page.html !== 'string') continue;
				this.sql.exec(
					`INSERT INTO cfw_page (path, status, content_type, html, rendered_at, render_ms)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             status = excluded.status, content_type = excluded.content_type,
             html = excluded.html, rendered_at = excluded.rendered_at,
             render_ms = excluded.render_ms`,
					path,
					Number(page.status ?? 200),
					String(page.contentType ?? 'text/html; charset=utf-8'),
					page.html,
					this.nowMs(),
					Number(page.renderMs ?? 0)
				);
				loaded++;
			}
			return { prefilled: loaded, prefilledPaths: Object.keys(pages) };
		} catch (e: any) {
			return { prefilled: 0, prefillError: String(e?.message ?? e).slice(0, 200) };
		}
	}

	/**
	 * Advances the migration by one invocation's worth of chunks, or returns null when
	 * there is nothing to do.
	 *
	 * Returns null in two distinct cases that must not be conflated: no migration has ever
	 * been started (so this object is not mid-flight and an alarm should get on with
	 * filling), and the migration is finished. A site with no manifest at all also returns
	 * null rather than throwing, because that is the shape of every pre-existing deploy
	 * and an alarm that throws stops re-arming.
	 */
	async migrateStepIfPending(): Promise<Payload | null> {
		ensureMigrateTable(this.sql);
		const cursor = readMigrateCursor(this.sql);
		if (cursor?.state === 'done') return null;
		// NO CURSOR STARTS A MIGRATION ONLY WHEN A VISITOR ASKED FOR ONE. Starting on any alarm
		// instead was measured hijacking 37 tests: the object migrated first and never reached the
		// quarantine check, the HTTP-queue drain or the deferred-POST drain, so an alarm asserting
		// any of those got a migration report. The marker keeps this alarm's contract as it was --
		// carry an IN-PROGRESS migration forward -- and makes provisioning an explicit request
		if (!cursor && !(this.provisionRequested() && (await this.hasMigrationManifest()))) {
			return null;
		}

		// the pack inserts the packed cachetags rows; that is setup, not a content change,
		// so it must not bump the generation and invalidate the edge cache
		this.suppressBump = true;
		try {
			// Gated HERE and not in migrateChunks(), because alarm() is not gated as a whole
			// while fetch() is. Without this acquire a concurrent /migrate request and this alarm
			// both read the same cursor, both replay the same chunk, the loser hits a UNIQUE
			// constraint, and the cursor latches to `failed` -- after which /serve answers 503
			// forever. An intermittently-failing serve-chain assertion was pointing at it.
			const out = await this.gate.run(
				() => this.migrator().step({ maxChunks: chunksPerInvocation(this.env) }),
				'alarm-migrate'
			);
			this.migrated = out.done;
			// the completion branch a deployed site actually reaches. Without this the alarm chain
			// finishes the migration and leaves the serving table empty; see prefillServingTable().
			// Its own gate.run() rather than the one above: a second sequential acquire on a FIFO
			// chain is fine, where nesting inside the first would deadlock.
			if (out.done) {
				const prefill = await this.gate.run(
					() => this.prefillServingTable(),
					'alarm-prefill'
				);
				return { migrate: out, ...prefill };
			}
			return { migrate: out };
		} catch (e: any) {
			// recorded, not rethrown: the cursor already holds the error and the object has to
			// keep re-arming or the migration stalls with no way to resume itself
			return { migrate: { ok: false, error: String(e?.message ?? e) } };
		} finally {
			this.suppressBump = false;
		}
	}

	// `any` on the return: the base resolves to undefined, the platform discards
	// whatever an alarm handler returns, and this one hands its outcome back for /__serve-stats
	override async alarm(): Promise<any> {
		this.lastAlarmAt = this.nowMs();
		// an alarm is a billed Durable Object invocation too, and the quota docs say so explicitly --
		// which is why slicing work into more alarms spends the meter it is trying to dodge
		this.doRequestsSinceFlush = (this.doRequestsSinceFlush ?? 0) + 1;
		// BEFORE the budgets are read, because they are two of the levers being adopted. An alarm
		// never passes through handle(), so without this the fill knobs stay at their deployed vars
		// however many times an operator rewrites KV
		await this.adoptSettings();
		const outcomes: Array<Payload | null> = [];
		const budgetMs = fillBatchWallMs(this.env);
		const maxPages = fillBatchSize(this.env);
		const startedAt = Date.now();

		// An in-flight heap restore OWNS the alarm chain and comes before everything, including
		// migration.
		//
		// Ordering matters: while the cursor is open `ensurePhp()`
		// throws, so migration, updb and the fill loop can each do nothing but raise. Finishing the
		// restore is the only work that unblocks any of them, and every firing spent elsewhere is an
		// invocation spent on a guaranteed failure.
		if (this.heapRestoreCursor) {
			const before = this.heapRestoreCursor.nextChunk;
			const outcome = await this.restoreStepOnce();
			this.lastAlarmOutcome = outcome;
			this.alarmFirings = (this.alarmFirings ?? 0) + 1;

			const decision = restoreAlarmDecision(before, this.heapRestoreCursor);
			// halt on no progress. A firing that advanced the cursor by zero chunks and left it open
			// would re-arm at +1 ms forever, and because the gate is held that starves every queued
			// request rather than erroring -- the exact failure the migration lane produced, which
			// presented as a deadlock while actually being starvation. Every known path does make
			// progress; this is here because "cannot happen" is what that one was too.
			if (decision.action === 'halt') {
				this.heapRestore = {
					restored: false,
					reason: `restore stalled at chunk ${before}; abandoned rather than re-armed`,
					discardedHeap: true
				};
				this.heapRestoreCursor = null;
				this.php = null;
				return { heapRestore: this.heapRestore };
			}

			this.alarmRearms = (this.alarmRearms ?? 0) + 1;
			await this.ctx.storage.setAlarm(this.nowMs() + decision.delayMs);
			return outcome;
		}

		// Migration first, and it returns rather than falling through to the fill loop.
		//
		// Ordering matters: an unmigrated site has no content to fill, so a fill loop
		// would burn the invocation's budget on nothing while the thing blocking the site
		// waits. And migration must NOT share an invocation with a render -- the whole
		// reason it is chunked is that one chunk is sized to be the largest unit with a
		// chance of fitting 10 ms on its own.
		if (migrationSelfDrives(this.env)) {
			const pending = await this.migrateStepIfPending();
			if (pending) {
				this.lastAlarmOutcome = pending;
				this.alarmFirings = (this.alarmFirings ?? 0) + 1;
				this.alarmRearms = (this.alarmRearms ?? 0) + 1;

				// back off on failure. Re-arming at +1 ms whenever this branch was taken meant a
				// step that ERRORS also re-armed at +1 ms, because an error return is non-null
				// too. The object then spun at 1 ms forever, and since migration runs inside the
				// reentrancy gate, every gated request queued behind an endless stream of alarm
				// entries and never ran: `/migrate` and `/serve-stats` both hung past 90 s on a
				// fresh object. Starvation, not a deadlock, and it presented as one.
				const failed = pending.migrate?.ok === false;
				if (failed) {
					this.migrateFailures = (this.migrateFailures ?? 0) + 1;
				} else {
					this.migrateFailures = 0;
				}
				const delay = migrateAlarmDelayMs(pending.migrate, this.migrateFailures);
				await this.ctx.storage.setAlarm(this.nowMs() + delay);
				return pending;
			}
		}

		// A database update in progress OWNS the alarm chain, and returns rather than falling
		// through.
		//
		// Ordering matters: an updb run is a schema migration, and filling pages from a
		// half-updated schema would cache output the finished site cannot reproduce. It also
		// must not share an invocation with a render, because the whole reason the run is
		// sliced is that one unit is sized to fit 10 ms on its own.
		//
		// Gated on an ACTIVE RUN so an ordinary alarm pays nothing: `readUpdbRun()` is one
		// indexed read of a single row, and with no run present this branch is skipped
		// entirely rather than calling into PHP.
		if (this.updbActive()) {
			const outcome = await this.updbStepOnce();
			this.lastAlarmOutcome = outcome;
			this.alarmFirings = (this.alarmFirings ?? 0) + 1;
			this.alarmRearms = (this.alarmRearms ?? 0) + 1;
			await this.ctx.storage.setAlarm(
				this.nowMs() + updbAlarmDelayMs(outcome?.updb, updbOptions(this.env))
			);
			return outcome;
		}

		// a QUARANTINED site stops writing and stops filling, and keeps SERVING.
		//
		// That asymmetry is the product decision. The failure mode that matters for a free host is not
		// "the site is wrong", it is "the site is gone" -- so quarantine leaves the storage
		// lane answering cached pages with no PHP on the path, and only stops the lane that mutates. A
		// visitor sees a stale site rather than an error, which is the difference between a host with a
		// fault and no host at all.
		//
		// Checked here rather than inside `fillOne()` because the fill lane is the thing being stopped,
		// and a check inside the thing you are stopping still pays its boot.
		const repair = parseState(this.metaGet('repair_state'));
		if (isQuarantined(repair)) {
			const point = latestImport(this.sql);
			const decision = shouldRollback(repair, point);
			// DECIDED AND NOW EXECUTED. `shouldRollback()` was computed, recorded in
			// `lastAlarmOutcome` and dropped, so the rung that exists to restore a site
			// reported its intention every 60 s and never restored anything.
			if (decision.rollback && point) {
				const restore = new SqlMigrator({
					sql: this.sql,
					storage: this.ctx.storage,
					now: () => this.nowMs(),
					...storedImportLoader(this.sql, Number(point.id))
				});
				// one chunk per firing on free, all of them on paid; the cursor this advances is
				// the same one `/__serve` reads, so the site stays 503 until the replay lands
				const out = await restore.step({ maxChunks: chunksPerInvocation(this.env) });
				this.lastAlarmOutcome = { rollback: decision, restore: out };
				this.alarmFirings = (this.alarmFirings ?? 0) + 1;
				this.alarmRearms = (this.alarmRearms ?? 0) + 1;
				await this.ctx.storage.setAlarm(this.nowMs() + (out.done ? 60_000 : 1));
				return this.lastAlarmOutcome;
			}
			this.lastAlarmOutcome = {
				skipped: 'quarantined',
				rung: repair.rung,
				code: repair.code,
				strikes: repair.strikes,
				rollback: decision
			};
			this.alarmFirings = (this.alarmFirings ?? 0) + 1;
			this.alarmRearms = (this.alarmRearms ?? 0) + 1;
			// a slow tick: nothing here is urgent, because the site is still serving
			await this.ctx.storage.setAlarm(this.nowMs() + 60_000);
			return this.lastAlarmOutcome;
		}

		// Never boot the interpreter to fill a page for a site whose database is incomplete.
		// The render would run against a partial database, and /serve already refuses to serve
		// one -- so the fill can only produce something unservable, at the price of a ~4 s
		// synchronous boot that blocks the whole object while it happens.
		if (this.migratePartial()) {
			this.lastAlarmOutcome = { skipped: 'migration incomplete' };
			this.alarmFirings = (this.alarmFirings ?? 0) + 1;
			await this.ctx.storage.setAlarm(this.nowMs() + 1000);
			return this.lastAlarmOutcome;
		}

		// Batch, because setAlarm() costs one ROW WRITE and rows written is the meter
		// that actually binds the free plan: 100,000/day against ~18 row-writes per
		// fill caps it near 5,555 fills/day, and one of those writes is the re-arm. N
		// pages per firing amortises the re-arm across N, so N=5 lifts the ceiling to
		// roughly 20,000/day for no new machinery.
		//
		// Two guards, because the batch is spending two different budgets at once. The
		// page count bounds row writes; the wall-clock check bounds how long the
		// object is occupied, since a fill holds the single-threaded interpreter and
		// every queued HIT waits behind it. Neither guard is the CPU limit -- on the
		// free plan an alarm invocation has the same 10 ms cap as any other, so a
		// batch does NOT make a render fit; it only makes the re-arms cheaper.
		for (let i = 0; i < maxPages; i++) {
			let outcome: Payload | null = null;
			try {
				outcome = await this.gate.run(() => this.fillOne(), 'alarm');
			} catch (e: any) {
				// A THROW OUT OF fillOne() SKIPS ITS OWN THREE-STRIKES BOOKKEEPING, and that is an
				// infinite alarm chain rather than one lost page: the queue row keeps its old
				// attempt count, so `remaining` stays 1, so the re-arm below picks +1 ms, forever.
				// Measured on a deployed worker -- one render that threw
				// `TypeError: target is not a function` produced 196 firings in 14 s, every one of
				// them `outcome: ok`, 2-6 ms, and a Durable Object invocation off the daily budget.
				//
				// fillOne() records a failure when the RENDER reports one; this records it when the
				// render never got that far. Same three strikes, so a poisoned path still cannot
				// own the chain.
				//
				// EXCEPT for a heap restore in flight, which is a transient refusal that already owns
				// the chain: `ensurePhp()` throws it on the boot that applied the first chunk, and the
				// restore branch at the top of `alarm()` drives every firing after that. Striking here
				// charges the page for the object's boot, and three cold boots would drop a perfectly
				// good path out of the queue.
				outcome = { error: String(e?.message ?? e), threw: true };
				if (e instanceof HeapRestoreIncomplete) {
					outcome.restorePending = true;
				} else {
					this.strikeFillHead(String(outcome.error));
				}
			}
			outcomes.push(outcome);
			// nothing left to do, or the object has been busy long enough
			if (!outcome || (outcome.filled === null && outcome.failed === undefined)) break;
			if ((outcome.remaining ?? 0) === 0) break;
			if (Date.now() - startedAt >= budgetMs) {
				outcomes.push({ stopped: 'wall-budget', afterPages: i + 1 });
				break;
			}
		}

		this.lastAlarmOutcome = outcomes.length === 1 ? outcomes[0] : outcomes;
		this.alarmFirings = (this.alarmFirings ?? 0) + 1;
		this.pagesFilledByAlarms =
			(this.pagesFilledByAlarms ?? 0) + outcomes.filter((o) => o?.filled).length;

		// THE HEALTH LAYER, and until now nothing called it. Every tripwire, the ledger, the breaker
		// and `quarantineDecision` were reachable only from `tests/unit/ops/supervisor.spec.ts`, so
		// the whole thing was green in CI and absent from production -- and `repair_state`, which the
		// quarantine branch at the top of this method reads, was written by nobody. That made L4 and
		// L5 unreachable by construction rather than unbuilt.
		//
		// Placed after the fills so a finding is made about work that actually happened, and before
		// the re-arm so a site that just quarantined itself does not schedule another fill.
		const findings = this.supervise(outcomes);
		if (findings.length > 0) {
			this.lastAlarmOutcome = { outcomes, findings };
		}
		// Garbage collection, AFTER the fill loop.
		//
		// Placement matters: a waiting visitor outranks reclaiming disk, and by here the
		// queue is drained and the interpreter is already warm, so GC pays no boot of its own.
		//
		// Cron is NOT drupal_cron(): measured natively at 187 queries and 227-275 ms CPU to
		// accomplish almost nothing but a watchdog trim, with 3 of its 6 hooks needing
		// outbound sockets this runtime lacks. src/cron.js replaces it with pure SQL that
		// never enters the interpreter at all.
		//
		// Interval-gated because GC and page fills spend the SAME meter -- rows written,
		// 100k/day. One measured pass on the real site reclaimed 2.453 MB (17.9% of the
		// database; watchdog alone was 46.1% of it) for 2,648 rows written, about 147 page
		// fills forgone. Steady state is 0 rows written, so it is free once caught up.
		// `amplification` is reported rather than assumed: the 4x index factor comes from the
		// pricing docs, and the first deployed run turns it into a measurement.
		if (this.shouldRunGc()) {
			try {
				this.lastGc = gcPass(this.sql, cronOptions(this.env));
				// the ledger polices its own growth on the same interval as everything else it
				// watches; `ledgerOversized` is the tripwire, this is the act
				this.lastGc.healthRowsTrimmed = gcHealthLedger(this.sql);
				this.lastGcAt = Date.now();
			} catch (e: any) {
				this.lastGc = { error: String(e?.message ?? e) };
			}
		}

		// DRUPAL'S OWN CRON, and until now it had never run on any site.
		//
		// `gcPass()` above is host-side SQL that never enters the interpreter, so `hook_cron` was
		// never invoked at all -- which is exactly why scheduler, simple_sitemap and search_api
		// indexing install cleanly and then silently do nothing. A module that enables and never
		// runs is worse than a refusal, because the site looks fine.
		//
		// Sliced, and bounded three ways: `cronStep()` runs one unit per firing, and the budget
		// caps units, rows and wall time. Placed after GC and before the HTTP drain for the same
		// reason both sit after the fills -- a waiting visitor outranks background work.
		//
		// ON by default, off with DRUPAL_CRON=0. It shipped off, which quietly made six contrib
		// modules do nothing at all -- Scheduler never publishes, Search API never indexes, Simple
		// XML Sitemap never generates -- with no error anywhere, because "cron has not run" is
		// indistinguishable from "there was nothing to do". The budget is what makes the default
		// safe: 6 units / 500 rows / 500 ms per firing is under 0.5% of the daily row budget, so a
		// site cronning every alarm all day cannot consume the regeneration ceiling.
		const cronLastRun = (await this.ctx.storage.get<number>('cronLastRunMs')) ?? null;
		if (drupalCronEnabled(this.env) && cronLastRun === null) {
			// start the clock without running: the first pass lands one interval from here rather
			// than on the busiest alarm the site will ever have
			await this.ctx.storage.put('cronLastRunMs', this.nowMs());
		} else if (
			drupalCronEnabled(this.env) &&
			// the quota ladder's first rung: cron is regeneration nobody is waiting on, so it stops
			// before anything a visitor can see
			this.degradation().cron &&
			cronDue(cronLastRun, this.nowMs(), cronIntervalMs(this.env))
		) {
			try {
				await this.ctx.storage.put('cronLastRunMs', this.nowMs());
				const driven = await driveCron(
					await this.ctx.storage.get<string>('cronCursor'),
					{ sql: this.sql, runJson: (code: string) => this.runJson(code) },
					// the origin is the site's, read from the pin rather than from a request:
					// cron has none, and a mail link built against the default points the
					// recipient at their own machine
					{ ...cronOptions(this.env), origin: this.canonicalOrigin(null) },
					cronBudget(this.env)
				);
				await this.ctx.storage.put('cronCursor', writeCursor(driven.cursor));
				this.lastCron = driven;
				this.lastCronAt = Date.now();
			} catch (e: any) {
				// a cron failure must never take down the alarm that serves the site
				this.lastCron = { error: String(e?.message ?? e) };
			}
		}

		// Deferred outbound HTTP, drained here and nowhere else unattended.
		//
		// PHP cannot await, so `cfwQueueFetch` records a request and returns immediately; the
		// actual `fetch()` has to happen in JS between PHP runs. `/httpdrain` did that
		// manually, which meant nothing drained on a real site -- a queued request sat until
		// someone poked a diagnostic route.
		//
		// Placed after the fills for the same reason GC is: a waiting visitor outranks a
		// background fetch, and by here the queue is drained. The limit is small because each
		// fetch is one of the 50 subrequests an invocation gets, and a fill already spent
		// several.
		if (httpDrainEnabled(this.env)) {
			try {
				const drained = await this.drainHttpQueue(httpDrainLimit(this.env));
				// `.length`, not truthiness: `drained.drained` is an ARRAY and an empty array is
				// truthy, so the obvious guard records on every quiet alarm
				if ((drained?.drained?.length ?? 0) > 0) {
					this.lastHttpDrain = drained;
					this.lastHttpDrainAt = Date.now();
				}
			} catch (e: any) {
				this.lastHttpDrain = { error: String(e?.message ?? e) };
			}
		}

		// Outbound mail, for the same reason and in the same place.
		//
		// `cfwMail` commits the message and returns; a Worker cannot send from inside a synchronous
		// host call. The transport is re-resolved here rather than stored on the row, so an operator
		// who fixes a credential drains the queue that was refused under the old one -- the row
		// records which KIND was resolved at commit, which is diagnostics, not a routing decision.
		if (mailDrainEnabled(this.env ?? {}) && (this.countOrNull('cfw_mail_queue') ?? 0) > 0) {
			await this.adoptSettings();
			const plan = resolveMailTransport(this.env ?? {});
			if ('refusal' in plan) {
				this.lastMailDrain = { refusal: plan.refusal };
				this.lastMailDrainAt = Date.now();
			} else {
				try {
					const drained = await drainMailQueue(this.sql, plan.transport, {
						limit: mailDrainLimit(this.env ?? {}),
						// so a rejected send can say "this is the free plan" rather than "403"
						plan: isPaid(this.env) ? 'paid' : 'free'
					});
					if (drained.sent.length > 0) {
						this.lastMailDrain = drained as unknown as Payload;
						this.lastMailDrainAt = Date.now();
					}
				} catch (e: any) {
					this.lastMailDrain = { error: String(e?.message ?? e) };
					this.lastMailDrainAt = Date.now();
				}
			}
		}

		// The R2 offload, drained here for the same reason GC and the HTTP queue are: a waiting
		// visitor outranks a background upload, and by here the fill queue is drained.
		//
		// It is worth an alarm because serving a file off R2 on a custom domain costs ZERO
		// Worker requests, and Worker requests are what bind the serving ceiling at 3M
		// visits/month. Every other lever in this project moves CPU or rows while that ceiling
		// stands still. The queue has existed for a while and drained nowhere, which is why the
		// report still calls the off-Worker path "designed, not delivered".
		//
		// The limit is small: each put is one of the 50 subrequests an invocation
		// gets, and a fill batch has already spent several. `mirrorBucket()` returns null when no
		// bucket is bound, which is the free-tier default and not an error -- the object is the
		// durable copy either way.
		const bucket = this.mirrorBucket();
		if (bucket) {
			try {
				const drained = await drainMirrors(this.sql, bucket, {
					limit: mirrorLimit(this.env),
					site: this.siteName()
				});
				if (drained.mirrored + drained.deleted + drained.refused > 0) {
					this.lastMirrorDrain = drained;
					this.lastMirrorDrainAt = Date.now();
				}
			} catch (e: any) {
				this.lastMirrorDrain = { error: String(e?.message ?? e) };
			}

			// The PAGE mirror, which is the serving-ceiling lever rather than the file one: a page
			// answered from an R2 custom domain costs no Worker request at all, and Worker requests
			// are what bind 3M visits/month. Ordered by in-memory view counts, so the limited budget
			// publishes the pages that actually move traffic off the Worker -- mirroring everything
			// is measurably worse than mirroring the optimum (77% peaks at 432,900 views/day, 99%
			// falls back to 336,700), and mirroring an arbitrary slice is worse than either.
			try {
				const pages = await drainPageMirrors(
					this.sql,
					bucket,
					(p) =>
						this.sql
							.exec<PageRow>(
								'SELECT status, content_type, html FROM cfw_page WHERE path = ?',
								p
							)
							.toArray()
							.map((r) => ({
								path: p,
								html: String(r.html),
								status: Number(r.status),
								contentType: String(r.content_type)
							}))[0] ?? null,
					{ limit: mirrorLimit(this.env), hits: this.pageHits, site: this.siteName() }
				);
				if (pages.mirrored + pages.failed + pages.refused > 0) {
					this.lastPageMirrorDrain = pages;
					this.lastPageMirrorDrainAt = Date.now();
				}
			} catch (e: any) {
				this.lastPageMirrorDrain = { error: String(e?.message ?? e) };
			}
		}

		// Fold this firing's writes into the daily total. LAST, so it captures everything the
		// firing did -- the fills, the GC, the HTTP drain and the mirror puts -- rather than a
		// prefix of it. Its own row lands in the next firing's total, which is correct: it is a
		// real write and the meter must not exclude itself.
		this.flushDailyRows();
		// folded in the same firing, so the counter costs no row of its own
		this.flushDailyDoRequests();

		// Report this site into the fleet inventory, which is what gives a security rollout a
		// denominator. `shouldReport()` is what keeps this from spending a fleet-wide D1 meter to
		// record that nothing changed: identity moves report immediately, otherwise once a day.
		await this.reportToFleet();

		// one re-arm per batch, not per page; that is the saving
		this.alarmRearms = (this.alarmRearms ?? 0) + 1;

		// Both queues decide the next firing, not just fills. An HTTP queue left non-empty
		// would otherwise wait for the 240 s keep-warm tick, which is what made the drain
		// look broken.
		//
		// Queue depth alone no longer decides it, which is the structural half of the
		// 196-firings-in-14-seconds fix rather than another special case. The old line read
		// `soon ? 1 : 240000` off the queues, so a row that failed to be struck kept the queue
		// non-empty and kept the chain at +1 ms forever -- every firing reporting `ok`. The delay
		// now comes from what the batch ACHIEVED; a non-empty queue can only make an
		// already-progressing chain fast, and can no longer rescue a failing one.
		const remaining = this.queueDepth();
		const httpRemaining = httpDrainEnabled(this.env)
			? (this.countOrNull('cfw_http_queue') ?? 0)
			: 0;
		// mail counts the same way: a queue the limit could not empty must not wait 240 s for the
		// keep-warm tick, which is exactly what made the HTTP drain look broken
		const mailRemaining = mailDrainEnabled(this.env ?? {})
			? (this.countOrNull('cfw_mail_queue') ?? 0)
			: 0;
		const cls = classifyAlarmOutcome(outcomes);
		// A SITE THAT JUST QUARANTINED ITSELF MUST NOT RE-ARM AT +1 ms. `supervise()` ran after the
		// fills, so the enforcement branch at the top of this method does not see the new state until
		// the next firing -- and with a non-empty queue the delay below would be 1 ms, spinning the
		// object against a fill lane that branch is about to refuse. The slow tick matches what the
		// branch itself picks, because a quarantined site is still serving and nothing here is urgent.
		const quarantined = isQuarantined(parseState(this.metaGet('repair_state')));
		const delayMs = quarantined
			? 60_000
			: alarmRearmDelayMs(cls, {
					queueNonEmpty: remaining > 0 || httpRemaining > 0 || mailRemaining > 0,
					failures: this.consecutiveFillFailures ?? 0
				});
		this.consecutiveFillFailures =
			cls === 'failure' ? (this.consecutiveFillFailures ?? 0) + 1 : 0;
		this.lastAlarmClass = cls;
		await this.ctx.storage.setAlarm(this.nowMs() + delayMs);
		return this.lastAlarmOutcome;
	}

	/** runs a PHP fragment and returns everything it wrote */
	async run(code: string): Promise<string> {
		const inst = await this.ensurePhp();
		this.out.length = 0;
		await inst.php._run(code);
		return this.out.join('');
	}

	/** runs a fragment and parses the JSON object it printed */
	async runJson(code: string): Promise<Payload> {
		const raw = await this.run(code);
		const start = raw.indexOf('{');
		if (start < 0) return { error: 'no JSON in output', raw: raw.slice(0, 2000) };
		try {
			return JSON.parse(raw.slice(start));
		} catch (e: any) {
			return {
				error: `unparseable: ${e?.message ?? e}`,
				raw: raw.slice(0, 2000)
			};
		}
	}

	/**
	 * TWO LANES, and which one answers is the throughput story.
	 *
	 * The storage lane serves a cached page out of `cfw_page` with pure
	 * `ctx.storage.sql` and never enters the gate, so a HIT is answered WHILE a
	 * render is in flight instead of queueing behind it. That matters most for the
	 * thing it was built for: a sliced render holds the PHP lane for its whole sliced
	 * lifetime, and without this split every HIT in that window would wait, putting
	 * the single-object ceiling back through the side door.
	 *
	 * Three conditions make it safe, and each one is a real constraint rather than a
	 * formality:
	 *
	 *   1. It runs NO DDL. `ensureServeTables()` issues `CREATE TABLE IF NOT EXISTS`,
	 *      and DDL while the PHP lane holds an open transaction replay dirties
	 *      `sqlite_master` and turns every later read in that transaction into a
	 *      speculative replay -- the O(W x R) cost that once wedged the local runtime
	 *      hard enough to take unrelated sites down with it. So the fast lane
	 *      declines until some gated request has created the tables.
	 *   2. It never awaits. One SELECT, one response. Nothing can interleave inside
	 *      it, so it cannot observe a half-applied write.
	 *   3. It never touches PHP.
	 *
	 * `lane=gate` forces the gated path, which is what makes the split testable: the
	 * same race with the fast lane disabled must show the HIT waiting.
	 */
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		// counted HERE, before any lane splits: both the fast storage lane and the gated PHP lane are
		// the same billed invocation, so counting inside either would undercount the meter
		this.doRequestsSinceFlush = (this.doRequestsSinceFlush ?? 0) + 1;

		// The warm window. Handled before the gate: accepting the socket must
		// not sit inside a gate entry, or the per-message work queued behind it deadlocks.
		if (
			url.pathname === '/__fillsocket' &&
			request.headers.get('upgrade')?.toLowerCase() === 'websocket'
		) {
			return this.openFillWindow();
		}

		if (
			url.pathname === '/__serve' &&
			request.method === 'GET' &&
			url.searchParams.get('lane') !== 'gate' &&
			// condition 1: no DDL from this lane, so it only runs once the tables exist
			this.serveTablesReady === true &&
			// the row is an ANONYMOUS render; `fillOne()` refuses to store one for a session and
			// nothing refused to serve one
			!hasSessionCookie(request.headers.get('cookie')) &&
			// A RESTORE WRITES THIS CURSOR TOO. The gated lane has always refused a
			// half-migrated site, but this lane answers before the gate and never looked, so a
			// warm site returned 200 from `cfw_page` while a rollback was overwriting the
			// database underneath it -- measured. Unreachable on a FIRST migration, because the
			// pack ships no pages and `serveTablesReady` is false, which is why the migration
			// specs never saw it. One indexed read of a single row, no DDL and no await, so all
			// three fast-lane conditions still hold.
			this.migratePartial() === null &&
			// the claim page is the gated lane's decision, and the pack prefills `/`, so answering
			// here made it unreachable
			!needsSetup(request, this.metaGet(FIRST_RUN_KEY) !== null)
		) {
			const fast = this.serveFromStorage(url);
			if (fast) return fast;
		}

		this.phpLaneEntries = (this.phpLaneEntries ?? 0) + 1;
		// one gate entry for the whole request; handle() must never re-enter it
		return this.gate.run(() => this.handle(request, url));
	}

	/**
	 * A cached page, or null to say "not mine".
	 *
	 * Synchronous by construction: an `async` here would introduce the await that
	 * condition 2 forbids. The serve counter is incremented only on the answering
	 * path so a request is still counted exactly once whichever lane takes it.
	 *
	 */
	serveFromStorage(url: URL): Response | null {
		const path = url.searchParams.get('path') ?? '/';
		const t0 = Date.now();
		let row: PageRow | undefined;
		try {
			row = this.sql
				.exec<PageRow>(
					'SELECT status, content_type, html, rendered_at, render_ms FROM cfw_page WHERE path = ?',
					path
				)
				.toArray()[0];
		} catch {
			// a missing table means the memo lied; let the gated lane sort it out
			this.serveTablesReady = false;
			return null;
		}
		if (!row) return null;

		this.sql.exec(
			`INSERT INTO cfw_meta (k, v) VALUES ('serve_requests', '1')
       ON CONFLICT(k) DO UPDATE SET v = CAST(cfw_meta.v AS INTEGER) + 1`
		);
		this.storageLaneServes = (this.storageLaneServes ?? 0) + 1;
		// IN MEMORY, never a row. This decides which pages the R2 mirror publishes first, and a
		// `hits` column would spend the rows-written meter to decide how to save it. Lost on
		// eviction by design: the ordering restarts warm rather than wrong
		this.pageHits.set(path, (this.pageHits.get(path) ?? 0) + 1);
		const gate = this.gate.stats();
		return this.pageResponse(row, 'HIT', Date.now() - t0, {
			'x-cfw-lane': 'storage',
			// Proof of overlap with no timing involved: `active` counts callbacks
			// currently inside the PHP lane, so a 1 here means this HIT was answered
			// while a render was in flight. That is the entire claim of the split, and
			// asserting on it beats asserting on milliseconds.
			'x-cfw-gate-active': String(gate.active),
			'x-cfw-gate-queued': String(gate.queued),
			'x-cfw-queue-depth': String(this.queueDepth())
		});
	}

	/**
	 * Overlays EVERY KV lever override onto this object's env.
	 *
	 * `withSettings()` is applied in `src/site.ts`, to the FRONT worker's env, and the Durable Object
	 * receives its own copy of the bindings -- so for the whole life of the convention no KV lever
	 * reached a reader inside this class. Seven of the eleven are read here and only here
	 * (`RENDER_BUDGET_MS`, `FILL_BATCH_SIZE`, `FILL_BATCH_WALL_MS`, `HTTP_DRAIN_LIMIT`,
	 * `MIRROR_LIMIT`, `LAZY_FS_BUDGET_BYTES`, `PREFILL`), which made them knobs that configured
	 * nothing. This used to overlay only the two mail names and say so.
	 *
	 * Awaited HERE and never in `fetch()`: the fast storage lane must stay await-free. That is safe
	 * because the fast lane reads no lever at all -- it is one indexed `cfw_page` read -- so there is
	 * nothing on it for an override to change.
	 *
	 * Called from `alarm()` as well, which is not optional: the fill chain is where four of the seven
	 * are read, and an alarm never passes through `handle()`.
	 */
	async adoptSettings(): Promise<void> {
		const kv = (this.env as { CONFIG_KV?: PlanKv } | undefined)?.CONFIG_KV;
		if (!kv) return;
		const settings = await resolveSettings(kv);
		// spread once rather than per name; eleven successive object copies on the gated lane is
		// eleven allocations for a map that is memoised anyway
		const overrides: Record<string, string> = {};
		for (const name of KV_OVERRIDABLE) {
			const value = settings[name];
			if (value !== undefined) overrides[name] = value;
		}
		if (Object.keys(overrides).length > 0) this.env = { ...this.env, ...overrides };
	}

	override async handle(request: Request, url: URL): Promise<Response> {
		await this.adoptSettings();
		// learned once, from the name the front worker RESOLVED; the alarm chain has no request to
		// read it from, which is exactly where the R2 mirror needs it
		this.siteName(url.searchParams.get('site'));
		this.invalidateOnCoreUpgrade();
		{
			switch (url.pathname) {
				// `extensions` is the only route in this project that MEASURES what the binary
				// loads. Every other extension claim here was inferred, and three were wrong --
				// `DEFAULT_PLATFORM` listed `ext-mbstring` on a build that has none. Function-name
				// evidence cannot substitute: opcache's optimizer carries a `func_info` table
				// naming `curl_init` and `imagecreatetruecolor` in a binary that has neither.
				case '/__php': {
					const out = await this.runJson(
						`<?php $e = get_loaded_extensions(); sort($e); echo json_encode(['v' => PHP_VERSION, 'e' => $e]);`
					);
					return Response.json({
						version: String(out.v ?? '').trim(),
						extensions: Array.isArray(out.e) ? out.e : [],
						bootMs: this.bootMs,
						mount: this.mountInfo,
						diag: this.bootDiag
					});
				}

				// The route that settles six runtime questions a PDO stand-in could
				// never answer. Driven from PHP through the real bridge, so a pass also
				// proves vrzno_env() returns something PHP can invoke.
				// snapshot, restore, and the bridge check that stops a false pass
				case '/__heap': {
					const op = url.searchParams.get('op') ?? 'status';
					if (op === 'snapshot') {
						// `fresh=1` REFUSES to snapshot a restored heap, for provenance.
						// The boot path restores by default, so
						// BOOT_KERNEL then reports `alreadyBooted: 1` off the restored image and no PHP
						// in this isolate ever minted a vrzno handle -- the snapshot inherits an empty
						// handle table and looks fine. Measured: `handles: 1`, `liveNextId: 1` on an
						// object whose kernel was demonstrably up. A snapshot has to come from a boot
						// out of the PACK.
						if (url.searchParams.get('fresh') === '1') {
							this.php = null;
							this.heapRestoreCursor = null;
							this.heapRestore = {
								restored: false,
								reason: 'skipped for a fresh snapshot'
							};
							await this.ensurePhp({ skipRestore: true });
						}
						// boot the Drupal kernel FIRST. ensurePhp() only boots the interpreter and
						// mounts, and a snapshot taken there holds 47 non-zero pages and zero open
						// descriptors -- measurably the wrong lifecycle point. The kernel boot is
						// what costs 1,121 ms and what a restore is meant to skip
						const booted = await this.runJson(BOOT_KERNEL);
						const askedChunk = Number(url.searchParams.get('chunkBytes') ?? 0);
						const snap = await this.snapshotHeap({
							chunkBytes: askedChunk > 0 ? askedChunk : undefined
						});
						return Response.json({ booted, snapshot: snap });
					}
					if (op === 'bridge') {
						// the check that matters. A restored heap can render 12,304 bytes from a
						// cached page while the vrzno bridge is dead, so a byte comparison proves
						// nothing about the restore. This forces a HOST CALL to round-trip: the
						// PHP side reaches cfwStats through vrzno_env(), so a correct answer means
						// the handle table survived, and a null or a throw means it did not.
						const out = await this.runJson(
							`<?php
							$fn = function_exists('vrzno_env') ? vrzno_env('cfwStats') : null;
							if ($fn === null) { echo json_encode(['bridge' => 'vrzno_env absent']); return; }
							$raw = $fn();
							$decoded = json_decode((string) $raw, true);
							echo json_encode([
								'bridge' => is_array($decoded) ? 'round-tripped' : 'returned nothing usable',
								'sawQueryCount' => is_array($decoded) && array_key_exists('queryCount', $decoded),
								'raw' => is_string($raw) ? substr($raw, 0, 120) : gettype($raw),
							]);`
						);
						return Response.json({ heapRestore: this.heapRestore, hostCall: out });
					}
					if (op === 'handles') {
						// what the vrzno handle table actually holds, as names. The restore
						// contract depends on every live handle being nameable in a fresh
						// instance, so that claim gets a route to check it against.
						const { binary } = await this.ensurePhp();
						const live = captureHandles(
							this.handleIndex(binary),
							binary as unknown as Record<string, unknown>
						);
						ensureHeapTables(this.sql);
						const meta = latestSnapshotMeta(
							this.sql,
							String(this.packGeneration() ?? '')
						);
						const stored = meta ? snapshotPageIndex(this.sql, meta.id) : null;
						return Response.json({
							tablePresent: this.handleIndex(binary) !== null,
							live: live.handles,
							unnameable: live.unnameable,
							stored: stored?.handles ?? null,
							liveNextId: this.handleIndex(binary)?.id ?? null,
							heapRestore: this.heapRestore
						});
					}
					if (op === 'trace') {
						// THE INSTRUMENT, because reasoning about this got it wrong twice. The glue's
						// call thunk is `const target = Module.targets.get($0); target(...args)`, so the
						// only way to learn WHICH id a restored heap asks for is to watch the lookups.
						// `get` is defined non-writable, which is why the wrapper goes one level up --
						// the glue re-reads `Module.targets` at every call site, so swapping the object
						// in is enough.
						const { binary } = await this.ensurePhp();
						const table = this.handleIndex(binary);
						if (!table) return Response.json({ error: 'no vrzno handle table' });
						const misses: number[] = [];
						const hits: Array<{ id: number; kind: string }> = [];
						const real = table as unknown as {
							get(id: number): unknown;
							add(o: object): number;
							getId(o: object): number | undefined;
							has(o: object): number | undefined;
							hasId(id: number): unknown;
							remove(id: number): void;
						};
						// a DELEGATING OBJECT rather than a Proxy: `get` is a non-writable non-configurable
						// data property, so the proxy invariant forbids a get trap returning anything but its
						// actual value -- the trap throws instead of tracing. Measured on the edge, first try
						const wrapper = {
							byObject: table.byObject,
							byInteger: table.byInteger,
							get id(): number {
								return table.id;
							},
							set id(v: number) {
								table.id = v;
							},
							get: (id: number) => {
								const v = real.get(id);
								if (v === undefined) {
									if (!misses.includes(Number(id))) misses.push(Number(id));
								} else if (hits.length < 24) {
									hits.push({ id: Number(id), kind: typeof v });
								}
								return v;
							},
							add: (o: object) => real.add(o),
							getId: (o: object) => real.getId(o),
							has: (o: object) => real.has(o),
							hasId: (id: number) => real.hasId(id),
							remove: (id: number) => real.remove(id)
						};
						(binary as unknown as { targets: unknown }).targets = wrapper;
						let render: Payload;
						try {
							render = (await this.fillOne(
								url.searchParams.get('path') ?? '/'
							)) as unknown as Payload;
						} catch (e) {
							render = { threw: String((e as Error)?.message ?? e) };
						} finally {
							(binary as unknown as { targets: unknown }).targets = table;
						}
						return Response.json({
							misses,
							hits,
							nextId: table.id,
							live: captureHandles(
								table,
								binary as unknown as Record<string, unknown>
							),
							render,
							heapRestore: this.heapRestore
						});
					}
					if (op === 'corrupt') {
						// 1.6: FAULT INJECTION, so the digest refusal is reachable from a deployed
						// worker rather than only from a unit test. `LAZY_MOUNT` was unreachable code
						// for its entire life and nothing noticed, because "the test covers it" and
						// "production can execute it" are different claims. Diagnostics-gated,
						// alongside /php which evaluates arbitrary PHP.
						ensureHeapTables(this.sql);
						const flipped = this.corruptStoredChunk(
							Number(url.searchParams.get('chunk') ?? 0)
						);
						return Response.json(flipped);
					}
					if (op === 'restore') {
						// forces the restore to run again on the real boot path: drop the interpreter
						// so the next ensurePhp() takes the same branch a cold object would
						this.php = null;
						this.heapRestoreCursor = null;
						this.heapRestore = null;
						let booted: Payload;
						try {
							await this.ensurePhp();
							booted = { ok: true };
						} catch (e) {
							booted = { ok: false, error: String((e as Error)?.message ?? e) };
						}
						return Response.json({ booted, heapRestore: this.heapRestore });
					}
					ensureHeapTables(this.sql);
					return Response.json({
						heapRestore: this.heapRestore,
						heapRestoreCursor: this.heapRestoreCursor,
						packGeneration: this.packGeneration(),
						latest: latestSnapshotMeta(this.sql, String(this.packGeneration() ?? '')),
						enabled: heapSnapshotEnabled(this.env),
						chunkBudget: heapRestoreChunkBudget(this.env) ?? 'all',
						// wasm linear memory RIGHT NOW, which is the quantity `INITIAL_MEMORY`
						// governs and the one every proposal to lower it has to be measured
						// against. null on an object that has not booted PHP: 0 would read as a
						// measured empty heap rather than as "there is nothing to measure"
						linearMemoryBytes: this.php
							? (this.heapBytes(this.php.binary)?.byteLength ?? null)
							: null
					});
				}

				/**
				 * One boot phase per invocation, because a phase has no other clock.
				 *
				 * `?phase=kernel-boot` runs every phase up to that one and stops. The cost of a phase
				 * is `cpuTime(phase) - cpuTime(previous phase)` read from `wrangler tail` on a
				 * DEPLOYED worker; every in-isolate clock reads 0 out there, so an internal
				 * breakdown is not available at any price.
				 */
				case '/__bootphase': {
					const requested = (url.searchParams.get('phase') ?? 'render') as BootPhase;
					if (!BOOT_PHASES.includes(requested)) {
						return Response.json(
							{ error: `unknown phase`, phase: requested, phases: BOOT_PHASES },
							{ status: 400 }
						);
					}
					// drop the interpreter. BOOT_KERNEL memoises the kernel into $GLOBALS, so a phase
					// measured on a warm object measures nothing and returns a small plausible
					// number -- which is exactly how 850 ms stayed unattributed.
					this.php = null;
					this.heapRestoreCursor = null;
					const t0 = Date.now();
					const out = await this.runJson(bootPhaseFragment(requested));
					return Response.json({
						phase: requested,
						phases: BOOT_PHASES,
						result: out,
						// present so a local run is orderable, and useless on the edge by design
						localElapsedMs: Date.now() - t0,
						mountInfo: this.mountInfo,
						howToRead:
							'deploy, then subtract consecutive cpuTime figures from wrangler tail; ' +
							'container-read and container-unserialize both baseline against kernel-new'
					});
				}

				case '/__probe':
					return Response.json({
						bootMs: this.bootMs,
						probe: await this.runJson(PROBE_RUNTIME)
					});

				// the other half of MIGRATE_DB: a site that cannot be extracted is not a
				// product. Streams as SQL text so a fleet backup can push it to R2.
				/**
				 * Dumps the database as replayable SQL, host-side.
				 *
				 * NOT the PHP `exportDatabase()` any more, and the reason is fidelity rather than
				 * the ~1.4 s interpreter boot it also avoids. That fragment cannot represent three
				 * of the five storage classes: it has no BLOB branch at all, so a blob ships as a
				 * quoted TEXT literal and comes back a different type; it emits NUL bytes raw into
				 * statement text, which SQLite answers with `unrecognized token`; and its integer
				 * pattern quotes anything past 18 digits. `dumpDatabase()` reads `typeof()` and
				 * `hex()` and never the column, so no value crosses a double -- which is what DO
				 * SQLite's lossy-above-2^53 read requires.
				 */
				/**
				 * Stores a dump as a restore point and arms the alarm to replay it.
				 *
				 * The missing half of rollback: `shouldRollback()` looks for a stored import and
				 * nothing in production ever wrote one, so the quarantine rung could only ever
				 * decide against restoring. A dump arrives as the request body -- never a query
				 * string, which `wrangler tail` prints.
				 *
				 * The replay runs on the alarm rather than here: it rewrites the database a chunk
				 * at a time, and the invocation that accepts the upload must not also be the one
				 * holding a half-overwritten site open.
				 */
				/**
				 * Answers whether the presented bearer token owns this site.
				 *
				 * A separate route rather than a check inside `/__export`, because the Worker in
				 * front has to decide BEFORE it proxies: a 401 must not cost a database dump. It
				 * returns nothing but a status, so a wrong guess learns only that it was wrong.
				 */
				/**
				 * The health ledger, the repair state and what the last alarm found.
				 *
				 * `?clear=1` releases quarantine, which is deliberately an explicit operator act and
				 * never automatic: one clean render says nothing about the condition that caused it,
				 * so `release()` is reachable only from here.
				 */
				case '/__health': {
					this.ensureServeTables();
					const state = parseState(this.metaGet('repair_state'));
					if (url.searchParams.get('clear') === '1') {
						const released = release(state, this.nowMs());
						this.metaSet('repair_state', serialiseState(released));
						return Response.json({ ok: true, released, was: state });
					}
					return Response.json({
						repair: state,
						quarantined: isQuarantined(state),
						rollback: shouldRollback(state, latestImport(this.sql)),
						lastFindings: this.lastFindings ?? [],
						ledger: this.sql
							.exec(
								'SELECT ts, code, severity, scope, context, action, outcome, attempt FROM cfw_health ORDER BY id DESC LIMIT ?',
								Number(url.searchParams.get('limit') ?? 50)
							)
							.toArray(),
						ledgerRows: this.countOrNull('cfw_health')
					});
				}

				/**
				 * The Cloudflare OAuth flow, held in the object because that is the only
				 * store here that a KV writer cannot reach.
				 *
				 * `start` is owner-authenticated; `callback` cannot be, because it arrives
				 * as a browser redirect carrying no header. `state` is what authenticates
				 * it, which is the standard construction and why the comparison in
				 * `pendingMatches()` is constant-time.
				 */
				/**
				 * Sending-domain onboarding status, and the apply step behind it.
				 *
				 * Read-only on GET so an operator can watch a long DNS wait without
				 * writing anything. The token is NOT taken from the query: it is the
				 * deployed `CF_EMAIL_TOKEN`, because a token in a URL lands in every
				 * log the request touches.
				 */
				case '/__mailonboard': {
					const env = this.env as unknown as Record<string, string | undefined>;
					const token = env.CF_EMAIL_TOKEN ?? '';
					const accountId =
						env.CF_EMAIL_ACCOUNT_ID ?? this.metaGet(CF_OAUTH_ACCOUNT_KEY) ?? '';
					const zoneId =
						url.searchParams.get('zone') ?? this.metaGet(MAIL_ZONE_KEY) ?? '';
					if (!token) {
						return Response.json(
							{ ok: false, error: 'no Cloudflare token; connect an account first' },
							{ status: 400 }
						);
					}
					if (url.searchParams.get('zone')) this.metaSet(MAIL_ZONE_KEY, zoneId);

					const subs = zoneId ? await listSendingSubdomains(token, zoneId) : null;
					if (subs && !subs.ok)
						return Response.json({ ok: false, error: subs.error }, { status: 400 });
					let subdomain = subs?.ok ? (subs.value[0] ?? null) : null;

					if (url.searchParams.get('action') === 'apply' && zoneId) {
						if (!subdomain) {
							const made = await createSendingSubdomain(
								token,
								zoneId,
								url.searchParams.get('name') ?? ''
							);
							if (!made.ok)
								return Response.json(
									{ ok: false, error: made.error },
									{ status: 400 }
								);
							subdomain = made.value;
						}
					}

					let plan: RecordAction[] = [];
					if (subdomain) {
						const [want, have] = await Promise.all([
							requiredDns(token, zoneId, subdomain.id),
							zoneRecords(token, zoneId)
						]);
						if (want.ok && have.ok) plan = dnsPlan(want.value, have.value);
					}

					let applied = null;
					if (url.searchParams.get('action') === 'apply' && plan.length > 0) {
						applied = await applyDnsPlan(token, zoneId, plan);
					}

					const dests = accountId ? await listDestinations(token, accountId) : null;
					const wanted = url.searchParams.get('destination');
					const destination = dests?.ok
						? dests.value.find((d) => (wanted ? d.email === wanted : isVerified(d)))
						: undefined;

					return Response.json({
						ok: true,
						...onboardState({ zoneId: zoneId || null, subdomain, plan, destination }),
						applied
					});
				}

				case '/__cfoauth': {
					const action = url.searchParams.get('action') ?? 'status';
					const clientId = this.metaGet(CF_OAUTH_CLIENT_ID_KEY);

					if (action === 'connect') {
						const given = url.searchParams.get('client_id')?.trim();
						if (given) this.metaSet(CF_OAUTH_CLIENT_ID_KEY, given);
						const id = given || clientId;
						if (!id) {
							return Response.json(
								{ ok: false, error: 'register an OAuth client and pass client_id' },
								{ status: 400 }
							);
						}
						const pkce = await createPkce();
						const state = randomToken(24);
						const redirectUri = callbackUrl(this.canonicalOrigin(url.origin));
						this.metaSet(
							CF_OAUTH_PENDING_KEY,
							JSON.stringify({
								state,
								verifier: pkce.verifier,
								redirectUri,
								createdAt: this.nowMs()
							} satisfies PendingAuth)
						);
						return Response.json({
							ok: true,
							authorizeUrl: authorizeUrl({
								clientId: id,
								redirectUri,
								challenge: pkce.challenge,
								state
							})
						});
					}

					if (action === 'callback') {
						const raw = this.metaGet(CF_OAUTH_PENDING_KEY);
						let pending: PendingAuth | null = null;
						try {
							pending = raw ? (JSON.parse(raw) as PendingAuth) : null;
						} catch {
							pending = null;
						}
						const check = pendingMatches(
							pending,
							url.searchParams.get('state') ?? '',
							this.nowMs()
						);
						// consumed only on a MATCH: this route is public and takes no credential, so
						// clearing on every inbound request let anyone cancel an owner's connect
						// mid-flight with `GET /setup/cf/callback?state=x`, one `cfw_meta` write each
						if (!check.ok)
							return Response.json(
								{ ok: false, error: check.reason },
								{ status: 400 }
							);
						// still before the exchange, so a code cannot be replayed against it
						this.metaSet(CF_OAUTH_PENDING_KEY, '');
						const code = url.searchParams.get('code') ?? '';
						if (!code || !clientId) {
							return Response.json(
								{ ok: false, error: 'no code returned' },
								{ status: 400 }
							);
						}
						const out = await exchangeCode({
							clientId,
							code,
							verifier: (pending as PendingAuth).verifier,
							redirectUri: (pending as PendingAuth).redirectUri
						});
						if (isTokenError(out))
							return Response.json({ ok: false, error: out.error }, { status: 400 });
						const accountId = await resolveAccountId(out.accessToken);
						this.metaSet(CF_OAUTH_TOKEN_KEY, JSON.stringify(out));
						if (accountId) this.metaSet(CF_OAUTH_ACCOUNT_KEY, accountId);
						// the grant replaces the pasted pair, which is the point of offering it
						this.env = {
							...this.env,
							CF_EMAIL_TOKEN: out.accessToken,
							...(accountId ? { CF_EMAIL_ACCOUNT_ID: accountId } : {})
						};
						return Response.json({ ok: true, accountId, scopes: out.scopes });
					}

					if (action === 'disconnect') {
						const raw = this.metaGet(CF_OAUTH_TOKEN_KEY);
						let revoked = false;
						if (raw && clientId) {
							try {
								const set = JSON.parse(raw) as TokenSet;
								revoked = await revoke({ clientId, token: set.accessToken });
							} catch {
								revoked = false;
							}
						}
						// cleared either way; reporting `revoked` separately keeps a failed
						// revocation visible rather than reading as a completed disconnect
						this.metaSet(CF_OAUTH_TOKEN_KEY, '');
						this.metaSet(CF_OAUTH_ACCOUNT_KEY, '');
						return Response.json({ ok: true, revoked });
					}

					const stored = this.metaGet(CF_OAUTH_TOKEN_KEY);
					return Response.json({
						ok: true,
						clientId: clientId ? `${clientId.slice(0, 6)}...` : null,
						connected: Boolean(stored),
						accountId: this.metaGet(CF_OAUTH_ACCOUNT_KEY) || null
					});
				}

				case '/__ownercheck': {
					const presented = bearerToken(request.headers.get('authorization'));
					const stored = this.metaGet(OWNER_TOKEN_KEY);
					return new Response(null, {
						status: tokenMatches(presented, stored) ? 200 : 401
					});
				}

				case '/__restore': {
					if (request.method !== 'POST') {
						return Response.json(
							{ ok: false, error: 'POST a dump body to /restore' },
							{ status: 405 }
						);
					}
					const stored = storeImport(this.sql, await request.text(), {
						storage: this.ctx.storage,
						generation: url.searchParams.get('label') ?? String(this.nowMs()),
						source: '/__restore',
						nowMs: this.nowMs()
					});
					await this.ctx.storage.setAlarm(this.nowMs() + 1);
					return Response.json({ ok: true, ...stored });
				}

				case '/__export': {
					const options = {
						limitPerTable: Number(url.searchParams.get('limit') ?? 0),
						// asked for by name, and NOT implied by `all=1`: that flag widens which
						// TABLES carry rows, and rolling the credentials into it would mean the
						// byte-exact copy a restore wants is also the one nobody may store
						...(url.searchParams.get('secrets') === '1' ? { secrets: true } : {}),
						...(url.searchParams.get('all') === '1' ? { includeRows: () => true } : {}),
						...(url.searchParams.get('chunkChars')
							? { maxCharsPerChunk: Number(url.searchParams.get('chunkChars')) }
							: {})
					};

					const rawCursor = url.searchParams.get('cursor');
					if (rawCursor !== null) {
						let cursor: DumpCursor;
						try {
							cursor = rawCursor === 'start' ? DUMP_START : JSON.parse(rawCursor);
						} catch {
							return Response.json(
								{
									ok: false,
									error: 'cursor is not JSON; start with ?cursor=start'
								},
								{ status: 400 }
							);
						}
						let chunk;
						try {
							chunk = dumpChunk(this.sql, cursor, options);
						} catch (e) {
							// a shape mismatch means two different dumps are being spliced, which
							// produces a file that looks whole and is not
							return Response.json(
								{ ok: false, error: String((e as Error)?.message ?? e) },
								{ status: 409 }
							);
						}
						const { sql: chunkSql, ...chunkMeta } = chunk;
						return Response.json(
							{
								ok: true,
								...chunkMeta,
								// the cursor is opaque to the caller and goes back verbatim
								nextCursor: chunk.done ? null : JSON.stringify(chunk.cursor),
								...(url.searchParams.get('body') === '1'
									? { sql: chunkSql }
									: { sqlOmitted: chunkSql.length })
							},
							{ status: chunk.replayable ? 200 : 409 }
						);
					}

					const { sql, ...meta } = dumpDatabase(this.sql, options);
					// 409 when the dump cannot be replayed, because a restore point nobody can
					// replay is worse than none: it reads as a backup. `?all=1` emits the whole
					// cache_container row, measured at 960,544 chars against a 100,000 ceiling, and
					// said nothing about it
					const status = meta.replayable ? 200 : 409;
					const envelope = {
						...meta,
						...(meta.replayable
							? {}
							: {
									error: `widest statement is ${meta.maxStatementChars} chars against the ${DO_MAX_STATEMENT_CHARS} a Durable Object accepts; this dump cannot be restored`,
									how: 'drop ?all=1, or narrow with ?limit='
								})
					};
					return url.searchParams.get('body') === '1'
						? Response.json({ ...envelope, sql }, { status })
						: Response.json({ ...envelope, sqlOmitted: sql.length }, { status });
				}

				// the product gap nothing was tracking: every migrated site boots identical
				/**
				 * The `cfw_ops` HTTP surface.
				 *
				 * The registry declared eight operations and nothing was wired to it, so the
				 * measurements it encodes were unreachable. This surface REFUSES most of what it
				 * lists: seven of the eight
				 * are `sliced: true`, meaning they cannot complete inside one invocation, and the
				 * measured cost is the reason. `cr` alone is 282.9 ms in wasm -- 28x a free
				 * invocation -- so an endpoint that ran it inline would time out or blow the budget
				 * while looking like it worked.
				 *
				 * A refusal therefore carries the cost figure and the driver that CAN run the
				 * operation, because "no" without an alternative just gets retried.
				 */
				/**
				 * Can this module be installed? One cacheable subrequest, and a refusal that NAMES
				 * the conflict.
				 *
				 * The check, not the install -- the Workflow path does the installing. They are
				 * separate because `composer require` on the edge needs a solver, unbounded
				 * subrequests and
				 * minutes of CPU, but the COMMON answer is decidable from one metadata fetch against a
				 * lock this bundle already carries. A module needing `drupal/core: ^10` is refused
				 * before any download, any Workflow and any write.
				 *
				 * Through `caches.default`, because a p2 payload is immutable per version -- so the
				 * second operator to ask about the same module pays nothing.
				 */
				case '/__installable': {
					const name = url.searchParams.get('module') ?? '';
					const cache = caches.default;
					const verdict = await resolveInstallable(
						this.env as never,
						async (target: string) => {
							const key = new Request(target, { method: 'GET' });
							const hit = await cache.match(key);
							if (hit) return hit;
							const res = await fetch(key);
							if (res.ok) {
								// clone before the body is read, and give it a TTL: immutable per
								// version, but a NEW version appears under the same URL
								const copy = new Response(res.clone().body, {
									status: res.status,
									headers: { 'cache-control': 'public, max-age=3600' }
								});
								await cache.put(key, copy);
							}
							return res;
						},
						name,
						SHIPPED_LOCK_VERSIONS,
						SHIPPED_CORE_VERSION
					);
					return Response.json(
						{ ...verdict, shippedCore: SHIPPED_CORE_VERSION },
						{
							// a refusal is a real answer, not a server error: 200 with a verdict, so a
							// caller reads the named conflict rather than a status code
							status: verdict.verdict === 'not-found' ? 404 : 200
						}
					);
				}

				/**
				 * Where do the rows actually go?
				 *
				 * `?op=on` arms the tally, `?op=off` clears it, a bare call reports it. Off by default
				 * because it allocates and because an always-on counter is a thing to forget about.
				 *
				 * This exists because the regeneration ceiling is bound by rows written, the work order
				 * says rows work is worth 2.15x against ~1% for boot work, and the attribution the whole
				 * ordering rests on -- "~9 of ~17 rows are `dblog`" -- predates this session and has never
				 * been measured per table.
				 */
				case '/__writes': {
					const op = url.searchParams.get('op');
					/**
					 * The widest single value per table, which is the limit a migration scores
					 * against and which nothing reported.
					 *
					 * TWO Durable Object ceilings bite a real site and neither had an instrument:
					 * a record may not exceed 2,199,995 bytes, and statement text may not exceed
					 * 100,000 characters. A dump is refused by the second -- measured, one
					 * `cache_container` row is 960,544 characters -- and until now the only way to
					 * discover that was to attempt the restore.
					 *
					 * `length(hex(col)) / 2` rather than `length(col)`: on a TEXT value `length()`
					 * counts CHARACTERS, so a multi-byte string reports narrower than it stores and
					 * the number would be wrong in the safe-looking direction.
					 *
					 * Its own op because it scans every row of every table; the tally read above
					 * has to stay cheap enough to call after each fill.
					 */
					if (op === 'widest') {
						const tables = this.sql
							.exec<Row<{ name: string }>>(
								"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
							)
							.toArray()
							.map((r) => String(r.name));
						const widest: { table: string; column: string; bytes: number }[] = [];
						for (const table of tables) {
							const cols = this.sql
								.exec<Row<{ name: string }>>(`PRAGMA table_info("${table}")`)
								.toArray()
								.map((r) => String(r.name));
							for (const col of cols) {
								try {
									const row = this.sql
										.exec<Row<{ n: number }>>(
											`SELECT max(length(hex("${col}")) / 2) AS n FROM "${table}"`
										)
										.toArray()[0];
									const bytes = Number(row?.n ?? 0);
									if (bytes > 0) widest.push({ table, column: col, bytes });
								} catch {
									// a virtual or shadow table that refuses the scan is skipped
								}
							}
						}
						widest.sort((a, b) => b.bytes - a.bytes);
						const top = widest[0];
						return Response.json({
							ok: true,
							recordCap: DO_MAX_RECORD_BYTES,
							statementCap: DO_MAX_STATEMENT_CHARS,
							widest: widest.slice(0, 20),
							// a value is inlined as two hex chars per byte plus the statement around
							// it, so the statement ceiling bites at roughly half the record ceiling
							exportable: (top?.bytes ?? 0) * 2 < DO_MAX_STATEMENT_CHARS,
							note: top
								? `widest value is ${top.table}.${top.column} at ${top.bytes} bytes`
								: 'no rows'
						});
					}
					if (op === 'on') {
						this.writeTally = emptyTally();
						return Response.json({ ok: true, tally: 'armed' });
					}
					if (op === 'off') {
						this.writeTally = undefined;
						return Response.json({ ok: true, tally: 'cleared' });
					}
					if (!this.writeTally) {
						return Response.json({
							ok: true,
							tally: 'not armed',
							how: 'GET /writes?op=on, drive a fill, then GET /writes'
						});
					}
					return Response.json({
						ok: true,
						statements: this.writeTally.statements,
						rowsWritten: this.writeTally.rowsWritten,
						ranked: rankTally(this.writeTally),
						amplification: amplification(this.writeTally),
						overheadShare: overheadShare(this.writeTally),
						note: 'an ?unattributed share means writeTargetTable() is missing a form and the breakdown is not trustworthy'
					});
				}

				/**
				 * Drives Drupal's file API over the durable store; see FILES_PROBE.
				 *
				 * `drop=1` discards the interpreter FIRST, which is what makes a read prove
				 * durability rather than read back a buffer the same run wrote.
				 */
				case '/__mirror': {
					// Drives the R2 offload by hand and reports what it REFUSED. The drain also
					// runs from the alarm; this exists so a pass can be forced and read.
					// `refused` is the field that matters -- it counts queue rows the drain would
					// not send, which is how the private-file rule gets checked rather than
					// assumed.
					const bucket = this.mirrorBucket();
					const limit = Number(url.searchParams.get('limit') ?? mirrorLimit(this.env));
					const drained = await drainMirrors(this.sql, bucket, {
						limit,
						site: this.siteName()
					});
					return Response.json({
						ok: true,
						...drained,
						pending: pendingMirrors(this.sql, 25),
						how: bucket
							? 'bound; a pass ran'
							: 'no FILES bucket bound, which is the free-tier default -- the object is the durable copy'
					});
				}

				case '/__files': {
					if (url.searchParams.get('drop') === '1') {
						this.php = null;
					}
					// the kernel has to be up before `\Drupal::` resolves, and it is a SEPARATE run:
					// BOOT_KERNEL memoises into $GLOBALS and prints its own JSON, so concatenating
					// the two fragments would emit two objects and neither would parse. The
					// interpreter persists between runs, which is what makes the split work.
					const booted = await this.runJson(BOOT_KERNEL);
					if (booted?.ok === false) {
						return Response.json(
							{ ok: false, error: 'kernel boot failed', booted },
							{
								status: 500
							}
						);
					}
					const op = url.searchParams.get('op') ?? 'write';
					const uri = url.searchParams.get('uri') ?? 'public://cfw-probe/note.txt';
					const body = url.searchParams.get('body') ?? 'durable';
					// set through globals rather than string interpolation: a filename with a quote
					// in it would otherwise close the PHP literal and change what runs
					const preamble =
						`<?php $GLOBALS['__cfw_files_op'] = ${JSON.stringify(op)};` +
						` $GLOBALS['__cfw_files_uri'] = ${JSON.stringify(uri)};` +
						` $GLOBALS['__cfw_files_body'] = ${JSON.stringify(body)};`;
					// the probe's own `<?php` is stripped and the preamble supplies it. NO `?>` between
					// them: closing the tag would emit the rest of the fragment as literal text
					// instead of running it, which is exactly what the first version did.
					const reply = await this.runJson(
						`${preamble}\n${FILES_PROBE.replace(/^<\?php\n/, '')}`
					);
					return Response.json(reply ?? { ok: false, error: 'no reply' }, {
						status: reply?.ok === true ? 200 : 500
					});
				}

				/**
				 * Enables a packed Drupal module, and measures what that costs.
				 *
				 * `dry=1` reports discoverability and `hook_requirements` without installing.
				 * `verify=1` runs ENABLE_VERIFY instead, on a dropped interpreter, which is the
				 * only way to see the post-rebuild container rather than the one still in memory.
				 *
				 * The write tally is armed around the install because rows written is the meter
				 * that binds regeneration, and the router rebuild is a single non-resumable burst
				 * -- the first real number for an operation the E-track has only ever estimated.
				 */
				case '/__enable': {
					const wantVerify = url.searchParams.get('verify') === '1';
					// AN INSTALL RUNS ON A FRESH INTERPRETER, AND THIS IS THE WHOLE FIX. wasm
					// linear memory only ever grows -- `memory.grow` has no inverse -- so an
					// object that has served pages carries every byte those renders claimed.
					// Measured: an enable ends at 92.2 MB on a fresh interpreter and 110.6 MB on
					// one that has rendered four pages, against a 128 MB isolate cap. `keep=1`
					// reproduces the failing order for the A/B rather than being a tuning knob
					const keepInterpreter = url.searchParams.get('keep') === '1';
					if (wantVerify || !keepInterpreter) {
						this.php = null;
					}
					const booted = await this.runJson(BOOT_KERNEL);
					if (booted?.ok === false) {
						return Response.json(
							{ ok: false, error: 'kernel boot failed', booted },
							{ status: 500 }
						);
					}
					if (wantVerify) {
						const verified = await this.runJson(ENABLE_VERIFY);
						return Response.json(verified ?? { ok: false, error: 'no reply' });
					}
					const name = url.searchParams.get('module') ?? 'drupflare';
					const dry = url.searchParams.get('dry') === '1';
					const stopAt = url.searchParams.get('stop') ?? '';
					const preamble =
						`<?php $GLOBALS['__cfw_enable_module'] = ${JSON.stringify(name)};` +
						` $GLOBALS['__cfw_enable_dry'] = ${dry ? 'true' : 'false'};` +
						` $GLOBALS['__cfw_enable_stop'] = ${JSON.stringify(stopAt)};`;
					this.writeTally = emptyTally();
					// THE WASM HEAP, READ FROM THE HOST. `memory_get_peak_usage()` returns 0 in
					// this build, so the only live memory instrument is the linear memory itself.
					// An install ends at 92 MB fresh and 110 MB on an interpreter that has
					// rendered, against a 128 MB isolate -- close enough to be worth reporting,
					// though it is NOT what refused the install on the edge
					const heapBefore = this.php
						? (this.heapBytes(this.php.binary)?.length ?? 0)
						: 0;
					const t0 = Date.now();
					// AN INSTALL MUST NOT WAKE THE FILL CHAIN WHILE IT IS STILL RUNNING, and this
					// is what stopped a deployed enable from landing. The install writes
					// `cachetags`, `execSql()` reads that as a content change and calls
					// `bumpGeneration()`, which purges `cfw_page`, re-queues what it purged and
					// arms an alarm at +1 ms -- so a fill fires while the install still has ~5
					// seconds of work and an open implicit transaction. The object is then reset
					// with "Internal error in Durable Object storage caused object to be reset"
					// and every row of the install rolls back.
					//
					// Measured on a deployed worker: 0/6 installs landed with the bump inline,
					// 12/12 with the requeue suppressed. Same idiom `migrateStepIfPending()` uses
					// for the same reason -- the bump is not skipped, it is MOVED to after the
					// install's own writes are done, so the chain runs in a later invocation.
					const priorSuppress = this.suppressBump;
					this.suppressBump = true;
					const reply = await this.runJson(
						`${preamble}\n${ENABLE_MODULE.replace(/^<\?php\n/, '')}`
					);
					this.suppressBump = priorSuppress;
					const heapAfter = this.php ? (this.heapBytes(this.php.binary)?.length ?? 0) : 0;
					// and dropped again afterwards, for the same reason and one more: the install
					// rebuilt the container, so the resident interpreter holds a module list and a
					// service graph that are already stale. ENABLE_VERIFY has always run on a
					// dropped interpreter for exactly that reason
					if (!keepInterpreter) {
						this.php = null;
					}
					const tally = this.writeTally;
					this.writeTally = undefined;
					// how many times the router was REBUILT, read from the statement shape rather
					// than inferred by dividing rows by a subtrahend nobody measured. One rebuild
					// over 419 routes is 2,095 rows and an enable measured 17,188, so the cost is
					// a repeat rather than one large burst -- this is the field that proves which.
					const routes = Number(
						this.sql
							.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM router')
							.toArray()[0]?.c ?? 0
					);
					// NOW the invalidation, and it is not optional: an install changes routes,
					// the container and the module list, so every cached page is stale. Deferred
					// to here rather than skipped -- the alarm this arms fires after the event
					// closes instead of during it, which is the whole difference
					const bump =
						reply?.ok === true && !dry && stopAt === ''
							? this.bumpGeneration('module-install', { arm: false })
							: null;
					// NOTHING ARMS THE FILL CHAIN FROM IN HERE, AND THAT IS THE FIX. Calling
					// `setAlarm()` inside the install's event is what stopped an install landing on
					// the edge: the object is reset with "Internal error in Durable Object storage
					// caused object to be reset" and the whole install rolls back. Measured across
					// four deployed builds, `token` into a prefilled site:
					//
					//   arm inline at +1 ms (`armFillAlarm`)   0/6 landed
					//   arm awaited at +1000 ms                1/6 landed
					//   requeue suppressed entirely           12/12 landed
					//   requeue kept, NO alarm armed           6/6 landed
					//
					// So it is the `setAlarm()` call, not the requeue writes and not when the alarm
					// fires -- awaiting it and pushing it a full second out did not help. The queue
					// rows are written; `armInstallFill()` wakes them from a SEPARATE event.
					const armFill = bump !== null && bump.requeued > 0;
					return Response.json({
						...(reply ?? { ok: false, error: 'no reply' }),
						localMs: Date.now() - t0,
						bump,
						// the caller's cue to poke `/__armfill`, which is a second event and
						// therefore safe; reported rather than assumed so a client that ignores it
						// is a visible choice
						armFill,
						heapBefore,
						heapAfter,
						// BOTH HALVES. The wasm heap above is linear memory; MEMFS file contents
						// are JS-side typed arrays and are not in it, so a reading of one is not a
						// reading of the isolate. blob + index + the resident cache is the other
						// half, and it is the half `LAZY_FS_BUDGET_BYTES` bounds
						mountBytes: lazyMountBytes(this.mountInfo),
						rowsWritten: tally?.rowsWritten ?? 0,
						writeStatements: tally?.statements ?? 0,
						routes,
						routerStatements: tally?.statementsByTable['router'] ?? 0,
						routerRebuilds: tally ? routerRebuilds(tally, routes) : null,
						byTable: tally ? rankTally(tally) : [],
						// charged rows per statement per table, which is where an index audit starts:
						// a factor above 1 means something other than the row is being billed
						amplification: tally ? amplification(tally) : [],
						overheadShare: tally ? overheadShare(tally) : 0,
						// WHICH statements, not just how many: an 8x cost surprise is a question the
						// two counters cannot answer between them
						shapes: tally
							? Object.entries(tally.shapes ?? {})
									.sort((a, b) => b[1] - a[1])
									.slice(0, 8)
							: [],
						containerRows: Number(
							this.sql
								.exec<Row<{ c: number }>>(
									'SELECT COUNT(*) AS c FROM cache_container'
								)
								.toArray()[0]?.c ?? 0
						),
						// the widest single value the install wrote, against the 2,199,995-byte
						// per-record limit this project measured. A compiled container is one
						// blob, so it is the row most likely to reach it
						containerBytes: Number(
							this.sql
								.exec<Row<{ b: number }>>(
									'SELECT COALESCE(MAX(LENGTH(data)), 0) AS b FROM cache_container'
								)
								.toArray()[0]?.b ?? 0
						)
					});
				}

				case '/__ops': {
					const registry = await this.runJson(OPS_REGISTRY);
					if (!registry?.ok) {
						return Response.json(registry ?? { ok: false, error: 'no reply' }, {
							status: 500
						});
					}
					const name = url.searchParams.get('op');
					if (!name) {
						return Response.json({
							...registry,
							how: 'GET /ops?op=<name> to run one; sliced operations are refused with their driver named'
						});
					}

					const ops = (registry.operations ?? {}) as Record<string, Payload>;
					const op = ops[name];
					if (!op) {
						// fails closed: an unknown name is treated as writing and sliced, so a typo
						// cannot be run as if it were a read
						return Response.json(
							{
								ok: false,
								error: `unknown operation ${name}`,
								known: Object.keys(ops),
								treatedAs: registry.failsClosed
							},
							{ status: 404 }
						);
					}

					if (op.sliced === true) {
						return Response.json(
							{
								ok: false,
								error: `${name} is sliced and cannot run in one invocation`,
								cost: op.cost,
								writes: op.writes,
								driver:
									OPS_DRIVERS[name] ??
									'no driver exists yet; this operation is declared, not implemented'
							},
							{ status: 501 }
						);
					}

					// only `status` reaches here, and it is the one operation measured at "one read"
					return Response.json({
						ok: true,
						op: name,
						cost: op.cost,
						status: {
							generation: this.packGeneration(),
							// read from the CURSOR, not the in-memory flag. `this.migrated` is set
							// during a migration and hibernation discards it, so a fully migrated
							// site that had since been evicted reported `migrated: false` while its
							// cursor read `done` -- observed, and exactly the sort of status a
							// reader trusts.
							// migrateCursorOrNull() rather than readMigrateCursor(): `cfw_migrate`
							// does not exist on a site that never started a migration, and reading
							// it directly threw SQLITE_ERROR out of a status route
							migrated: this.migrateCursorOrNull()?.state === 'done',
							migratePartial: this.migratePartial(),
							bootMs: this.bootMs,
							firstRunAt: this.metaGet(FIRST_RUN_KEY),
							serveRequests: Number(this.metaGet('serve_requests', '0')),
							queueDepth: this.queueDepth()
						}
					});
				}

				/**
				 * First-run configuration: the first thing a user does with a new site.
				 *
				 * A secret must not arrive in a query string. `?pass=` puts the admin password into
				 * the request line, which `wrangler tail` prints, observability stores and every
				 * intermediary logs -- and this is the one route whose whole job is setting that
				 * password. So a password is accepted from a POST BODY only, and a `pass` query
				 * parameter is REFUSED rather than quietly honoured: honouring it would leave the
				 * insecure path working and therefore the one everybody keeps using.
				 *
				 * A bare GET reports state instead of doing anything, because a UI needs to ask
				 * "has this site been configured yet" without configuring it.
				 */
				case '/__firstrun': {
					const doneAt = this.metaGet(FIRST_RUN_KEY);
					const force = url.searchParams.get('force') === '1';

					if (url.searchParams.has('pass')) {
						return Response.json(
							{
								ok: false,
								error: 'refusing a password in a query string; it is logged by tail, observability and every intermediary',
								how: 'POST /firstrun with a JSON body: {"adminPass":"...","siteName":"..."}'
							},
							{ status: 400 }
						);
					}

					if (request.method !== 'POST') {
						return Response.json({
							ok: true,
							configured: doneAt !== null,
							firstRunAt: doneAt === null ? null : Number(doneAt),
							appliedKeys: this.metaGet('first_run_keys'),
							how: 'POST /firstrun with a JSON body to configure; a bare GET only reports'
						});
					}

					if (doneAt !== null && !force) {
						// idempotent by default: a second run would silently reset the admin password,
						// and a retried request is a much more likely cause than a deliberate redo
						return Response.json(
							{
								ok: false,
								error: 'already configured',
								firstRunAt: Number(doneAt),
								how: 'POST /firstrun?force=1 with the owner token to reconfigure deliberately'
							},
							{ status: 409 }
						);
					}

					// FORCE ON A PROVISIONED SITE IS A TAKEOVER unless the caller owns it.
					//
					// Provisioning is trust-on-first-use: this route is reachable without diagnostics
					// so a site owner can obtain the token at all, which is what `/export` needs and
					// what "a customer can leave" rests on. The claim window is the unprovisioned
					// state and nothing else -- once `first_run_at` is set, `force=1` resets the admin
					// password, so it is gated on the token minted by the run that set it.
					//
					// Checked HERE rather than in the Worker because this is where the secret lives; a
					// gate in front is a second place to get it right, not the place it has to be
					// right. `PW_DIAGNOSTICS=1` is still a way in, unchanged.
					if (doneAt !== null && force && this.env.PW_DIAGNOSTICS !== '1') {
						const presented = bearerToken(request.headers.get('authorization'));
						if (!tokenMatches(presented, this.metaGet(OWNER_TOKEN_KEY))) {
							return Response.json(
								{
									ok: false,
									error: 'already configured; reconfiguring needs the owner token',
									how: 'POST /firstrun?force=1 with Authorization: Bearer <ownerToken>'
								},
								{ status: 401 }
							);
						}
					}

					let body: Payload = {};
					try {
						body = (await request.json()) as Payload;
					} catch {
						return Response.json(
							{ ok: false, error: 'body is not JSON' },
							{ status: 400 }
						);
					}
					const str = (k: string): string | undefined =>
						typeof body[k] === 'string' && body[k].length > 0 ? body[k] : undefined;

					// The pack ships uid 1 with an EMPTY hash, which password_verify() rejects for every
					// input, so a site that finishes first run without a password has no way in at
					// all. Minting one here is what keeps the deploy one-click; it is returned once in
					// this response and stored nowhere, so a lost response means using password reset
					// rather than reading it back out of the database.
					const minted = str('adminPass') === undefined ? randomKeyBase64(18) : undefined;

					const applied = await this.runJson(
						firstRunConfig({
							siteName: str('siteName'),
							siteMail: str('siteMail'),
							adminName: str('adminName'),
							adminMail: str('adminMail'),
							adminPass: str('adminPass') ?? minted,
							timezone: str('timezone')
						})
					);
					if (applied?.ok) {
						this.metaSet(FIRST_RUN_KEY, this.nowMs());
						// claiming a site also fixes its origin, which closes the window
						// trust-on-first-use leaves open: the owner is here, deliberately, on the
						// host they mean. Overwrites whatever a first visitor pinned.
						if (pinnable(url.origin)) this.metaSet(ORIGIN_KEY, url.origin);
						// the KEYS, never the values: this row is readable by anything that can read
						// the database, and one of those values is a password
						this.metaSet(
							'first_run_keys',
							[
								...Object.keys(body).filter((k) => str(k) !== undefined),
								...(minted === undefined ? [] : ['adminPass:minted'])
							]
								.sort()
								.join(',')
						);
						// config changed, so any cached page is stale
						this.bumpGeneration('firstrun');
					}
					// the minted password rides this response and is stored nowhere; added after the
					// PHP result so a failed run cannot hand back a password it never set
					// The OWNER TOKEN rides it too, and this is the only place it is handed out. It
					// is what reaches `/export` WITHOUT `PW_DIAGNOSTICS=1`, so leaving no longer
					// requires exposing arbitrary SQL and a whole-database overwrite alongside it.
					return Response.json(
						applied?.ok
							? {
									...applied,
									...(minted === undefined
										? {}
										: {
												adminPass: minted,
												adminPassNote:
													'minted for this site and shown once; store it now'
											}),
									ownerToken: ensureOwnerToken(this.secretStore()),
									ownerTokenNote:
										'send as Authorization: Bearer <token> to reach /export without PW_DIAGNOSTICS; shown once'
								}
							: applied
					);
				}

				/**
				 * Runs the capability plugins for the first time.
				 *
				 * Prefetches the URL the check reads BEFORE entering PHP, because that is the
				 * only order in which a synchronous `cfwFetch` can succeed: awaiting belongs
				 * in JS, and PHP has no way to wait for it.
				 */
				case '/__capability': {
					const testUrl = url.searchParams.get('url') ?? 'https://example.com/';
					this.queueHttp(testUrl);
					const drained = await this.drainHttpQueue(3);
					this.logs = [];
					this.mails = [];
					const php = await this.runJson(CAPABILITY_CHECK);
					// the logger's evidence is host-side: the entries actually arrived
					const marks = php?.markers ?? {};
					const sawDirect = (this.logs ?? []).some((l) =>
						String(l?.message ?? '').includes(String(marks.direct ?? '\0'))
					);
					const sawChannel = (this.logs ?? []).some((l) =>
						String(l?.message ?? '').includes(String(marks.channel ?? '\0'))
					);
					return Response.json({
						...php,
						prefetch: drained,
						hostSideEvidence: {
							logEntriesReceived: (this.logs ?? []).length,
							directLogArrived: sawDirect,
							channelLogArrived: sawChannel,
							levels: [...new Set((this.logs ?? []).map((l) => l?.level))],
							channels: [...new Set((this.logs ?? []).map((l) => l?.channel))],
							mailAttempts: this.mails ?? [],
							httpQueueRemaining: Number(
								this.sql
									.exec<Row<{ c: number }>>(
										'SELECT COUNT(*) AS c FROM cfw_http_queue'
									)
									.toArray()[0]?.c ?? 0
							)
						}
					});
				}

				/**
				 * Destructive by design.
				 *
				 * Reads a URL through the build's NATIVE https wrapper -- the one
				 * `stream_get_wrappers()` advertises -- with no capability wrapper
				 * registered. It throws `ReferenceError: Asyncify is not defined` out of the
				 * wasm import, which is a JS exception: `@` does not suppress it, PHP's
				 * `catch (\Throwable)` never sees it, and the invocation dies with the
				 * interpreter parked mid-call.
				 *
				 * Kept as its own route so the finding is reproducible without taking the
				 * capability suite down, and so nothing has to take it on trust.
				 */
				case '/__nativefetch': {
					const target =
						url.searchParams.get('url') ?? 'https://example.com/native-probe';
					try {
						const raw = await this.run(
							`<?php $b = @file_get_contents(${JSON.stringify(target)}); echo json_encode(['bytes' => is_string($b) ? strlen($b) : -1]);`
						);
						return Response.json({ survived: true, raw: raw.slice(0, 400) });
					} catch (e: any) {
						return Response.json({
							survived: false,
							// the whole finding in one field
							jsError: String(e?.message ?? e),
							note: 'a JS exception out of the wasm import; PHP cannot catch it and the interpreter is left parked'
						});
					}
				}

				// drains what PHP deferred; the fetch happens HERE, in JS, where awaiting
				// is legal, and lands in the cache the next PHP run reads synchronously
				case '/__httpdrain':
					return Response.json(
						await this.drainHttpQueue(Number(url.searchParams.get('limit') ?? 5))
					);

				// the mb_* wrappers, exercised where the polyfill is real
				case '/__mb':
					return Response.json(await this.runJson(MB_CHECK));

				/**
				 * The serving path.
				 *
				 * Three outcomes, and the header says which: `HIT` answers from SQL
				 * without touching PHP, `RENDER` rendered the page in this invocation,
				 * `MISS` returned a placeholder and left the alarm chain to do it.
				 *
				 * A MISS used to be the only non-HIT outcome, which meant the first
				 * visitor to every URL got a 202 that is not the page. Rendering inline
				 * fixes that, and it is a UX fix ONLY. It buys no CPU: a Durable Object
				 * invocation carries the same 10 ms free-plan cap as any Worker, a warm
				 * minimal render measured 20.02 ms of cpuTime on the deployed edge, and
				 * that does not fit whether it runs in a fetch or in an alarm. What the
				 * caller's Worker pays is wall time rather than CPU -- 4 ms of CPU against
				 * 827 ms of wall, measured -- so the visitor waiting is cheap; the render
				 * itself costs exactly what it always cost, in the same place.
				 *
				 * Inline is skipped unless the estimate fits the budget, which in practice
				 * means the interpreter is already up: see estimateRenderMs().
				 */
				case '/__serve': {
					this.ensureServeTables();
					const path = url.searchParams.get('path') ?? '/';
					const t0 = Date.now();

					// A HALF-MIGRATED SITE MUST NOT RENDER.
					//
					// Chunked migration made this reachable for the first time: `/migrate` now
					// returns after one chunk on the free plan, so between the deploy and the last
					// alarm firing there is a real window where Drupal would boot against a quarter
					// of its own database. It does not fail cleanly either -- it renders, with
					// truncated caches, and a rendered page gets written to the page cache and the
					// edge. A 503 with Retry-After is the right answer, and it is cheap because the
					// check is one indexed read of a single row.
					// A PAGE REQUEST IS THE TRIGGER, because on the canonical config nothing else can
					// be. `/migrate` is diagnostic-gated, so a deployed site had no reachable way to
					// provision itself and answered `warming` forever. Arming the alarm rather than
					// migrating inline keeps the replay off the request path, where it belongs: the
					// chain is already resumable and already re-arms itself until the cursor is done.
					if (this.neverMigrated()) {
						await this.requestProvision();
						return warmingResponse({
							stage: 'migrating',
							retryAfterSeconds: 2,
							request,
							headers: {
								'x-cfw-migrate': 'starting',
								'x-cfw-migrate-state': 'queued'
							}
						});
					}

					const partial = this.migratePartial();
					if (partial) {
						return warmingResponse({
							stage: 'migrating',
							// seconds, and short: the alarm chain re-arms at +1 ms
							retryAfterSeconds: 1,
							request,
							headers: {
								'x-cfw-migrate': `${partial.chunk}/${partial.chunks}`,
								'x-cfw-migrate-state': partial.state
							}
						});
					}
					this.sql.exec(
						`INSERT INTO cfw_meta (k, v) VALUES ('serve_requests', '1')
             ON CONFLICT(k) DO UPDATE SET v = CAST(cfw_meta.v AS INTEGER) + 1`
					);

					// an unclaimed site shows its owner the way in, rather than its front page.
					// The pack ships an installed database, so `install.php` never runs and uid 1
					// carries an empty hash no password can match: a site that looks finished has no
					// way in until `/firstrun` mints one, and the claim window stays open for
					// whoever reaches the URL first. Placed AFTER the migration guards so a site
					// that is still replaying says so instead, and after the counter so an
					// unclaimed site's traffic is still metered.
					if (needsSetup(request, this.metaGet(FIRST_RUN_KEY) !== null)) {
						return setupResponse(this.canonicalOrigin(url.origin), {
							'x-cfw-serve-ms': String(Date.now() - t0),
							'x-cfw-v': CFW_HEADER_VERSION
						});
					}

					// THE READ-ONLY RUNG, checked before the cache read rather than after: a
					// non-GET must be refused whether or not a cached copy of the path exists,
					// because what it would do is WRITE
					const degraded = this.degradation();
					if (!degraded.writes && request.method !== 'GET' && request.method !== 'HEAD') {
						return readOnlyResponse(secondsUntilUtcReset(Date.now()), degraded);
					}

					// A SUBMISSION MUST NEVER BE ANSWERED FROM `cfw_page`.
					//
					// The row holds an ANONYMOUS GET of this path. Returning it for a POST hands the
					// submitter the empty form back with a 200 and never runs Drupal, so the
					// submission silently does nothing -- no validation, no mail, no content. Found
					// by the e2e mail lane: `/user/password` ships in `prefill.json`, so it is
					// pre-cached on every site and every password reset was swallowed.
					//
					// and neither is a session: same row, same reason, and `fillOne()` already
					// refuses to STORE one, so only the write half of this was ever enforced
					const authenticated = hasSessionCookie(request.headers.get('cookie'));
					const cacheable =
						(request.method === 'GET' || request.method === 'HEAD') && !authenticated;
					const hit = cacheable
						? this.sql
								.exec<PageRow>(
									'SELECT status, content_type, html, rendered_at, render_ms FROM cfw_page WHERE path = ?',
									path
								)
								.toArray()[0]
						: undefined;

					if (hit) {
						return this.pageResponse(hit, 'HIT', Date.now() - t0, {
							// the gated lane answered, so either the tables were not ready yet or
							// lane=gate forced it; both are visible rather than inferred
							'x-cfw-lane': 'php-gate'
						});
					}

					// Queued BEFORE the inline attempt. The alarm chain is the safety net for a
					// render this invocation cannot finish -- the free tier kills it at 10 ms of
					// CPU, and the caller can walk away -- and a successful fill deletes the row
					// again.
					//
					// never for a session: the chain renders anonymously, so an admin's path filled
					// `cfw_page` with Drupal's 403 and published it as the public page
					//
					// `degraded.queue` is the 80% rung, and it had NO READER -- so the reduced band
					// between 80% and 95% stopped nothing, and each queued path costs ~13 rows on the
					// meter that put the site there. `FILL_QUEUE_MAX` bounds the table itself: an
					// anonymous visitor asking for distinct paths grew it without limit
					const queueable =
						!authenticated && degraded.queue && this.queueDepth() < FILL_QUEUE_MAX;
					if (queueable) {
						this.sql.exec(
							'INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING',
							path,
							this.nowMs()
						);
					}
					// A pending alarm is not good enough: once the queue drains, alarm()
					// re-arms 240 s out for keep-warm, so a later MISS would sit behind it
					// for up to four minutes. Found by the integration test, which watched
					// /user/login never fill. Pull the alarm in whenever it is further away
					// than the next tick.
					const soon = this.nowMs() + 1;
					const existing = await this.ctx.storage.getAlarm();
					if (existing === null || existing > soon + 50) {
						await this.ctx.storage.setAlarm(soon);
					}

					// Rendering here is safe against the gate: fetch() takes the one gate
					// entry and handle() runs inside it, so fillOne() is already serialized
					// and must NOT re-enter -- a gated fetch() called from inside gate.run()
					// self-deadlocks, and blockConcurrencyWhile forbids nesting outright.
					// /__fill has always called fillOne() this way.
					//
					// ctx.waitUntil() is NOT an alternative to any of this: it extends the
					// SAME invocation, so its CPU lands on the same budget. An alarm is the
					// only mechanism that starts a fresh invocation with a fresh budget --
					// and even that does not make a 20 ms render fit a 10 ms cap.
					const budgetMs = this.inlineBudgetMs(url);
					const estimateMs = this.estimateRenderMs();
					// A COLD OBJECT REFUSES ON `!this.php`, NOT ON THE BUDGET, and that is the whole
					// shape of the free-plan MISS: the estimate is never consulted, so raising
					// RENDER_BUDGET_MS from 2,000 to 25,000 changed nothing. Paid is allowed to boot
					// and then render -- ~1.4 s of wall clock the visitor waits through instead of a
					// 503 -- because a 30 s CPU budget is what makes that affordable.
					// a MISS at the top rung answers 503 rather than spending ~13 rows on a
					// render the quota cannot pay for; the queue entry above still stands, so
					// the page fills once the day rolls over
					if (!degraded.render) {
						return readOnlyResponse(secondsUntilUtcReset(Date.now()), degraded);
					}
					// `bootInline: false` defers an anonymous GET to the chain, which is a wait. The
					// chain can render neither of these, so for them the same refusal is a dead end
					const submission = request.method !== 'GET' && request.method !== 'HEAD';
					const unfillable = submission || authenticated;
					const mayBoot = planProfile(this.env).bootInline || unfillable;
					const coldBoot = !this.php && mayBoot;
					let inline = '0';
					if (budgetMs <= 0 || url.searchParams.get('inline') === '0') {
						// an explicit lever is honoured even here; it is how a test forces a MISS
						inline = 'off';
					} else if (!this.php && !mayBoot) {
						inline = 'cold';
					} else if (estimateMs > budgetMs && !unfillable) {
						// diverting to the chain is the same dead end the boot gate just declined
						inline = 'over-budget';
					} else {
						// charge the authenticated allowance, and only here. A render is the thing
						// that costs -- a cache HIT above returned already, and an authenticated
						// request is refused `cfw_page` a few lines up. So this is the one point
						// where a logged-in visitor actually spends the reserved budget.
						//
						// Without this the counter had NO WRITER: `authAllowance()` enforced
						// against a spend that never incremented, so the allowance permitted
						// everything and the surface looked live while doing nothing.
						//
						// charged on the COOKIE, not on `x-cfw-auth`: that header rides in on a
						// request a client composed, so anyone could spend an operator's allowance
						//
						// One `ctx.storage.put`, inside the ~13 rows a real render already writes,
						// so the accounting does not meaningfully change what it accounts for.
						if (authenticated) {
							const stored = await this.ctx.storage.get<AuthSpend>('authSpend');
							// spendForToday() discards a record from another UTC day rather than
							// carrying it, which is what makes the budget daily rather than forever
							const today = spendForToday(stored ?? null);
							today.renders += 1;
							await this.ctx.storage.put('authSpend', today);
							this.authSpend = today;
						}
						// a submission is rendered with the method and body that arrived, and its
						// response is answered from the outcome rather than from `cfw_page`, which
						// deliberately never holds it
						// the cookie rides on both, because an authenticated GET and a form POST are
						// the same requirement seen twice: without it Drupal renders uid 0 and the
						// routing layer denies every create-entity route before a form is built
						const cookie = request.headers.get('cookie') ?? '';
						// pinned on the way past, so every render after the first agrees on the
						// host even if a later request arrives carrying a forged one
						const origin = this.canonicalOrigin(url.origin);
						// Drupal's flood control keys on this; without it the whole site shares one
						// bucket and 50 bad passwords lock everyone out of /user/login for an hour
						const clientIp = request.headers.get('cf-connecting-ip') ?? '';
						const inbound: RenderRequest =
							request.method === 'GET' || request.method === 'HEAD'
								? cookie
									? { origin, cookie, clientIp }
									: { origin, clientIp }
								: {
										origin,
										clientIp,
										method: request.method,
										// decoded from bytes rather than `.text()`, which workerd
										// warns may corrupt a non-text content type -- a form field
										// carrying a multi-byte character is exactly that case
										body: new TextDecoder().decode(
											await request.clone().arrayBuffer()
										),
										contentType: request.headers.get('content-type') ?? '',
										cookie
									};
						const outcome = await this.fillOne(path, undefined, undefined, inbound);
						if (outcome.page) {
							// built here rather than through `pageResponse()`, which hardcodes a
							// cacheable `cache-control` and cannot be overridden through its header
							// argument. A submission's response is for one submitter: it must not be
							// stored by the browser, by the edge, or by the Worker's own edge put
							const headers = new Headers({
								'content-type': outcome.page.contentType,
								'cache-control': 'private, no-store',
								'x-cfw-cache': 'RENDER',
								'x-cfw-method': String(request.method),
								'x-cfw-serve-ms': String(Date.now() - t0),
								'x-cfw-v': CFW_HEADER_VERSION
							});
							// APPENDED, never set: a login can emit more than one, and `set` would
							// keep the last and silently drop the session
							for (const line of outcome.page.setCookie) {
								headers.append('set-cookie', line);
							}
							if (outcome.page.location) {
								headers.set('location', outcome.page.location);
							}
							return new Response(String(outcome.page.html ?? ''), {
								status: outcome.page.status,
								headers
							});
						}
						if (outcome.filled === path) {
							const fresh = this.sql
								.exec<PageRow>(
									'SELECT status, content_type, html, rendered_at, render_ms FROM cfw_page WHERE path = ?',
									path
								)
								.toArray()[0];
							if (fresh) {
								return this.pageResponse(fresh, 'RENDER', Date.now() - t0, {
									// what the visitor spent and what is left, so the Worker in
									// front can degrade without a second round trip
									...(this.authSpend
										? authSpendHeaders(this.authSpend, authAllowance(this.env))
										: {}),
									'x-cfw-lane': 'php-gate',
									'x-cfw-inline-budget-ms': String(budgetMs),
									'x-cfw-inline-estimate-ms': String(estimateMs),
									// what the fill REPORTED paying for. `coldBoot` is the decision,
									// taken before the gate; these disagree whenever an alarm boots
									// the object while this request waits, and the deployed tail
									// showed exactly that
									'x-cfw-inline-boot': outcome.bootedInFill ? '1' : '0',
									'x-cfw-inline-boot-predicted': coldBoot ? '1' : '0',
									// says out loud that the wall clock could not time the render,
									// so nobody reads an estimate of 0 as "this render was free"
									'x-cfw-render-clock': this.renderClockUnmeasurable
										? 'unmeasurable'
										: 'ok'
								});
							}
						}
						// a failed render has already been counted against its three strikes;
						// fall through to the placeholder rather than 500 at the visitor
						inline = 'failed';
					}

					// 503, NOT 202. A 202 is a SUCCESS status: a crawler may index it, and the word
					// "warming" then becomes the page's content in search results, while a browser
					// renders it as the page. 503 with Retry-After is the only answer that says
					// "not yet, come back" to a browser, a CDN and a crawler alike -- and it is the
					// same reasoning already applied to the half-migrated case above.
					return warmingResponse({
						stage: 'warming',
						// seconds, short because the fill is queued and the alarm re-arms fast
						retryAfterSeconds: 1,
						request,
						headers: {
							'x-cfw-cache': 'MISS',
							'x-cfw-lane': 'php-gate',
							'x-cfw-generation': String(this.generation()),
							'x-cfw-queued': '1',
							'x-cfw-queue-depth': String(this.queueDepth()),
							'x-cfw-miss-ms': String(Date.now() - t0),
							'x-cfw-serve-ms': String(Date.now() - t0),
							'x-cfw-php-booted': this.php ? '1' : '0',
							'x-cfw-inline': inline,
							'x-cfw-inline-budget-ms': String(budgetMs),
							'x-cfw-inline-estimate-ms': String(estimateMs),
							'x-cfw-plan': isPaid(this.env) ? 'paid' : 'free'
						}
					});
				}

				/**
				 * The write-refresh loop: save a node, then re-render.
				 *
				 * Reports the generation either side, because a content save must trigger the
				 * automatic invalidation seam with nothing here calling `bumpGeneration()`
				 * directly -- that is the difference between an edge cache that shows fresh
				 * content and one that shows yesterday's.
				 */
				case '/__savenode': {
					const genBefore = this.generation();
					const cachedBefore = Number(
						this.sql
							.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_page')
							.toArray()[0]?.c ?? 0
					);
					const before = this.queryCount;
					const txnBefore = this.txnCount ?? 0;
					const txnStmtBefore = this.txnStatements ?? 0;
					const specBefore = this.txnSpeculative ?? 0;
					const t0 = Date.now();
					const php = await this.runJson(
						saveNode({
							title: url.searchParams.get('title') ?? undefined,
							type: url.searchParams.get('type') ?? undefined,
							body: url.searchParams.get('body') ?? undefined
						})
					);
					return Response.json({
						...php,
						wallMs: Date.now() - t0,
						hostStatementsTotal: this.queryCount - before,
						transactions: (this.txnCount ?? 0) - txnBefore,
						transactionStatements: (this.txnStatements ?? 0) - txnStmtBefore,
						speculativeReplays: (this.txnSpeculative ?? 0) - specBefore,
						generationBefore: genBefore,
						generationAfter: this.generation(),
						cfwPageRowsBefore: cachedBefore,
						cfwPageRowsAfter: Number(
							this.sql
								.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_page')
								.toArray()[0]?.c ?? 0
						)
					});
				}

				// Drives Drupal's own Cache::invalidateTags() so the automatic seam is
				// exercised end to end: the cachetags write crosses execSql() and the
				// generation bump must follow with nothing here calling it directly.
				case '/__invalidate': {
					const tags = (url.searchParams.get('tags') ?? 'rendered')
						.split(',')
						.map((t) => t.trim())
						.filter(Boolean);
					const before = this.generation();
					const php = await this.runJson(invalidateTags(tags));
					const after = this.generation();
					return Response.json(
						{ ...php, generationBefore: before, generationAfter: after },
						{ headers: { 'x-cfw-generation': String(after) } }
					);
				}

				// one integer write invalidates every edge-cached URL for this site; see
				// bumpGeneration() for why tag purging is not attempted
				case '/__bump': {
					const out = this.bumpGeneration(url.searchParams.get('reason') ?? 'manual');
					return Response.json(
						{ ...out, bumps: this.bumps ?? 0 },
						{ headers: { 'x-cfw-generation': String(out.generation) } }
					);
				}

				// drives one fill synchronously, so the chain is testable without waiting
				// on the runtime's alarm scheduling
				case '/__fill':
					return Response.json(await this.fillOne());

				/**
				 * One assembly per invocation, which is the shape RULE 0 requires.
				 *
				 * Identical to the /__serve inline-MISS render except that only the `page`
				 * bin is emptied, so `dynamic_page_cache` answers and the page is
				 * reassembled from cached render arrays. The row is deleted first so the
				 * render actually happens rather than being served from cfw_page.
				 *
				 * `dynamicCache` is echoed back: a HIT is the precondition for
				 * the timing meaning anything, and a DPC entry made under a different PHP
				 * could silently MISS. Read it before reading the clock.
				 */
				case '/__assemble': {
					this.ensureServeTables();
					const path = url.searchParams.get('path') ?? '/';
					const bins = (url.searchParams.get('bins') ?? 'page')
						.split(',')
						.map((b) => b.trim())
						.filter(Boolean);
					this.sql.exec('DELETE FROM cfw_page WHERE path = ?', path);
					// destruct=0 reproduces the lifecycle this project shipped for its whole
					// history, so the collector-persistence claim is an A/B rather than a story
					// absent, empty and "0" all mean the default (off); "1" means the safe
					// set; anything else is an allowlist of service ids to bisect with
					const destructParam = url.searchParams.get('destruct');
					const destruct =
						destructParam === null || destructParam === '' || destructParam === '0'
							? false
							: destructParam === '1'
								? true
								: destructParam;
					const before = this.queryCount;
					const beforeWritten = this.rowsWritten ?? 0;
					const t0 = Date.now();
					const outcome = await this.fillOne(path, bins, destruct);
					return Response.json({
						...outcome,
						bins,
						destruct,
						wallMs: Date.now() - t0,
						hostStatements: this.queryCount - before,
						rowsWritten: (this.rowsWritten ?? 0) - beforeWritten,
						phpBooted: !!this.php
					});
				}

				case '/__serve-stats': {
					this.ensureServeTables();
					return Response.json({
						// how many stored pages could be served as a shared shell with their
						// personalised regions filled at the edge. The input for deciding whether
						// authenticated caching is worth finishing on THIS site rather than in
						// general: a site whose pages carry no placeholders has nothing to gain
						shellCandidates: this.shellCandidates(),
						// PHP-to-host crossings for the LAST render, per capability. Not a billed
						// meter today -- a `cfw*` call is a wasm import into the same isolate -- so
						// this prices the refactor risk the docs create: an RPC method call IS
						// billed as a DO request, so a migration would convert each of these into
						// one. `crossingCapabilities` says which names were present to wrap, so a
						// 0 cannot be read as "never called" when it means "never installed"
						crossings: this.lastRenderCrossings ?? null,
						crossingsTotal: this.crossings?.total ?? 0,
						crossingCapabilities: this.crossingNames ?? [],
						cached: this.sql
							.exec(
								'SELECT path, status, length(html) AS bytes, render_ms, rendered_at FROM cfw_page ORDER BY path'
							)
							.toArray(),
						queue: this.sql
							.exec(
								'SELECT path, attempts, last_error FROM cfw_fill_queue ORDER BY queued_at'
							)
							.toArray(),
						alarmFirings: this.alarmFirings ?? 0,
						lastAlarmAt: this.lastAlarmAt ?? null,
						// GC and page fills spend the same meter, so its cost is reported next to
						// the fill accounting rather than in a separate place
						lastGc: this.lastGc ?? null,
						lastGcAt: this.lastGcAt ?? null,
						// the ONLY place an Asyncify-boundary failure is observable: it produces
						// no PHP fatal, no printErr and no Drupal log entry, so a PHP-side
						// shutdown handler cannot see it at all
						asyncifyCalls: shimGlobals.__cfwAsyncifyCalls ?? 0,
						// rows written is the free plan's binding meter; GC and fills compete for it.
						// TWO figures: `rowsWritten` counts only what went through
						// execSql(), so it sees Drupal's statements and none of the host's, while
						// `rowsToday` comes from countingSql() wrapping the storage handle and is
						// therefore complete. The first is kept because measurements are pinned to
						// it; the second is the one a quota decision should use.
						rowsWritten: this.rowsWritten ?? 0,
						rowsToday: this.dailyRows(),
						// the second daily ceiling the architecture is scored against, and it read
						// "nothing measures this yet" until now. Counts invocations that REACHED this
						// object; an edge-cache hit never enters the isolate, so this is deliberately
						// not the Worker-request meter
						doRequestsToday: this.dailyDoRequests(),
						// the image hard cap is a function of CONTENT, not traffic, so it can be
						// counted rather than projected: one transformation per style per image, which
						// is exactly what these two counts multiply out to. null when the tables are
						// absent, because an unmigrated site has no image styles and 0 would read as
						// a verified zero
						imageStyles: this.countOrNull('config', "name LIKE 'image.style.%'"),
						managedImages: this.countOrNull('file_managed', "filemime LIKE 'image/%'"),
						// null rather than 0 when the table does not exist: an unmigrated site has
						// no semaphore table, and reporting 0 would look like a verified invariant
						semaphoreHeld: this.countOrNull('semaphore'),
						// the deferred outbound-HTTP queue, so an unattended drain is verifiable
						// rather than assumed. null when the tables do not exist yet
						httpQueue: this.countOrNull('cfw_http_queue'),
						lastHttpDrain: this.lastHttpDrain ?? null,
						lastHttpDrainAt: this.lastHttpDrainAt ?? null,
						// the outbound mail queue, on the same terms. A send that failed at the
						// relay is only visible here: `cfwMail` had already returned by then, so
						// this is the surface that keeps a queued-but-undelivered message auditable
						mailQueue: this.countOrNull('cfw_mail_queue'),
						lastMailDrain: this.lastMailDrain ?? null,
						lastMailDrainAt: this.lastMailDrainAt ?? null,
						// null on a site that never ran an update; a live run holds the alarm chain
						updb: this.lastUpdb ?? null,
						updbActive: this.updbActive(),
						// null when migration was never started, so "not started" and "finished" are
						// distinguishable rather than both reading as absent
						migrate: this.migrateCursorOrNull(),
						lastAlarmOutcome: this.lastAlarmOutcome ?? null,
						phpBooted: !!this.php,
						// which lane answered, so the split is observable rather than claimed
						storageLaneServes: this.storageLaneServes ?? 0,
						phpLaneEntries: this.phpLaneEntries ?? 0,
						gate: this.gate.stats(),
						generation: this.generation(),
						bumps: this.bumps ?? 0,
						lastBump: this.metaGet('last_bump'),
						// persisted rather than an instance field so eviction cannot reset it
						// mid-test; the edge-tier assertion is "this counter did not move"
						serveRequests: Number(this.metaGet('serve_requests', '0'))
					});
				}

				case '/__migrate': {
					const force = url.searchParams.get('force') === '1';
					// The CURSOR decides, not the in-memory flag. `this.migrated` is discarded on
					// hibernation and is set by whichever call last touched this instance, so an
					// object that migrated via the alarm chain and then got evicted would answer
					// "not migrated" and replay. The cursor is durable and is the actual answer.
					const cursor = this.migrateCursorOrNull();
					const alreadyDone = cursor?.state === 'done' || this.migrated === true;
					if (alreadyDone && !force) {
						// `done` is present on EVERY response from this route, including this one.
						// Omitting it here made a caller that branches on `done === false` read
						// `undefined` and conclude nothing -- which is exactly what happened to
						// scripts/test-serve-chain.mjs
						return Response.json({
							ok: true,
							skipped: true,
							done: true,
							reason: 'already migrated',
							chunk: cursor?.chunk ?? null,
							chunks: cursor?.chunks ?? null,
							engine: migrateEngine(url, this.env)
						});
					}
					// replaying the pack inserts the packed cachetags rows; that is setup,
					// not a content change, so it must not bump the generation
					this.suppressBump = true;
					let result: Payload;
					try {
						result =
							migrateEngine(url, this.env) === 'php'
								? await this.runJson(MIGRATE_DB)
								: await this.migrateChunks(url);
						// a partial pass has a half-populated database; seeding the serving table
						// then would publish pages the site cannot yet reproduce on invalidation
						if (result?.done === false) {
							result.prefilled = 0;
							result.prefillNote = 'migration is partial; prefill waits for done';
						} else if (result && typeof result === 'object') {
							// most specific wins: request param, then PREFILL env, then the plan
							Object.assign(
								result,
								await this.prefillServingTable(url.searchParams.get('prefill'))
							);
						}
					} finally {
						this.suppressBump = false;
					}
					// `done !== false` rather than `ok === true`: the chunked engine returns
					// ok:true on a PARTIAL pass, and treating that as migrated would let a render
					// run against a half-populated database
					this.migrated = !result.error && result.ok === true && result.done !== false;
					return Response.json({
						...result,
						queryCount: this.queryCount,
						databaseSize: Number(this.sql.databaseSize)
					});
				}

				/**
				 * Raw SQL against ctx.storage.sql, no PHP involved.
				 *
				 * The route table has mapped `/sql` here since the beginning and the handler was
				 * never written, so every call returned an empty body and a JSON parse error at the
				 * front end. It exists now because platform limits have to be measurable directly:
				 * the bound-parameter ceiling below was found by bisecting through this route, and
				 * asking PHP would have measured the driver instead of the platform.
				 *
				 * `params` is a JSON array; `repeat` binds the same value N times, which is how you
				 * probe a parameter ceiling without composing a giant URL.
				 */
				/**
				 * How much ONE Durable Object event may write, which nothing had measured.
				 *
				 * The per-record cap (2,199,995 bytes) and the statement-text cap (100,000 chars)
				 * are both known; the aggregate write set of a single event is the third limit in
				 * that family, and a module install runs into it -- the install completes and the
				 * object is then reset with "Internal error in Durable Object storage caused
				 * object to be reset", rolling every row back.
				 *
				 * No Drupal, no PHP: a loop of plain inserts, so a reset here is the platform
				 * refusing bytes rather than anything this project built. Each point wants its own
				 * fresh object, because the failing call takes the object down with it.
				 */
				/**
				 * Wakes the fill chain from an event of its own.
				 *
				 * Exists because `/__enable` may not arm its own alarm -- see the measurement
				 * table there. One `setAlarm()` and nothing else, so the event that arms is not
				 * an event that is also writing thousands of rows.
				 */
				case '/__armfill': {
					const queued = this.queueDepth();
					if (queued > 0) await this.ctx.storage.setAlarm(this.nowMs() + 1);
					return Response.json({ ok: true, queued, armed: queued > 0 });
				}

				case '/__txnprobe': {
					const rows = Math.max(1, Number(url.searchParams.get('rows') ?? 100));
					const size = Math.max(1, Number(url.searchParams.get('size') ?? 1024));
					if (rows * size > 512 * 1_048_576) {
						return Response.json(
							{ ok: false, error: 'refusing to attempt over 512 MiB' },
							{ status: 400 }
						);
					}
					const blob = 'x'.repeat(size);
					this.sql.exec(
						'CREATE TABLE IF NOT EXISTS cfw_txn_probe (id INTEGER PRIMARY KEY, data TEXT)'
					);
					this.sql.exec('DELETE FROM cfw_txn_probe');

					// SPECULATIVE ROLLBACKS, which is the one thing an install does that no other
					// path does. `cfw_do_sqlite` answers a read against uncommitted buffered
					// writes by replaying them inside `transactionSync()` and THROWING to discard
					// it -- the measured rollback mechanism. One enable does 34 of those in a
					// single event, and nothing else here does more than a handful
					const speculations = Math.max(0, Number(url.searchParams.get('spec') ?? 0));
					let rolledBack = 0;
					for (let i = 0; i < speculations; i++) {
						try {
							this.ctx.storage.transactionSync(() => {
								this.sql.exec(
									'INSERT INTO cfw_txn_probe (data) VALUES (?)',
									`spec-${i}`
								);
								throw new Error('cfw speculative rollback');
							});
						} catch {
							rolledBack++;
						}
					}

					let written = 0;
					for (let i = 0; i < rows; i++) {
						this.sql.exec('INSERT INTO cfw_txn_probe (data) VALUES (?)', blob);
						written += size;
					}
					// read back inside the same event, so a silently-dropped write is not counted
					const seen = Number(
						this.sql
							.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_txn_probe')
							.toArray()[0]?.c ?? 0
					);
					return Response.json({ ok: true, rows, size, written, seen, rolledBack });
				}

				case '/__sql': {
					const text = url.searchParams.get('q');
					if (!text) return Response.json({ ok: false, error: 'no q' }, { status: 400 });
					let params: unknown[] = [];
					try {
						const raw = url.searchParams.get('params');
						if (raw) params = JSON.parse(raw);
					} catch (e: any) {
						return Response.json(
							{ ok: false, error: `bad params: ${e?.message}` },
							{ status: 400 }
						);
					}
					const repeat = Number(url.searchParams.get('repeat') ?? 0);
					if (Number.isFinite(repeat) && repeat > 0) {
						const fill = params.length ? params[0] : 1;
						params = new Array(repeat).fill(fill);
					}
					try {
						const cursor = this.sql.exec(text, ...params);
						const rows = cursor.toArray();
						return Response.json({
							ok: true,
							params: params.length,
							rows: rows.slice(0, 50),
							rowCount: rows.length,
							rowsRead: cursor.rowsRead,
							rowsWritten: cursor.rowsWritten
						});
					} catch (e: any) {
						return Response.json({
							ok: false,
							params: params.length,
							error: String(e?.message ?? e)
						});
					}
				}

				// the driver's own assertions, against ctx.storage.sql rather than PDO
				case '/__driver':
					return Response.json(await this.runJson(DRIVER_LIVE_SUITE));

				// the whole point: Drupal rendering with the Durable Object as its
				// database
				case '/__drupal': {
					const before = this.queryCount;
					const t0 = Date.now();
					const php = await this.runJson(
						drupalRequest(
							url.searchParams.get('path') ?? '/',
							Number(url.searchParams.get('repeat') ?? 1),
							(url.searchParams.get('bins') ?? 'page,dynamic_page_cache')
								.split(',')
								.map((b) => b.trim())
								.filter(Boolean),
							url.searchParams.get('resetcid') !== '0'
						)
					);
					return Response.json({
						wallMs: Date.now() - t0,
						hostStatementsTotal: this.queryCount - before,
						bootMs: this.bootMs,
						php
					});
				}

				default:
					return super.handle(request, url);
			}
		}
	}
}
