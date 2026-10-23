import { pathTag } from '@drupflare/spool/proxy';
import { beforeEach, describe, expect, it } from 'vitest';
import { LEVER_DOMAINS, leverRefusal, OWNER_ONLY_LEVERS, spoolMode } from '../../../src/ops/plan';
import {
	isSpoolPath,
	pathTagFor,
	resetSpoolBudget,
	SPOOL_GLOBAL_LIMIT,
	SPOOL_IP_LIMIT,
	SPOOL_MODES,
	SPOOL_SW_PATH,
	SPOOL_WINDOW_MS,
	spoolAllowed,
	SpoolStamps
} from '../../../src/ops/spool';

describe('the spool mode', () => {
	it('is off unless a paid site names shadow', () => {
		expect(spoolMode({})).toBe('off');
		expect(spoolMode({ PLAN: 'paid' })).toBe('off');
		expect(spoolMode({ PLAN: 'paid', SPOOL_MODE: 'shadow' })).toBe('shadow');
		expect(spoolMode({ PLAN: 'paid', SPOOL_MODE: ' Shadow ' })).toBe('shadow');
	});

	it('ignores the lever on a free site, because every sync is a Worker request', () => {
		expect(spoolMode({ PLAN: 'free', SPOOL_MODE: 'shadow' })).toBe('off');
		expect(spoolMode({ SPOOL_MODE: 'shadow' })).toBe('off');
	});

	it('reads anything else as off', () => {
		for (const value of ['serve', 'on', '1', 'true', {}, 7, null]) {
			expect(spoolMode({ PLAN: 'paid', SPOOL_MODE: value })).toBe('off');
		}
	});

	it('is a lever the owner writes and Drupal does not', () => {
		expect(LEVER_DOMAINS.SPOOL_MODE).toEqual({ kind: 'enum', values: SPOOL_MODES });
		expect(OWNER_ONLY_LEVERS.has('SPOOL_MODE')).toBe(true);
		expect(leverRefusal('SPOOL_MODE', 'shadow')).toBeUndefined();
		expect(leverRefusal('SPOOL_MODE', '')).toBeUndefined();
		expect(leverRefusal('SPOOL_MODE', 'serve')).toMatch(/off|shadow/);
	});
});

describe('the paths spool owns', () => {
	it('claims its worker script and its prefix and nothing near them', () => {
		expect(isSpoolPath(SPOOL_SW_PATH)).toBe(true);
		expect(isSpoolPath('/.spool/sync')).toBe(true);
		expect(isSpoolPath('/.spool/0.2.0/client.js')).toBe(true);
		for (const other of [
			'/',
			'/spool-sw.js/',
			'/.spool',
			'/.spooled',
			'/node/1',
			'/a/.spool/x'
		]) {
			expect(isSpoolPath(other)).toBe(false);
		}
	});

	it('derives the same page tag the library does', () => {
		for (const path of ['/', '/node/1', '/a b', '/news/2026']) {
			expect(pathTagFor(path)).toBe(pathTag(path));
		}
	});
});

describe('the budget on spool paths', () => {
	beforeEach(() => resetSpoolBudget());

	it('allows the limit per address and refuses the next, without touching another address', () => {
		for (let i = 0; i < SPOOL_IP_LIMIT; i++) expect(spoolAllowed('a', 1_000)).toBe(true);
		expect(spoolAllowed('a', 1_000)).toBe(false);
		expect(spoolAllowed('b', 1_000)).toBe(true);
	});

	it('opens a fresh window after the old one passes', () => {
		for (let i = 0; i <= SPOOL_IP_LIMIT; i++) spoolAllowed('a', 1_000);
		expect(spoolAllowed('a', 1_000 + SPOOL_WINDOW_MS)).toBe(true);
	});

	it('caps every address together at the isolate limit', () => {
		let refused = 0;
		for (let i = 0; i < SPOOL_GLOBAL_LIMIT + 10; i++) {
			if (!spoolAllowed(`addr-${i}`, 5_000)) refused++;
		}
		expect(refused).toBe(10);
	});
});

describe('the version vector', () => {
	it('answers a tag changed after a cursor, and nothing changed before it', () => {
		const stamps = new SpoolStamps(5);
		stamps.stamp(['node:1', 'proxy:path:/node/1'], 7);
		stamps.stamp(['node:2'], 9);
		expect(stamps.diff(5, 9)).toEqual({
			cursor: 9,
			changed: { 'node:1': 7, 'proxy:path:/node/1': 7, 'node:2': 9 },
			reset: false
		});
		expect(stamps.diff(7, 9)).toEqual({ cursor: 9, changed: { 'node:2': 9 }, reset: false });
		expect(stamps.diff(9, 9)).toEqual({ cursor: 9, changed: {}, reset: false });
	});

	it('restamps a tag at its latest change', () => {
		const stamps = new SpoolStamps(1);
		stamps.stamp(['node:1'], 2);
		stamps.stamp(['node:1'], 4);
		expect(stamps.diff(2, 4).changed).toEqual({ 'node:1': 4 });
	});

	it('resets a holder behind the instance that started at a later generation', () => {
		const stamps = new SpoolStamps(10);
		expect(stamps.diff(9, 10)).toEqual({ cursor: 10, changed: {}, reset: true });
		expect(stamps.diff(10, 10).reset).toBe(false);
	});

	it('resets every holder below a wholesale change and forgets the tags it replaced', () => {
		const stamps = new SpoolStamps(1);
		stamps.stamp(['node:1'], 3);
		stamps.wholesale(6);
		expect(stamps.size).toBe(0);
		expect(stamps.diff(5, 6).reset).toBe(true);
		expect(stamps.diff(6, 6)).toEqual({ cursor: 6, changed: {}, reset: false });
	});

	it('resets a holder ahead of the vector, which has lost state', () => {
		expect(new SpoolStamps(1).diff(50, 8).reset).toBe(true);
	});

	it('refuses a cursor that is not a whole number as a reset', () => {
		const stamps = new SpoolStamps(1);
		for (const from of [-1, 1.5, Number.NaN]) {
			expect(stamps.diff(from, 3).reset).toBe(true);
		}
	});

	it('degrades past its cap to a wholesale change rather than growing', () => {
		const stamps = new SpoolStamps(1);
		stamps.stamp(
			Array.from({ length: 10_001 }, (_, i) => `t${i}`),
			4
		);
		expect(stamps.size).toBe(0);
		expect(stamps.diff(3, 4).reset).toBe(true);
	});
});
