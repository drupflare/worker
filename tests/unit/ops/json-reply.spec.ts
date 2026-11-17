import { describe, expect, it } from 'vitest';
import { endedInExit, parseJsonReply } from '../../../src/ops/json-reply';

describe('parseJsonReply', () => {
	it('reads a bare reply', () => {
		expect(parseJsonReply('{"ok":true,"n":{"a":1}}')).toEqual({ ok: true, n: { a: 1 } });
	});

	it('skips a notice whose text carries a brace', () => {
		const raw =
			'\nDeprecated: Implicit conversion in Drupal\\Core\\{closure}() on line 4\n{"ok":true,"module":"strawberryfield"}';
		expect(parseJsonReply(raw)).toEqual({ ok: true, module: 'strawberryfield' });
	});

	it('reads past more log lines with a brace than there are candidates', () => {
		const log = '%date{M j H:i:s} DEBUG getServerHTTPS()\n'.repeat(40);
		expect(parseJsonReply(`${log}{"ok":true}`)).toEqual({ ok: true });
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

describe('endedInExit', () => {
	const none = parseJsonReply('partial');
	const probe = (answer: string) => {
		const calls: string[] = [];
		return {
			calls,
			run: async (code: string) => {
				calls.push(code);
				return answer;
			}
		};
	};

	it('is true for a clean return with no JSON and an interpreter that answers nothing', async () => {
		const p = probe('');
		expect(await endedInExit(0, none, p.run)).toBe(true);
		expect(p.calls).toHaveLength(1);
	});

	it('is true when the partial output held a brace that never parsed', async () => {
		expect(await endedInExit(0, parseJsonReply('{"a"'), probe('').run)).toBe(true);
	});

	it('is false when the interpreter still answers, as after a harness that printed nothing useful', async () => {
		expect(await endedInExit(0, none, probe('cfw-alive').run)).toBe(false);
	});

	it('is false for a fatal return code and spends no probe', async () => {
		const p = probe('');
		expect(await endedInExit(1, none, p.run)).toBe(false);
		expect(await endedInExit(2, none, p.run)).toBe(false);
		expect(p.calls).toHaveLength(0);
	});

	it('is false for an unknown return code and for a reply that carries JSON', async () => {
		const p = probe('');
		expect(await endedInExit(undefined, none, p.run)).toBe(false);
		expect(await endedInExit(0, { ok: true }, p.run)).toBe(false);
		expect(await endedInExit(0, { error: 'a render fault', raw: 'x' }, p.run)).toBe(false);
		expect(p.calls).toHaveLength(0);
	});

	it('is true when the probe itself throws', async () => {
		const run = async () => {
			throw new Error('trap');
		};
		expect(await endedInExit(0, none, run)).toBe(true);
	});
});
