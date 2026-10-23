import { describe, expect, it } from 'vitest';
import { byClass, firstPerPath, pathClass, percentile } from '../../scripts/measure/spool-cpu';

describe('the path classes', () => {
	it('separates spool, pages, files and the rest', () => {
		expect(pathClass('/spool-sw.js')).toBe('spool worker script');
		expect(pathClass('/.spool/sync')).toBe('spool endpoint');
		expect(pathClass('/')).toBe('page');
		expect(pathClass('/user/login')).toBe('page');
		expect(pathClass('/node/12')).toBe('page');
		expect(pathClass('/sites/default/files/2026-10/photo.png')).toBe('image file');
		expect(pathClass('/sites/default/files/2026-10/clip.mp4')).toBe('video file');
		expect(pathClass('/admin/content')).toBe('other');
	});
});

describe('percentile and the class rows', () => {
	it('takes the nearest rank and is zero for nothing', () => {
		expect(percentile([], 50)).toBe(0);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
		expect(percentile([7], 99)).toBe(7);
	});

	it('groups by class with count, median, p90 and max', () => {
		const rows = byClass([
			{ path: '/', cpuMs: 2, at: 1 },
			{ path: '/node/1', cpuMs: 4, at: 2 },
			{ path: '/', cpuMs: 3, at: 3 },
			{ path: '/sites/default/files/a.png', cpuMs: 30, at: 4 }
		]);
		expect(rows['page']).toEqual({ n: 3, median: 3, p90: 4, max: 4 });
		expect(rows['image file']).toEqual({ n: 1, median: 30, p90: 30, max: 30 });
	});
});

describe('the first request for a path', () => {
	it('keeps the earliest of each path in time order', () => {
		const first = firstPerPath([
			{ path: '/a', cpuMs: 9, at: 5 },
			{ path: '/a', cpuMs: 1, at: 9 },
			{ path: '/b', cpuMs: 2, at: 3 }
		]);
		expect(first.map((e) => [e.path, e.cpuMs])).toEqual([
			['/b', 2],
			['/a', 9]
		]);
	});
});
