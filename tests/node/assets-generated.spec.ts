import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { constantName, readAssets, renderAssets } from '../../scripts/gen-assets';
import * as generated from '../../src/site/generated/assets';

describe('src/site/generated/assets.ts', () => {
	const assets = readAssets();

	it('is the generator output for the files under src/site', () => {
		const onDisk = readFileSync('src/site/generated/assets.ts', 'utf8');
		expect(onDisk).toBe(renderAssets(assets));
	});

	it('exports one constant per asset, with the same text', () => {
		const exported = generated as Record<string, unknown>;
		for (const { name, text } of assets) expect(exported[name]).toBe(text);
		expect(Object.keys(exported).sort()).toEqual(assets.map((a) => a.name).sort());
	});

	it('names a constant from its path: separators and dashes become underscores', () => {
		expect(constantName('boot/phase/kernel-new.php', 'php')).toBe('BOOT_PHASE_KERNEL_NEW_PHP');
		expect(constantName('mb/fix.php', 'php')).toBe('MB_FIX_PHP');
	});

	it('carries no open tag, because every consumer prepends its own', () => {
		for (const { name, text } of assets.filter((a) => a.name.endsWith('_PHP'))) {
			expect(text.startsWith('<?php'), name).toBe(false);
		}
	});

	it('keeps no escaped apostrophe left over from the single-quoted eval form', () => {
		for (const { name, text } of assets) expect(text.includes('\\x27'), name).toBe(false);
	});
});
