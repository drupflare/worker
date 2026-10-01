import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The interpreter seam is imported only by the exact specifier `wrangler.jsonc` aliases.
 *
 * Any other spelling of `./runtime/php-binary` (extensionless, or reached from another directory)
 * misses the alias and bundles the DEFAULT seam, `vendor/static-free-v1`: measured at 3,856,138
 * gzipped bytes, 710,410 over the old ceiling, with nothing failing but the size.
 */

const tracked = () =>
	execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
		encoding: 'utf8'
	})
		.split('\n')
		.filter(Boolean);

const aliasKey = (): string => {
	const alias = JSON.parse(
		readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, '')
	) as {
		alias?: Record<string, string>;
	};
	return Object.keys(alias.alias ?? {})[0] as string;
};

describe('module specifiers', () => {
	it('reaches the binary seam only through the aliased specifier', () => {
		const key = aliasKey();
		const hits: string[] = [];
		for (const f of tracked()) {
			if (!f.startsWith('src/') || !f.endsWith('.ts')) continue;
			// probes are frozen instruments, each its own entrypoint the alias never routes through
			if (f.startsWith('src/probes/') || !existsSync(f)) continue;
			readFileSync(f, 'utf8')
				.split('\n')
				.forEach((line, i) => {
					const m = /^\s*(?:import|export)[^'"]*from\s+['"](\.[^'"]*)['"]/.exec(line);
					const spec = m?.[1];
					if (!spec || !/runtime\/php-binary(\.js)?$/.test(spec)) return;
					if (f !== 'src/site-do.ts' || spec !== key) hits.push(`${f}:${i + 1} ${spec}`);
				});
		}
		expect(hits, 'imports of the binary seam that miss the wrangler alias').toEqual([]);
	});

	// node resolves a relative specifier as an exact path, while tsc, vite and esbuild infer the
	// extension; an extensionless import added under a node-run script broke `build:local` in
	// `pack-sql.ts` and `heap-digest-cost.ts` with the whole suite green
	it('resolves every relative import a node-run script reaches', () => {
		const files = tracked().filter(
			(f) =>
				existsSync(f) &&
				(f === 'package.json' ||
					/^(scripts|docs|\.github)\//.test(f) ||
					f === 'CLAUDE.md' ||
					f === 'TECHNICAL_REPORT.md')
		);
		const entries = new Set<string>();
		for (const f of files) {
			const text = readFileSync(f, 'utf8');
			for (const m of text.matchAll(
				/(?<![\w-])node (?:--[\w-]+(?:=\S+)? )*(scripts\/[\w/.-]+\.(?:ts|mjs|js))\b/g
			)) {
				entries.add(m[1]!);
			}
			for (const m of text.matchAll(/\[\s*'node',\s*'(scripts\/[\w/.-]+\.(?:ts|mjs|js))'/g)) {
				entries.add(m[1]!);
			}
		}
		expect(
			entries.size,
			'found no node-run scripts; the discovery regex is broken'
		).toBeGreaterThan(5);

		const spec =
			/^\s*(?:import|export)\s(?!type\s)[^'";]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gm;
		const seen = new Set<string>();
		const unresolved: string[] = [];
		const walk = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			for (const m of readFileSync(file, 'utf8').matchAll(spec)) {
				const target = resolve(dirname(file), (m[1] ?? m[2])!);
				if (!existsSync(target) || statSync(target).isDirectory()) {
					unresolved.push(`${relative(process.cwd(), file)} -> ${m[1] ?? m[2]}`);
				} else if (/\.(?:ts|mts|mjs|js)$/.test(target)) {
					walk(target);
				}
			}
		};
		for (const e of entries) if (existsSync(e)) walk(resolve(e));
		expect(unresolved, 'specifiers plain node cannot resolve').toEqual([]);
	});

	it('keeps the aliased binary specifier exactly as wrangler spells it', () => {
		// the alias key and the import have to agree character for character, and they live in two
		// files that nothing else links
		const key = aliasKey();
		expect(key).toBeDefined();
		expect(readFileSync('src/site-do.ts', 'utf8')).toContain(`from '${key}'`);
	});
});
