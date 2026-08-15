/**
 * The table a write statement targets, or `null` when the statement writes nothing.
 *
 * Deliberately narrow. It recognises the five write forms Drupal's SQL generation actually emits and
 * returns `null` for everything else -- an unattributed write shows up as `null` in
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
 * A correction rather than an addition. `execSql()` is the only path
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
			// always on, and separate from the tally above. The tally is a
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
	// `Reflect.get` is called WITHOUT a receiver. `ctx.storage.sql` is a workerd host
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

/** One table's charged rows against the statements that caused them. */
export type Amplification = {
	table: string;
	/** write statements aimed at this table, including no-ops */
	statements: number;
	/** rows the host CHARGED for those statements */
	rowsWritten: number;
	/**
	 * charged rows per statement.
	 *
	 * Above 1 means something other than the row itself is being billed, and on DO SQLite that
	 * something is index maintenance: every index on a table is another row written per insert.
	 */
	factor: number;
};

/**
 * Charged rows per write statement, per table, largest factor first.
 *
 * The two counters this divides were already being collected, so the factor costs nothing new to
 * obtain. What it does NOT tell you is which index -- only that a table charges more than it stores,
 * which is the signal to go and look. A factor of 1.0 on a hot table means there is nothing to win
 * there, and that is worth knowing before touching a schema.
 *
 * A table with statements but zero charged rows reports a factor of 0 rather than being dropped: an
 * all-no-op table is a finding too, because the statements still cost CPU.
 */
export function amplification(tally: WriteTally): Amplification[] {
	const tables = new Set([
		...Object.keys(tally.statementsByTable),
		...Object.keys(tally.byTable)
	]);
	return [...tables]
		.map((table) => {
			const statements = tally.statementsByTable[table] ?? 0;
			const rowsWritten = tally.byTable[table] ?? 0;
			return {
				table,
				statements,
				rowsWritten,
				factor: statements > 0 ? rowsWritten / statements : 0
			};
		})
		.sort((a, b) => b.factor - a.factor || b.rowsWritten - a.rowsWritten);
}

/**
 * The share of a tally's charged rows that is NOT explained by one row per statement.
 *
 * **This is not the index share, and it is not an upper bound on it either.** An earlier docblock
 * here said it was, and the measurement falsified that: the recorded cold fill is 63 statements
 * against 12 charged rows, so `explained` clamps to 12 and this returns **0** for a fill that
 * `scripts/measure/index-audit.ts` decomposes as **9 of 12 rows index maintenance**. A write path
 * with more no-op statements than rows will always read 0 here and look index-free.
 *
 * What it does bound is the opposite direction -- rows that arrived from FEWER statements than rows,
 * which is a multi-row statement (`INSERT ... SELECT`, a `DELETE` clearing a bin) or a heavily
 * indexed insert. Useful for spotting a burst; useless for pricing an index. Use
 * `splitChargedRows()` with the schema's factors when the question is how much of a cost is index
 * maintenance.
 */
export function overheadShare(tally: WriteTally): number {
	if (tally.rowsWritten <= 0) return 0;
	const explained = Math.min(tally.statements, tally.rowsWritten);
	return (tally.rowsWritten - explained) / tally.rowsWritten;
}

/** one table's charged rows divided into what was stored and what was overhead */
export type ChargeSplit = {
	table: string;
	chargedRows: number;
	/** charged rows one stored row costs, from the schema */
	chargePerRow: number;
	dataRows: number;
	/**
	 * every charged row that is not the table row.
	 *
	 * Index entries, except on an AUTOINCREMENT table where one is the `sqlite_sequence` rewrite.
	 */
	indexRows: number;
	/** false when the charged total is not a whole multiple of the factor, or the factor is unknown */
	exact: boolean;
};

/**
 * Divides measured charged rows into data and index maintenance, given the schema's charge factors.
 *
 * The exact answer `overheadShare()` cannot give, and it needs an input that tally alone does not
 * carry: how many charged rows one stored row costs on each table. That comes from the schema --
 * `chargePerInsertedRow()` in `scripts/measure/index-audit.ts` derives it and
 * `tests/unit/db/index-charge-model.spec.ts` measures it against real Durable Object SQL.
 *
 * Reports `exact: false` rather than rounding when a table's total is not a whole multiple of its
 * factor. A non-integer means the writes were not all fresh single-row inserts, and rounding it away
 * would turn a wrong assumption about the statements into a confident number.
 */
export function splitChargedRows(
	charged: Record<string, number>,
	chargePerRow: Record<string, number>
): { rows: ChargeSplit[]; dataRows: number; indexRows: number; indexShare: number } {
	const rows: ChargeSplit[] = [];
	for (const [table, chargedRows] of Object.entries(charged)) {
		const factor = chargePerRow[table] ?? 0;
		const exactRows = factor > 0 ? chargedRows / factor : 0;
		const dataRows = Math.floor(exactRows);
		rows.push({
			table,
			chargedRows,
			chargePerRow: factor,
			dataRows,
			indexRows: chargedRows - dataRows,
			exact: factor > 0 && Number.isInteger(exactRows)
		});
	}
	const dataRows = rows.reduce((n, r) => n + r.dataRows, 0);
	const total = rows.reduce((n, r) => n + r.chargedRows, 0);
	return {
		rows,
		dataRows,
		indexRows: total - dataRows,
		indexShare: total > 0 ? (total - dataRows) / total : 0
	};
}
