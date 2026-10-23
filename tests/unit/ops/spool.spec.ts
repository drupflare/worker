import { pathTag } from '@drupflare/spool/proxy';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	LEVER_DOMAINS,
	leverRefusal,
	OWNER_ONLY_LEVERS,
	spoolEnabled,
	spoolFeature
} from '../../../src/ops/plan';
import {
	isSpoolPath,
	pathTagFor,
	resetSpoolBudget,
	SPOOL_GLOBAL_LIMIT,
	SPOOL_IP_LIMIT,
	SPOOL_SLOTS,
	SPOOL_SW_PATH,
	SPOOL_WINDOW_MS,
	spoolAllowed,
	spoolCursorFloor,
	SpoolStamps
} from '../../../src/ops/spool';
import { intrinsicWidth, withoutUpscale } from '../../../src/site/spool';
import { druplicon } from '../../fixtures/png';

describe('whether spool runs', () => {
	it('is on for a paid site and off for a free one, with no lever set', () => {
		expect(spoolEnabled({ PLAN: 'paid' })).toBe(true);
		expect(spoolEnabled({ PLAN: 'free' })).toBe(false);
		expect(spoolEnabled({})).toBe(false);
	});

	it('takes SPOOL over the plan in both directions', () => {
		expect(spoolEnabled({ PLAN: 'paid', SPOOL: '0' })).toBe(false);
		expect(spoolEnabled({ PLAN: 'free', SPOOL: '1' })).toBe(true);
		expect(spoolEnabled({ PLAN: 'paid', SPOOL: '' })).toBe(true);
	});

	it('leaves each feature on until its own lever is 0, and never without spool', () => {
		for (const name of ['SPOOL_IMAGES', 'SPOOL_VIDEO', 'SPOOL_EMBEDS'] as const) {
			expect(spoolFeature({ PLAN: 'paid' }, name)).toBe(true);
			expect(spoolFeature({ PLAN: 'paid', [name]: '1' }, name)).toBe(true);
			expect(spoolFeature({ PLAN: 'paid', [name]: '0' }, name)).toBe(false);
			expect(spoolFeature({ PLAN: 'paid', SPOOL: '0' }, name)).toBe(false);
			expect(spoolFeature({ PLAN: 'free' }, name)).toBe(false);
		}
	});

	it('are levers the owner writes and Drupal does not', () => {
		for (const name of ['SPOOL', 'SPOOL_IMAGES', 'SPOOL_VIDEO', 'SPOOL_EMBEDS'] as const) {
			expect(LEVER_DOMAINS[name]).toEqual({ kind: 'flag' });
			expect(OWNER_ONLY_LEVERS.has(name)).toBe(true);
			expect(leverRefusal(name, '0')).toBeUndefined();
			expect(leverRefusal(name, '')).toBeUndefined();
			expect(leverRefusal(name, 'maybe')).toMatch(/0|1/);
		}
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

describe('the width an image is converted to', () => {
	const jpeg = (width: number, height: number) =>
		Uint8Array.from([
			// SOI, then a JFIF APP0 segment of 16 bytes, then SOF0 holding the size
			...[0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01],
			...[0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08],
			...[height >> 8, height & 255, width >> 8, width & 255],
			...[0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0x00]
		]);

	it('reads a PNG and a JPEG from the header, and nothing else', () => {
		expect(intrinsicWidth(druplicon())).toBe(88);
		expect(intrinsicWidth(jpeg(800, 600))).toBe(800);
		expect(intrinsicWidth(jpeg(4032, 3024))).toBe(4032);
		expect(intrinsicWidth(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
		expect(
			intrinsicWidth(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0]))
		).toBeUndefined();
	});

	it('drops a requested width the image already meets, because the encoder would enlarge it', () => {
		const photo = jpeg(900, 600);
		expect(withoutUpscale(photo, { width: 2560, quality: 80 })).toEqual({ quality: 80 });
		expect(withoutUpscale(photo, { width: 900, quality: 80 })).toEqual({ quality: 80 });
	});

	it('keeps a width that makes the image smaller, and any width for an image it cannot read', () => {
		const photo = jpeg(900, 600);
		expect(withoutUpscale(photo, { width: 480, quality: 80 })).toEqual({
			width: 480,
			quality: 80
		});
		const none = withoutUpscale<{ width?: number; quality: number }>(photo, { quality: 80 });
		expect(none).toEqual({ quality: 80 });
		const unknown = new Uint8Array([9, 9, 9]);
		expect(withoutUpscale(unknown, { width: 2560, quality: 80 })).toEqual({
			width: 2560,
			quality: 80
		});
	});
});

describe('the version vector', () => {
	/** the cursor a page rendered at `generation` carries, plus `n` changes inside it */
	const at = (generation: number, n = 0) => spoolCursorFloor(generation) + n;

	it('counts a holder of the generation it started at as current, and an older one as lost', () => {
		const stamps = new SpoolStamps(5);
		expect(stamps.diff(at(5), 5)).toEqual({ cursor: at(5), changed: {}, reset: false });
		expect(stamps.diff(at(4, 9), 5).reset).toBe(true);
		expect(stamps.diff(0, 5).reset).toBe(true);
	});

	it('gives every change a cursor above the one a page rendered at the same generation carries', () => {
		const stamps = new SpoolStamps(5);
		stamps.stamp(['node:1', 'proxy:path:/node/1'], 5);
		stamps.stamp(['node:2'], 5);
		expect(stamps.diff(at(5), 5)).toEqual({
			cursor: at(5, 2),
			changed: { 'node:1': at(5, 1), 'proxy:path:/node/1': at(5, 1), 'node:2': at(5, 2) },
			reset: false
		});
		expect(stamps.diff(at(5, 1), 5).changed).toEqual({ 'node:2': at(5, 2) });
		expect(stamps.diff(at(5, 2), 5).changed).toEqual({});
	});

	it('restamps a tag at its latest change', () => {
		const stamps = new SpoolStamps(1);
		stamps.stamp(['node:1'], 1);
		stamps.stamp(['node:1'], 2);
		expect(stamps.diff(at(1), 2).changed).toEqual({ 'node:1': at(2, 1) });
	});

	it('reports the cursor at a later generation as the cursor a page there carries', () => {
		const stamps = new SpoolStamps(1);
		stamps.stamp(['node:1'], 1);
		expect(stamps.cursor(1)).toBe(at(1, 1));
		expect(stamps.cursor(4)).toBe(at(4));
	});

	it('resets every holder below a wholesale bump and spares one at the new generation', () => {
		const stamps = new SpoolStamps(1);
		stamps.stamp(['node:1'], 3);
		stamps.wholesale(6);
		expect(stamps.size).toBe(0);
		expect(stamps.diff(at(5, 3), 6).reset).toBe(true);
		expect(stamps.diff(at(6), 6)).toEqual({ cursor: at(6), changed: {}, reset: false });
	});

	it('gives a purge that moved no generation a cursor of its own, so a holder of that generation resets', () => {
		const stamps = new SpoolStamps(2);
		stamps.wholesale(2, true);
		expect(stamps.diff(at(2), 2).reset).toBe(true);
		expect(stamps.diff(at(2, 1), 2).reset).toBe(false);
	});

	it('never hands a holder a cursor below its own floor, or it would be reset again at its next sync', () => {
		const stamps = new SpoolStamps(2);
		stamps.wholesale(2, true);
		const told = stamps.diff(at(2), 2);
		expect(told.reset).toBe(true);
		expect(stamps.diff(told.cursor, 2).reset).toBe(false);
	});

	it('resets a holder ahead of the vector, which has lost state', () => {
		expect(new SpoolStamps(1).diff(at(50), 8).reset).toBe(true);
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
			Array.from({ length: 2_001 }, (_, i) => `t${i}`),
			4
		);
		expect(stamps.size).toBe(0);
		expect(stamps.diff(at(4), 4).reset).toBe(true);
	});

	it('never spills a generation into the next one, however many changes it holds', () => {
		const stamps = new SpoolStamps(3);
		for (let i = 0; i < SPOOL_SLOTS + 10; i++) stamps.stamp([`t${i % 5}`], 3);
		expect(stamps.cursor(3)).toBeLessThan(at(4));
	});

	it('is lost with its instance, and a device that asks the next one resets', () => {
		const before = new SpoolStamps(7);
		before.stamp(['node:9'], 7);
		const heldByDevice = before.cursor(7) - 1;
		const after = new SpoolStamps(8);
		expect(after.diff(heldByDevice, 8).reset).toBe(true);
	});
});
