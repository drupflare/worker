/**
 * Which of `src/` actually runs on the edge, and which exports nothing ever calls.
 *
 * Written because the health layer -- 11 tripwires, the ledger, the breaker, `quarantineDecision`
 * -- was imported by its own unit test and by nothing else, so every one of them was green in CI
 * and dead in production. A test proves a function works; it does not prove anything calls it.
 *
 * Two questions, because they fail differently:
 *   MODULE  - is the file reachable from the wrangler entrypoint at all?
 *   EXPORT  - is the file reachable but the export never referenced outside its own tests?
 *
 * `--json` for machines, `--strict` to exit non-zero when anything is unreachable.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const SRC = join(ROOT, 'src');

/** the canonical wrangler `main`; what a deployed site actually runs */
const ENTRY = join(SRC, 'site.ts');

/**
 * Modules that are reachable by a route the bundler cannot see.
 *
 * Only two kinds belong here: a wrangler `alias` target (the binary seam) and a file with no
 * runtime form at all. Anything else claiming an exemption is the defect this scan exists to
 * find, so the list stays short and each entry says why.
 */
const EXEMPT_MODULES = new Map<string, string>([
	['src/runtime/php-binary-85.ts', 'wrangler alias target for ./runtime/php-binary.js'],
	['src/runtime/php-binary.ts', 'the default binary seam the alias replaces'],
	['src/vendor.d.ts', 'ambient declarations; no runtime form']
]);

/**
 * How a module is reached, worst first.
 *
 * The distinction is the entire point: `probe` and `script` are FINE -- a frozen probe is its own
 * wrangler entrypoint and a build helper runs under bun -- while `dead` means nothing anywhere
 * imports it and `edge` means it ships. A scan that lumped all four together would report 45
 * problems and hide the 5 real ones.
 */
type Reach = 'edge' | 'probe' | 'script' | 'dead';

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			walk(full, out);
			continue;
		}
		if (full.endsWith('.ts')) out.push(full);
	}
	return out;
}

/** `from '...'`, `import('...')` and bare `import '...'`, which side-effect imports use */
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function specifiers(source: string): string[] {
	return [...source.matchAll(SPEC)].map((m) => m[1] ?? '').filter(Boolean);
}

/**
 * Resolves a relative specifier to a file on disk.
 *
 * The `.js`-for-`.ts` convention is repo-wide (see CLAUDE.md), so a specifier ending `.js` is
 * tried as `.ts` FIRST -- resolving it as written would miss every import in the codebase.
 */
function resolveSpec(fromFile: string, spec: string): string | null {
	if (!spec.startsWith('.')) return null;
	const base = resolve(dirname(fromFile), spec);
	const candidates = [base.replace(/\.js$/, '.ts'), `${base}.ts`, base, join(base, 'index.ts')];
	for (const c of candidates) {
		try {
			if (statSync(c).isFile()) return c;
		} catch {
			// a specifier that resolves to nothing is a type-only import or a build artifact
		}
	}
	return null;
}

function reachableFrom(entry: string): Set<string> {
	const seen = new Set<string>();
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop();
		if (!file || seen.has(file)) continue;
		seen.add(file);
		let source: string;
		try {
			source = readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		for (const spec of specifiers(source)) {
			const next = resolveSpec(file, spec);
			if (next && !seen.has(next)) queue.push(next);
		}
	}
	return seen;
}

/** `export function x`, `export const x`, `export class x`, `export interface x`, `export type x` */
const EXPORTED =
	/^export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

function exportsOf(source: string): string[] {
	return [...source.matchAll(EXPORTED)].map((m) => m[1] ?? '').filter(Boolean);
}

/** every `.ts` under `scripts/`, each of which is its own bun entrypoint */
function scriptEntries(): string[] {
	return walk(join(ROOT, 'scripts')).filter((f) => !f.endsWith('reachability.ts'));
}

function main(): void {
	const argv = process.argv.slice(2);
	const asJson = argv.includes('--json');
	const strict = argv.includes('--strict');

	const all = walk(SRC).sort();
	const edge = reachableFrom(ENTRY);

	// a probe is its own wrangler entrypoint, so it is a ROOT rather than something to be reached
	const probe = new Set<string>();
	for (const p of all.filter((f) => relative(ROOT, f).startsWith('src/probes/'))) {
		for (const f of reachableFrom(p)) probe.add(f);
	}

	const script = new Set<string>();
	for (const s of scriptEntries()) {
		for (const f of reachableFrom(s)) script.add(f);
	}

	const classify = (file: string): Reach => {
		if (edge.has(file)) return 'edge';
		if (probe.has(file)) return 'probe';
		if (script.has(file)) return 'script';
		return 'dead';
	};

	const rows = all
		.map((file) => ({ file: relative(ROOT, file), reach: classify(file), abs: file }))
		.filter((r) => !EXEMPT_MODULES.has(r.file));

	const dead = rows.filter((r) => r.reach === 'dead');
	// the finding that matters: real ops code that only a build script or nothing at all reaches
	const offEdge = rows.filter(
		(r) => (r.reach === 'script' || r.reach === 'dead') && !r.file.startsWith('src/probes/')
	);

	// one concatenated haystack of everything that SHIPS, so an export referenced only by its own
	// spec file does not count as used
	const edgeSource = [...edge].map((f) => readFileSync(f, 'utf8')).join('\n');

	// what the tests reach. An export that only tests mention is GREEN IN CI AND DEAD IN PRODUCTION,
	// which is the exact shape the health layer shipped in, so it is reported separately from an
	// export nothing mentions at all
	const testSource = walk(join(ROOT, 'tests'))
		.map((f) => readFileSync(f, 'utf8'))
		.join('\n');

	const unusedExports: { file: string; name: string; testOnly: boolean }[] = [];
	for (const file of edge) {
		const rel = relative(ROOT, file);
		if (rel === relative(ROOT, ENTRY)) continue;
		const source = readFileSync(file, 'utf8');
		for (const name of new Set(exportsOf(source))) {
			// a word-boundary count is enough here: the codebase has no dynamic property access
			// into these modules
			const pattern = new RegExp(`\\b${name}\\b`, 'g');
			const total = (edgeSource.match(pattern) ?? []).length;
			const here = (source.match(pattern) ?? []).length;
			if (total - here > 0) continue;
			unusedExports.push({ file: rel, name, testOnly: pattern.test(testSource) });
		}
	}

	if (asJson) {
		console.log(
			JSON.stringify(
				{ scanned: rows.length, edge: edge.size, offEdge, dead, unusedExports },
				null,
				2
			)
		);
	} else {
		const n = (r: Reach) => rows.filter((x) => x.reach === r).length;
		console.log(
			`${rows.length} modules under src/: ${n('edge')} edge, ${n('probe')} probe, ` +
				`${n('script')} script-only, ${n('dead')} dead`
		);
		console.log(`\nNOT ON THE EDGE (${offEdge.length}), excluding probes:`);
		for (const r of offEdge) console.log(`  ${r.reach.padEnd(7)} ${r.file}`);
		const testOnly = unusedExports.filter((u) => u.testOnly);
		console.log(
			`\nEXPORTS TESTED BUT NEVER CALLED IN PRODUCTION (${testOnly.length} of ` +
				`${unusedExports.length} unused):`
		);
		for (const u of testOnly) console.log(`  ${u.file}  ${u.name}`);
	}

	if (strict && offEdge.length > 0) process.exit(1);
}

main();
