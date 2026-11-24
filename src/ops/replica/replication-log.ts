/**
 * How authoritative state reaches a replica. Invariant: a replica is fully valid at G or known to
 * be below G, never in between.
 *
 * A record in one transaction commits with its position, so an interruption rolls back cleanly. A
 * chunked record writes an intent marker first and clears it with the last chunk; a surviving
 * marker means the replica must restore (it cannot resume).
 *
 * @module
 */

/** one delivered generation; `fingerprint` is what the replica must hash to after applying */
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
	 * Set when the change was too large to log; the record carries no statements and a replica
	 * meeting it must restore (a truncated list would apply cleanly and be wrong).
	 */
	overflowed?: boolean;
	/** the primary's writes, in order */
	statements: readonly { sql: string; params?: readonly unknown[] }[];
};

/**
 * Where a replica is in the log, as durable state; no schema version, since the applier is handed
 * the live pack generation.
 */
export type LogPosition = {
	/** the last generation applied in full */
	applied: number;
	/** set while a chunked apply is in flight; a survivor of one means chunks landed */
	inflight: { from: number; to: number } | null;
};

/** whether a replica's position may be acted on, and the generation it is valid at */
export type Trust =
	{ trusted: true; validAt: number } | { trusted: false; validAt: number; reason: string };

/** what {@link planApply} decided for a record */
export type PlanAction = 'apply' | 'duplicate' | 'refuse';
/** a {@link PlanAction} with its reason */
export type Plan = { action: PlanAction; reason: string };

/** the durable surface an applier needs; a Map satisfies it, so the decisions are drivable */
export type LogStore = {
	read(key: string): string | null;
	write(key: string, value: string): void;
	exec(sql: string, params: readonly unknown[]): void;
	/** must be atomic: everything inside commits together or not at all */
	txn(fn: () => void): void;
};

/**
 * A statement's bindings as `ctx.storage.sql` takes them: positional. Drupal binds by name (the
 * update branch of `merge()`), so names are rewritten in SQL order; a missing value throws.
 */
export function positionalBindings(
	sql: string,
	params: unknown
): { sql: string; params: readonly unknown[] } {
	if (Array.isArray(params)) return { sql, params };
	if (params === null || params === undefined) return { sql, params: [] };
	if (typeof params !== 'object') return { sql, params: [params] };

	const map = params as Record<string, unknown>;
	const out: unknown[] = [];
	// `::` is a cast and `:=` is not a token; a name is what SQLite accepts after a single colon
	const rewritten = sql.replace(/(?<![:\w]):([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) => {
		const key = `:${name}`;
		if (key in map) {
			out.push(map[key]);
			return '?';
		}
		if (name in map) {
			out.push(map[name]);
			return '?';
		}
		// left alone rather than guessed at; the length check below turns it into a refusal
		return whole;
	});
	const supplied = Object.keys(map).length;
	if (out.length !== supplied) {
		throw new Error(
			`named bindings do not match the statement: ${out.length} of ${supplied} placed`
		);
	}
	return { sql: rewritten, params: out };
}

const APPLIED_KEY = 'repl_applied';
const INFLIGHT_KEY = 'repl_inflight';

/** the stored position; an unreadable value reads as -1, never as absent */
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
 * Whether the replica's own position may be acted on; a surviving marker is untrusted and not
 * resumable, since it does not record which chunks committed.
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
 * Marks the position untrusted while a multi-transaction load (a bulk restore) is in flight, with
 * the chunked-apply marker so {@link positionTrust} refuses both.
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

function malformed(record: LogRecord): string | undefined {
	if (!Number.isFinite(record.generation) || !Number.isFinite(record.parent)) {
		return 'the record carries a generation that is not a number';
	}
	if (record.parent < 0 || record.generation < 0)
		return 'the record carries a negative generation';
	// a record spans an invocation, so gaps are normal and `parent + 1` is not required; the
	// chain check is `planApply()`'s exact parent match
	if (record.generation <= record.parent) {
		return `the record claims ${record.parent} -> ${record.generation}, which does not advance`;
	}
	if (record.overflowed === true) {
		return 'the record overflowed and carries no statements; this replica must restore';
	}
	if (!Array.isArray(record.statements)) return 'the record carries no statement list';
	if (typeof record.fingerprint !== 'string' || record.fingerprint === '') {
		return 'the record carries no fingerprint, so applying it could not be verified';
	}
	return undefined;
}

/**
 * What to do with a delivered record. Malformed or wrong-schema records are refused before the
 * numbers are trusted; `duplicate` skips, since statements need not be idempotent.
 *
 * A generation number only orders one primary's history: records from a second primary would
 * skip as duplicates, caught only by the fingerprint check at admission.
 */
export function planApply(
	pos: LogPosition,
	record: LogRecord,
	localSchema: string | undefined
): Plan {
	const trust = positionTrust(pos);
	if (!trust.trusted) return { action: 'refuse', reason: trust.reason };

	const bad = malformed(record);
	if (bad !== undefined) return { action: 'refuse', reason: bad };

	if (localSchema === undefined || record.schemaVersion !== localSchema) {
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

/** what {@link applyRecord} did */
export type ApplyOutcome = {
	action: PlanAction;
	reason: string;
	/** the generation the replica is valid at afterwards */
	applied: number;
	/** how many transactions the apply took; 1 means the marker was never needed */
	chunks: number;
};

/**
 * Applies one record, or refuses it. The statements bypass the replica's read-only guard: this is
 * how authoritative writes legitimately arrive.
 *
 * @param localSchema
 *   The pack generation this object holds, read live.
 * @param chunkSize
 *   Statements per transaction; the default is one transaction. A smaller value means an
 *   interruption costs a restore.
 */
export function applyRecord(
	store: LogStore,
	record: LogRecord,
	{
		localSchema,
		chunkSize = Number.POSITIVE_INFINITY
	}: { localSchema: string | undefined; chunkSize?: number }
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
		// committed before any chunk, so a survivor means chunks may have landed
		store.txn(() => store.write(INFLIGHT_KEY, `${record.parent}:${record.generation}`));
	}

	let chunks = 0;
	for (let i = 0; i < statements.length; i += size) {
		const batch = statements.slice(i, i + size);
		const last = i + size >= statements.length;
		store.txn(() => {
			for (const s of batch) {
				const bound = positionalBindings(s.sql, s.params);
				store.exec(bound.sql, bound.params);
			}
			if (last) {
				store.write(APPLIED_KEY, String(record.generation));
				if (chunked) store.write(INFLIGHT_KEY, '');
			}
		});
		chunks++;
	}

	// a record with no statements still advances (its effect may be only a new fingerprint)
	if (statements.length === 0) {
		store.txn(() => store.write(APPLIED_KEY, String(record.generation)));
		chunks = 1;
	}

	return { action: 'apply', reason: '', applied: record.generation, chunks };
}
