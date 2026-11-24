import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { opsRun, phpBodyExpression } from '../../src/drupal/php/site';
import { phpDouble, phpSingle } from '../../src/util/php';

const HOSTILE = [
	'${strtoupper(chr(97))}',
	'{$GLOBALS["x"]}',
	'$a and ${b}',
	'it\'s "quoted" \\ back\\slash',
	'line\nbreak\ttab',
	'é 😀',
	'plain'
];

/** what PHP 8 prints for a literal expression, or throws if PHP did not run */
function evaluate(expression: string): string {
	const out = spawnSync('php', ['-d', 'error_reporting=0', '-r', `echo ${expression};`], {
		encoding: 'utf8'
	});
	if (out.status !== 0) throw new Error(`php exited ${out.status}: ${out.stderr}`);
	return out.stdout;
}

describe('PHP literals built from values that came from outside', () => {
	it('round-trips a hostile value through a double-quoted JSON literal without running it', () => {
		for (const value of HOSTILE) {
			const literal = phpDouble(JSON.stringify(value));
			expect(evaluate(`json_decode(${literal})`)).toBe(value);
		}
	});

	it('round-trips the same values through the single-quoted form', () => {
		for (const value of HOSTILE) {
			expect(evaluate(`json_decode(${phpSingle(JSON.stringify(value))})`)).toBe(value);
		}
	});

	it('keeps a request body byte for byte, text and base64', () => {
		for (const value of HOSTILE) {
			expect(evaluate(phpBodyExpression({ body: value }))).toBe(value);
			const b64 = Buffer.from(value, 'utf8').toString('base64');
			expect(evaluate(phpBodyExpression({ bodyBase64: b64 }))).toBe(value);
		}
	});

	it('keeps a config import payload out of PHP interpolation', () => {
		const script = opsRun('cim', [], {
			payload: { 'system.site': { name: '${phpversion()}' } }
		});
		expect(script).toContain('\\${phpversion');
		expect(script).not.toMatch(/[^\\]\$\{phpversion/);
	});

	it('escapes the dollar, which is the control: JSON alone lets PHP run the expression', () => {
		const value = '${strtoupper(chr(97))}';
		const unsafe = JSON.stringify(JSON.stringify(value));
		expect(evaluate(`json_decode(${unsafe})`)).not.toBe(value);
		expect(phpDouble(JSON.stringify(value))).toContain('\\$');
	});
});
