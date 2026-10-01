/**
 * Exact reads for SQLite integers wider than 2^53 (`ctx.storage.sql` returns lossy doubles).
 *
 * A second read wraps the original statement as a subquery and casts the suspect columns by output
 * name to TEXT, so no SQL parsing is needed. It fires only on detection (an integer a double
 * cannot hold), so an ordinary site never pays for it.
 * @module
 */

/**
 * The magnitude past which a JS number cannot be a truncated SQLite integer.
 * `2 ** 64`, not `2 ** 63`: rounding pushes `9223372036854775807` past the signed bound
 * (`9223372036854776000`), and unsigned 64-bit ids exist in contrib.
 */
const INT64_BOUND = 2 ** 64;

/** a result row, as the driver already treats every column value */
export type Row = Record<string, unknown>;

/**
 * Whether one value lost precision on the way out of SQLite.
 * The range guard keeps floats like `1e300` out of the cast path; an integral float inside the
 * bound is cast anyway, costing a spurious re-read, not a wrong value.
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
 * Whether a statement can be wrapped as a subquery: `SELECT` and `VALUES` only (`WITH` is skipped
 * as precedence-prone; `PRAGMA` and `EXPLAIN` are not subqueryable). Refusal keeps the lossy value.
 */
export function wrappable(sql: string): boolean {
	// leading comments and whitespace, then the first keyword
	const head = sql
		.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, '')
		.slice(0, 16)
		.toUpperCase();
	return head.startsWith('SELECT') || head.startsWith('VALUES');
}

/** the re-read statement: the original, with casts on the suspect columns and every column named */
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
 * Puts the exact digits back into the original rows, by position (the wrapper keeps the inner
 * `ORDER BY`). A length mismatch means something non-deterministic; the original rows return as is.
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
 * `reread` runs the wrapper statement with the same bindings; it is injected so the decision is
 * unit-testable without a Durable Object.
 */
export function repairWideIntegers(
	sql: string,
	rows: Row[],
	reread: (wrapped: string) => Row[]
): { rows: Row[]; repair?: WideRepair } {
	if (rows.length === 0) return { rows };
	const suspects = suspectColumns(rows);
	if (suspects.length === 0 || !wrappable(sql)) return { rows };

	const columns = Object.keys(rows[0] as Row);
	let exact: Row[];
	try {
		exact = reread(castingWrapper(sql, columns, suspects));
	} catch {
		// a refusal is the pre-existing behaviour, and this runs on the serving path
		return { rows };
	}
	const merged = mergeWide(rows, exact, suspects);
	return { rows: merged, repair: { columns: suspects, rows: merged.length } };
}
