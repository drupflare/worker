import { describe, expect, it } from 'vitest';
import {
	classifyLimit,
	hitAnyLimit,
	noteLimit,
	type LimitTally
} from '../../../src/ops/platform-limits';

/**
 * The limit classifier.
 *
 * Every message below is one the platform actually emits, or the observed shape of one. The case
 * that carries the most weight is `silent`: an isolate memory kill INSIDE an invocation throws with
 * no message and no stack, which is indistinguishable from an ordinary bug unless something names
 * it. That shape reset four freshly provisioned sites before it was understood.
 */

describe('a message is attributed to the ceiling it names', () => {
	it('names each class from the platform text', () => {
		const cases: [string, string][] = [
			['Cannot perform I/O on behalf of a different request.', 'io-context'],
			['Too many subrequests.', 'subrequest-limit'],
			["Durable Object's isolate exceeded its memory limit and was reset", 'memory-limit'],
			['Worker exceeded CPU time limit.', 'time-limit'],
			['The script exceeded resource limits', 'time-limit'],
			['output gate failure', 'output-gate']
		];
		for (const [message, kind] of cases) {
			expect(classifyLimit(new Error(message)), message).toBe(kind);
		}
	});

	it('attributes a reset that follows a memory kill to the memory limit', () => {
		// both phrases appear; the memory limit is the cause and the reset is the consequence
		const both = new Error(
			"Durable Object's isolate exceeded its memory limit and was reset; " +
				'Internal error in Durable Object storage caused object to be reset'
		);
		expect(classifyLimit(both)).toBe('memory-limit');
		// on its own the storage text is its own class
		const alone = new Error(
			'Internal error in Durable Object storage caused object to be reset'
		);
		expect(classifyLimit(alone)).toBe('storage-reset');
	});

	it('calls a message-less throw silent rather than other', () => {
		// THE ONE THAT MATTERS. Measured on four provisioned sites: an isolate memory kill inside a
		// single invocation throws exactly this, at 2,213-4,944 ms of cpuTime, and folding it into
		// `other` would hide it among ordinary application exceptions
		expect(classifyLimit(new Error(''))).toBe('silent');
		expect(classifyLimit({})).toBe('silent');
		expect(classifyLimit(undefined)).toBe('silent');
		expect(classifyLimit(null)).toBe('silent');
		expect(classifyLimit(new Error('   '))).toBe('silent');
	});

	it('calls an ordinary application exception other', () => {
		expect(classifyLimit(new Error('Call to undefined function foo()'))).toBe('other');
		expect(classifyLimit('no such table: key_value')).toBe('other');
	});

	it('reads a bare string and a bare object the same way as an Error', () => {
		expect(classifyLimit('Too many subrequests.')).toBe('subrequest-limit');
		expect(classifyLimit({ message: 'Too many subrequests.' })).toBe('subrequest-limit');
	});
});

describe('the tally separates a ceiling from a bug', () => {
	it('counts each class', () => {
		const tally: LimitTally = {};
		noteLimit(tally, new Error('Too many subrequests.'));
		noteLimit(tally, new Error('Too many subrequests.'));
		noteLimit(tally, new Error('boom'));
		expect(tally).toEqual({ 'subrequest-limit': 2, other: 1 });
	});

	it('does not let ordinary exceptions read as hitting a limit', () => {
		const tally: LimitTally = {};
		for (let i = 0; i < 50; i++) noteLimit(tally, new Error('Call to undefined function'));
		// fifty application bugs are not a platform ceiling, and a counter that said otherwise would
		// make the signal useless on any site with a broken module
		expect(hitAnyLimit(tally)).toBe(false);

		noteLimit(tally, new Error(''));
		// one message-less throw is
		expect(hitAnyLimit(tally)).toBe(true);
	});

	it('reads an empty tally as no limit hit', () => {
		expect(hitAnyLimit({})).toBe(false);
	});
});
