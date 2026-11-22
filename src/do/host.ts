import type { Gate } from '@drupflare/cartridge/gate';
import type { SqlBindings } from '@drupflare/durabledb/do-sqlite';
import type { FileBuckets, MirrorBucket } from '../db/file-store';
import type { MigrateCursor, SqlMigrator } from '../db/migrate-sql';
import type { SiteEnv } from '../env';
import type { AggregateIndex } from '../ops/aggregates';
import type { EncounterCounts } from '../ops/cold-encounter';
import type { Degradation } from '../ops/degrade';
import type { PackedContainer } from '../ops/packed-container';
import type { ReconcileHost, ReconcileState } from '../ops/reconcile';
import type { ReplicaStage } from '../ops/replica-admission';
import type { ProvisionCursor, ProvisionOutcome } from '../ops/replica-restore';
import type { LogStore } from '../ops/replication-log';
import type { SecretStore } from '../ops/site-secrets';
import type { Arrival, WarmDecision } from '../ops/thermal';
import type { ForwardStatement } from '../ops/write-forwarding';
import type { SitePhpDurableObject } from '../site-do';
import type { Stamped } from '../util/types';
import type { SiteMountInfo } from './lazy-mount';
import type { LaneRowsCap, OpsJob, Payload, SiteBinary } from './types';

/** the primitives the object's helpers read through the host on every call */
export interface SiteStore {
	sql: SqlStorage;
	storage: DurableObjectStorage;
	env: SiteEnv;
	nowMs(): number;
	metaGet(key: string, fallback?: string | null): string | null;
	metaSet(key: string, value: unknown): void;
	noteError(where: string, e: unknown): void;
	ensureServeTables(): void;
}

/** the store plus the sealed credential read the git remote code needs */
export interface GitHost extends SiteStore {
	readSecret(key: string): string | null;
	/** the provider token the current `/git` call carried in its header; unset outside that call */
	gitCallToken?: string | undefined;
}

/** the store plus the sealed credential reads and writes and the replica check */
export interface IdentityHost extends SiteStore {
	readSecret(key: string): string | null;
	writeSecret(key: string, value: string): void;
	isReplica(): boolean;
}

/** the R2 offload memo the class holds */
export interface FileOffloadState {
	/** the last grant read from `CONFIG_KV`, reused briefly so a run of foreign reads costs one lookup */
	grant?: { at: number; sources: ReadonlySet<string> };
}

/** the store plus the offload memo and the instance methods the offload helpers call through */
export interface FileOffloadHost extends SiteStore {
	fileOffload: FileOffloadState;
	siteName(observed?: string): string;
	mirrorBucket(): MirrorBucket | undefined;
	fileStoreR2(): boolean;
	fileBuckets(): FileBuckets;
	fileSchemes(): readonly string[];
	trustedFileSources(): Promise<ReadonlySet<string>>;
	r2Allowance(): { month: string; used: number; budget: number; left: number };
}

/** the store plus the daily meter counters the meter helpers read and write */
export interface MeterHost extends SiteStore {
	rowsSinceFlush?: number;
	doRequestsSinceFlush?: number;
	kvGrantsSinceFlush?: number;
	activitySinceFlush?: { renders: number; alarms: number; fetches: number };
	serveRequestsPending?: number;
	lastMeterFlushMs?: number;
	carriedServe?: number;
	encounters: EncounterCounts;
}

/** the store plus the warm predictor state and the instance reads the warming helpers make */
export interface WarmingHost extends SiteStore {
	arrivals?: Arrival[];
	rendersSinceFlush?: number;
	coldsSinceFlush?: number;
	lastRenderWindowFlushMs?: number;
	lastAuthenticatedAt?: number;
	lastWarmDecision?: WarmDecision;
	lastRearm?: { ms: number; reason: string; idleForMs: number | null };
	lastRenderAtMs?: number;
	lastRenderMs?: number;
	readonly php: unknown;
	degradation(nowMs?: number): Degradation;
	hasTable(table: string): boolean;
	isPoolLane(): boolean;
	lanesProvisioned(): number;
	migratePartial(): MigrateCursor | undefined;
	opsJobActive(): boolean;
}

/** the store plus the invalidation state and the tag purge the pending-tag helpers settle through */
export interface PendingTagsHost extends SiteStore {
	invalidatedTags: Set<string>;
	lastScopedPurge?: { scoped: boolean; tags: number; purged: number; requeued?: number };
	pendingDrained?: boolean;
	lastPendingDrain?: { tags: number; purged: number };
	purgeForTags(
		tags: readonly string[],
		reason?: string,
		options?: { bump?: boolean | undefined }
	): { scoped: boolean; tags: number; purged: number; requeued?: number };
}

/** the plan staleness flag the purge helpers set at a write and settle at the end */
export interface PurgeState {
	/** whether this invocation has already flagged the plans; cleared by `settlePlans()` */
	plansStaled?: boolean;
}

/** the store plus the plan staleness flag the purge helpers read and write */
export interface PurgeHost extends SiteStore {
	purge: PurgeState;
}

/** the aggregate manifest memo the fill chain reads once per incarnation */
export interface AggregateMemo {
	/** the aggregate manifest, read once per incarnation (undefined once read: there is none) */
	index?: AggregateIndex;
	/** whether {@link aggregateIndex} has read the manifest, so an absent one is asked for once */
	read: boolean;
}

/** the store plus the fill alarm, generation, serve-table flag, GC pacing and aggregate memo */
export interface FillQueueHost extends SiteStore {
	armFillAlarm(delayMs?: number): void;
	generation(): number;
	serveTablesReady?: boolean;
	lastGcAt?: number;
	aggregates: AggregateMemo;
}

/** the store plus the replay driver, the migrated flag and the alarm the provisioning helpers arm */
export interface MigrationHost extends SiteStore {
	_migrator?: SqlMigrator;
	migrated: boolean;
	setAlarmAt(atMs: number): Promise<void>;
}

/** the stepped-job read cache the class holds */
export interface SteppedJobState {
	/** a stepped operation (`cim`, `queue-drain`) the alarm carries to the end; undefined unread */
	cache?: { job?: OpsJob };
}

/** the store plus the stepped-job cache, the PHP run, the gate and the last outcomes the stepped helpers write */
export interface SteppedHost extends SiteStore {
	steppedJobs: SteppedJobState;
	runJson(code: string): Promise<Payload>;
	gate: Gate;
	lastOpsJob?: Payload;
	lastUpdb?: Stamped<Payload>;
}

/** the store plus the per-path render sizes and the instance reads the health and fleet helpers make */
export interface HealthHost extends SiteStore {
	pageBytes: Map<string, number[]>;
	hasTable(table: string): boolean;
	installCapabilities(binary: SiteBinary): SiteBinary;
	packGeneration(): string | undefined;
	degradation(nowMs?: number): Degradation;
}

/** the store plus the lane identity, the commit sequence and the pool size the role helpers read */
export interface RoleHost extends SiteStore {
	ctx: DurableObjectState;
	commitSeq(): number;
	lanesProvisioned(): number;
	isReplica(): boolean;
	isPoolLane(): boolean;
}

/** the store plus the pending commit advances and the replication buffer the commit helpers write */
export interface ReplicationLogHost extends SiteStore {
	pendingCommits: number;
	bufferForReplication(sql: string, params?: SqlBindings): void;
}

/** the store plus the lane state, the replica stage and the role reads the lane helpers make */
export interface LaneHost extends SiteStore {
	ctx: DurableObjectState;
	php: unknown;
	forwardBuffer?: (ForwardStatement & { params: unknown[]; table: string })[];
	forwardParent?: number;
	lastWithdrawal?: unknown;
	lastSessionCatchUpAt?: number;
	sessionCatchUps?: { tried: number; found: number };
	inflightPeak?: number;
	doRequestsSinceFlush?: number;
	commitSeq(): number;
	hasTable(table: string): boolean;
	isPoolLane(): boolean;
	logStore(): LogStore;
	mandatoryGap(): string[];
	packGeneration(): string | undefined;
	purgeAfterApply(): { pages: number; shells: number; plans: number; dynamic: number };
	replicaStage(): ReplicaStage;
	setAlarmAt(atMs: number): Promise<void>;
	setReplicaStage(next: ReplicaStage): { stage: ReplicaStage; moved: boolean; reason: string };
}

/** the pool memo the class holds */
export interface PoolState {
	/** the lanes epoch read once per incarnation */
	epochMemo?: number;
}

/** the store plus the pool state, the lane counters and the instance reads the pool helpers make */
export interface PoolHost extends SiteStore {
	ctx: DurableObjectState;
	pool: PoolState;
	inflight?: number;
	inflightPeak?: number;
	laneTimings?: { ahead: number; queueMs: number; serviceMs: number }[];
	laneRowsCap?: LaneRowsCap;
	lanesMemo?: number;
	lanesPublished?: Promise<unknown>;
	dailyRows(nowMs?: number): number;
	isPoolLane(): boolean;
	lanesProvisioned(): number;
	laneRepairQueue(): number[];
	dequeueLaneRepair(lane: number): number[];
	mandatoryGap(): string[];
	noteLaneServing(lane: number): void;
	packGeneration(): string | undefined;
	canonicalOrigin(observed?: string): string;
	secretStore(): SecretStore;
	sealGeneration(): Promise<{ generation: number; statements: number } | undefined>;
	copyableGeneration(): number;
	tableNames(): string[];
	snapshotRows(
		table: string,
		offset: number,
		limit: number
	): { columns: string[]; rows: unknown[][] };
	tableDdl(table: string): string[];
	provisionLane(
		lane: number,
		cursor: ProvisionCursor | undefined,
		budget?: number
	): Promise<ProvisionOutcome>;
}

/** the store plus the meter row counter the autoload registration adds to */
export interface AutoloadHost extends SiteStore {
	rowsSinceFlush?: number;
}

/** the interpreter fields the recycle helpers read and drop */
export interface RecyclePhp {
	binary?: SiteBinary;
	mysql?: { endRun?(): void };
}

/** the store plus the interpreter, its drop record and the instance reads the recycle helpers make */
export interface RecycleHost extends SiteStore {
	php: RecyclePhp | undefined;
	rebuildBoot: boolean;
	uploadSeen: boolean;
	recycles?: number;
	lastRecycle?: {
		at: number;
		bytes: number;
		reason: 'request' | 'alarm' | 'upload' | 'owner';
		rebuild?: boolean;
	};
	bootLinear: number;
	mountInfo?: SiteMountInfo;
	heapBytes(binary: SiteBinary): Uint8Array | undefined;
	heapNow(): number;
	isolateNow(): number;
	oversized(): boolean;
	dropInterpreter(): void;
}

/** the store, the interpreter fields an adoption hands over, and the reads the retention helpers make */
export interface RetentionHost
	extends
		SiteStore,
		Pick<
			SitePhpDurableObject,
			| 'php'
			| 'out'
			| 'bootDiag'
			| 'bootMs'
			| 'phpBootedAt'
			| 'bootLinear'
			| 'mountInfo'
			| 'heapRestore'
			| 'crossings'
			| 'crossingNames'
			| 'replicaGuard'
			| 'pinnedHandles'
			| 'installedModuleFiles'
			| 'moduleIntegrity'
			| 'heapIntegrity'
			| 'parkInstall'
			| 'parkSockets'
			| 'retired'
			| 'retentionAdoptions'
			| 'lastRetention'
			| 'commitSeq'
			| 'dropInterpreter'
			| 'heapNow'
			| 'isolateNow'
		> {
	ctx: DurableObjectState;
	phpOwner?: { current: RetentionHost };
}

/** the store, the interpreter and its run record, and the reads the run helpers make */
export interface RunHost
	extends
		SiteStore,
		Pick<
			SitePhpDurableObject,
			| 'php'
			| 'out'
			| 'lastRet'
			| 'trappedRuns'
			| 'lastTrap'
			| 'exitedRuns'
			| 'lastExit'
			| 'phpBootedAt'
			| 'restartBlocked'
			| 'ensurePhp'
			| 'dropInterpreter'
			| 'run'
			| 'settleReply'
		> {}

/** the reconciliation memo the class holds */
export interface ReconcileMemo {
	/** whether the core version has been compared this incarnation; in memory only */
	coreVersionChecked: boolean;
}

/** the store plus the pack's container row, the memo and the reads the reconciliation helpers make */
export interface ReconcileStateHost extends SiteStore {
	packedContainer?: PackedContainer;
	reconcileMemo: ReconcileMemo;
	reconcileState(): ReconcileState;
	reconcileHost(): ReconcileHost;
	canonicalOrigin(observed?: string): string;
	enabledModulesFingerprint(): string;
	isPoolLane(): boolean;
}

/** the meta row primitives and the storage handles the sealed credential helpers read on each call */
export interface SecretsHost {
	sql: SqlStorage;
	storage: DurableObjectStorage;
	ctx: DurableObjectState;
	metaRowGet(key: string, fallback?: string | null): string | null;
	metaRowSet(key: string, value: unknown): void;
	ensureServeTables(): void;
}
