import { describe, expect, it } from 'vitest';
import {
	DEFAULT_HEADERS,
	edgeRules,
	HSTS_VALUE,
	parseRedirects,
	parseResponseHeaders,
	redirectMatch,
	ruleDocumentRefusal
} from '../../../src/ops/edge-rules';
import { leverRefusal, writeSettings } from '../../../src/ops/plan';

describe('parsing RESPONSE_HEADERS', () => {
	it('accepts a JSON string and the array itself', () => {
		const rule = { path: '/a*', set: { 'X-A': '1' } };
		expect(parseResponseHeaders(JSON.stringify([rule])).rules).toEqual([rule]);
		expect(parseResponseHeaders([rule]).rules).toEqual([rule]);
		expect(parseResponseHeaders(undefined)).toEqual({ rules: [], problems: [] });
	});

	it('drops what cannot be set and names it', () => {
		const { rules, problems } = parseResponseHeaders([
			{
				path: '/',
				set: {
					'Set-Cookie': 'a=b',
					'X-Cfw-Cache': 'x',
					'Content-Length': '1',
					'Bad Name': 'x',
					'X-Ok': 'line\r\nbreak',
					'X-Fine': 'yes'
				}
			},
			{ path: 'nope', set: {} },
			{ path: '//host', set: { A: 'b' } }
		]);
		expect(rules).toEqual([{ path: '/', set: { 'X-Fine': 'yes' } }]);
		expect(problems).toHaveLength(7);
	});

	it('refuses a document that is not an array', () => {
		expect(parseResponseHeaders('{oops').problems).toEqual([
			'RESPONSE_HEADERS: not valid JSON, ignored'
		]);
		expect(parseResponseHeaders('{}').problems).toEqual([
			'RESPONSE_HEADERS: not a JSON array, ignored'
		]);
	});
});

describe('parsing and matching REDIRECTS', () => {
	it('defaults the status and rejects loops, bad targets and a second splat', () => {
		const { rules, problems } = parseRedirects([
			{ from: '/a', to: '/b' },
			{ from: '/a', to: '/a' },
			{ from: '/c', to: 'javascript:alert(1)' },
			{ from: '/d', to: '/e', status: 200 },
			{ from: '/*/x*', to: '/y' }
		]);
		expect(rules).toEqual([{ from: '/a', to: '/b', status: 301 }]);
		expect(problems).toHaveLength(4);
	});

	it('matches an exact path with or without a trailing slash, and a trailing splat', () => {
		const rules = parseRedirects([
			{ from: '/old', to: '/new' },
			{ from: '/docs/*', to: '/help/*', status: 308 }
		]).rules;
		const at = (p: string) => redirectMatch(rules, new URL(`https://x.test${p}`));
		expect(at('/old')?.to).toBe('/new');
		expect(at('/old/')?.to).toBe('/new');
		expect(at('/old/more')).toBeUndefined();
		expect(at('/docs/a/b?q=1')).toEqual({ to: '/help/a/b?q=1', status: 308 });
	});

	it('caps the rule count', () => {
		const many = Array.from({ length: 150 }, (_, i) => ({ from: `/f${i}`, to: `/t${i}` }));
		expect(parseRedirects(many).rules).toHaveLength(100);
	});
});

describe('the appliers', () => {
	it('adds no rule header when no rule matches, only the defaults', () => {
		const rules = edgeRules({ RESPONSE_HEADERS: [{ path: '/a', set: { 'X-A': '1' } }] });
		const out = rules.decorate('/b', new Response('x'));
		expect(out.headers.has('x-a')).toBe(false);
		expect(Object.fromEntries(out.headers)).toMatchObject(DEFAULT_HEADERS);
	});

	it('sends HSTS only when told the request was https', () => {
		const rules = edgeRules({});
		expect(
			rules.decorate('/', new Response('x'), true).headers.get('strict-transport-security')
		).toBe(HSTS_VALUE);
		expect(
			rules.decorate('/', new Response('x')).headers.has('strict-transport-security')
		).toBe(false);
	});

	it('lets a later rule win and an empty value remove a default', () => {
		const rules = edgeRules({
			RESPONSE_HEADERS: [
				{ path: '/*', set: { 'X-Frame-Options': 'DENY', 'Referrer-Policy': '' } },
				{ path: '/a', set: { 'X-Frame-Options': 'SAMEORIGIN' } }
			]
		});
		const a = rules.decorate('/a', new Response('x'));
		const b = rules.decorate('/b', new Response('x'));
		expect(a.headers.get('x-frame-options')).toBe('SAMEORIGIN');
		expect(b.headers.get('x-frame-options')).toBe('DENY');
		expect(b.headers.has('referrer-policy')).toBe(false);
	});

	it('keeps the body, status and its own headers, and skips a websocket upgrade', async () => {
		const rules = edgeRules({});
		const out = rules.decorate(
			'/',
			new Response('body', { status: 404, headers: { 'x-own': '1' } })
		);
		expect([out.status, await out.text(), out.headers.get('x-own')]).toEqual([
			404,
			'body',
			'1'
		]);
		const upgrade = { status: 101 } as Response;
		expect(rules.decorate('/', upgrade)).toBe(upgrade);
	});

	it('puts the defaults on a redirect', () => {
		const rules = edgeRules({ REDIRECTS: [{ from: '/a', to: '/b' }] });
		const res = rules.redirect(new URL('https://x.test/a'))!;
		expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
		expect(res.headers.get('strict-transport-security')).toBe(HSTS_VALUE);
		expect(
			rules.redirect(new URL('http://x.test/a'))!.headers.has('strict-transport-security')
		).toBe(false);
	});

	it('does not redirect a reserved path', () => {
		const rules = edgeRules({ REDIRECTS: [{ from: '/keep*', to: '/gone' }] }, (p) =>
			p.startsWith('/keep-me')
		);
		expect(rules.redirect(new URL('https://x.test/keep-me'))).toBeUndefined();
		expect(rules.redirect(new URL('https://x.test/keep-this'))?.status).toBe(301);
	});
});

describe('the levers as settings', () => {
	const doc = JSON.stringify([{ from: '/a', to: '/b' }]);

	it('refuses a document with a problem as a whole', () => {
		expect(leverRefusal('REDIRECTS', doc)).toBeUndefined();
		expect(leverRefusal('REDIRECTS', '[{"from":"a","to":"/b"}]')).toMatch(/1 problem/);
		expect(ruleDocumentRefusal('RESPONSE_HEADERS', '{')).toMatch(/not valid JSON/);
	});

	it('stores an array from a PUT body as its text', async () => {
		const store = new Map<string, string>();
		const kv = {
			get: async (k: string) => store.get(k) ?? null,
			put: async (k: string, v: string) => void store.set(k, v)
		};
		const result = await writeSettings(kv as never, {
			REDIRECTS: [{ from: '/a', to: '/b' }],
			RESPONSE_HEADERS: [{ path: 'bad', set: {} }]
		});
		expect(result.written.REDIRECTS).toBe('[{"from":"/a","to":"/b"}]');
		expect(result.invalid.map((i) => i.name)).toEqual(['RESPONSE_HEADERS']);
	});
});
