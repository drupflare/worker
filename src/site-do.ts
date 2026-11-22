import '@drupflare/cartridge/shim';
import {
	SiteDurableObject,
	bindable,
	toPositional,
	type ExecSqlResult,
	type ExecTxnResult,
	type SqlBindings,
	type TxnRequest
} from '@drupflare/durabledb/do-sqlite';
import type { FileBuckets, MirrorBucket } from './db/file-store';
import { type HandleIndex } from './db/heap-store';
import { SqlMigrator, readMigrateCursor, type MigrateCursor } from './db/migrate-sql';
import { repairWideIntegers, type Row as WideRow } from './db/wide-integers';
import { markSchemaHook, type MarkState } from './db/write-mark';
import {
	countingSql,
	countingStorage,
	readSourceTables,
	writeTargetTable,
	type WriteTally
} from './db/write-tally';
import { HeapRestoreIncomplete, type AlarmClass, type HeapRestoreCursor } from './do/alarm';
import { alarmEntry } from './do/alarm-body';
import { installCapabilities } from './do/capabilities';
import { fetchRequest } from './do/fetch';
import {
	chargeR2,
	fileBuckets,
	fileSchemes,
	fileStoreR2,
	hydrateForRequest,
	mirrorBucket,
	publicFilesOrigin,
	r2Allowance,
	trustedFileSources
} from './do/file-offload';
import { deriveStep, fillOne, strikeFillHead } from './do/fill';
import {
	aggregateIndex,
	appendDeferred,
	countOrNull,
	enqueueRefill,
	herdKeyFor,
	isUnstorable,
	markAttempt,
	noteStorable,
	pageStaleness,
	queueDepth,
	queueDerivatives,
	shouldRunGc,
	unstorablePaths
} from './do/fill-queue';
import { fleetHealth, reportToFleet } from './do/fleet';
import {
	gitGet,
	gitPoll,
	gitPulls,
	gitRefs,
	gitSmart,
	gitSync,
	gitWriteStatus,
	handleGit
} from './do/git';
import {
	gitCredential,
	gitOwners,
	gitPollStates,
	gitRemotes,
	gitSaveRemotes,
	gitStoredFiles
} from './do/git-remotes';
import {
	advisoryVerdict,
	healthObservation,
	medianRenderBytes,
	noteRenderBytes,
	observe,
	supervise
} from './do/health';
import {
	corruptStoredChunk,
	handleIndex,
	heapBytes,
	pinHandles,
	snapshotHeap,
	snapshotStep,
	tryRestoreHeap
} from './do/heap-image';
import { cacheTagsIn } from './do/helpers';
import type {
	AggregateMemo,
	FileOffloadState,
	PoolState,
	PurgeState,
	ReconcileMemo,
	SiteStore,
	SteppedJobState
} from './do/host';
import {
	canonicalOrigin,
	cfCredentials,
	cfCredentialsSync,
	oidcConfig,
	oidcProvider,
	siteName
} from './do/identity';
import { bumpGeneration, pathsForTags, purgeForTags } from './do/invalidate';
import { keepSpareMemory } from './do/isolate';
import { HEAP_IMAGE_ATTEMPTS_KEY } from './do/keys';
import {
	applyRestoreChunk,
	awaitingCopy,
	catchUpOnce,
	clearRestore,
	collectForward,
	copyBackoffMs,
	flushForward,
	laneIsIdle,
	requestReadmission,
	sessionReach
} from './do/lane';
import { type SiteMountInfo } from './do/lazy-mount';
import { argon2Enabled, memoryCacheBins, memoryCacheMaxItems, phpStringList } from './do/levers';
import { CACHETAG_WRITE, FILL_BINS, SESSION_CATCHUP_MS } from './do/limits';
import { mailEnv, sendMailTest } from './do/mail-setup';
import {
	activityToday,
	carriedServeTotal,
	coldEncounterRate,
	countActivity,
	dailyDoRequests,
	dailyKvWrites,
	dailyRows,
	degradation,
	flushDailyRows,
	flushEncounters,
	flushMeters,
	flushServeRequests,
	serveRequests,
	shouldFlushMeters,
	storedMeters
} from './do/meters';
import {
	hasMigrationManifest,
	migrateCursorOrNull,
	migratePartial,
	migrator,
	neverMigrated,
	provisionRequested,
	requestProvision
} from './do/migration-state';
import { modifyBadBody, readModifyBody } from './do/modify';
import type { MysqlBridge } from './do/mysql-bridge';
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
	dropCompiledContainer,
	handleModify,
	installPackage,
	installTree,
	installableVerdict,
	packageAutoloads,
	registerPackageAutoload
} from './do/packages';
import {
	clearPendingTags,
	drainPendingTags,
	flushTagPurge,
	notePendingTags,
	pendingTags,
	settlePendingIfOwed
} from './do/pending-tags';
import { bootPhp, type PhpStatic } from './do/php-boot';
import {
	autoScaleStep,
	dequeueLaneRepair,
	enqueueLaneRepair,
	laneHeaders,
	laneRepairQueue,
	lanesProvisioned,
	noteLaneServing,
	provisionLane
} from './do/pool';
import {
	ensureServeTables,
	migrateChunks,
	migrateStepIfPending,
	prefillServingTable
} from './do/provision';
import {
	purgeAfterApply,
	purgeDynamicPageCache,
	purgePlansFor,
	settlePlans,
	stalePlans
} from './do/purge';
import {
	applyReconcileStep,
	cronHooksForSite,
	enabledModulesFingerprint,
	invalidateOnCoreUpgrade,
	loadPackedContainer,
	reconcileHost,
	reconcileSkipReason,
	reconcileState,
	reconcileStatus,
	reconcileStepOnce,
	sweepBeat,
	updbAction
} from './do/reconcile';
import {
	containerMissing,
	dropInterpreter,
	heapNow,
	isolateNow,
	oversized,
	recycleAfterUpload,
	recycleForOwner,
	recycleIfOversized
} from './do/recycle';
import {
	advanceCommit,
	bufferForReplication,
	commitSeq,
	copyableGeneration,
	ensureReplicationLog,
	flushCommitSeq,
	hasTable,
	noteAuthoritativeWrite,
	replicationRecords,
	sealGeneration,
	snapshotRows,
	tableDdl,
	tableNames
} from './do/replication';
import { forgetRetained, resetPhp, retainInterpreter, retire, traceMemory } from './do/retention';
import {
	fenceRefusal,
	idPartition,
	isPoolLane,
	isReplica,
	logStore,
	mandatoryGap,
	replicaStage,
	setReplicaStage
} from './do/role';
import { ROUTES } from './do/routes/index';
import { backgroundHold, run, runJson, settleReply } from './do/run';
import { adoptOwnerToken, adoptSecrets, readSecret, secretStore, writeSecret } from './do/secrets';
import { pageResponse, replicaHandoff, serveFromStorage } from './do/serve';
import { assembleFor, harvestShellFor, seedShellFrom, shellCandidates } from './do/shell';
import { noteDemand, noteError, noteRangeError, serveStatsSync } from './do/stats';
import {
	opsJobActive,
	opsJobBeat,
	opsJobStep,
	updbBeat,
	updbDeps,
	updbStepOnce
} from './do/stepped-jobs';
import type {
	ErrorNote,
	FillOutcome,
	ForwardOutcome,
	LaneRowsCap,
	OpsJob,
	PageRow,
	Payload,
	Row,
	SharedRender,
	ShellAssembly,
	SiteBinary
} from './do/types';
import {
	estimateRenderMs,
	flushRenderWindow,
	inlineBudgetMs,
	storedRenderWindow,
	thermalRearmMs,
	warmCeiling
} from './do/warming';
import type { RenderRequest } from './drupal/site-php';
import type { SiteEnv } from './env';
import { type AdvisoryVerdict } from './ops/advisories';
import { type AggregateIndex } from './ops/aggregates';
import { type AuthSpend } from './ops/auth-budget';
import type { CacheTier } from './ops/cache-tiers';
import {
	ZERO_ENCOUNTERS,
	encounterReport,
	recordEncounter,
	type EncounterCounts
} from './ops/cold-encounter';
import { type InvalidationResult } from './ops/core-version';
import { type CrossingTally } from './ops/crossings';
import { type DayMeters } from './ops/day-meters';
import { type Degradation } from './ops/degrade';
import { deploymentEnv, deploymentEnvPhp } from './ops/deployment-env';
import { type RangeReport } from './ops/error-probe';
import { type FleetRow } from './ops/fleet';
import {
	type BuildState,
	type Credential,
	type PullRequest,
	type Remote
} from './ops/git-provider';
import { type Advertisement, type SmartRemote } from './ops/git-smart';
import { type PollState } from './ops/git-sync';
import { type HeapIntegrityStats } from './ops/heap-integrity';
import { type MailEnv } from './ops/mail';
import { type IntegrityStats } from './ops/module-integrity';
import type { OidcConfig, OidcProvider } from './ops/oidc';
import { type OracleResult } from './ops/oracle';
import { outboundGuardEnabled, refuseOutbound } from './ops/outbound-guard';
import {
	autoloadPhp,
	type AutoloadDeclaration,
	type PackageAutoload,
	type Registry
} from './ops/package-install';
import { type PackedContainer } from './ops/packed-container';
import { type ParkInstall } from './ops/park';
import type { SleepBudget } from './ops/park-drive';
import { ParkSockets } from './ops/park-drive';
import { KV_OVERRIDABLE, resolveSettings, type PlanKv } from './ops/plan';
import { type LimitTally } from './ops/platform-limits';
import {
	reconcileReport,
	recordStep,
	type ReconcileHost,
	type ReconcileState
} from './ops/reconcile';
import { type DeriveTransport } from './ops/render-lane';
import { ReplicaRequiresPrimary, type ReadOnlyGuard } from './ops/replica';
import { type ReplicaStage } from './ops/replica-admission';
import {
	type ProvisionCursor,
	type ProvisionOutcome,
	type RestoreChunk
} from './ops/replica-restore';
import { type LogRecord, type LogStore } from './ops/replication-log';
import { SEALED_META_KEYS, readSealed, writeSealed, type SecretStore } from './ops/site-secrets';
import { SpoolStamps } from './ops/spool';
import { RingBuffer, type Finding, type Observation } from './ops/supervisor';
import { type SweepReport } from './ops/sweep';
import { type TcpResult } from './ops/tcp';
import { type Arrival, type RenderWindow, type WarmDecision } from './ops/thermal';
import type { UpdbDeps } from './ops/updb';
import { type ForwardStatement } from './ops/write-forwarding';
import type { TagStats } from './wordpress/tag-bridge';
// the `.js` is load-bearing: wrangler.jsonc aliases the specifier `./runtime/php-binary.js`, and
// without it esbuild resolves the default seam and bundles an 11 MB probe build over the ceiling
import { PHPFactory, wasmModule } from './runtime/php-binary.js';
import { isMissingTable } from './util/errors';
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
export interface PhpInstance {
	php: PhpStatic;
	binary: SiteBinary;
	out: string[];
	/**
	 * The MySQL bridge installed on `binary`, whose request-scoped state each run clears. A
	 * WordPress site's also ends a run, which judges the writes it made.
	 */
	mysql?: MysqlBridge & { endRun?(): void };
}

/**
 * One site: the interpreter and the database in the same isolate.
 *
 * `ctx.storage.sql` is synchronous only inside the Durable Object and PHP's PDO blocks, so PHP
 * must run here.
 */
export class SitePhpDurableObject extends SiteDurableObject implements SiteStore {
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
	bootLinear = 0;
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
			forgetRetained(this.ctx.id.toString(), was);
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
	/** what the last boot decided about the published boot image, and what the restore did */
	bootImage?: Payload;
	/** the heap at the restore point, kept only by a bake rig so a capture can take the delta */
	bootImageBaseline?: Uint8Array;
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
	/** what the installed-file integrity check has seen; shown by `/serve-stats` */
	moduleIntegrity?: IntegrityStats;
	/** what the heap image integrity check has seen; shown by `/__serve-stats` */
	heapIntegrity?: HeapIntegrityStats;
	/** tag to the cursor of its last change, for spool's sync; memory only */
	spoolStamps?: SpoolStamps;
	/** whether this invocation already bumped the generation */
	bumpCoalesced?: boolean;
	/** every cache tag invalidated this invocation (the bump is coalesced; the tag set is not) */
	invalidatedTags: Set<string> = new Set();
	/** the plan staleness flag the purge helpers read and write through the instance */
	purge: PurgeState = {};
	/** the last scoped plan purge, so an invalidation that removed nothing is still visible */
	lastPlanPurge?: { purged: number; tags: number };

	/** what the last tag-scoped purge did, reported at `/serve-stats` so the 11x is observable */
	lastScopedPurge?: { scoped: boolean; tags: number; purged: number; requeued?: number };

	/** what WordPress's tag emitter has asked for, including the purges the host raised itself */
	wordpressTags?: TagStats;

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

	/** cold boots not yet folded into the persisted window */
	coldsSinceFlush?: number;

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

	/** the idle re-arm last chosen, with why and the idle time behind it; in memory */
	lastRearm?: { ms: number; reason: string; idleForMs: number | null };

	/** when a render last began in this incarnation; the exact half of the idle clock */
	lastRenderAtMs?: number;

	/** what the last asset aggregation removed from a stored page, so 5,400 bytes/row has an n */
	lastAggregation?: {
		path: string;
		libraries: number;
		tagsRemoved: number;
		bytesSaved: number;
		skipped?: 'not-cacheable' | 'no-index' | 'no-match';
	};

	/** the aggregate manifest memo that {@link aggregateIndex} fills once per incarnation */
	aggregates: AggregateMemo = { read: false };

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
		reason: 'request' | 'alarm' | 'upload' | 'owner';
		rebuild?: boolean;
	};
	/**
	 * Set when this interpreter's first kernel boot has no container row and so rebuilds it.
	 *
	 * The rebuild's garbage is invisible to the memory estimate, so the next invocation can be
	 * reset; the interpreter is dropped at the end of that invocation regardless of thresholds.
	 */
	rebuildBoot = false;
	/** set by a request carrying a file, cleared when the interpreter drops after it */
	uploadSeen = false;
	/** drops taken because the VM trapped, which is a fault rather than a size; see {@link run} */
	trappedRuns?: number;
	/** the last VM trap */
	lastTrap?: { at: number; message: string };
	/** drops taken because a run ended in `exit()`; see {@link settleReply} */
	exitedRuns?: number;
	/** the last run that ended in `exit()`, with the first bytes it printed */
	lastExit?: { at: number; partial: string };
	/** what the last `_run()` returned: 0 for a normal end or an exit, 1 or 2 for a fatal */
	lastRet?: number;
	/** consecutive failing batches, for the capped backoff; reset by any batch that progressed */
	consecutiveFillFailures?: number;
	/** the class of the last alarm outcome */
	lastAlarmClass?: AlarmClass;
	/** per-table rows-written tally; only allocated when /__writes turns it on */
	writeTally?: WriteTally;
	/** whether an accepted-write mark exists; unknown until the first table-level statement */
	markState: MarkState = {};
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

	countActivity(kind: 'renders' | 'alarms' | 'fetches', n = 1): void {
		return countActivity(this, kind, n);
	}

	activityToday(nowMs = this.nowMs()): { renders: number; alarms: number; fetches: number } {
		return activityToday(this, nowMs);
	}
	/**
	 * When the alarm this object last set is due, in memory only.
	 *
	 * `armFillAlarm()` compares against it so a burst costs one charged row; a hibernation costs
	 * one extra arm.
	 */
	alarmDueMs?: number;

	/** events (requests and alarms) running now; an arm inside one waits for the last of them */
	armHolds = 0;

	/** the soonest alarm an arm asked for while an event held arming */
	armHeldAtMs?: number;

	/** set by `retire()`; this incarnation then answers 410 and arms nothing */
	retired?: boolean;

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
	/** settles once a legacy plaintext owner token has been moved into sealed storage */
	ownerAdoption: Promise<void>;
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
		this.sql = countingSql(
			this.sql,
			() => this.writeTally,
			charge,
			markSchemaHook(() => this.sql, this.markState)
		);
		// the KV half of the same meter: `setAlarm` alone is 360 rows/day on an idle site
		this.storage = countingStorage(this.ctx.storage, () => this.writeTally, charge);
		this.limitTally = {};
		this.ownerAdoption = adoptOwnerToken(this);
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
		this.bootInFlight = bootPhp(this, opts, {
			factory: PHPFactory,
			module: wasmModule as WebAssembly.Module
		}).finally(() => {
			this.bootInFlight = undefined;
		});
		return this.bootInFlight;
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

	awaitingCopy(): boolean {
		return awaitingCopy(this);
	}

	copyBackoffMs(): number {
		return copyBackoffMs(this);
	}

	advisoryVerdict(): AdvisoryVerdict & { fresh: boolean; ageS: number } {
		return advisoryVerdict(this);
	}

	laneRepairQueue(): number[] {
		return laneRepairQueue(this);
	}

	enqueueLaneRepair(lane: number): number[] {
		return enqueueLaneRepair(this, lane);
	}

	dequeueLaneRepair(lane: number): number[] {
		return dequeueLaneRepair(this, lane);
	}

	async requestReadmission(): Promise<{ asked: boolean; reason: string; stage: ReplicaStage }> {
		return requestReadmission(this);
	}

	laneIsIdle(): boolean {
		return laneIsIdle(this);
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

	async aggregateIndex(): Promise<AggregateIndex | undefined> {
		return aggregateIndex(this);
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

	/** the settings override's inputs other than the origin, which the boot image keys on */
	bootSettings() {
		const partition = this.idPartition();
		return {
			argon2: argon2Enabled(this.env),
			memoryBins: phpStringList(memoryCacheBins(this.env)),
			memoryItems: memoryCacheMaxItems(this.env),
			lane: partition.lane,
			lanes: partition.lanes,
			packageAutoload: autoloadPhp(this.packageAutoloads()),
			deploymentEnv: deploymentEnvPhp(deploymentEnv(this.env))
		};
	}

	/** how many times this object has tried to image `generation`; a new one starts at zero */
	imageAttempts(generation: string): number {
		const raw = this.metaGet(HEAP_IMAGE_ATTEMPTS_KEY) ?? '';
		const at = raw.lastIndexOf(' ');
		if (at < 0 || raw.slice(0, at) !== generation) return 0;
		const n = Number(raw.slice(at + 1));
		return Number.isFinite(n) ? n : 3;
	}

	heapBytes(binary: SiteBinary): Uint8Array | undefined {
		return heapBytes(binary);
	}

	pinHandles(binary: SiteBinary): number {
		return pinHandles(this, binary);
	}

	handleIndex(binary: SiteBinary): HandleIndex | undefined {
		return handleIndex(binary);
	}

	async snapshotHeap(opts?: { chunkBytes?: number }): Promise<Payload> {
		return snapshotHeap(this, opts);
	}

	async snapshotStep(): Promise<Payload | undefined> {
		return snapshotStep(this);
	}

	reconcileHost(): ReconcileHost {
		return reconcileHost(this);
	}

	/** the pack's container row, loaded once an instance has reconciliation to do */
	packedContainer?: PackedContainer;

	async loadPackedContainer(): Promise<void> {
		return loadPackedContainer(this);
	}

	reconcileState(): ReconcileState {
		return reconcileState(this);
	}

	reconcileStatus(): ReturnType<typeof reconcileReport> {
		return reconcileStatus(this);
	}

	reconcileSkipReason(): string {
		return reconcileSkipReason(this);
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

	gitRemotes(): Remote[] {
		return gitRemotes(this);
	}

	gitSaveRemotes(remotes: readonly Remote[]): void {
		return gitSaveRemotes(this, remotes);
	}

	gitCredential(id: string): Credential {
		return gitCredential(this, id);
	}

	gitSmart(remote: Remote): SmartRemote {
		return gitSmart(this, remote);
	}

	async gitGet(
		remote: Remote,
		url: string
	): Promise<{ ok: boolean; body: unknown; status: number }> {
		return gitGet(this, remote, url);
	}

	gitStoredFiles(id: string): Map<string, string> {
		return gitStoredFiles(this, id);
	}

	gitOwners(): Map<string, string> {
		return gitOwners(this);
	}

	async gitRefs(remote: Remote): Promise<Advertisement> {
		return gitRefs(this, remote);
	}

	async gitWriteStatus(
		remote: Remote,
		sha: string,
		state: BuildState,
		description: string,
		targetUrl: string
	): Promise<boolean> {
		return gitWriteStatus(this, remote, sha, state, description, targetUrl);
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

	registerPackageAutoload(
		pkg: AutoloadDeclaration,
		files: readonly { path: string; source: string }[]
	): void {
		return registerPackageAutoload(this, pkg, files);
	}

	async readModifyBody(request: Request): Promise<unknown> {
		return readModifyBody(request);
	}

	modifyBadBody(): Response {
		return modifyBadBody();
	}

	dropCompiledContainer(): void {
		return dropCompiledContainer(this);
	}

	gitPollStates(remotes: readonly Remote[]): PollState[] {
		return gitPollStates(this, remotes);
	}

	async gitPoll(limit?: number): Promise<Record<string, unknown>[]> {
		return gitPoll(this, limit);
	}

	async gitPulls(remote: Remote): Promise<PullRequest[]> {
		return gitPulls(this, remote);
	}

	async handleGit(url: URL, deliverBase?: string): Promise<Response> {
		return handleGit(this, url, deliverBase);
	}

	ensureServeTables(): void {
		return ensureServeTables(this);
	}

	flushDailyRows(nowMs = this.nowMs()): number {
		return flushDailyRows(this, nowMs);
	}

	storedMeters(nowMs = this.nowMs()): DayMeters {
		return storedMeters(this, nowMs);
	}

	flushMeters(nowMs?: number): DayMeters {
		return flushMeters(this, nowMs);
	}

	carriedServeTotal(): number {
		return carriedServeTotal(this);
	}

	storedRenderWindow(): RenderWindow | undefined {
		return storedRenderWindow(this);
	}

	warmCeiling(): number {
		return warmCeiling(this);
	}

	flushRenderWindow(nowMs = this.nowMs()): RenderWindow | undefined {
		return flushRenderWindow(this, nowMs);
	}

	shouldFlushMeters(nowMs = this.nowMs()): boolean {
		return shouldFlushMeters(this, nowMs);
	}

	flushServeRequests(): number {
		return flushServeRequests(this);
	}

	serveRequests(): number {
		return serveRequests(this);
	}

	dailyRows(nowMs = this.nowMs()): number {
		return dailyRows(this, nowMs);
	}

	flushEncounters(nowMs = this.nowMs()): EncounterCounts {
		return flushEncounters(this, nowMs);
	}

	coldEncounterRate(nowMs = this.nowMs()): {
		today: ReturnType<typeof encounterReport>;
		incarnation: ReturnType<typeof encounterReport>;
	} {
		return coldEncounterRate(this, nowMs);
	}

	/** in memory only: an object evicted mid-upgrade must re-check; the comparison is idempotent */
	reconcileMemo: ReconcileMemo = { coreVersionChecked: false };

	invalidateOnCoreUpgrade(): InvalidationResult | undefined {
		return invalidateOnCoreUpgrade(this);
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
		stability?: string,
		ignoreCore?: boolean
	): Promise<Record<string, unknown>[]> {
		return installTree(this, registry, name, constraint, budget, stability, ignoreCore);
	}

	async installPackage(
		registry: Registry,
		name: string,
		constraint?: string,
		stability?: string,
		ignoreCore?: boolean
	): Promise<Record<string, unknown>> {
		return installPackage(this, registry, name, constraint, stability, ignoreCore);
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

	degradation(nowMs = this.nowMs()): Degradation {
		return degradation(this, nowMs);
	}

	dailyDoRequests(nowMs = this.nowMs()): number {
		return dailyDoRequests(this, nowMs);
	}

	fleetHealth(): FleetRow['health'] {
		return fleetHealth(this);
	}

	async reportToFleet(): Promise<void> {
		return reportToFleet(this);
	}

	observe(outcomes: (Payload | undefined)[]): Observation {
		return observe(this, outcomes);
	}

	healthObservation(): Record<string, unknown> {
		return healthObservation(this);
	}

	medianRenderBytes(path: string): number | undefined {
		return medianRenderBytes(this, path);
	}

	noteRenderBytes(path: string, bytes: number): void {
		return noteRenderBytes(this, path, bytes);
	}

	supervise(outcomes: (Payload | undefined)[]): Finding[] {
		return supervise(this, outcomes);
	}

	secretStore(): SecretStore {
		return secretStore(this);
	}

	readSecret(key: string): string | null {
		return readSecret(this, key);
	}

	writeSecret(key: string, value: string): void {
		writeSecret(this, key, value);
	}

	async adoptSecrets(): Promise<void> {
		return adoptSecrets(this);
	}

	async sendMailTest(to: string): Promise<Payload> {
		return sendMailTest(this, to);
	}

	mailEnv(): MailEnv {
		return mailEnv(this);
	}

	oidcConfig(origin: string): { config: OidcConfig } | { refusal: string } {
		return oidcConfig(this, origin);
	}

	async oidcProvider(issuer: string): Promise<{ provider: OidcProvider } | { refusal: string }> {
		return oidcProvider(issuer);
	}

	/**
	 * Reads a `cfw_meta` value, or `fallback` when the key is absent.
	 *
	 * A key in {@link SEALED_META_KEYS} is read from sealed storage; a row left from before the move
	 * is adopted on the first read that misses it.
	 */
	metaGet(key: string, fallback: string | null = null): string | null {
		if (SEALED_META_KEYS.has(key)) {
			const sealed = this.storage.kv.get<string>(key);
			return sealed ?? readSealed(this.secretStore(), key) ?? fallback;
		}
		return this.metaRowGet(key, fallback);
	}

	/** reads the `cfw_meta` row itself, whatever the key */
	metaRowGet(key: string, fallback: string | null = null): string | null {
		this.ensureServeTables();
		const row = firstRow(
			this.sql.exec<Row<{ v: string }>>('SELECT v FROM cfw_meta WHERE k = ?', key)
		);
		return row === undefined ? fallback : String(row.v);
	}

	/**
	 * Writes a `cfw_meta` value, skipping one that is already there. A key in
	 * {@link SEALED_META_KEYS} goes to sealed storage and leaves no row.
	 */
	metaSet(key: string, value: unknown): void {
		if (SEALED_META_KEYS.has(key)) {
			const next = String(value);
			if (this.metaGet(key) === next) this.elidedWrites = (this.elidedWrites ?? 0) + 1;
			else writeSealed(this.secretStore(), key, next);
			return;
		}
		this.metaRowSet(key, value);
	}

	/**
	 * Writes the `cfw_meta` row, skipping one that is already there.
	 *
	 * One read to save one write: free allows 5,000,000 rows read against 100,000 written, and a
	 * write of the existing value is charged in full. `elidedWrites` counts the skips.
	 */
	metaRowSet(key: string, value: unknown): void {
		this.ensureServeTables();
		const next = String(value);
		if (this.metaRowGet(key) === next) {
			this.elidedWrites = (this.elidedWrites ?? 0) + 1;
			return;
		}
		this.sql.exec(
			'INSERT INTO cfw_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
			key,
			next
		);
	}

	async cfCredentials(): Promise<{ token: string; accountId: string }> {
		return cfCredentials(this);
	}

	cfCredentialsSync(): { token: string; accountId: string } {
		return cfCredentialsSync(this);
	}

	setReplicaStage(next: ReplicaStage): { stage: ReplicaStage; moved: boolean; reason: string } {
		return setReplicaStage(this, next);
	}

	replicaStage(): ReplicaStage {
		return replicaStage(this);
	}

	/** the waiting allowance of the invocation in progress; see `sleepBudgetMs()` */
	sleepBudget?: SleepBudget;

	traceMemory(at: string): void {
		traceMemory(this, at);
	}

	/** whether this incarnation has already made sure the deployment document lists it */
	deploymentChecked = false;

	isReplica(): boolean {
		return isReplica(this);
	}

	isPoolLane(): boolean {
		return isPoolLane(this);
	}

	fenceRefusal(request: Request): { refuse: boolean; required: number; applied: number } {
		return fenceRefusal(this, request);
	}

	logStore(): LogStore {
		return logStore(this);
	}

	mandatoryGap(): string[] {
		return mandatoryGap(this);
	}

	async provisionLane(
		lane: number,
		cursor: ProvisionCursor | undefined,
		budget?: number
	): Promise<ProvisionOutcome> {
		return provisionLane(this, lane, cursor, budget);
	}

	noteLaneServing(lane: number): void {
		return noteLaneServing(this, lane);
	}

	/** set when one more lane would project the day's rows past the reduce fraction */
	laneRowsCap?: LaneRowsCap;

	/** the last `CONFIG_KV` write of the pool, awaited only by tests */
	lanesPublished?: Promise<unknown>;

	/** the pool epoch memo the pool helpers read and write */
	pool: PoolState = {};

	/** the pool size read once per incarnation; only `noteLaneServing()` moves it */
	lanesMemo?: number;

	laneHeaders(): Record<string, string> {
		return laneHeaders(this);
	}

	lanesProvisioned(): number {
		return lanesProvisioned(this);
	}

	async sessionReach(cookie: string): Promise<'held' | 'absent' | 'unknown'> {
		return sessionReach(this, cookie);
	}

	hasTable(table: string): boolean {
		return hasTable(this, table);
	}

	tableDdl(table: string): string[] {
		return tableDdl(this, table);
	}

	tableNames(): string[] {
		return tableNames(this);
	}

	snapshotRows(
		table: string,
		offset: number,
		limit: number
	): { columns: string[]; rows: unknown[][] } {
		return snapshotRows(this, table, offset, limit);
	}

	idPartition(): { lane: number; lanes: number } {
		return idPartition(this);
	}

	collectForward(statements: readonly string[], payload: unknown): void {
		return collectForward(this, statements, payload);
	}

	async flushForward(): Promise<ForwardOutcome | undefined> {
		return flushForward(this);
	}

	flushTagPurge(): string[] {
		return flushTagPurge(this);
	}

	/** the stored paths that depend on any of `tags` */
	pathsForTags(tags: readonly string[]): string[] | undefined {
		return pathsForTags(this, tags);
	}

	notePendingTags(tags: readonly string[]): void {
		notePendingTags(this, tags);
	}

	pendingTags(): string[] {
		return pendingTags(this);
	}

	clearPendingTags(): void {
		clearPendingTags(this);
	}

	settlePendingIfOwed(): void {
		settlePendingIfOwed(this);
	}

	drainPendingTags(): { tags: number; purged: number } | undefined {
		return drainPendingTags(this);
	}

	clearRestore(): void {
		clearRestore(this);
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

	canonicalOrigin(observed?: string): string {
		return canonicalOrigin(this, observed);
	}

	siteName(observed?: string): string {
		return siteName(this, observed);
	}

	/** the version vector spool syncs from, created on first use at this generation; memory only */
	spoolVector(): SpoolStamps {
		return (this.spoolStamps ??= new SpoolStamps(this.generation()));
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

	purgePlansFor(tags?: string[]): number {
		return purgePlansFor(this, tags);
	}

	stalePlans(): void {
		return stalePlans(this);
	}

	settlePlans(tags: readonly string[]): { purged: number; cleared: boolean } {
		return settlePlans(this, tags);
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

	purgeDynamicPageCache(): number {
		return purgeDynamicPageCache(this);
	}

	purgeAfterApply(): { pages: number; shells: number; plans: number; dynamic: number } {
		return purgeAfterApply(this);
	}

	enqueueRefill(path: string): void {
		return enqueueRefill(this, path);
	}

	/**
	 * Sets an alarm and remembers when it is due, so `armFillAlarm()` never believes a +1 ms alarm
	 * survived a 240 s re-arm.
	 */
	async setAlarmAt(atMs: number): Promise<void> {
		if (this.retired) return;
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
		if (this.retired) return;
		const at = this.nowMs() + Math.max(1, delayMs);
		if (this.alarmDueMs !== undefined && this.alarmDueMs <= at) return;
		if (this.armHolds > 0) {
			if (this.armHeldAtMs === undefined || at < this.armHeldAtMs) this.armHeldAtMs = at;
			return;
		}
		this.setAlarmQuiet(at);
	}

	private setAlarmQuiet(at: number): void {
		try {
			this.alarmDueMs = at;
			const armed = this.storage.setAlarm(at);
			if (armed && typeof armed.catch === 'function') armed.catch(() => {});
		} catch {
			/* an unschedulable alarm must not fail the save that triggered it */
		}
	}

	/** starts an event whose `armFillAlarm()` calls wait for `releaseArming()` */
	holdArming(): void {
		this.armHolds += 1;
	}

	/**
	 * Ends one event; the last one out sets the alarm the event asked for.
	 *
	 * A +1 ms `setAlarm()` armed ahead of an await, on an event with thousands of unconfirmed
	 * writes, reset a bare object in 5 of 142 requests against 0 of 175 for the same awaits without
	 * it (suggestive, p about 0.02). The install route's note records the same shape. Arming after
	 * the event's last await keeps the alarm and avoids that shape.
	 */
	releaseArming(): void {
		this.armHolds = Math.max(0, this.armHolds - 1);
		if (this.armHolds > 0 || this.armHeldAtMs === undefined || this.retired) return;
		const at = this.armHeldAtMs;
		this.armHeldAtMs = undefined;
		if (this.alarmDueMs !== undefined && this.alarmDueMs <= at) return;
		this.setAlarmQuiet(at);
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
			if (!this.speculating) noteAuthoritativeWrite(this, sql, params);
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
				this.spoolVector().stamp(written, this.generation());
			}
		}
		return result;
	}

	bufferForReplication(sql: string, params?: SqlBindings): void {
		return bufferForReplication(this, sql, params);
	}

	async sealGeneration(): Promise<{ generation: number; statements: number } | undefined> {
		return sealGeneration(this);
	}

	ensureReplicationLog(): void {
		return ensureReplicationLog(this);
	}

	copyableGeneration(): number {
		return copyableGeneration(this);
	}

	/** sealed log records after generation `since` */
	replicationRecords(since: number, limit?: number): LogRecord[] {
		return replicationRecords(this, since, limit);
	}

	advanceCommit(): number {
		return advanceCommit(this);
	}

	commitSeq(): number {
		return commitSeq(this);
	}

	flushCommitSeq(): void {
		return flushCommitSeq(this);
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

	inlineBudgetMs(url: URL): number {
		return inlineBudgetMs(this, url);
	}

	estimateRenderMs(): number {
		return estimateRenderMs(this);
	}

	pageResponse(
		row: PageRow,
		tier: CacheTier,
		serveMs: number,
		extra?: Record<string, string>
	): Response {
		return pageResponse(this, row, tier, serveMs, extra);
	}

	queueDepth(): number {
		return queueDepth(this);
	}

	shouldRunGc(): boolean {
		return shouldRunGc(this);
	}

	countOrNull(table: string, where?: string): number | null {
		return countOrNull(this, table, where);
	}

	migrator(): SqlMigrator {
		return migrator(this);
	}

	migratePartial(): MigrateCursor | undefined {
		return migratePartial(this);
	}

	provisionRequested(): boolean {
		return provisionRequested(this);
	}

	async requestProvision(): Promise<void> {
		return requestProvision(this);
	}

	async hasMigrationManifest(): Promise<boolean> {
		return hasMigrationManifest(this);
	}

	neverMigrated(): boolean {
		return neverMigrated(this);
	}

	noteStorable(path: string, cacheable: boolean, refused: boolean, anonymous: boolean): void {
		return noteStorable(this, path, cacheable, refused, anonymous);
	}

	unstorablePaths(): string[] {
		return unstorablePaths(this);
	}

	isUnstorable(path: string): boolean {
		return isUnstorable(this, path);
	}

	thermalRearmMs(queued = false): number {
		return thermalRearmMs(this, queued);
	}

	publicFilesOrigin(): string {
		return publicFilesOrigin(this);
	}

	mirrorBucket(): MirrorBucket | undefined {
		return mirrorBucket(this);
	}

	/** the R2 offload memo the file helpers read and write through the instance */
	fileOffload: FileOffloadState = {};

	async trustedFileSources(): Promise<ReadonlySet<string>> {
		return trustedFileSources(this);
	}

	fileStoreR2(): boolean {
		return fileStoreR2(this);
	}

	fileBuckets(): FileBuckets {
		return fileBuckets(this);
	}

	fileSchemes(): readonly string[] {
		return fileSchemes(this);
	}

	async hydrateForRequest(url: URL): Promise<void> {
		return hydrateForRequest(this, url);
	}

	r2Allowance(): { month: string; used: number; budget: number; left: number } {
		return r2Allowance(this);
	}

	chargeR2(ops: number): void {
		return chargeR2(this, ops);
	}

	async updbStepOnce(): Promise<{ updb: Payload }> {
		return updbStepOnce(this);
	}

	/** the stepped-job read cache the stepped helpers read and write through the instance */
	steppedJobs: SteppedJobState = {};
	/** the last stepped-operation outcome */
	lastOpsJob?: Payload;

	opsJobActive(): boolean {
		return opsJobActive(this);
	}

	async opsJobStep(name: string, args: string[], options: OpsJob['options']): Promise<Payload> {
		return opsJobStep(this, name, args, options);
	}

	async opsJobBeat(): Promise<{ opsJob: Payload }> {
		return opsJobBeat(this);
	}

	updbDeps(): UpdbDeps {
		return updbDeps(this);
	}

	async updbAction(action: string, params: URLSearchParams): Promise<Payload> {
		return updbAction(this, action, params);
	}

	async updbBeat(gated: boolean): Promise<{ updb: Payload }> {
		return updbBeat(this, gated);
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

	migrateCursorOrNull(): MigrateCursor | null {
		return migrateCursorOrNull(this);
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

	override async alarm(info?: AlarmInvocationInfo): Promise<any> {
		return alarmEntry(this, info);
	}

	/** the attempt the next render belongs to; see `src/ops/attempt.ts` */
	pendingAttempt?: string;

	markAttempt(key: string): void {
		return markAttempt(this, key);
	}

	backgroundHold(): number | undefined {
		return backgroundHold(this);
	}

	async run(code: string): Promise<string> {
		return run(this, code);
	}

	async runJson(code: string): Promise<Payload> {
		return runJson(this, code);
	}

	async settleReply(reply: Payload): Promise<Payload> {
		return settleReply(this, reply);
	}

	/** the 421 sending the caller to the primary; `neverRan` marks an uncommitted forward */
	replicaHandoff(refusal: ReplicaRequiresPrimary, neverRan?: boolean): Response {
		return replicaHandoff(this, refusal, neverRan);
	}

	override async fetch(request: Request): Promise<Response> {
		return fetchRequest(this, request);
	}

	appendDeferred(statements: readonly ForwardStatement[]): number {
		return appendDeferred(this, statements);
	}

	queueDerivatives(uri: string): void {
		return queueDerivatives(this, uri);
	}

	async deriveStep(transport?: DeriveTransport): Promise<void> {
		return deriveStep(this, transport);
	}

	dailyKvWrites(nowMs = this.nowMs()): number {
		return dailyKvWrites(this, nowMs);
	}

	herdKeyFor(request: Request, url: URL): string | undefined {
		return herdKeyFor(this, request, url);
	}

	heapNow(): number {
		return heapNow(this);
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
	resetBridgeBytes(): void {
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

	isolateNow(): number {
		return isolateNow(this);
	}

	oversized(): boolean {
		return oversized(this);
	}

	dropInterpreter(): void {
		dropInterpreter(this);
	}

	resetPhp(): void {
		resetPhp(this);
	}

	async retire(): Promise<void> {
		return retire(this);
	}

	retainInterpreter(): void {
		retainInterpreter(this);
	}

	recycleIfOversized(reason: 'request' | 'alarm'): boolean {
		return recycleIfOversized(this, reason);
	}

	recycleForOwner(): boolean {
		return recycleForOwner(this);
	}

	containerMissing(): boolean {
		return containerMissing(this);
	}

	recycleAfterUpload(): void {
		recycleAfterUpload(this);
	}

	pageStaleness(
		path: string,
		row: { stale_at?: number | null; tags?: unknown; tag_checksum?: number | null }
	): number | undefined {
		return pageStaleness(this, path, row);
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
