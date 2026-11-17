import { DatabaseSync } from 'node:sqlite';

import type { SqlCursor, SqlRun } from '../../src/db/sql/exec';

/** a `SqlRun` over `node:sqlite`, with the cursor shape of a Durable Object's `sql.exec` */
export function sqliteRun(db: DatabaseSync): SqlRun {
	return (sql, ...params) => {
		const stmt = db.prepare(sql);
		const columnNames = stmt.columns().map((c) => c.name);
		let rows: unknown[][] = [];
		let written = 0;
		if (columnNames.length > 0) {
			stmt.setReturnArrays(true);
			rows = stmt.all(...(params as never[])) as unknown as unknown[][];
		} else {
			written = Number(stmt.run(...(params as never[])).changes);
		}
		const cursor: SqlCursor = {
			columnNames,
			raw: () => ({ toArray: () => rows }),
			rowsRead: rows.length,
			rowsWritten: written
		};
		return cursor;
	};
}

/** an in-memory database and its runner, with a `transactionSync` stand-in */
export function memoryDatabase(): {
	db: DatabaseSync;
	run: SqlRun;
	atomic: <T>(fn: () => T) => T;
} {
	const db = new DatabaseSync(':memory:');
	return {
		db,
		run: sqliteRun(db),
		atomic: <T>(fn: () => T): T => {
			db.exec('BEGIN');
			try {
				const out = fn();
				db.exec('COMMIT');
				return out;
			} catch (e) {
				db.exec('ROLLBACK');
				throw e;
			}
		}
	};
}
