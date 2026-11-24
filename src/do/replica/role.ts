import { hasSessionCookie } from '../../ops/meters/auth-budget';
import { canTransition, missingMandatory, type ReplicaStage } from '../../ops/replica/admission';
import { fenceAllows, replicaReadOnly } from '../../ops/replica/policy';
import { type LogStore } from '../../ops/replica/replication-log';
import { replicaOf } from '../../ops/replica/routing';
import { readStateRows } from '../../ops/replica/state-fingerprint';
import { ID_PARTITION_LANES, writeForwardEnabled } from '../../ops/replica/write-forwarding';
import type { RoleHost, SiteStore } from '../host';

/**
 * Moves this object's replica stage through {@link canTransition}, or refuses the move.
 *
 * @returns the stage now in force; unchanged when the transition was refused
 */
export function setReplicaStage(
	host: SiteStore,
	next: ReplicaStage
): { stage: ReplicaStage; moved: boolean; reason: string } {
	const from = (host.metaGet('replica_stage') ?? 'CREATED') as ReplicaStage;
	if (from === next) return { stage: from, moved: false, reason: 'already there' };
	if (!canTransition(from, next)) {
		return { stage: from, moved: false, reason: `${from} -> ${next} is not a legal move` };
	}
	host.metaSet('replica_stage', next);
	return { stage: next, moved: true, reason: '' };
}

/** the stored replica stage (`CREATED` when none) */
export function replicaStage(host: SiteStore): ReplicaStage {
	return (host.metaGet('replica_stage') ?? 'CREATED') as ReplicaStage;
}

/**
 * Whether this object is a replica, a property of its name (`example.com#r1`).
 *
 * `REPLICA_READ_ONLY` is deployment-wide and would make a pool's primary read-only, so the
 * role is per-object; no client request can change which id the router used. Either source
 * suffices (OR, so a misconfiguration lands on read-only).
 */
export function isReplica(host: RoleHost): boolean {
	if (replicaReadOnly(host.env)) return true;
	return isPoolLane(host);
}

/**
 * Whether this object is a pool lane, narrower than a replica.
 *
 * A lane has a lifecycle (restore, then `SERVING`) and hands traffic back until then; a
 * var-configured replica sits at `CREATED` forever, so the readiness check would refuse
 * everything.
 */
export function isPoolLane(host: RoleHost): boolean {
	const name = host.ctx.id.name;
	return name !== undefined && replicaOf(name) !== undefined;
}

/**
 * Whether this object may answer a request that requires generation `g`.
 *
 * A primary is never fenced. A replica checks the caller's header: absent means any view will
 * do, an unparseable one refuses (unreadable is not absent), a number goes to
 * {@link fenceAllows}.
 */
export function fenceRefusal(
	host: RoleHost,
	request: Request
): { refuse: boolean; required: number; applied: number } {
	const applied = host.commitSeq();
	if (!host.isReplica()) return { refuse: false, required: applied, applied };
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
export function logStore(host: SiteStore): LogStore {
	return {
		read: (key) => host.metaGet(key),
		write: (key, value) => host.metaSet(key, value),
		exec: (sql, params) => host.sql.exec(sql, ...params),
		txn: (fn) => host.storage.transactionSync(fn)
	};
}

/**
 * Which values this object cannot mint for itself and does not hold.
 *
 * Asked of a replica (did the copy finish) and of a primary (may it be copied from): a
 * provisioned site holds no `system.private_key` yet, and each replica would then mint a key
 * the others reject.
 */
export function mandatoryGap(host: SiteStore): string[] {
	const read = readStateRows((sql) => host.sql.exec(sql).toArray());
	return missingMandatory({
		stage: replicaStage(host),
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

/**
 * Which slice of the rowid space this object's driver mints from.
 *
 * The count is {@link ID_PARTITION_LANES}, not the pool size (a lane cannot learn it). The
 * primary takes slice 0, or unpartitioned ids collide with forwarded rows on `UNIQUE`. Gated
 * on the site having a pool, since ids advance by the stride.
 */
export function idPartition(host: RoleHost): { lane: number; lanes: number } {
	if (!writeForwardEnabled(host.env)) return { lane: 0, lanes: 0 };
	if (!isPoolLane(host)) {
		return host.lanesProvisioned() > 0
			? { lane: 0, lanes: ID_PARTITION_LANES }
			: { lane: 0, lanes: 0 };
	}
	const lane = laneOf(host)?.lane ?? 0;
	return lane < 1 ? { lane: 0, lanes: 0 } : { lane, lanes: ID_PARTITION_LANES };
}

/** the body and status of the refusal a replica gives a write mark request */
export const MARK_REFUSAL = { message: 'a replica lane keeps no mark', status: 409 };

/** whether this object keeps no write mark, which a replica does not */
export function keepsMark(host: RoleHost): boolean {
	// the method, not the module function, so an override on the object still applies
	return host.isReplica();
}

/** whether this object is a pool lane, which refuses the routes only the primary answers */
export function refusesPrimaryRoutes(host: RoleHost): boolean {
	return host.isPoolLane();
}

/** whether this object is a pool lane handed a request that carries a session cookie */
export function handsBackSession(host: RoleHost, cookie: string): boolean {
	return host.isPoolLane() && hasSessionCookie(cookie);
}

/** whether this object is a pool lane, which serves a copy of the primary and does not reconcile */
export function refusesReconcile(host: Pick<RoleHost, 'isPoolLane'>): boolean {
	return host.isPoolLane();
}

/** whether this object is a pool lane, which leaves autoscaling and provisioning to the primary */
export function refusesPoolOwner(host: Pick<RoleHost, 'isPoolLane'>): boolean {
	return host.isPoolLane();
}

/** whether this object trusts module files as they stand, which a replica does */
export function trustsModuleFiles(host: Pick<RoleHost, 'isReplica'>): boolean {
	return host.isReplica();
}

/** the role name the stats and the replica status report: replica for a replica, else primary */
export function roleName(host: Pick<RoleHost, 'isReplica'>): 'replica' | 'primary' {
	return host.isReplica() ? 'replica' : 'primary';
}

/** the site and lane number this object's name names, or undefined when it is not a lane */
export function laneOf(host: Pick<RoleHost, 'ctx'>): { site: string; lane: number } | undefined {
	return replicaOf(host.ctx.id.name ?? '');
}
