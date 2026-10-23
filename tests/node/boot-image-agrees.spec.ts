import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
	checkCapture,
	contextConfig,
	INTERPRETER_WASM,
	interpreterDigest,
	PACK_SQLITE,
	packConfigDigest
} from '../../scripts/boot-image-pack';
import {
	BOOT_IMAGE_VARIANTS,
	bootImageDir,
	parseBootImageIndex,
	type BootImageVariant
} from '../../src/ops/boot-image';

/**
 * The published boot image against the artifacts it was copied from. A site boots from the image
 * only when its context equals the bake's, so a stale image costs a plain boot and never a wrong
 * page; what no context can say is which interpreter built the heap, so that is checked here.
 */

const ROOT = resolve(import.meta.dirname, '..', '..', 'assets');
const dirOf = (variant: BootImageVariant) => join(ROOT, bootImageDir(variant));
const published = BOOT_IMAGE_VARIANTS.filter(
	(v) => existsSync(join(dirOf(v), 'index.json')) && existsSync(INTERPRETER_WASM)
);

describe('the context key', () => {
	it('reads the config part out of a context and nothing else', () => {
		expect(contextConfig('generation=a|b|driver=d|config=0f9a|settings=s')).toBe('0f9a');
		expect(contextConfig('config=ab|settings=s')).toBe('ab');
		expect(contextConfig('generation=a|settings=s')).toBeUndefined();
		expect(contextConfig('generation=a|xconfig=ab')).toBeUndefined();
		expect(contextConfig('generation=a|config=reset|settings=s')).toBeUndefined();
	});
});

describe('what a capture must be before it is published', () => {
	const capture = (context: string, handles = [{ id: 1, name: '@globalThis' }]) => ({
		context,
		handles
	});

	it('accepts each variant keyed its own way', () => {
		expect(() => checkCapture('pack', capture('x|config=ab|y'), 'ab')).not.toThrow();
		expect(() => checkCapture('claimed', capture('x|config=reset|y'), 'ab')).not.toThrow();
	});

	it('refuses a pack capture whose rows are not the pack, and a claimed one keyed to a digest', () => {
		expect(() => checkCapture('pack', capture('x|config=cd|y'), 'ab')).toThrow(/digest is cd/);
		expect(() => checkCapture('claimed', capture('x|config=ab|y'), 'ab')).toThrow(
			/without a digest/
		);
	});

	it('refuses a capture that names no handle, which nothing could replay', () => {
		expect(() => checkCapture('pack', capture('x|config=ab|y', []), 'ab')).toThrow(/no handle/);
	});
});

describe('the digest of the packed database', () => {
	const dir = mkdtempSync(join(tmpdir(), 'boot-image-agrees-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const database = (name: string, edit?: (db: DatabaseSync) => void) => {
		const path = join(dir, name);
		const db = new DatabaseSync(path);
		db.exec('CREATE TABLE config (collection TEXT, name TEXT, data BLOB)');
		db.exec('CREATE TABLE key_value (name TEXT, value TEXT)');
		db.prepare('INSERT INTO config VALUES (?, ?, ?)').run('', 'system.site', Buffer.from('a'));
		edit?.(db);
		db.close();
		return path;
	};

	it('moves with a config row and ignores every other table', () => {
		const base = packConfigDigest(database('base.sqlite'));
		expect(packConfigDigest(database('same.sqlite'))).toBe(base);
		expect(
			packConfigDigest(
				database('other.sqlite', (db) => db.exec("INSERT INTO key_value VALUES ('k', 'v')"))
			)
		).toBe(base);
		expect(
			packConfigDigest(
				database('edited.sqlite', (db) =>
					db.exec("UPDATE config SET data = x'62' WHERE name = 'system.site'")
				)
			)
		).not.toBe(base);
	});
});

describe.each(published)('the published %s boot image', (variant) => {
	const dir = dirOf(variant);
	const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));

	it('is an index the object accepts', () => {
		expect(typeof parseBootImageIndex(index)).not.toBe('string');
	});

	it('names the interpreter on disk, which no context can', () => {
		expect(index.interpreter).toBe(interpreterDigest());
	});

	it('is keyed the way its variant is', () => {
		if (variant === 'pack')
			expect(contextConfig(index.context)).toBe(packConfigDigest(PACK_SQLITE));
		else expect(index.context).toContain('config=reset');
	});

	it('has every file the index lists at its declared size, and no other', () => {
		const listed = new Set<string>(index.chunks.map((c: { file: string }) => c.file));
		for (const chunk of index.chunks as { file: string; pages: number[] }[])
			expect(statSync(join(dir, chunk.file)).size, chunk.file).toBe(
				chunk.pages.length * 65_536
			);
		const extra = readdirSync(dir).filter((f) => f !== 'index.json' && !listed.has(f));
		expect(extra).toEqual([]);
	});
});
