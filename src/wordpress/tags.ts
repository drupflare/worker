/** the table prefix `wp-config.php` sets; the tables the host judges writes against */
export const TABLE_PREFIX = 'wp_';

/** the tables WordPress owns whose rows a page can show */
export const CONTENT_TABLES = [
	'posts',
	'postmeta',
	'terms',
	'term_taxonomy',
	'term_relationships',
	'termmeta',
	'comments',
	'commentmeta',
	'users',
	'usermeta',
	'options',
	'links'
] as const;

/** one name from {@link CONTENT_TABLES} */
export type ContentTable = (typeof CONTENT_TABLES)[number];

/**
 * The tag families that account for a write to each table: a write to the table with none of
 * these announced in the same run is a write nobody said anything about. `links` has none, so a
 * write to it is only ever covered by a wholesale purge.
 */
export const TABLE_FAMILIES: Readonly<Record<ContentTable, readonly string[]>> = {
	posts: ['post', 'posts'],
	postmeta: ['post', 'posts'],
	term_relationships: ['post', 'posts', 'term', 'terms'],
	terms: ['term', 'terms'],
	term_taxonomy: ['term', 'terms'],
	termmeta: ['term', 'terms'],
	comments: ['comments'],
	commentmeta: ['comments'],
	users: ['user', 'users'],
	usermeta: ['user', 'users'],
	options: ['option'],
	links: []
};

/** the most tags one announcement may carry; more is a wholesale purge */
export const MAX_ANNOUNCED_TAGS = 256;

/** what the emitter in the host plugin may send, after validation */
export type Announcement =
	| { op: 'announce'; tags: string[] }
	| { op: 'wholesale'; reason: string }
	| { op: 'quiet'; table: ContentTable }
	| { op: 'settle' };

const TAG = /^[a-z_]+(?::[A-Za-z0-9_.-]{1,64})?$/;

/** whether a string is a tag the emitter's grammar allows */
export function isTag(tag: unknown): tag is string {
	return typeof tag === 'string' && tag.length <= 80 && TAG.test(tag);
}

/** the family of a tag: the text before the colon, or the whole tag */
export function familyOf(tag: string): string {
	const at = tag.indexOf(':');
	return at < 0 ? tag : tag.slice(0, at);
}

/** a reason cut to a short, log-safe string */
export function safeReason(reason: unknown): string {
	return String(reason ?? '')
		.replace(/[^A-Za-z0-9:_.-]/g, '_')
		.slice(0, 48);
}

/**
 * Reads one request from the emitter. Anything malformed is `undefined`, which the caller answers
 * with a refusal; a refusal makes the emitter fall back to a wholesale purge.
 */
export function parseAnnouncement(raw: unknown): Announcement | undefined {
	if (raw === null || typeof raw !== 'object') return undefined;
	const body = raw as Record<string, unknown>;
	switch (body['op']) {
		case 'settle':
			return { op: 'settle' };
		case 'wholesale':
			return { op: 'wholesale', reason: safeReason(body['reason']) };
		case 'quiet': {
			const table = String(body['table'] ?? '');
			return (CONTENT_TABLES as readonly string[]).includes(table)
				? { op: 'quiet', table: table as ContentTable }
				: undefined;
		}
		case 'announce': {
			const tags = body['tags'];
			if (!Array.isArray(tags) || tags.length === 0 || tags.length > MAX_ANNOUNCED_TAGS) {
				return undefined;
			}
			return tags.every(isTag) ? { op: 'announce', tags: [...new Set(tags)] } : undefined;
		}
		default:
			return undefined;
	}
}

/** a statement with its string literals and comments blanked, so a table named in text is not read */
function blanked(sql: string): string {
	return sql
		.replace(/'(?:[^'\\]|\\.|'')*'/gs, "''")
		.replace(/"(?:[^"\\]|\\.|"")*"/gs, '""')
		.replace(/\/\*.*?\*\//gs, ' ');
}

/**
 * The content tables one MySQL statement writes, or `ddl:<table>` for a schema change, or empty
 * for anything that writes none.
 *
 * Over-reads on purpose: a write statement that names a content table anywhere (a subselect, a
 * join) counts as a write to it, because a miss would leave a stale page.
 */
export function writtenTables(sql: string, prefix: string = TABLE_PREFIX): string[] {
	const text = blanked(sql);
	const verb = /^[\s(]*([A-Za-z]+)/.exec(text)?.[1]?.toUpperCase() ?? '';
	const ddl = ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(verb);
	if (!ddl && !['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(verb)) return [];
	const out: string[] = [];
	for (const name of CONTENT_TABLES) {
		const table = `${prefix}${name}`;
		if (new RegExp(`(?<![A-Za-z0-9_$])\`?${table}\`?(?![A-Za-z0-9_$])`).test(text)) {
			out.push(ddl ? `ddl:${name}` : name);
		}
	}
	return out;
}

/**
 * The writes of one run that nothing announced.
 *
 * A write is covered by a wholesale purge, by a quiet mark for its table (a write the emitter
 * named and decided no page shows), or by an announced tag of a family that table feeds.
 */
export function uncoveredWrites(
	writes: ReadonlySet<string>,
	tags: ReadonlySet<string>,
	quiet: ReadonlySet<string>,
	wholesale: boolean
): string[] {
	if (wholesale) return [];
	const families = new Set([...tags].map(familyOf));
	return [...writes].filter((entry) => {
		if (entry.startsWith('ddl:')) return true;
		if (quiet.has(entry)) return false;
		return !TABLE_FAMILIES[entry as ContentTable]?.some((family) => families.has(family));
	});
}
