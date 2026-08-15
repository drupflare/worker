import { describe, expect, it } from 'vitest';
import {
	MIRROR_STRIKES,
	drainPageMirrors,
	ensurePageMirrorTable,
	orderByViews,
	pageMirrorDepth,
	pageMirrorKey,
	queuePageMirror,
	staleGenerationPrefix,
	type MirrorablePage,
	type PageMirrorSql
} from '../../../src/ops/page-mirror';

/** an in-memory stand-in: the drain's contract is the four statements it issues, not a real database */
function fakeSql(): PageMirrorSql & {
	rows: Map<string, { generation: number; attempts: number; queued: number }>;
} {
	const rows = new Map<string, { generation: number; attempts: number; queued: number }>();
	return {
		rows,
		exec<T>(query: string, ...b: unknown[]) {
			const q = query.replace(/\s+/g, ' ').trim();
			if (q.startsWith('CREATE TABLE')) return { toArray: () => [] as T[] };
			if (q.startsWith('INSERT INTO cfw_page_mirror_queue')) {
				rows.set(String(b[0]), {
					generation: Number(b[1]),
					queued: Number(b[2]),
					attempts: 0
				});
				return { toArray: () => [] as T[] };
			}
			if (q.startsWith('SELECT COUNT(*)')) {
				return { toArray: () => [{ c: rows.size }] as unknown as T[] };
			}
			if (q.startsWith('SELECT path, generation, attempts')) {
				// no LIMIT: the drain reads the whole queue and orders it by views before
				// taking its budget, because the oldest N is not the most-viewed N
				const out = [...rows.entries()]
					.sort((x, y) => x[1].queued - y[1].queued)
					.map(([path, r]) => ({ path, generation: r.generation, attempts: r.attempts }));
				return { toArray: () => out as unknown as T[] };
			}
			if (q.startsWith('DELETE FROM cfw_page_mirror_queue')) {
				rows.delete(String(b[0]));
				return { toArray: () => [] as T[] };
			}
			if (q.startsWith('UPDATE cfw_page_mirror_queue')) {
				const row = rows.get(String(b[2]));
				if (row) row.attempts = Number(b[0]);
				return { toArray: () => [] as T[] };
			}
			throw new Error(`unexpected query: ${q}`);
		}
	};
}

const page = (over: Partial<MirrorablePage> = {}): MirrorablePage => ({
	path: '/',
	html: '<!DOCTYPE html><p>hi</p>',
	status: 200,
	contentType: 'text/html; charset=utf-8',
	...over
});

describe('pageMirrorKey', () => {
	it('puts the generation in the key, so invalidation is a counter bump', () => {
		expect(pageMirrorKey('site', 7, '/about')).toBe('p/site/7/about.html');
		expect(pageMirrorKey('site', 8, '/about')).toBe('p/site/8/about.html');
	});

	it('resolves a directory-style path to index.html', () => {
		expect(pageMirrorKey('site', 1, '/')).toBe('p/site/1/index.html');
		expect(pageMirrorKey('site', 1, '/blog/')).toBe('p/site/1/blog/index.html');
	});

	it('tolerates a path with no leading slash', () => {
		expect(pageMirrorKey('site', 1, 'about')).toBe('p/site/1/about.html');
	});

	it('percent-encodes what would otherwise be unaddressable over HTTP', () => {
		// a raw ? or # would truncate the URL on a custom domain, which defeats the point
		expect(pageMirrorKey('site', 1, '/a?b')).toBe('p/site/1/a%3Fb.html');
		expect(pageMirrorKey('site', 1, '/a#b')).toBe('p/site/1/a%23b.html');
		expect(pageMirrorKey('site', 1, '/café')).toBe('p/site/1/caf%C3%A9.html');
	});

	it('keeps separators as separators rather than encoding them', () => {
		expect(pageMirrorKey('site', 1, '/a/b/c')).toBe('p/site/1/a/b/c.html');
	});

	it('gives a stale generation a listable prefix', () => {
		expect(staleGenerationPrefix('site', 7)).toBe('p/site/7/');
	});
});

describe('the queue', () => {
	it('records a path and reports its depth', () => {
		const sql = fakeSql();
		queuePageMirror(sql, '/', 1, 1000);
		queuePageMirror(sql, '/about', 1, 1001);
		expect(pageMirrorDepth(sql)).toBe(2);
	});

	it('re-queuing a path updates its generation instead of duplicating it', () => {
		const sql = fakeSql();
		queuePageMirror(sql, '/', 1, 1000);
		queuePageMirror(sql, '/', 2, 2000);
		expect(pageMirrorDepth(sql)).toBe(1);
		expect(sql.rows.get('/')?.generation).toBe(2);
	});

	it('creates its table without being asked twice', () => {
		const sql = fakeSql();
		expect(() => ensurePageMirrorTable(sql)).not.toThrow();
		expect(pageMirrorDepth(sql)).toBe(0);
	});
});

describe('drainPageMirrors', () => {
	it('reports noBucket rather than failing, because that is the free-tier default', async () => {
		const sql = fakeSql();
		queuePageMirror(sql, '/', 1, 1000);
		const out = await drainPageMirrors(sql, null, () => page());
		expect(out.noBucket).toBe(true);
		expect(out.mirrored).toBe(0);
		expect(pageMirrorDepth(sql)).toBe(1);
	});

	it('puts the page under its generation key and clears the task', async () => {
		const sql = fakeSql();
		queuePageMirror(sql, '/about', 4, 1000);
		const puts: { key: string; body: unknown; type?: string }[] = [];
		const bucket = {
			put: async (
				key: string,
				body: unknown,
				opts?: { httpMetadata?: { contentType?: string } }
			) => {
				puts.push({ key, body, type: opts?.httpMetadata?.contentType });
			}
		};
		const out = await drainPageMirrors(sql, bucket as never, () => page({ path: '/about' }), {
			site: 'demo'
		});
		expect(out.mirrored).toBe(1);
		expect(puts[0]!.key).toBe('p/demo/4/about.html');
		expect(puts[0]!.type).toBe('text/html; charset=utf-8');
		expect(pageMirrorDepth(sql)).toBe(0);
	});

	it('refuses a task whose page row is gone, and drops it', async () => {
		const sql = fakeSql();
		queuePageMirror(sql, '/gone', 1, 1000);
		const out = await drainPageMirrors(sql, { put: async () => {} } as never, () => null);
		expect(out.refused).toBe(1);
		expect(out.mirrored).toBe(0);
		expect(pageMirrorDepth(sql)).toBe(0);
	});

	it('refuses a non-200, so a warming placeholder is never published', async () => {
		const sql = fakeSql();
		queuePageMirror(sql, '/warm', 1, 1000);
		const out = await drainPageMirrors(sql, { put: async () => {} } as never, () =>
			page({ status: 503, html: 'warming\n' })
		);
		expect(out.refused).toBe(1);
		expect(out.mirrored).toBe(0);
	});

	it('honours the limit, so one alarm cannot spend the whole budget', async () => {
		const sql = fakeSql();
		for (let i = 0; i < 10; i++) queuePageMirror(sql, `/p${i}`, 1, 1000 + i);
		const out = await drainPageMirrors(sql, { put: async () => {} } as never, () => page(), {
			limit: 3
		});
		expect(out.mirrored).toBe(3);
		expect(pageMirrorDepth(sql)).toBe(7);
	});

	it('counts a failure and keeps the task for another pass', async () => {
		const sql = fakeSql();
		queuePageMirror(sql, '/', 1, 1000);
		const bucket = {
			put: async () => {
				throw new Error('r2 said no');
			}
		};
		const out = await drainPageMirrors(sql, bucket as never, () => page());
		expect(out.failed).toBe(1);
		expect(pageMirrorDepth(sql)).toBe(1);
		expect(sql.rows.get('/')?.attempts).toBe(1);
	});

	it('drops a task after its strikes rather than starving the queue behind it', async () => {
		const sql = fakeSql();
		queuePageMirror(sql, '/', 1, 1000);
		const bucket = {
			put: async () => {
				throw new Error('r2 said no');
			}
		};
		for (let i = 0; i < MIRROR_STRIKES; i++) {
			await drainPageMirrors(sql, bucket as never, () => page());
		}
		expect(pageMirrorDepth(sql)).toBe(0);
	});

	it('mirrors the CURRENT bytes, not the bytes queued', async () => {
		// the queue holds no copy on purpose: a page re-rendered between queue and drain must publish
		// what cfw_page says now
		const sql = fakeSql();
		queuePageMirror(sql, '/', 1, 1000);
		const puts: unknown[] = [];
		const bucket = { put: async (_k: string, body: unknown) => void puts.push(body) };
		await drainPageMirrors(sql, bucket as never, () => page({ html: 'rerendered' }));
		expect(new TextDecoder().decode(puts[0] as Uint8Array)).toBe('rerendered');
	});
});

describe('orderByViews', () => {
	it('puts the busiest paths first, because the optimum is a share of VIEWS', () => {
		const hits = new Map([
			['/', 900],
			['/about', 12],
			['/blog/post-1', 300]
		]);
		expect(orderByViews(['/about', '/blog/post-1', '/'], hits)).toEqual([
			'/',
			'/blog/post-1',
			'/about'
		]);
	});

	it('keeps queue order when nothing has been counted yet', () => {
		// a freshly evicted object has no counts; that is a reason to fall back, not to refuse
		expect(orderByViews(['/a', '/b'], new Map())).toEqual(['/a', '/b']);
		expect(orderByViews(['/a', '/b'], null)).toEqual(['/a', '/b']);
	});

	it('sorts an uncounted path last but never drops it', () => {
		const out = orderByViews(['/cold', '/hot'], new Map([['/hot', 5]]));
		expect(out).toEqual(['/hot', '/cold']);
		expect(out).toHaveLength(2);
	});

	it('does not mutate the caller array', () => {
		const paths = ['/a', '/b'];
		orderByViews(paths, new Map([['/b', 9]]));
		expect(paths).toEqual(['/a', '/b']);
	});
});

describe('the drain spends its budget on the busiest pages', () => {
	it('mirrors the most-viewed pages, NOT the oldest queued', async () => {
		// the failure this exists for: draining in queue order spends a limited budget on
		// whatever happened to be rendered first, which moves an unknown share of traffic
		const sql = fakeSql();
		queuePageMirror(sql, '/cold-1', 1, 1000);
		queuePageMirror(sql, '/cold-2', 1, 1001);
		queuePageMirror(sql, '/busy', 1, 9999);

		const puts: string[] = [];
		const bucket = { put: async (key: string) => void puts.push(key) };
		const out = await drainPageMirrors(sql, bucket as never, (p) => page({ path: p }), {
			limit: 1,
			hits: new Map([
				['/busy', 5_000],
				['/cold-1', 1]
			])
		});

		expect(out.mirrored).toBe(1);
		expect(puts[0]).toContain('/busy');
		// the two cold paths are still queued rather than discarded
		expect(pageMirrorDepth(sql)).toBe(2);
	});
});
