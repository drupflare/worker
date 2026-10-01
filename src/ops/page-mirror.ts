/**
 * Mirrors rendered pages to R2 so a custom domain can answer them without invoking the Worker.
 *
 * R2 reads are metered (10M Class B a month, 333,333/day against the 100,000/day Worker ceiling),
 * so mirror to the optimum, not everything: call `optimalOffWorker()` instead of hardcoding a
 * share. CDN absorption is zero until an operator adds a cache rule (Cloudflare decides HTML
 * eligibility by extension, so an origin `cache-control` cannot buy it back).
 *
 * @see scripts/measure/free-envelope.ts for the model this feeds
 * @see scripts/measure/cdn-absorption.ts for where its `cdnAbsorption` comes from
 * @module
 */
import type { MirrorBucket } from '../db/file-store';
import { firstRow } from '../util/sql';

/** the `cfw_page` columns a mirror needs, and nothing more */
export type MirrorablePage = {
	path: string;
	html: string;
	status: number;
	contentType: string;
};

/**
 * Minimal SQL surface, so the drain is drivable over a stand-in.
 * Non-generic like `FileSql`: a generic `exec<T>` does not accept the object's own `SqlStorage`.
 */
export type PageMirrorSql = {
	exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
};

/** the outcome of one drain pass */
export type PageMirrorDrain = {
	/** pages written to the bucket */
	mirrored: number;
	/** puts that threw */
	failed: number;
	/** tasks dropped because the page row is gone or is not a 200 */
	refused: number;
	/** true when no bucket is bound, which is the free-tier default rather than an error */
	noBucket?: boolean;
};

/**
 * The R2 key for one page.
 *
 * The generation is in the key, so invalidation is one counter bump instead of a Class A delete
 * per path; the orphans are swept via {@link staleGenerationPrefix}. The path is percent-encoded
 * because a raw `?` or `#` would make the object unaddressable over HTTP.
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

/** key prefix for a superseded generation, so a GC pass can list and delete it */
export function staleGenerationPrefix(site: string, generation: number): string {
	return `p/${site}/${generation}/`;
}

/** creates the queue (separate from the file mirror's: different keys and lifecycle) */
export function ensurePageMirrorTable(sql: PageMirrorSql): void {
	sql.exec(
		// without rowid: a TEXT primary key on a rowid table also charges an index row per insert
		`CREATE TABLE IF NOT EXISTS cfw_page_mirror_queue (
      path TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      queued_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    ) WITHOUT ROWID`
	);
}

/** queues one path for mirroring on fill, so queue depth tracks regeneration and not traffic */
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
 * Orders queued paths by views, most viewed first, so mirroring moves the head of traffic off the
 * Worker (queue order is fill recency, uncorrelated with popularity).
 *
 * Hits come from an in-memory map on the object, which costs no rows (a `hits` column would spend
 * the meter this lever protects) and is lost on eviction. A path with no hits sorts last, kept.
 */
export function orderByViews(
	paths: string[],
	hits: ReadonlyMap<string, number> | undefined
): string[] {
	if (!hits || hits.size === 0) return [...paths];
	return [...paths].sort((a, b) => (hits.get(b) ?? 0) - (hits.get(a) ?? 0));
}

/** how many mirror tasks are waiting */
export function pageMirrorDepth(sql: PageMirrorSql): number {
	ensurePageMirrorTable(sql);
	const row = firstRow(sql.exec('SELECT COUNT(*) AS c FROM cfw_page_mirror_queue'));
	return Number(row?.c ?? 0);
}

/** the strike count after which a task is dropped rather than retried forever */
export const MIRROR_STRIKES = 3;

/**
 * Pushes queued pages to R2, reading the html from `cfw_page` at drain time so a page re-rendered
 * since it was queued mirrors its current bytes.
 *
 * @param readPage - looks a path up in `cfw_page`; returns undefined when the row is gone
 */
export async function drainPageMirrors(
	sql: PageMirrorSql,
	bucket: MirrorBucket | undefined,
	readPage: (path: string) => MirrorablePage | undefined,
	opts: { limit?: number; site?: string; hits?: ReadonlyMap<string, number> } = {}
): Promise<PageMirrorDrain> {
	const out: PageMirrorDrain = { mirrored: 0, failed: 0, refused: 0 };
	if (!bucket) return { ...out, noBucket: true };

	ensurePageMirrorTable(sql);
	const site = opts.site ?? 'site';
	const limit = Math.max(1, Math.floor(opts.limit ?? 5));
	// read the whole queue and order by views before limiting (a `LIMIT` takes the oldest N)
	const queued = sql
		.exec('SELECT path, generation, attempts FROM cfw_page_mirror_queue ORDER BY queued_at')
		.toArray();
	const byPath = new Map(queued.map((t) => [String(t.path), t]));
	const tasks = orderByViews(
		queued.map((t) => String(t.path)),
		opts.hits
	)
		.slice(0, limit)
		.map((p) => byPath.get(p)!);

	for (const task of tasks) {
		const path = String(task.path);
		const page = readPage(path);
		// the row is gone, so this task can never mirror anything
		if (!page || page.status !== 200) {
			sql.exec('DELETE FROM cfw_page_mirror_queue WHERE path = ?', path);
			out.refused += 1;
			continue;
		}

		try {
			// explicit utf-8 bytes keep the contentType header honest
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
				// dropped, or a permanently failing task would starve the pages behind it
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
