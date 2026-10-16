/**
 * Binding a whole number so SQLite stores and compares it as an INTEGER.
 *
 * `ctx.storage.sql.exec()` binds every JavaScript number as a REAL and refuses a BigInt, so a PHP
 * `0` arrives as `0.0`. Against an INTEGER column that is invisible, because the column converts
 * it back. Against a TEXT column it is not: `varchar_col = 0.0` compares as `'0.0'` and matches
 * nothing, and an INSERT stores `'0.0'`. PostgreSQL and MySQL coerce an integer against a varchar,
 * and PDO's SQLite driver binds a PHP int as an INTEGER, so a module that keeps an enum ordinal in
 * a string field (mantle2's `field_visibility`) works on both and listed nothing here.
 *
 * `+CAST(? AS INTEGER)` is the form that fixes both directions. The cast makes the value an
 * INTEGER and the unary `+` strips the cast's affinity, so a TEXT column still has its own
 * affinity applied to the value (`'0'`) and its index is still usable.
 * @module
 */

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** a number or BigInt that the REAL binding would turn into a different type but not a different value */
export function isWholeNumber(value: unknown): boolean {
	if (typeof value === 'number') return Number.isSafeInteger(value);
	return typeof value === 'bigint' && value <= SAFE && value >= -SAFE;
}

/**
 * The statement with each positional `?` that will be bound to a whole number rewritten to
 * `+CAST(? AS INTEGER)`. Literals, quoted identifiers and comments are copied as they are.
 */
export function bindIntegers(text: string, values: readonly unknown[]): string {
	if (!values.some(isWholeNumber)) return text;
	let out = '';
	let slot = 0;
	let i = 0;
	while (i < text.length) {
		const c = text[i]!;
		if (c === "'" || c === '"' || c === '`') {
			const start = i++;
			while (i < text.length) {
				if (text[i] === c && text[i + 1] === c) {
					i += 2;
					continue;
				}
				if (text[i++] === c) break;
			}
			out += text.slice(start, i);
			continue;
		}
		if (c === '-' && text[i + 1] === '-') {
			const end = text.indexOf('\n', i);
			const stop = end === -1 ? text.length : end;
			out += text.slice(i, stop);
			i = stop;
			continue;
		}
		if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			const stop = end === -1 ? text.length : end + 2;
			out += text.slice(i, stop);
			i = stop;
			continue;
		}
		if (c === '?' && !/\d/.test(text[i + 1] ?? '')) {
			out += isWholeNumber(values[slot]) ? '+CAST(? AS INTEGER)' : '?';
			slot++;
			i++;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}
