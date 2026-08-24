/**
 * Exact reads for SQLite INTEGERs wider than 2^53.
 *
 * ## What is actually broken
 *
 * `ctx.storage.sql` hands INTEGER columns back as JavaScript numbers, so a value above
 * `Number.MAX_SAFE_INTEGER` has already lost precision before anything in this project sees it.
 * Re-measured 2026-08-23 on workerd, unchanged from the first reading:
 *
 * | written               | read back             | `CAST(col AS TEXT)`   |
 * | --------------------- | --------------------- | --------------------- |
 * | `9007199254740993`   | `9007199254740992`   | `9007199254740993`   |
 * | `9223372036854775807` | `9223372036854776000` | `9223372036854775807` |
 *
 * The storage is exact and the READ is lossy. The codec cannot help: by the time it runs the value
 * is already a wrong double, and the `__phpint` envelope then carries the wrong number faithfully.
 *
 * ## Why this needs no SQL parser, which is what the item assumed
 *
 * The backlog scoped this as "the driver knows the schema, so it can rewrite `SELECT id` to a text
 * cast for columns declared wide", and then listed the shapes such a rewrite has to survive --
 * `SELECT *`, aliases, expressions, JOINs, `ORDER BY`, aggregates. That is a SQL parser, and it
 * would cover the shapes it was written for and silently miss the rest.
 *
 * It is unnecessary. **The result rows already carry the output column names**, whatever produced
 * them, so the exact values can be fetched by wrapping the ORIGINAL statement as a subquery and
 * casting by name:
 *
 * ```sql
 * SELECT "a", CAST("b" AS TEXT) AS "b" FROM ( <the original statement, untouched> )
 * ```
 *
 * The inner statement keeps full 64-bit precision inside SQLite; only the outer projection crosses
 * into JavaScript, and it crosses as TEXT. Aliases, aggregates and `SELECT *` all resolve to output
 * names before this sees them, so every shape is covered by construction rather than by enumeration.
 *
 * ## And it costs nothing when nothing is wide
 *
 * Triggered by DETECTION, never by schema: the second read happens only when a returned value is an
 * integer that a double cannot represent exactly. Drupal core never stores integers that wide, so on
 * an ordinary site this never fires at all.
 */

/**
 * The magnitude past which a JS number cannot be a truncated SQLite INTEGER at all.
 *
 * `2 ** 64` rather than `2 ** 63`, and the extra bit is not slack. Rounding pushes a wide value
 * PAST the signed bound on the way into a double -- measured, `9223372036854775807` arrives as
 * `9223372036854776000`, which is larger than `2 ** 63` and would be excluded by the tighter
 * guard. This bound also covers an unsigned 64-bit id, which contrib does store.
 */
const INT64_BOUND = 2 ** 64;

/** what the driver already does to every column value, so a string here changes nothing downstream */
export type Row = Record<string, unknown>;

/**
 * Whether one value lost precision on the way out of SQLite.
 *
 * `Number.isInteger` alone is not enough -- `1e300` satisfies it and is a REAL, not a truncated
 * integer -- so the range guard is what keeps a float out of the cast path. An integral REAL that
 * does fall inside the bound is cast anyway; it comes back as its own text form, which is what the
 * driver stringifies it to regardless, so the cost is a spurious re-read rather than a wrong value.
 */
export function isLossyInteger(value: unknown): boolean {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		!Number.isSafeInteger(value) &&
		Math.abs(value) < INT64_BOUND
	);
}

/** the output columns that carry at least one value a double could not hold */
export function suspectColumns(rows: readonly Row[]): string[] {
	const suspects = new Set<string>();
	for (const row of rows) {
		for (const [name, value] of Object.entries(row)) {
			if (isLossyInteger(value)) suspects.add(name);
		}
	}
	return [...suspects];
}

/** SQLite quoting: a double quote inside an identifier is doubled */
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Whether a statement can be wrapped as a subquery at all.
 *
 * `WITH` is excluded rather than handled: a CTE is legal inside a subquery in SQLite but the
 * precedence is easy to get wrong, and nothing in this project issues one that returns a wide id.
 * `PRAGMA` and `EXPLAIN` return rows and are not subqueryable. Anything refused here keeps the
 * lossy value it already had, which is the behaviour before this file existed.
 */
export function wrappable(sql: string): boolean {
	// leading comments and whitespace, then the first keyword
	const head = sql
		.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, '')
		.slice(0, 16)
		.toUpperCase();
	return head.startsWith('SELECT') || head.startsWith('VALUES');
}

/**
 * The re-read: the original statement, projected through casts for the suspect columns.
 *
 * Every output column is named explicitly so the row shape is preserved exactly -- dropping the
 * unaffected ones would hand the caller a different result set than it asked for.
 */
export function castingWrapper(
	sql: string,
	columns: readonly string[],
	suspects: readonly string[]
): string {
	const wide = new Set(suspects);
	const projection = columns
		.map((name) =>
			wide.has(name) ? `CAST(${quote(name)} AS TEXT) AS ${quote(name)}` : quote(name)
		)
		.join(', ');
	// the trailing semicolon has to go: `FROM (SELECT 1;)` is a syntax error
	return `SELECT ${projection} FROM (${sql.trim().replace(/;\s*$/, '')})`;
}

/**
 * Puts the exact digits back into the original rows.
 *
 * BY POSITION, because the wrapper preserves the inner statement's own ordering -- including its
 * `ORDER BY` -- so row `i` of the re-read is row `i` of the first read. A length mismatch means
 * something non-deterministic sits between the two reads, and the original rows are returned
 * unchanged rather than merged into the wrong order.
 */
export function mergeWide(rows: Row[], exact: readonly Row[], suspects: readonly string[]): Row[] {
	if (exact.length !== rows.length) return rows;
	return rows.map((row, i) => {
		const source = exact[i];
		if (!source) return row;
		const merged: Row = { ...row };
		for (const name of suspects) {
			const value = source[name];
			if (typeof value === 'string') merged[name] = value;
		}
		return merged;
	});
}

/** what a repair did, so `/writes` can report a cost that is otherwise invisible */
export type WideRepair = { columns: string[]; rows: number };

/**
 * Repairs one result set, or reports that nothing needed repairing.
 *
 * `reread` runs the wrapper statement with the SAME bindings; it is injected rather than taken from
 * a handle so the whole decision is drivable from a unit test with no Durable Object.
 */
export function repairWideIntegers(
	sql: string,
	rows: Row[],
	reread: (wrapped: string) => Row[]
): { rows: Row[]; repair: WideRepair | null } {
	if (rows.length === 0) return { rows, repair: null };
	const suspects = suspectColumns(rows);
	if (suspects.length === 0 || !wrappable(sql)) return { rows, repair: null };

	const columns = Object.keys(rows[0] as Row);
	let exact: Row[];
	try {
		exact = reread(castingWrapper(sql, columns, suspects));
	} catch {
		// a refusal is the pre-existing behaviour, and this runs on the serving path
		return { rows, repair: null };
	}
	const merged = mergeWide(rows, exact, suspects);
	return { rows: merged, repair: { columns: suspects, rows: merged.length } };
}
