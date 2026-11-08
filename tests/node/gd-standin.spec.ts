import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GD_CONSTANTS, GD_FUNCTIONS, STANDIN_FIX } from '../../src/drupal/standin-fix';
import { SHIM_CLAIMS } from '../../src/site/shims/extension-table';
import { nativePhp } from '../helpers/sodium-harness';

/**
 * The gd stand-in's declared table against the `Shim\Gd` class it routes to. The table is copied
 * into the fragment because the fragment runs before any class can load, so a drift would leave a
 * function undefined on the edge with every other gate green.
 */
const php = nativePhp();
const shim = resolve(
	process.env['DRUPFLARE_SRC'] ?? resolve(__dirname, '../../../drupflare'),
	'src/Shim'
);

const reflect = (): {
	constants: Record<string, number>;
	methods: Record<string, string[]>;
} =>
	JSON.parse(
		execFileSync(
			php!,
			[
				'-n',
				'-r',
				`require '${shim}/GdImage.php'; require '${shim}/Gd.php';
				$r = new ReflectionClass('Drupal\\\\drupflare\\\\Shim\\\\Gd');
				$m = [];
				foreach ($r->getMethods(ReflectionMethod::IS_PUBLIC) as $f) {
					if ($f->isStatic() && $f->getName() !== 'available') {
						$m[$f->getName()] = array_map(fn($p) => ($p->isVariadic() ? '...' : '') . '$' . $p->getName(), $f->getParameters());
					}
				}
				echo json_encode(['constants' => $r->getConstant('CONSTANTS'), 'methods' => $m]);`
			],
			{ encoding: 'utf8' }
		)
	);

describe('the gd stand-in table', () => {
	it('declares all 40 functions of the three CMS image paths', () => {
		expect(GD_FUNCTIONS.length).toBe(40);
		expect(new Set(GD_FUNCTIONS.map(([name]) => name)).size).toBe(40);
	});

	it.runIf(php !== undefined)('names the public functions of Shim\\Gd and no others', () => {
		expect(GD_FUNCTIONS.map(([name]) => name).sort()).toEqual(
			Object.keys(reflect().methods).sort()
		);
	});

	it.runIf(php !== undefined)('passes every parameter of each function through, in order', () => {
		const { methods } = reflect();
		for (const [name, , args] of GD_FUNCTIONS) {
			expect(args === '' ? [] : args.split(', '), name).toEqual(methods[name]);
		}
	});

	it.runIf(php !== undefined)('defines the constants Shim\\Gd defines, with its values', () => {
		expect(GD_CONSTANTS).toEqual(reflect().constants);
	});

	it('writes a wrapper and a define for each entry', () => {
		for (const [name] of GD_FUNCTIONS) expect(STANDIN_FIX).toContain(`function ${name}(`);
		for (const name of Object.keys(GD_CONSTANTS)) expect(STANDIN_FIX).toContain(`'${name}'`);
	});
});

describe('the gd extension claim', () => {
	it('is held by the table the differential gates and lists the declared functions', () => {
		const claim = SHIM_CLAIMS['gd'];
		expect(claim).toBeDefined();
		expect([...claim!.api.functions].sort()).toEqual(GD_FUNCTIONS.map(([name]) => name).sort());
		expect(Object.keys(GD_CONSTANTS).sort()).toEqual([...claim!.api.constants].sort());
	});

	it('leaves the stand-in functions defined when the extension reads loaded', () => {
		expect(STANDIN_FIX).toContain("if (!function_exists('imagecreatefromstring'))");
		expect(STANDIN_FIX).not.toContain("!extension_loaded('gd')");
	});
});
