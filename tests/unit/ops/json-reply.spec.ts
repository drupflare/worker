import { describe, expect, it } from 'vitest';
import type { RunHost } from '../../../src/do/host';
import { settleReply } from '../../../src/do/run';
import { EXIT_REPLY_MARK, endedInExit, parseJsonReply } from '../../../src/ops/json-reply';

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

describe('parseJsonReply after an exit', () => {
	const mark = EXIT_REPLY_MARK;

	it('reads the reply after the mark and gives an empty html the page that was printed', () => {
		const got = parseJsonReply(
			`<p>é</p>${mark}{"status":202,"html":"","bytes":0,"phpExit":true}`
		);
		expect(got).toEqual({ status: 202, html: '<p>é</p>', bytes: 9, phpExit: true });
	});

	it('is not thrown by braces in the page, however many', () => {
		const page = '{"a":1}'.repeat(60);
		const got = parseJsonReply(`${page}${mark}{"html":"","phpExit":true}`);
		expect(got['html']).toBe(page);
	});

	it('keeps the html of a render that finished before the exit', () => {
		const got = parseJsonReply(`ignored${mark}{"html":"built","bytes":5,"phpExit":true}`);
		expect(got).toEqual({ html: 'built', bytes: 5, phpExit: true });
	});

	it('leaves a reply with no html field alone', () => {
		expect(parseJsonReply(`x${mark}{"error":"E","phpExit":true}`)).toEqual({
			error: 'E',
			phpExit: true
		});
	});

	it('falls back to the scan when what follows the mark is not an object', () => {
		const raw = `{"ok":true}${mark}nope`;
		const got = parseJsonReply(raw);
		expect(String(got['error'])).toMatch(/^unparseable: /);
		expect(got['raw']).toBe(raw);
	});
});

describe('settleReply', () => {
	const host = (lastRet: number | undefined, probeAnswer = 'cfw-alive') => {
		const probes: string[] = [];
		let dropped = 0;
		const h = {
			lastRet,
			exitedRuns: undefined as number | undefined,
			lastExit: undefined as { at: number; partial: string } | undefined,
			nowMs: () => 42,
			run: async (code: string) => {
				probes.push(code);
				return probeAnswer;
			},
			dropInterpreter: () => {
				dropped += 1;
			}
		};
		return { h: h as unknown as RunHost, raw: h, probes, dropped: () => dropped };
	};

	it('counts an exit the harness answered and passes the reply through', async () => {
		const { h, raw, probes, dropped } = host(0);
		const reply = { phpExit: true, status: 202, html: 'partial' };
		expect(await settleReply(h, reply)).toBe(reply);
		expect(raw.exitedRuns).toBe(1);
		expect(raw.lastExit).toEqual({ at: 42, partial: 'partial' });
		expect(probes).toHaveLength(0);
		expect(dropped()).toBe(0);
	});

	it('drops an interpreter that is dead after the exit and answers the exit error', async () => {
		const { h, raw, dropped } = host(0, '');
		const reply = parseJsonReply('partial');
		expect(await settleReply(h, reply)).toEqual({
			error: expect.stringContaining('exit()'),
			exited: true,
			raw: 'partial'
		});
		expect(raw.exitedRuns).toBe(1);
		expect(dropped()).toBe(1);
	});

	it('leaves a live instance and a plain reply alone', async () => {
		const { h, raw, dropped } = host(0);
		const none = parseJsonReply('no json');
		expect(await settleReply(h, none)).toBe(none);
		const ok = { ok: true };
		expect(await settleReply(h, ok)).toBe(ok);
		expect(raw.exitedRuns).toBeUndefined();
		expect(dropped()).toBe(0);
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
