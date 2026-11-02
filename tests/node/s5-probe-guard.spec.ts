import { describe, expect, it } from 'vitest';
import { clampReps, refuse } from '../../scripts/e2e/s5-probe/guard.js';

const KEY = 'k-test';
const env = { PROBE_KEY: KEY };
const call = (path: string, key: string | null = KEY, e: { PROBE_KEY?: string } = env) =>
	refuse(
		new URL(`https://probe.example.workers.dev${path}`),
		new Request('https://probe.example.workers.dev/', {
			headers: key === null ? {} : { 'x-probe-key': key }
		}),
		e
	);

describe('the S5 probe refuses to be an open outbound relay', () => {
	it('answers 403 without the key, with a wrong key, and when no key is configured', () => {
		expect(call('/run?arm=ship-stock&fn=info', null)?.status).toBe(403);
		expect(call('/run?arm=ship-stock&fn=info', 'nope')?.status).toBe(403);
		expect(call('/run?arm=ship-stock&fn=info', '', { PROBE_KEY: '' })?.status).toBe(403);
		expect(call('/control', KEY, {})?.status).toBe(403);
	});

	it('refuses hosts other than its own and the loopback literal', () => {
		for (const host of ['example.com', '169.254.169.254', '10.0.0.1', '[::1]', 'localhost']) {
			expect(call(`/control?host=${host}`)?.err, host).toBe('disallowed host');
		}
		expect(call('/control?host=probe.example.workers.dev')).toBeUndefined();
		expect(call('/run?arm=ship-wss&fn=ssc&host=127.0.0.1&port=8443&reps=3')).toBeUndefined();
	});

	it('refuses ports, functions and arms outside the fixed sets', () => {
		expect(call('/run?arm=ship-stock&fn=ssc&port=22')?.err).toBe('disallowed port');
		expect(call('/run?arm=ship-stock&fn=ssc&port=abc')?.err).toBe('disallowed port');
		expect(call('/run?arm=ship-stock&fn=eval')?.err).toBe('unknown fn');
		expect(call('/run?arm=ship-stock$(id)&fn=info')?.err).toBe('unknown arm');
		expect(call('/run?arm=control-stock&fn=socket&port=443')).toBeUndefined();
	});

	it('caps repetitions at five and defaults to three', () => {
		expect(clampReps('999')).toBe(5);
		expect(clampReps('0')).toBe(1);
		expect(clampReps('abc')).toBe(3);
		expect(clampReps(null)).toBe(3);
	});
});
