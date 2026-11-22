import { describe, expect, it } from 'vitest';
import {
	contractMsFor,
	digest,
	expectation,
	frontPage,
	judgeAnswer,
	judgeContract,
	judgeError,
	judgePrivate,
	judgeQuietWrite,
	judgeStore,
	MAX_ROWS,
	type Model,
	OPERATIONS,
	pick,
	prng,
	sameStable,
	spread,
	tokensOf,
	undated,
	WRITES
} from '../../scripts/wp/cache-soak-core';

const model = (): Model => ({
	blogname: 'Soak Site',
	theme: 'twentytwentyfive',
	themeShows: true,
	posts: [
		{
			id: 1,
			title: 'Hello world!',
			route: '/hello/',
			status: 'publish',
			category: 1,
			comments: []
		},
		{
			id: 2,
			title: 'Tk0002',
			route: '/a/',
			status: 'publish',
			category: 1,
			comments: ['Cm0001']
		},
		{ id: 3, title: 'Tk0003', route: '/b/', status: 'publish', category: 1, comments: [] },
		{ id: 4, title: 'Tk0004', route: '/c/', status: 'trash', category: 1, comments: [] },
		{ id: 5, title: 'Tk0005', route: '/d/', status: 'draft', category: 1, comments: [] }
	],
	categories: new Map([[1, { name: 'Uncategorized', slug: 'uncategorized' }]]),
	secrets: ['SECRET-1'],
	gone: ['OldTitle'],
	lastComment: 'Cm0001'
});

const page = (m: Model, ...inside: string[]) =>
	`<title>${m.blogname}</title><link href="/themes/${m.theme}/style.css">${inside.join(' ')}`;

describe('the cache soak', () => {
	it('draws the same operations from one seed and different ones from another', () => {
		const draw = (seed: number) => {
			const roll = prng(seed);
			return Array.from({ length: 200 }, () => pick(OPERATIONS, roll()).kind).join();
		};
		expect(draw(7)).toBe(draw(7));
		expect(draw(7)).not.toBe(draw(8));
		expect(new Set(draw(7).split(','))).toEqual(new Set(OPERATIONS.map((o) => o.kind)));
	});

	it('weights what it draws', () => {
		const roll = prng(3);
		const counts: Record<string, number> = {};
		for (let i = 0; i < 20_000; i++) {
			const kind = pick(OPERATIONS, roll()).kind;
			counts[kind] = (counts[kind] ?? 0) + 1;
		}
		for (const op of OPERATIONS) {
			expect(counts[op.kind]! / 20_000).toBeGreaterThan(op.weight / 100 - 0.02);
			expect(counts[op.kind]! / 20_000).toBeLessThan(op.weight / 100 + 0.02);
		}
		expect(OPERATIONS.reduce((s, o) => s + o.weight, 0)).toBe(100);
		expect(WRITES.length).toBe(10);
	});

	it('expects no title that left, and leaves the order of a listing to a fresh render', () => {
		const m = model();
		expect(frontPage(m).map((p) => p.id)).toEqual([3, 2, 1]);
		const want = expectation(m, '/');
		expect(want.present).toEqual(['Soak Site', 'Tk0003', 'Tk0002', 'Hello world!']);
		expect(tokensOf('<b>Tkabcdef12</b> Tk12345678 Tkabcdef12')).toBe('Tk12345678,Tkabcdef12');
		expect(want.absent).toEqual(expect.arrayContaining(['OldTitle', 'Tk0004', 'Tk0005']));
		expect(expectation(m, '/c/').status).toBe(404);
		expect(expectation(m, '/a/').present).toEqual(
			expect.arrayContaining(['Cm0001', 'Uncategorized'])
		);
		expect(expectation(m, '/comments/feed/').present).toContain('Cm0001');
	});

	it('lists a published post behind a password and a sticky post first, as WordPress does', () => {
		const m = model();
		m.locked = [{ id: 6, title: 'Protected-Title' }];
		expect(frontPage(m).map((p) => p.id)).toEqual([6, 3, 2]);
		m.posts[0]!.sticky = true;
		expect(frontPage(m).map((p) => p.id)).toEqual([1, 6, 3]);
		expect(expectation(m, '/').present).toEqual(
			expect.arrayContaining(['Hello world!', 'Protected-Title', 'Tk0003'])
		);
		const right = {
			status: 200,
			body: page(m, 'Hello world! Protected-Title Tk0003'),
			headers: {}
		};
		expect(judgeAnswer(m, '/', right)).toEqual([]);
		// the control: a front page without the locked post is the one the model must flag
		expect(
			judgeAnswer(m, '/', { ...right, body: page(m, 'Hello world! Tk0003 Tk0002') })
		).toEqual(['missing Protected-Title']);
		// a draft, a private post and a trashed one take no slot
		m.posts[2]!.status = 'private';
		expect(frontPage(m).map((p) => p.id)).toEqual([1, 6, 2]);
	});

	it('flags a stale, missing, wrong-status or leaking answer and passes a right one', () => {
		const m = model();
		const listing = 'Tk0003 Tk0002 Hello world!';
		const right = { status: 200, body: page(m, listing), headers: {} };
		expect(judgeAnswer(m, '/', right)).toEqual([]);
		expect(judgeAnswer(m, '/', { ...right, body: page(m, `${listing} OldTitle`) })).toEqual([
			'still shows OldTitle'
		]);
		expect(
			judgeAnswer(m, '/a/', { status: 200, body: page(m, 'Tk0002'), headers: {} })
		).toEqual(['missing Cm0001', 'missing Uncategorized']);
		expect(judgeAnswer(m, '/', { ...right, status: 404 })[0]).toBe('status 404, wanted 200');
		expect(judgeAnswer(m, '/', { ...right, body: page(m, `${listing} SECRET-1`) })).toEqual([
			'leaks SECRET-1'
		]);
		const oldTheme = {
			...right,
			body: right.body.replace('twentytwentyfive', 'twentytwentyfour')
		};
		expect(judgeAnswer(m, '/', oldTheme)).toEqual(['theme twentytwentyfive not shown']);
		expect(
			judgeAnswer(m, '/c/', { status: 200, body: page(m, 'Tk0004'), headers: {} })
		).toContain('status 200, wanted 404');
		expect(judgeAnswer(m, '/c/', { status: 404, body: page(m), headers: {} })).toEqual([]);
	});

	it('flags an identified or refused answer that came from a store tier, and an error that did', () => {
		for (const tier of ['HIT', 'EDGE', 'MEM', 'KV', 'AGED']) {
			const seen = { status: 200, body: '', headers: { 'x-cfw-cache': tier } };
			expect(judgePrivate('auth', seen)).toHaveLength(1);
			expect(judgeError({ ...seen, status: 404 })).toHaveLength(1);
		}
		const rendered = { status: 200, body: '', headers: { 'x-cfw-cache': 'RENDER' } };
		expect(judgePrivate('refused', rendered)).toEqual([]);
		expect(judgeError({ ...rendered, status: 404 })).toEqual([]);
	});

	it('flags a stored error, a path the rule refuses, too many rows and a stored secret', () => {
		const row = { path: '/a/', status: 200, rendered_at: 1, stale_at: null, bytes: 1 };
		expect(judgeStore([row], { 'SECRET-1': [] })).toEqual([]);
		expect(judgeStore([{ ...row, status: 404 }], {})[0]).toContain('has status 404');
		expect(judgeStore([{ ...row, path: '/?s=x' }], {})[0]).toContain('refuses');
		expect(judgeStore([{ ...row, path: '/?utm_source=x' }], {})[0]).toContain('refuses');
		const many = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ ...row, path: `/p${i}/` }));
		expect(judgeStore(many, {})).toEqual([`${MAX_ROWS + 1} rows, over the ${MAX_ROWS} bound`]);
		expect(judgeStore([row], { 'SECRET-1': ['/a/'] })[0]).toContain('is stored in /a/');
	});

	it('judges a quiet write at the purge, so a later refill is not a purge', () => {
		const row = { path: '/a/', status: 200, rendered_at: 1, stale_at: null, bytes: 1 };
		const c = { generation: 4, announced: 0, wholesale: 0, floorPurges: 0 };
		expect(judgeQuietWrite([row], [row], c, c)).toEqual([]);
		expect(judgeQuietWrite([row], [{ ...row, rendered_at: 9 }], c, c)).toEqual([]);
		expect(judgeQuietWrite([row], [], c, c)).toEqual(['removed /a/']);
		expect(judgeQuietWrite([row], [{ ...row, stale_at: 5 }], c, c)).toEqual(['marked /a/']);
		expect(judgeQuietWrite([row], [row], c, { ...c, wholesale: 1 })).toEqual([
			'wholesale purge'
		]);
		expect(judgeQuietWrite([row], [row], c, { ...c, floorPurges: 1 })).toEqual(['floor purge']);
		const scoped = { ...c, generation: 5, lastScoped: { generation: 5, purged: 3 } };
		expect(judgeQuietWrite([row], [row], c, scoped)).toEqual(['scoped purge of 3 pages']);
		// a bump that removed nothing is the edge tier's cost, not a stored page's
		expect(
			judgeQuietWrite([row], [row], c, {
				...c,
				generation: 5,
				lastScoped: { generation: 5, purged: 0 }
			})
		).toEqual([]);
	});

	it('compares two runs on their figures and leaves the clock-driven violations out', () => {
		const run = {
			seed: 1,
			operations: 10,
			byKind: { read: 4 },
			writesByKind: { publish: 1 },
			logDigest: 'abc',
			violations: ['publish took 10100 ms'],
			storedPaths: ['/']
		};
		expect(sameStable(run, { ...run, violations: ['publish took 11200 ms'] })).toBe(true);
		expect(sameStable(run, { ...run, logDigest: 'abd' })).toBe(false);
		expect(sameStable(run, { ...run, storedPaths: ['/', '/a/'] })).toBe(false);
	});

	it('ignores the date a permalink carries when two runs straddle midnight', () => {
		const run = {
			seed: 1,
			operations: 10,
			byKind: {},
			writesByKind: {},
			logDigest: 'abc',
			violations: [],
			storedPaths: ['/', '/2026/11/21/a/', '/2026/11/']
		};
		const next = { ...run, storedPaths: ['/', '/2026/11/22/a/', '/2026/11/'] };
		expect(sameStable(run, next)).toBe(true);
		expect(
			sameStable(run, { ...next, storedPaths: ['/', '/2026/11/22/b/', '/2026/11/'] })
		).toBe(false);
		expect(undated('read|/2026/11/21/a/|200')).toBe(undated('read|/2026/11/22/a/|200'));
		expect(undated('read|/2026/11/21/a/|200')).not.toBe(undated('read|/2026/11/22/b/|200'));
	});

	it('bounds write-to-fresh by the routes a confirm reads', () => {
		expect([1, 4, 6, 20].map(contractMsFor)).toEqual([3000, 6000, 8000, 22000]);
	});

	it('judges a confirm within and over its bound and names the route count', () => {
		expect(judgeContract('publish', 8000, 6)).toBeUndefined();
		expect(judgeContract('publish', 9100, 6)).toBe(
			'publish took 9,100 ms for 6 routes, over the 8,000 ms bound'
		);
		expect(judgeContract('edit', 6001, 4)).toContain('for 4 routes');
		expect(judgeContract('edit', 6000, 4)).toBeUndefined();
	});

	it('bounds a wholesale purge by the stored rows it refills when they outnumber the routes read', () => {
		expect(judgeContract('option-change', 9702, 4, undefined, 18)).toBeUndefined();
		expect(judgeContract('option-change', 20001, 4, undefined, 18)).toBe(
			'option-change took 20,001 ms for 4 routes read behind 18 stored rows, over the 20,000 ms bound'
		);
		expect(judgeContract('option-change', 6001, 4, undefined, 2)).toContain('for 4 routes,');
	});

	it('holds every confirm to one flat figure when an override is set', () => {
		expect(judgeContract('publish', 9100, 6, 10000)).toBeUndefined();
		expect(judgeContract('trash', 3500, 1, 3000)).toBe(
			'trash took 3,500 ms for 1 routes, over the 3,000 ms flat override'
		);
		expect(judgeContract('publish', 9100, 6, Number.NaN)).toContain('8,000 ms bound');
		const run = {
			seed: 1,
			operations: 1,
			byKind: {},
			writesByKind: {},
			logDigest: 'a',
			violations: [judgeContract('publish', 9100, 6) ?? ''],
			storedPaths: []
		};
		expect(sameStable(run, { ...run, violations: [] })).toBe(true);
	});

	it('digests a body the same way twice and summarises a spread', () => {
		expect(digest('page')).toBe(digest('page'));
		expect(digest('page')).not.toBe(digest('pagf'));
		expect(spread([])).toBeUndefined();
		expect(spread([5, 1, 9, 3, 7])).toEqual({ n: 5, min: 1, p50: 5, p90: 9, max: 9 });
	});
});
