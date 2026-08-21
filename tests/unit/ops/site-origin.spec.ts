import { describe, expect, it } from 'vitest';
import {
	FALLBACK_ORIGIN,
	chooseOrigin,
	normaliseOrigin,
	pinnable
} from '../../../src/ops/site-origin';

/**
 * The origin is a property of the SITE, not of the request, and these cases are what enforce that.
 *
 * The security-relevant one is the ladder: once a pin exists, an observed origin must not be able
 * to displace it, or the whole defence is a comment.
 */

describe('normalising', () => {
	it('keeps a well-formed origin and drops everything after the authority', () => {
		expect(normaliseOrigin('https://example.com')).toBe('https://example.com');
		expect(normaliseOrigin('https://example.com/')).toBe('https://example.com');
		expect(normaliseOrigin('https://example.com/some/path?q=1#f')).toBe('https://example.com');
	});

	it('keeps a non-default port and elides a default one', () => {
		expect(normaliseOrigin('http://localhost:8787')).toBe('http://localhost:8787');
		expect(normaliseOrigin('https://example.com:443')).toBe('https://example.com');
		expect(normaliseOrigin('http://example.com:80')).toBe('http://example.com');
	});

	// a deployed site can only mean https, and an operator typing a bare hostname is the common case
	it('assumes https for a bare hostname', () => {
		expect(normaliseOrigin('example.com')).toBe('https://example.com');
		expect(normaliseOrigin('  example.com  ')).toBe('https://example.com');
	});

	it('refuses anything that is not http or https, which is why this is an allowlist', () => {
		expect(normaliseOrigin('javascript://example.com')).toBeNull();
		expect(normaliseOrigin('data://x')).toBeNull();
		expect(normaliseOrigin('ftp://example.com')).toBeNull();
	});

	it('refuses an empty, missing or hostless value', () => {
		expect(normaliseOrigin('')).toBeNull();
		expect(normaliseOrigin('   ')).toBeNull();
		expect(normaliseOrigin(null)).toBeNull();
		expect(normaliseOrigin(undefined)).toBeNull();
		expect(normaliseOrigin('https://')).toBeNull();
	});
});

describe('the ladder', () => {
	it('lets the var win over both a pin and an observation', () => {
		expect(
			chooseOrigin({
				configured: 'https://configured.example',
				pinned: 'https://pinned.example',
				observed: 'https://observed.example'
			})
		).toEqual({ origin: 'https://configured.example', from: 'var' });
	});

	/** the whole point: after one real request, a forged Host changes nothing */
	it('lets a pin win over an observation', () => {
		expect(
			chooseOrigin({ pinned: 'https://pinned.example', observed: 'https://attacker.example' })
		).toEqual({ origin: 'https://pinned.example', from: 'pinned' });
	});

	it('takes the observation only when there is nothing above it', () => {
		expect(chooseOrigin({ observed: 'https://observed.example' })).toEqual({
			origin: 'https://observed.example',
			from: 'observed'
		});
	});

	it('falls back rather than failing when every layer is empty', () => {
		expect(chooseOrigin({})).toEqual({ origin: FALLBACK_ORIGIN, from: 'fallback' });
	});

	// a typo in a var must not take a site down, and must not silently win either
	it('falls THROUGH an unusable value rather than failing on it', () => {
		expect(
			chooseOrigin({ configured: 'not a url at all ://', pinned: 'https://pinned.example' })
		).toEqual({ origin: 'https://pinned.example', from: 'pinned' });
		expect(
			chooseOrigin({ configured: 'javascript://x', observed: 'https://observed.example' })
		).toEqual({ origin: 'https://observed.example', from: 'observed' });
	});
});

describe('what may be pinned', () => {
	it('refuses every local origin, so a dev run cannot fix a real site to a laptop', () => {
		expect(pinnable('http://localhost:8787')).toBe(false);
		expect(pinnable('http://127.0.0.1:1234')).toBe(false);
		expect(pinnable('https://do.local')).toBe(false);
		expect(pinnable('http://[::1]:8080')).toBe(false);
	});

	it('accepts a real host', () => {
		expect(pinnable('https://example.com')).toBe(true);
		expect(pinnable('https://site.workers.dev')).toBe(true);
	});

	it('refuses an unusable value rather than pinning garbage', () => {
		expect(pinnable('')).toBe(false);
		expect(pinnable(null)).toBe(false);
		expect(pinnable('javascript://evil')).toBe(false);
	});
});
