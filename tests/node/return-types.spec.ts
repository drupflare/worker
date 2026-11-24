import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { phpGoldens, type Golden, type GoldenCase } from '../../scripts/gen/return-type-goldens';
import { anachronCheckout, renderTable } from '../../scripts/gen/return-types';
import { CORE_RETURN_TYPES } from '../../src/ops/generated/core-return-types';
import { tokenize } from '../../src/ops/php-tokens';
import {
	addReturnTypes,
	addWritten,
	emptyReport,
	indexClasses,
	receiptOf,
	REFUSALS_LISTED,
	returnTypesOff,
	rewriteSource,
	type ClassInfo
} from '../../src/ops/return-types';
import cases from '../fixtures/return-types/cases.json';
import expected from '../fixtures/return-types/expected.json';
import {
	DATA_TYPE_CLASSES,
	inconsistentClass,
	UNTYPED_FILES,
	UNTYPED_METHODS,
	untypedModule
} from '../helpers/return-type-module';

/**
 * The install-time return type rewrite, held to anachron's PHP rewriter.
 *
 * `expected.json` is what the PHP class answers for each case in `cases.json`, recorded by
 * `scripts/gen/return-type-goldens.ts`; the TypeScript rewrite has to match it byte for byte and
 * refusal for refusal. The specs that read anachron or a Drupal tree skip when the checkout or the
 * tree is absent, so the goldens carry the comparison on a machine without either.
 */

const WORKER = new URL('../../', import.meta.url).pathname;
const ANACHRON = anachronCheckout();
const AUTOLOAD = join(WORKER, 'drupal-src', 'vendor', 'autoload.php');
const havePhp = spawnSync('php', ['-v']).status === 0;
const goldens = expected as Golden[];
const inputs = cases as GoldenCase[];

describe('the TypeScript rewrite against the recorded PHP answers', () => {
	it.each(inputs.map((c, at) => [c.name, at] as const))('%s', (_name, at) => {
		const input = inputs[at] as GoldenCase;
		const golden = goldens[at] as Golden;
		const found: { class: string; method: string; line: number; reason: string }[] = [];
		const index = new Map(Object.entries(input.index ?? {})) as Map<string, ClassInfo>;
		const done = rewriteSource(input.source, index, found);
		expect(done.code).toBe(golden.expected);
		expect(found).toEqual(golden.refusals);
		expect(done.added > 0).toBe(done.code !== input.source);
	});

	it('records one answer for every case', () => {
		expect(goldens.map((g) => g.name)).toEqual(inputs.map((c) => c.name));
	});

	it('never changes a line count', () => {
		for (const [at, input] of inputs.entries()) {
			const out = (goldens[at] as Golden).expected;
			expect(out.split('\n').length, input.name).toBe(input.source.split('\n').length);
		}
	});

	it('tokenizes every case without losing a byte', () => {
		for (const input of inputs) {
			expect(
				tokenize(input.source)
					.map((t) => t.s)
					.join(''),
				input.name
			).toBe(input.source);
		}
	});

	it('rewrites its own output to the same bytes', () => {
		for (const input of inputs) {
			const index = new Map(Object.entries(input.index ?? {})) as Map<string, ClassInfo>;
			const once = rewriteSource(input.source, index).code;
			expect(rewriteSource(once, index), input.name).toMatchObject({ code: once, added: 0 });
		}
	});
});

describe.skipIf(ANACHRON === undefined || !havePhp)('the recorded answers against anachron', () => {
	it('are what the PHP rewriter answers now', () => {
		expect(phpGoldens(ANACHRON as string, inputs)).toEqual(goldens);
	});

	it('use the table anachron declares', () => {
		const generated = renderTable(ANACHRON as string);
		expect(generated).toContain(JSON.stringify(CORE_RETURN_TYPES, null, '\t'));
	});
});

describe('the module pass', () => {
	const ROOT = 'modules/custom/probe';
	const files = Object.entries(untypedModule('probe')).map(([path, source]) => ({
		path,
		source
	}));

	it('adds the table types and counts files and methods', () => {
		const report = emptyReport();
		const out = addReturnTypes(files, report);
		expect(report.files).toBe(UNTYPED_FILES);
		expect(report.methods).toBe(UNTYPED_METHODS);
		expect(report.refused).toEqual([]);
		const joined = out.map((f) => f.source).join('\n');
		expect(joined).toContain('offsetExists($offset): bool');
		expect(joined).toContain('getIterator(): \\ArrayIterator');
		expect(joined).toContain('count(): int');
	});

	it('counts a narrowed declared type as a change and names one it cannot narrow', () => {
		const wide = 'ArrayObject|array|string|int|float|bool|null';
		const header = `<?php\nnamespace M;\nuse Drupal\\serialization\\Normalizer\\FieldItemNormalizer;\n`;
		const method = (body: string) =>
			`\tpublic function normalize($o, $f = NULL, array $c = []): ${wide} {\n${body}\n\t}\n`;
		const path = `${ROOT}/src/Normalizer/Good.php`;
		const bad = `${ROOT}/src/Normalizer/Bad.php`;
		const report = emptyReport();
		const out = addReturnTypes(
			[
				{
					path,
					source: `${header}class Good extends FieldItemNormalizer {\n${method('\t\treturn parent::normalize($o, $f, $c);')}}\n`
				},
				{
					path: bad,
					source: `${header}class Bad extends FieldItemNormalizer {\n${method('\t\treturn $this->x;')}}\n`
				}
			],
			report
		);
		expect(report).toMatchObject({ files: 1, methods: 1, byPath: { [path]: 1 } });
		expect(out[0]?.source).toContain('array $c = []): array {');
		expect(out[1]?.source).toContain(`): ${wide} {`);
		expect(report.refused).toHaveLength(1);
		expect(report.refused[0]).toMatchObject({
			path: bad,
			class: 'M\\Bad',
			method: 'normalize'
		});
		expect(report.refused[0]?.reason).toContain('not shown to be array');
		const again = emptyReport();
		addReturnTypes(out, again);
		expect(again.methods).toBe(0);
	});

	it('answers the files in the order given and leaves the others as they were', () => {
		const out = addReturnTypes(files, emptyReport());
		expect(out.map((f) => f.path)).toEqual(files.map((f) => f.path));
		expect(out[0]).toBe(files[0]);
	});

	it('is idempotent: a second pass adds nothing and changes no byte', () => {
		const first = addReturnTypes(files, emptyReport());
		const report = emptyReport();
		const second = addReturnTypes(first, report);
		expect(second).toEqual(first);
		expect(report).toEqual(emptyReport());
	});

	it('leaves typed methods byte for byte', () => {
		const typed = files.map((f) => ({
			...f,
			source: f.source
				.replace(/offsetExists\(\$offset\) \{/g, 'offsetExists($offset): bool {')
				.replace(/getIterator\(\) \{/g, 'getIterator(): \\ArrayIterator {')
				.replace(/count\(\) \{/g, 'count(): int {')
		}));
		const report = emptyReport();
		expect(addReturnTypes(typed, report)).toEqual(typed);
		expect(report.methods).toBe(0);
	});

	it('names a method the type would break and installs the rest', () => {
		const [path, source] = inconsistentClass('probe');
		const report = emptyReport();
		const out = addReturnTypes([...files, { path, source }], report);
		expect(report.methods).toBe(UNTYPED_METHODS);
		expect(report.refused).toEqual([
			expect.objectContaining({
				path,
				class: 'Drupal\\probe\\Plugin\\DataType\\NullCount',
				method: 'count',
				reason: expect.stringContaining('null literal')
			})
		]);
		expect(out.at(-1)?.source).toBe(source);
	});

	it('resolves a parent class in a file the delivery does not carry, from the held files', () => {
		const child = files.find((f) => f.path.endsWith('EntitiesViaJmesPath.php')) as {
			path: string;
			source: string;
		};
		const parent = files.find((f) => f.path.endsWith('/ValuesViaJmesPath.php')) as {
			path: string;
			source: string;
		};
		const alone = emptyReport();
		addReturnTypes([child], alone);
		expect(alone.methods).toBe(0);
		expect(alone.refused).toHaveLength(1);
		const held = emptyReport();
		const out = addReturnTypes([child], held, () => [parent]);
		expect(held.methods).toBe(1);
		expect(out[0]?.source).toContain('offsetExists($offset): bool');
	});

	it('reads the held files only when a delivery has a covered method', () => {
		let reads = 0;
		const held = () => {
			reads++;
			return [];
		};
		addReturnTypes(
			[{ path: `${ROOT}/src/Plain.php`, source: '<?php class Plain {}' }],
			emptyReport(),
			held
		);
		expect(reads).toBe(0);
		addReturnTypes(files, emptyReport(), held);
		expect(reads).toBe(1);
	});

	it('touches extension trees and PHP files only', () => {
		const source = files.find((f) => f.path.endsWith('ValuesFromJson.php'))?.source as string;
		const others = [
			'vendor/acme/lib/src/ValuesFromJson.php',
			'libraries/acme/ValuesFromJson.php',
			'core/lib/ValuesFromJson.php',
			`${ROOT}/src/notes.txt`,
			`${ROOT}/src/ValuesFromJson.twig`
		].map((path) => ({ path, source }));
		const report = emptyReport();
		expect(addReturnTypes(others, report)).toEqual(others);
		expect(report.methods).toBe(0);
		for (const path of [
			`modules/contrib/x/${'a.module'}`,
			'themes/contrib/x/a.theme',
			'profiles/contrib/x/a.profile',
			'modules/custom/x/a.inc',
			'modules/custom/x/a.install',
			'themes/custom/x/a.engine'
		]) {
			const one = emptyReport();
			addReturnTypes([{ path, source }], one);
			expect(one.methods, path).toBe(1);
		}
	});

	it('is switched off by `off` and nothing else', () => {
		expect(returnTypesOff({ ANACHRON_RETURN_TYPES: 'off' })).toBe(true);
		expect(returnTypesOff({ ANACHRON_RETURN_TYPES: ' OFF ' })).toBe(true);
		for (const value of [undefined, '', '0', 'on', '1', 'false']) {
			expect(returnTypesOff({ ANACHRON_RETURN_TYPES: value }), String(value)).toBe(false);
		}
		expect(returnTypesOff(undefined)).toBe(false);
	});

	it('counts per path, and keeps only the paths a commit wrote', () => {
		const done = emptyReport();
		addReturnTypes(files, done);
		expect(Object.keys(done.byPath)).toHaveLength(UNTYPED_FILES);
		const [first] = Object.keys(done.byPath) as [string];
		const kept = emptyReport();
		addWritten(kept, done, new Set([first, `${ROOT}/src/not-in-the-report.php`]));
		expect(kept).toMatchObject({ files: 1, methods: done.byPath[first] });
		expect(kept.refused).toEqual([]);
	});

	it('lists a bounded number of refusals and counts them all', () => {
		const report = emptyReport();
		for (let i = 0; i < REFUSALS_LISTED + 5; i++) {
			report.refused.push({
				path: `p${i}`,
				class: 'C',
				method: 'count',
				line: 1,
				reason: 'r'
			});
		}
		const receipt = receiptOf(report);
		expect(receipt.refused).toBe(REFUSALS_LISTED + 5);
		expect(receipt.refusals).toHaveLength(REFUSALS_LISTED);
	});

	it('indexes a class by its resolved parent and interfaces', () => {
		const index = indexClasses(
			'<?php\nnamespace A;\nuse B\\Base as Root;\nclass C extends Root implements \\Countable, D {}\n'
		);
		expect(index.get('A\\C')).toEqual({
			extends: 'B\\Base',
			implements: ['Countable', 'A\\D']
		});
	});
});

describe.skipIf(!havePhp || !existsSync(AUTOLOAD))(
	'the five classes against the Drupal core in the worker tree',
	() => {
		const NAME = 'cfw_rt_probe';

		function load(dir: string, cls: string): string {
			const runner = join(dir, 'load.php');
			writeFileSync(
				runner,
				`<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
$loader = require ${JSON.stringify(AUTOLOAD)};
$loader->addPsr4('Drupal\\\\${NAME}\\\\', ${JSON.stringify(join(dir, 'src'))});
echo class_exists(${JSON.stringify(`Drupal\\${NAME}\\Plugin\\DataType\\${cls}`)}) ? 'loaded' : 'missing';
`
			);
			const run = spawnSync('php', [runner], { encoding: 'utf8' });
			return `${run.stdout}${run.stderr}`;
		}

		function write(dir: string, tree: Record<string, string>): void {
			for (const [path, source] of Object.entries(tree)) {
				const target = join(dir, path.replace(`modules/custom/${NAME}/`, ''));
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, source);
			}
		}

		it('fatal as written and load once the return types are added', () => {
			const root = mkdtempSync(join(tmpdir(), 'cfw-rt-load-'));
			try {
				const before = join(root, 'before');
				const after = join(root, 'after');
				const tree = untypedModule(NAME);
				write(before, tree);
				const report = emptyReport();
				write(
					after,
					Object.fromEntries(
						addReturnTypes(
							Object.entries(tree).map(([path, source]) => ({ path, source })),
							report
						).map((f) => [f.path, f.source])
					)
				);
				expect(report.methods).toBe(UNTYPED_METHODS);
				for (const cls of DATA_TYPE_CLASSES) {
					expect(load(before, cls), `${cls} as written`).toContain('must be compatible');
					expect(load(after, cls), `${cls} rewritten`).toBe('loaded');
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}, 60_000);

		it('a normalizer with a union return type fatals as written and loads once narrowed', () => {
			const root = mkdtempSync(join(tmpdir(), 'cfw-rt-norm-'));
			try {
				const source = `<?php
namespace Drupal\\${NAME}\\Normalizer;

use ArrayObject;
use Drupal\\serialization\\Normalizer\\FieldItemNormalizer;

class Probe extends FieldItemNormalizer {
	public function normalize($object, $format = NULL, array $context = []): ArrayObject|array|string|int|float|bool|null {
		$values = parent::normalize($object, $format, $context);
		$values['a'] = 1;
		return $values;
	}
}
`;
				const rewritten = rewriteSource(source);
				expect(rewritten.added).toBe(1);
				expect(rewritten.code).toContain('$context = []): array {');
				const run = (dir: string, code: string): string => {
					mkdirSync(join(dir, 'Normalizer'), { recursive: true });
					writeFileSync(join(dir, 'Normalizer', 'Probe.php'), code);
					const runner = join(dir, 'load.php');
					writeFileSync(
						runner,
						`<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
$loader = require ${JSON.stringify(AUTOLOAD)};
$loader->addPsr4('Drupal\\\\serialization\\\\', ${JSON.stringify(join(WORKER, 'drupal-src', 'core', 'modules', 'serialization', 'src'))});
$loader->addPsr4('Drupal\\\\${NAME}\\\\', ${JSON.stringify(dir)});
echo class_exists('Drupal\\\\${NAME}\\\\Normalizer\\\\Probe') ? 'loaded' : 'missing';
`
					);
					const done = spawnSync('php', [runner], { encoding: 'utf8' });
					return `${done.stdout}${done.stderr}`;
				};
				expect(run(join(root, 'before'), source)).toContain('must be compatible');
				expect(run(join(root, 'after'), rewritten.code)).toBe('loaded');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}, 60_000);

		it('lint clean after the rewrite', () => {
			const root = mkdtempSync(join(tmpdir(), 'cfw-rt-lint-'));
			try {
				const out = addReturnTypes(
					Object.entries(untypedModule(NAME)).map(([path, source]) => ({ path, source })),
					emptyReport()
				);
				for (const [at, file] of out.entries()) {
					if (!file.path.endsWith('.php')) continue;
					const target = join(root, `${at}.php`);
					writeFileSync(target, file.source);
					expect(
						() => execFileSync('php', ['-l', target], { stdio: 'pipe' }),
						file.path
					).not.toThrow();
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
);
