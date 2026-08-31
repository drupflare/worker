/**
 * How authoritative state reaches a replica, and why an interrupted delivery cannot be mistaken for
 * a complete one.
 *
 * THE INVARIANT IS THAT A REPLICA IS FULLY VALID AT G OR KNOWN TO BE BELOW G, NEVER IN BETWEEN. A
 * replica that has applied half of a generation is not "slightly stale"; it holds a state the primary
 * was never in, and no fence expressed in generation numbers can describe it. So every path out of an
 * interrupted apply lands on a number that is true, or on a refusal.
 *
 * Two mechanisms carry that, and they cover different failures:
 *
 * - A record that fits one transaction needs no marker. The apply and the position advance commit
 *   together, so an interruption rolls both back and the replica is cleanly at the parent. This is
 *   the common case and it costs nothing.
 * - A record applied in CHUNKS cannot use that, because the chunks commit separately. An intent
 *   marker is committed before the first chunk and cleared with the last, so a marker found on
 *   restart means chunks landed and the position did not. That replica is untrusted until it
 *   restores; it cannot resume, because nothing records which chunks committed.
 *
 * The marker is written only when it is load-bearing. Writing it for a single-transaction apply
 * would charge a row to record something the transaction already guarantees.
 */

/** one delivered generation; `fingerprint` is what the replica must hash to AFTER applying */
export type LogRecord = {
	/** the generation this record produces */
	generation: number;
	/** the generation it must be applied on top of */
	parent: number;
	/** the pack generation both sides must agree on */
	schemaVersion: string;
	/** the primary's authoritative-state fingerprint at {@link generation} */
	fingerprint: string;
	/**
	 * Set when the change was too large to log statement by statement.
	 *
	 * An overflowed record carries NO statements and cannot be applied; a replica meeting one has to
	 * restore. That is the safe direction: a truncated statement list would
	 * apply cleanly and leave the replica silently wrong, which is the one outcome the whole log
	 * exists to prevent.
	 */
	overflowed?: boolean;
	statements: readonly { sql: string; params?: readonly unknown[] }[];
};

/**
 * Where a replica is in the log, as durable state.
 *
 * No schema version here. The object's pack generation is already recorded by the migrate
 * cursor, and a copy kept alongside the log position would be a second source of truth that can
 * disagree with the first. The applier is handed the live one.
 */
export type LogPosition = {
	/** the last generation applied in full */
	applied: number;
	/** set while a chunked apply is in flight; a survivor of one means chunks landed */
	inflight: { from: number; to: number } | null;
};

export type Trust =
	{ trusted: true; validAt: number } | { trusted: false; validAt: number; reason: string };

export type PlanAction = 'apply' | 'duplicate' | 'refuse';
export type Plan = { action: PlanAction; reason: string };

/** the durable surface an applier needs; a Map satisfies it, so the decisions are drivable */
export type LogStore = {
	read(key: string): string | null;
	write(key: string, value: string): void;
	exec(sql: string, params: readonly unknown[]): void;
	/** must be atomic: everything inside commits together or not at all */
	txn(fn: () => void): void;
};

const APPLIED_KEY = 'repl_applied';
const INFLIGHT_KEY = 'repl_inflight';

export function readPosition(store: LogStore): LogPosition {
	const applied = Number(store.read(APPLIED_KEY) ?? '0');
	const raw = store.read(INFLIGHT_KEY) ?? '';
	let inflight: LogPosition['inflight'] = null;
	if (raw !== '') {
		const [from, to] = raw.split(':').map(Number);
		// an unreadable marker is still a marker; refusing to parse it must not read as its absence
		inflight = { from: Number.isFinite(from) ? from! : -1, to: Number.isFinite(to) ? to! : -1 };
	}
	return { applied: Number.isFinite(applied) ? applied : -1, inflight };
}

/**
 * Whether the replica's own position is a number anyone may act on.
 *
 * A surviving marker is the untrusted case and it is NOT resumable: the marker records which
 * generation was being built, not which of its chunks committed, so there is no safe point to
 * continue from. Recording per-chunk progress would make resume possible and is not built, because
 * the recovery it replaces is a restore the replica can already perform.
 */
export function positionTrust(pos: LogPosition): Trust {
	if (pos.applied < 0) {
		return { trusted: false, validAt: 0, reason: 'the applied generation is unreadable' };
	}
	if (pos.inflight !== null) {
		return {
			trusted: false,
			validAt: pos.applied,
			reason:
				`a chunked apply of generation ${pos.inflight.to} was interrupted after ` +
				`${pos.inflight.from}; some chunks committed and the position did not`
		};
	}
	return { trusted: true, validAt: pos.applied };
}

/**
 * Marks the position untrusted while a multi-transaction load is in flight.
 *
 * The same marker a chunked apply uses, and for the same reason: a bulk restore commits table by
 * table, so an interruption leaves rows that landed and a position that did not. Sharing it rather
 * than adding a second flag means {@link positionTrust} already refuses both, and there is one
 * answer to "is this replica's number real" instead of two that can disagree.
 */
export function markInflight(store: LogStore, from: number, to: number): void {
	store.txn(() => store.write(INFLIGHT_KEY, `${from}:${to}`));
}

/** lands the position at `generation` and clears the marker, in one transaction */
export function landPosition(store: LogStore, generation: number): void {
	store.txn(() => {
		store.write(APPLIED_KEY, String(generation));
		store.write(INFLIGHT_KEY, '');
	});
}

function malformed(record: LogRecord): string | null {
	if (!Number.isFinite(record.generation) || !Number.isFinite(record.parent)) {
		return 'the record carries a generation that is not a number';
	}
	if (record.parent < 0 || record.generation < 0)
		return 'the record carries a negative generation';
	if (record.generation !== record.parent + 1) {
		return `the record claims ${record.parent} -> ${record.generation}, which is not one step`;
	}
	if (record.overflowed === true) {
		return 'the record overflowed and carries no statements; this replica must restore';
	}
	if (!Array.isArray(record.statements)) return 'the record carries no statement list';
	if (typeof record.fingerprint !== 'string' || record.fingerprint === '') {
		return 'the record carries no fingerprint, so applying it could not be verified';
	}
	return null;
}

/**
 * What to do with a delivered record.
 *
 * Order matters. A malformed or wrong-schema record is refused before anything looks at generation
 * numbers, because its numbers are not evidence of anything. Only then does a re-delivery of an
 * already-applied generation collapse to a no-op.
 *
 * `duplicate` is a SKIP rather than a re-apply. The statements in a record are not required to be
 * idempotent -- an `UPDATE ... SET n = n + 1` is a legitimate authoritative write -- so replaying one
 * at a generation the replica already passed would corrupt exactly the state this exists to carry.
 *
 * **A GENERATION NUMBER IDENTIFIES A POSITION IN ONE PRIMARY'S HISTORY AND NOTHING MORE.** Nothing
 * here can tell a record from primary A apart from a record from primary B carrying the same number,
 * so a replica pointed at a second primary would skip its records as duplicates and diverge in
 * silence. What catches that is the fingerprint comparison at admission, which checks the RESULT
 * rather than the sequence -- and it runs at admission only, so divergence that begins after a
 * replica is already serving is not detected until it is re-admitted. Chaining each record to its
 * parent's fingerprint would close it inside the log; it is not built, and this is the surviving
 * objective rather than a settled one.
 */
export function planApply(pos: LogPosition, record: LogRecord, localSchema: string | null): Plan {
	const trust = positionTrust(pos);
	if (!trust.trusted) return { action: 'refuse', reason: trust.reason };

	const bad = malformed(record);
	if (bad !== null) return { action: 'refuse', reason: bad };

	if (localSchema === null || record.schemaVersion !== localSchema) {
		return {
			action: 'refuse',
			reason: `schema mismatch: record ${record.schemaVersion}, replica ${localSchema ?? 'unknown'}`
		};
	}

	if (record.generation <= pos.applied) {
		return {
			action: 'duplicate',
			reason: `generation ${record.generation} is already applied`
		};
	}

	if (record.parent > pos.applied) {
		return {
			action: 'refuse',
			reason: `missing generation: applied ${pos.applied}, record needs ${record.parent}`
		};
	}
	if (record.parent < pos.applied) {
		return {
			action: 'refuse',
			reason: `out of order: applied ${pos.applied}, record builds on ${record.parent}`
		};
	}

	return { action: 'apply', reason: '' };
}

export type ApplyOutcome = {
	action: PlanAction;
	reason: string;
	/** the generation the replica is valid at afterwards */
	applied: number;
	/** how many transactions the apply took; 1 means the marker was never needed */
	chunks: number;
};

/**
 * Applies one record, or refuses it.
 *
 * The statements are the primary's authoritative writes and are NOT passed through the
 * replica's read-only guard. That guard exists to stop a replica ORIGINATING an authoritative write;
 * this is the one path by which such a write legitimately arrives, and gating it there would leave a
 * replica able to receive only the writes it could have made itself.
 *
 * @param localSchema
 *   The pack generation this object actually holds, read live rather than kept beside the position.
 * @param chunkSize
 *   Statements per transaction. The default applies the whole record in one, which is what makes an
 *   interruption roll back cleanly. Pass a smaller number only when a record is too large to apply in
 *   one invocation, and accept that an interruption then costs a restore.
 */
export function applyRecord(
	store: LogStore,
	record: LogRecord,
	{
		localSchema,
		chunkSize = Number.POSITIVE_INFINITY
	}: { localSchema: string | null; chunkSize?: number }
): ApplyOutcome {
	const pos = readPosition(store);
	const plan = planApply(pos, record, localSchema);
	if (plan.action !== 'apply') {
		return { action: plan.action, reason: plan.reason, applied: pos.applied, chunks: 0 };
	}

	const statements = record.statements;
	const size = Math.max(1, Math.min(chunkSize, statements.length || 1));
	const chunked = statements.length > size;

	if (chunked) {
		// committed on its own and BEFORE any chunk, which is the only ordering that makes a survivor
		// mean "chunks may have landed"; written after the first chunk it would mean nothing
		store.txn(() => store.write(INFLIGHT_KEY, `${record.parent}:${record.generation}`));
	}

	let chunks = 0;
	for (let i = 0; i < statements.length; i += size) {
		const batch = statements.slice(i, i + size);
		const last = i + size >= statements.length;
		store.txn(() => {
			for (const s of batch) store.exec(s.sql, s.params ?? []);
			if (last) {
				store.write(APPLIED_KEY, String(record.generation));
				if (chunked) store.write(INFLIGHT_KEY, '');
			}
		});
		chunks++;
	}

	// a record with no statements still advances the generation; the primary may commit a generation
	// whose whole effect was to state a new fingerprint
	if (statements.length === 0) {
		store.txn(() => store.write(APPLIED_KEY, String(record.generation)));
		chunks = 1;
	}

	return { action: 'apply', reason: '', applied: record.generation, chunks };
}
