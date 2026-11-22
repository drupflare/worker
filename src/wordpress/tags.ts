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
 * named and decided no page shows), or by an announced tag of a family that table feeds. When
 * every write to a table named its post ids (see {@link writtenRows}), only a `post:<id>` tag for
 * each of those ids covers it, so a tag announced for one post no longer covers a write to another.
 *
 * @param rows the ids each table was written at; absent or null means the family check applies
 */
export function uncoveredWrites(
	writes: ReadonlySet<string>,
	tags: ReadonlySet<string>,
	quiet: ReadonlySet<string>,
	wholesale: boolean,
	rows?: ReadonlyMap<string, ReadonlySet<number> | null>
): string[] {
	if (wholesale) return [];
	const families = new Set([...tags].map(familyOf));
	return [...writes].filter((entry) => {
		if (entry.startsWith('ddl:')) return true;
		if (quiet.has(entry)) return false;
		const ids = rows?.get(entry);
		if (ids !== undefined && ids !== null) {
			return [...ids].some((id) => !tags.has(`post:${id}`));
		}
		return !TABLE_FAMILIES[entry as ContentTable]?.some((family) => families.has(family));
	});
}

/** the tables whose written rows a statement can name, and the column that holds the post id */
const ROW_COLUMN: Readonly<Partial<Record<ContentTable, string>>> = {
	posts: 'ID',
	postmeta: 'post_id'
};

const MAX_NAMED_ROWS = 100;

/**
 * The post ids a write to `wp_posts` or `wp_postmeta` names, or undefined when it does not name
 * them in a shape that cannot be misread.
 *
 * Accepted: an `UPDATE` or `DELETE` of one table whose `WHERE` is a conjunction holding `ID = n`
 * (`post_id = n` for meta) or `ID IN (n, ...)`, and a single-row `INSERT` into `wp_posts`, whose id
 * is the one the database reported. An `OR`, a subselect, a join, a parenthesis outside an `IN`
 * list, `BETWEEN` or an upsert is undefined, and so is every other table. Extra `AND` terms only
 * narrow a write, so the listed ids are a superset of the rows it touched.
 *
 * @param sql the MySQL statement
 * @param reply what the database said about it
 * @param prefix the table prefix
 */
export function writtenRows(
	sql: string,
	reply: { insertId?: number; affected?: number },
	prefix: string = TABLE_PREFIX
): { table: ContentTable; ids: number[] } | undefined {
	const text = blanked(sql).replace(/`/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, '');
	if (/\b(SELECT|JOIN|UNION)\b/i.test(text)) return undefined;
	const tables = writtenTables(sql, prefix);
	const only = tables.length === 1 ? (tables[0] as ContentTable) : undefined;
	const column = only === undefined ? undefined : ROW_COLUMN[only];
	if (only === undefined || column === undefined) return undefined;
	const name = `${prefix}${only}`;

	const insert = new RegExp(
		`^(?:INSERT|REPLACE) (?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE) )*(?:INTO )?${name}\\b`,
		'i'
	).test(text);
	if (insert) {
		const id = reply.insertId ?? 0;
		return only === 'posts' &&
			reply.affected === 1 &&
			Number.isSafeInteger(id) &&
			id > 0 &&
			!/\bON DUPLICATE\b/i.test(text)
			? { table: only, ids: [id] }
			: undefined;
	}

	const update = new RegExp(
		`^UPDATE (?:(?:LOW_PRIORITY|IGNORE) )*${name} SET [^()]*? WHERE (.+)$`,
		'i'
	).exec(text);
	const remove = new RegExp(
		`^DELETE (?:(?:LOW_PRIORITY|QUICK|IGNORE) )*FROM ${name} WHERE (.+)$`,
		'i'
	).exec(text);
	const where = (update ?? remove)?.[1];
	if (where === undefined) return undefined;
	const condition = where.replace(/ (?:ORDER BY .*?)?(?:LIMIT \d+(?: OFFSET \d+)?)?$/i, '');
	const bare = condition.replace(/\bIN ?\( ?\d+(?: ?, ?\d+)* ?\)/gi, 'IN_LIST');
	if (/[()]|\bOR\b|\bBETWEEN\b|\bXOR\b/i.test(bare)) return undefined;
	const ids = new Set<number>();
	for (const term of condition.split(/ AND /i)) {
		const single = new RegExp(`^(?:${name}\\.)?${column} ?= ?(\\d+)$`, 'i').exec(term.trim());
		const many = new RegExp(
			`^(?:${name}\\.)?${column} IN ?\\( ?(\\d+(?: ?, ?\\d+)*) ?\\)$`,
			'i'
		).exec(term.trim());
		const found = single?.[1] ?? many?.[1];
		if (found === undefined) continue;
		for (const n of found.split(',')) ids.add(Number(n));
		break;
	}
	if (ids.size === 0 || ids.size > MAX_NAMED_ROWS) return undefined;
	return [...ids].every((n) => Number.isSafeInteger(n) && n > 0)
		? { table: only, ids: [...ids] }
		: undefined;
}

/** the rows each content table was written at in one run; null means a write that named none */
export type WrittenRows = Map<string, Set<number> | null>;

/**
 * Folds one successful write into a run's rows: the ids it named, or a null for each table it
 * touched without naming rows, which sends that table back to the family check.
 */
export function noteWrittenRows(
	rows: WrittenRows,
	tables: readonly string[],
	named: { table: string; ids: readonly number[] } | undefined
): void {
	for (const table of tables) {
		if (named === undefined || named.table !== table) {
			rows.set(table, null);
			continue;
		}
		const held = rows.get(table);
		if (held === null) continue;
		const ids = held ?? new Set<number>();
		for (const id of named.ids) ids.add(id);
		rows.set(table, ids);
	}
}
