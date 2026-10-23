import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

/** what each entry lets PHP reach: a glue refusal, a flag or list, JavaScript computation, or I/O */
export const CLASSES = ['hard', 'policy', 'compute', 'io'] as const;

export type Class = (typeof CLASSES)[number] | 'unclassified';

export type Entry = { class: Class; note?: string };

/** the committed allow-list: every wasm import and every `cfw*` host function, each classified */
export type Census = {
	wasm: Record<string, Entry>;
	host: Record<string, Entry>;
};

export const CENSUS_FILE = 'config/host-imports.json';
export const SHIPPING_WASM = '.interp/php8.5.wasm';
export const TUNED_WASM = '.interp/php8.5.tuned.wasm';

/** every import of a module as `module.name:kind`, sorted */
export function wasmImports(bytes: Uint8Array): string[] {
	// the workers typings declare the constructor abstract; node and bun construct it synchronously
	const Module = WebAssembly.Module as unknown as new (b: BufferSource) => WebAssembly.Module;
	return WebAssembly.Module.imports(new Module(bytes as BufferSource))
		.map((i) => `${i.module}.${i.name}:${i.kind}`)
		.sort();
}

/** a host function and the source text of what the host assigns to it */
export type HostFunction = { name: string; file: string; source: string };

const SKIP_DIRS = new Set(['probes', 'generated']);

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			if (!SKIP_DIRS.has(entry)) sourceFiles(path, out);
		} else if (path.endsWith('.ts')) {
			out.push(path);
		}
	}
	return out;
}

/** the receivers the host installs capabilities on; a file system node's `cfwDirty` is not one */
const RECEIVER = /^(binary|module|\(binary as [^)]*\))$/;

/**
 * Every `cfw*` function the host assigns onto the PHP module, found by walking the TypeScript
 * rather than matching text, so a computed key (`binary[ZLIB_BRIDGE]`) and a cast receiver count.
 *
 * Reads `src/` (minus the frozen probes and generated files) and the durable database package,
 * which installs `cfwSqlExec` and `cfwSqlTxn` from outside this repository's own tree.
 */
export function hostFunctions(root = process.cwd()): HostFunction[] {
	const files = [
		...sourceFiles(resolve(root, 'src')),
		resolve(root, 'node_modules/@drupflare/durabledb/src/do-sqlite.ts')
	].filter((f) => existsSync(f));
	const found: HostFunction[] = [];
	for (const file of files) {
		const text = readFileSync(file, 'utf8');
		if (!text.includes('cfw')) continue;
		const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		const constants = new Map<string, string>();
		const visit = (node: ts.Node) => {
			if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer &&
				ts.isStringLiteral(node.initializer)
			) {
				constants.set(node.name.text, node.initializer.text);
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
		const assigned = (node: ts.Node) => {
			if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.EqualsToken
			) {
				const left = node.left;
				let name: string | undefined;
				let receiver: string | undefined;
				if (ts.isPropertyAccessExpression(left)) {
					name = left.name.text;
					receiver = left.expression.getText(sf);
				} else if (ts.isElementAccessExpression(left)) {
					const key = left.argumentExpression;
					name = ts.isStringLiteral(key)
						? key.text
						: ts.isIdentifier(key)
							? constants.get(key.text)
							: undefined;
					receiver = left.expression.getText(sf);
				}
				if (name && /^cfw[A-Z]/.test(name) && receiver && RECEIVER.test(receiver)) {
					found.push({
						name,
						file: file.slice(resolve(root).length + 1),
						source: node.right.getText(sf)
					});
				}
			}
			ts.forEachChild(node, assigned);
		};
		assigned(sf);
	}
	return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** reads the committed file; a missing one is an empty census, so `--write` can create it */
export function loadCensus(root = process.cwd()): Census {
	const path = resolve(root, CENSUS_FILE);
	if (!existsSync(path)) return { wasm: {}, host: {} };
	return JSON.parse(readFileSync(path, 'utf8')) as Census;
}

/**
 * The census rebuilt from what exists: a name already on file keeps its class and note, a new one
 * is `unclassified`, and a name that no longer exists is dropped.
 */
export function rebuild(
	previous: Census,
	wasm: readonly string[],
	host: readonly string[]
): Census {
	const keep = (old: Record<string, Entry>, names: readonly string[]) =>
		Object.fromEntries(names.map((n) => [n, old[n] ?? { class: 'unclassified' as const }]));
	return { wasm: keep(previous.wasm, wasm), host: keep(previous.host, host) };
}

/**
 * The file's text: one line per entry that fits the line width, else one key per line, which is
 * what prettier leaves alone, so a regenerated file diffs as small as a hand-edited one.
 */
export function serialize(census: Census): string {
	const side = (entries: Record<string, Entry>) =>
		Object.entries(entries)
			.map(([name, e]) => {
				const key = JSON.stringify(name);
				const fields = Object.entries(e).map(
					([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`
				);
				const flat = `\t\t${key}: { ${fields.join(', ')} }`;
				if (flat.replace(/\t/g, '    ').length <= 100) return flat;
				return `\t\t${key}: {\n${fields.map((f) => `\t\t\t${f}`).join(',\n')}\n\t\t}`;
			})
			.join(',\n');
	return `{\n\t"wasm": {\n${side(census.wasm)}\n\t},\n\t"host": {\n${side(census.host)}\n\t}\n}\n`;
}

export type Drift = {
	/** in the module or the host and not on file */
	added: string[];
	/** on file and gone */
	removed: string[];
	/** on file without one of {@link CLASSES} */
	unclassified: string[];
};

/** how the committed names differ from the measured ones, for one side of the census */
export function drift(onFile: Record<string, Entry>, measured: readonly string[]): Drift {
	const have = new Set(Object.keys(onFile));
	const want = new Set(measured);
	return {
		added: measured.filter((n) => !have.has(n)),
		removed: [...have].filter((n) => !want.has(n)).sort(),
		unclassified: Object.entries(onFile)
			.filter(([, e]) => !(CLASSES as readonly string[]).includes(e.class))
			.map(([n]) => n)
			.sort()
	};
}

/** the names of the tuned module that the shipping one does not import */
export function tunedExtras(shipping: readonly string[], tuned: readonly string[]): string[] {
	const base = new Set(shipping);
	return tuned.filter((n) => !base.has(n));
}

function main(argv: string[]): number {
	const root = process.cwd();
	const wasm = wasmImports(readFileSync(resolve(root, SHIPPING_WASM)));
	const host = hostFunctions(root).map((h) => h.name);
	const names = [...new Set(host)];
	const census = loadCensus(root);
	if (argv.includes('--write')) {
		const next = rebuild(census, wasm, names);
		writeFileSync(resolve(root, CENSUS_FILE), serialize(next));
		const open = [...Object.entries(next.wasm), ...Object.entries(next.host)].filter(
			([, e]) => e.class === 'unclassified'
		);
		process.stdout.write(
			`wrote ${CENSUS_FILE}: ${wasm.length} imports, ${names.length} host functions, ` +
				`${open.length} unclassified\n`
		);
		for (const [n] of open) process.stdout.write(`  unclassified: ${n}\n`);
		return open.length > 0 ? 1 : 0;
	}
	let bad = 0;
	for (const [label, side, measured] of [
		['wasm import', census.wasm, wasm],
		['host function', census.host, names]
	] as const) {
		const d = drift(side, measured);
		for (const n of d.added) process.stdout.write(`new ${label} not on file: ${n}\n`);
		for (const n of d.removed) process.stdout.write(`${label} on file and gone: ${n}\n`);
		for (const n of d.unclassified) process.stdout.write(`${label} unclassified: ${n}\n`);
		bad += d.added.length + d.removed.length + d.unclassified.length;
	}
	process.stdout.write(
		`${wasm.length} imports, ${names.length} host functions, ${bad} problems\n`
	);
	return bad > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
