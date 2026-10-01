/** The first row of a cursor, or undefined when it is empty. */
export function firstRow<T = Record<string, unknown>>(cursor: { toArray(): T[] }): T | undefined {
	return cursor.toArray()[0];
}

/** a TEXT or BLOB column read as a string; anything else is empty */
export function columnText(data: unknown): string {
	return typeof data === 'string'
		? data
		: data instanceof Uint8Array
			? new TextDecoder().decode(data)
			: '';
}
