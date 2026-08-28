import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every KV write must go through the counted handle: the next `put` written against `ctx.storage`
 * directly fails here rather than quietly leaving short the rows meter that gates read-only mode.
 */
const WRITES = /\.ctx\.storage\.(put|delete|deleteAll|setAlarm|deleteAlarm)\b/g;

/** probes are exempt: each is its own entrypoint with no rows meter, and frozen besides */
const EXEMPT = /^src\/probes\//;

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...sources(path));
		else if (name.endsWith('.ts')) out.push(path);
	}
	return out.filter((p) => !EXEMPT.test(p));
}

/** a docblock showing the old call shape is not a call; blank comments out rather than parse */
function code(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/\/\/.*/g, '');
}

describe('the rows meter can see every storage write', () => {
	it('finds no direct ctx.storage write anywhere in src', () => {
		const offenders: string[] = [];
		for (const path of sources('src')) {
			const text = code(readFileSync(path, 'utf8'));
			for (const hit of text.matchAll(WRITES)) {
				const line = text.slice(0, hit.index).split('\n').length;
				offenders.push(`${path}:${line} ${hit[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('still wraps the raw handle exactly once, so the proxy is actually installed', () => {
		const text = readFileSync('src/site-do.ts', 'utf8');
		expect(text).toContain('countingStorage(this.ctx.storage,');
		// the field, not the raw handle, is what the rest of the file reaches for
		expect(text.match(/this\.storage\./g)?.length ?? 0).toBeGreaterThan(20);
	});
});
