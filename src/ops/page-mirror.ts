/**
 * Mirrors rendered pages to R2 so they can be answered without invoking the Worker.
 *
 * This is the serving-ceiling lever, and it is the only one worth more than 2x. Both existing page
 * tiers -- `caches.default` and the optional KV tier -- cost one Worker request each, because the
 * Worker has to run to consult them. A page answered from an R2 public bucket on a custom domain
 * costs none.
 *
 * The size of the win was overstated in this project for months. "Requests to static assets are free
 * and unlimited" describes Workers Static Assets, which are uploaded at deploy time and cannot hold a
 * page rendered at runtime. R2 is metered: **10M Class B operations per month** free, which is
 * 333,333/day against the 100,000/day Worker-request ceiling, so the floor is **3.3x** rather than the
 * 12.5x once quoted. Anything above that floor comes from Cloudflare's CDN absorbing reads in front of
 * the bucket, and that hit ratio is unmeasured. Writes are not the constraint: 1M Class A/month is
 * 33,333/day against a 7,575/day regeneration ceiling.
 *
 * MIRROR TO THE OPTIMUM, NOT TO EVERYTHING. Once R2's read meter binds, moving more traffic off the
 * Worker spends a 333,333/day meter faster to save a 100,000/day one, so the lever has a maximum
 * rather than a limit. **Do not hardcode a share -- call `optimalOffWorker()`** in
 * `scripts/measure/free-envelope.ts`, which derives it from the same model every other caller uses.
 * On the default mix at zero CDN absorption it computes 0.769 for 432,900 views/day, against 336,700
 * for mirroring everything: maximising gives up 96,200 views/day, a fifth of what the mirror is for.
 * Raising absorption does not walk that towards "mirror everything" either -- at absorption 1, where
 * R2 reads cannot bind, the peak lands at 0.888 and is bound by ROWS instead.
 *
 * @see scripts/measure/free-envelope.ts for the model this feeds
 */

import type { MirrorBucket } from '../db/file-store';

/** the `cfw_page` columns a mirror needs, and nothing more */
export type MirrorablePage = {
	path: string;
	html: string;
	status: number;
	contentType: string;
};

/**
 * Minimal SQL surface, so the drain is drivable over a stand-in.
 *
 * NON-GENERIC, matching `FileSql`: a generic `exec<T>` does not accept the Durable Object's own
 * `SqlStorage`, because `Record<string, SqlStorageValue>` cannot satisfy an arbitrary `T`. The
 * column shapes are asserted at the two read sites instead.
 */
export type PageMirrorSql = {
	exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
};

export type PageMirrorDrain = {
	mirrored: number;
	failed: number;
	refused: number;
	/** true when no bucket is bound, which is the free-tier default rather than an error */
	noBucket?: boolean;
};

/**
 * The R2 key for one page.
 *
 * THE GENERATION IS IN THE KEY, and that is the decision this module turns on. With it, invalidation
 * is a single counter bump -- every old key is simply never read again -- instead of one R2 delete per
 * path, which would be a Class A operation each and would have to enumerate the paths to delete. The
 * cost is orphaned objects, which {@link staleGenerationPrefix} exists to sweep. `site.ts` already
 * keys its edge cache the same way, so the two tiers agree.
 *
 * A path is percent-encoded rather than passed through: R2 keys tolerate most bytes, but a raw `?`
 * or `#` would make the object unaddressable over HTTP on a custom domain, which is the entire point
 * of putting it there.
 */
export function pageMirrorKey(site: string, generation: number, path: string): string {
	const clean = path.startsWith('/') ? path : `/${path}`;
	const encoded = clean
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
	// index.html so a directory-style path resolves on a static host
	const leaf = encoded.endsWith('/') ? `${encoded}index.html` : `${encoded}.html`;
	return `p/${site}/${generation}${leaf}`;
}

/** Key prefix for a generation that is no longer served, so a GC pass can list and delete it. */
export function staleGenerationPrefix(site: string, generation: number): string {
	return `p/${site}/${generation}/`;
}

/** Creates the queue. Separate from the file mirror's queue: different keys, different lifecycle. */
export function ensurePageMirrorTable(sql: PageMirrorSql): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_page_mirror_queue (
      path TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      queued_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )`
	);
}

/**
 * Queues one path for mirroring.
 *
 * Called on fill rather than on request: a page is mirrored because it was rendered, not because
 * somebody asked for it, so the queue depth tracks regeneration and not traffic.
 */
export function queuePageMirror(
	sql: PageMirrorSql,
	path: string,
	generation: number,
	nowMs: number
): void {
	ensurePageMirrorTable(sql);
	sql.exec(
		`INSERT INTO cfw_page_mirror_queue (path, generation, queued_at, attempts)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(path) DO UPDATE SET generation = excluded.generation, queued_at = excluded.queued_at`,
		path,
		Math.floor(generation),
		Math.floor(nowMs)
	);
}

/**
 * Orders queued paths by how much traffic mirroring each one actually moves off the Worker.
 *
 * THE OPTIMUM IS A SHARE OF VIEWS, NOT A COUNT OF PAGES, and draining in queue order confuses the
 * two. Queue order is roughly fill recency, which is uncorrelated with popularity, so mirroring the
 * first N queued pages moves an unknown share of traffic -- and the whole lever is worthless if it
 * moves the tail instead of the head.
 *
 * The hit counts come from an in-memory map on the Durable Object, incremented on the fast serve
 * lane. That costs ZERO rows, which matters because rows written is the meter this lever exists to
 * protect; a `hits` column would spend the meter to decide how to save it. The counts are lost on
 * eviction, which is fine: the heuristic restarts warm rather than wrong, and a path that is
 * genuinely popular re-earns its place within one alarm cycle.
 *
 * A path with no recorded hits sorts last but is NOT dropped -- it was rendered, so something asked
 * for it, and the counter may simply be younger than the page.
 */
export function orderByViews(paths: string[], hits: ReadonlyMap<string, number> | null): string[] {
	if (!hits || hits.size === 0) return [...paths];
	return [...paths].sort((a, b) => (hits.get(b) ?? 0) - (hits.get(a) ?? 0));
}

/** How many mirror tasks are waiting. */
export function pageMirrorDepth(sql: PageMirrorSql): number {
	ensurePageMirrorTable(sql);
	const row = sql.exec('SELECT COUNT(*) AS c FROM cfw_page_mirror_queue').toArray()[0];
	return Number(row?.c ?? 0);
}

/** The strike count after which a task is dropped rather than retried forever. */
export const MIRROR_STRIKES = 3;

/**
 * Pushes queued pages to R2.
 *
 * Reads the HTML out of `cfw_page` at drain time rather than storing a copy in the queue, so the
 * queue stays small and a page re-rendered between queue and drain mirrors its CURRENT bytes.
 *
 * @param readPage - looks a path up in `cfw_page`; returns null when the row is gone
 */
export async function drainPageMirrors(
	sql: PageMirrorSql,
	bucket: MirrorBucket | null | undefined,
	readPage: (path: string) => MirrorablePage | null,
	opts: { limit?: number; site?: string; hits?: ReadonlyMap<string, number> | null } = {}
): Promise<PageMirrorDrain> {
	const out: PageMirrorDrain = { mirrored: 0, failed: 0, refused: 0 };
	if (!bucket) return { ...out, noBucket: true };

	ensurePageMirrorTable(sql);
	const site = opts.site ?? 'site';
	const limit = Math.max(1, Math.floor(opts.limit ?? 5));
	// the whole queue is read and then ORDERED BY VIEWS before the limit is applied, because a
	// LIMIT in the query would take the oldest N and the oldest N is not the most-viewed N. The
	// queue is bounded by the fill rate, so this is a small read
	const queued = sql
		.exec('SELECT path, generation, attempts FROM cfw_page_mirror_queue ORDER BY queued_at')
		.toArray();
	const byPath = new Map(queued.map((t) => [String(t.path), t]));
	const tasks = orderByViews(
		queued.map((t) => String(t.path)),
		opts.hits ?? null
	)
		.slice(0, limit)
		.map((p) => byPath.get(p)!);

	for (const task of tasks) {
		const path = String(task.path);
		const page = readPage(path);
		// the row went away, so there is nothing to mirror and never will be for this task
		if (page === null || page.status !== 200) {
			sql.exec('DELETE FROM cfw_page_mirror_queue WHERE path = ?', path);
			out.refused += 1;
			continue;
		}

		try {
			// encoded here rather than handed over as a string: the bucket takes bytes, and being
			// explicit about UTF-8 is what makes the contentType header honest
			await bucket.put(
				pageMirrorKey(site, Number(task.generation), path),
				new TextEncoder().encode(page.html),
				{ httpMetadata: { contentType: page.contentType } }
			);
			sql.exec('DELETE FROM cfw_page_mirror_queue WHERE path = ?', path);
			out.mirrored += 1;
		} catch (cause) {
			const attempts = Number(task.attempts) + 1;
			const message = cause instanceof Error ? cause.message : String(cause);
			if (attempts >= MIRROR_STRIKES) {
				// dropped rather than retried forever: a permanently failing task would hold a slot
				// every pass and starve the pages behind it
				sql.exec('DELETE FROM cfw_page_mirror_queue WHERE path = ?', path);
			} else {
				sql.exec(
					'UPDATE cfw_page_mirror_queue SET attempts = ?, last_error = ? WHERE path = ?',
					attempts,
					message.slice(0, 200),
					path
				);
			}
			out.failed += 1;
		}
	}
	return out;
}
