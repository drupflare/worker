/**
 * Which fragment a cache tag reaches, and whether a fragment has changed at all.
 *
 * The `tag -> paths` index answers "which stored pages does this save invalidate". One level down
 * sits the question it cannot: most of a page is unchanged by most saves, and on an authenticated
 * render Drupal has already drawn the boundary -- every auto-placeholdered region is a BigPipe hole
 * with its OWN cacheability, and `Renderer::renderPlaceholder()` keeps that metadata out of the
 * response's.
 *
 * MEASURED ON THE SHIPPING PACK, which is what makes the split worth indexing. An anonymous render
 * of `/` carries 10 cache tags and zero holes; the authenticated harvest of the same path carries
 * **6** tags and 6 holes, and `local_task`, `config:system.menu.main` and `config:system.menu.account`
 * appear only on the fragments. So a menu-item save invalidates every anonymous page on the site and
 * touches no stored shell at all -- and today it drops every shell anyway, because
 * `bumpGeneration()` has nothing finer to consult.
 *
 * ## The anonymous page tier has no seam, and that is structural
 *
 * `cfw_page` stores cookieless GETs, and BigPipe only placeholders a request that has a session:
 * measured again here, a stored `/` row carries **zero** `data-big-pipe-placeholder-id` spans. There
 * is nothing on an anonymous page to address, so this indexes the SHELL tier, which has the holes.
 *
 * ## Nothing here stores a fragment's bytes
 *
 * A fragment is personalised by construction -- that is what a hole is for -- so a content-addressed
 * blob of one would be a store of one visitor's markup addressable by another, which is the
 * disclosure this project has already shipped once. The row carries the ADDRESS and the tag list,
 * never the markup, so the index has no reader to leak to.
 *
 * ## What the address costs, and why the generation is in it anyway
 *
 * The address is `sha256(plan + dependency values + generation)`, and an index pass whose address
 * matches the stored one writes NOTHING. The generation moves on every save, so a save does
 * re-address every fragment -- but re-indexing only happens at a HARVEST, and a harvest only happens
 * when a shell was dropped. What the check removes is the repeat: `verifyShellFor()` re-harvests once
 * per new `(path, role, uid)`, so a site with 50 editors re-indexes the same six fragments 50 times
 * per path. At one row each that is 300 rows for one page; with the address it is 6.
 */

/** the reads and writes this module needs, narrowed so it stays drivable over a fake */
export interface FragmentSql {
	exec(sql: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** a tag and the invalidation counter Drupal keeps for it; the fragment's dependency VALUES */
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

export interface IndexedFragment {
	path: string;
	id: string;
	addr: string;
	tags: string[];
}

export function ensureFragmentTables(sql: FragmentSql): void {
	// WITHOUT ROWID because a TEXT primary key in a rowid table gets its own unique index and charges
	// 2 rows an insert rather than 1, the same reason `cfw_shell_verified` is stored that way
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
	// CHECKED FIRST, NOT ATTEMPTED AND CAUGHT: a failing ALTER dirties `sqlite_master` on every call
	// the same way a CREATE TABLE does, and that took the serve path into `migrate: starting` on 2 of
	// 3 runs when `cfw_page.tags` was added
	const hasTags = sql
		.exec("SELECT name FROM pragma_table_info('cfw_shell')")
		.toArray()
		.some((r) => String(r['name']) === 'tags');
	if (!hasTags) sql.exec('ALTER TABLE cfw_shell ADD COLUMN tags TEXT');
}

/**
 * A stored tag list, or null when the row cannot speak for itself.
 *
 * NULL IS NOT AN EMPTY SET. A shell stored before the column existed has no recorded dependencies,
 * and a purge that skips it serves a visitor content they can see is wrong -- so it answers null and
 * {@link shellVerdict} drops the shell.
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
 * Read as one full scan and filtered here rather than through an `IN (...)`, which is what
 * `pathsForTags()` does and for the same two reasons: a Durable Object statement takes at most 100
 * bound parameters, and a page's tag set is not bounded by that.
 *
 * A tag with no row has never been invalidated, so it counts 0 -- a real value rather than a missing
 * one, and the value Drupal's own checksum would use.
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

const HEX = (buf: ArrayBuffer): string =>
	[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

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
 * All three, and each answers a different way the fragment can stop being what it was. The plan is
 * what it renders, the dependency values are what it renders FROM -- Drupal's own invalidation
 * counters, the same numbers a cache checksum is built out of -- and the generation is the fence for
 * everything no tag describes, which is why `bumpGeneration()` exists at all.
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
	return HEX(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
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
 * A fragment the harvest no longer declares is dropped, for the reason `indexPageTags()` replaces
 * rather than merges: a page whose fragment set SHRANK would otherwise keep answering for a region
 * it no longer has, and a save on that region's tag would keep a shell alive that should have gone.
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
		// THE WHOLE POINT OF THE ADDRESS. A re-harvest of an unchanged page writes nothing here, and
		// a re-harvest is what every new visitor to a shelled path costs
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
 * The half of `tag -> fragment -> pages` a save asks for first: a menu item moved, so the main menu
 * fragment is stale and the breadcrumb beside it is not.
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

export type ShellVerdict = { drop: boolean; reason: string };

/**
 * Whether a save's tags reach a stored shell's own bytes.
 *
 * REFUSES BY DEFAULT, the same asymmetry `shellSafety()` keeps and for the same reason: a shell kept
 * when it should have gone is a visitor reading content they can see is wrong, and a shell dropped
 * when it could have stayed is one harvest. So an unrecorded tag set drops, and a tag this page can
 * account for NOWHERE drops.
 *
 * A tag that belongs only to a FRAGMENT does not drop. The fragment is not stored -- `assembleFor()`
 * renders every hole on every request -- so the invalidation reaches it through Drupal's own render
 * cache on the next request, and the shell around it is unaffected.
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
		if (!fragments.has(tag)) {
			return { drop: true, reason: `${tag} is not accounted for on this page` };
		}
	}
	return {
		drop: false,
		reason: 'every invalidated tag belongs to a fragment rendered per request'
	};
}

/**
 * Drops the shells a save reaches and leaves the rest assembling.
 *
 * What it replaces is a wholesale `DELETE FROM cfw_shell` on every invalidation including
 * `cachetags` -- correct when nothing knew what a shell depended on, and the reason assembly stopped
 * at the first content save on every live site.
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
