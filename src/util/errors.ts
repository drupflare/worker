/** `String(e?.message ?? e)` for any thrown value; an empty message stays empty. */
export function errorMessage(e: unknown): string {
	return String((e as { message?: unknown } | null | undefined)?.message ?? e);
}

/** whether SQLite refused a statement because its table does not exist yet */
export function isMissingTable(e: unknown): boolean {
	return /no such table/i.test(errorMessage(e));
}
