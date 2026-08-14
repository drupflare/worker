/**
 * The table a write statement targets, or `null` when the statement writes nothing.
 *
 * Deliberately narrow. It recognises the five write forms Drupal's SQL generation actually emits and
 * returns `null` for everything else rather than guessing -- an unattributed write shows up as `null` in
 * the tally, which is visible, where a wrong guess would silently move rows onto the wrong table and
 * corrupt the exact number the roadmap depends on.
 */
export function writeTargetTable(sql: string): string | null {
	const text = String(sql ?? '').trim();
	// `INSERT OR REPLACE INTO`, `INSERT OR IGNORE INTO`, `INSERT INTO`
	const insert = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["'`[]?([A-Za-z0-9_.]+)/i.exec(text);
	if (insert) return insert[1] as string;
	const update = /^UPDATE\s+(?:OR\s+\w+\s+)?["'`[]?([A-Za-z0-9_.]+)/i.exec(text);
	if (update) return update[1] as string;
	const del = /^DELETE\s+FROM\s+["'`[]?([A-Za-z0-9_.]+)/i.exec(text);
	if (del) return del[1] as string;
	const replace = /^REPLACE\s+INTO\s+["'`[]?([A-Za-z0-9_.]+)/i.exec(text);
	if (replace) return replace[1] as string;
	// DDL writes rows too (sqlite_master), and a migration is mostly DDL
	const create =
		/^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z0-9_.]+)/i.exec(
			text
		);
	if (create) return create[1] as string;
	return null;
}

export type WriteTally = {
	/** rows written per table, and `?unattributed` for a write whose target could not be parsed */
	byTable: Record<string, number>;
	/**
	 * write STATEMENTS per table, which rows alone cannot substitute for.
	 *
	 * Rows answer "how expensive", statements answer "how many times". The router rebuild is the
	 * case that forced this: a rebuild is one DELETE plus a fixed number of parameter-budgeted
	 * INSERTs, so statements-per-table divided by that fixed shape reads the number of REBUILDS
	 * directly. Inferring it from rows instead means dividing a measured total by a subtrahend
	 * nobody measured -- the exact error this project keeps finding.
	 *
	 * Counted for every write statement including no-ops, unlike `byTable`, because a statement
	 * that wrote nothing still happened.
	 */
	statementsByTable: Record<string, number>;
	statements: number;
	rowsWritten: number;
};

export function emptyTally(): WriteTally {
	return { byTable: {}, statementsByTable: {}, statements: 0, rowsWritten: 0 };
}

/**
 * Folds one statement's result in.
 *
 * A statement that wrote ZERO rows is still counted in `statements` but adds nothing to a table, because
 * the question is where the rows go and a no-op write is not where they go. Attribution failures land
 * under `?unattributed` rather than being dropped -- if that key ever carries a meaningful share, the
 * parser above is missing a form and the breakdown is not trustworthy.
 */
export function tallyWrite(tally: WriteTally, sql: string, rowsWritten: number): WriteTally {
	tally.statements += 1;
	const table = writeTargetTable(sql) ?? '?unattributed';
	// statements are counted even at zero rows; the statement still happened, and the rebuild
	// shape this reads is a count of statements rather than of rows
	tally.statementsByTable[table] = (tally.statementsByTable[table] ?? 0) + 1;
	const rows = Number.isFinite(rowsWritten) ? Math.max(0, rowsWritten) : 0;
	if (rows === 0) return tally;
	tally.rowsWritten += rows;
	tally.byTable[table] = (tally.byTable[table] ?? 0) + rows;
	return tally;
}

/** the shape of `ctx.storage.sql` this wrapper needs, narrowed so the module stays testable */
export type SqlLike = {
	exec(sql: string, ...bindings: unknown[]): { rowsWritten: number };
};

/**
 * Wraps `ctx.storage.sql` so the HOST's own writes land in the tally too.
 *
 * WHY THIS EXISTS, and it is a correction rather than an addition. `execSql()` is the only path
 * `tallyWrite()` was ever called from, and `execSql()` is the PHP driver's entry point -- so the
 * tally, and `this.rowsWritten` with it, could only ever see **Drupal's** statements. Every write
 * the host makes on its own behalf goes through `this.sql.exec()` directly and was invisible:
 * the `cfw_page` insert, the `cfw_fill_queue` delete, `cfw_meta`, the serve-table DDL.
 *
 * That is not a rounding error. The `cfw_page` insert carries the whole rendered page -- 12,304
 * bytes for the front page -- and `cfw_page` is indexed, so it is the single largest write in a
 * fill. A fill measured at "12 rows" through the old instrument reported **0** for the statement
 * that stores the product of the fill.
 *
 * Rows written is the meter that binds the regeneration ceiling, so an instrument that cannot see
 * the host's half cannot price the fill lane at all. Read-only statements pass through untouched
 * and are not counted: `rowsWritten` on a cursor mid-iteration is not a settled number, and a
 * write statement returns no rows, so reading it immediately is only safe for the write case.
 */
export function countingSql<T extends SqlLike>(
	sql: T,
	getTally: () => WriteTally | undefined,
	onWrite?: (rows: number) => void
): T {
	const wrapped: SqlLike = {
		exec(text: string, ...bindings: unknown[]) {
			const cursor = sql.exec(text, ...bindings);
			// a SELECT's cursor is a live iterator and reading rowsWritten here would consume
			// rows the caller is about to read, so the check comes first for both consumers
			const isWrite = writeTargetTable(text) !== null;
			if (!isWrite) return cursor;
			const rows = cursor.rowsWritten;
			// ALWAYS-ON and deliberately separate from the tally above. The tally is a
			// diagnostic -- it allocates a per-table map and is armed by a route. This is the
			// product meter: one addition per write statement, no allocation, so the daily
			// rows-written figure the Limits page shows is a real reading rather than a blank.
			onWrite?.(rows);
			const tally = getTally();
			if (tally) tallyWrite(tally, text, rows);
			return cursor;
		}
	};
	// the real object carries members beyond exec() (`databaseSize`, and the internals
	// `rowidOf`/`changesOf` reach for), so delegate rather than replace.
	//
	// `Reflect.get` is called WITHOUT a receiver on purpose. `ctx.storage.sql` is a workerd host
	// object whose accessors reject a `this` that is not the real object, so forwarding the proxy as
	// the receiver throws "Illegal invocation" on the first `databaseSize` read -- which is exactly
	// what 15 integration tests reported. Omitting it makes `target` the receiver.
	return new Proxy(sql, {
		get(target, prop) {
			if (prop === 'exec') return wrapped.exec;
			const value = Reflect.get(target, prop);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

/** the tally sorted heaviest-first, which is the only order worth reading it in */
export function rankTally(
	tally: WriteTally
): Array<{ table: string; rows: number; statements: number; share: number }> {
	const total = tally.rowsWritten;
	// union of both keys: a table can carry statements with zero rows, and dropping it would
	// hide a write path that ran and did nothing -- which is a finding, not a blank
	const tables = new Set([
		...Object.keys(tally.byTable),
		...Object.keys(tally.statementsByTable)
	]);
	return [...tables]
		.map((table) => ({
			table,
			rows: tally.byTable[table] ?? 0,
			statements: tally.statementsByTable[table] ?? 0,
			share: total > 0 ? (tally.byTable[table] ?? 0) / total : 0
		}))
		.sort((a, b) => b.rows - a.rows || b.statements - a.statements);
}

/**
 * How many full router rebuilds a tally represents, read from statements rather than rows.
 *
 * A rebuild is exactly one `DELETE FROM router` plus `ceil(routes / routesPerStatement)` inserts,
 * because `MatcherDumper::dump()` empties the table once and then re-inserts everything
 * (`core/lib/Drupal/Core/Routing/MatcherDumper.php:98-143`). Core chunks at 50 routes, which is
 * 300 bound parameters and over the Durable Object ceiling of 100, so the driver re-chunks to 16.
 *
 * Returns `null` rather than 0 when the shape does not divide cleanly: a fractional answer means
 * the assumed chunk size is wrong, and reporting "2.4 rebuilds" as 2 would launder that away.
 */
export function routerRebuildPasses(
	tally: WriteTally,
	routes: number,
	routesPerStatement = 16
): number | null {
	const statements = tally.statementsByTable['router'] ?? 0;
	if (statements === 0 || routes <= 0) return null;
	const perPass = 1 + Math.ceil(routes / routesPerStatement);
	const passes = statements / perPass;
	return Number.isInteger(passes) ? passes : null;
}
