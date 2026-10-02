import { describe, expect, it } from 'vitest';
import {
	DEFAULT_OPCACHE_MODE,
	OPCACHE_MODES,
	opcacheIni,
	opcacheMode,
	opcachePackState,
	opcacheSourceKey
} from '../../../src/runtime/opcache';

describe('opcacheMode', () => {
	it('accepts every named arm, trimmed', () => {
		for (const mode of OPCACHE_MODES) expect(opcacheMode(` ${mode} `)).toBe(mode);
	});

	it('falls back to the shipping arm on an unknown or missing value', () => {
		expect(DEFAULT_OPCACHE_MODE).toBe('off');
		expect(opcacheMode('turbo')).toBe('off');
		expect(opcacheMode(undefined)).toBe('off');
		expect(opcacheMode('')).toBe('off');
	});
});

describe('opcacheIni', () => {
	it('turns opcache off by default', () => {
		expect(opcacheIni()).toEqual(['opcache.enable=0', 'opcache.enable_cli=0']);
	});

	it('shm has no file cache lines', () => {
		const ini = opcacheIni('shm');
		expect(ini).toContain('opcache.enable=1');
		expect(ini.some((l) => l.startsWith('opcache.file_cache'))).toBe(false);
	});

	it('file is a file-only store and pack adds read-only on top of it', () => {
		const file = opcacheIni('file');
		expect(file).toContain('opcache.file_cache_only=1');
		expect(file).not.toContain('opcache.file_cache_read_only=1');
		expect(opcacheIni('pack')).toEqual([...file, 'opcache.file_cache_read_only=1']);
	});
});

describe('opcacheSourceKey', () => {
	it('is stable under lock key order and moves with a version', () => {
		const a = opcacheSourceKey('d1', { 'a/x': '1.0.0', 'b/y': '2.0.0' });
		expect(opcacheSourceKey('d1', { 'b/y': '2.0.0', 'a/x': '1.0.0' })).toBe(a);
		expect(opcacheSourceKey('d1', { 'a/x': '1.0.1', 'b/y': '2.0.0' })).not.toBe(a);
		expect(opcacheSourceKey('d2', { 'a/x': '1.0.0', 'b/y': '2.0.0' })).not.toBe(a);
		expect(a).toMatch(/^d1:[0-9a-f]{8}$/);
	});
});

describe('opcachePackState', () => {
	const key = opcacheSourceKey('d1', { 'a/x': '1.0.0' });

	it('is none without a pack, outside the pack arm, or without the lazy mount', () => {
		expect(opcachePackState(undefined, 'pack', true, key)).toBe('none');
		expect(opcachePackState({ source: key }, 'file', true, key)).toBe('none');
		expect(opcachePackState({ source: key }, 'pack', false, key)).toBe('none');
	});

	it('is usable when the sources agree and stale when they do not', () => {
		expect(opcachePackState({ source: key }, 'pack', true, key)).toBe('usable');
		expect(opcachePackState({ source: 'other' }, 'pack', true, key)).toBe('stale');
	});
});
