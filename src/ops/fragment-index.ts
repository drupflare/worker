/**
 * Which fragment a cache tag reaches, and whether a fragment has changed at all.
 *
 * Indexes the shell tier (the BigPipe holes, each with its own cacheability); the anonymous
 * `cfw_page` tier has no placeholders to address. A fragment's bytes are never stored, since it is
 * personalised by construction; a row holds the address and tag list only. The address is
 * `sha256(plan + dependency values + generation)` and an unchanged address writes nothing, which
 * keeps repeat harvests (one per `(path, role, uid)`) from costing a row per fragment each time.
 * @module
 */
import { bytesToHex } from '../util/hex';

/** the reads and writes this module needs, narrowed so it stays drivable over a fake */
export interface FragmentSql {
	exec(sql: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** a tag and the invalidation counter Drupal keeps for it; the fragment's dependency values */
export type TagCounts = Record<string, number>;

/** one fragment as a harvest declares it, before it has an address */
export interface DeclaredFragment {
	/** the BigPipe placeholder id, which is the render array and is content-derived */
	id: string;
	/** the recipe: what this fragment renders, from `big_pipe_placeholders` */
	plan: unknown;
	/** the tags the fragment render bubbled, which the page's own metadata does not carry */
	tags: readonly string[];
}

/** one stored fragment row: where it sits, its content address and its tags */
export interface IndexedFragment {
	path: string;
	id: string;
	addr: string;
	tags: string[];
}

/** creates `cfw_fragment` and adds the `tags` column to `cfw_shell` when missing */
export function ensureFragmentTables(sql: FragmentSql): void {
	// without rowid: a TEXT primary key in a rowid table gets its own index (2 rows an insert)
	sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_fragment (
       path TEXT NOT NULL,
       id TEXT NOT NULL,
       addr TEXT NOT NULL,
       tags TEXT NOT NULL,
       indexed_at INTEGER NOT NULL,
       PRIMARY KEY (path, id)
     ) WITHOUT ROWID`
	);
	// check first, never attempt and catch: a failing `ALTER` dirties `sqlite_master` on every call
	// and took the serve path into `migrate: starting`
	const hasTags = sql
		.exec("SELECT name FROM pragma_table_info('cfw_shell')")
		.toArray()
		.some((r) => String(r['name']) === 'tags');
	if (!hasTags) sql.exec('ALTER TABLE cfw_shell ADD COLUMN tags TEXT');
}

/**
 * A stored tag list, or null when the row cannot speak for itself.
 *
 * Null is not an empty set: a shell stored before the column existed has no recorded dependencies,
 * so it answers null and {@link shellVerdict} drops it.
 */
export function readTagList(raw: unknown): string[] | null {
	if (raw === null || raw === undefined || raw === '') return null;
	try {
		const parsed: unknown = JSON.parse(String(raw));
		if (!Array.isArray(parsed)) return null;
		return parsed.map((t) => String(t));
	} catch {
		return null;
	}
}

/**
 * The invalidation counters Drupal holds for these tags.
 *
 * One full scan filtered here, not an `IN (...)`: a Durable Object statement takes at most 100
 * bound parameters. A tag with no row has never been invalidated and counts 0 (as in Drupal).
 */
export function dependencyValues(sql: FragmentSql, tags: readonly string[]): TagCounts {
	const out: TagCounts = {};
	for (const tag of tags) out[String(tag)] = 0;
	if (tags.length === 0) return out;
	let rows: Record<string, unknown>[];
	try {
		rows = sql.exec('SELECT tag, invalidations FROM cachetags').toArray();
	} catch {
		// a site whose Drupal tables are not migrated yet has invalidated nothing
		return out;
	}
	for (const row of rows) {
		const tag = String(row['tag']);
		if (tag in out) out[tag] = Number(row['invalidations'] ?? 0);
	}
	return out;
}

/**
 * The sum of a page's tags' invalidation counters, which is Drupal's own freshness test.
 *
 * Drupal's `DatabaseCacheTagsChecksum` compares a stored checksum against this same sum, so a page
 * whose sum has not moved was not invalidated. Compared at serve time it trades a write per
 * affected page for a read per served page (free allows 5,000,000 rows read a day against 100,000
 * written). Zero for a page with no recorded tags, which is not a usable checksum; callers must
 * tell that case apart.
 */
export function tagChecksum(sql: FragmentSql, tags: readonly string[]): number {
	if (tags.length === 0) return 0;
	const counts = dependencyValues(sql, tags);
	let sum = 0;
	for (const tag of tags) sum += Number(counts[String(tag)] ?? 0);
	return sum;
}

/** sorted, so a recipe that arrives with its keys in another order is the same fragment */
function canonical(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0
	);
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * A fragment's content address: `sha256(plan + dependency values + generation)`.
 *
 * The plan is what it renders, the dependency values are what it renders from (Drupal's own
 * invalidation counters), and the generation fences everything no tag describes.
 */
export async function fragmentAddress(input: {
	plan: unknown;
	deps: TagCounts;
	generation: number | string;
}): Promise<string> {
	const deps = Object.keys(input.deps)
		.sort()
		.map((tag) => `${tag}=${Number(input.deps[tag] ?? 0)}`)
		.join(',');
	const material = `${canonical(input.plan)}\n${deps}\n${String(input.generation)}`;
	return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
}

/** every fragment recorded for a path, or for the whole site when no path is given */
export function storedFragments(sql: FragmentSql, path?: string): IndexedFragment[] {
	const rows =
		path === undefined
			? sql.exec('SELECT path, id, addr, tags FROM cfw_fragment').toArray()
			: sql
					.exec('SELECT path, id, addr, tags FROM cfw_fragment WHERE path = ?', path)
					.toArray();
	return rows.map((r) => ({
		path: String(r['path']),
		id: String(r['id']),
		addr: String(r['addr']),
		tags: readTagList(r['tags']) ?? []
	}));
}

/**
 * Records this page's fragments, writing only the ones whose address moved.
 *
 * A fragment the harvest no longer declares is dropped (replace, not merge, as `indexPageTags()`
 * does), or a shrunken page would keep answering for a region it no longer has.
 */
export async function indexFragments(
	sql: FragmentSql,
	input: {
		path: string;
		generation: number | string;
		fragments: readonly DeclaredFragment[];
		nowMs: number;
	}
): Promise<{
	written: number;
	unchanged: number;
	dropped: number;
	addresses: Record<string, string>;
}> {
	const held = new Map(storedFragments(sql, input.path).map((f) => [f.id, f]));
	const addresses: Record<string, string> = {};
	let written = 0;
	let unchanged = 0;

	for (const fragment of input.fragments) {
		const tags = [...new Set(fragment.tags.map((t) => String(t)).filter((t) => t !== ''))];
		const addr = await fragmentAddress({
			plan: fragment.plan,
			deps: dependencyValues(sql, tags),
			generation: input.generation
		});
		addresses[fragment.id] = addr;
		const stored = held.get(fragment.id);
		held.delete(fragment.id);
		// an unchanged page writes nothing on re-harvest, which every new visitor to a path costs
		if (stored?.addr === addr) {
			unchanged++;
			continue;
		}
		sql.exec(
			`INSERT INTO cfw_fragment (path, id, addr, tags, indexed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path, id) DO UPDATE SET
         addr = excluded.addr,
         tags = excluded.tags,
         indexed_at = excluded.indexed_at`,
			input.path,
			fragment.id,
			addr,
			JSON.stringify(tags),
			input.nowMs
		);
		written++;
	}

	for (const gone of held.keys()) {
		sql.exec('DELETE FROM cfw_fragment WHERE path = ? AND id = ?', input.path, gone);
	}
	return { written, unchanged, dropped: held.size, addresses };
}

/**
 * The fragments these tags invalidate.
 *
 * The first half of `tag -> fragment -> pages`: a moved menu item stales the menu fragment, not
 * the breadcrumb beside it.
 */
export function dirtyFragments(sql: FragmentSql, tags: readonly string[]): IndexedFragment[] {
	if (tags.length === 0) return [];
	const wanted = new Set(tags.map((t) => String(t)));
	return storedFragments(sql).filter((f) => f.tags.some((t) => wanted.has(t)));
}

/** and the other half: the pages carrying a fragment these tags invalidate */
export function pagesWithDirtyFragments(sql: FragmentSql, tags: readonly string[]): string[] {
	return [...new Set(dirtyFragments(sql, tags).map((f) => f.path))].sort();
}

/** whether a shell is dropped, and why */
export type ShellVerdict = { drop: boolean; reason: string };

/**
 * Whether a save's tags reach a stored shell's own bytes.
 *
 * An unrecorded tag set drops (the shell cannot speak for itself). A tag on neither the shell nor a
 * fragment does not: `shellTags` is Drupal's own `cacheTags` for the render, so a tag outside it
 * cannot invalidate it, and dropping on one made the scoped purge behave like the wholesale one.
 * A tag only on a fragment does not drop either (`assembleFor()` renders every hole per request).
 */
export function shellVerdict(input: {
	invalidated: readonly string[];
	shellTags: readonly string[] | null;
	fragmentTags: readonly string[];
}): ShellVerdict {
	if (input.shellTags === null) {
		return { drop: true, reason: 'no recorded tags, so this shell cannot speak for itself' };
	}
	if (input.invalidated.length === 0) return { drop: false, reason: 'nothing invalidated' };
	const own = new Set(input.shellTags.map((t) => String(t)));
	const fragments = new Set(input.fragmentTags.map((t) => String(t)));
	for (const raw of input.invalidated) {
		const tag = String(raw);
		if (own.has(tag)) return { drop: true, reason: `the shell depends on ${tag}` };
	}
	const onFragment = input.invalidated.some((t) => fragments.has(String(t)));
	return {
		drop: false,
		reason: onFragment
			? 'every invalidated tag belongs to a fragment rendered per request'
			: 'no invalidated tag is on this shell'
	};
}

/**
 * Drops the shells a save reaches and leaves the rest assembling.
 *
 * Replaces a wholesale `DELETE FROM cfw_shell` on every invalidation, which stopped assembly at
 * the first content save on every site.
 */
export function purgeShellsForTags(
	sql: FragmentSql,
	tags: readonly string[]
): { dropped: number; kept: number; reasons: string[] } {
	if (tags.length === 0) return { dropped: 0, kept: 0, reasons: [] };
	const byPath = new Map<string, string[]>();
	for (const fragment of storedFragments(sql)) {
		const held = byPath.get(fragment.path) ?? [];
		held.push(...fragment.tags);
		byPath.set(fragment.path, held);
	}
	const rows = sql.exec('SELECT path, permissions_hash, tags FROM cfw_shell').toArray();
	let dropped = 0;
	let kept = 0;
	const reasons: string[] = [];
	for (const row of rows) {
		const path = String(row['path']);
		const verdict = shellVerdict({
			invalidated: tags,
			shellTags: readTagList(row['tags']),
			fragmentTags: byPath.get(path) ?? []
		});
		if (!verdict.drop) {
			kept++;
			continue;
		}
		const hash = String(row['permissions_hash']);
		sql.exec('DELETE FROM cfw_shell WHERE path = ? AND permissions_hash = ?', path, hash);
		sql.exec(
			'DELETE FROM cfw_shell_verified WHERE path = ? AND permissions_hash = ?',
			path,
			hash
		);
		dropped++;
		if (reasons.length < 8) reasons.push(`${path}: ${verdict.reason}`);
	}
	return { dropped, kept, reasons };
}
