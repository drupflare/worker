/** what an extension is: a module, a theme or an install profile */
export type ExtensionKind = 'module' | 'theme' | 'profile';

/** one extension as `/extensions` reports it */
export type ExtensionRow = {
	name: string;
	kind: ExtensionKind;
	/** the version the info file states; undefined in the input and null here when it has none */
	version: string | null;
	enabled: boolean;
};

const KINDS: readonly string[] = ['module', 'theme', 'profile'];

/** a code-unit comparison, so the order does not depend on the host's locale */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The rows of the extension script's reply, sorted by name then kind, or undefined when the reply
 * is not the shape the script writes. A row with an unknown kind or no name is a defect in the
 * script, so the whole reply is refused rather than the row dropped.
 */
export function extensionRows(reply: unknown): ExtensionRow[] | undefined {
	const list = (reply as { extensions?: unknown } | null | undefined)?.extensions;
	if (!Array.isArray(list)) return undefined;
	const rows: ExtensionRow[] = [];
	for (const item of list) {
		const row = item as Record<string, unknown> | null;
		if (
			typeof row?.['name'] !== 'string' ||
			row['name'] === '' ||
			typeof row['kind'] !== 'string' ||
			!KINDS.includes(row['kind']) ||
			typeof row['enabled'] !== 'boolean'
		) {
			return undefined;
		}
		const version = row['version'];
		rows.push({
			name: row['name'],
			kind: row['kind'] as ExtensionKind,
			version: typeof version === 'string' && version.trim() !== '' ? version : null,
			enabled: row['enabled']
		});
	}
	return rows.sort((a, b) => compare(a.name, b.name) || compare(a.kind, b.kind));
}
