import type { SqlBindings } from '@drupflare/durabledb/do-sqlite';
import {
	admissionVerdict,
	MANDATORY_COLLECTIONS,
	MANDATORY_STATE,
	type ReplicaStage
} from '../../ops/replica-admission';
import { planRestore, type ProvisionCursor, type RestoreChunk } from '../../ops/replica-restore';
import {
	applyRecord,
	type LogRecord,
	positionalBindings,
	positionTrust,
	readPosition
} from '../../ops/replication-log';
import { fingerprintState, readStateRows } from '../../ops/state-fingerprint';
import { type ForwardStatement, planForward, splitForward } from '../../ops/write-forwarding';
import type { SitePhpDurableObject } from '../../site-do';

/**
 * What this object publishes about its own authoritative state, and what it makes of a primary's.
 *
 * A primary answers with its generation, fingerprint and mandatory values. A replica also gets a
 * verdict when the caller supplies the primary's side; a missing primary fingerprint is a refusal.
 */
export async function replica(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	// the only writer of `replica_stage`; a refused move is 409 (skipping `VERIFIED` would serve
	// unchecked state)
	if (url.searchParams.get('action') === 'stage') {
		const next = url.searchParams.get('to') as ReplicaStage | null;
		if (next === null) {
			return Response.json({ error: 'stage needs ?to=' }, { status: 400 });
		}
		const moved = site.setReplicaStage(next);
		return Response.json(moved, { status: moved.moved ? 200 : 409 });
	}

	// fill a lane one bounded step per call, driven from the primary (a lane has no route into it);
	// the caller loops on the cursor until `done`
	if (url.searchParams.get('action') === 'provision') {
		const raw = url.searchParams.get('cursor');
		const out = await site.provisionLane(
			Number(url.searchParams.get('lane') ?? '1'),
			raw === null || raw === '' ? undefined : (JSON.parse(raw) as ProvisionCursor),
			Number(url.searchParams.get('budget') ?? '') || undefined
		);
		return Response.json(out, { status: out.ok ? 200 : 409 });
	}

	// a withdrawn lane asking to be copied again; queued for the alarm's driver (a copy is
	// thousands of rows) and the lane re-asks until it lands
	if (url.searchParams.get('action') === 'readmit') {
		if (request.method !== 'POST') {
			return Response.json({ error: 'readmit is a POST' }, { status: 405 });
		}
		if (site.isPoolLane()) {
			return Response.json(
				{
					error: 'a lane is readmitted by the primary, not by another lane'
				},
				{ status: 409 }
			);
		}
		const lane = Number(url.searchParams.get('lane') ?? '');
		if (!Number.isInteger(lane) || lane < 1) {
			return Response.json({ error: 'readmit needs ?lane=' }, { status: 400 });
		}
		const queue = site.enqueueLaneRepair(lane);
		// armed here because a site whose lanes all withdrew may have no other reason to wake
		if ((await site.storage.getAlarm()) === null) {
			await site.setAlarmAt(site.nowMs() + 1000);
		}
		return Response.json({ ok: true, lane, queue });
	}

	// commit a batch a lane ran speculatively and rolled back, or refuse it
	if (url.searchParams.get('action') === 'forward') {
		if (request.method !== 'POST') {
			return Response.json({ error: 'forward is a POST' }, { status: 405 });
		}
		if (site.isPoolLane()) {
			return Response.json(
				{ error: 'a lane forwards to the primary, not to another lane' },
				{ status: 409 }
			);
		}
		site.ensureServeTables();
		const batch = (await request.json()) as {
			statements: ForwardStatement[];
			parent: number;
			partitioned?: string[];
		};
		const { commit, deferred } = splitForward(batch.statements ?? []);
		// a batch that only logged has nothing to sequence
		if (commit.length === 0 && deferred.length > 0) {
			return Response.json({
				action: 'commit',
				generation: site.commitSeq(),
				reason: '',
				deferred: site.appendDeferred(deferred)
			});
		}
		const plan = planForward({
			statements: commit,
			parent: Number(batch.parent),
			primaryGeneration: site.commitSeq(),
			partitioned: batch.partitioned
		});
		if (plan.action !== 'commit') {
			return Response.json(
				{ ...plan, primaryGeneration: site.commitSeq() },
				// a conflict is retryable (409, re-read) and a refusal is not (422, stop)
				{ status: plan.action === 'conflict' ? 409 : 422 }
			);
		}
		// named bindings arrive too (`merge()` binds by name on its `UPDATE` branch), and `?? []`
		// does not cover an object
		const bound = commit.map((s) => positionalBindings(s.sql, s.params));
		site.storage.transactionSync(() => {
			for (const s of bound) site.sql.exec(s.sql, ...s.params);
		});
		for (const s of bound) {
			site.bufferForReplication(s.sql, s.params as SqlBindings);
		}
		const generation = site.advanceCommit();
		await site.sealGeneration();
		return Response.json({
			action: 'commit',
			generation,
			reason: '',
			deferred: site.appendDeferred(deferred)
		});
	}

	// one catch-up round by hand (the alarm chain runs it on its own)
	if (url.searchParams.get('action') === 'catchup') {
		const out = await site.catchUpOnce(
			Number(url.searchParams.get('limit') ?? '') || undefined
		);
		return Response.json(out, { status: out.ran ? 200 : 409 });
	}

	// the records a replica at `?since=` still needs, oldest first
	if (url.searchParams.get('action') === 'log') {
		const since = Number(url.searchParams.get('since') ?? '0');
		const records = site.replicationRecords(
			Number.isFinite(since) ? since : 0,
			Number(url.searchParams.get('limit') ?? '') || 50
		);
		return Response.json({
			generation: site.commitSeq(),
			records,
			// an overflowed record cannot be applied; a caller seeing one restores
			overflowed: records.filter((r) => r.overflowed).map((r) => r.generation)
		});
	}

	// primary half of a bulk copy (the table plan, or one page of one table); never the object
	// that runs `action=restore`
	if (url.searchParams.get('action') === 'snapshot') {
		// seal first so the copy lands on a record boundary: a buffer opened at 54 can seal at 56
		// while `commitSeq()` reads 55, and a lane copied at 55 meets `54 -> 56` and is withdrawn
		await site.sealGeneration();
		const table = url.searchParams.get('table');
		if (table === null) {
			// a primary without its own identity may not be copied from, or every replica mints its
			// own
			const missing = site.mandatoryGap();
			return Response.json(
				{
					generation: site.copyableGeneration(),
					schemaVersion: site.packGeneration() ?? null,
					missing,
					tables: planRestore(site.tableNames())
				},
				{ status: missing.length > 0 ? 409 : 200 }
			);
		}
		const verdict = planRestore([table])[0]!;
		if (!verdict.copy) {
			return Response.json({ error: verdict.reason, table }, { status: 409 });
		}
		const offset = Number(url.searchParams.get('offset') ?? '0') || 0;
		const limit = Number(url.searchParams.get('limit') ?? '') || 200;
		const page = site.snapshotRows(table, offset, limit);
		return Response.json({
			generation: site.copyableGeneration(),
			schemaVersion: site.packGeneration() ?? null,
			table,
			offset,
			// carried on every page, since a paginating driver does not know which page it holds
			ddl: site.tableDdl(table),
			...page
		});
	}

	// replica half: land one chunk of that copy (refused on a primary; a restore clears its tables)
	if (url.searchParams.get('action') === 'restore') {
		if (request.method !== 'POST') {
			return Response.json({ error: 'restore is a POST' }, { status: 405 });
		}
		if (!site.isReplica()) {
			return Response.json({ error: 'a restore lands only on a replica' }, { status: 409 });
		}
		site.ensureServeTables();
		// the only exit from an interrupted copy, which would otherwise refuse every retry as torn
		if (url.searchParams.get('restart') === '1') site.clearRestore();
		const before = site.replicaStage();
		const outcome = site.applyRestoreChunk((await request.json()) as RestoreChunk);
		// nothing else arms a finished lane, so it would refuse every request while waiting for an
		// alarm
		if (outcome.stage === 'VERIFIED' && before !== 'VERIFIED') {
			await site.setAlarmAt(site.nowMs() + 1);
		}
		return Response.json(outcome, { status: outcome.ok ? 200 : 409 });
	}

	// apply one delivered generation; the one path a primary's write may land on a replica, so it
	// bypasses `enforceReadOnly()`
	if (url.searchParams.get('action') === 'apply') {
		if (request.method !== 'POST') {
			return Response.json({ error: 'apply is a POST' }, { status: 405 });
		}
		site.ensureServeTables();
		const record = (await request.json()) as LogRecord;
		const before = readPosition(site.logStore()).applied;
		const outcome = applyRecord(site.logStore(), record, {
			localSchema: site.packGeneration(),
			chunkSize: Number(url.searchParams.get('chunk') ?? '') || undefined
		});
		// the same invalidation the pull loop performs, which this route skipped
		if (outcome.applied > before) site.purgeAfterApply();
		return Response.json(outcome, {
			status: outcome.action === 'refuse' ? 409 : 200
		});
	}

	const read = readStateRows((sql) => site.sql.exec(sql).toArray());
	const rows = read.rows;
	const fingerprint = await fingerprintState(rows);
	const present = rows.map((r) => ({ collection: r.collection, name: r.name }));
	const collections = [...new Set(rows.map((r) => r.collection))];
	const applied = site.commitSeq();
	const schemaVersion = site.packGeneration() ?? null;
	// the primary's side as the caller knows it; absent means unknown, which the verdict refuses
	const num = (key: string): number => {
		const raw = url.searchParams.get(key);
		return raw === null ? Number.NaN : Number(raw);
	};
	const advertised = url.searchParams.has('advertisedGeneration')
		? num('advertisedGeneration')
		: applied;
	const verdict = admissionVerdict({
		stage: site.replicaStage(),
		presentState: present,
		presentCollections: collections,
		appliedGeneration: applied,
		advertisedGeneration: advertised,
		fingerprint,
		primaryFingerprint: url.searchParams.get('primaryFingerprint'),
		schemaVersion,
		primarySchemaVersion: url.searchParams.get('primarySchema')
	});
	const position = readPosition(site.logStore());
	return Response.json({
		role: site.isReplica() ? 'replica' : 'primary',
		generation: applied,
		fingerprint,
		schemaVersion,
		mandatory: {
			state: MANDATORY_STATE.map((m) => `${m.collection}:${m.name}`),
			collections: [...MANDATORY_COLLECTIONS]
		},
		rowsCovered: rows.length,
		// which covered tables this object lacks; both means never restored, reported rather than
		// read as empty
		tablesAbsent: read.absent,
		log: { position, trust: positionTrust(position) },
		verdict
	});
}
