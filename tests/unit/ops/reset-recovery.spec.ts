import { describe, expect, it } from 'vitest';
import { ATTEMPT_HEADER, attemptKey } from '../../../src/ops/attempt';
import { objectResetPage, resetRecovery } from '../../../src/site';

/**
 * What the front worker does when the hop to a site's object throws.
 *
 * The routing around it (a fresh stub, the attempt header, the failover hop) is driven in
 * `serve-edge.spec.ts`, which needs the pack; these are the decisions and the page it shows.
 */

// read off a deployed probe: a memory reset carries no `retryable`
const MEMORY_RESET = { overloaded: true, remote: true, durableObjectReset: true };

describe('whether a reset request is sent again', () => {
	it('does not retry an object that is overloaded without having been reset', () => {
		expect(resetRecovery({ retryable: true, overloaded: true }, 'GET')).toBe('refuse');
		expect(resetRecovery(MEMORY_RESET, 'GET')).toBe('retry');
		expect(resetRecovery(MEMORY_RESET, 'POST')).toBe('refuse');
		expect(resetRecovery(MEMORY_RESET, 'POST', true)).toBe('retry');
		expect(resetRecovery({ retryable: true, overloaded: true }, 'POST', true)).toBe('refuse');
		expect(resetRecovery({}, 'POST', true)).toBe('refuse');
		expect(resetRecovery({ retryable: true }, 'HEAD')).toBe('retry');
		expect(resetRecovery(null, 'GET')).toBe('refuse');
	});
});

describe('the page a visitor gets instead of a 1101', () => {
	it('asks for a retry and is never cached', async () => {
		const res = objectResetPage('GET');
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe('2');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('x-cfw-object-reset')).toBe('1');
		expect(await res.text()).not.toContain('may not have been saved');
	});

	it('warns that a form may not have been saved', async () => {
		expect(await objectResetPage('POST').text()).toContain('may not have been saved');
	});
});

describe('the attempt id a repeated POST carries', () => {
	it('keys only an id the front worker mints', () => {
		const id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
		expect(ATTEMPT_HEADER).toBe('x-cfw-attempt');
		expect(attemptKey(id)).toBe(`attempt:${id}`);
		expect(attemptKey(id.toUpperCase())).toBeNull();
		expect(attemptKey('attempt:../x')).toBeNull();
		expect(attemptKey('')).toBeNull();
		expect(attemptKey(null)).toBeNull();
	});
});
