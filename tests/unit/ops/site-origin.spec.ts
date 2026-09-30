import { describe, expect, it } from 'vitest';
import {
	FALLBACK_ORIGIN,
	aliasRewrite,
	chooseOrigin,
	normaliseOrigin,
	pinnable,
	replaceStream
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

	/** after one real request, a forged Host changes nothing */
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

describe('re-addressing a response to an alias host', () => {
	const canonical = 'https://primary.example.com';
	const alias = 'https://alias.example.org';

	async function through(pairs: [string, string][], chunks: string[]): Promise<string> {
		const source = new ReadableStream<string>({
			start(ctl) {
				for (const c of chunks) ctl.enqueue(c);
				ctl.close();
			}
		});
		let out = '';
		const reader = source.pipeThrough(replaceStream(pairs)).getReader();
		for (let r = await reader.read(); !r.done; r = await reader.read()) out += r.value;
		return out;
	}

	it('replaces a needle split across every possible chunk boundary', async () => {
		const text = `<a href="${canonical}/node/1">x</a> and ${canonical}`;
		for (let cut = 0; cut <= text.length; cut++) {
			const out = await through([[canonical, alias]], [text.slice(0, cut), text.slice(cut)]);
			expect(out).toBe(`<a href="${alias}/node/1">x</a> and ${alias}`);
		}
	});

	it('does not replace twice when the alias starts with the canonical origin', async () => {
		const longer = `${canonical}.au`;
		const out = await through([[canonical, longer]], [`${canonical}/a `, `${canonical}/b`]);
		expect(out).toBe(`${longer}/a ${longer}/b`);
	});

	it('moves body URLs, the JSON-escaped form, Location and the cookie Domain', async () => {
		const headers = new Headers({
			'content-type': 'text/html; charset=UTF-8',
			'content-length': '999',
			location: `${canonical}/user/1`
		});
		headers.append(
			'set-cookie',
			'SSESSabc=1; expires=x; path=/; domain=.primary.example.com; secure'
		);
		headers.append('set-cookie', 'other=2; path=/');
		const body = `<link rel="canonical" href="${canonical}/"><script>{"u":"https:\\/\\/primary.example.com\\/x"}</script>`;
		const res = aliasRewrite(new Response(body, { status: 302, headers }), canonical, alias);
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe(`${alias}/user/1`);
		expect(res.headers.getSetCookie()).toEqual([
			'SSESSabc=1; expires=x; path=/; Domain=.alias.example.org; secure',
			'other=2; path=/'
		]);
		expect(res.headers.get('content-length')).toBeNull();
		expect(res.headers.get('x-cfw-alias')).toBe('primary.example.com');
		const text = await res.text();
		expect(text).not.toContain('primary.example.com');
		expect(text).toContain(`href="${alias}/"`);
		expect(text).toContain('"https:\\/\\/alias.example.org\\/x"');
	});

	it('leaves a binary body and a foreign Location alone', async () => {
		const bytes = new TextEncoder().encode(canonical);
		const res = aliasRewrite(
			new Response(bytes, {
				headers: { 'content-type': 'image/png', location: 'https://elsewhere.example/' }
			}),
			canonical,
			alias
		);
		expect(res.headers.get('location')).toBe('https://elsewhere.example/');
		expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(canonical);
	});
});
