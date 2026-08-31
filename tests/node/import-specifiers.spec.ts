import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Relative imports under `src/` carry a file extension.
 *
 * Not a style preference. `wrangler.jsonc` aliases the exact specifier
 * `./runtime/php-binary.js`, so an extensionless form resolves the DEFAULT seam instead and bundles
 * `vendor/static-free-v1` -- measured at 3,856,138 gzipped bytes, 710,410 over the ceiling, with
 * nothing failing but the size. The same resolution difference is why some scripts run under bun
 * and not node.
 */

const tracked = () =>
	execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);

describe('module specifiers', () => {
	it('gives every relative import under src/ an extension', () => {
		const hits: string[] = [];
		for (const f of tracked()) {
			if (!f.startsWith('src/') || !f.endsWith('.ts')) continue;
			// probes are frozen instruments cited by figure in the report, and each is its own
			// entrypoint that the wrangler alias never routes through
			if (f.startsWith('src/probes/')) continue;
			readFileSync(f, 'utf8')
				.split('\n')
				.forEach((line, i) => {
					const m = /^\s*(?:import|export)[^'"]*from\s+['"](\.[^'"]*)['"]/.exec(line);
					if (!m) return;
					const spec = m[1] as string;
					if (!/\.(js|json|wasm|zst|br|mjs)$/.test(spec))
						hits.push(`${f}:${i + 1} ${spec}`);
				});
		}
		expect(hits, `${hits.length} relative imports without an extension`).toEqual([]);
	});

	it('keeps the aliased binary specifier exactly as wrangler spells it', () => {
		// the alias key and the import have to agree character for character, and they live in two
		// files that nothing else links
		const alias = JSON.parse(
			readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, '')
		) as { alias?: Record<string, string> };
		const key = Object.keys(alias.alias ?? {})[0] as string;
		expect(key).toBeDefined();
		expect(readFileSync('src/site-do.ts', 'utf8')).toContain(`from '${key}'`);
	});
});
