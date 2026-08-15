import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion, satisfies } from '../../../src/ops/composer-constraint';

/**
 * The constraint checker behind the installability check, and the reason it is three-valued.
 *
 * It exists instead of a dependency because the worker bundle has **138,967 bytes** of headroom under
 * the 3 MiB free ceiling -- PHP 8.4 does not fit in that -- and because npm's `semver` does not
 * implement Composer's rules. The `^0.x` case below is the concrete divergence: npm's `^0.3` allows
 * `<0.4`... and so does Composer's, but npm's `^0.0.3` allows only `0.0.3` while the reasoning differs
 * enough that borrowing the implementation would be a guess.
 *
 * The assertions that matter most return `unknown`. A checker that guesses answers "installable" for a
 * module that then breaks the site, which is this project's signature failure: a plausible answer with
 * no error. So every form outside the supported subset must refuse to judge, and an `unknown` inside a
 * satisfied AND group must poison the group rather than being ignored.
 */

describe('parsing, including the forms a lock file actually mixes', () => {
	it('strips a v prefix, because Composer treats v1.2.3 and 1.2.3 as one version', () => {
		expect(parseVersion('v1.2.3')?.parts).toEqual([1, 2, 3]);
		expect(parseVersion('1.2.3')?.parts).toEqual([1, 2, 3]);
	});

	it('keeps a stability suffix separately', () => {
		expect(parseVersion('1.2.3-beta2')?.stability).toBe('-beta2');
		expect(parseVersion('1.2.3')?.stability).toBe('');
	});

	it('refuses a dev branch, which has no numeric ordering at all', () => {
		// judging `dev-main` against `^1.0` would be inventing an order; the caller must ask a human
		expect(parseVersion('dev-main')).toBeNull();
		expect(parseVersion('1.x-dev')).toBeNull();
	});

	it('refuses junk rather than parsing it as 0', () => {
		for (const raw of ['', '   ', 'latest', 'not-a-version']) {
			expect(parseVersion(raw), raw).toBeNull();
		}
	});

	it('treats a missing segment as zero, so 1.2 equals 1.2.0', () => {
		expect(compareVersions(parseVersion('1.2')!, parseVersion('1.2.0')!)).toBe(0);
	});

	it('orders a release above every pre-release', () => {
		const release = parseVersion('1.0.0')!;
		for (const pre of ['1.0.0-rc1', '1.0.0-beta1', '1.0.0-alpha1']) {
			expect(compareVersions(release, parseVersion(pre)!), pre).toBe(1);
		}
	});
});

describe('caret, where Composer and npm diverge', () => {
	it('pins the left-most NON-ZERO segment', () => {
		expect(satisfies('1.5.0', '^1.2')).toBe('yes');
		expect(satisfies('2.0.0', '^1.2')).toBe('no');
		expect(satisfies('1.1.0', '^1.2')).toBe('no');
	});

	it('treats ^0.3 as >=0.3 <0.4, not <1.0', () => {
		// the divergence that makes borrowing an npm implementation a guess
		expect(satisfies('0.3.9', '^0.3')).toBe('yes');
		expect(satisfies('0.4.0', '^0.3')).toBe('no');
		expect(satisfies('0.9.0', '^0.3')).toBe('no');
	});

	it('handles the real Drupal core constraint', () => {
		expect(satisfies('11.4.5', '^11.3')).toBe('yes');
		expect(satisfies('11.2.0', '^11.3')).toBe('no');
		expect(satisfies('12.0.0', '^11.3')).toBe('no');
	});
});

describe('tilde, comparisons and wildcards', () => {
	it('bumps the segment BEFORE the last stated one, which is not the same as caret', () => {
		// `~1.2` is >=1.2 <2.0 -- it drops the last digit and increments the one before, so 1.3.0
		// DOES satisfy it. My first version of this test asserted 'no' and the implementation was
		// right; `~1.2.3` is the case that stops at <1.3.0.
		expect(satisfies('1.2.9', '~1.2')).toBe('yes');
		expect(satisfies('1.3.0', '~1.2')).toBe('yes');
		expect(satisfies('2.0.0', '~1.2')).toBe('no');
		expect(satisfies('1.2.9', '~1.2.3')).toBe('yes');
		expect(satisfies('1.3.0', '~1.2.3')).toBe('no');
	});

	it('treats ~1 as >=1 <2', () => {
		expect(satisfies('1.9.9', '~1')).toBe('yes');
		expect(satisfies('2.0.0', '~1')).toBe('no');
	});

	it('handles every comparison operator', () => {
		expect(satisfies('8.3.0', '>=8.3')).toBe('yes');
		expect(satisfies('8.2.0', '>=8.3')).toBe('no');
		expect(satisfies('8.4.0', '>8.3')).toBe('yes');
		expect(satisfies('8.3.0', '>8.3')).toBe('no');
		expect(satisfies('8.3.0', '<=8.3')).toBe('yes');
		expect(satisfies('8.2.0', '<8.3')).toBe('yes');
		expect(satisfies('8.3.0', '!=8.3')).toBe('no');
		expect(satisfies('8.4.0', '!=8.3')).toBe('yes');
	});

	it('handles wildcards and bare star', () => {
		expect(satisfies('1.2.9', '1.2.*')).toBe('yes');
		expect(satisfies('1.3.0', '1.2.*')).toBe('no');
		expect(satisfies('99.0.0', '*')).toBe('yes');
	});
});

describe('AND and OR, with OR taking precedence', () => {
	it('requires every clause of a space-separated AND', () => {
		expect(satisfies('1.5.0', '>=1.0 <2.0')).toBe('yes');
		expect(satisfies('2.5.0', '>=1.0 <2.0')).toBe('no');
	});

	it('accepts a comma as AND too', () => {
		expect(satisfies('1.5.0', '>=1.0,<2.0')).toBe('yes');
		expect(satisfies('2.5.0', '>=1.0,<2.0')).toBe('no');
	});

	it('accepts either side of an OR', () => {
		expect(satisfies('10.3.0', '^10 || ^11')).toBe('yes');
		expect(satisfies('11.4.5', '^10 || ^11')).toBe('yes');
		expect(satisfies('9.5.0', '^10 || ^11')).toBe('no');
	});

	it('survives spaces around >= inside an AND group', () => {
		// the split must not treat the space in `>= 1.2` as an AND separator
		expect(satisfies('1.5.0', '>= 1.0 < 2.0')).toBe('yes');
	});
});

describe('and REFUSES to judge what it does not implement', () => {
	it('returns unknown for an `as` alias', () => {
		expect(satisfies('1.0.0', 'dev-main as 1.0.0')).toBe('unknown');
	});

	it('returns unknown for an inline stability flag', () => {
		expect(satisfies('1.0.0', '^1.0@dev')).toBe('unknown');
	});

	it('returns unknown when the installed version cannot be parsed', () => {
		expect(satisfies('dev-main', '^1.0')).toBe('unknown');
	});

	it('returns unknown for an empty constraint rather than accepting everything', () => {
		// an absent constraint is a missing input, not a wildcard
		expect(satisfies('1.0.0', '')).toBe('unknown');
	});

	it('poisons a satisfied AND group with an unknown clause', () => {
		// the conservative direction: the unjudged clause could have excluded this version, so the
		// answer is "ask a human", never "fine"
		expect(satisfies('1.5.0', '>=1.0 dev-weird')).toBe('unknown');
	});

	it('still answers `no` when a KNOWN clause excludes it, even beside an unknown', () => {
		// a definite exclusion is a definite answer; the unknown cannot rescue it
		expect(satisfies('3.0.0', '<2.0 dev-weird')).toBe('no');
	});

	it('prefers a yes from one OR branch over an unknown in another', () => {
		expect(satisfies('11.4.5', '^11.3 || dev-main as 9')).toBe('yes');
	});
});
