import { describe, expect, it } from 'vitest';
import { parseJsonReply } from '../../../src/ops/json-reply.js';

describe('parseJsonReply', () => {
	it('reads a bare reply', () => {
		expect(parseJsonReply('{"ok":true,"n":{"a":1}}')).toEqual({ ok: true, n: { a: 1 } });
	});

	it('skips a notice whose text carries a brace', () => {
		const raw =
			'\nDeprecated: Implicit conversion in Drupal\\Core\\{closure}() on line 4\n{"ok":true,"module":"strawberryfield"}';
		expect(parseJsonReply(raw)).toEqual({ ok: true, module: 'strawberryfield' });
	});

	it('names the first failure and keeps the raw output when nothing parses', () => {
		const got = parseJsonReply('Fatal {closure} {"ok":');
		expect(String(got['error'])).toMatch(/^unparseable: /);
		expect(got['raw']).toBe('Fatal {closure} {"ok":');
	});

	it('says so when there is no object at all', () => {
		expect(parseJsonReply('Notice: nothing')).toEqual({
			error: 'no JSON in output',
			raw: 'Notice: nothing'
		});
	});
});
