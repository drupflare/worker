import { describe, expect, it } from 'vitest';
import {
	applyRecord,
	planApply,
	positionTrust,
	readPosition,
	type LogRecord,
	type LogStore
} from '../../../src/ops/replication-log';

/**
 * The replication log, driven through the seven ways a delivery goes wrong.
 *
 * The property under test is one sentence: a replica is fully valid at G or known to be below G, and
 * never in between. Every case below ends by asserting which of those two it landed on, because an
 * interrupted apply that reports a plausible generation is the failure this exists to prevent -- it
 * passes the fence, passes admission, and serves a state the primary was never in.
 */

/** a store with real transaction semantics and a crash it can be told to take */
function fakeStore(): LogStore & {
	rows: string[];
	kv: Map<string, string>;
	crashOnTxn: (n: number) => void;
	txnCount: number;
} {
	const kv = new Map<string, string>();
	const rows: string[] = [];
	let txnCount = 0;
	let crashAt = -1;

	const store = {
		kv,
		rows,
		get txnCount() {
			return txnCount;
		},
		crashOnTxn(n: number) {
			crashAt = n;
		},
		read: (key: string) => kv.get(key) ?? null,
		write: (key: string, value: string) => {
			pendingKv.set(key, value);
		},
		exec: (sql: string, params: readonly unknown[]) => {
			pendingRows.push(params.length > 0 ? `${sql} ${JSON.stringify(params)}` : sql);
		},
		txn: (fn: () => void) => {
			txnCount++;
			pendingKv = new Map();
			pendingRows = [];
			const crashing = txnCount === crashAt;
			fn();
			// a crash discards the buffer, which is what an atomic transaction does on rollback
			if (crashing) throw new Error(`interrupted during transaction ${txnCount}`);
			for (const [k, v] of pendingKv) kv.set(k, v);
			rows.push(...pendingRows);
		}
	};

	let pendingKv = new Map<string, string>();
	let pendingRows: string[] = [];
	return store as ReturnType<typeof fakeStore>;
}

const SCHEMA = '11.4.5';

function seeded(applied: number) {
	const store = fakeStore();
	store.kv.set('repl_applied', String(applied));
	return store;
}

/** the object's own pack generation is read live rather than stored, so every case supplies it */
function apply(
	store: LogStore,
	rec: LogRecord,
	opts: { localSchema?: string | null; chunkSize?: number } = {}
) {
	return applyRecord(store, rec, { localSchema: SCHEMA, ...opts });
}

function record(over: Partial<LogRecord> = {}): LogRecord {
	const generation = over.generation ?? 6;
	return {
		generation,
		parent: over.parent ?? generation - 1,
		schemaVersion: over.schemaVersion ?? SCHEMA,
		fingerprint: over.fingerprint ?? 'f'.repeat(64),
		statements: over.statements ?? [
			{ sql: 'INSERT INTO key_value VALUES (?, ?, ?)', params: ['state', 'a', '1'] },
			{ sql: 'INSERT INTO key_value VALUES (?, ?, ?)', params: ['state', 'b', '2'] }
		]
	};
}

describe('the ordinary case, or nothing below means anything', () => {
	it('applies a record in one transaction and advances the position', () => {
		const store = seeded(5);
		const out = apply(store, record({ generation: 6 }));

		expect(out.action).toBe('apply');
		expect(out.applied).toBe(6);
		expect(store.rows).toHaveLength(2);
		expect(readPosition(store).applied).toBe(6);
		expect(positionTrust(readPosition(store)).trusted).toBe(true);
	});

	it('writes no marker when the record fits one transaction', () => {
		const store = seeded(5);
		apply(store, record());
		// the transaction is the safety; a marker here would charge a row to record what the
		// transaction already guarantees
		expect(store.kv.has('repl_inflight')).toBe(false);
		expect(store.txnCount).toBe(1);
	});

	it('advances on a record with no statements', () => {
		const store = seeded(5);
		const out = apply(store, record({ generation: 6, statements: [] }));
		expect(out.applied).toBe(6);
		expect(readPosition(store).applied).toBe(6);
	});
});

describe('crash during generation application', () => {
	it('rolls back to the parent when the single transaction is interrupted', () => {
		const store = seeded(5);
		store.crashOnTxn(1);
		expect(() => apply(store, record({ generation: 6 }))).toThrow(/interrupted/);

		// VALID AT 5, not "somewhere near 6": no statement landed and the position did not move
		expect(store.rows).toEqual([]);
		const pos = readPosition(store);
		expect(pos.applied).toBe(5);
		expect(positionTrust(pos).trusted).toBe(true);
	});

	it('leaves a CHUNKED apply untrusted rather than plausible', () => {
		const store = seeded(5);
		// four statements, two per transaction: marker, chunk, chunk. crash on the second chunk
		store.crashOnTxn(3);
		expect(() =>
			apply(
				store,
				record({
					generation: 6,
					statements: [{ sql: 'A' }, { sql: 'B' }, { sql: 'C' }, { sql: 'D' }]
				}),
				{ chunkSize: 2 }
			)
		).toThrow(/interrupted/);

		// the first chunk COMMITTED, so the database is between generations
		expect(store.rows).toEqual(['A', 'B']);
		const pos = readPosition(store);
		expect(pos.applied).toBe(5);
		const trust = positionTrust(pos);
		if (trust.trusted) throw new Error('an interrupted chunked apply reported itself trusted');
		expect(trust.reason).toContain('interrupted');
		// and the position it reports as valid is the honest one, not the one it was building
		expect(trust.validAt).toBe(5);
	});

	it('refuses every further record while a marker survives', () => {
		const store = seeded(5);
		store.crashOnTxn(3);
		expect(() =>
			apply(store, record({ generation: 6, statements: [{ sql: 'A' }, { sql: 'B' }] }), {
				chunkSize: 1
			})
		).toThrow();

		// including the very record it was applying, which is the tempting one to allow
		for (const g of [6, 7]) {
			const out = apply(store, record({ generation: g, parent: g - 1 }));
			expect(out.action).toBe('refuse');
			expect(out.reason).toContain('interrupted');
		}
	});

	it('clears the marker when a chunked apply completes', () => {
		const store = seeded(5);
		const out = apply(
			store,
			record({ generation: 6, statements: [{ sql: 'A' }, { sql: 'B' }, { sql: 'C' }] }),
			{ chunkSize: 1 }
		);
		expect(out.chunks).toBe(3);
		expect(readPosition(store).inflight).toBeNull();
		expect(positionTrust(readPosition(store)).trusted).toBe(true);
		expect(readPosition(store).applied).toBe(6);
	});
});

describe('duplicate generation', () => {
	it('skips a re-delivery rather than replaying it', () => {
		const store = seeded(6);
		const out = apply(store, record({ generation: 6 }));

		expect(out.action).toBe('duplicate');
		// THE ASSERTION THAT MATTERS. Record statements are not required to be idempotent: an
		// `UPDATE ... SET n = n + 1` is a legitimate authoritative write, and replaying one at a
		// generation already passed corrupts the state the log exists to carry
		expect(store.rows).toEqual([]);
		expect(readPosition(store).applied).toBe(6);
	});

	it('skips a record from well behind the applied position', () => {
		const store = seeded(20);
		expect(apply(store, record({ generation: 3 })).action).toBe('duplicate');
		expect(store.rows).toEqual([]);
	});
});

describe('out-of-order and missing generations', () => {
	it('refuses a record that builds on a generation already passed', () => {
		const store = seeded(10);
		const out = apply(store, record({ generation: 8, parent: 7 }));
		// generation 8 <= applied 10 reads as a duplicate first, which is the correct call: it is a
		// re-delivery of settled history and skipping it is safe
		expect(out.action).toBe('duplicate');

		// a record AHEAD whose parent is behind is the genuine out-of-order shape
		const ahead = apply(store, record({ generation: 11, parent: 4 }));
		expect(ahead.action).toBe('refuse');
		expect(ahead.reason).toContain('not one step');
	});

	it('refuses a gap rather than closing it', () => {
		const store = seeded(5);
		const out = apply(store, record({ generation: 9, parent: 8 }));
		expect(out.action).toBe('refuse');
		expect(out.reason).toContain('missing generation');
		expect(store.rows).toEqual([]);
		// still cleanly valid at 5; a refused record leaves nothing behind
		expect(positionTrust(readPosition(store))).toEqual({ trusted: true, validAt: 5 });
	});

	it('refuses a record whose own numbers do not agree', () => {
		const store = seeded(5);
		for (const bad of [
			record({ generation: 7, parent: 5 }),
			record({ generation: 6, parent: 6 }),
			record({ generation: Number.NaN, parent: 5 }),
			record({ generation: 6, parent: Number.POSITIVE_INFINITY })
		]) {
			expect(apply(store, bad).action, JSON.stringify(bad.generation)).toBe('refuse');
		}
		expect(store.rows).toEqual([]);
	});

	it('refuses a record with no fingerprint, which could never be verified', () => {
		const store = seeded(5);
		const out = apply(store, record({ generation: 6, fingerprint: '' }));
		expect(out.action).toBe('refuse');
		expect(out.reason).toContain('fingerprint');
	});
});

describe('schema mismatch', () => {
	it('refuses a record built at a different pack generation', () => {
		const store = seeded(5);
		const out = apply(store, record({ generation: 6, schemaVersion: '11.5.0' }));
		expect(out.action).toBe('refuse');
		expect(out.reason).toContain('schema mismatch');
		expect(store.rows).toEqual([]);
	});

	it('refuses when the replica does not know its own schema', () => {
		const store = seeded(5);
		// unknown is not agreement; the whole admission machine resolves an unknown toward the primary
		expect(apply(store, record({ generation: 6 }), { localSchema: null }).action).toBe(
			'refuse'
		);
	});

	it('refuses a schema mismatch ahead of the generation check', () => {
		// a wrong-schema record whose generations line up perfectly is the one a lazy order lets in
		const store = seeded(5);
		const out = planApply(readPosition(store), record({ generation: 6 }), '11.5.0');
		expect(out.action).toBe('refuse');
		expect(out.reason).toContain('schema');
	});
});

describe('eviction and deployment during catch-up', () => {
	/**
	 * Both are the same mechanical event -- the invocation stops mid-apply and the storage survives --
	 * and they differ in what comes back. An eviction returns the same code to the same state; a
	 * deployment can return different code, and the pack generation is what carries that.
	 */
	it('an eviction mid-chunk comes back untrusted and stays refusing', () => {
		const store = seeded(5);
		store.crashOnTxn(2);
		expect(() =>
			apply(store, record({ generation: 6, statements: [{ sql: 'A' }, { sql: 'B' }] }), {
				chunkSize: 1
			})
		).toThrow();

		// the object comes back: same storage, fresh read, no memory of what it was doing
		const revived = readPosition(store);
		expect(positionTrust(revived).trusted).toBe(false);
		expect(revived.applied).toBe(5);
		expect(apply(store, record({ generation: 6 })).action).toBe('refuse');
	});

	it('a deployment mid-chunk refuses on the interruption before it refuses on the schema', () => {
		const store = seeded(5);
		store.crashOnTxn(2);
		expect(() =>
			apply(store, record({ generation: 6, statements: [{ sql: 'A' }, { sql: 'B' }] }), {
				chunkSize: 1
			})
		).toThrow();

		// the object comes back on a new pack, so the record now MATCHES the schema. Both facts are
		// disqualifying and the interruption is the one that must be reported, because a schema that
		// agrees is exactly what would otherwise read as nothing being wrong
		const out = apply(store, record({ generation: 6, schemaVersion: '11.5.0' }), {
			localSchema: '11.5.0'
		});
		expect(out.action).toBe('refuse');
		expect(out.reason).toContain('interrupted');
	});

	it('an interruption BEFORE the first chunk leaves nothing to recover from', () => {
		const store = seeded(5);
		// transaction 1 is the marker write itself
		store.crashOnTxn(1);
		expect(() =>
			apply(store, record({ generation: 6, statements: [{ sql: 'A' }, { sql: 'B' }] }), {
				chunkSize: 1
			})
		).toThrow();

		// the marker rolled back with nothing applied, so the replica is cleanly at 5 and may retry
		expect(store.rows).toEqual([]);
		expect(positionTrust(readPosition(store))).toEqual({ trusted: true, validAt: 5 });
		expect(apply(store, record({ generation: 6 })).action).toBe('apply');
	});
});

describe('an unreadable position is not a zero', () => {
	it('refuses when the applied generation cannot be read', () => {
		const store = fakeStore();
		store.kv.set('repl_applied', 'not a number');
		const pos = readPosition(store);
		expect(positionTrust(pos).trusted).toBe(false);
		expect(apply(store, record({ generation: 1, parent: 0 })).action).toBe('refuse');
	});

	it('treats an unparseable marker as a marker', () => {
		const store = seeded(5);
		store.kv.set('repl_inflight', 'garbage');
		expect(positionTrust(readPosition(store)).trusted).toBe(false);
	});
});
