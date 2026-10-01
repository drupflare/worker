import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../../../src/util/template';

describe('renderTemplate', () => {
	it('fills an inline token in place', () => {
		expect(
			renderTemplate('$a = json_decode(__CFW_PAYLOAD__, true);', { PAYLOAD: '"{}"' })
		).toBe('$a = json_decode("{}", true);');
	});

	it('replaces a whole-line token and keeps its indent', () => {
		expect(renderTemplate('a\n  // __CFW_BODY__\nb', { BODY: 'x();' })).toBe('a\n  x();\nb');
	});

	it('replaces a whole-line token with an empty value', () => {
		expect(renderTemplate('a\n// __CFW_NONE__\nb', { NONE: '' })).toBe('a\n\nb');
	});

	it('treats replacement patterns in a value as plain text', () => {
		expect(renderTemplate('// __CFW_V__', { V: "$& $1 $$ '" })).toBe("$& $1 $$ '");
	});

	it('does not scan a value for further tokens before the final check', () => {
		expect(() => renderTemplate('__CFW_A__', { A: '__CFW_B__', B: 'x' })).toThrow(
			'unresolved template token __CFW_B__'
		);
	});

	it('throws on a token with no value', () => {
		expect(() => renderTemplate('x __CFW_MISSING__ y', {})).toThrow(
			'unresolved template token __CFW_MISSING__'
		);
		expect(() => renderTemplate('// __CFW_MISSING__', {})).toThrow('__CFW_MISSING__');
	});

	it('leaves text without tokens unchanged', () => {
		expect(renderTemplate('no tokens $x __cfw_lower__', {})).toBe('no tokens $x __cfw_lower__');
	});
});
