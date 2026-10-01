import { describe, expect, it } from 'vitest';
import { hoistUses, phpScript, phpWhen } from '../../../src/util/php';

describe('phpWhen', () => {
	it('wraps the code in an if block on the condition', () => {
		expect(phpWhen("!function_exists('f')", 'function f() {}')).toBe(
			"if (!function_exists('f')) {\nfunction f() {}\n}"
		);
	});

	it('keeps a compound condition as written', () => {
		expect(phpWhen("!extension_loaded('x') && !function_exists('g')", 'A')).toBe(
			"if (!extension_loaded('x') && !function_exists('g')) {\nA\n}"
		);
	});
});

describe('hoistUses', () => {
	it('moves a use line out of an if block to the top, after the open tag', () => {
		const text = '<?php\nif (true) {\nuse A\\B;\nfoo();\n}\n';
		expect(hoistUses(text)).toBe('<?php\nuse A\\B;\nif (true) {\nfoo();\n}\n');
	});

	it('keeps one copy of an import two fragments both carry, in first-seen order', () => {
		const text = '<?php\nuse A\\B;\nx();\nif (1) {\nuse C\\D as E;\nuse A\\B;\n}\n';
		expect(hoistUses(text)).toBe('<?php\nuse A\\B;\nuse C\\D as E;\nx();\nif (1) {\n}\n');
	});

	it('puts the block at the start of a bare fragment', () => {
		expect(hoistUses('\nuse A\\B;\nfoo();\n')).toBe('use A\\B;\n\nfoo();\n');
	});

	it('handles a tag followed by a space, the way a fragment is run', () => {
		expect(hoistUses('<?php \nuse A\\B;\nfoo();')).toBe('<?php \nuse A\\B;\nfoo();');
		expect(hoistUses('<?php use A;\nfoo();')).toBe('<?php use A;\nfoo();');
	});

	it('leaves text with no imports unchanged', () => {
		const text = '<?php\nfoo();\n';
		expect(hoistUses(text)).toBe(text);
	});

	it('does not touch a closure use, an indented trait use or a use inside text', () => {
		const text =
			'<?php\n$f = function () use (&$out) {};\nclass C {\n\tuse T;\n}\n$s = "use A;";\n';
		expect(hoistUses(text)).toBe(text);
	});
});

describe('phpScript', () => {
	it('opens the tag and lifts the imports of everything it was built from', () => {
		expect(phpScript('if (1) {\nuse A\\B;\n}\n')).toBe('<?php\nuse A\\B;\nif (1) {\n}\n');
	});
});
