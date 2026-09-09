import { describe, expect, it } from 'vitest';
import { freshSite, inObject } from '../helpers/serve-do';

/**
 * A content save purges the pages that depend on it, not the whole site.
 *
 * THE ARITHMETIC. A wholesale purge re-queues `PREFILL_ON_SAVE` paths per save, so a busy news site
 * at 50 saves/day spends ~2,750 fills against free's 2,777 -- 99% of the meter that decides whether
 * a site fits on free at all. A node save's real dependency set is the node page plus the listings
 * that carry it, 3 to 10 pages, so the same site spends about 9% instead.
 *
 * BOTH HALVES, because a purge that removes nothing passes a test that only checks the first: the
 * related pages have to go AND the unrelated ones have to survive.
 */

const TIMEOUT = 600_000;

type Site = {
	sql: {
		exec: (q: string, ...args: unknown[]) => { toArray: () => Array<Record<string, unknown>> };
	};
	ensureServeTables: () => void;
	nowMs: () => number;
	indexPageTags: (path: string, tags: unknown) => void;
	pathsForTags: (tags: readonly string[]) => string[] | null;
	purgeForTags: (
		tags: readonly string[],
		reason?: string,
		opts?: { bump?: boolean }
	) => Record<string, unknown>;
	notePendingTags: (tags: readonly string[]) => void;
	pendingTags: () => string[];
	drainPendingTags: () => { tags: number; purged: number } | null;
};

/** stores a page with a declared tag set, the way a fill does */
function store(site: Site, path: string, tags: string[]): void {
	site.ensureServeTables();
	site.sql.exec(
		`INSERT INTO cfw_page (path, status, content_type, html, rendered_at, render_ms, tags)
     VALUES (?, 200, 'text/html', ?, ?, 1, ?)
     ON CONFLICT(path) DO UPDATE SET tags = excluded.tags`,
		path,
		`<html>${path}</html>`,
		site.nowMs(),
		JSON.stringify(tags)
	);
}

const paths = (site: Site): string[] =>
	site.sql
		.exec('SELECT path FROM cfw_page ORDER BY path')
		.toArray()
		.map((r) => String(r.path));

const queued = (site: Site): string[] =>
	site.sql
		.exec('SELECT path FROM cfw_fill_queue ORDER BY path')
		.toArray()
		.map((r) => String(r.path));

describe('a scoped purge removes the dependent pages and nothing else', () => {
	it(
		'purges the pages that carry the tag and leaves the ones that do not',
		async () => {
			const stub = freshSite();
			const out = await inObject(stub, (raw) => {
				const site = raw as unknown as Site;
				store(site, '/node/1', ['node:1', 'node_list']);
				store(site, '/news', ['node_list']);
				store(site, '/about', ['config:system.site']);
				const result = site.purgeForTags(['node:1', 'node_list'], 'cachetags', {
					bump: false
				});
				return { result, remaining: paths(site), queued: queued(site) };
			});
			expect((out.result as Record<string, unknown>).scoped).toBe(true);
			// the related ones went
			expect(out.remaining).toEqual(['/about']);
			// AND the unrelated one survived, which is the half a purge that removes nothing passes
			expect(out.remaining).toContain('/about');
			// what was purged is what was re-queued, so nothing is lost
			expect(out.queued).toEqual(['/news', '/node/1']);
		},
		TIMEOUT
	);

	it(
		'answers null and purges wholesale when any stored page has no recorded tags',
		async () => {
			const stub = freshSite();
			const out = await inObject(stub, (raw) => {
				const site = raw as unknown as Site;
				store(site, '/node/1', ['node:1']);
				// a page stored before the column existed; one is enough to make the whole answer
				// unsafe, and a scoped purge that misses shows a visitor content they can see is wrong
				site.sql.exec(
					`INSERT INTO cfw_page (path, status, content_type, html, rendered_at, render_ms)
           VALUES ('/legacy', 200, 'text/html', '<html/>', ?, 1)`,
					site.nowMs()
				);
				const scopedTo = site.pathsForTags(['node:1']);
				const result = site.purgeForTags(['node:1'], 'cachetags', { bump: false });
				return { scopedTo, result, remaining: paths(site) };
			});
			expect(out.scopedTo).toBeNull();
			expect((out.result as Record<string, unknown>).scoped).toBe(false);
			expect(out.remaining).toEqual([]);
		},
		TIMEOUT
	);

	it(
		'tells a page that depends on nothing from one that was never indexed',
		async () => {
			const stub = freshSite();
			const answer = await inObject(stub, (raw) => {
				const site = raw as unknown as Site;
				// declares an EMPTY set, which is a real answer and not an absent one
				store(site, '/static', []);
				return site.pathsForTags(['node:1']);
			});
			expect(answer).toEqual([]);
		},
		TIMEOUT
	);

	it(
		'refuses to scope against an empty tag set',
		async () => {
			const stub = freshSite();
			const answer = await inObject(stub, (raw) => {
				const site = raw as unknown as Site;
				store(site, '/node/1', ['node:1']);
				return site.pathsForTags([]);
			});
			expect(answer).toBeNull();
		},
		TIMEOUT
	);
});

describe('the pending set is durable, so a dead invocation still purges', () => {
	it(
		'records what is owed and settles it on the next drain',
		async () => {
			const stub = freshSite();
			const out = await inObject(stub, (raw) => {
				const site = raw as unknown as Site;
				store(site, '/node/1', ['node:1']);
				store(site, '/about', ['config:system.site']);
				// what the WRITE records, before any flush has run
				site.notePendingTags(['node:1']);
				const owed = site.pendingTags();
				// the invocation dies here; the next one drains
				const drained = site.drainPendingTags();
				return { owed, drained, remaining: paths(site), after: site.pendingTags() };
			});
			expect(out.owed).toEqual(['node:1']);
			expect(out.drained).not.toBeNull();
			expect(out.remaining).toEqual(['/about']);
			// and it is forgotten, so the next boot does not purge again
			expect(out.after).toEqual([]);
		},
		TIMEOUT
	);

	it(
		'is a no-op when nothing is owed',
		async () => {
			const stub = freshSite();
			const drained = await inObject(stub, (raw) => {
				const site = raw as unknown as Site;
				site.ensureServeTables();
				return site.drainPendingTags();
			});
			expect(drained).toBeNull();
		},
		TIMEOUT
	);

	it(
		'accumulates the tags of one invocation rather than keeping only the last',
		async () => {
			// a node save writes `node:3:revisions` before `node_list`; collecting only the first is
			// what made tag-scoped purging fail open
			const stub = freshSite();
			const owed = await inObject(stub, (raw) => {
				const site = raw as unknown as Site;
				site.ensureServeTables();
				site.notePendingTags(['node:3:revisions']);
				site.notePendingTags(['node_list']);
				return site.pendingTags();
			});
			expect(owed).toEqual(['node:3:revisions', 'node_list']);
		},
		TIMEOUT
	);
});
