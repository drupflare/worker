import { writeTargetTable } from '../db/write-tally';
import { sessionCookieValue } from '../ops/auth-budget';
import { drupalSessionRowId, statementAllowedOnReplica } from '../ops/replica';
import { admissionVerdict, type ReplicaStage } from '../ops/replica-admission';
import { chunkRefusal, type RestoreChunk, restoreStatements } from '../ops/replica-restore';
import { replicaLagMs } from '../ops/replica-routing';
import {
	applyRecord,
	landPosition,
	type LogRecord,
	markInflight,
	positionTrust,
	readPosition
} from '../ops/replication-log';
import { ORIGIN_KEY, pinnable } from '../ops/site-origin';
import { assertSalt, HASH_SALT_KEY } from '../ops/site-secrets';
import { fingerprintState, readStateRows } from '../ops/state-fingerprint';
import {
	type ForwardStatement,
	LANE_HIGH_PREFIX,
	laneHighWater,
	partitionedTables
} from '../ops/write-forwarding';
import type { LaneHost } from './host';
import {
	COMMIT_SEQ_KEY,
	READMIT_ASKS_KEY,
	RESTORE_EXPECT_KEY,
	RESTORE_GENERATION_KEY,
	RESTORE_SEEN_KEY
} from './keys';
import { CATCH_UP_INTERVAL_MS, SESSION_CATCHUP_MS } from './limits';
import { laneOf } from './role';
import type { ForwardOutcome } from './types';

/**
 * Whether this lane is empty and waiting for the primary's copy (`CREATED` with a readmission
 * ask outstanding).
 */
export function awaitingCopy(host: LaneHost): boolean {
	return host.replicaStage() === 'CREATED' && (host.metaGet(READMIT_ASKS_KEY) ?? '') !== '';
}

/**
 * How long a lane waiting on a copy sleeps before asking again: doubling from the catch-up
 * interval to 60 s.
 */
export function copyBackoffMs(host: LaneHost): number {
	const asks = Number(host.metaGet(READMIT_ASKS_KEY) ?? '0') || 0;
	return Math.min(CATCH_UP_INTERVAL_MS * 2 ** Math.max(0, asks - 1), 60_000);
}

/**
 * Whether this is a pool lane nothing has routed to lately; a primary is never idle (it takes
 * every write and miss).
 */
export function laneIsIdle(host: LaneHost): boolean {
	if (!host.isPoolLane()) return false;
	return (host.doRequestsSinceFlush ?? 0) === 0 && (host.inflightPeak ?? 0) < 1;
}

/**
 * Bounds how stale a serving lane may get by pulling its next firing in (30,000 ms against the
 * 240,000 ms idle re-arm; the fence refuses only callers that state a freshness requirement).
 * Runs in the `finally` because the body has many returns.
 */
export async function keepLaneReplicating(host: LaneHost): Promise<void> {
	if (!host.isPoolLane() || host.replicaStage() !== 'SERVING') return;
	const bound = host.nowMs() + replicaLagMs(host.env);
	const armed = await host.storage.getAlarm();
	if (armed !== null && armed <= bound) return;
	await host.setAlarmAt(bound);
}

/** a comma-joined restore bookkeeping list, empty when unset */
function restoreList(host: LaneHost, key: string): string[] {
	const raw = host.metaGet(key) ?? '';
	return raw === '' ? [] : raw.split(',');
}

/**
 * Abandons a restore in progress.
 *
 * Without it `restore_generation` survives and every chunk of a fresh attempt is refused as
 * torn. The in-flight marker stays: landed rows remain and the replica is untrusted until a
 * copy completes.
 */
export function clearRestore(host: LaneHost): void {
	host.metaSet(RESTORE_GENERATION_KEY, '');
	host.metaSet(RESTORE_EXPECT_KEY, '');
	host.metaSet(RESTORE_SEEN_KEY, '');
}

/**
 * Records the rowids this lane minted for a batch the primary committed (else a second insert
 * between catch-ups mints the id again). Uses `MAX` so the mark never falls.
 */
export function markLaneHigh(host: LaneHost, batch: readonly ForwardStatement[]): void {
	const marks = laneHighWater(batch);
	if (marks.size === 0) return;
	host.ensureServeTables();
	for (const [table, id] of marks) {
		host.sql.exec(
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
 * Puts a withdrawn lane back to `CREATED` and asks the primary for a whole re-copy: its state is
 * untrusted, so it never resumes. The ask repeats each firing until the copy lands.
 */
export async function requestReadmission(
	host: LaneHost
): Promise<{ asked: boolean; reason: string; stage: ReplicaStage }> {
	const lane = laneOf(host);
	if (lane === undefined) {
		return { asked: false, reason: 'not a pool lane', stage: host.replicaStage() };
	}
	if (host.replicaStage() !== 'WITHDRAWN') {
		return { asked: false, reason: 'not withdrawn', stage: host.replicaStage() };
	}
	const ns = host.env?.SITE;
	if (!ns) return { asked: false, reason: 'the namespace is not bound', stage: 'WITHDRAWN' };

	clearRestore(host);
	host.setReplicaStage('CREATED');
	// set before the hop, so a lane whose ask throws still reads as waiting
	const asks = (Number(host.metaGet(READMIT_ASKS_KEY) ?? '0') || 0) + 1;
	host.metaSet(READMIT_ASKS_KEY, String(asks));
	const res = await ns.get(ns.idFromName(lane.site)).fetch(
		new Request(`https://do.local/__replica?action=readmit&lane=${lane.lane}`, {
			method: 'POST'
		})
	);
	if (!res.ok) {
		// stays `CREATED` (it is empty now); the ask retries next firing
		return { asked: false, reason: `the primary answered ${res.status}`, stage: 'CREATED' };
	}
	return { asked: true, reason: '', stage: host.replicaStage() };
}

/**
 * Whether this lane holds the session the cookie names, asked before the render. A miss nudges a
 * rate-limited catch-up that is not awaited (awaiting it queued lanes behind the primary).
 */
export async function sessionReach(
	host: LaneHost,
	cookie: string
): Promise<'held' | 'absent' | 'unknown'> {
	// `unknown` defers to the render: no table or no cookie value is not evidence of no session
	if (!host.hasTable('sessions')) return 'unknown';
	const value = sessionCookieValue(cookie);
	if (value === undefined || value === '') return 'unknown';
	const id = await drupalSessionRowId(value);
	const present = () =>
		host.sql.exec(`SELECT 1 FROM sessions WHERE sid = ? LIMIT 1`, id).toArray().length > 0;
	if (present()) return 'held';
	const now = host.nowMs();
	if (now - (host.lastSessionCatchUpAt ?? 0) >= SESSION_CATCHUP_MS) {
		host.lastSessionCatchUpAt = now;
		const tally = (host.sessionCatchUps ??= { tried: 0, found: 0 });
		tally.tried += 1;
		host.ctx.waitUntil(
			catchUpOnce(host)
				.then((caught) => {
					if (caught.ran && caught.records > 0 && present()) tally.found += 1;
				})
				// this request hands back either way
				.catch(() => {})
		);
	}
	return 'absent';
}

/**
 * Keeps a forwarded statement, with the table the tally attributes it to.
 *
 * The parent generation is pinned on the first statement of an invocation (the generation this
 * lane read at); the primary refuses a batch built on one it has moved past.
 */
export function collectForward(
	host: LaneHost,
	statements: readonly string[],
	payload: unknown
): void {
	const body = (() => {
		try {
			return JSON.parse(String(payload)) as {
				statements?: { sql?: string; params?: unknown[]; minted?: string }[];
			};
		} catch (e) {
			host.noteError('collectForward', e);
			return undefined;
		}
	})();
	if (host.forwardParent === undefined) host.forwardParent = host.commitSeq();
	host.forwardBuffer ??= [];
	for (const statement of body?.statements ?? []) {
		if (typeof statement?.sql !== 'string') continue;
		if (statementAllowedOnReplica(statement.sql)) continue;
		host.forwardBuffer.push({
			sql: statement.sql,
			params: (statement.params ?? []) as unknown[],
			table: writeTargetTable(statement.sql) ?? '',
			// the driver's own report of an id minted from this lane's residue class (see
			// `partitionedTables()`)
			...(typeof statement.minted === 'string' && statement.minted !== ''
				? { minted: statement.minted }
				: {})
		});
	}
	void statements;
}

/**
 * Sends this invocation's collected writes to the primary, once.
 *
 * A conflict is retried once after re-reading the generation (usually another lane committed in
 * between); a second conflict is a contended row, and retrying again would spin.
 */
export async function flushForward(host: LaneHost): Promise<ForwardOutcome | undefined> {
	const batch = host.forwardBuffer;
	const parent = host.forwardParent;
	host.forwardBuffer = undefined;
	host.forwardParent = undefined;
	if (batch === undefined || batch.length === 0 || parent === undefined) return undefined;

	const lane = laneOf(host);
	const ns = host.env?.SITE;
	if (lane === undefined || !ns) {
		return { action: 'refuse', reason: 'no primary to forward to' };
	}
	const primary = ns.get(ns.idFromName(lane.site));

	type Answer = {
		action: string;
		reason: string;
		generation?: number;
		primaryGeneration?: number;
	};
	// what the driver minted, not what the statements look like (`laneHighWater()` would admit a
	// table this lane never originated an id for)
	const partitioned = partitionedTables(batch);
	const send = async (at: number): Promise<Answer> => {
		const res = await primary.fetch(
			new Request('https://do.local/__replica?action=forward', {
				method: 'POST',
				body: JSON.stringify({ statements: batch, parent: at, partitioned }),
				headers: { 'content-type': 'application/json' }
			})
		);
		return (await res.json()) as Answer;
	};

	const first = await send(parent);
	// the retry re-sends the same statements, rowids included; safe because every writer mints
	// from its own residue class (`idPartition()`), so no concurrent commit took one of these ids
	const answer =
		first.action === 'conflict' && Number.isFinite(first.primaryGeneration)
			? await send(first.primaryGeneration!)
			: first;
	if (answer.action === 'commit') markLaneHigh(host, batch);
	return answer;
}

/**
 * Lands one chunk of a bulk copy on this replica.
 *
 * The first chunk marks the position in-flight; it clears only when the whole copy and the
 * mandatory set have landed, so an interrupted restore reads as untrusted, not as a low generation.
 * `VERIFIED` is reached only from {@link missingMandatory} being empty.
 */
export function applyRestoreChunk(
	host: LaneHost,
	chunk: RestoreChunk
): {
	ok: boolean;
	reason: string;
	stage: ReplicaStage;
	statements: number;
	missing: string[];
} {
	const stage = host.replicaStage();
	const begunRaw = host.metaGet(RESTORE_GENERATION_KEY);
	const begunAt = begunRaw === null || begunRaw === '' ? null : Number(begunRaw);
	const refusal = chunkRefusal(chunk, host.packGeneration() ?? null, begunAt);
	if (refusal !== null) {
		return { ok: false, reason: refusal, stage, statements: 0, missing: [] };
	}

	if (begunAt === null) {
		host.metaSet(RESTORE_GENERATION_KEY, chunk.generation);
		host.metaSet(RESTORE_EXPECT_KEY, (chunk.expect ?? []).join(','));
		// inherited, never observed (see `RestoreChunk.origin`); else the session cookie name
		// differs from the primary's and every visitor is uid 0
		if (pinnable(chunk.origin)) host.metaSet(ORIGIN_KEY, chunk.origin!);
		// inherited likewise; the running interpreter baked the old salt into settings.php
		if (typeof chunk.hashSalt === 'string' && chunk.hashSalt !== '') {
			assertSalt(chunk.hashSalt);
			if (host.metaGet(HASH_SALT_KEY) !== chunk.hashSalt) {
				host.metaSet(HASH_SALT_KEY, chunk.hashSalt);
				host.php = undefined;
			}
		}
		host.metaSet(RESTORE_SEEN_KEY, '');
		markInflight(host.logStore(), host.commitSeq(), chunk.generation);
		if (stage === 'CREATED') host.setReplicaStage('RESTORING');
		// the ask was answered; clear its backoff so a second withdrawal asks promptly
		host.metaSet(READMIT_ASKS_KEY, '');
	}

	// before the statements: the first is a DELETE and a missing table fails it
	if (chunk.first === true && !host.hasTable(chunk.table)) {
		for (const sql of chunk.ddl ?? []) host.sql.exec(sql);
	}

	const statements = restoreStatements(chunk);
	host.storage.transactionSync(() => {
		for (const s of statements) host.sql.exec(s.sql, ...s.params);
	});
	const seen = restoreList(host, RESTORE_SEEN_KEY);
	if (!seen.includes(chunk.table)) {
		host.metaSet(RESTORE_SEEN_KEY, [...seen, chunk.table].join(','));
	}

	if (chunk.done !== true) {
		return {
			ok: true,
			reason: '',
			stage: host.replicaStage(),
			statements: statements.length,
			missing: []
		};
	}

	// a `done` on the wrong chunk must not verify a partial copy (the mandatory set only catches a
	// missing identity, so a copy that stopped after `config` would read as a working site)
	const landed = restoreList(host, RESTORE_SEEN_KEY);
	const uncopied = restoreList(host, RESTORE_EXPECT_KEY).filter((t) => !landed.includes(t));
	const missing = [...host.mandatoryGap(), ...uncopied.map((t) => `table:${t}`)];
	if (missing.length > 0) {
		// the marker stays; a copy missing values a replica cannot mint is not finished
		return {
			ok: false,
			reason: `restore incomplete: ${missing.join(', ')}`,
			stage: host.replicaStage(),
			statements: statements.length,
			missing
		};
	}

	landPosition(host.logStore(), chunk.generation);
	host.metaSet(COMMIT_SEQ_KEY, chunk.generation);
	clearRestore(host);
	host.setReplicaStage('VERIFIED');
	return {
		ok: true,
		reason: '',
		stage: host.replicaStage(),
		statements: statements.length,
		missing: []
	};
}

/**
 * Pulls one batch of the primary's log and applies it, then re-decides admission.
 *
 * The replica pulls because a push would make the primary own delivery state for every lane and
 * spend invocations on lanes that are down. Two hops per round: `/__replica` for what the primary
 * advertises, then `action=log`. Promotion goes through {@link admissionVerdict}, which resolves
 * every unknown toward the primary, so a null fingerprint on either side refuses.
 */
export async function catchUpOnce(
	host: LaneHost,
	limit = 25
): Promise<{
	ran: boolean;
	reason: string;
	applied: number;
	advertised: number;
	records: number;
	stage: ReplicaStage;
	admitted: boolean;
}> {
	const stage = host.replicaStage();
	const idle = {
		ran: false,
		applied: host.commitSeq(),
		advertised: 0,
		records: 0,
		stage,
		admitted: false
	};

	const lane = laneOf(host);
	if (lane === undefined) return { ...idle, reason: 'not a pool lane' };
	const ns = host.env?.SITE;
	if (!ns) return { ...idle, reason: 'the namespace is not bound' };
	// a log cannot repair CREATED, RESTORING or WITHDRAWN
	if (stage === 'CREATED' || stage === 'RESTORING' || stage === 'WITHDRAWN') {
		return { ...idle, reason: `stage ${stage} needs a restore, not a log` };
	}

	const position = readPosition(host.logStore());
	const trust = positionTrust(position);
	if (!trust.trusted) {
		// an untrusted position is not resumable (the marker names the generation, not which chunks
		// committed), so withdraw and wait for a restore
		host.setReplicaStage('WITHDRAWN');
		return { ...idle, reason: trust.reason, stage: host.replicaStage() };
	}

	const primary = ns.get(ns.idFromName(lane.site));
	const head = (await (
		await primary.fetch(new Request('https://do.local/__replica'))
	).json()) as {
		generation: number;
		fingerprint: string | null;
		schemaVersion: string | null;
	};

	let applied = position.applied;
	let records = 0;
	if (applied < head.generation) {
		if (host.replicaStage() === 'VERIFIED') host.setReplicaStage('CATCHING_UP');
		const batch = (await (
			await primary.fetch(
				new Request(`https://do.local/__replica?action=log&since=${applied}&limit=${limit}`)
			)
		).json()) as { records: LogRecord[] };
		for (const record of batch.records) {
			const outcome = applyRecord(host.logStore(), record, {
				localSchema: host.packGeneration()
			});
			if (outcome.action === 'refuse') {
				// a refusal ends the batch but does not undo the records ahead of it, which still
				// owe the loop's normal bookkeeping
				if (applied > position.applied) {
					host.metaSet(COMMIT_SEQ_KEY, applied);
					host.purgeAfterApply();
				}
				// separate from `lastCatchUp`, which readmission overwrites on the next firing
				host.lastWithdrawal = {
					reason: outcome.reason,
					generation: record.generation,
					applied,
					at: host.nowMs()
				};
				host.setReplicaStage('WITHDRAWN');
				return {
					ran: true,
					reason: `refused generation ${record.generation}: ${outcome.reason}`,
					applied,
					advertised: head.generation,
					records,
					stage: host.replicaStage(),
					admitted: false
				};
			}
			if (outcome.action === 'apply') records++;
			applied = outcome.applied;
		}
		host.metaSet(COMMIT_SEQ_KEY, applied);
		// the lane holds its own copies of the derived caches the primary purged on write
		if (applied > position.applied) host.purgeAfterApply();
	}

	const read = readStateRows((sql) => host.sql.exec(sql).toArray());
	const verdict = admissionVerdict({
		stage: host.replicaStage(),
		presentState: read.rows.map((r) => ({ collection: r.collection, name: r.name })),
		presentCollections: [...new Set(read.rows.map((r) => r.collection))],
		appliedGeneration: applied,
		advertisedGeneration: head.generation,
		fingerprint: await fingerprintState(read.rows),
		primaryFingerprint: head.fingerprint,
		schemaVersion: host.packGeneration() ?? null,
		primarySchemaVersion: head.schemaVersion
	});

	if (verdict.admitted) {
		// each move is one legal step; a lane that arrives here from VERIFIED walks all three
		for (const to of ['CATCHING_UP', 'ELIGIBLE', 'SERVING'] as const) {
			host.setReplicaStage(to);
		}
	}

	return {
		ran: true,
		reason: verdict.admitted ? '' : verdict.refusals.join('; '),
		applied,
		advertised: head.generation,
		records,
		stage: host.replicaStage(),
		admitted: verdict.admitted
	};
}
