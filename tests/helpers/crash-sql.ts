import type { SqlStorage } from '@gmitch215/folio/continuation';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

/**
 * A Durable Object's SQL handle over `node:sqlite` where a write survives a reset only once
 * `flush()` has returned. `reset()` drops every write since the last flush, as a killed event does,
 * and `beforeFlush` runs ahead of the commit so a test can kill the event at a chosen flush.
 *
 * It models the platform's rule (a write is durable once an await has passed it), not the platform.
 */
export function crashSql(db: DatabaseSync, hooks: { beforeFlush?: () => void } = {}) {
	const cache = new Map<string, StatementSync>();
	db.exec('BEGIN');
	const sql: SqlStorage = {
		exec(query, ...bindings) {
			const args = bindings.map((value) =>
				value instanceof ArrayBuffer ? new Uint8Array(value) : value
			);
			let statement = cache.get(query);
			if (!statement) cache.set(query, (statement = db.prepare(query)));
			const rows = /^\s*SELECT|RETURNING/i.test(query)
				? (statement.all(...args) as Record<string, unknown>[])
				: (statement.run(...args), []);
			return { toArray: () => rows };
		}
	};
	return {
		sql,
		async flush() {
			hooks.beforeFlush?.();
			db.exec('COMMIT');
			db.exec('BEGIN');
		},
		reset() {
			db.exec('ROLLBACK');
			db.exec('BEGIN');
		}
	};
}
