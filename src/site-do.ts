import {
	mkdirp,
	mountDriver,
	mountDrupalLazy,
	mountDrupalStreaming
} from '@drupflare/cartridge/fs';
import { withMask } from '@drupflare/cartridge/mask';
import '@drupflare/cartridge/shim';
import { PHP_CODEC } from '@drupflare/durabledb/codec';
import {
	SiteDurableObject,
	bindable,
	toPositional,
	type ExecSqlResult,
	type ExecTxnResult,
	type SqlBindings,
	type TxnRequest
} from '@drupflare/durabledb/do-sqlite';
import { PhpBase, type PhpBaseModuleFactory, type PhpRuntimeArgs } from 'php-wasm/PhpBase';
import { backendNeedsPark, selectBackend, type BackendEnv } from './db/backend';
import { type MirrorBucket } from './db/file-store';
import { HeapChunkDigestError, type HandleIndex } from './db/heap-store';
import {
	SqlMigrator,
	assetChunkLoader,
	ensureMigrateTable,
	readMigrateCursor,
	type MigrateCursor
} from './db/migrate-sql';
import { repairWideIntegers, type Row as WideRow } from './db/wide-integers';
import {
	countingSql,
	countingStorage,
	readSourceTables,
	writeTargetTable,
	type WriteTally
} from './db/write-tally';
import {
	HeapRestoreIncomplete,
	heapRestoreChunkBudget,
	heapSnapshotEnabled,
	type AlarmClass,
	type HeapRestoreCursor
} from './do/alarm';
import { alarmBody } from './do/alarm-body';
import { installCapabilities } from './do/capabilities';
import { deriveStep, fillOne, strikeFillHead } from './do/fill';
import { recordInDeployment, reportToFleet } from './do/fleet';
import { gitPoll, gitSync, handleGit } from './do/git';
import { observe, supervise } from './do/health';
import {
	corruptStoredChunk,
	pinHandles,
	snapshotHeap,
	snapshotStep,
	tryRestoreHeap
} from './do/heap-image';
import { cacheTagsIn, forwardTo, pageTagList } from './do/helpers';
import { bumpGeneration, pathsForTags, purgeForTags } from './do/invalidate';
import {
	INTERPRETER_MEMORY,
	isolateAboveBytes,
	isolateResidency,
	keepSpareMemory,
	recycleAboveBytes,
	retainInterpreterEnabled,
	shimGlobals,
	spareMemoryBytes,
	takeSpareMemory
} from './do/isolate';
import {
	CF_OAUTH_ACCOUNT_KEY,
	CF_OAUTH_CLIENT_ID_KEY,
	CF_OAUTH_TOKEN_KEY,
	COMMIT_SEQ_KEY,
	HEAP_IMAGE_ATTEMPTS_KEY,
	LANES_EPOCH_KEY,
	LANES_PROVISIONED_KEY,
	LANE_REPAIR_KEY,
	OIDC_CLIENT_ID_KEY,
	OIDC_ISSUER_KEY,
	OPS_JOB_KEY,
	PENDING_TAGS_KEY,
	READMIT_ASKS_KEY,
	RECONCILE_KEY,
	RENDER_WINDOW_KEY,
	RESTORE_EXPECT_KEY,
	RESTORE_GENERATION_KEY,
	RESTORE_SEEN_KEY,
	SITE_NAME_KEY,
	UNSTORABLE_KEY
} from './do/keys';
import { autoScaleStep, provisionLane, requestReadmission, sessionReach } from './do/lanes';
import {
	PACK_INDEX_BYTES,
	lazyMountBytes,
	packCachedEnv,
	type SiteMountInfo
} from './do/lazy-mount';
import {
	argon2Enabled,
	backgroundPhpHold,
	fillSettleMs,
	memoryCacheBins,
	memoryCacheMaxItems,
	migrateEngine,
	phpStringList,
	r2WriteBudget,
	sleepBudgetMs,
	sqlChunkPrefix
} from './do/levers';
import {
	CACHETAG_WRITE,
	CATCH_UP_INTERVAL_MS,
	FILL_BINS,
	FILL_QUEUE_MAX,
	RENDER_BYTES_MIN_SAMPLES,
	RENDER_BYTES_PATHS,
	RENDER_BYTES_SAMPLES,
	SESSION_CATCHUP_MS
} from './do/limits';
import { mailEnv, sendMailTest } from './do/mail-setup';
import { flushMeters } from './do/meters';
import {
	drainHttpQueue,
	ensureHttpTables,
	httpCacheGet,
	parkState,
	performOutbound,
	queueHttp,
	runJsonMaybeParked
} from './do/outbound';
import {
	handleModify,
	installPackage,
	installTree,
	installableVerdict,
	mountInstalledModules,
	packageAutoloads
} from './do/packages';
import {
	ensureServeTables,
	migrateChunks,
	migrateStepIfPending,
	prefillServingTable
} from './do/provision';
import {
	applyReconcileStep,
	cronHooksForSite,
	enabledModulesFingerprint,
	reconcileStepOnce,
	sweepBeat,
	updbAction,
	updbActive
} from './do/reconcile';
import {
	applyRestoreChunk,
	bufferForReplication,
	catchUpOnce,
	collectForward,
	flushForward,
	replicationRecords,
	sealGeneration
} from './do/replication';
import { ROUTES } from './do/routes/index';
import {
	pageResponse,
	replicaHandoff,
	route as routeImpl,
	serveFromStorage,
	withKvGrant
} from './do/serve';
import { SERVICES_YAML, settingsOverride } from './do/settings';
import { assembleFor, harvestShellFor, seedShellFrom, shellCandidates } from './do/shell';
import { noteAlarmDemand, noteDemand, noteError, noteRangeError, serveStatsSync } from './do/stats';
import type {
	ErrorNote,
	FillOutcome,
	ForwardOutcome,
	LaneRowsCap,
	OpsJob,
	PageRow,
	Payload,
	PhpOutputEvent,
	Row,
	SharedRender,
	ShellAssembly,
	SiteBinary
} from './do/types';
import { ARGON2_FIX, installArgon2 } from './drupal/argon2-fix';
import { CURL_FIX } from './drupal/curl-fix';
import { ICONV_FIX } from './drupal/iconv-fix';
import { MB_FIX } from './drupal/mb-fix';
import { OPENSSL_FIX, installSign } from './drupal/openssl-fix';
import { opsRun, type RenderRequest } from './drupal/site-php';
import { SODIUM_FIX, installAead, installBlake2b } from './drupal/sodium-fix';
import { DISABLED, STANDIN_FIX } from './drupal/standin-fix';
import { XMLWRITER_FIX } from './drupal/xmlwriter-fix';
import { ZLIB_FIX, installZlib } from './drupal/zlib-fix';
import type { SiteEnv } from './env';
import {
	ADVISORY_STATE_KEY,
	advisoryFreshness,
	readAdvisories,
	type AdvisoryVerdict
} from './ops/advisories';
import { type AggregateIndex } from './ops/aggregates';
import { ATTEMPT_TTL_MS } from './ops/attempt';
import { DAILY_ROWS_QUOTA, hasSessionCookie, type AuthSpend } from './ops/auth-budget';
import type { CacheTier } from './ops/cache-tiers';
import { SHIPPED_CAPABILITIES } from './ops/catalog';
import { isTokenError, needsRefresh, refresh, type TokenSet } from './ops/cf-oauth';
import {
	ZERO_ENCOUNTERS,
	addEncounters,
	encounterReport,
	parseEncounters,
	recordEncounter,
	type EncounterCounts
} from './ops/cold-encounter';
import {
	CORE_VERSION_KEY,
	invalidateVersionPinnedCaches,
	type InvalidationResult
} from './ops/core-version';
import {
	HIBERNATION_IDLE_MS,
	idleRearmMs,
	keepWarmMs,
	warmForced,
	warmIntervalConfigured
} from './ops/cron';
import { emptyCrossings, wrapCrossings, type CrossingTally } from './ops/crossings';
import {
	DAY_METERS_PREFIX,
	dayMetersKey,
	meterFlushBudget,
	readDayMeters,
	type DayMeters
} from './ops/day-meters';
import { dailyLimit, degradation, degradeHeaders, type Degradation } from './ops/degrade';
import { deploymentEnv, deploymentEnvPhp } from './ops/deployment-env';
import { DRIVER_DIGEST } from './ops/driver-digest';
import { type RangeReport } from './ops/error-probe';
import { type FleetRow } from './ops/fleet';
import { readTagList, tagChecksum } from './ops/fragment-index';
import {
	authHeaders,
	cloneUrl,
	hasApi,
	pullsRequest,
	smartAuth,
	statusRequest,
	type BuildState,
	type Credential,
	type PullRequest,
	type Remote
} from './ops/git-provider';
import { discoverRefs, requestRefs, type Advertisement, type SmartRemote } from './ops/git-smart';
import { DEFAULT_POLL_MINUTES, backoffMs, clampInterval, type PollState } from './ops/git-sync';
import { parseJsonReply } from './ops/json-reply';
import { type MailEnv } from './ops/mail';
import {
	DEFAULT_SCOPES,
	callbackUri,
	discoveryUrl,
	endpointUsable,
	readProvider,
	type OidcConfig,
	type OidcProvider
} from './ops/oidc';
import { OPCACHE_PACK } from './ops/opcache-pack';
import { type OracleResult } from './ops/oracle';
import { outboundGuardEnabled, refuseOutbound } from './ops/outbound-guard';
import {
	autoloadPhp,
	classmapOf,
	type AutoloadDeclaration,
	type PackageAutoload,
	type Registry
} from './ops/package-install';
import { PACKED_CONTAINER_PATH, type PackedContainer } from './ops/packed-container';
import { parkEnabled, type ParkInstall } from './ops/park';
import type { SleepBudget } from './ops/park-drive';
import { ParkSockets } from './ops/park-drive';
import { KV_OVERRIDABLE, isPaid, resolveSettings, type PlanKv } from './ops/plan';
import { resolvePlanNumber } from './ops/plan-profile';
import { noteLimit, type LimitTally } from './ops/platform-limits';
import {
	DRIVER_DIGEST_KEY,
	PACK_VERSION,
	parseReconcileState,
	planReconcile,
	reconcileReport,
	reconciled,
	recordStep,
	recurringWork,
	type ReconcileHost,
	type ReconcileState
} from './ops/reconcile';
import { eagerDerivativesEnabled, type DeriveTransport } from './ops/render-lane';
import { isQuarantined, parseState } from './ops/repair';
import {
	ReplicaRequiresPrimary,
	enforceReadOnly,
	fenceAllows,
	replicaReadOnly,
	type ReadOnlyGuard
} from './ops/replica';
import { canTransition, missingMandatory, type ReplicaStage } from './ops/replica-admission';
import {
	planRestore,
	type ProvisionCursor,
	type ProvisionOutcome,
	type RestoreChunk
} from './ops/replica-restore';
import {
	LANES_EPOCH_HEADER,
	LANES_HEADER,
	formatLanesPointer,
	lanesKvKey,
	replicaLagMs,
	replicaOf
} from './ops/replica-routing';
import { type LogRecord, type LogStore } from './ops/replication-log';
import { FIRST_RUN_KEY } from './ops/setup-page';
import { SHIPPED_CORE_VERSION, SHIPPED_LOCK_VERSIONS } from './ops/shipped-lock';
import { ORIGIN_KEY, chooseOrigin, pinnable } from './ops/site-origin';
import { ensureHashSalt, hashSaltAssignment, type SecretStore } from './ops/site-secrets';
import { readStateRows } from './ops/state-fingerprint';
import { classifyState } from './ops/state-inventory';
import { RingBuffer, type Finding, type Observation } from './ops/supervisor';
import { type SweepReport } from './ops/sweep';
import { type TcpResult } from './ops/tcp';
import {
	RATE_WINDOW_MS,
	WARM_INTERVAL_VERIFIED_MS,
	clampWarmInterval,
	foldRenderWindow,
	readRenderWindow,
	warmDecision,
	writeRenderWindow,
	type Arrival,
	type RenderWindow,
	type WarmDecision
} from './ops/thermal';
import { updbOptions, updbStep, type UpdbDeps } from './ops/updb';
import {
	ID_PARTITION_LANES,
	LANE_HIGH_PREFIX,
	laneHighWater,
	writeForwardEnabled,
	type ForwardStatement
} from './ops/write-forwarding';
import {
	DEFAULT_OPCACHE_MODE,
	OPCACHE_PACK_ROOT,
	opcacheIni,
	opcacheMode,
	opcacheSourceKey,
	opcachePackState as packedOpcacheState,
	type OpcacheMode
} from './runtime/opcache';
// the `.js` is load-bearing: wrangler.jsonc aliases the specifier `./runtime/php-binary.js`, and
// without it esbuild resolves the default seam and bundles an 11 MB probe build over the ceiling
import { PHPFactory, wasmModule } from './runtime/php-binary.js';
import { errorMessage, isMissingTable } from './util/errors';
import { jsonError } from './util/reply';
import { firstRow } from './util/sql';
import type { Stamped } from './util/types';

export {
	FAILURE_BACKOFF_FLOOR_MS,
	HeapRestoreIncomplete,
	alarmRearmDelayMs,
	classifyAlarmOutcome,
	heapRestoreChunkBudget,
	heapSnapshotEnabled,
	migrateAlarmDelayMs,
	restoreAlarmDecision
} from './do/alarm';
export type { AlarmClass, HeapRestoreCursor } from './do/alarm';
export { cacheTagsIn, passThroughHeaders } from './do/helpers';
export {
	INTERPRETER_MEMORY,
	isolateId,
	isolateResidency,
	keepSpareMemory,
	noteResident,
	recycleAboveBytes,
	retainInterpreterEnabled,
	spareMemoryBytes,
	takeSpareMemory
} from './do/isolate';
export { INSTALLED_FS_BUDGET_BYTES, packCachedEnv } from './do/lazy-mount';
export {
	DEFAULT_MEMORY_CACHE_BINS,
	argon2Enabled,
	backgroundPhpHold,
	fillSettleMs,
	memoryCacheBins,
	memoryCacheMaxItems,
	r2WriteBudget,
	saveDebounceMs,
	shellAssemblyEnabled,
	sleepBudgetMs
} from './do/levers';
export { CFW_HEADER_VERSION } from './do/limits';
export type { ShellVerdict } from './do/types';

/** the interpreter, its Module and the shared output buffer, once boot has finished */
interface PhpInstance {
	php: PhpStatic;
	binary: SiteBinary;
	out: string[];
}

/**
 * The interpreter, built the way prof.js builds it (static-free-v1, so recorded per-query numbers
 * stay comparable).
 */
class PhpStatic extends PhpBase {
	/** the raw entry point php-wasm's published types omit; `run()` is a wrapper over it */
	declare _run: (code: string) => Promise<unknown>;

	constructor(
		args: PhpRuntimeArgs = {},
		diag: string[] = [],
		mode: OpcacheMode = DEFAULT_OPCACHE_MODE,
		memory?: WebAssembly.Memory
	) {
		const t0 = Date.now();
		const note = (m: string) => diag.push(`+${Date.now() - t0}ms ${m}`);
		// php-wasm types the loader's `default` as a constructor but real builds export a factory
		// (upstream mismatch)
		super(
			Promise.resolve({ default: PHPFactory }) as unknown as Promise<PhpBaseModuleFactory>,
			{
				...args,
				ini: [
					// the opcache seam; `OPCACHE_MODE` selects the arm
					...opcacheIni(mode),
					// not a guard: `USE_ZEND_ALLOC=0` turns the enforcing allocator off
					// (an 8M cap held 38 MB)
					'memory_limit=96M',
					// removed so `STANDIN_FIX` can declare degraded versions under the same names
					`disable_functions=${DISABLED.join(',')}`
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
					if (memory) (imports.env as Record<string, unknown>).memory = memory;
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

/**
 * A memory for a boot with nothing to reuse, or undefined when the loaded binary defines its own.
 */
function newInterpreterMemory(): WebAssembly.Memory | undefined {
	let imports: WebAssembly.ModuleImportDescriptor[] = [];
	try {
		imports = WebAssembly.Module.imports(wasmModule as WebAssembly.Module);
	} catch {
		// a stub binary in a spec has no import table; it defines nothing and imports nothing
	}
	return imports.some((i) => i.kind === 'memory')
		? new WebAssembly.Memory(INTERPRETER_MEMORY)
		: undefined;
}

/**
 * Interpreters kept across the eviction of the instance that booted them, by object id.
 *
 * Module scope lives with the isolate, so the next instance of the object can adopt the
 * interpreter.
 * Host closures resolve `this` through `owner` so an adoption repoints handles PHP already holds. A
 * `commitSeq` that differs on adoption means the object wrote elsewhere, so the interpreter is
 * dropped.
 */
type RetainedInterpreter = {
	php: PhpInstance;
	owner: { current: SitePhpDurableObject };
	commitSeq: number;
	at: number;
};

const retainedInterpreters = new Map<string, RetainedInterpreter>();

/**
 * One site: the interpreter and the database in the same isolate.
 *
 * `ctx.storage.sql` is synchronous only inside the Durable Object and PHP's PDO blocks, so PHP
 * must run here.
 */
export class SitePhpDurableObject extends SiteDurableObject {
	/** the worker's own vars (narrows the base class's env; emits nothing) */
	declare env: SiteEnv;
	/** backing field of {@link php} */
	private phpInstance?: PhpInstance;
	/** what every host closure of the current interpreter resolves `this` through */
	phpOwner?: { current: SitePhpDurableObject };
	/** the last adoption attempt, for `/serve-stats` */
	lastRetention?: { at: number; adopted: boolean; reason?: string; idleMs?: number };
	/** interpreters adopted from an evicted instance */
	retentionAdoptions = 0;
	/** how many boots instantiated into a dropped interpreter's memory */
	heapsReused?: number;
	/** the last such reuse */
	lastReuse?: { at: number; bytes: number };
	/** linear memory when the current interpreter finished booting; a reused memory starts large */
	private bootLinear = 0;
	/** the cold boot under way, which a concurrent {@link ensurePhp} caller shares */
	private bootInFlight?: Promise<PhpInstance>;
	/** the last boot that started while another interpreter was still resident in this isolate */
	bootBesideResident?: { at: number; id: string; interpreters: number; linearBytes: number };
	/**
	 * The interpreter. Clearing it also drops the isolate's retained copy, or a recycle or a drop
	 * would leave the memory it exists to free held in module scope.
	 */
	get php(): PhpInstance | undefined {
		return this.phpInstance;
	}
	set php(value: PhpInstance | undefined) {
		const was = this.phpInstance;
		this.phpInstance = value;
		if (value === undefined && was) {
			keepSpareMemory(was);
			const id = this.ctx.id.toString();
			if (retainedInterpreters.get(id)?.php === was) retainedInterpreters.delete(id);
		}
	}
	/** the shared output buffer of the interpreter */
	out: string[];
	/** timestamped boot notes from the loader */
	bootDiag: string[];
	/** how long the last boot took */
	bootMs?: number;
	/**
	 * `nowMs()` when the resident interpreter booted; what {@link fillSettleMs} is measured from.
	 */
	phpBootedAt?: number;
	/** the last firing whose background PHP waited for a young interpreter */
	lastFillHold?: { at: number; until: number; queued: number };
	/** firings whose background PHP waited for a young interpreter */
	fillHolds = 0;
	/** what the lazy mount reported for this site */
	mountInfo?: SiteMountInfo;
	/** wall time of the last fill that also booted; diagnostics only, never an estimate */
	lastBootInclusiveMs?: number;
	/** what the last heap restore attempt did, or undefined when it was never attempted */
	heapRestore?: Payload;
	/**
	 * Today's authenticated spend, or undefined when nothing has been charged in this lifetime.
	 *
	 * Re-read from `ctx.storage` on each charge; an eviction must not reset the day's budget.
	 */
	authSpend?: AuthSpend;
	/**
	 * Where a chunked restore has got to, or undefined when none is in flight.
	 *
	 * In memory only: the cursor indexes a live heap, and a persisted one could resume at chunk 7
	 * of a heap an eviction already zeroed. Repeating one object's memcpy after an eviction is
	 * idempotent.
	 */
	heapRestoreCursor?: HeapRestoreCursor;

	/**
	 * Strong references to every vrzno handle value this interpreter has handed PHP.
	 *
	 * In memory only; stops the handle table's WeakRefs dying under a heap that still holds their
	 * integers.
	 */
	pinnedHandles?: Set<object>;
	/** whether the pack database has been replayed into this object */
	migrated: boolean;

	// #region set on first use, so `undefined` tells "never happened" apart from a zero
	/** recent PHP log payloads, bounded */
	logs?: Payload[];
	/** recent mail attempts, bounded */
	mails?: Array<{
		to: unknown;
		subject: unknown;
		bytes: number;
		/** the transport the message was committed to, or null when it was refused */
		transport: string | null;
		/** why it was refused; absent on a message that reached the queue */
		refusal?: string;
	}>;
	/** whether `ensureHttpTables()` has run */
	httpTablesReady?: boolean;
	/** whether `ensureServeTables()` has run */
	serveTablesReady?: boolean;
	/** set while a write must not bump the generation */
	suppressBump?: boolean;
	/** inside an `execTxn` pass that will be rolled back; see the guard in `execSql()` */
	speculating?: boolean;
	/** statement counter for PW_SQL_TRACE, so the tail can be read as a sequence */
	sqlTraceSeq?: number;

	/** how many result sets this lifetime needed a wide-integer re-read; 0 on an ordinary site */
	wideRepairs?: number;

	/** files written from `cfw_module_file` at boot; 0 on a site that has installed nothing */
	installedModuleFiles?: number;
	/** whether this invocation already bumped the generation */
	bumpCoalesced?: boolean;
	/** every cache tag invalidated this invocation (the bump is coalesced; the tag set is not) */
	invalidatedTags: Set<string> = new Set();
	/** whether this invocation has already flagged the plans; cleared by `settlePlans()` */
	plansStaled?: boolean;
	/** the last scoped plan purge, so an invalidation that removed nothing is still visible */
	lastPlanPurge?: { purged: number; tags: number };

	/** what the last tag-scoped purge did, reported at `/serve-stats` so the 11x is observable */
	lastScopedPurge?: { scoped: boolean; tags: number; purged: number; requeued?: number };

	/** whether this incarnation has settled a purge a previous one recorded */
	pendingDrained?: boolean;

	/** outbound calls the render in flight has deferred; see the re-drive in {@link fillOne} */
	deferredInRender?: number;

	/**
	 * The last request-level re-drive; `at` and `seq` tell a repeat from the first one still
	 * sitting here.
	 */
	lastRedrive?: {
		path: string;
		deferred: number;
		drained: number;
		deferredAgain: number;
		at: number;
		seq: number;
	};

	/** the arrivals the thermal predictor reads; a ring, so it costs no rows */
	arrivals?: Arrival[];

	/** renders not yet folded into the persisted window; see `flushRenderWindow()` */
	rendersSinceFlush?: number;

	/** when that window last paid for a write */
	lastRenderWindowFlushMs?: number;

	/**
	 * Writes skipped because the row already held the value; in memory (a row to count rows saved
	 * defeats it).
	 */
	elidedWrites?: number;

	/**
	 * When an authenticated request last reached this object; in memory, since a row spends the
	 * meter it protects.
	 */
	lastAuthenticatedAt?: number;

	/** what the predictor last decided, reported at `/serve-stats` so a policy is legible */
	lastWarmDecision?: WarmDecision;

	/** what the last asset aggregation removed from a stored page, so 5,400 bytes/row has an n */
	lastAggregation?: {
		path: string;
		libraries: number;
		tagsRemoved: number;
		bytesSaved: number;
	};

	/** the aggregate manifest, read once per incarnation (undefined once read: there is none) */
	private aggregates?: AggregateIndex;
	/** whether {@link aggregateIndex} has read the manifest, so an absent one is asked for once */
	private aggregatesRead = false;

	/** what that settlement did, so a crash-then-recover is observable rather than assumed */
	lastPendingDrain?: { tags: number; purged: number };
	/** the last invocation's complete tag set, reported at `/serve-stats` */
	lastInvalidatedTags?: string[];
	/** generation bumps this incarnation */
	bumps?: number;
	/** wall ms of the last warm render (the inline budget guard's estimate) */
	lastRenderMs?: number;
	/** set when the frozen clock made the last render time unusable */
	renderClockUnmeasurable?: boolean;
	/** PHP-to-host crossings, per capability; see `src/ops/crossings.ts` */
	crossings?: CrossingTally;
	/** capability names actually present to wrap, so a 0 is not read as "never called" */
	crossingNames?: string[];
	/** whether this interpreter can park a Zend continuation, probed once per interpreter */
	parkInstall?: ParkInstall;
	/** the sockets a parked chain holds; per interpreter, because its PHP tokens are */
	parkSockets?: ParkSockets;
	/** how the last parked render went, so a park that stopped answering is readable */
	lastPark?: { state: string; trips: number; why?: string };
	/**
	 * Every park this interpreter has driven, and every trip inside them.
	 *
	 * Cumulative: one park is below the 1 ms meter, so a cost needs two reads either side of a
	 * window.
	 */
	parkTotals?: { runs: number; trips: number; refused: number };
	/**
	 * What a parked HTTP yield is performed with; global `fetch` unless a test stubs it (keeps the
	 * real classifier and guard).
	 */
	parkFetchDep?: typeof fetch;
	/** the tally at the start of the last render, so `/serve-stats` reports a per-render figure */
	lastRenderCrossings?: CrossingTally;
	/** when the daily meters last paid for a write; see `shouldFlushMeters()` */
	lastMeterFlushMs?: number;
	/** served requests not yet folded into their durable total; see `flushServeRequests()` */
	serveRequestsPending?: number;
	/** writes this lane executed speculatively and owes the primary; see `collectForward()` */
	forwardBuffer?: (ForwardStatement & { params: unknown[]; table: string })[];
	/** the generation this lane read at, pinned on the first collected write */
	forwardParent?: number;
	/** the last forward outcome, reported at `/serve-stats` so a refused write is visible */
	lastForward?: unknown;
	/**
	 * The read-only guard when `REPLICA_READ_ONLY` is set, undefined on a primary; see
	 * `src/ops/replica.ts`.
	 */
	replicaGuard?: ReadOnlyGuard;
	/**
	 * The most recent refusals (failovers are counted from it); bounded, since each holds a stack
	 * and the JS heap shares the 128 MiB isolate.
	 */
	replicaRefusals: ReplicaRequiresPrimary[] = [];
	/** the total, kept apart so bounding the array above does not deflate the reported count */
	replicaRefusalsTotal = 0;

	/**
	 * Whether an SMTP send holds an outbound socket; the only thing that makes this object
	 * non-hibernateable.
	 */
	mailSocketOpen?: boolean;
	/** fills served by the open fill window, sent back on its socket */
	windowFills?: number;
	/** the pack replay driver, created on first use */
	_migrator?: SqlMigrator;
	/** the last database-update beat, with when it ran */
	lastUpdb?: Stamped<Payload>;
	/** when the alarm last fired */
	lastAlarmAt?: number;
	/** how the last alarm ended */
	lastAlarmOutcome?: unknown;
	/** the last catch-up round, reported at `/serve-stats` so a stuck lane is visible */
	lastCatchUp?: unknown;
	/** why this lane last left the pool; survives the readmission that clears `lastCatchUp` */
	lastWithdrawal?: unknown;
	/** lever names `adoptSettings()` took from KV, so `cfwSettings` can report a source */
	kvLeverNames?: Set<string>;
	/** when this lane last chased a session it did not hold; the cookie is attacker-supplied */
	lastSessionCatchUpAt?: number;
	/**
	 * Minimum ms between session chases on a lane; a forged cookie must not buy a primary hop per
	 * request.
	 */
	static readonly SESSION_CATCHUP_MS = SESSION_CATCHUP_MS;
	/** how many times chasing a session found it */
	sessionCatchUps?: { tried: number; found: number };
	/** alarm firings this incarnation */
	alarmFirings?: number;
	/** alarm re-arms this incarnation */
	alarmRearms?: number;
	/** consecutive pack replay failures */
	migrateFailures?: number;
	/** pages the alarm chain filled this incarnation */
	pagesFilledByAlarms?: number;
	/** the gated lane's queue/service split; a ring, read by `/serve-stats` */
	laneTimings?: { ahead: number; queueMs: number; serviceMs: number }[];
	/**
	 * Which platform limits this incarnation's failed requests hit; per incarnation, since a reset
	 * object has already answered.
	 */
	limitTally: LimitTally;
	/**
	 * Authoritative statements collected during this invocation, awaiting a fingerprint.
	 *
	 * Per invocation: one that dies before sealing must leave no record (a replica restores
	 * instead; a partial record would leave it silently wrong).
	 */
	pendingReplication?: {
		parent: number;
		statements: { sql: string; params?: readonly unknown[] }[];
		overflowed: boolean;
	};
	/** commit advances not yet persisted; see `flushCommitSeq()` */
	pendingCommits = 0;
	/** renders in flight, so N concurrent identical requests cost one; see `herdKeyFor()` */
	renderFlights = new Map<string, Promise<SharedRender | undefined>>();
	/** interpreter drops taken to stay under the isolate limit; `/serve-stats` reports both */
	recycles?: number;
	/** the last interpreter drop and why */
	lastRecycle?: {
		at: number;
		bytes: number;
		reason: 'request' | 'alarm' | 'upload';
		rebuild?: boolean;
	};
	/**
	 * Set when this interpreter's first kernel boot has no container row and so rebuilds it.
	 *
	 * The rebuild's garbage is invisible to the memory estimate, so the next invocation can be
	 * reset; the interpreter is dropped at the end of that invocation regardless of thresholds.
	 */
	private rebuildBoot = false;
	/** set by a request carrying a file, cleared when the interpreter drops after it */
	uploadSeen = false;
	/** drops taken because the VM trapped, which is a fault rather than a size; see {@link run} */
	trappedRuns?: number;
	/** the last VM trap */
	lastTrap?: { at: number; message: string };
	/** consecutive failing batches, for the capped backoff; reset by any batch that progressed */
	consecutiveFillFailures?: number;
	/** the class of the last alarm outcome */
	lastAlarmClass?: AlarmClass;
	/** per-table rows-written tally; only allocated when /__writes turns it on */
	writeTally?: WriteTally;
	/** the last garbage-collection pass; {@link lastGcAt} is apart because it paces the next */
	lastGc?: Payload;
	/** when the last collection pass succeeded; an error leaves it so a failing pass retries */
	lastGcAt?: number;
	/** what the last addressable-sweep step did, so coverage has a number rather than a guess */
	lastSweep?: SweepReport | { error: string };
	/** when a sweep last queued something; separate from the report, which every step replaces */
	lastSweepAt?: number;
	/** what the last heap-image attempt did; see {@link SitePhpDurableObject.snapshotStep} */
	lastHeapImage?: Payload;
	/** the last deferred-HTTP drain, with when it ran */
	lastHttpDrain?: Stamped<Payload>;
	/** the last git poll, with when it ran */
	lastGitPoll?: Stamped<Record<string, unknown>[]>;
	/** the last mail drain, with when it ran */
	lastMailDrain?: Stamped<Payload>;
	/** the last file-mirror drain, with when it ran */
	lastMirrorDrain?: Stamped<Payload>;
	/** the last page-mirror drain, with when it ran */
	lastPageMirrorDrain?: Stamped<Payload>;
	/** what the last eager derivative run did; see `deriveStep()` */
	lastDerive?: Payload;
	/** the last fleet reporting failure */
	lastFleetError?: string;
	/** the last cron firing, with when it ran */
	lastCron?: Stamped<Payload>;
	/** the last outbound URL the SSRF guard refused; see `src/ops/outbound-guard.ts` */
	lastOutboundRefusal?: { reason: string; url: string };
	/** the hook list the last firing scheduled from; discovered, or the shipped fallback */
	lastCronHooks?: string[];
	/** requests in flight right now */
	inflight?: number;
	/** the peak of {@link inflight} since the alarm last read it */
	inflightPeak?: number;
	/** what the last autoscale evaluation decided; null when it did nothing */
	lastAutoScale?: Payload;
	/** per-path serve counts, in memory only; the R2 page mirror publishes the busiest first */
	pageHits = new Map<string, number>();
	/**
	 * Paths a shell seed already failed on, so each is attempted once (in memory; a hibernation
	 * costs one more attempt).
	 */
	shellSeedFailed = new Set<string>();
	/** the last reconciliation outcome, including a step that is waiting and owns no firing */
	lastReconcile?: Payload;
	/** writes accumulated since the last alarm folded them into the daily total */
	rowsSinceFlush?: number;
	/**
	 * Durable Object invocations since the last flush; in memory, since a row each would inflate
	 * the rows meter.
	 */
	doRequestsSinceFlush?: number;
	/** `PAGE_KV` page writes granted since the last meter flush */
	kvGrantsSinceFlush?: number;

	/** today's renders, alarm firings and drained fetches since the last meter flush */
	activitySinceFlush?: { renders: number; alarms: number; fetches: number };

	/** adds `n` to today's pending counter for `kind` */
	countActivity(kind: 'renders' | 'alarms' | 'fetches', n = 1): void {
		const held = this.activitySinceFlush ?? { renders: 0, alarms: 0, fetches: 0 };
		held[kind] += n;
		this.activitySinceFlush = held;
	}

	/** today's activity counters, stored plus pending, so a read between flushes is current */
	activityToday(nowMs = this.nowMs()): { renders: number; alarms: number; fetches: number } {
		const stored = this.storedMeters(nowMs);
		const pending = this.activitySinceFlush ?? { renders: 0, alarms: 0, fetches: 0 };
		return {
			renders: stored.renders + pending.renders,
			alarms: stored.alarms + pending.alarms,
			fetches: stored.fetches + pending.fetches
		};
	}
	/**
	 * When the alarm this object last set is due, in memory only.
	 *
	 * `armFillAlarm()` compares against it so a burst costs one charged row; a hibernation costs
	 * one extra arm.
	 */
	alarmDueMs?: number;

	/** `carriedServeTotal()`'s memo; the lifetime serve total moves only through `flushMeters()` */
	carriedServe?: number;
	/** requests served through the PHP lane this incarnation */
	phpLaneEntries?: number;
	/** requests served from storage this incarnation */
	storageLaneServes?: number;
	/**
	 * How often a request met an evicted interpreter; in memory, folded into a per-day total on
	 * the alarm.
	 */
	encounters: EncounterCounts = { ...ZERO_ENCOUNTERS };
	/**
	 * Trend ring for memory; held here because the supervisor owns no state (a poisoned
	 * observation must not outlive a recycle).
	 */
	memoryRing = new RingBuffer();
	/** trend ring for rows written */
	rowsRing = new RingBuffer();
	/** trend ring for Durable Object requests */
	doRing = new RingBuffer();
	/** per-path render sizes, previous renders only (the `renderSizeAnomaly` baseline) */
	pageBytes = new Map<string, number[]>();
	/** what the last supervised alarm found, for `/__health` */
	lastFindings?: Finding[];
	/** speculative replays whose read touches no table the buffer writes; see execTxn() */
	txnSkippable?: number;
	/** statements those replays ran, which is the size of the lever rather than its value */
	txnSkippableStatements?: number;
	/** why a replay was NOT skippable, so no opportunity reads differently from a blind parser */
	txnSkipUnparseable?: number;
	/** replays not skippable because a statement's table could not be attributed */
	txnSkipUnattributed?: number;
	/** replays not skippable because a read overlaps the buffer's tables */
	txnSkipOverlap?: number;
	/** the split a read filter lives or dies on: a replay with no read has nothing to filter */
	txnSpeculativeWithRead?: number;
	/** speculative replays with no read */
	txnSpeculativeNoRead?: number;
	/** the counted handle; `storage-metered.spec.ts` fails on a direct `ctx.storage` write */
	storage: DurableObjectStorage;
	// #endregion

	constructor(ctx: DurableObjectState, env: SiteEnv) {
		super(ctx, env);
		this.out = [];
		this.bootDiag = [];
		this.migrated = false;
		// counts the host's writes as well as Drupal's, always (the daily rows meter is a product
		// reading); the per-table tally stays route-gated
		const charge = (rows: number) => {
			this.rowsSinceFlush = (this.rowsSinceFlush ?? 0) + rows;
		};
		this.sql = countingSql(this.sql, () => this.writeTally, charge);
		// the KV half of the same meter: `setAlarm` alone is 360 rows/day on an idle site
		this.storage = countingStorage(this.ctx.storage, () => this.writeTally, charge);
		this.limitTally = {};
	}

	/**
	 * Builds the interpreter, installs the bridge, mounts the tree. Once.
	 *
	 * Lazy rather than in the constructor so boot cost is attributable to a route. A static build
	 * instantiates inside a request handler because it needs no runtime codegen.
	 */
	async ensurePhp(opts: { skipRestore?: boolean } = {}): Promise<PhpInstance> {
		if (this.php) {
			// a half-restored heap has the right length and wrong bytes, so refuse it here
			if (this.heapRestoreCursor) throw new HeapRestoreIncomplete(this.heapRestoreCursor);
			// the warm half of the cold-encounter rate (a cold boot is 1,264 ms of cpuTime)
			this.encounters = recordEncounter(this.encounters, 'warm');
			return this.php;
		}
		// a second cold caller waits for the first (reconciliation runs outside the gate; two
		// interpreters in one isolate got it reset)
		if (this.bootInFlight) return this.bootInFlight;
		this.bootInFlight = this.bootPhp(opts).finally(() => {
			this.bootInFlight = undefined;
		});
		return this.bootInFlight;
	}

	/** the cold half of {@link ensurePhp}; only it and its own reboot call this */
	private async bootPhp(opts: { skipRestore?: boolean }): Promise<PhpInstance> {
		this.encounters = recordEncounter(this.encounters, 'cold');
		// the heap a drop left behind, if any, so this boot never holds a second one beside it
		const spare = takeSpareMemory();
		if (spare) {
			this.heapsReused = (this.heapsReused ?? 0) + 1;
			this.lastReuse = { at: this.nowMs(), bytes: spare.buffer.byteLength };
		}
		const memory = spare ?? newInterpreterMemory();
		// an uncollected interpreter still counts toward the isolate's 128 MiB while this one grows
		const resident = isolateResidency();
		this.traceMemory('boot');
		if (resident.interpreters > 0) {
			this.bootBesideResident = { at: this.nowMs(), ...resident };
			console.warn(JSON.stringify({ cfw: 'boot-beside-resident', ...resident }));
		}

		const t0 = Date.now();
		// every closure installed below goes through `self`, so an adopting instance can take them
		// over
		const owner = { current: this as SitePhpDurableObject };
		this.phpOwner = owner;
		const self = forwardTo(owner);
		const php = new PhpStatic({}, this.bootDiag, opcacheMode(this.env?.OPCACHE_MODE), memory);
		// braced on purpose: a brace-less arrow returns `push`'s length and workerd warns on every
		// event
		php.addEventListener('output', (e) => {
			self.out.push(...([] as string[]).concat((e as PhpOutputEvent).detail ?? []));
		});
		php.addEventListener('error', (e) => {
			self.out.push(...([] as string[]).concat((e as PhpOutputEvent).detail ?? []));
		});
		// the one cast: php-wasm resolves this as a loosely-typed Module, and SiteBinary names
		// both the FS surface the mounts drive and the cfw* members installed just below
		const binary = (await php.binary) as unknown as SiteBinary;
		// what a drop hands to the next boot; see `keepSpareMemory()`
		if (memory) (binary as unknown as { wasmMemory: WebAssembly.Memory }).wasmMemory = memory;

		// the bridge the driver reaches through vrzno_env(); inherited from
		// SiteDurableObject so exec/txn semantics are the verified ones
		this.installBridge.call(self, binary as unknown as Record<string, unknown>);
		// whether this binary can suspend, read by drupflare's service provider; `FetchHandler`
		// needs Asyncify or JSPI (shipping has neither), so `ParkFetchHandler` answers HTTP instead
		binary.cfwCanSuspend =
			typeof shimGlobals.Asyncify === 'object' && shimGlobals.Asyncify.__cfwStub !== true;

		binary.cfwStats = () =>
			JSON.stringify({
				queryCount: self.queryCount,
				databaseSize: Number(self.sql.databaseSize),
				// what a progressive batch reads between operations, since memory_get_usage() is 0
				oversized: self.oversized()
			});
		// what the Worker knows (pool, meters, fill queue), handed to Drupal so it can be displayed
		binary.cfwServeStats = () => JSON.stringify(self.serveStatsSync());
		this.installCapabilities.call(self, binary);
		// ext-zlib over fflate, masked (a sync deflate is a long JS frame); installed even where
		// zlib exists (the PHP half then defines nothing)
		installZlib(binary as unknown as Record<string, unknown>, withMask);
		// RSA/ECDSA over node:crypto, which is synchronous in workerd, so an ordinary masked bridge
		installSign(binary as unknown as Record<string, unknown>, withMask);
		installArgon2(binary as unknown as Record<string, unknown>, withMask);
		// BLAKE2b over blakejs; no build has ext-sodium, so this is the only content-address source
		installBlake2b(binary as unknown as Record<string, unknown>, withMask);
		installAead(binary as unknown as Record<string, unknown>, withMask);
		// not probed here: the park probe runs PHP, which cannot execute yet at this point of the
		// boot (see {@link parkState})
		this.parkInstall = undefined;
		// close old sockets here, not in `dropInterpreter()` (most drops assign `php = undefined`
		// directly); their tokens died with the old `$GLOBALS`
		void this.parkSockets?.closeAll();
		this.parkSockets = undefined;
		// read by `ParkFetchHandler::available()`; gated on the traps' switch, else a
		// `cfwpark+fetch://` target reaches the real `stream_socket_client` (reasoned, unmeasured)
		(binary as unknown as Record<string, unknown>)['cfwParkFetch'] =
			SHIPPED_CAPABILITIES.blockingOutbound && parkEnabled(this.env);
		// same flag for SQL plus a reachable backend: a yield the host will not answer is a hang
		// (no local database to fall back to)
		(binary as unknown as Record<string, unknown>)['cfwParkImage'] =
			SHIPPED_CAPABILITIES.blockingOutbound && parkEnabled(this.env);
		(binary as unknown as Record<string, unknown>)['cfwSqlPark'] =
			SHIPPED_CAPABILITIES.blockingOutbound &&
			parkEnabled(this.env) &&
			backendNeedsPark(selectBackend(this.env as unknown as BackendEnv));
		// last, after every installer (an earlier wrapper is overwritten and the tally reads 0)
		this.crossings = emptyCrossings();
		this.crossings.bytes = { in: 0, out: 0, maxIn: 0, maxOut: 0, maxName: '' };
		this.crossingNames = wrapCrossings(
			binary as unknown as Record<string, unknown>,
			this.crossings
		);
		// outside the tally (a refused call is not a crossing), and last so an installer cannot
		// overwrite the guard
		this.replicaGuard = this.isReplica()
			? enforceReadOnly(
					binary as unknown as Record<string, unknown>,
					(refusal) => {
						self.replicaRefusals.push(refusal);
						self.replicaRefusalsTotal += 1;
						if (self.replicaRefusals.length > 20) self.replicaRefusals.shift();
					},
					// a pool lane forwards its writes; a var-configured replica has no primary and
					// keeps refusing
					this.isPoolLane() && writeForwardEnabled(this.env)
						? (statements, payload) => self.collectForward(statements, payload)
						: undefined
				)
			: undefined;
		// before any PHP runs: a handle minted before the pin cannot be pinned retroactively
		this.pinHandles(binary);

		// SITE_DB_PREFIX swaps only the database (the default pack has no node bundles)
		// LAZY_MOUNT swaps the mount strategy: streaming inflates 39 MB up front (3,066 ms of a
		// 3,754 ms cold start), lazy inflates on first open
		const lazyOptions = {
			dbPrefix: this.env?.SITE_DB_PREFIX || undefined,
			// same condition as the streaming path below
			database: migrateEngine(undefined, this.env) === 'php'
		};
		const opcachePackState = packedOpcacheState(
			OPCACHE_PACK,
			opcacheMode(this.env?.OPCACHE_MODE),
			this.env?.LAZY_MOUNT === '1',
			opcacheSourceKey(DRIVER_DIGEST, SHIPPED_LOCK_VERSIONS)
		);
		const packedOpcache = opcachePackState === 'usable';
		const mountEnv = packCachedEnv(this.env);
		this.mountInfo =
			this.env?.LAZY_MOUNT === '1'
				? packedOpcache
					? await mountDrupalLazy(binary, mountEnv, {
							...lazyOptions,
							layers: [{ prefix: 'drupal-pf' }, { prefix: 'drupal-opc' }]
						}).catch(() => mountDrupalLazy(binary, mountEnv, lazyOptions))
					: await mountDrupalLazy(binary, mountEnv, lazyOptions)
				: await mountDrupalStreaming(binary, this.env, {
						dbPrefix: this.env?.SITE_DB_PREFIX || undefined,
						// only the PHP migration engine opens the packed .sqlite (the JS engine
						// would spend 6.47 MB and a subrequest)
						database: migrateEngine(undefined, this.env) === 'php'
					});
		this.mountInfo.driver = await mountDriver(binary, this.env);
		// opcache looks in /tmp/<system id>; the layer sits beside the tree, so a link joins them
		const opcLayer =
			'layers' in this.mountInfo &&
			this.mountInfo.layers.some((l) => l.name === 'drupal-opc');
		if (packedOpcache && opcLayer && OPCACHE_PACK) {
			try {
				(binary.FS as unknown as { symlink(target: string, path: string): void }).symlink(
					`${OPCACHE_PACK_ROOT}/${OPCACHE_PACK.systemId}`,
					`/tmp/${OPCACHE_PACK.systemId}`
				);
				this.mountInfo.opcachePack = OPCACHE_PACK.systemId;
			} catch {
				// an unlinked cache is a miss on every script, which is the `off` arm's cost
			}
		} else if (opcachePackState === 'stale') {
			this.mountInfo.opcachePack = 'stale';
		}
		// at mount time, not settings.php: a restored heap never boots a kernel, so the override's
		// `@mkdir()` would not run
		try {
			mkdirp(binary.FS, '/drupal/sites/default/files/config/sync');
		} catch {
			// a read-only or already-present node is not a boot failure
		}
		// after the packed driver, so an installed module overrides a packed file (the only place
		// `cfw_module_file` reaches PHP)
		this.installedModuleFiles = mountInstalledModules(this, binary);

		// point the site at this driver, and at a salt only this site has
		const settingsPath = '/drupal/sites/default/settings.php';
		const existing = new TextDecoder().decode(binary.FS.readFile(settingsPath));
		if (!existing.includes('cfw_do_sqlite')) {
			// the pack ships no hash_salt, so this append is the only assignment (a failed override
			// throws rather than sharing one salt)
			const salt = hashSaltAssignment(ensureHashSalt(this.secretStore()));
			// the pinned origin is interpolated here: settings.php runs once per boot and the pin
			// belongs to the site
			const partition = this.idPartition();
			const override = settingsOverride({
				origin: JSON.stringify(this.canonicalOrigin()),
				argon2: argon2Enabled(this.env),
				memoryBins: phpStringList(memoryCacheBins(this.env)),
				memoryItems: memoryCacheMaxItems(this.env),
				lane: partition.lane,
				lanes: partition.lanes,
				packageAutoload: autoloadPhp(this.packageAutoloads()),
				deploymentEnv: deploymentEnvPhp(deploymentEnv(this.env))
			});
			binary.FS.writeFile(settingsPath, existing + override + salt);
		}
		// the path settings.php already registered but that never existed; see SERVICES_YAML
		binary.FS.writeFile('/drupal/sites/default/services.yml', SERVICES_YAML);

		this.php = { php, binary, out: this.out };
		this.phpBootedAt = this.nowMs();
		this.bootMs = Date.now() - t0;
		this.bootLinear = this.heapNow();
		this.rebuildBoot = this.containerMissing();

		// restore a stored heap matching this pack after the mount, bridge and capabilities
		// (the heap holds vrzno handles by index into what they populate)
		if (heapSnapshotEnabled(this.env) && !opts.skipRestore) {
			try {
				this.heapRestore = await this.tryRestoreHeap(binary, {
					maxChunks: heapRestoreChunkBudget(this.env)
				});
			} catch (e) {
				// a refusal is a boot, not an outage: fall through to the normal path
				this.heapRestoreCursor = undefined;
				// unless bytes already landed: a refusal on chunk 0 leaves the pack's heap,
				// one on chunk N has applied N chunks (right length, wrong bytes)
				const dirty = e instanceof HeapChunkDigestError && e.bytesWritten > 0;
				this.heapRestore = {
					restored: false,
					reason: errorMessage(e),
					...(dirty ? { discardedHeap: true, dirtyBytes: e.bytesWritten } : {})
				};
				if (dirty) {
					// drop the poisoned instance and boot from the pack (`skipRestore` stops a
					// retry refusing the same chunk)
					this.php = undefined;
					// directly: through `ensurePhp()` this would wait on the boot it is part of
					const fresh = await this.bootPhp({ skipRestore: true });
					this.heapRestore.rebooted = true;
					return fresh;
				}
			}
			// the restore did not finish: the binary and mount survive to the next firing, and
			// the cursor keeps the object unservable meanwhile
			if (this.heapRestoreCursor) {
				await this.setAlarmAt(this.nowMs() + 1);
				throw new HeapRestoreIncomplete(this.heapRestoreCursor);
			}
		}

		// pw_encode()/pw_decode() must precede the driver's client; the mb_* wrappers must
		// precede Symfony's polyfill bootstrap (its function_exists() guards would win)
		await this.run(`<?php ${PHP_CODEC}`);
		await this.run(`<?php ${MB_FIX}`);
		// same window as MB_FIX: polyfill-iconv's bootstrap must find the name taken (its
		// iconv_strrpos() is wrong at index 0)
		await this.run(`<?php ${ICONV_FIX}`);
		// gz* must exist before AssetDumper runs in a render; inert where the extension exists
		await this.run(`<?php ${ZLIB_FIX}`);
		// curl_* must exist before an SDK constructs its own transport (the shim class resolves
		// on first call; no autoloader yet)
		await this.run(`<?php ${CURL_FIX}`);
		// openssl_sign/openssl_verify for firebase/php-jwt and the Google auth client; inert
		// with the real extension
		await this.run(`<?php ${OPENSSL_FIX}`);
		await this.run(`<?php ${ARGON2_FIX}`);
		// sodium_crypto_generichash*, needed before a content-addressed store's first write
		await this.run(`<?php ${SODIUM_FIX}`);
		// XMLWriter must exist before a module class extends it (compile time, hence a class and
		// not a shim set)
		await this.run(`<?php ${XMLWRITER_FIX}`);
		// ZipArchive, finfo, Transliterator and exif, plus the degraded sleep, exec and gd names
		await this.run(`<?php ${STANDIN_FIX}`);
		return this.php;
	}

	installCapabilities(binary: SiteBinary): SiteBinary {
		return installCapabilities(this, binary);
	}

	ensureHttpTables(): void {
		return ensureHttpTables(this);
	}

	/** reads a cached outbound response, optionally stale; undefined on a miss */
	httpCacheGet(
		url: string,
		method?: string,
		body?: string,
		headers?: Record<string, string>,
		opts?: { allowStale?: boolean }
	): { status: number; headers: Payload; body: string; stale: boolean } | undefined {
		return httpCacheGet(this, url, method, body, headers, opts);
	}

	async autoScaleStep(): Promise<Payload | undefined> {
		return autoScaleStep(this);
	}

	/**
	 * Whether this lane is empty and waiting for the primary's copy (`CREATED` with a readmission
	 * ask outstanding).
	 */
	awaitingCopy(): boolean {
		return this.replicaStage() === 'CREATED' && (this.metaGet(READMIT_ASKS_KEY) ?? '') !== '';
	}

	/**
	 * How long a lane waiting on a copy sleeps before asking again: doubling from the catch-up
	 * interval to 60 s.
	 */
	copyBackoffMs(): number {
		const asks = Number(this.metaGet(READMIT_ASKS_KEY) ?? '0') || 0;
		return Math.min(CATCH_UP_INTERVAL_MS * 2 ** Math.max(0, asks - 1), 60_000);
	}

	/**
	 * What the last advisory sweep found: one indexed row read, no kernel boot (the module's cron
	 * hook fills it).
	 */
	advisoryVerdict(): AdvisoryVerdict & { fresh: boolean; ageS: number } {
		// a site that never migrated has no `key_value`; that reads as unknown, like an absent row
		let row: { value: unknown } | undefined;
		try {
			row = firstRow(
				this.sql.exec(
					`SELECT value FROM key_value WHERE collection = 'state' AND name = ?`,
					ADVISORY_STATE_KEY
				)
			) as { value: unknown } | undefined;
		} catch {
			row = undefined;
		}
		const verdict = readAdvisories(row?.value);
		return { ...verdict, ...advisoryFreshness(verdict, Math.floor(this.nowMs() / 1000)) };
	}

	/** lane numbers waiting to be copied again, lowest first; read on the primary */
	laneRepairQueue(): number[] {
		const raw = this.metaGet(LANE_REPAIR_KEY) ?? '';
		const seen = new Set<number>();
		for (const part of raw.split(',')) {
			const lane = Number(part.trim());
			if (Number.isInteger(lane) && lane >= 1) seen.add(lane);
		}
		return [...seen].sort((a, b) => a - b);
	}

	/** records a lane as needing a fresh copy; idempotent, since a lane re-asks every firing */
	enqueueLaneRepair(lane: number): number[] {
		if (!Number.isInteger(lane) || lane < 1) return this.laneRepairQueue();
		const queue = [...new Set([...this.laneRepairQueue(), lane])].sort((a, b) => a - b);
		this.metaSet(LANE_REPAIR_KEY, queue.join(','));
		return queue;
	}

	/** removes a lane from the repair queue and returns what remains */
	dequeueLaneRepair(lane: number): number[] {
		const queue = this.laneRepairQueue().filter((n) => n !== lane);
		this.metaSet(LANE_REPAIR_KEY, queue.join(','));
		return queue;
	}

	async requestReadmission(): Promise<{ asked: boolean; reason: string; stage: ReplicaStage }> {
		return requestReadmission(this);
	}

	/**
	 * Whether this is a pool lane nothing has routed to lately; a primary is never idle (it takes
	 * every write and miss).
	 */
	laneIsIdle(): boolean {
		if (!this.isPoolLane()) return false;
		return (this.doRequestsSinceFlush ?? 0) === 0 && (this.inflightPeak ?? 0) < 1;
	}

	/** the SSRF guard, or undefined when it is off or the URL is allowed */
	refuseOutbound(url: string): { reason: string; url: string } | undefined {
		if (!outboundGuardEnabled(this.env)) return undefined;
		return refuseOutbound(url);
	}

	queueHttp(url: string, method?: string, body?: string, headers?: Record<string, string>): void {
		return queueHttp(this, url, method, body, headers);
	}

	async parkState(): Promise<ParkInstall> {
		return parkState(this);
	}

	/** the socket table this interpreter's parked chains use, created on first park */
	parkSocketTable(): ParkSockets {
		this.parkSockets ??= new ParkSockets();
		return this.parkSockets;
	}

	async runJsonMaybeParked(code: string): Promise<Payload> {
		return runJsonMaybeParked(this, code);
	}

	serveStatsSync(): Payload {
		return serveStatsSync(this);
	}

	async performOutbound(
		url: string,
		method: string,
		body: string,
		headers: Record<string, string>
	): Promise<TcpResult> {
		return performOutbound(this, url, method, body, headers);
	}

	/**
	 * The aggregate manifest from the `ASSETS` binding, or undefined; memoised per incarnation,
	 * absence included.
	 */
	async aggregateIndex(): Promise<AggregateIndex | undefined> {
		if (this.aggregatesRead) return this.aggregates;
		this.aggregatesRead = true;
		try {
			const assets = (this.env as { ASSETS?: { fetch: (r: Request) => Promise<Response> } })
				?.ASSETS;
			if (!assets) return undefined;
			const res = await assets.fetch(new Request('https://assets.local/agg/manifest.json'));
			if (!res.ok) return undefined;
			const parsed = (await res.json()) as AggregateIndex;
			if (parsed?.libraries && parsed?.files) this.aggregates = parsed;
		} catch {
			// an absent or unreadable manifest is "no aggregation", never a failed render
		}
		return this.aggregates;
	}

	async drainHttpQueue(limit?: number) {
		return drainHttpQueue(this, limit);
	}

	/**
	 * The pack generation this object migrated from, or undefined; a heap restored across packs
	 * holds paths into moved files.
	 */
	packGeneration(): string | undefined {
		try {
			return readMigrateCursor(this.sql)?.generation;
		} catch (e) {
			if (!isMissingTable(e)) this.noteError('packGeneration', e);
			return undefined;
		}
	}

	/**
	 * The identity a heap image is valid for: the pack plus the site's module set.
	 *
	 * An install changes the container and class loader without touching the pack, so a pack-only
	 * key restores a stale kernel (`access() on null`). Undefined when there is no pack
	 * generation.
	 */
	heapGeneration(): string | undefined {
		const pack = this.packGeneration();
		if (pack === undefined) return undefined;
		return `${pack}|${this.enabledModulesFingerprint()}`;
	}

	/** how many times this object has tried to image `generation`; a new one starts at zero */
	imageAttempts(generation: string): number {
		const raw = this.metaGet(HEAP_IMAGE_ATTEMPTS_KEY) ?? '';
		const at = raw.lastIndexOf(' ');
		if (at < 0 || raw.slice(0, at) !== generation) return 0;
		const n = Number(raw.slice(at + 1));
		return Number.isFinite(n) ? n : 3;
	}

	/**
	 * The emscripten heap as bytes (`HEAPU8`, else `wasmMemory`; php-wasm types neither);
	 * undefined if neither exists.
	 */
	heapBytes(binary: SiteBinary): Uint8Array | undefined {
		const b = binary as unknown as {
			HEAPU8?: unknown;
			wasmMemory?: { buffer?: ArrayBufferLike };
		};
		if (b.HEAPU8 instanceof Uint8Array) return b.HEAPU8;
		const buf = b.wasmMemory?.buffer;
		if (buf) return new Uint8Array(buf);
		return undefined;
	}

	pinHandles(binary: SiteBinary): number {
		return pinHandles(this, binary);
	}

	/**
	 * The vrzno handle table (`Module.targets`), shape-checked; undefined when absent, which a
	 * restore refuses on.
	 */
	handleIndex(binary: SiteBinary): HandleIndex | undefined {
		const t = (binary as unknown as { targets?: unknown }).targets as HandleIndex | undefined;
		if (!t || typeof t !== 'object') return undefined;
		const ok =
			typeof t.id === 'number' &&
			typeof t.byObject?.set === 'function' &&
			typeof t.byInteger?.set === 'function' &&
			typeof (t.byInteger as unknown as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
				'function';
		return ok ? t : undefined;
	}

	async snapshotHeap(opts?: { chunkBytes?: number }): Promise<Payload> {
		return snapshotHeap(this, opts);
	}

	async snapshotStep(): Promise<Payload | undefined> {
		return snapshotStep(this);
	}

	/** what a reconciliation step may ask this object beyond plain SQL */
	reconcileHost(): ReconcileHost {
		return {
			claimedAtMs: () => {
				const raw = this.metaGet(FIRST_RUN_KEY);
				const at = raw === null ? NaN : Number(raw);
				return Number.isFinite(at) && at > 0 ? at : undefined;
			},
			meta: (key: string) => this.metaGet(key),
			setMeta: (key: string, value: string) => this.metaSet(key, value),
			origin: () => this.canonicalOrigin(),
			packedContainer: () => this.packedContainer,
			modules: () => this.enabledModulesFingerprint()
		};
	}

	/** the pack's container row, loaded once an instance has reconciliation to do */
	packedContainer?: PackedContainer;

	/** loads the pack's container row from `ASSETS` once */
	async loadPackedContainer(): Promise<void> {
		if (this.packedContainer) return;
		try {
			const res = await this.env.ASSETS.fetch(
				new URL(`https://a.local/${PACKED_CONTAINER_PATH}`)
			);
			if (res.ok) this.packedContainer = await res.json<PackedContainer>();
		} catch {
			// absent means the step rebuilds, as it always did
		}
	}

	/** the stored reconciliation state */
	reconcileState(): ReconcileState {
		return parseReconcileState(this.metaGet(RECONCILE_KEY));
	}

	/** the reconciliation report for this site */
	reconcileStatus(): ReturnType<typeof reconcileReport> {
		return reconcileReport(this.reconcileState(), this.sql, this.reconcileHost());
	}

	/**
	 * Why `reconcileStepOnce()` answered undefined, so a POST that did nothing is not mistaken for
	 * a silent failure.
	 */
	reconcileSkipReason(): string {
		if (String(this.env?.RECONCILE ?? '1') === '0') return 'RECONCILE is off';
		if (this.isPoolLane()) return 'a replica lane serves a copy and does not reconcile';
		const state = this.reconcileState();
		if (
			reconciled(state, this.metaGet(DRIVER_DIGEST_KEY)) &&
			!recurringWork(state, this.sql, this.reconcileHost())
		) {
			return 'already at the shipping version';
		}
		// a deferred step answers undefined too; without this a site parked at version 0 of 2
		// reads as shipping
		const planned = planReconcile(state, this.sql, this.reconcileHost());
		return planned.action === 'wait'
			? `waiting on ${planned.step.id}: ${planned.reason}`
			: `version ${state.version} of ${PACK_VERSION}, with no step left to try`;
	}

	async reconcileStepOnce(): Promise<Payload | undefined> {
		return reconcileStepOnce(this);
	}

	async applyReconcileStep(
		before: ReconcileState,
		step: Parameters<typeof recordStep>[1],
		owed: string,
		host: ReconcileHost,
		satisfied: string[]
	): Promise<Payload> {
		return applyReconcileStep(this, before, step, owed, host, satisfied);
	}

	enabledModulesFingerprint(): string {
		return enabledModulesFingerprint(this);
	}

	async cronHooksForSite(): Promise<{ hooks: string[]; discovered: boolean }> {
		return cronHooksForSite(this);
	}

	async tryRestoreHeap(binary: SiteBinary, opts?: { maxChunks?: number }): Promise<Payload> {
		return tryRestoreHeap(this, binary, opts);
	}

	corruptStoredChunk(seq: number): Payload {
		return corruptStoredChunk(this, seq);
	}

	// #region git remotes

	/** every configured remote; the list is one meta row so an add is one write */
	gitRemotes(): Remote[] {
		try {
			const raw = JSON.parse(this.metaGet('git_remotes') || '[]') as unknown;
			return Array.isArray(raw) ? (raw as Remote[]) : [];
		} catch {
			return [];
		}
	}

	/** stores the remote list as one meta row */
	gitSaveRemotes(remotes: readonly Remote[]): void {
		this.metaSet('git_remotes', JSON.stringify(remotes));
	}

	/** the stored token, email and username for a remote (empty strings when unset) */
	gitCredential(id: string): Credential {
		return {
			token: this.metaGet(`git_token_${id}`) ?? '',
			email: this.metaGet(`git_email_${id}`) ?? '',
			username: this.metaGet(`git_username_${id}`) ?? ''
		};
	}

	/** the git transport's view of a remote, which authenticates as Basic, unlike the API */
	gitSmart(remote: Remote): SmartRemote {
		const auth = smartAuth(remote, this.gitCredential(remote.id));
		return { url: cloneUrl(remote), username: auth.username, token: auth.token };
	}

	/** one authenticated API GET, returning parsed JSON or a refusal */
	async gitGet(
		remote: Remote,
		url: string
	): Promise<{ ok: boolean; body: unknown; status: number }> {
		const res = await fetch(url, {
			headers: authHeaders(remote, this.gitCredential(remote.id))
		});
		let body: unknown;
		try {
			body = await res.json();
		} catch {
			body = undefined;
		}
		if (res.status === 429)
			this.gitBackoff(remote.id, res.headers.get('retry-after') ?? undefined);
		return { ok: res.ok, body, status: res.status };
	}

	/** records a refusal so nothing polls this remote again until the window passes */
	private gitBackoff(id: string, retryAfter?: string): number {
		const attempts = Number(this.metaGet(`git_attempts_${id}`, '0') ?? 0) + 1;
		const seconds = retryAfter === undefined ? undefined : Number(retryAfter);
		const wait = backoffMs(attempts, Number.isFinite(seconds) ? seconds : undefined);
		this.metaSet(`git_attempts_${id}`, String(attempts));
		this.metaSet(`git_backoff_${id}`, String(this.nowMs() + wait));
		return wait;
	}

	/** clears a remote's backoff after a good poll */
	private gitClearBackoff(id: string): void {
		this.metaSet(`git_attempts_${id}`, '0');
		this.metaSet(`git_backoff_${id}`, '0');
	}

	/** every file this remote has installed, so a plan can tell a change from an addition */
	gitStoredFiles(id: string): Map<string, string> {
		this.ensureServeTables();
		const rows = this.sql
			.exec<{
				path: string;
				source: string;
			}>('SELECT path, source FROM cfw_module_file WHERE package = ?', id)
			.toArray();
		return new Map(rows.map((r) => [String(r.path), String(r.source)]));
	}

	/** who owns each installed path, which is what turns an overwrite into a refusal */
	gitOwners(): Map<string, string> {
		this.ensureServeTables();
		const rows = this.sql
			.exec<{
				path: string;
				package: string;
			}>('SELECT path, package FROM cfw_module_file')
			.toArray();
		return new Map(rows.map((r) => [String(r.path), String(r.package)]));
	}

	/** the ref advertisement, which is the poll and works against any remote that speaks git */
	async gitRefs(remote: Remote): Promise<Advertisement> {
		try {
			const ad = await discoverRefs(this.gitSmart(remote));
			this.gitClearBackoff(remote.id);
			return ad;
		} catch (e) {
			const message = errorMessage(e);
			if (/ answered 4(29|03)/.test(message)) this.gitBackoff(remote.id);
			throw e;
		}
	}

	/**
	 * Writes one commit status, never a check run (a pasted token is refused by the check-run
	 * endpoints on all three providers).
	 */
	async gitWriteStatus(
		remote: Remote,
		sha: string,
		state: BuildState,
		description: string,
		targetUrl: string
	): Promise<boolean> {
		const post = statusRequest(remote, sha, state, description, targetUrl);
		if (!post) return false;
		const res = await fetch(post.url, {
			method: 'POST',
			headers: {
				...authHeaders(remote, this.gitCredential(remote.id)),
				'content-type': 'application/json'
			},
			body: JSON.stringify(post.body)
		});
		return res.ok;
	}

	async gitSync(
		remote: Remote,
		sha: string,
		opts?: { apply: boolean; previewOf?: string }
	): Promise<Record<string, unknown>> {
		return gitSync(this, remote, sha, opts);
	}

	async handleModify(url: URL, request: Request): Promise<Response> {
		return handleModify(this, url, request);
	}

	/** stores the autoload map a build-delivered vendor package asks composer to register */
	registerPackageAutoload(
		pkg: AutoloadDeclaration,
		files: readonly { path: string; source: string }[]
	): void {
		this.sql.exec(
			`INSERT INTO cfw_package_autoload (package, version, mount, autoload, classmap)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(package) DO UPDATE SET version = excluded.version, mount = excluded.mount,
         autoload = excluded.autoload, classmap = excluded.classmap`,
			pkg.name,
			pkg.version,
			pkg.mount,
			JSON.stringify(pkg.autoload),
			JSON.stringify(classmapOf(pkg.mount, pkg.autoload, files))
		);
		this.rowsSinceFlush = (this.rowsSinceFlush ?? 0) + 1;
	}

	/** a body that is not JSON is a caller error, and a throw here would read as a server fault */
	async readModifyBody(request: Request): Promise<unknown> {
		if (request.method !== 'POST') return undefined;
		try {
			return (await request.json()) as unknown;
		} catch {
			return undefined;
		}
	}

	/** the 400 for a modify action called without a JSON POST */
	modifyBadBody(): Response {
		return jsonError('this action needs a POST carrying a JSON body', 400);
	}

	/**
	 * Drops the compiled container and plugin discovery so the next boot rebuilds both.
	 *
	 * Called when a delivery changes an extension's wiring; a container cached before a module's
	 * code arrives resolves routes to classes that cannot load.
	 */
	dropCompiledContainer(): void {
		for (const table of ['cache_container', 'cache_discovery']) {
			try {
				this.sql.exec(`DELETE FROM ${table}`);
			} catch {
				// a table the site has not created has nothing cached to drop
			}
		}
	}

	/** the poll cadence for every remote, which is what the alarm reads */
	gitPollStates(remotes: readonly Remote[]): PollState[] {
		return remotes.map((r) => ({
			id: r.id,
			intervalMinutes: clampInterval(
				Number(this.metaGet(`git_interval_${r.id}`, String(DEFAULT_POLL_MINUTES)) ?? 0)
			),
			lastCheckedMs: Number(this.metaGet(`git_checked_${r.id}`, '0') ?? 0),
			backoffUntilMs: Number(this.metaGet(`git_backoff_${r.id}`, '0') ?? 0)
		}));
	}

	async gitPoll(limit?: number): Promise<Record<string, unknown>[]> {
		return gitPoll(this, limit);
	}

	/** every open request, from the provider API where there is one, else from the refs */
	async gitPulls(remote: Remote): Promise<PullRequest[]> {
		if (!hasApi(remote.provider)) {
			const ad = await this.gitRefs(remote);
			return requestRefs(ad).map((r) => ({
				id: r.id,
				title: `request ${r.id}`,
				branch: r.ref,
				target: remote.branch,
				sha: r.sha,
				author: '',
				url: '',
				draft: false
			}));
		}
		const request = pullsRequest(remote);
		const got = await this.gitGet(remote, request.url);
		if (!got.ok) throw new Error(`the provider answered ${got.status}`);
		return request.pick(got.body);
	}

	async handleGit(url: URL, deliverBase?: string): Promise<Response> {
		return handleGit(this, url, deliverBase);
	}

	ensureServeTables(): void {
		return ensureServeTables(this);
	}

	/**
	 * Folds the writes since the last flush into a per-UTC-day total; flushed on the alarm, never
	 * per write (that would double the count; the flush row is itself counted).
	 *
	 * @returns the running total for today
	 */
	flushDailyRows(nowMs = this.nowMs()): number {
		return this.flushMeters(nowMs).rows;
	}

	/**
	 * What the packed day row holds, else the four legacy keys (read-only, so an upgrade mid-day
	 * keeps the row budget the degrade guard reads).
	 */
	storedMeters(nowMs = this.nowMs()): DayMeters {
		const packed = readDayMeters(this.metaGet(dayMetersKey(nowMs)));
		if (packed) return packed;
		const day = new Date(nowMs).toISOString().slice(0, 10);
		return {
			rows: Number(this.metaGet(`rows_written_${day}`, '0') ?? 0),
			doRequests: Number(this.metaGet(`do_requests_${day}`, '0') ?? 0),
			serveTotal: this.carriedServeTotal(),
			encounters: parseEncounters(this.metaGet(`encounters_${day}`)),
			kvWrites: 0,
			renders: 0,
			alarms: 0,
			fetches: 0
		};
	}

	/**
	 * The lifetime serve total from whichever day last recorded one; memoised, since it only moves
	 * through `flushMeters()`.
	 */
	carriedServeTotal(): number {
		if (this.carriedServe !== undefined) return this.carriedServe;
		let latest = 0;
		try {
			const row = firstRow(
				this.sql.exec(
					`SELECT v FROM cfw_meta WHERE k GLOB '${DAY_METERS_PREFIX}*' ORDER BY k DESC LIMIT 1`
				)
			) as { v?: string } | undefined;
			latest = readDayMeters(row?.v)?.serveTotal ?? 0;
		} catch (e) {
			// a missing cfw_meta is the zero total; the next flush writes one
			if (!isMissingTable(e)) this.noteError('carriedServeTotal', e);
		}
		this.carriedServe = Math.max(latest, Number(this.metaGet('serve_requests', '0') ?? 0));
		return this.carriedServe;
	}

	flushMeters(nowMs?: number): DayMeters {
		return flushMeters(this, nowMs);
	}

	/** the render window as it survived the last hibernation, or undefined if none is stored */
	storedRenderWindow(): RenderWindow | undefined {
		return readRenderWindow(this.metaGet(RENDER_WINDOW_KEY));
	}

	/**
	 * Folds pending renders into the persisted window, at most once per 15-minute window (96
	 * rows/day against 1,440 at the 60 s meter interval; the rate only separates ~505 renders/day
	 * from ~8,640).
	 *
	 * The roll is also where the warm interval is solved: `lastRenderWindowFlushMs` is in memory,
	 * so it is set only if this incarnation did the previous roll.
	 */
	flushRenderWindow(nowMs = this.nowMs()): RenderWindow | undefined {
		const pending = this.rendersSinceFlush ?? 0;
		const stored = this.storedRenderWindow();
		if (pending === 0) return stored;
		// held until the bucket rolls, so a busy site pays once per window, not once per flush
		if (stored && nowMs - stored.startedAt < RATE_WINDOW_MS) {
			const held = this.lastRenderWindowFlushMs ?? 0;
			if (nowMs - held < RATE_WINDOW_MS) return stored;
		}
		const survived = this.incarnationSpanned(stored, nowMs);
		this.rendersSinceFlush = 0;
		this.lastRenderWindowFlushMs = nowMs;
		const folded = foldRenderWindow(stored, pending, nowMs, RATE_WINDOW_MS, survived);
		this.metaSet(RENDER_WINDOW_KEY, writeRenderWindow(folded));
		return folded;
	}

	/**
	 * Whether one incarnation covered the window that is closing.
	 *
	 * `lastRenderWindowFlushMs` must be set (this incarnation opened a window) and no later than
	 * the window's start (it is that window, not one inherited after a re-creation).
	 */
	private incarnationSpanned(stored: RenderWindow | undefined, nowMs: number): boolean {
		if (!stored) return false;
		const opened = this.lastRenderWindowFlushMs;
		if (opened === undefined) return false;
		return opened <= stored.startedAt && nowMs - stored.startedAt >= RATE_WINDOW_MS;
	}

	/**
	 * Whether this firing should pay for a daily-meter flush.
	 *
	 * Two triggers: pending volume flushes at once, an idle warming tick waits for the interval.
	 * Both come from `meterFlushBudget()` (the remaining budget), reaching 25 rows and 60 s at the
	 * ceiling. The accumulator is in memory, so an eviction loses at most one interval of counting.
	 */
	shouldFlushMeters(nowMs = this.nowMs()): boolean {
		const pending = (this.rowsSinceFlush ?? 0) + (this.doRequestsSinceFlush ?? 0);
		if (pending === 0) return false;
		const budget = meterFlushBudget(this.dailyRows(nowMs), DAILY_ROWS_QUOTA);
		if (pending >= budget.rows) return true;
		return nowMs - (this.lastMeterFlushMs ?? 0) >= budget.intervalMs;
	}

	/**
	 * Folds served requests into their durable total, on the meters' own interval.
	 *
	 * A row per view would cost ~15,000 of free's 100,000 rows/day. A serve arms the fill alarm at
	 * +1 ms and that firing flushes, so an eviction loses about a millisecond of counting.
	 */
	flushServeRequests(): number {
		const pending = this.serveRequestsPending ?? 0;
		if (pending === 0) return 0;
		this.flushMeters();
		return pending;
	}

	/** the durable total plus what has not been paid for yet; for a read that must not write */
	serveRequests(): number {
		return this.storedMeters().serveTotal + (this.serveRequestsPending ?? 0);
	}

	/** today's rows written, without flushing (for a read that must not write) */
	dailyRows(nowMs = this.nowMs()): number {
		return this.storedMeters(nowMs).rows + (this.rowsSinceFlush ?? 0);
	}

	/**
	 * Folds this firing's Durable Object invocations into a per-UTC-day total.
	 *
	 * Counts only what reached this object (an edge-cache hit never enters the isolate), so it is
	 * the DO meter and not the Worker-request meter.
	 */
	flushDailyDoRequests(nowMs = this.nowMs()): number {
		return this.flushMeters(nowMs).doRequests;
	}

	/**
	 * Folds this incarnation's cold-encounter counts into a per-UTC-day total; called from the
	 * alarm, where a row is already written.
	 */
	flushEncounters(nowMs = this.nowMs()): EncounterCounts {
		return this.flushMeters(nowMs).encounters;
	}

	/**
	 * The share of requests that met an evicted interpreter, today and in this incarnation (score
	 * a boot proposal against it).
	 */
	coldEncounterRate(nowMs = this.nowMs()): {
		today: ReturnType<typeof encounterReport>;
		incarnation: ReturnType<typeof encounterReport>;
	} {
		return {
			today: encounterReport(
				addEncounters(this.storedMeters(nowMs).encounters, this.encounters)
			),
			incarnation: encounterReport(this.encounters)
		};
	}

	/** in memory only: an object evicted mid-upgrade must re-check; the comparison is idempotent */
	private coreVersionChecked = false;

	/**
	 * Drops the caches that embed the Drupal core version, once per lifetime, when that version
	 * has moved.
	 */
	invalidateOnCoreUpgrade(): InvalidationResult | undefined {
		if (this.coreVersionChecked) return undefined;
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
			return undefined;
		}
	}

	async installableVerdict(
		name: string,
		constraint?: string,
		stability?: string
	): Promise<OracleResult> {
		return installableVerdict(this, name, constraint, stability);
	}

	packageAutoloads(): PackageAutoload[] {
		return packageAutoloads(this);
	}

	async installTree(
		registry: Registry,
		name: string,
		constraint?: string,
		budget?: { left: number },
		stability?: string
	): Promise<Record<string, unknown>[]> {
		return installTree(this, registry, name, constraint, budget, stability);
	}

	async installPackage(
		registry: Registry,
		name: string,
		constraint?: string,
		stability?: string
	): Promise<Record<string, unknown>> {
		return installPackage(this, registry, name, constraint, stability);
	}

	shellCandidates() {
		return shellCandidates(this);
	}

	async harvestShellFor(
		path: string,
		cookies: readonly string[],
		origin: string
	): Promise<{ stored: boolean; reason: string; holes?: number; permissionsHash?: string }> {
		return harvestShellFor(this, path, cookies, origin);
	}

	async seedShellFrom(
		path: string,
		cookie: string,
		origin: string
	): Promise<ShellAssembly | undefined> {
		return seedShellFrom(this, path, cookie, origin);
	}

	async assembleFor(
		path: string,
		cookie: string,
		origin: string
	): Promise<ShellAssembly | undefined> {
		return assembleFor(this, path, cookie, origin);
	}

	/** how many shells are stored for a path; 0 makes a seed the right move, not a retry */
	shellRows(path: string): number {
		return Number(
			firstRow(
				this.sql.exec<{ n: number }>(
					'SELECT COUNT(*) AS n FROM cfw_shell WHERE path = ?',
					path
				)
			)?.n ?? 0
		);
	}

	/** whether this visitor has been proven against the harvest the stored shell came from */
	shellVerified(path: string, hash: string, uid: string, harvestedAt: number): boolean {
		return (
			(firstRow(
				this.sql.exec<{ n: number }>(
					`SELECT COUNT(*) AS n FROM cfw_shell_verified
           WHERE path = ? AND permissions_hash = ? AND uid = ? AND harvested_at = ?`,
					path,
					hash,
					uid,
					harvestedAt
				)
			)?.n ?? 0) > 0
		);
	}

	sweepBeat(options?: { force?: boolean | undefined }): boolean {
		return sweepBeat(this, options);
	}

	/**
	 * Where this site sits on the quota ladder; both daily meters reset at midnight UTC, so
	 * nothing is persisted (two warm reads, no await).
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
		return this.storedMeters(nowMs).doRequests + (this.doRequestsSinceFlush ?? 0);
	}

	/**
	 * This site's own verdict on itself for the fleet inventory (findings stay on `/health`).
	 *
	 * Quarantine outranks degradation: a quarantined site refuses requests, a degraded one serves
	 * them cheaper.
	 */
	fleetHealth(): FleetRow['health'] {
		try {
			if (isQuarantined(parseState(this.metaGet('repair_state')))) return 'quarantined';
			// read `level`, the one answer `degradation()` decides, not two derived booleans
			return this.degradation().level === 'normal' ? 'ok' : 'degraded';
		} catch {
			// an inventory value must never be the thing that fails the alarm that writes it
			return 'ok';
		}
	}

	async reportToFleet(): Promise<void> {
		return reportToFleet(this);
	}

	observe(outcomes: (Payload | undefined)[]): Observation {
		return observe(this, outcomes);
	}

	/**
	 * What the host knows about itself, in the shape `BootSelfTest` reads.
	 *
	 * Every key is a host fact (bridge, absent capabilities, migration progress, update run, pack
	 * identity), so the PHP health unit needs no kernel. `missing_capabilities` comes from the
	 * installed list, not a hand-kept name list.
	 */
	healthObservation(): Record<string, unknown> {
		const installed = new Set(Object.keys(this.installCapabilities({} as SiteBinary)));
		// only capabilities this method installs (probing an empty object cannot see `cfwStats`
		// or the SQL bridge)
		const wanted = ['cfwLog', 'cfwHealth', 'cfwFetch', 'cfwMail'];
		const cursor = readMigrateCursor(this.sql);
		return {
			bridge_installed: installed.size > 0 ? 1 : 0,
			missing_capabilities: wanted.filter((name) => !installed.has(name)),
			migrate_chunk: cursor?.chunk ?? null,
			migrate_chunks: cursor?.chunks ?? null,
			updb_phase: updbActive(this) ? 'running' : null,
			pack_generation: this.packGeneration(),
			db_generation: this.metaGet('pack_generation')
		};
	}

	/**
	 * The rolling median body size for one path, over previous renders only.
	 *
	 * Reading `cfw_page` would compare a render against the row it just wrote (ratio 1.00, so
	 * `renderSizeAnomaly` could never fire). In memory and capped, like `pageHits`.
	 */
	medianRenderBytes(path: string): number | undefined {
		const seen = this.pageBytes.get(path);
		if (!seen || seen.length < RENDER_BYTES_MIN_SAMPLES) return undefined;
		const sorted = [...seen].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 === 0
			? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
			: sorted[mid];
	}

	/** records one render's size after its median was taken, so a render never sets its baseline */
	noteRenderBytes(path: string, bytes: number): void {
		if (!path || !Number.isFinite(bytes) || bytes <= 0) return;
		const seen = this.pageBytes.get(path) ?? [];
		seen.push(bytes);
		if (seen.length > RENDER_BYTES_SAMPLES) seen.splice(0, seen.length - RENDER_BYTES_SAMPLES);
		this.pageBytes.set(path, seen);
		// bounded; the busiest paths matter most, so the oldest entry goes
		if (this.pageBytes.size > RENDER_BYTES_PATHS) {
			const oldest = this.pageBytes.keys().next();
			if (!oldest.done) this.pageBytes.delete(oldest.value);
		}
	}

	supervise(outcomes: (Payload | undefined)[]): Finding[] {
		return supervise(this, outcomes);
	}

	/** the meta table as a {@link SecretStore}, so the mint needs no Durable Object to test */
	secretStore(): SecretStore {
		return {
			get: (key: string) => this.metaGet(key),
			set: (key: string, value: string) => this.metaSet(key, value)
		};
	}

	async sendMailTest(to: string): Promise<Payload> {
		return sendMailTest(this, to);
	}

	mailEnv(): MailEnv {
		return mailEnv(this);
	}

	/**
	 * The OIDC provider an operator configured, or why it is not usable.
	 *
	 * The secret is an env binding; neither it nor the issuer may join `KV_OVERRIDABLE` (a KV
	 * writer could point every login at a provider they control).
	 */
	oidcConfig(origin: string): { config: OidcConfig } | { refusal: string } {
		const issuer = this.metaGet(OIDC_ISSUER_KEY) ?? '';
		const clientId = this.metaGet(OIDC_CLIENT_ID_KEY) ?? '';
		if (issuer === '' || clientId === '') {
			return { refusal: 'no OIDC provider is configured for this site' };
		}
		if (!endpointUsable(issuer)) return { refusal: 'the OIDC issuer must be https' };
		const secret = String(this.env?.OIDC_CLIENT_SECRET ?? '');
		return {
			config: {
				issuer,
				clientId,
				...(secret ? { clientSecret: secret } : {}),
				scopes: DEFAULT_SCOPES,
				redirectUri: callbackUri(this.canonicalOrigin(origin))
			}
		};
	}

	/** the discovery document, fetched per callback, not cached; a login is not a hot path */
	async oidcProvider(issuer: string): Promise<{ provider: OidcProvider } | { refusal: string }> {
		let doc: unknown;
		try {
			const res = await fetch(discoveryUrl(issuer));
			if (!res.ok) return { refusal: `discovery answered ${res.status}` };
			doc = await res.json();
		} catch (e) {
			return { refusal: `discovery failed: ${errorMessage(e).slice(0, 120)}` };
		}
		const provider = readProvider(doc, issuer);
		return 'refusal' in provider ? provider : { provider };
	}

	/** reads a `cfw_meta` value, or `fallback` when the key is absent */
	metaGet(key: string, fallback: string | null = null): string | null {
		this.ensureServeTables();
		const row = firstRow(
			this.sql.exec<Row<{ v: string }>>('SELECT v FROM cfw_meta WHERE k = ?', key)
		);
		return row === undefined ? fallback : String(row.v);
	}

	/**
	 * Writes a `cfw_meta` value, skipping one that is already there.
	 *
	 * One read to save one write: free allows 5,000,000 rows read against 100,000 written, and a
	 * write of the existing value is charged in full. `elidedWrites` counts the skips.
	 */
	metaSet(key: string, value: unknown): void {
		this.ensureServeTables();
		const next = String(value);
		if (this.metaGet(key) === next) {
			this.elidedWrites = (this.elidedWrites ?? 0) + 1;
			return;
		}
		this.sql.exec(
			'INSERT INTO cfw_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
			key,
			next
		);
	}

	/**
	 * The Cloudflare API credentials, from the durable grant or from the deployed pair.
	 *
	 * Every consumer goes through here: the env overlay dies with the incarnation (about ten
	 * seconds idle), so the persisted grant is the source. A refreshed set is persisted so the
	 * next incarnation starts from it; a refresh failure is not an error (the access token may
	 * still be valid).
	 */
	async cfCredentials(): Promise<{ token: string; accountId: string }> {
		const stored = this.storedGrant();
		if (stored.set) {
			const clientId = this.metaGet(CF_OAUTH_CLIENT_ID_KEY) ?? '';
			if (clientId && stored.set.refreshToken && needsRefresh(stored.set, this.nowMs())) {
				const next = await refresh({ clientId, refreshToken: stored.set.refreshToken });
				if (!isTokenError(next)) {
					this.metaSet(CF_OAUTH_TOKEN_KEY, JSON.stringify(next));
					return {
						token: next.accessToken,
						accountId: this.cfCredentialsSync().accountId
					};
				}
			}
		}
		return this.cfCredentialsSync();
	}

	/** the stored grant, parsed; `set` is undefined when there is none or it is unreadable */
	private storedGrant(): { set?: TokenSet } {
		const raw = this.metaGet(CF_OAUTH_TOKEN_KEY);
		if (!raw) return {};
		try {
			const set = JSON.parse(raw) as TokenSet;
			return { set: set?.accessToken ? set : undefined };
		} catch {
			return {};
		}
	}

	/**
	 * The same credentials without the refresh, for a caller that cannot await.
	 *
	 * One rule for which credential a site uses (durable grant first), shared with `mailEnv()`; the
	 * drain refreshes before it resolves. An expired token answers 401, which is the better signal.
	 */
	cfCredentialsSync(): { token: string; accountId: string } {
		const env = this.env as unknown as Record<string, string | undefined>;
		const accountId = env.CF_EMAIL_ACCOUNT_ID ?? this.metaGet(CF_OAUTH_ACCOUNT_KEY) ?? '';
		const set = this.storedGrant().set;
		return { token: set?.accessToken ?? env.CF_EMAIL_TOKEN ?? '', accountId };
	}

	/**
	 * Moves this object's replica stage through {@link canTransition}, or refuses the move.
	 *
	 * @returns the stage now in force; unchanged when the transition was refused
	 */
	setReplicaStage(next: ReplicaStage): { stage: ReplicaStage; moved: boolean; reason: string } {
		const from = (this.metaGet('replica_stage') ?? 'CREATED') as ReplicaStage;
		if (from === next) return { stage: from, moved: false, reason: 'already there' };
		if (!canTransition(from, next)) {
			return { stage: from, moved: false, reason: `${from} -> ${next} is not a legal move` };
		}
		this.metaSet('replica_stage', next);
		return { stage: next, moved: true, reason: '' };
	}

	/** the stored replica stage (`CREATED` when none) */
	replicaStage(): ReplicaStage {
		return (this.metaGet('replica_stage') ?? 'CREATED') as ReplicaStage;
	}

	/** the waiting allowance of the invocation in progress; see `sleepBudgetMs()` */
	sleepBudget?: SleepBudget;

	/**
	 * One log line of memory readings when `MEMORY_TRACE=1` (the platform only reports that the
	 * isolate was reset).
	 */
	traceMemory(at: string): void {
		if (this.env?.MEMORY_TRACE !== '1') return;
		const resident = isolateResidency();
		console.log(
			JSON.stringify({
				cfw: 'memory',
				at,
				linear: this.heapNow(),
				isolate: this.isolateNow(),
				residents: resident.interpreters,
				residentLinear: resident.linearBytes,
				retained: retainedInterpreters.size,
				spare: spareMemoryBytes(),
				booted: this.php?.binary ? 1 : 0
			})
		);
	}

	/** whether this incarnation has already made sure the deployment document lists it */
	deploymentChecked = false;

	/**
	 * Whether this object is a replica, a property of its name (`example.com#r1`).
	 *
	 * `REPLICA_READ_ONLY` is deployment-wide and would make a pool's primary read-only, so the
	 * role is per-object; no client request can change which id the router used. Either source
	 * suffices (OR, so a misconfiguration lands on read-only).
	 */
	isReplica(): boolean {
		if (replicaReadOnly(this.env)) return true;
		return this.isPoolLane();
	}

	/**
	 * Whether this object is a pool lane, narrower than a replica.
	 *
	 * A lane has a lifecycle (restore, then `SERVING`) and hands traffic back until then; a
	 * var-configured replica sits at `CREATED` forever, so the readiness check would refuse
	 * everything.
	 */
	isPoolLane(): boolean {
		const name = this.ctx.id.name;
		return name !== undefined && replicaOf(name) !== undefined;
	}

	/**
	 * Whether this object may answer a request that requires generation `g`.
	 *
	 * A primary is never fenced. A replica checks the caller's header: absent means any view will
	 * do, an unparseable one refuses (unreadable is not absent), a number goes to
	 * {@link fenceAllows}.
	 */
	fenceRefusal(request: Request): { refuse: boolean; required: number; applied: number } {
		const applied = this.commitSeq();
		if (!this.isReplica()) return { refuse: false, required: applied, applied };
		const raw = request.headers.get('x-cfw-require-generation');
		if (raw === null) return { refuse: false, required: applied, applied };
		// `Number('')` is 0, not NaN, so an empty header would pass every object; it is an
		// unreadable requirement and refuses
		if (raw.trim() === '') return { refuse: true, required: Number.NaN, applied };
		const required = Number(raw);
		return { refuse: !fenceAllows(applied, required), required, applied };
	}

	/**
	 * The replication log's view of this object.
	 *
	 * Uses `cfw_meta`, not `ctx.storage.kv` (a record applies inside synchronous
	 * `transactionSync`).
	 * `metaSet('')` clears the in-flight marker: `v` is NOT NULL, so empty means absent.
	 */
	logStore(): LogStore {
		return {
			read: (key) => this.metaGet(key),
			write: (key, value) => this.metaSet(key, value),
			exec: (sql, params) => this.sql.exec(sql, ...params),
			txn: (fn) => this.storage.transactionSync(fn)
		};
	}

	/**
	 * Which values this object cannot mint for itself and does not hold.
	 *
	 * Asked of a replica (did the copy finish) and of a primary (may it be copied from): a
	 * provisioned site holds no `system.private_key` yet, and each replica would then mint a key
	 * the others reject.
	 */
	mandatoryGap(): string[] {
		const read = readStateRows((sql) => this.sql.exec(sql).toArray());
		return missingMandatory({
			stage: this.replicaStage(),
			presentState: read.rows.map((r) => ({ collection: r.collection, name: r.name })),
			presentCollections: [...new Set(read.rows.map((r) => r.collection))],
			appliedGeneration: 0,
			advertisedGeneration: 0,
			fingerprint: null,
			primaryFingerprint: null,
			schemaVersion: null,
			primarySchemaVersion: null
		});
	}

	async provisionLane(
		lane: number,
		cursor: ProvisionCursor | undefined,
		budget?: number
	): Promise<ProvisionOutcome> {
		return provisionLane(this, lane, cursor, budget);
	}

	/**
	 * Records that a lane finished copying; the key puts `x-cfw-lanes` on responses, so every
	 * provisioning path must call this (one writer).
	 */
	noteLaneServing(lane: number): void {
		const provisioned = this.lanesProvisioned();
		if (lane > provisioned) {
			const epoch = this.lanesEpoch() + 1;
			this.metaSet(LANES_PROVISIONED_KEY, String(lane));
			this.metaSet(LANES_EPOCH_KEY, String(epoch));
			this.lanesMemo = lane;
			this.epochMemo = epoch;
			// once per epoch, so a colo that has never answered for this site still finds the pool
			const kv = (this.env as { CONFIG_KV?: KVNamespace } | undefined)?.CONFIG_KV;
			const site = this.ctx.id.name;
			if (kv && site) {
				this.lanesPublished = kv
					.put(lanesKvKey(site), formatLanesPointer(lane, epoch))
					.catch(() => undefined);
			}
		}
	}

	/** statements sealed for replication since `sinceMs`, each at least one row on every lane */
	replicatedRowsSince(sinceMs: number): number {
		try {
			const row = firstRow(
				this.sql.exec<Row<{ n: number }>>(
					'SELECT COALESCE(SUM(json_array_length(statements)), 0) AS n FROM cfw_repl_log WHERE sealed_at >= ?',
					sinceMs
				)
			);
			return Number(row?.n ?? 0);
		} catch {
			// no log yet means nothing has been sealed for a lane to replay
			return 0;
		}
	}

	/** set when one more lane would project the day's rows past the reduce fraction */
	laneRowsCap?: LaneRowsCap;

	/** the last `CONFIG_KV` write of the pool, awaited only by tests */
	lanesPublished?: Promise<unknown>;

	/** the lanes epoch read once per incarnation */
	private epochMemo?: number;

	/** the pool epoch, bumped whenever the lane count grows */
	private lanesEpoch(): number {
		if (this.epochMemo === undefined) {
			this.epochMemo = Number(this.metaGet(LANES_EPOCH_KEY) ?? 0) || 0;
		}
		return this.epochMemo;
	}

	/** the pool advertisement every primary response carries, or nothing without a pool */
	laneHeaders(): Record<string, string> {
		const lanes = this.isPoolLane() ? 0 : this.lanesProvisioned();
		if (lanes <= 0) return {};
		return { [LANES_HEADER]: String(lanes), [LANES_EPOCH_HEADER]: String(this.lanesEpoch()) };
	}

	/** the pool size read once per incarnation; only `noteLaneServing()` moves it */
	private lanesMemo?: number;

	/**
	 * How many lanes this primary has built; memoised for the storage fast lane, which must
	 * advertise the pool on cache hits.
	 */
	private lanesProvisioned(): number {
		if (this.lanesMemo === undefined) {
			this.lanesMemo = Number(this.metaGet(LANES_PROVISIONED_KEY) ?? 0) || 0;
		}
		return this.lanesMemo;
	}

	async sessionReach(cookie: string): Promise<'held' | 'absent' | 'unknown'> {
		return sessionReach(this, cookie);
	}

	/** whether this object holds a table at all; the restore's own precondition */
	hasTable(table: string): boolean {
		return (
			this.sql
				.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table)
				.toArray().length > 0
		);
	}

	/**
	 * The DDL that recreates one table, its own statement first and its indexes after.
	 *
	 * `sql IS NOT NULL` drops sqlite's auto-indexes, which have no statement and are recreated with
	 * the table anyway.
	 */
	tableDdl(table: string): string[] {
		return this.sql
			.exec(
				`SELECT sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL
				 ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END`,
				table
			)
			.toArray()
			.map((r) => String((r as { sql: unknown }).sql));
	}

	/** every table this object holds, in `sqlite_master` order */
	tableNames(): string[] {
		return this.sql
			.exec(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
			.toArray()
			.map((r) => String((r as { name: unknown }).name));
	}

	/**
	 * One page of one table, as columns plus flat rows.
	 *
	 * Uses `OFFSET` (a `WITHOUT ROWID` table has no rowid); unstable under a concurrent write,
	 * which the receiving generation check refuses.
	 * ponytail: O(n^2) over a whole table; a keyset cursor if a restore ever spans a large one
	 */
	snapshotRows(
		table: string,
		offset: number,
		limit: number
	): { columns: string[]; rows: unknown[][] } {
		const verdict = planRestore([table])[0]!;
		if (!verdict.copy) throw new Error(`${table} is not copyable: ${verdict.reason}`);
		const raw = this.sql
			.exec(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`, limit, offset)
			.toArray() as Record<string, unknown>[];
		if (raw.length === 0) return { columns: [], rows: [] };
		const columns = Object.keys(raw[0]!);
		return { columns, rows: raw.map((r) => columns.map((c) => r[c])) };
	}

	/**
	 * Which slice of the rowid space this object's driver mints from.
	 *
	 * The count is {@link ID_PARTITION_LANES}, not the pool size (a lane cannot learn it). The
	 * primary takes slice 0, or unpartitioned ids collide with forwarded rows on `UNIQUE`. Gated
	 * on the site having a pool, since ids advance by the stride.
	 */
	idPartition(): { lane: number; lanes: number } {
		if (!writeForwardEnabled(this.env)) return { lane: 0, lanes: 0 };
		if (!this.isPoolLane()) {
			return this.lanesProvisioned() > 0
				? { lane: 0, lanes: ID_PARTITION_LANES }
				: { lane: 0, lanes: 0 };
		}
		const lane = replicaOf(this.ctx.id.name ?? '')?.lane ?? 0;
		return lane < 1 ? { lane: 0, lanes: 0 } : { lane, lanes: ID_PARTITION_LANES };
	}

	collectForward(statements: readonly string[], payload: unknown): void {
		return collectForward(this, statements, payload);
	}

	async flushForward(): Promise<ForwardOutcome | undefined> {
		return flushForward(this);
	}

	/**
	 * Records the rowids this lane minted for a batch the primary committed (else a second insert
	 * between catch-ups mints the id again). Uses `MAX` so the mark never falls.
	 */
	markLaneHigh(batch: readonly ForwardStatement[]): void {
		const marks = laneHighWater(batch);
		if (marks.size === 0) return;
		this.ensureServeTables();
		for (const [table, id] of marks) {
			this.sql.exec(
				`INSERT INTO cfw_meta (k, v) VALUES (?, ?)
				 ON CONFLICT(k) DO UPDATE SET
				 v = MAX(CAST(cfw_meta.v AS INTEGER), CAST(excluded.v AS INTEGER))`,
				`${LANE_HIGH_PREFIX}${table}`,
				// a bound number lands as 5.0 in a TEXT column; the string keeps the row legible
				String(id)
			);
		}
	}

	/**
	 * Runs the tag-scoped purge once the invocation's invalidated tags are complete.
	 *
	 * Runs at the end, so a death before it leaves a plan alive. The wholesale purge in
	 * `bumpGeneration()` runs at the write and has no such window.
	 */
	flushTagPurge(): string[] {
		const tags = [...this.invalidatedTags];
		this.invalidatedTags.clear();
		if (tags.length > 0) {
			// here the set is complete (a wholesale purge re-queues ~2,750 fills/day at 50 saves;
			// a node save depends on 3 to 10 pages)
			this.lastScopedPurge = this.purgeForTags(tags, 'cachetags', { bump: false });
			this.clearPendingTags();
		}
		return tags;
	}

	/**
	 * Sets a stored page's tag list out of band, for a caller that did not write the row.
	 *
	 * Tags come from the render's cacheability metadata, never parsed HTML. Replaces rather than
	 * merges, so a re-render with fewer dependencies is not purged by a dropped tag.
	 */
	indexPageTags(path: string, tags: unknown): void {
		this.sql.exec('UPDATE cfw_page SET tags = ? WHERE path = ?', pageTagList(tags), path);
	}

	/** the stored paths that depend on any of `tags` */
	pathsForTags(tags: readonly string[]): string[] | undefined {
		return pathsForTags(this, tags);
	}

	/**
	 * Persists the tags this invocation invalidated, at the write, so a crash before
	 * `flushTagPurge()` leaves a durable record of what is owed. {@link drainPendingTags} settles
	 * it at the end of the invocation and again at boot.
	 */
	notePendingTags(tags: readonly string[]): void {
		if (tags.length === 0) return;
		const held = new Set(this.pendingTags());
		for (const tag of tags) held.add(tag);
		// bounded: past this a wholesale purge is correct and cheaper than an unbounded row
		const kept = [...held].slice(0, 256);
		this.metaSet(PENDING_TAGS_KEY, JSON.stringify(kept));
	}

	/** the durably recorded tag set, empty when there is nothing owed */
	pendingTags(): string[] {
		try {
			const raw = JSON.parse(this.metaGet(PENDING_TAGS_KEY) || '[]') as unknown;
			return Array.isArray(raw) ? raw.map((t) => String(t)) : [];
		} catch {
			return [];
		}
	}

	/** forgets the recorded set, once the purge it describes has happened */
	clearPendingTags(): void {
		if ((this.metaGet(PENDING_TAGS_KEY) ?? '') !== '') this.metaSet(PENDING_TAGS_KEY, '');
	}

	/**
	 * Settles a purge a previous invocation recorded and did not finish; runs at boot too, so a
	 * dead invocation purges on the next.
	 */
	settlePendingIfOwed(): void {
		if (this.pendingDrained === true) return;
		this.pendingDrained = true;
		try {
			const drained = this.drainPendingTags();
			if (drained) this.lastPendingDrain = drained;
		} catch {
			// a site with no serving tables owes nothing, and this must never fail a request
		}
	}

	/** purges the recorded pending tags and clears the record; undefined when none are owed */
	drainPendingTags(): { tags: number; purged: number } | undefined {
		const owed = this.pendingTags();
		if (owed.length === 0) return undefined;
		// reason `cachetags`: this is that purge settled late (other reasons take the wholesale
		// path)
		const out = this.purgeForTags(owed, 'cachetags', { bump: false });
		this.clearPendingTags();
		return out;
	}

	/** a comma-joined restore bookkeeping list, empty when unset */
	restoreList(key: string): string[] {
		const raw = this.metaGet(key) ?? '';
		return raw === '' ? [] : raw.split(',');
	}

	/**
	 * Abandons a restore in progress.
	 *
	 * Without it `restore_generation` survives and every chunk of a fresh attempt is refused as
	 * torn. The in-flight marker stays: landed rows remain and the replica is untrusted until a
	 * copy completes.
	 */
	clearRestore(): void {
		this.metaSet(RESTORE_GENERATION_KEY, '');
		this.metaSet(RESTORE_EXPECT_KEY, '');
		this.metaSet(RESTORE_SEEN_KEY, '');
	}

	applyRestoreChunk(chunk: RestoreChunk): {
		ok: boolean;
		reason: string;
		stage: ReplicaStage;
		statements: number;
		missing: string[];
	} {
		return applyRestoreChunk(this, chunk);
	}

	async catchUpOnce(limit?: number): Promise<{
		ran: boolean;
		reason: string;
		applied: number;
		advertised: number;
		records: number;
		stage: ReplicaStage;
		admitted: boolean;
	}> {
		return catchUpOnce(this, limit);
	}

	/**
	 * The `scheme://host[:port]` this site renders absolute URLs against; pinned on first use (one
	 * `cfw_meta` row), and a local origin is never pinned.
	 *
	 * @param observed - `url.origin` of the request being served (the visitor's scheme and host in
	 *   production); harness origins like `do.local` are refused by {@link pinnable}
	 */
	canonicalOrigin(observed?: string): string {
		const chosen = chooseOrigin({
			configured: this.env?.SITE_ORIGIN,
			pinned: this.metaGet(ORIGIN_KEY),
			observed
		});
		// a replica inherits the primary's origin with the first restore chunk (the session
		// cookie name derives from the host)
		// `isReplica()`, not `isPoolLane()`: a var-configured replica has the same defect
		if (chosen.from === 'observed' && pinnable(chosen.origin) && !this.isReplica()) {
			this.metaSet(ORIGIN_KEY, chosen.origin);
		}
		return chosen.origin;
	}

	/**
	 * Which site this object is, pinned like the origin (a shared bucket needs per-site mirror
	 * keys, not the literal `'site'`).
	 */
	siteName(observed?: string): string {
		const pinned = this.metaGet(SITE_NAME_KEY);
		if (pinned !== null && pinned !== '') return pinned;
		const seen = (observed ?? '').trim();
		if (seen === '') return 'site';
		this.metaSet(SITE_NAME_KEY, seen);
		return seen;
	}

	/**
	 * The site generation: one integer every edge cache key carries, so one write unreaches every
	 * cached URL (tag purge is Enterprise-only).
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
	 * Deletes the plans that depend on any of `tags`, or every plan when none are known.
	 *
	 * `LIKE` rather than a join table: a page bubbles 10-40 tags and a row each would spend the
	 * meter that binds regeneration, so the tags live in one JSON column on the plan row.
	 */
	purgePlansFor(tags?: string[]): number {
		const before = Number(
			firstRow(this.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_plan'))?.c ??
				0
		);
		if (!tags || tags.length === 0) {
			this.sql.exec('DELETE FROM cfw_plan');
			return before;
		}
		for (const tag of tags) {
			// the pattern stays inside the 50-byte `LIKE` limit (`cacheTagsIn` caps the name at 40)
			this.sql.exec('DELETE FROM cfw_plan WHERE tags LIKE ?', `%"${tag}"%`);
		}
		const after = Number(
			firstRow(this.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_plan'))?.c ??
				0
		);
		return before - after;
	}

	/**
	 * Flags every plan the moment content changes, before the tag set is known.
	 *
	 * One wholesale `UPDATE` at the write, so an invocation that dies before
	 * {@link settlePlans} leaves everything flagged. Not coalesced on `bumpCoalesced`, which only
	 * `fillOne()` clears (a node save left plans in place on a site serving plans).
	 */
	stalePlans(): void {
		if (this.plansStaled) return;
		this.plansStaled = true;
		// runs inside `execSql()`, so a missing table would fail the triggering write
		this.ensureServeTables();
		this.sql.exec('UPDATE cfw_plan SET stale = 1 WHERE stale = 0');
	}

	/**
	 * Deletes the plans this invocation's tags invalidate and un-flags the rest; runs at the end,
	 * when the tag set is complete.
	 */
	settlePlans(tags: readonly string[]): { purged: number; cleared: boolean } {
		if (!this.plansStaled) return { purged: 0, cleared: false };
		this.plansStaled = false;
		this.ensureServeTables();
		// no tags with a stale flag set means the write that flagged them named nothing usable, so
		// the conservative reading stands and every plan goes
		const purged = this.purgePlansFor(tags.length === 0 ? undefined : [...tags]);
		this.sql.exec('UPDATE cfw_plan SET stale = 0 WHERE stale = 1');
		return { purged, cleared: true };
	}

	purgeForTags(
		tags: readonly string[],
		reason?: string,
		options?: { bump?: boolean | undefined }
	) {
		return purgeForTags(this, tags, reason, options);
	}

	bumpGeneration(
		reason?: string,
		options?: { arm?: boolean; invalidatedTags?: string[]; scopedTo?: string[] }
	) {
		return bumpGeneration(this, reason, options);
	}

	/**
	 * Empties Drupal's dynamic page cache, tolerating a site that has never created the table.
	 *
	 * @returns rows removed, or -1 when the bin does not exist yet.
	 */
	purgeDynamicPageCache(): number {
		try {
			const before = Number(
				firstRow(
					this.sql.exec<Row<{ c: number }>>(
						'SELECT COUNT(*) AS c FROM cache_dynamic_page_cache'
					)
				)?.c ?? 0
			);
			this.sql.exec('DELETE FROM cache_dynamic_page_cache');
			return before;
		} catch (e) {
			if (!isMissingTable(e)) this.noteError('purgeDynamicPageCache', e);
			return -1;
		}
	}

	/**
	 * Drops the derived caches a lane holds once the primary's log has moved it past a generation.
	 *
	 * Only the primary runs `bumpGeneration()`; replayed SQL leaves a lane's path-keyed `cfw_page`
	 * stale. Wholesale, since the log carries statements, not tags.
	 *
	 * @returns what each store gave up, for the pull loop to report
	 */
	purgeAfterApply(): { pages: number; shells: number; plans: number; dynamic: number } {
		const count = (table: string): number =>
			Number(
				firstRow(this.sql.exec<Row<{ c: number }>>(`SELECT COUNT(*) AS c FROM ${table}`))
					?.c ?? 0
			);
		const pages = count('cfw_page');
		if (pages > 0) this.sql.exec('DELETE FROM cfw_page');
		const shells = count('cfw_shell');
		if (shells > 0) {
			this.sql.exec('DELETE FROM cfw_shell');
			this.sql.exec('DELETE FROM cfw_shell_verified');
		}
		const plans = this.purgePlansFor();
		const dynamic = this.purgeDynamicPageCache();
		return { pages, shells, plans, dynamic };
	}

	/**
	 * Queues a refill for one path and wakes the chain; await-free (the storage lane runs outside
	 * the gate) and bounded by `FILL_QUEUE_MAX`.
	 */
	enqueueRefill(path: string): void {
		if (this.queueDepth() >= FILL_QUEUE_MAX) return;
		this.sql.exec(
			'INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING',
			path,
			this.nowMs()
		);
		this.armFillAlarm();
	}

	/**
	 * Sets an alarm and remembers when it is due, so `armFillAlarm()` never believes a +1 ms alarm
	 * survived a 240 s re-arm.
	 */
	async setAlarmAt(atMs: number): Promise<void> {
		this.alarmDueMs = atMs;
		await this.storage.setAlarm(atMs);
	}

	/**
	 * Arms the fill alarm without disturbing one that is already sooner.
	 *
	 * Synchronous callers cannot await `getAlarm()`, so the guard is an in-memory note; an
	 * unconditional `setAlarm()` costs a row per hit on hot paths. Fire-and-forget: a memo lost to
	 * hibernation costs one extra arm and never skips one.
	 */
	armFillAlarm(delayMs = 1): void {
		const at = this.nowMs() + Math.max(1, delayMs);
		if (this.alarmDueMs !== undefined && this.alarmDueMs <= at) return;
		try {
			this.alarmDueMs = at;
			const armed = this.storage.setAlarm(at);
			if (armed && typeof armed.catch === 'function') armed.catch(() => {});
		} catch {
			/* an unschedulable alarm must not fail the save that triggered it */
		}
	}

	/**
	 * Every Drupal statement, plus the automatic invalidation trigger.
	 *
	 * Suppressed during /__migrate (packed `cachetags` rows are setup). Coalesced: one save writes
	 * many tags, and once bumped further writes are ignored until `fillOne()` clears the flag.
	 */
	override execSql(sql: string, params?: SqlBindings): ExecSqlResult {
		// trace before the statement runs: a reset rolls back SQL, console.log survives, and the
		// last line names the killer
		if (this.env?.PW_SQL_TRACE === '1') {
			this.sqlTraceSeq = (this.sqlTraceSeq ?? 0) + 1;
			// a tail event caps at 256 KB (~1,005 statements of an install); `PW_SQL_TRACE_FROM`
			// spends it on the run's end
			const from = Number(this.env?.PW_SQL_TRACE_FROM ?? 0);
			if (this.sqlTraceSeq >= from) {
				console.log(`cfwsql ${this.sqlTraceSeq} ${sql.replace(/\s+/g, ' ').slice(0, 60)}`);
			}
		}
		const result = super.execSql(sql, params);
		// an integer above 2^53 arrives as a wrong double; re-read the statement through a casting
		// projection (free on core sites)
		const repaired = repairWideIntegers(sql, result.rows as WideRow[], (wrapped) => {
			const { text, values } = toPositional(wrapped, params);
			return this.sql.exec(text, ...values.map(bindable)).toArray() as WideRow[];
		});
		if (repaired.repair) {
			result.rows = repaired.rows as typeof result.rows;
			this.wideRepairs = (this.wideRepairs ?? 0) + 1;
		}
		// no tally here: this is the PHP driver's entry point; `countingSql()` wraps the shared
		// handle
		if (!this.suppressBump) {
			// not inside a rolled-back replay (it re-executes the buffer, so statements would be
			// logged twice: 154 logged for 19 real)
			if (!this.speculating) this.noteAuthoritativeWrite(sql, params);
			if (CACHETAG_WRITE.test(sql)) {
				// every tag, not the first: a node save writes `node:3:revisions` before
				// `node_list`
				const written = cacheTagsIn(params);
				for (const tag of written) this.invalidatedTags.add(tag);
				// durable at the write: the boot drain settles it if the invocation dies before
				// `flushTagPurge()`
				this.notePendingTags(written);
				// outside the coalesce: `bumpCoalesced` latches for the incarnation, so later plans
				// would never be flagged
				this.stalePlans();
				if (!this.bumpCoalesced) {
					this.bumpCoalesced = true;
					// moves the generation (this response must carry it) and purges nothing; the
					// tag set is incomplete until `flushTagPurge()`
					this.bumpGeneration('cachetags', {
						invalidatedTags: [...this.invalidatedTags],
						scopedTo: []
					});
				}
			}
		}
		return result;
	}

	/**
	 * Advances the commit sequence when a statement writes authoritative state.
	 *
	 * Keyed on the target table, not cache tags (a user create and a `system.private_key` rotation
	 * write no tag). Every `key_value` write counts, which over-advances safely: too often costs a
	 * refresh, too rarely serves stale authorization.
	 */
	noteAuthoritativeWrite(sql: string, params?: SqlBindings): void {
		const table = writeTargetTable(sql);
		if (table === undefined) return;
		if (table === 'key_value' || table === 'key_value_expire') {
			this.advanceCommit();
			this.bufferForReplication(sql, params);
			return;
		}
		if (classifyState(table) === 'AUTHORITATIVE') {
			this.advanceCommit();
			this.bufferForReplication(sql, params);
		}
	}

	bufferForReplication(sql: string, params?: SqlBindings): void {
		return bufferForReplication(this, sql, params);
	}

	async sealGeneration(): Promise<{ generation: number; statements: number } | undefined> {
		return sealGeneration(this);
	}

	/** creates the replication log table if absent */
	ensureReplicationLog(): void {
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS cfw_repl_log (
        generation INTEGER PRIMARY KEY,
        parent INTEGER NOT NULL,
        schema_version TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        overflowed INTEGER NOT NULL DEFAULT 0,
        statements TEXT NOT NULL,
        sealed_at INTEGER NOT NULL
      ) WITHOUT ROWID`
		);
	}

	/**
	 * The generation a copy may hand a replica: the last sealed record, not `commitSeq()`.
	 *
	 * The sequence can sit ahead of the last record (a lane copied at 86 meets a record from 85
	 * and is withdrawn). The gap holds no statements, so resuming at the last record skips no
	 * change.
	 */
	copyableGeneration(): number {
		this.ensureReplicationLog();
		const row = firstRow(this.sql.exec(`SELECT MAX(generation) AS head FROM cfw_repl_log`)) as
			{ head: number | null } | undefined;
		const head = Number(row?.head ?? 0);
		return Number.isFinite(head) && head > 0 ? head : this.commitSeq();
	}

	/** sealed log records after generation `since` */
	replicationRecords(since: number, limit?: number): LogRecord[] {
		return replicationRecords(this, since, limit);
	}

	/**
	 * Advances the monotonic count of authoritative invalidations that a replica fences on.
	 *
	 * Separate from `generation`, a coalesced page-purge counter that stops moving once
	 * `cfw_page` is empty (a permission grant invalidated two tags and left it still).
	 */
	advanceCommit(): number {
		this.pendingCommits = (this.pendingCommits ?? 0) + 1;
		return this.commitSeq();
	}

	/** the stored commit sequence plus advances not yet persisted */
	commitSeq(): number {
		return Number(this.metaGet(COMMIT_SEQ_KEY, '0') ?? 0) + (this.pendingCommits ?? 0);
	}

	/**
	 * Persists the invocation's commit advances as one row (a write per statement was 15% of a node
	 * save's row cost). An invocation's writes commit together, so the counter cannot fall behind
	 * the data it fences; the seal flushes unconditionally, since under-advancing serves stale
	 * authorization.
	 */
	flushCommitSeq(): void {
		if (!this.pendingCommits) return;
		const next = this.commitSeq();
		this.pendingCommits = 0;
		this.metaSet(COMMIT_SEQ_KEY, next);
	}

	/**
	 * Counts speculative replays whose read could not have seen the buffer anyway.
	 *
	 * An instrument, not a lever (skipping a replay also skips `rememberResults()`); measured zero,
	 * since replays on a content write carry no read.
	 */
	override execTxn(req: TxnRequest): ExecTxnResult {
		const statements = Array.isArray(req?.statements) ? req.statements : [];
		if (req?.commit === false) {
			if (req?.read) this.txnSpeculativeWithRead = (this.txnSpeculativeWithRead ?? 0) + 1;
			else this.txnSpeculativeNoRead = (this.txnSpeculativeNoRead ?? 0) + 1;
		}
		if (req?.commit === false && req?.read && statements.length > 0) {
			const read = readSourceTables(req.read.sql);
			const written = statements.map((s) => writeTargetTable(s.sql));
			// record why it is not skippable (no opportunity and a blind classifier both read zero)
			if (!read) this.txnSkipUnparseable = (this.txnSkipUnparseable ?? 0) + 1;
			else if (written.includes(undefined)) {
				this.txnSkipUnattributed = (this.txnSkipUnattributed ?? 0) + 1;
			} else {
				const dirty = new Set(written.map((t) => String(t).toLowerCase()));
				if (read.some((t) => dirty.has(t.toLowerCase()))) {
					this.txnSkipOverlap = (this.txnSkipOverlap ?? 0) + 1;
				} else {
					this.txnSkippable = (this.txnSkippable ?? 0) + 1;
					this.txnSkippableStatements =
						(this.txnSkippableStatements ?? 0) + statements.length;
				}
			}
		}
		// `commit: false` is discarded (id replay or lane forwarding), so `execSql()` bookkeeping
		// must not run
		const was = this.speculating;
		this.speculating = req?.commit === false;
		try {
			return super.execTxn(req);
		} finally {
			this.speculating = was;
		}
	}

	strikeFillHead(error: string): number | undefined {
		return strikeFillHead(this, error);
	}

	/**
	 * The bins a fill empties on itself.
	 *
	 * `dynamic_page_cache` stays warm: 1.4x on a site whose page table fills (5 charged rows
	 * against 7), and tag invalidation still reaches it through its checksum. A non-tag bump
	 * purges it and `gcDynamicPageCache()` bounds it.
	 */
	static readonly FILL_BINS = FILL_BINS;

	async fillOne(
		targetPath?: string,
		bins?: string[],
		destruct?: boolean | string,
		request?: RenderRequest
	): Promise<FillOutcome> {
		return fillOne(this, targetPath, bins, destruct, request);
	}

	/**
	 * Wall-clock budget a miss may spend rendering before the path goes to the alarm chain.
	 *
	 * 2 s covers the measured first-render range (195 to 1,636 ms) and excludes the 3,754 ms cold
	 * boot; it bounds the visitor's patience, not a billed resource. `budget` on the query string
	 * overrides (0 disables inline rendering). A cold object refuses on `!this.php` before this is
	 * consulted.
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
	 * A prediction, because `php._run()` is one synchronous wasm call that no timer or
	 * `AbortSignal` can preempt. The last render is the best predictor; pessimistic with no
	 * evidence (a cold instance is the common case and must not gamble on a multi-second boot).
	 */
	estimateRenderMs(): number {
		if (!this.php) return 4000;
		// first render pays one-off opcache and container work (195 to 1,636 ms); on the edge
		// every post-boot render lands here (no clock across sync work), so 1800 = unknown
		if (this.lastRenderMs === undefined) return 1800;
		return this.lastRenderMs;
	}

	pageResponse(
		row: PageRow,
		tier: CacheTier,
		serveMs: number,
		extra?: Record<string, string>
	): Response {
		return pageResponse(this, row, tier, serveMs, extra);
	}

	/** rows waiting in the fill queue */
	queueDepth(): number {
		this.ensureServeTables();
		return Number(
			firstRow(this.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_fill_queue'))
				?.c ?? 0
		);
	}

	/**
	 * Whether this alarm firing should spend rows on garbage collection.
	 *
	 * Fills and GC share the rows-written meter, so a waiting page outranks reclaiming disk; the
	 * interval gate exists because the measured steady state is 0 rows written.
	 */
	shouldRunGc(): boolean {
		const everyMs = Number(this.env?.GC_INTERVAL_MS ?? 3_600_000);
		if (!this.serveTablesReady) return false;
		const queued = firstRow(
			this.sql.exec<Row<{ n: number }>>('SELECT count(*) AS n FROM cfw_fill_queue')
		)?.n;
		if (Number(queued ?? 0) > 0) return false;
		return !this.lastGcAt || Date.now() - this.lastGcAt >= everyMs;
	}

	/**
	 * Row count for a table that may not exist yet. null rather than 0: several Drupal tables are
	 * created lazily on first write, and 0 for a missing one reads as a verified invariant.
	 */
	countOrNull(table: string, where?: string): number | null {
		try {
			// `where` is a literal from this file only (no bind slot for a predicate)
			const sql = `SELECT count(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`;
			return firstRow(this.sql.exec<Row<{ n: number }>>(sql))?.n ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * The JS-side migrator, built lazily (the manifest is an asset fetch) and cached (re-reading
	 * per chunk costs 15 subrequests of the 50 cap).
	 */
	migrator(): SqlMigrator {
		if (!this._migrator) {
			this._migrator = new SqlMigrator({
				sql: this.sql,
				storage: this.storage,
				now: () => this.nowMs(),
				...assetChunkLoader(this.env, sqlChunkPrefix(this.env))
			});
		}
		return this._migrator;
	}

	/**
	 * The cursor when a migration is started but unfinished, else undefined (never started must
	 * keep serving; deploys predate the chunked engine).
	 */
	migratePartial(): MigrateCursor | undefined {
		const cursor = this.migrateCursorOrNull();
		if (!cursor || cursor.state === 'done') return undefined;
		return cursor;
	}

	/**
	 * Whether a page request asked this site to provision itself; durable (one `cfw_meta` row),
	 * since an eviction sits between ask and alarm.
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

	/** records that a visitor wants this site, and wakes the alarm chain to build it */
	async requestProvision(): Promise<void> {
		this.sql.exec(`CREATE TABLE IF NOT EXISTS cfw_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
		this.sql.exec(
			`INSERT INTO cfw_meta (k, v) VALUES ('provision_requested', '1')
			 ON CONFLICT(k) DO NOTHING`
		);
		await this.setAlarmAt(this.nowMs() + 1);
	}

	/**
	 * Whether this deployment ships migration chunks; a quiet false, since an alarm that throws
	 * stops re-arming.
	 */
	async hasMigrationManifest(): Promise<boolean> {
		try {
			await assetChunkLoader(this.env, sqlChunkPrefix(this.env)).loadManifest();
			return true;
		} catch (e) {
			this.noteError('hasMigrationManifest', e);
			return false;
		}
	}

	/**
	 * Whether this site was never provisioned (no cursor at all, unlike a half-finished one);
	 * `migrateStepIfPending()` needs a cursor, so this starts the chain.
	 */
	neverMigrated(): boolean {
		ensureMigrateTable(this.sql);
		return this.migrateCursorOrNull() === null && this.migrated !== true;
	}

	/**
	 * Records whether a path can be stored at all; only an anonymous render Drupal itself refused
	 * counts (a cookie, redirect or 500 is transient).
	 */
	noteStorable(path: string, cacheable: boolean, refused: boolean, anonymous: boolean): void {
		const unstorable = !cacheable && refused && anonymous;
		const held = new Set(this.unstorablePaths());
		if (unstorable === held.has(path)) return;
		if (unstorable) held.add(path);
		else held.delete(path);
		// bounded: past this a cold boot per path is not worth it
		this.metaSet(UNSTORABLE_KEY, [...held].slice(-64).join('\n'));
	}

	/** the paths a render has proven cannot be stored */
	unstorablePaths(): string[] {
		return (this.metaGet(UNSTORABLE_KEY) || '').split('\n').filter((p) => p !== '');
	}

	/** whether the fill chain has already proven it cannot satisfy this path */
	isUnstorable(path: string): boolean {
		return this.unstorablePaths().includes(path);
	}

	/**
	 * The idle re-arm this site's own traffic justifies.
	 *
	 * Falls back to the configured interval when the predictor has nothing to say. The warm branch
	 * is solved (climbing toward 9,500 on windows the object survived); an explicit
	 * `WARM_INTERVAL_MS` wins.
	 */
	thermalRearmMs(): number {
		const headroom = this.degradation().cron;
		const configured = idleRearmMs(this.env, headroom);
		if (!headroom) return configured;
		const forced = warmForced(this.env, isPaid(this.env));
		const stored = this.storedRenderWindow();
		const decision = warmDecision(this.arrivals ?? [], this.nowMs(), {
			thresholdMs: HIBERNATION_IDLE_MS,
			forced,
			lastAuthenticatedAt: this.lastAuthenticatedAt,
			stored
		});
		this.lastWarmDecision = decision;
		if (!decision.warm) return keepWarmMs(this.env);
		return (
			warmIntervalConfigured(this.env) ??
			clampWarmInterval(stored?.intervalMs ?? WARM_INTERVAL_VERIFIED_MS, HIBERNATION_IDLE_MS)
		);
	}

	/** the origin public bytes are served from, or '' when everything goes through the Worker */
	publicFilesOrigin(): string {
		return String(this.env?.FILES_PUBLIC_URL ?? '').replace(/\/+$/, '');
	}

	/**
	 * The R2 bucket to offload files to, or undefined when there is none.
	 *
	 * An absent bucket is supported (the free-tier default): files live durably in DO SQL and R2
	 * only buys serving headroom. Typed structurally so the drain runs over a stand-in.
	 */
	mirrorBucket(): MirrorBucket | undefined {
		const bucket = (this.env as { FILES?: MirrorBucket } | undefined)?.FILES;
		return bucket && typeof bucket.put === 'function' ? bucket : undefined;
	}

	/** this month's R2 writes against {@link r2WriteBudget}; the key carries the month */
	r2Allowance(): { month: string; used: number; budget: number; left: number } {
		const month = new Date().toISOString().slice(0, 7);
		const used = Number(this.metaGet(`r2_writes:${month}`, '0')) || 0;
		const budget = r2WriteBudget(this.env);
		return { month, used, budget, left: Math.max(0, budget - used) };
	}

	/** adds `ops` to this month's R2 write tally (deletes count too, so it reads high) */
	chargeR2(ops: number): void {
		if (ops <= 0) return;
		const { month, used } = this.r2Allowance();
		this.metaSet(`r2_writes:${month}`, used + ops);
	}

	/**
	 * Advances a database-update run by one beat; `updbStep()` owns no transport, alarm or env, so
	 * the dependency bag is built here.
	 */
	async updbStepOnce(): Promise<{ updb: Payload }> {
		return this.updbBeat(true);
	}

	/** a stepped operation (`cim`, `queue-drain`) the alarm carries to the end; undefined unread */
	private opsJobCache?: { job?: OpsJob };
	/** the last stepped-operation outcome */
	lastOpsJob?: Payload;

	/** reads the stored stepped job once and caches it, absence included */
	private readOpsJob(): OpsJob | undefined {
		if (this.opsJobCache !== undefined) return this.opsJobCache.job;
		let job: OpsJob | undefined;
		try {
			const raw = this.metaGet(OPS_JOB_KEY);
			const parsed = raw === null ? undefined : (JSON.parse(raw) as OpsJob);
			job = parsed && typeof parsed.name === 'string' ? parsed : undefined;
		} catch (e) {
			this.noteError('readOpsJob', e);
		}
		this.opsJobCache = { job };
		return job;
	}

	/** whether a stepped operation is in flight */
	opsJobActive(): boolean {
		return this.readOpsJob() !== undefined;
	}

	/**
	 * Runs one step of a stepped operation, keeping the job only while it reports more to do.
	 *
	 * A failed step also ends it (a retry from the top would replay what already landed). The first
	 * `cim` step carries the payload; the run holds its own state after that.
	 */
	async opsJobStep(name: string, args: string[], options: OpsJob['options']): Promise<Payload> {
		const ran = (await this.runJson(opsRun(name, args, options))) ?? {
			ok: false,
			error: 'no reply'
		};
		const more = ran['ok'] !== false && ran['done'] !== true;
		if (more) {
			const { payload: _first, ...rest } = options;
			const job: OpsJob = { name, args, options: rest };
			this.metaSet(OPS_JOB_KEY, JSON.stringify(job));
			this.opsJobCache = { job };
		} else if (this.readOpsJob() !== undefined) {
			this.sql.exec('DELETE FROM cfw_meta WHERE k = ?', OPS_JOB_KEY);
			this.opsJobCache = {};
		}
		this.lastOpsJob = { name, at: this.nowMs(), more, ...ran };
		return ran;
	}

	/** advances the stepped operation one step; a throw drops the job (a throwing alarm stops) */
	async opsJobBeat(): Promise<{ opsJob: Payload }> {
		const job = this.readOpsJob();
		if (!job) return { opsJob: { ok: true, idle: true } };
		try {
			return { opsJob: await this.opsJobStep(job.name, job.args, job.options) };
		} catch (e) {
			// recorded rather than rethrown, and the job dropped: a throwing alarm stops re-arming
			this.sql.exec('DELETE FROM cfw_meta WHERE k = ?', OPS_JOB_KEY);
			this.opsJobCache = {};
			const failure = { ok: false, error: errorMessage(e) };
			this.lastOpsJob = { name: job.name, at: this.nowMs(), more: false, ...failure };
			return { opsJob: failure };
		}
	}

	/** the one dependency bag every updb entry point takes; nothing here holds state */
	updbDeps(): UpdbDeps {
		return {
			sql: this.sql,
			runJson: (code: string) => this.runJson(code),
			// no `phpReady`: a unit boots a cold interpreter itself (free's 10 ms cap does not fail
			// a DO invocation)
			txn: (fn: () => void) => this.storage.transactionSync(fn),
			nowMs: () => this.nowMs()
		} satisfies UpdbDeps;
	}

	async updbAction(action: string, params: URLSearchParams): Promise<Payload> {
		return updbAction(this, action, params);
	}

	/**
	 * One beat, acquiring the gate only when the caller does not already hold it.
	 *
	 * The gate is a non-reentrant FIFO chain and `fetch()` already holds it; a second acquire
	 * inside the router hangs forever. `alarm()` is its own event and needs the explicit acquire.
	 */
	async updbBeat(gated: boolean): Promise<{ updb: Payload }> {
		const beat = () => updbStep(this.updbDeps(), updbOptions(this.env));
		try {
			const step = gated ? await this.gate.run(beat, 'alarm-updb') : await beat();
			this.lastUpdb = { at: Date.now(), value: step };
			return { updb: step };
		} catch (e) {
			// recorded, not rethrown: an alarm that throws stops re-arming
			const failure = { ok: false, error: errorMessage(e) };
			this.lastUpdb = { at: Date.now(), value: failure };
			return { updb: failure };
		}
	}

	/**
	 * Which uploaded Worker version is answering; null under `wrangler dev --local` and in the
	 * test lanes (not deployed, not unknown).
	 */
	workerVersion(): { id: string; tag: string | null; timestamp: string | null } | null {
		const meta = (this.env as SiteEnv | undefined)?.CF_VERSION_METADATA;
		if (!meta || typeof meta.id !== 'string' || meta.id === '') return null;
		// an untagged upload supplies an empty tag; null is the honest answer
		const blank = (value: unknown): string | null =>
			typeof value === 'string' && value !== '' ? value : null;
		return { id: meta.id, tag: blank(meta.tag), timestamp: blank(meta.timestamp) };
	}

	/** the migration cursor for diagnostics, or null on a site that never started one */
	migrateCursorOrNull(): MigrateCursor | null {
		try {
			return readMigrateCursor(this.sql) ?? null;
		} catch {
			// the table is absent on a pre-existing deploy; that is a state, not an error
			return null;
		}
	}

	async migrateChunks(url: URL | undefined): Promise<Payload> {
		return migrateChunks(this, url);
	}

	async prefillServingTable(asked?: string): Promise<Payload> {
		return prefillServingTable(this, asked);
	}

	async migrateStepIfPending(): Promise<Payload | undefined> {
		return migrateStepIfPending(this);
	}

	/**
	 * Fill one page, then re-arm at +1 ms (each link is a fresh invocation with a fresh budget).
	 *
	 * The fill runs inside the gate. The return is `any` because the platform discards it and this
	 * one feeds `/__serve-stats`.
	 */
	override async alarm(info?: AlarmInvocationInfo): Promise<any> {
		this.adoptRetained();
		recordInDeployment(this);
		this.sleepBudget = { remainingMs: sleepBudgetMs(this.env, 'alarm') };
		this.countActivity('alarms');
		// an alarm writes authoritative state (cron), so seal in `finally`: an unsealed buffer
		// would leak into the next request with the wrong parent
		const linearBefore = this.heapNow();
		this.resetBridgeBytes();
		try {
			const outcome = await alarmBody(this, info);
			noteAlarmDemand(this, outcome, linearBefore);
			return outcome;
		} catch (e) {
			this.noteRangeError(e, 'alarm');
			throw e;
		} finally {
			// cron saves content, so settle the plan flag here too; after the work, not at the head
			// of `route()` (DDL on the fast lane would sit next to an open replay)
			this.settlePendingIfOwed();
			const invalidated = this.flushTagPurge();
			if (invalidated.length > 0) this.lastInvalidatedTags = invalidated;
			const settled = this.settlePlans(invalidated);
			if (settled.cleared)
				this.lastPlanPurge = { purged: settled.purged, tags: invalidated.length };
			await this.sealGeneration();
			await this.keepLaneReplicating();
		}
	}

	/**
	 * Bounds how stale a serving lane may get by pulling its next firing in (30,000 ms against the
	 * 240,000 ms idle re-arm; the fence refuses only callers that state a freshness requirement).
	 * Runs in the `finally` because the body has many returns.
	 */
	private async keepLaneReplicating(): Promise<void> {
		if (!this.isPoolLane() || this.replicaStage() !== 'SERVING') return;
		const bound = this.nowMs() + replicaLagMs(this.env);
		const armed = await this.storage.getAlarm();
		if (armed !== null && armed <= bound) return;
		await this.setAlarmAt(bound);
	}

	/** the attempt the next render belongs to; see `src/ops/attempt.ts` */
	pendingAttempt?: string;

	/** records that an attempt's PHP is about to run, dropping markers past their ttl */
	markAttempt(key: string): void {
		const now = this.nowMs();
		this.ensureServeTables();
		this.sql.exec(
			"DELETE FROM cfw_meta WHERE k >= 'attempt:' AND k < 'attempt;' AND CAST(v AS INTEGER) < ?",
			now - ATTEMPT_TTL_MS
		);
		this.metaSet(key, now);
	}

	/** the end of the young-interpreter hold on background PHP, or undefined when there is none */
	backgroundHold(): number | undefined {
		if (!this.php?.binary) return undefined;
		return backgroundPhpHold(this.phpBootedAt, this.nowMs(), fillSettleMs(this.env));
	}

	/**
	 * Runs a PHP fragment and returns everything it wrote.
	 *
	 * A wasm trap (`RuntimeError` out of `_run()`) leaves a half-finished Zend state, so the
	 * interpreter is dropped. The error still propagates; a 503 would read as warming and hide a
	 * fault.
	 */
	async run(code: string): Promise<string> {
		const inst = await this.ensurePhp();
		this.out.length = 0;
		try {
			await inst.php._run(code);
		} catch (e) {
			// name rather than instanceof alone: the pool and the worker are different realms
			if (e instanceof WebAssembly.RuntimeError || (e as Error)?.name === 'RuntimeError') {
				this.trappedRuns = (this.trappedRuns ?? 0) + 1;
				this.lastTrap = { at: this.nowMs(), message: errorMessage(e) };
				this.dropInterpreter();
			}
			throw e;
		}
		return this.out.join('');
	}

	/** runs a fragment and parses the JSON object it printed */
	async runJson(code: string): Promise<Payload> {
		return parseJsonReply(await this.run(code));
	}

	/** the 421 sending the caller to the primary; `neverRan` marks an uncommitted forward */
	replicaHandoff(refusal: ReplicaRequiresPrimary, neverRan?: boolean): Response {
		return replicaHandoff(this, refusal, neverRan);
	}

	/** serves one request: routes it, hands refusals to the primary, classifies platform limits */
	override async fetch(request: Request): Promise<Response> {
		this.adoptRetained();
		recordInDeployment(this);
		// one allowance per invocation; an alarm overlapping this request shares it until either
		// ends
		this.sleepBudget = { remainingMs: sleepBudgetMs(this.env, 'request') };
		// in-flight requests are the queue (one request at a time); peak, since the alarm reads
		// and resets it per window
		this.inflight = (this.inflight ?? 0) + 1;
		if (this.inflight > (this.inflightPeak ?? 0)) this.inflightPeak = this.inflight;
		// the monotonic total, not the ring's length (capped at 20, so the comparison below
		// saturates and the handoff stops after 20 refusals)
		const refusalsBefore = this.replicaRefusalsTotal;
		const forwardBefore = this.lastForward;
		try {
			const linearBefore = this.heapNow();
			const reusedBefore = this.heapsReused ?? 0;
			this.resetBridgeBytes();
			const res = await routeImpl(this, request);
			this.noteDemand(request, linearBefore, reusedBefore);
			// a refusal PHP caught is still a refusal (Drupal's session handler turns it into a
			// 500 the catch below never sees)
			// only when nothing was forwarded: a forwarded batch already committed on the primary,
			// and a retry would apply it twice
			const refusal = this.replicaRefusals.at(-1);
			if (
				res.status >= 500 &&
				this.replicaRefusalsTotal > refusalsBefore &&
				this.lastForward === forwardBefore &&
				refusal !== undefined
			) {
				return this.replicaHandoff(refusal);
			}
			return withKvGrant(this, request, this.withDegradeHeaders(res));
		} catch (e) {
			// a replica meeting work it may not do is the guard working; send the caller to the
			// primary
			// an uncommitted forward is retry-safe (the lane rolled back and the primary refused
			// the batch whole)
			if (e instanceof ReplicaRequiresPrimary) {
				return this.replicaHandoff(e, e.capability === 'forward');
			}
			// classified and rethrown, around both lanes (the fast lane reads storage outside the
			// gate)
			noteLimit(this.limitTally, e);
			this.noteRangeError(e, 'fetch', request);
			throw e;
		} finally {
			this.inflight = Math.max(0, (this.inflight ?? 1) - 1);
		}
	}

	/**
	 * Marks every response with the degradation band (so `reduced` is visible before the final
	 * 503); at `normal` the response passes untouched.
	 */
	private withDegradeHeaders(res: Response): Response {
		let extra: Record<string, string>;
		try {
			extra = degradeHeaders(this.degradation());
		} catch {
			// meters are unreadable before the tables exist; an unmarked response is honest
			return res;
		}
		if (Object.keys(extra).length === 0) return res;
		// a 101 carries no headers a client can read and rewriting one drops the socket
		if (res.status === 101 || res.webSocket) return res;
		const headers = new Headers(res.headers);
		for (const [name, value] of Object.entries(extra)) headers.set(name, value);
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
	}

	/**
	 * Appends the disposable rows a forwarded batch carried, outside its transaction; a failure
	 * drops only that row, and nothing is buffered for replication.
	 */
	appendDeferred(statements: readonly ForwardStatement[]): number {
		let appended = 0;
		for (const s of statements) {
			try {
				this.sql.exec(s.sql, ...(s.params ?? []));
				appended++;
			} catch {
				// a lost log row is the whole cost
			}
		}
		return appended;
	}

	/**
	 * Queues a public image for its styles to be rendered ahead of the first view (derivatives and
	 * Drupal's styles directory are not sources).
	 */
	queueDerivatives(uri: string): void {
		if (!eagerDerivativesEnabled(this.env as never)) return;
		if (!/^public:\/\/.+\.(jpe?g|png|gif|webp|avif)$/i.test(uri)) return;
		if (uri.startsWith('public://styles/') || uri.startsWith('public://cfw-derivatives/'))
			return;
		this.sql.exec(
			'CREATE TABLE IF NOT EXISTS cfw_derive_queue (uri TEXT PRIMARY KEY, queued_at INTEGER NOT NULL)'
		);
		this.sql.exec(
			'INSERT OR REPLACE INTO cfw_derive_queue (uri, queued_at) VALUES (?, ?)',
			uri,
			this.nowMs()
		);
		void this.armFillAlarm(1000);
	}

	async deriveStep(transport?: DeriveTransport): Promise<void> {
		return deriveStep(this, transport);
	}

	/** today's granted `PAGE_KV` page writes, without flushing */
	dailyKvWrites(nowMs = this.nowMs()): number {
		return this.storedMeters(nowMs).kvWrites + (this.kvGrantsSinceFlush ?? 0);
	}

	/**
	 * The key N concurrent identical requests share, or undefined when they may not be coalesced.
	 *
	 * The cookie is in the key, so one visitor's page is never handed to another. Serving GETs
	 * only.
	 */
	herdKeyFor(request: Request, url: URL): string | undefined {
		if (request.method !== 'GET') return undefined;
		if (url.pathname !== '/__serve') return undefined;
		if (url.searchParams.get('lane') === 'gate') return undefined;
		const path = url.searchParams.get('path') ?? '/';
		// an anonymous request is already answered by the fast lane above without entering the gate
		const cookie = request.headers.get('cookie') ?? '';
		if (!hasSessionCookie(cookie)) return undefined;
		return `${this.generation()} ${path} ${cookie}`;
	}

	/**
	 * Linear memory right now, or 0 where there is nothing to read (`this.php` can be a
	 * `stubRender()` stub with no `binary`).
	 */
	heapNow(): number {
		const binary = this.php?.binary;
		if (!binary) return 0;
		return this.heapBytes(binary)?.byteLength ?? 0;
	}

	/** the last requests' effect on linear memory */
	demandLog: {
		path: string;
		method: string;
		before: number;
		after: number;
		reused: boolean;
		bridge?: { in: number; out: number; maxIn: number; maxOut: number; maxName: string };
		renderBytes?: number;
	}[] = [];

	/** the size of the last rendered page, for the demand record */
	lastRenderBytes = 0;

	/** zeroes the per-render size and bridge byte counters */
	private resetBridgeBytes(): void {
		this.lastRenderBytes = 0;
		const b = this.crossings?.bytes;
		if (b) {
			b.in = 0;
			b.out = 0;
			b.maxIn = 0;
			b.maxOut = 0;
			b.maxName = '';
		}
	}
	/** the highest linear-memory reading each path has caused */
	demandByPath: Record<string, number> = {};

	noteDemand(request: Request, before: number, reusedBefore: number): void {
		return noteDemand(this, request, before, reusedBefore);
	}

	/** the last RangeErrors a handler saw, with what the interpreter was doing when they landed */
	rangeErrors: RangeReport[] = [];

	noteRangeError(e: unknown, where: string, request?: Request): void {
		return noteRangeError(this, e, where, request);
	}

	/** the last faults a catch absorbed while keeping its fallback, oldest first */
	recentErrors: ErrorNote[] = [];

	noteError(where: string, e: unknown): void {
		return noteError(this, where, e);
	}

	/**
	 * The whole isolate's demand: wasm linear memory plus the JS-side bytes the mount holds (the
	 * pack blob and in-memory fs arrays share the 128 MiB budget).
	 */
	isolateNow(): number {
		const linear = this.heapNow();
		if (linear === 0) return 0;
		const lazy = lazyMountBytes(this.mountInfo);
		return linear + lazy.blob + lazy.resident + (lazy.blob > 0 ? PACK_INDEX_BYTES : 0);
	}

	/**
	 * Whether this object should drop its interpreter at the next safe point; either threshold
	 * fires.
	 *
	 * Only once the heap has grown since the boot (a reused memory starts large and a drop cannot
	 * shrink it, else it would drop every invocation). The batch guard reads this too.
	 */
	oversized(): boolean {
		const linear = this.heapNow();
		if (linear <= this.bootLinear) return false;
		return (
			linear >= recycleAboveBytes(this.env) ||
			this.isolateNow() >= isolateAboveBytes(this.env)
		);
	}

	/**
	 * Drops the interpreter, but only one with a `binary` (a `stubRender()` stub holds no heap and
	 * would be lost).
	 */
	dropInterpreter(): void {
		if (!this.php?.binary) return;
		this.php = undefined;
	}

	/** keeps this object's interpreter in module scope, stamped with the commit it has seen */
	retainInterpreter(): void {
		const id = this.ctx.id.toString();
		if (!this.phpInstance?.binary || !this.phpOwner || !retainInterpreterEnabled(this.env)) {
			retainedInterpreters.delete(id);
			return;
		}
		retainedInterpreters.set(id, {
			php: this.phpInstance,
			owner: this.phpOwner,
			commitSeq: this.commitSeq(),
			at: this.nowMs()
		});
	}

	/**
	 * Takes over the interpreter a previous instance left in module scope.
	 *
	 * Refused when the commit sequence moved (the object wrote elsewhere) or the previous instance
	 * held park sockets (they belong to its own I/O context).
	 */
	private adoptRetained(): void {
		if (this.phpInstance || !retainInterpreterEnabled(this.env)) return;
		const id = this.ctx.id.toString();
		// another object's entry is either gone or still held by its own live instance
		for (const key of retainedInterpreters.keys())
			if (key !== id) retainedInterpreters.delete(key);
		const kept = retainedInterpreters.get(id);
		if (!kept || kept.owner.current === this) return;
		const prev = kept.owner.current;
		const at = this.nowMs();
		let reason: string | undefined;
		try {
			// plain read, not `commitSeq()`: its `metaGet()` runs `ensureServeTables()`, which must
			// not run before the gate
			const row = firstRow(
				this.sql.exec<Row<{ v: string }>>(
					'SELECT v FROM cfw_meta WHERE k = ?',
					COMMIT_SEQ_KEY
				)
			);
			if (kept.commitSeq !== Number(row?.v ?? 0)) reason = 'stale';
		} catch {
			reason = 'unreadable';
		}
		if (!reason && (prev.parkSockets?.size ?? 0) > 0) reason = 'sockets';
		if (reason) {
			retainedInterpreters.delete(id);
			// its instance is gone, so its heap is garbage; the boot that follows takes it instead
			keepSpareMemory(kept.php);
			this.lastRetention = { at, adopted: false, reason };
			return;
		}
		this.out = prev.out;
		this.bootDiag = prev.bootDiag;
		this.bootMs = prev.bootMs;
		this.phpBootedAt = prev.phpBootedAt;
		this.bootLinear = prev.bootLinear;
		this.mountInfo = prev.mountInfo;
		this.heapRestore = prev.heapRestore;
		this.crossings = prev.crossings;
		this.crossingNames = prev.crossingNames;
		this.replicaGuard = prev.replicaGuard;
		this.pinnedHandles = prev.pinnedHandles;
		this.installedModuleFiles = prev.installedModuleFiles;
		// data about traps already armed in this interpreter; arming again could read as failed
		this.parkInstall = prev.parkInstall;
		this.phpOwner = kept.owner;
		kept.owner.current = this;
		this.phpInstance = kept.php;
		this.retentionAdoptions += 1;
		this.lastRetention = { at, adopted: true, idleMs: at - kept.at };
	}

	/**
	 * Drops the interpreter when linear memory has climbed too close to the isolate limit.
	 *
	 * PHP returns nothing under `USE_ZEND_ALLOC=0`, so demand is cumulative; past 128 MiB the edge
	 * resets the isolate and every in-flight request. Called between invocations only (a
	 * mid-request drop holds both heaps until collection). A ceiling check; a trend misses a
	 * workload arriving high.
	 */
	recycleIfOversized(reason: 'request' | 'alarm'): boolean {
		if (!this.php) return false;
		const bytes = this.heapNow();
		const rebuild = this.rebuildBoot;
		// both thresholds, as oversized() reads them (linear memory alone left the isolate past
		// its own)
		if (!this.oversized() && !rebuild) return false;
		this.dropInterpreter();
		this.rebuildBoot = false;
		this.lastRecycle = { at: this.nowMs(), bytes, reason, ...(rebuild ? { rebuild } : {}) };
		this.recycles = (this.recycles ?? 0) + 1;
		return true;
	}

	/** whether the next kernel boot has to rebuild the container; unreadable reads as no */
	private containerMissing(): boolean {
		try {
			const row = firstRow(
				this.sql.exec<Row<{ n: number }>>('SELECT COUNT(*) AS n FROM cache_container')
			);
			return Number(row?.n ?? 0) === 0;
		} catch (e) {
			if (!isMissingTable(e)) this.noteError('containerMissing', e);
			return false;
		}
	}

	/** drops the interpreter after a request that carried a file; see `carriesUpload()` */
	recycleAfterUpload(): void {
		if (!this.uploadSeen) return;
		this.uploadSeen = false;
		if (!this.php) return;
		this.lastRecycle = { at: this.nowMs(), bytes: this.heapNow(), reason: 'upload' };
		this.php = undefined;
		this.recycles = (this.recycles ?? 0) + 1;
	}

	/**
	 * When this page became superseded, derived from tag state rather than written per save.
	 *
	 * A marked row answers at once; an unmarked one is checked against its tags' invalidation sum
	 * and marked if it moved (2 rows instead of 34 per save). Undefined with no usable checksum,
	 * which `bumpGeneration()` marks eagerly.
	 */
	pageStaleness(
		path: string,
		row: { stale_at?: number | null; tags?: unknown; tag_checksum?: number | null }
	): number | undefined {
		if (typeof row.stale_at === 'number') return row.stale_at;
		const stored = typeof row.tag_checksum === 'number' ? row.tag_checksum : undefined;
		if (stored === undefined) return undefined;
		const tags = readTagList(row.tags);
		if (!tags || tags.length === 0) return undefined;
		if (tagChecksum(this.sql, tags) === stored) return undefined;
		const now = this.nowMs();
		// the one write, taken at the transition rather than at the save
		this.sql.exec(
			'UPDATE cfw_page SET stale_at = ? WHERE path = ? AND stale_at IS NULL',
			now,
			path
		);
		return now;
	}

	serveFromStorage(url: URL): Response | undefined {
		return serveFromStorage(this, url);
	}

	/**
	 * Overlays every KV lever override onto this object's env.
	 *
	 * `withSettings()` only covers the front worker's env; the object gets its own bindings.
	 * Awaited here and never in `fetch()` (the fast lane stays await-free and reads no lever), and
	 * called from `alarm()` too, which never passes through `handle()`.
	 */
	async adoptSettings(): Promise<void> {
		const kv = (this.env as { CONFIG_KV?: PlanKv } | undefined)?.CONFIG_KV;
		if (!kv) return;
		const settings = await resolveSettings(kv, Date.now(), this.siteName());
		// spread once, not per name (one allocation instead of eleven on the gated lane)
		const overrides: Record<string, string> = {};
		for (const name of KV_OVERRIDABLE) {
			const value = settings[name];
			if (value !== undefined) overrides[name] = value;
		}
		// which names came from KV, so `cfwSettings` can report a source without a second read
		this.kvLeverNames = new Set(Object.keys(overrides));
		if (Object.keys(overrides).length > 0) this.env = { ...this.env, ...overrides };
	}

	/** adopts KV levers, learns the site name, then dispatches to the route table */
	override async handle(request: Request, url: URL): Promise<Response> {
		await this.adoptSettings();
		// learned once from the name the front worker resolved (the alarm chain, where the R2
		// mirror needs it, has no request)
		this.siteName(url.searchParams.get('site') ?? undefined);
		this.invalidateOnCoreUpgrade();
		const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined;
		if (!route) return super.handle(request, url);
		return route(this, request, url);
	}
}
